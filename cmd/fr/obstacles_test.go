package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestBuildObstacles walks the synthetic fixture and asserts the decoded
// shape: per-type counts, lit / group flags, the "other" fallback for
// unknown French txtDescrType values, and the skippedNoGeo counter.
func TestBuildObstacles(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("testdata", "obstacles", "sample.aixm.xml"))
	if err != nil {
		t.Fatal(err)
	}
	fixedNow := func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) }
	art, meta, err := BuildObstacles(src, ObstaclesOptions{
		Source:       "sample.aixm.xml",
		Now:          fixedNow,
		MinObstacles: 1,
		MaxObstacles: 100,
	})
	if err != nil {
		t.Fatal(err)
	}

	// Fixture has 8 <Obs>, one with a bad coordinate that gets skipped.
	if meta.ObstacleCount != 7 {
		t.Errorf("ObstacleCount = %d, want 7", meta.ObstacleCount)
	}
	if meta.SkippedNoGeo != 1 {
		t.Errorf("SkippedNoGeo = %d, want 1", meta.SkippedNoGeo)
	}
	// 5 of 7 rows have codeLgt=Y, 1 of 7 has codeGroup=Y.
	if meta.LitCount != 5 {
		t.Errorf("LitCount = %d, want 5", meta.LitCount)
	}
	if meta.GroupCount != 1 {
		t.Errorf("GroupCount = %d, want 1", meta.GroupCount)
	}

	// Per-type counts.
	want := map[string]int{
		"windturbine": 1, // Eolienne(s)
		"pylon":       1, // Pylône
		"mast":        1, // Mât
		"antenna":     1, // Antenne
		"chimney":     1, // Cheminée
		"lighthouse":  1, // Phare marin
		"other":       1, // unknown French type falls through
	}
	for k, v := range want {
		if meta.Counts[k] != v {
			t.Errorf("counts[%q] = %d, want %d", k, meta.Counts[k], v)
		}
	}
	// "Étrange chose" must show up in unknownTypes.
	foundUnknown := false
	for _, t := range meta.UnknownTypes {
		if t == "Étrange chose" {
			foundUnknown = true
		}
	}
	if !foundUnknown {
		t.Errorf("UnknownTypes missing %q: %v", "Étrange chose", meta.UnknownTypes)
	}

	// Spot-check the artefact schema and the first row's shape.
	if len(art.Fields) != 10 || art.Fields[0] != "id" || art.Fields[8] != "group" ||
		art.Fields[9] != "rmk" {
		t.Errorf("fields shape mismatch: %v", art.Fields)
	}
	row0 := art.Rows[0].([]any)
	if got, want := row0[0].(string), "1000001"; got != want {
		t.Errorf("row[0].id = %q, want %q", got, want)
	}
	// The remark is emitted verbatim, the two-backslash FR/EN separator kept
	// for the SPA to split (see fixture obstacle 1000001).
	if got, want := row0[9].(string), `Pylône métallique\\Metallic pylon`; got != want {
		t.Errorf("row[0].rmk = %q, want %q", got, want)
	}
	if got, want := row0[1].(string), "pylon"; got != want {
		t.Errorf("row[0].type = %q, want %q", got, want)
	}
	if got, want := row0[7].(bool), false; got != want {
		t.Errorf("row[0].lit = %v, want %v", got, want)
	}
}

func TestClassifyAllKnownObstacleTypes(t *testing.T) {
	// Smoke-test that every entry in obstacleTypes returns a non-empty
	// language-neutral code (catches typos in either side of the map).
	for fr, code := range obstacleTypes {
		if code == "" {
			t.Errorf("obstacleTypes[%q] = empty", fr)
		}
	}
}
