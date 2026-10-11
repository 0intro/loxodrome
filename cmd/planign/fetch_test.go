package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// testFetcher is a fetcher at the given server with no real waiting.
func testFetcher(base string) *fetcher {
	f := newFetcher(base, 1000, 4)
	f.backoff = time.Millisecond
	f.attempts = 3
	return f
}

func TestTileURL(t *testing.T) {
	got := tileURL(wmtsEndpoint, tile{12, 2074, 1409})
	want := "https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&FORMAT=image/png&TILEMATRIXSET=PM_0_19&TILEMATRIX=12&TILEROW=1409&TILECOL=2074"
	if got != want {
		t.Fatalf("\n got %s\nwant %s", got, want)
	}
}

func TestFetchClassifies(t *testing.T) {
	png := pngTile(t, false)
	var flaky, flaky400 atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if ua := r.Header.Get("User-Agent"); ua != userAgent {
			t.Errorf("User-Agent %q", ua)
		}
		switch r.URL.Query().Get("TILECOL") {
		case "1": // present
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(png)
		case "2": // absent
			http.Error(w, "<ExceptionReport/>", http.StatusNotFound)
		case "3": // a portal: 200 but not a PNG, every time
			w.Header().Set("Content-Type", "text/html")
			_, _ = w.Write([]byte("<html>maintenance</html>"))
		case "4": // a 400 every time: a plain failure once the retries are spent
			http.Error(w, "bad", http.StatusBadRequest)
		case "8": // one transient 400, then the tile (IGN, 2026-10-01)
			if flaky400.Add(1) == 1 {
				http.Error(w, "bad", http.StatusBadRequest)
				return
			}
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(png)
		case "5":
			http.Error(w, "go away", http.StatusForbidden)
		case "6": // one 503, then the tile
			if flaky.Add(1) == 1 {
				http.Error(w, "busy", http.StatusServiceUnavailable)
				return
			}
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(png)
		case "7":
			http.Error(w, "gone", http.StatusGone)
		}
	}))
	defer srv.Close()
	f := testFetcher(srv.URL)
	ctx := context.Background()

	if b, err := f.get(ctx, tile{3, 1, 0}); err != nil || len(b) != len(png) {
		t.Errorf("present: %d bytes, %v", len(b), err)
	}
	if b, err := f.get(ctx, tile{3, 2, 0}); err != nil || b != nil {
		t.Errorf("absent: %v, %v", b, err)
	}
	if _, err := f.get(ctx, tile{3, 3, 0}); err == nil {
		t.Error("a 200 that is not a PNG was accepted")
	}
	var fatal *fatalError
	if _, err := f.get(ctx, tile{3, 4, 0}); err == nil || errors.As(err, &fatal) {
		t.Errorf("a persistent 400: %v, want a plain failure, not a stop", err)
	}
	if b, err := f.get(ctx, tile{3, 8, 0}); err != nil || len(b) != len(png) {
		t.Errorf("a transient 400: %d bytes, %v, want the tile on the retry", len(b), err)
	}
	if _, err := f.get(ctx, tile{3, 5, 0}); !errors.As(err, &fatal) || fatal.status != 403 {
		t.Errorf("403: %v", err)
	}
	if b, err := f.get(ctx, tile{3, 6, 0}); err != nil || len(b) != len(png) || flaky.Load() != 2 {
		t.Errorf("503 then 200: %d bytes, %v, %d requests", len(b), err, flaky.Load())
	}
	if _, err := f.get(ctx, tile{3, 7, 0}); err == nil || errors.As(err, &fatal) {
		t.Errorf("410: %v, want a plain failure", err)
	}
}

func TestFetch429PausesEveryone(t *testing.T) {
	var n atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if n.Add(1) == 1 {
			w.Header().Set("Retry-After", "1")
			http.Error(w, "slow down", http.StatusTooManyRequests)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(pngTile(t, false))
	}))
	defer srv.Close()
	f := testFetcher(srv.URL)
	start := time.Now()
	if _, err := f.get(context.Background(), tile{1, 0, 0}); err != nil {
		t.Fatal(err)
	}
	if time.Since(start) < 900*time.Millisecond {
		t.Fatalf("Retry-After ignored: retried after %s", time.Since(start))
	}
	// The pause holds the next request of ANY worker.
	if f.until.Before(start.Add(900 * time.Millisecond)) {
		t.Fatal("no global pause recorded")
	}
}

func TestFetchRateCap(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "", http.StatusNotFound)
	}))
	defer srv.Close()
	f := newFetcher(srv.URL, 20, 4)
	start := time.Now()
	for i := range 11 {
		if _, err := f.get(context.Background(), tile{4, uint32(i), 0}); err != nil {
			t.Fatal(err)
		}
	}
	// Eleven requests at 20/s: ten intervals of 50 ms at the least.
	if d := time.Since(start); d < 480*time.Millisecond {
		t.Fatalf("11 requests in %s at 20/s", d)
	}
}

func TestParseRetryAfter(t *testing.T) {
	now := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	if d := parseRetryAfter("7", now); d != 7*time.Second {
		t.Errorf("seconds: %s", d)
	}
	if d := parseRetryAfter(now.Add(90*time.Second).Format(http.TimeFormat), now); d != 90*time.Second {
		t.Errorf("date: %s", d)
	}
	for _, v := range []string{"", "soon", "-3", now.Add(-time.Minute).Format(http.TimeFormat)} {
		if d := parseRetryAfter(v, now); d != 0 {
			t.Errorf("%q: %s", v, d)
		}
	}
}

func TestBreaker(t *testing.T) {
	var b breaker
	for i := range breakerRun - 1 {
		if err := b.record(true); err != nil {
			t.Fatalf("tripped after %d failures", i+1)
		}
	}
	if err := b.record(true); err == nil {
		t.Fatalf("%d failures in a row did not trip", breakerRun)
	}

	// 2 % of 500 is 10 failures; spread out, the 11th trips it.
	var r breaker
	failures := 0
	for i := range 500 {
		failed := i%45 == 0 && failures < 11
		if failed {
			failures++
		}
		err := r.record(failed)
		if err != nil && i < 499 {
			t.Fatalf("tripped at %d with %d failures", i, failures)
		}
		if i == 499 && err == nil {
			t.Fatalf("%d failures in 500 did not trip", failures)
		}
	}
}

func TestBreakerWindowForgets(t *testing.T) {
	var b breaker
	for range 10 {
		_ = b.record(true)
	}
	for range 500 {
		if err := b.record(false); err != nil {
			t.Fatal(err)
		}
	}
	// The ten old failures have left the window: ten new ones do not trip it.
	for i := range 10 {
		if err := b.record(true); err != nil {
			t.Fatalf("tripped at new failure %d: %v", i+1, err)
		}
	}
}
