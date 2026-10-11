package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A store names a first block by its content since VersionedKey; compare
// looked for the run's bare name and found nothing in a fresh store.
func TestFirstArchiveFindsTheVersionedBlock(t *testing.T) {
	dir := t.TempDir()
	base := filepath.Join(dir, "first", "arome0025")
	if err := os.MkdirAll(base, 0o755); err != nil {
		t.Fatal(err)
	}
	put := func(name string, age time.Duration) {
		p := filepath.Join(base, name)
		if err := os.WriteFile(p, nil, 0o644); err != nil {
			t.Fatal(err)
		}
		when := time.Now().Add(-age)
		if err := os.Chtimes(p, when, when); err != nil {
			t.Fatal(err)
		}
	}
	run := time.Date(2026, 10, 8, 0, 0, 0, 0, time.UTC)
	put("2026100800.pmtiles", 2*time.Hour)
	put("2026100800.3f2a9c1e5b7d.pmtiles", time.Hour)
	put("2026100800.0123456789ab.pmtiles", 3*time.Hour)
	put("2026100803.aaaaaaaaaaaa.pmtiles", 0)
	put("2026100800.pmtiles.tmp", 0)
	got, err := firstArchive(dir, "arome0025", run)
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(base, "2026100800.3f2a9c1e5b7d.pmtiles"); got != want {
		t.Fatalf("firstArchive = %s, want the newest of the run's, %s", got, want)
	}
	if _, err := firstArchive(dir, "arome0025", run.Add(6*time.Hour)); err == nil || !strings.Contains(err.Error(), "2026100806") {
		t.Fatalf("a run with no first block: err = %v", err)
	}
}

// AROME-OM has no Open-Meteo twin: compare refuses it before asking
// anything, where the zero value asked /data//static/meta.json.
func TestCompareRefusesAModelWithNoTwin(t *testing.T) {
	err := cmdCompare([]string{"-model", "aromeomantil", "-archive", t.TempDir()})
	if err == nil || !strings.Contains(err.Error(), "no twin of aromeomantil") {
		t.Fatalf("err = %v", err)
	}
}
