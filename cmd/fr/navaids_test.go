package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestBuildNavaidsILS pins the landing-aid decoding added to cmd/fr: an
// ILS-DME (glidepath + co-located DME), a LOC (localizer only), and a
// middle marker, alongside the folded VOR-DME.
func TestBuildNavaidsILS(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("testdata", "navaids", "sample.aixm.xml"))
	if err != nil {
		t.Fatal(err)
	}
	fixedNow := func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) }
	art, meta, err := BuildNavaids(src, NavaidsOptions{
		Source: "sample.aixm.xml", Now: fixedNow, MinNavaids: 1, MaxNavaids: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	if meta.Counts["ILS-DME"] != 1 || meta.Counts["LOC"] != 1 || meta.Counts["MKR"] != 1 {
		t.Fatalf("counts = %v, want one each of ILS-DME / LOC / MKR", meta.Counts)
	}
	// The VOR folds its DME; no standalone DME row.
	if meta.Counts["VOR-DME"] != 1 || meta.Counts["DME"] != 0 {
		t.Errorf("VOR-DME=%d DME=%d, want 1 / 0", meta.Counts["VOR-DME"], meta.Counts["DME"])
	}

	byType := map[string][]any{}
	for _, r := range art.Rows {
		row := r.([]any)
		byType[row[1].(string)] = row
	}
	// ILS-DME: keyed on the localizer ident, named by the served runway,
	// with the localizer frequency and position (not the glidepath).
	ils := byType["ILS-DME"]
	if ils[2] != "CN" {
		t.Errorf("ILS-DME ident = %v, want CN (localizer)", ils[2])
	}
	if ils[3] != "LFRK RWY 31" {
		t.Errorf("ILS-DME name = %v, want 'LFRK RWY 31'", ils[3])
	}
	if ils[6] != "109.90" {
		t.Errorf("ILS-DME freq = %v, want the localizer 109.90", ils[6])
	}
	// LOC: a localizer with no glidepath.
	if loc := byType["LOC"]; loc[2] != "DND" || loc[3] != "LFRD RWY 11" {
		t.Errorf("LOC = %v", loc)
	}
	// Marker: synthesized ident + descriptive name (its codeId is Morse).
	mkr := byType["MKR"]
	if mkr[2] != "LFRK-31-M" {
		t.Errorf("MKR ident = %v, want LFRK-31-M", mkr[2])
	}
	if mkr[3] != "LFRK RWY 31 middle marker" {
		t.Errorf("MKR name = %v", mkr[3])
	}
}
