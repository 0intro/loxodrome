package main

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func readFixture(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestParseMenu(t *testing.T) {
	pages := parseMenu(readFixture(t, "menu.html"))
	want := []adPage{
		{ICAO: "LFGA", Section: 2},
		{ICAO: "LFPO", Section: 2},
		{ICAO: "LFPT", Section: 2},
		{ICAO: "LFWF", Section: 3},
		{ICAO: "LFWM", Section: 3},
	}
	if !reflect.DeepEqual(pages, want) {
		t.Errorf("parseMenu = %+v, want %+v", pages, want)
	}
}

func TestParseChartsLFPT(t *testing.T) {
	charts := parseCharts(readFixture(t, "ad2-lfpt.html"))
	if len(charts) != 27 {
		t.Fatalf("got %d charts, want 27", len(charts))
	}
	// Publication order: the aerodrome chart first, then ground movement.
	want0 := chartRef{Code: "ADC", Title: "01", Path: "Cartes/LFPT/AD_2_LFPT_ADC_01.pdf"}
	if charts[0] != want0 {
		t.Errorf("charts[0] = %+v, want %+v", charts[0], want0)
	}
	if charts[1].Code != "GMC" {
		t.Errorf("charts[1].Code = %s, want GMC", charts[1].Code)
	}
	last := charts[len(charts)-1]
	if last.Code != "IAC" || last.Title != "RWY22 VPT" {
		t.Errorf("last = %+v, want IAC / RWY22 VPT", last)
	}
	byFamily := map[string]int{}
	for _, c := range charts {
		byFamily[c.Code]++
	}
	wantFam := map[string]int{"ADC": 1, "GMC": 1, "DATA": 13, "IAC": 5, "SID": 4, "STAR": 3}
	if !reflect.DeepEqual(byFamily, wantFam) {
		t.Errorf("families = %v, want %v", byFamily, wantFam)
	}
}

func TestParseChartsLFWFHeliport(t *testing.T) {
	charts := parseCharts(readFixture(t, "ad3-lfwf.html"))
	if len(charts) != 14 {
		t.Fatalf("got %d charts, want 14", len(charts))
	}
	// The AD 3 tree nests under Cartes/VAC_HEL/<ICAO>/<ICAO>/, so the
	// whole relative path must be preserved.
	want0 := chartRef{Code: "TEXT", Title: "01", Path: "Cartes/VAC_HEL/LFWF/LFWF/AD_3_LFWF_TEXT_01.pdf"}
	if charts[0] != want0 {
		t.Errorf("charts[0] = %+v, want %+v", charts[0], want0)
	}
}

func TestParseChartsDedup(t *testing.T) {
	page := []byte(`<a href="Cartes/LFXX/AD_2_LFXX_IAC_RWY05.pdf">x</a>` +
		`<a href="Cartes/LFXX/AD_2_LFXX_IAC_RWY05.pdf">again</a>` +
		`<a href="Cartes/LFXX/AD_2_LFXX_ADC_01.pdf">y</a>`)
	charts := parseCharts(page)
	if len(charts) != 2 {
		t.Fatalf("got %d charts, want 2 (dedup by path)", len(charts))
	}
	if charts[0].Code != "IAC" || charts[1].Code != "ADC" {
		t.Errorf("order not preserved: %+v", charts)
	}
}

func TestSplitChartName(t *testing.T) {
	cases := []struct {
		base, code, title string
	}{
		{"AD_2_LFPO_IAC_RWY02_FNA_RNP.pdf", "IAC", "RWY02 FNA RNP"},
		{"AD_2_LFPO_ADC_01.pdf", "ADC", "01"},
		{"AD_3_LFWF_TEXT_01.pdf", "TEXT", "01"},
		{"AD_2_LFPO_AOC_RWY06-24.pdf", "AOC", "RWY06-24"},
		{"AD_2_LFPT_GMC.pdf", "GMC", ""},
		{"SOMETHING_ELSE.pdf", "", "SOMETHING ELSE"},
	}
	for _, c := range cases {
		code, title := splitChartName(c.base)
		if code != c.code || title != c.title {
			t.Errorf("splitChartName(%s) = (%q, %q), want (%q, %q)",
				c.base, code, title, c.code, c.title)
		}
	}
}

func TestBuild(t *testing.T) {
	effective := time.Date(2026, time.July, 9, 0, 0, 0, 0, time.UTC)
	charts := map[string][]chartRef{
		"LFPT": {
			{Code: "ADC", Title: "01", Path: "Cartes/LFPT/AD_2_LFPT_ADC_01.pdf"},
			{Code: "IAC", Title: "RWY22 VPT", Path: "Cartes/LFPT/AD_2_LFPT_IAC_RWY22_VPT.pdf"},
		},
		"LFGA": {
			{Code: "IAC", Title: "RWY01 ILS", Path: "Cartes/LFGA/AD_2_LFGA_IAC_RWY01_ILS.pdf"},
		},
		"LFXX": {},
	}
	// LFPT has charts and an aerodrome plate, LFGA charts only, LF075 a
	// helistation plate only (no eAIP page at all), LFPO both plates, and
	// LFXX a fetched page that published nothing and has no plate.
	vacAD := []string{"LFGB", "LFPO", "LFPT"}
	vacHel := []string{"LF075", "LFPO"}
	art, meta := build(charts, vacAD, vacHel, effective, "menu-url", 4, time.Date(2026, time.July, 21, 10, 0, 0, 0, time.UTC))
	if meta.Effective != "2026-07-09" || meta.Aerodromes != 2 || meta.Charts != 3 || meta.EmptyPages != 1 {
		t.Errorf("meta = %+v", meta)
	}
	if meta.VacAerodromes != 3 || meta.VacHeliports != 2 {
		t.Errorf("VAC counts = %d/%d, want 3/2", meta.VacAerodromes, meta.VacHeliports)
	}
	if meta.ByFamily["IAC"] != 2 || meta.ByFamily["ADC"] != 1 {
		t.Errorf("byFamily = %v", meta.ByFamily)
	}
	if got, want := meta.Source.VacHIndex,
		"https://www.sia.aviation-civile.gouv.fr/media/dvd/eAIP_09_JUL_2026/Atlas-VAC/Javascript/AeroArraysVach.js"; got != want {
		t.Errorf("VacHIndex = %q, want %q", got, want)
	}
	// Sorted by ICAO; LFXX dropped (no charts, no plate), the plate-only
	// idents kept with an empty chart list.
	idents := make([]string, 0, len(art.Rows))
	for _, r := range art.Rows {
		idents = append(idents, r[0].(string))
	}
	if want := []string{"LF075", "LFGA", "LFGB", "LFPO", "LFPT"}; !reflect.DeepEqual(idents, want) {
		t.Fatalf("idents = %v, want %v", idents, want)
	}
	byIdent := map[string][]any{}
	for _, r := range art.Rows {
		byIdent[r[0].(string)] = r
	}
	for _, c := range []struct{ ident, vac string }{
		{"LF075", "hel"}, {"LFGA", ""}, {"LFGB", "ad"}, {"LFPO", "both"}, {"LFPT", "ad"},
	} {
		if got := byIdent[c.ident][2].(string); got != c.vac {
			t.Errorf("%s vac = %q, want %q", c.ident, got, c.vac)
		}
	}
	if n := len(byIdent["LF075"][1].([][]string)); n != 0 {
		t.Errorf("LF075 charts = %d, want 0 (plate only)", n)
	}
	lfpt := byIdent["LFPT"][1].([][]string)
	if !reflect.DeepEqual(lfpt[0], []string{"ADC", "01", "Cartes/LFPT/AD_2_LFPT_ADC_01.pdf"}) {
		t.Errorf("chart tuple = %v", lfpt[0])
	}
}

func TestParseAeroArray(t *testing.T) {
	codes := parseAeroArray(readFixture(t, "AeroArraysVach.js"))
	// Sorted, deduplicated, and the parallel name array excluded (the
	// atlas emits the codes in aerodrome-name order).
	want := []string{"LF001", "LF075", "LF411", "LFPO", "LFWB"}
	if !reflect.DeepEqual(codes, want) {
		t.Errorf("parseAeroArray = %v, want %v", codes, want)
	}
	if got := parseAeroArray([]byte("var nothing = 1;")); got != nil {
		t.Errorf("parseAeroArray(no array) = %v, want nil", got)
	}
}
