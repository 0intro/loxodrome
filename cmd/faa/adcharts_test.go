package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestBuildAdCharts(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("testdata", "d-TPP_Metafile_sample.xml"))
	if err != nil {
		t.Fatal(err)
	}
	effective := time.Date(2026, 7, 9, 0, 0, 0, 0, time.UTC)
	art, meta, err := buildAdCharts(data, "2607", dtppChartBase("2607"), "fixture", effective, fixedNow)
	if err != nil {
		t.Fatal(err)
	}
	if art.Cycle != "2607" || art.Base != "https://aeronav.faa.gov/d-tpp/2607/" {
		t.Errorf("cycle/base = %q / %q", art.Cycle, art.Base)
	}
	if meta.Effective != "2026-07-09" {
		t.Errorf("effective = %q", meta.Effective)
	}

	rows := map[string][][]string{}
	for _, row := range art.Rows {
		rows[row[0].(string)] = row[1].([][]string)
	}
	// KJFK keyed by its ICAO ident; the FAA-ident-only field keyed by its
	// apt_ident; the third airport's only record has no PDF, so it is
	// dropped entirely.
	if _, ok := rows["KJFK"]; !ok {
		t.Fatalf("KJFK missing; rows = %v", keysOf(rows))
	}
	if _, ok := rows["79J"]; !ok {
		t.Errorf("the FAA-ident-only field (79J) should key by apt_ident; rows = %v", keysOf(rows))
	}
	if _, ok := rows["KTST"]; ok {
		t.Error("an airport with no usable charts should be dropped")
	}

	// Family mapping: airport diagram -> ADC, approach -> IAC, departure ->
	// SID, arrival -> STAR, and the minimums text page -> MISC.
	byCode := map[string]string{}
	for _, c := range rows["KJFK"] {
		byCode[c[0]] = c[1]
	}
	for code, wantSub := range map[string]string{
		"ADC":  "AIRPORT DIAGRAM",
		"IAC":  "",
		"SID":  "",
		"STAR": "",
		"MISC": "MINIMUMS",
	} {
		if _, ok := byCode[code]; !ok {
			t.Errorf("KJFK missing family %s; got %v", code, byCode)
		}
		_ = wantSub
	}
	if byCode["ADC"] != "AIRPORT DIAGRAM" {
		t.Errorf("ADC title = %q, want AIRPORT DIAGRAM", byCode["ADC"])
	}
}

func TestChartFamily(t *testing.T) {
	cases := map[string]string{
		"IAP":  "IAC",
		"DP":   "SID",
		"ODP":  "SID",
		"STR":  "STAR",
		"STAR": "STAR",
		"APD":  "ADC",
		"MIN":  "MISC",
		"HOT":  "MISC",
		"LAH":  "MISC",
		"XXX":  "MISC",
	}
	for in, want := range cases {
		if got := chartFamily(in); got != want {
			t.Errorf("chartFamily(%q) = %q, want %q", in, got, want)
		}
	}
}

func keysOf(m map[string][][]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
