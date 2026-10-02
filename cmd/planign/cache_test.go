package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"testing"
	"time"
)

var day0 = time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC)

func TestCacheResumeAndParams(t *testing.T) {
	dir := t.TempDir()
	c, release, err := openCache(dir, false, false, day0)
	if err != nil {
		t.Fatal(err)
	}
	if c.started != "2026-10-01" {
		t.Fatalf("started %q", c.started)
	}
	e, err := encodeTile(pngTile(t, false))
	if err != nil {
		t.Fatal(err)
	}
	tl := tile{12, 2074, 1409}
	if err := c.putTile(tl, e); err != nil {
		t.Fatal(err)
	}
	if err := c.putNone(tile{12, 0, 0}); err != nil {
		t.Fatal(err)
	}
	release()

	// The next day: same harvest, tiles still there, the date unchanged.
	c, release, err = openCache(dir, false, false, day0.Add(30*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	if c.started != "2026-10-01" || !c.resolved(tl) || !c.resolved(tile{12, 0, 0}) || c.resolved(tile{12, 1, 1}) {
		t.Fatal("the cache did not resume")
	}
	got, err := c.get(tl)
	if err != nil || !got.present || got.pixels != e.pixels || string(got.webp) != string(e.webp) {
		t.Fatalf("get: %+v %v", got, err)
	}
	if none, err := c.get(tile{12, 0, 0}); err != nil || none.present {
		t.Fatalf("absent: %+v %v", none, err)
	}
	if _, err := c.get(tile{12, 1, 1}); err == nil {
		t.Fatal("an unharvested tile read as resolved")
	}
	// No .part left behind.
	parts, _ := filepath.Glob(filepath.Join(dir, "tiles", "*", "*", "*.part"))
	if len(parts) > 0 {
		t.Fatalf("left %v", parts)
	}
}

func TestCacheRefusesOtherParams(t *testing.T) {
	dir := t.TempDir()
	if err := writeJSON(filepath.Join(dir, "params.json"), params{Layer: wmtsLayer, Quality: 70}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := openCache(dir, false, false, day0); err == nil {
		t.Fatal("a cache encoded at another quality was continued")
	}
	// -fresh starts over.
	c, release, err := openCache(dir, true, false, day0)
	if err != nil {
		t.Fatal(err)
	}
	release()
	if c.started != "2026-10-01" {
		t.Fatal(c.started)
	}
}

func TestCacheStaleNeedsResume(t *testing.T) {
	dir := t.TempDir()
	_, release, err := openCache(dir, false, false, day0)
	if err != nil {
		t.Fatal(err)
	}
	release()
	later := day0.Add(staleAfter + 24*time.Hour)
	if _, _, err := openCache(dir, false, false, later); err == nil {
		t.Fatal("last quarter's cache was continued without -resume")
	}
	c, release, err := openCache(dir, false, true, later)
	if err != nil {
		t.Fatal(err)
	}
	release()
	if c.started != "2026-10-01" {
		t.Fatal("-resume changed the edition's date")
	}
}

func TestCacheLock(t *testing.T) {
	dir := t.TempDir()
	_, release, err := openCache(dir, false, false, day0)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := openCache(dir, false, false, day0); err == nil {
		t.Fatal("a second run took a held cache")
	}
	release()
	// A lock left by a process that is gone is taken over.
	if err := os.WriteFile(filepath.Join(dir, "lock"), []byte(strconv.Itoa(1<<30)+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, release, err = openCache(dir, false, false, day0)
	if err != nil {
		t.Fatalf("a stale lock was not taken over: %v", err)
	}
	release()
	if _, err := os.Stat(filepath.Join(dir, "lock")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("release left the lock")
	}
}

func TestHarvestAllResolvesAndResumes(t *testing.T) {
	png := pngTile(t, false)
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		col, _ := strconv.Atoi(r.URL.Query().Get("TILECOL"))
		if col%3 == 0 {
			http.Error(w, "", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(png)
	}))
	defer srv.Close()
	c, release, err := openCache(t.TempDir(), false, false, day0)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	want := enumerate(0, 3, 3, nil, 0, 0) // 85 tiles, the whole world to zoom 3
	if err := harvestAll(t.Context(), testFetcher(srv.URL), c, want, 4); err != nil {
		t.Fatal(err)
	}
	if int(hits.Load()) != len(want) {
		t.Fatalf("%d requests for %d tiles", hits.Load(), len(want))
	}
	for _, tl := range want {
		got, err := c.get(tl)
		if err != nil || got.present == (tl.x%3 == 0) {
			t.Fatalf("%s: %+v %v", tl, got.present, err)
		}
	}
	// Run again: everything is cached, nothing is asked.
	if err := harvestAll(t.Context(), testFetcher(srv.URL), c, want, 4); err != nil {
		t.Fatal(err)
	}
	if int(hits.Load()) != len(want) {
		t.Fatalf("the second run made %d more requests", int(hits.Load())-len(want))
	}
}

func TestHarvestStopsOnForbidden(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "blocked", http.StatusForbidden)
	}))
	defer srv.Close()
	c, release, err := openCache(t.TempDir(), false, false, day0)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	err = harvestAll(t.Context(), testFetcher(srv.URL), c, enumerate(0, 4, 4, nil, 0, 0), 4)
	var fatal *fatalError
	if !errors.As(err, &fatal) || fatal.status != http.StatusForbidden {
		t.Fatalf("got %v, want the 403 to stop the harvest", err)
	}
}

func TestHarvestKeepsWhatFailed(t *testing.T) {
	secondPassDelay = time.Millisecond
	t.Cleanup(func() { secondPassDelay = 30 * time.Second })
	png := pngTile(t, false)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// One tile never answers properly; the rest do.
		if r.URL.Query().Get("TILEMATRIX") == "2" && r.URL.Query().Get("TILECOL") == "1" && r.URL.Query().Get("TILEROW") == "1" {
			http.Error(w, "oops", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(png)
	}))
	defer srv.Close()
	c, release, err := openCache(t.TempDir(), false, false, day0)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	want := enumerate(0, 2, 2, nil, 0, 0)
	err = harvestAll(t.Context(), testFetcher(srv.URL), c, want, 4)
	if !errors.Is(err, errIncomplete) {
		t.Fatalf("got %v, want errIncomplete", err)
	}
	if c.resolved(tile{2, 1, 1}) {
		t.Fatal("the failed tile was cached")
	}
	if !c.resolved(tile{2, 0, 0}) {
		t.Fatal("the tiles that answered were not kept")
	}
}
