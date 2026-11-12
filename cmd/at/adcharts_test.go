package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// eaipFixture is the trimmed eAIP snapshot under testdata/eaip: the
// landing page's edition table plus one edition holding an AD 2 index
// (a PRI aerodrome, two SRY ones, one of them charts-less), an AD 3
// index, and the charts pages of four of them.
const eaipFixture = "testdata"

func TestParseEditions(t *testing.T) {
	data, err := os.ReadFile(filepath.Join(eaipFixture, "eaip", "index.htm"))
	if err != nil {
		t.Fatal(err)
	}
	doc, err := parsePage(data)
	if err != nil {
		t.Fatal(err)
	}
	eds := ParseEditions(doc)
	if len(eds) != 4 {
		t.Fatalf("editions = %d, want 4", len(eds))
	}
	if eds[0].Segment != "260710" || eds[0].From != "2026-07-10T00:00:00.000Z" {
		t.Errorf("first edition = %+v", eds[0])
	}
	if eds[0].Until != "2026-08-05" {
		t.Errorf("first edition until = %q", eds[0].Until)
	}
	if got := eds[0].Base(); got != "https://eaip.austrocontrol.at/lo/260710/" {
		t.Errorf("base = %q", got)
	}
	// The last edition runs until further notice, so it states no end.
	if last := eds[len(eds)-1]; last.Until != "" {
		t.Errorf("open-ended edition until = %q, want empty", last.Until)
	}
}

func TestSelectEditions(t *testing.T) {
	eds := []Edition{
		{Segment: "260903", From: "2026-09-03T00:00:00.000Z"},
		{Segment: "260710", From: "2026-07-10T00:00:00.000Z"},
		{Segment: "260807", From: "2026-08-07T00:00:00.000Z"},
		{Segment: "260806", From: "2026-08-06T00:00:00.000Z"},
	}
	cases := []struct {
		day, current, next string
	}{
		// Mid-cycle: the edition in force and the one that follows.
		{"2026-07-22", "260710", "260806"},
		// The changeover day itself belongs to the new edition.
		{"2026-08-06", "260806", "260807"},
		// The 06 AUG edition is valid for its own date alone; the day
		// after, the pair has already moved on.
		{"2026-08-07", "260807", "260903"},
		// Past the last published edition there is nothing to queue.
		{"2026-09-10", "260903", ""},
	}
	for _, c := range cases {
		day, err := time.Parse("2006-01-02", c.day)
		if err != nil {
			t.Fatal(err)
		}
		current, next := SelectEditions(eds, day)
		if current == nil || current.Segment != c.current {
			t.Errorf("%s current = %v, want %s", c.day, current, c.current)
		}
		if c.next == "" {
			if next != nil {
				t.Errorf("%s next = %v, want none", c.day, next)
			}
			continue
		}
		if next == nil || next.Segment != c.next {
			t.Errorf("%s next = %v, want %s", c.day, next, c.next)
		}
	}
}

func TestParseADIndex(t *testing.T) {
	data, err := os.ReadFile(filepath.Join(eaipFixture, "eaip", "260710", "ad_2.htm"))
	if err != nil {
		t.Fatal(err)
	}
	doc, err := parsePage(data)
	if err != nil {
		t.Fatal(err)
	}
	by := map[string]adEntry{}
	for _, e := range ParseADIndex(doc) {
		by[e.ICAO] = e
	}
	if len(by) != 4 {
		t.Fatalf("aerodromes = %d, want 4", len(by))
	}
	// The international / secondary split lives in the path and cannot
	// be derived from the code, which is why it is stored.
	if got := by["LOWG"].ADPath; got != "PART_3/AD_2/PRI/AD_2_LOWG/LO_AD_2_LOWG_en.pdf" {
		t.Errorf("LOWG ad path = %q", got)
	}
	if got := by["LOAG"].ADPath; !strings.Contains(got, "/SRY/") {
		t.Errorf("LOAG ad path = %q, want the secondary tree", got)
	}
	if by["LOWG"].Section != 2 {
		t.Errorf("LOWG section = %d, want 2", by["LOWG"].Section)
	}
	if got := by["LOWG"].ChartsPage; got != "ad_2_lowg.htm" {
		t.Errorf("LOWG charts page = %q", got)
	}
	// An aerodrome that publishes only its text section has none.
	if got := by["LOAG"].ChartsPage; got != "" {
		t.Errorf("LOAG charts page = %q, want none", got)
	}
}

func TestParseADIndexHeliports(t *testing.T) {
	data, err := os.ReadFile(filepath.Join(eaipFixture, "eaip", "260710", "ad_3.htm"))
	if err != nil {
		t.Fatal(err)
	}
	doc, err := parsePage(data)
	if err != nil {
		t.Fatal(err)
	}
	by := map[string]adEntry{}
	for _, e := range ParseADIndex(doc) {
		by[e.ICAO] = e
	}
	loat, ok := by["LOAT"]
	if !ok {
		t.Fatalf("LOAT missing from %v", by)
	}
	if loat.Section != 3 {
		t.Errorf("LOAT section = %d, want 3", loat.Section)
	}
	if loat.ChartsPage != "ad_3_loat.htm" {
		t.Errorf("LOAT charts page = %q", loat.ChartsPage)
	}
	if got := by["LOBU"].ChartsPage; got != "" {
		t.Errorf("LOBU charts page = %q, want none", got)
	}
}

func TestParseChartsPage(t *testing.T) {
	data, err := os.ReadFile(filepath.Join(eaipFixture, "eaip", "260710", "ad_2_lowg.htm"))
	if err != nil {
		t.Fatal(err)
	}
	doc, err := parsePage(data)
	if err != nil {
		t.Fatal(err)
	}
	charts := ParseChartsPage(doc)
	if len(charts) != 3 {
		t.Fatalf("charts = %d, want 3", len(charts))
	}
	// The chart number carries the kind (ICAO Annex 4 sequence), and
	// the English wording beside the German one is the one kept.
	want := []chartRef{
		{Code: "ADC", Title: "Aerodrome Chart - ICAO"},
		{Code: "AOC", Title: "Aerodrome Obstacle Chart - ICAO Type A (Operating Limitations)"},
		{Code: "SID", Title: "Standard Departure Chart - Instrument (SID) - ICAO (RWY 16C)"},
	}
	for i, w := range want {
		if charts[i].Code != w.Code {
			t.Errorf("chart %d code = %q, want %q", i, charts[i].Code, w.Code)
		}
		if charts[i].Title != w.Title {
			t.Errorf("chart %d title = %q, want %q", i, charts[i].Title, w.Title)
		}
		if !strings.HasSuffix(charts[i].Path, ".pdf") {
			t.Errorf("chart %d path = %q", i, charts[i].Path)
		}
	}
}

func TestParseChartsPageEncoding(t *testing.T) {
	data, err := os.ReadFile(filepath.Join(eaipFixture, "eaip", "260710", "ad_2_loav.htm"))
	if err != nil {
		t.Fatal(err)
	}
	doc, err := parsePage(data)
	if err != nil {
		t.Fatal(err)
	}
	charts := ParseChartsPage(doc)
	if len(charts) != 1 {
		t.Fatalf("charts = %d, want 1", len(charts))
	}
	// The pages are ISO-8859-1 with no charset declaration, so the place
	// name reads correctly only through the latin1 decode.
	if got := charts[0].Title; got != "Chart for VFR flights VÖSLAU" {
		t.Errorf("title = %q", got)
	}
	if charts[0].Code != "VAC" {
		t.Errorf("code = %q, want VAC", charts[0].Code)
	}
	// A fifth of the chart directories carry a space in their name, which
	// the stored path encodes so consumers can concatenate it as-is.
	if got := charts[0].Path; !strings.Contains(got, "SECONDARY_%20LOAV") {
		t.Errorf("path = %q, want the space encoded", got)
	}
}

func TestChartFamily(t *testing.T) {
	cases := map[string]string{
		"1-1":      "ADC",
		"2-1":      "APDC",
		"3-2":      "GMC",
		"4-1":      "AOC",
		"5-1":      "AOC",
		"6-1":      "AOC",
		"7-3":      "PATC",
		"9-1-2":    "SID",
		"11-2-2-1": "STAR",
		"12-1":     "ATCSMAC",
		"13-1-2-1": "IAC",
		"14-2":     "VAC",
		"99-1":     "MISC",
		"":         "MISC",
	}
	for in, want := range cases {
		if got := chartFamily(in); got != want {
			t.Errorf("chartFamily(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestBuildAdCharts(t *testing.T) {
	trees, err := acquireEaipOffline(eaipFixture, func() time.Time {
		return time.Date(2026, 7, 22, 0, 0, 0, 0, time.UTC)
	})
	if err != nil {
		t.Fatal(err)
	}
	// Only the edition in force is in the fixture; the ones published
	// ahead of it are listed but not stored.
	if len(trees) != 1 {
		t.Fatalf("editions = %d, want 1", len(trees))
	}

	artifact, meta, err := BuildAdCharts(trees[0], AdChartsOptions{
		Now: fixedNow, MinAerodromes: 1, MinCharts: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if artifact.Edition != "260710" {
		t.Errorf("edition = %q", artifact.Edition)
	}
	if artifact.Base != "https://eaip.austrocontrol.at/lo/260710/" {
		t.Errorf("base = %q", artifact.Base)
	}
	if meta.Effective != "2026-07-10T00:00:00.000Z" {
		t.Errorf("effective = %q", meta.Effective)
	}
	if meta.Aerodromes != 4 || meta.Heliports != 2 {
		t.Errorf("meta counts = %d aerodromes / %d heliports, want 4/2", meta.Aerodromes, meta.Heliports)
	}
	if meta.WithCharts != 4 {
		t.Errorf("withCharts = %d, want 4", meta.WithCharts)
	}
	if len(meta.UnknownChart) != 0 {
		t.Errorf("unknownChartNumbers = %v, want none", meta.UnknownChart)
	}

	rows := map[string][]any{}
	for _, r := range artifact.Rows {
		row := r.([]any)
		rows[row[0].(string)] = row
	}
	// Every aerodrome of the index carries its AD section, whether or
	// not it publishes charts.
	if len(rows) != 6 {
		t.Fatalf("rows = %d, want 6", len(rows))
	}
	if got := rows["LOAG"][1].(string); got == "" {
		t.Error("LOAG lost its AD section path")
	}
	if got := rows["LOAG"][2].([][]string); len(got) != 0 {
		t.Errorf("LOAG charts = %v, want none", got)
	}
	if got := rows["LOWG"][2].([][]string); len(got) != 3 {
		t.Errorf("LOWG charts = %d, want 3", len(got))
	}
	if got := rows["LOAT"][1].(string); !strings.Contains(got, "AD_3") {
		t.Errorf("LOAT ad path = %q, want the AD 3 tree", got)
	}
}

func TestBuildAdChartsSanityFloor(t *testing.T) {
	trees, err := acquireEaipOffline(eaipFixture, func() time.Time {
		return time.Date(2026, 7, 22, 0, 0, 0, 0, time.UTC)
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := BuildAdCharts(trees[0], AdChartsOptions{
		Now: fixedNow, MinAerodromes: 500, MinCharts: 1,
	}); err == nil {
		t.Error("an aerodrome count below the floor should fail the build")
	}
	if _, _, err := BuildAdCharts(trees[0], AdChartsOptions{
		Now: fixedNow, MinAerodromes: 1, MinCharts: 5000,
	}); err == nil {
		t.Error("a chart count below the floor should fail the build")
	}
}
