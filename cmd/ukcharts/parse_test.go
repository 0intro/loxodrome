package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestParseMenu(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("testdata", "EG-menu-en-GB.html"))
	if err != nil {
		t.Fatal(err)
	}
	pages := parseMenu(data)
	if len(pages) != 2 {
		t.Fatalf("pages = %d, want 2 (the duplicate EGLL folds)", len(pages))
	}
	// Sorted by ICAO; the heliport keeps its AD 3 section.
	if pages[0].ICAO != "EGLL" || pages[0].Section != 2 {
		t.Errorf("page 0 = %+v, want EGLL AD 2", pages[0])
	}
	if pages[1].ICAO != "EGLW" || pages[1].Section != 3 {
		t.Errorf("page 1 = %+v, want EGLW AD 3", pages[1])
	}
}

func TestParseCharts(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("testdata", "EG-AD-2.EGLL-en-GB.html"))
	if err != nil {
		t.Fatal(err)
	}
	charts := parseCharts(data)
	if len(charts) != 10 {
		t.Fatalf("charts = %d, want 10", len(charts))
	}

	// Title-row / link-row pairing, in publication order.
	first := charts[0]
	if first.Title != "AERODROME CHART - ICAO" || first.Code != "ADC" {
		t.Errorf("first chart = %+v", first)
	}
	if first.Path != "graphics/487994.pdf" {
		t.Errorf("first path = %q", first.Path)
	}

	byCode := map[string]int{}
	for _, c := range charts {
		byCode[c.Code]++
	}
	// The families the keyword mapper resolves on this page.
	if byCode["ADC"] < 2 {
		t.Errorf("ADC = %d, want the two aerodrome charts", byCode["ADC"])
	}
	if byCode["GMC"] < 1 {
		t.Errorf("GMC = %d, want at least one ground-movement chart", byCode["GMC"])
	}
	if byCode["IAC"] < 1 {
		t.Errorf("IAC = %d, want the instrument approach chart", byCode["IAC"])
	}
	// The arrival CODING TABLE maps to DATA (coding table wins over
	// arrival), not STAR.
	if byCode["DATA"] < 1 {
		t.Errorf("DATA = %d, want the arrival coding table", byCode["DATA"])
	}
	// An "AERODROME CHART ... GROUND MOVEMENT" title stays ADC, not GMC.
	for _, c := range charts {
		if c.Title == "AERODROME CHART A380 GROUND MOVEMENT - ICAO" && c.Code != "ADC" {
			t.Errorf("A380 aerodrome chart = %q, want ADC", c.Code)
		}
	}
}

func TestChartFamily(t *testing.T) {
	cases := map[string]string{
		"AERODROME CHART - ICAO":                             "ADC",
		"AERODROME CHART A380 GROUND MOVEMENT - ICAO":        "ADC",
		"AIRCRAFT GROUND MOVEMENT/ALL TAXIWAYS CHART - ICAO": "GMC",
		"AIRCRAFT PARKING/DOCKING CHART - ICAO":              "APDC",
		"INSTRUMENT APPROACH CHART ILS/DME RWY 27R - ICAO":   "IAC",
		"INITIAL APPROACH PROCEDURES ILS RWY 27R":            "IAC",
		"STANDARD DEPARTURE CHART - INSTRUMENT (SID) - ICAO": "SID",
		"RNAV DME/DME OR GNSS STANDARD ARRIVAL CHART":        "STAR",
		"ATC SURVEILLANCE MINIMUM ALTITUDE CHART - ICAO":     "ATCSMAC",
		"STANDARD INSTRUMENT ARRIVAL CODING TABLE":           "DATA",
		"CONTROL ZONE AND CONTROL AREA CHART":                "ARC",
		"NOISE PREFERENTIAL ROUTEINGS":                       "MISC",
	}
	for title, want := range cases {
		if got := chartFamily(title); got != want {
			t.Errorf("chartFamily(%q) = %q, want %q", title, got, want)
		}
	}
}

func TestBuild(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("testdata", "EG-AD-2.EGLL-en-GB.html"))
	if err != nil {
		t.Fatal(err)
	}
	charts := map[string][]chartRef{
		"EGLL": parseCharts(data),
		"EGXX": nil, // an aerodrome with no charts is dropped
	}
	effective := time.Date(2026, 7, 9, 0, 0, 0, 0, time.UTC)
	fixedNow := time.Date(2026, 7, 23, 12, 0, 0, 0, time.UTC)
	art, meta, err := buildOK(charts, effective, fixedNow)
	if err != nil {
		t.Fatal(err)
	}
	if len(art.Rows) != 1 {
		t.Fatalf("rows = %d, want 1 (EGXX dropped)", len(art.Rows))
	}
	if meta.Aerodromes != 1 || meta.Charts != 10 {
		t.Errorf("meta = %d aerodromes / %d charts, want 1 / 10", meta.Aerodromes, meta.Charts)
	}
	if meta.Effective != "2026-07-09" {
		t.Errorf("effective = %q", meta.Effective)
	}
	if len(meta.MiscTitles) != len(dedupeMisc(charts["EGLL"])) {
		t.Errorf("miscTitles = %v", meta.MiscTitles)
	}
}

// buildOK adapts build's positional args for the test.
func buildOK(charts map[string][]chartRef, effective, now time.Time) (Artifact, Meta, error) {
	art, meta := build(charts, effective, "https://base/", "menu", 1, now)
	return art, meta, nil
}

func dedupeMisc(refs []chartRef) map[string]bool {
	out := map[string]bool{}
	for _, c := range refs {
		if c.Code == "MISC" {
			out[c.Title] = true
		}
	}
	return out
}
