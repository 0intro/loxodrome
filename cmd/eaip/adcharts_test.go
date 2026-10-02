package main

import (
	"testing"

	"github.com/0intro/loxodrome/internal/eaip"
)

// LGS lists each chart in the version in force and the one before it; the
// index links the one in force on the package's effective date.
func TestCurrentVersions(t *testing.T) {
	g := "https://ais.lgs.lv/eAIPfiles/x/data/2026-09-03/graphics/eAIP/"
	in := []eaip.Chart{
		{Code: "VAC", URL: g + "1564_EVAD_2_24_14_20250710.pdf"},
		{Code: "VAC", URL: g + "1795_EVAD_2_24_14_20260903.pdf"},
		{Code: "ADC", URL: g + "1616_EVAD_2_24_1_20250710.pdf"},
		// A version not yet in force gives way to the one that is.
		{Code: "IAC", URL: g + "1578_EVGA_2_24_13_RWY18_ILS_LOC_20250710.pdf"},
		{Code: "IAC", URL: g + "1900_EVGA_2_24_13_RWY18_ILS_LOC_20261001.pdf"},
		{Code: "MISC", URL: g + "noise.pdf"},
	}
	got := currentVersions(in, "2026-09-03T00:00:00.000Z")
	want := []string{"1795_EVAD_2_24_14_20260903.pdf", "1616_EVAD_2_24_1_20250710.pdf", "1578_EVGA_2_24_13_RWY18_ILS_LOC_20250710.pdf", "noise.pdf"}
	if len(got) != len(want) {
		t.Fatalf("got %+v", got)
	}
	for i, c := range got {
		if c.URL != g+want[i] {
			t.Errorf("%d: %s, want %s", i, c.URL, want[i])
		}
	}
}
