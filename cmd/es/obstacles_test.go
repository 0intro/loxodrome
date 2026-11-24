package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/0intro/loxodrome/internal/aixm5build"
)

// TestDecodeInputsMergeAndBuildObstacles drives the two-file ENAIRE merge
// path. decodeInputs concatenates (an obstacle filed in both files arrives
// twice) and keeps the first file's effective date; BuildObstacles then
// drops sub-30 m and height-less structures, maps the AIXM type vocabulary
// and keeps the obstacle filed twice once.
func TestDecodeInputsMergeAndBuildObstacles(t *testing.T) {
	a := filepath.Join("testdata", "obstacles", "obs-a.xml")
	b := filepath.Join("testdata", "obstacles", "obs-b.xml")
	for _, p := range []string{a, b} {
		if _, err := os.Stat(p); err != nil {
			t.Fatalf("fixture missing: %v", err)
		}
	}

	msg, src, name, err := decodeInputs([]string{a, b})
	if err != nil {
		t.Fatal(err)
	}

	// Plain concatenation: 4 BASELINE structures from obs-a (the 5th is
	// SNAPSHOT) + 2 from obs-b = 6, no de-duplication.
	if got := len(msg.Obstacles); got != 6 {
		t.Errorf("merged obstacle count = %d, want 6", got)
	}
	if msg.SkippedNonBaseline != 1 {
		t.Errorf("SkippedNonBaseline = %d, want 1", msg.SkippedNonBaseline)
	}
	// First file wins the effective date even though obs-b is later.
	if msg.Effective != "2026-05-14T00:00:00Z" {
		t.Errorf("Effective = %q, want first file's date", msg.Effective)
	}
	if name != "obs-a.xml+obs-b.xml" {
		t.Errorf("source label = %q, want %q", name, "obs-a.xml+obs-b.xml")
	}
	if len(src) == 0 {
		t.Error("merged source bytes empty")
	}

	fixedNow := func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) }
	art, meta, err := aixm5build.BuildObstacles(msg, name, src, msg.Effective, aixm5build.ObstaclesOptions{
		IDPrefix:     "es",
		Country:      "ES",
		MinHeightM:   esMinObstacleHeightM,
		Now:          fixedNow,
		MinObstacles: 1,
		MaxObstacles: 100,
	})
	if err != nil {
		t.Fatal(err)
	}

	// Kept: WT (120 m), antenna (50 m), tower (60 m). Dropped: building
	// (20 m), mast (no height), and the WT filed again in obs-b.
	if meta.ObstacleCount != 3 {
		t.Errorf("ObstacleCount = %d, want 3", meta.ObstacleCount)
	}
	if meta.RepeatedRows != 1 {
		t.Errorf("RepeatedRows = %d, want 1 (the WT filed in both files)", meta.RepeatedRows)
	}
	if meta.SkippedTooShort != 2 {
		t.Errorf("SkippedTooShort = %d, want 2 (sub-30 m + height-less)", meta.SkippedTooShort)
	}
	if meta.LitCount != 2 {
		t.Errorf("LitCount = %d, want 2", meta.LitCount)
	}
	if meta.Effective != "2026-05-14T00:00:00Z" {
		t.Errorf("meta.Effective = %q, want first file's date", meta.Effective)
	}
	for k, want := range map[string]int{"windturbine": 1, "antenna": 1, "tower": 1} {
		if meta.Counts[k] != want {
			t.Errorf("counts[%q] = %d, want %d", k, meta.Counts[k], want)
		}
	}

	// The obstacle filed in both files is one row.
	const dupID = "es:ES-OBS-WT-001"
	seen := 0
	for _, r := range art.Rows {
		if r.([]any)[0].(string) == dupID {
			seen++
		}
	}
	if seen != 1 {
		t.Errorf("rows with id %q = %d, want 1", dupID, seen)
	}
}
