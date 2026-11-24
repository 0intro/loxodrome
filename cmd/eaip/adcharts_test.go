package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/0intro/loxodrome/internal/eaip"
	"github.com/0intro/loxodrome/internal/overlay"
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

// The index is written only from a pass that read: a page the publisher
// answers 404 for is one it does not serve, and a tenth of the pages may
// be such, but a deadline, a server error or more 404s than that leave
// the committed index standing rather than dropping those aerodromes'
// charts until the next run.
func TestWriteAdChartsRefusesAnUnreadPass(t *testing.T) {
	notFound := &overlay.StatusError{URL: "https://aip.example/x.html", Status: 404}
	serverDown := &overlay.StatusError{URL: "https://aip.example/x.html", Status: 503}
	for _, c := range []struct {
		name    string
		errs    []error
		written bool
	}{
		{"every page read", nil, true},
		{"one 404 in ten", []error{notFound}, true},
		{"two 404s in ten", []error{notFound, notFound}, false},
		{"a server error", []error{serverDown}, false},
		{"the deadline", []error{fmt.Errorf("GET x: %w", context.DeadlineExceeded)}, false},
		{"eight of ten unread", []error{notFound, notFound, notFound, notFound, notFound, notFound, notFound, notFound}, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			s := &State{CC: "xx", Label: "Test", Site: eaip.Site{Country: "XX", Family: eaip.Eurocontrol,
				Base: "https://aip.example", Lang: "en-GB", Replay: t.TempDir()}}
			cyc := eaip.Cycle{Dir: "2026-09-03-AIRAC"}
			pass := &adPass{sources: []chartPackage{&eaipPackage{label: s.Label, s: &s.Site, cyc: cyc}}}
			for i := range 10 {
				icao := fmt.Sprintf("XXA%c", 'A'+i)
				pg := aerodromePage{ad: eaip.Aerodrome{ICAO: icao, Section: 2, URL: "https://aip.example/" + icao + ".html"}}
				if i < len(c.errs) {
					pg.err = c.errs[i]
				} else {
					pg.charts = []eaip.Chart{{Code: "VAC", Title: "Visual approach chart", URL: "https://aip.example/" + icao + ".pdf"}}
				}
				pass.pages = append(pass.pages, pg)
			}
			out := t.TempDir()
			err := writeAdCharts(context.Background(), s, pass, cyc, cyc.Dir, "2026-09-03T00:00:00.000Z", resolution{}, out, "current")
			_, statErr := os.Stat(filepath.Join(out, "xx-adcharts.json"))
			if wrote := statErr == nil; wrote != c.written || (err == nil) != c.written {
				t.Errorf("writeAdCharts: error %v, wrote %v; want written %v", err, wrote, c.written)
			}
		})
	}
}
