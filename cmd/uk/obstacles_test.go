package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/0intro/loxodrome/internal/aixm5"
	"github.com/0intro/loxodrome/internal/aixm5build"
)

// TestBuildObstacles decodes a synthetic AIXM 5.1 obstacle fixture and
// checks the row schema cmd/uk emits: one row per BASELINE structure (no
// height floor, unlike cmd/es), the type-vocabulary mapping with an
// "other" fallback tracked in UnknownTypes, the lit count, the SNAPSHOT
// (non-baseline) skip, and the uk: id namespacing.
func TestBuildObstacles(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("testdata", "obstacles", "obstacles.xml"))
	if err != nil {
		t.Fatalf("fixture: %v", err)
	}

	msg, err := aixm5.Decode(src)
	if err != nil {
		t.Fatal(err)
	}

	// 4 BASELINE structures decoded; the 5th is SNAPSHOT.
	if got := len(msg.Obstacles); got != 4 {
		t.Errorf("decoded obstacle count = %d, want 4", got)
	}
	if msg.SkippedNonBaseline != 1 {
		t.Errorf("SkippedNonBaseline = %d, want 1", msg.SkippedNonBaseline)
	}
	if msg.Effective != "2026-05-14T00:00:00Z" {
		t.Errorf("Effective = %q, want the messageMetadata dateStamp", msg.Effective)
	}

	fixedNow := func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) }
	art, meta, err := aixm5build.BuildObstacles(msg, "obstacles.xml", src, msg.Effective, aixm5build.ObstaclesOptions{
		IDPrefix:     "uk",
		Country:      "UK",
		Now:          fixedNow,
		MinObstacles: 1,
		MaxObstacles: 100,
	})
	if err != nil {
		t.Fatal(err)
	}

	// cmd/uk emits every BASELINE structure (no 30 m floor).
	if meta.ObstacleCount != 4 {
		t.Errorf("ObstacleCount = %d, want 4", meta.ObstacleCount)
	}
	if meta.LitCount != 2 {
		t.Errorf("LitCount = %d, want 2 (turbine + tower)", meta.LitCount)
	}
	if meta.SkippedNonBaseline != 1 {
		t.Errorf("meta.SkippedNonBaseline = %d, want 1", meta.SkippedNonBaseline)
	}
	if meta.Effective != "2026-05-14T00:00:00Z" {
		t.Errorf("meta.Effective = %q, want the dateStamp", meta.Effective)
	}
	for k, want := range map[string]int{"windturbine": 1, "tower": 1, "mast": 1, "other": 1} {
		if meta.Counts[k] != want {
			t.Errorf("counts[%q] = %d, want %d", k, meta.Counts[k], want)
		}
	}

	// The unmapped GANTRY type falls back to "other" and is tracked.
	if len(meta.UnknownTypes) != 1 || meta.UnknownTypes[0] != "GANTRY" {
		t.Errorf("UnknownTypes = %v, want [GANTRY]", meta.UnknownTypes)
	}

	// Rows are uk: namespaced and keep the gml:identifier.
	const wantID = "uk:UK-OBS-WT-001"
	seen := false
	for _, r := range art.Rows {
		if r.([]any)[0].(string) == wantID {
			seen = true
		}
	}
	if !seen {
		t.Errorf("no row with id %q (uk: namespacing or identifier decode broke)", wantID)
	}
}
