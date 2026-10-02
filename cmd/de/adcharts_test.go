package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func fixedNow() time.Time { return time.Date(2026, 7, 23, 12, 0, 0, 0, time.UTC) }

func TestBuildAdCharts(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("testdata", "config.js"))
	if err != nil {
		t.Fatal(err)
	}
	art, meta, err := BuildAdCharts(data, "fixture", AdChartsOptions{Now: fixedNow, MinAerodromes: 1})
	if err != nil {
		t.Fatal(err)
	}
	// The hospital helipad has no ICAO in its label and is skipped; the
	// three ICAO-identified entries survive, the duplicate EDDB folding to
	// its first permalink.
	if len(art.Rows) != 3 {
		t.Fatalf("rows = %d, want 3", len(art.Rows))
	}
	if meta.Skipped != 1 {
		t.Errorf("skipped = %d, want 1 (the hospital helipad)", meta.Skipped)
	}
	byICAO := map[string]string{}
	for _, r := range art.Rows {
		row := r.([]any)
		byICAO[row[0].(string)] = row[1].(string)
	}
	if byICAO["EDKA"] != "C0194C" {
		t.Errorf("EDKA = %q, want C0194C", byICAO["EDKA"])
	}
	// The military ET indicator is kept, matching the airport dataset.
	if byICAO["ETNL"] != "C01A80" {
		t.Errorf("ETNL = %q, want C01A80", byICAO["ETNL"])
	}
	// A duplicate ICAO keeps the first (publication-order) permalink.
	if byICAO["EDDB"] != "C01990" {
		t.Errorf("EDDB = %q, want the first permalink", byICAO["EDDB"])
	}
	// Rows are sorted by ICAO.
	if art.Rows[0].([]any)[0] != "EDDB" {
		t.Errorf("first row = %v, want EDDB", art.Rows[0])
	}
	if art.Base != "https://aip.dfs.de/BasicVFR/pages/" {
		t.Errorf("base = %q", art.Base)
	}
}

func TestBuildAdChartsSanityFloor(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("testdata", "config.js"))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := BuildAdCharts(data, "fixture", AdChartsOptions{Now: fixedNow, MinAerodromes: 300}); err == nil {
		t.Error("a count below the floor should fail the build")
	}
}
