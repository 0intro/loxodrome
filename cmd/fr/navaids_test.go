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

// TestBuildNavaidsVRP pins the designated points' two columns: a VFR
// reporting point carries its remark as published and its aerodrome, an
// ICAO waypoint carries neither, a point on an aerodrome is not emitted,
// and every row is as wide as the layout.
func TestBuildNavaidsVRP(t *testing.T) {
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
	byIdent := map[string][]any{}
	for _, r := range art.Rows {
		row := r.([]any)
		if len(row) != len(art.Fields) {
			t.Errorf("row %v: %d cells, want %d (the layout)", row[0], len(row), len(art.Fields))
		}
		byIdent[row[2].(string)] = row
	}
	if got := art.Fields[9:]; len(got) != 2 || got[0] != "rmk" || got[1] != "ad" {
		t.Errorf("fields[9:] = %v, want [rmk ad]", got)
	}
	vrp := byIdent["BIN"]
	if vrp == nil {
		t.Fatal("BIN: no row")
	}
	if vrp[1] != "VFR_REPORTING_POINT" || vrp[3] != "BI-N" {
		t.Errorf("BIN type, name = %v, %v; want VFR_REPORTING_POINT, BI-N", vrp[1], vrp[3])
	}
	if want := "VRP-Neuville de Poitou#\r\nMax ALT 2000 ft AMSL when IFR present."; vrp[9] != want {
		t.Errorf("BIN rmk = %q, want %q", vrp[9], want)
	}
	if vrp[10] != "LFBI" {
		t.Errorf("BIN ad = %v, want LFBI", vrp[10])
	}
	wpt := byIdent["ETAMP"]
	if wpt == nil {
		t.Fatal("ETAMP: no row")
	}
	if wpt[1] != "WAYPOINT" || wpt[3] != "" || wpt[9] != "" || wpt[10] != "" {
		t.Errorf("ETAMP = %v, want a WAYPOINT, no name, no rmk, no ad", wpt)
	}
	if byIdent["BI01"] != nil {
		t.Errorf("BI01: a point on an aerodrome was emitted: %v", byIdent["BI01"])
	}
	if cgn := byIdent["CGN"]; cgn[9] != "" || cgn[10] != "" {
		t.Errorf("CGN rmk, ad = %q, %q; want empty", cgn[9], cgn[10])
	}
	if meta.WithRemark != 1 || meta.WithAerodrome != 1 {
		t.Errorf("withRemark, withAerodrome = %d, %d; want 1, 1", meta.WithRemark, meta.WithAerodrome)
	}
}
