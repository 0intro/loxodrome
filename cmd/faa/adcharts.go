// adcharts.go emits us-adcharts.json from the FAA's free, public-domain
// digital Terminal Procedures Publication (d-TPP): per US airport, the
// approach / departure / arrival / airport-diagram charts as
// [code, title, pdf] rows. Same panel surface as fr-adcharts.json.
//
// The FAA publishes one metafile per 28-day cycle at
// aeronav.faa.gov/d-tpp/<cycle>/xml_data/d-TPP_Metafile.xml, and the
// cycle number is the ICAO AIRAC YYNN label, so the base URL is derivable
// (aip.AiracYYNN); the app rebuilds it at render, the dataset carries the
// cycle for reference. The next cycle is published ahead, so both the
// current and next slots are written.

package main

import (
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"os"
	"sort"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/overlay"
)

func readFile(path string) ([]byte, error) { return os.ReadFile(path) }
func nowStderr() io.Writer                 { return os.Stderr }

const (
	// dtppBase is the per-cycle d-TPP directory; the metafile lives under
	// xml_data/ and every chart PDF directly under it.
	dtppHost = "https://aeronav.faa.gov/d-tpp/"

	defaultMinUsAirports = 2000
	defaultMinUsCharts   = 15000
)

// dtppMetafile mirrors the d-TPP_Metafile.xml root.
type dtppMetafile struct {
	Cycle    string        `xml:"cycle,attr"`
	FromDate string        `xml:"from_edate,attr"`
	States   []dtppState   `xml:"state_code"`
	Cities   []dtppCity    `xml:"city_name"` // never at root, keeps xml happy
	Airports []dtppAirport `xml:"airport_name"`
}

type dtppState struct {
	Cities []dtppCity `xml:"city_name"`
}

type dtppCity struct {
	Airports []dtppAirport `xml:"airport_name"`
}

type dtppAirport struct {
	AptIdent  string       `xml:"apt_ident,attr"`
	IcaoIdent string       `xml:"icao_ident,attr"`
	Records   []dtppRecord `xml:"record"`
}

type dtppRecord struct {
	ChartCode string `xml:"chart_code"`
	ChartName string `xml:"chart_name"`
	PDFName   string `xml:"pdf_name"`
}

// chartFamily maps the d-TPP chart_code to the families the app already
// labels and orders (CHART_FAMILY_ORDER in src/lib/data/airports.ts).
// The textual reference pages (takeoff / alternate minimums, hot spots,
// land-and-hold-short, diverse-departure, charted visual) share the MISC
// bucket. Verified against the d-TPP chart_name values (APD is the
// airport diagram, STR the standard arrival).
func chartFamily(code string) string {
	switch code {
	case "IAP":
		return "IAC" // instrument approach procedure
	case "DP", "ODP":
		return "SID" // (obstacle) departure procedure
	case "STAR", "STR":
		return "STAR" // standard terminal arrival
	case "APD":
		return "ADC" // airport diagram
	case "MIN", "LAH", "HOT", "DAU", "CVFP":
		return "MISC"
	}
	return "MISC"
}

// AdChartsArtifact is the us-adcharts.json document. Cycle / Base pin the
// d-TPP publication the pdf names belong to.
type AdChartsArtifact struct {
	Fields      []string `json:"fields"`
	ChartFields []string `json:"chartFields"`
	Cycle       string   `json:"cycle"`
	Base        string   `json:"base"`
	Rows        [][]any  `json:"rows"`
}

// AdChartsMeta is the us-adcharts.meta.json sidecar.
type AdChartsMeta struct {
	GeneratedAt string         `json:"generatedAt"`
	Effective   string         `json:"effective"`
	Source      string         `json:"source"`
	Cycle       string         `json:"cycle"`
	Base        string         `json:"base"`
	Airports    int            `json:"airports"`
	Charts      int            `json:"charts"`
	ByFamily    map[string]int `json:"byFamily"`
}

// buildAdCharts parses one d-TPP metafile into rows sorted by ident. An
// airport is keyed by its ICAO ident when present, else its FAA ident,
// matching how the OurAirports baseline idents US fields; a record with
// no PDF name (a rare placeholder) is skipped.
func buildAdCharts(data []byte, cycle, base, source string, effective time.Time, now func() time.Time) (AdChartsArtifact, AdChartsMeta, error) {
	var mf dtppMetafile
	if err := xml.Unmarshal(data, &mf); err != nil {
		return AdChartsArtifact{}, AdChartsMeta{}, fmt.Errorf("parse metafile: %w", err)
	}

	type entry struct {
		ident string
		rows  [][]string
	}
	byIdent := map[string]*entry{}
	var idents []string
	byFamily := map[string]int{}
	total := 0

	visit := func(a dtppAirport) {
		ident := a.IcaoIdent
		if ident == "" {
			ident = a.AptIdent
		}
		if ident == "" {
			return
		}
		e, ok := byIdent[ident]
		if !ok {
			e = &entry{ident: ident}
			byIdent[ident] = e
			idents = append(idents, ident)
		}
		for _, r := range a.Records {
			if r.PDFName == "" {
				continue
			}
			code := chartFamily(r.ChartCode)
			e.rows = append(e.rows, []string{code, r.ChartName, r.PDFName})
			byFamily[code]++
			total++
		}
	}
	for _, st := range mf.States {
		for _, c := range st.Cities {
			for _, a := range c.Airports {
				visit(a)
			}
		}
	}
	sort.Strings(idents)

	art := AdChartsArtifact{
		Fields:      []string{"icao", "charts"},
		ChartFields: []string{"code", "title", "pdf"},
		Cycle:       cycle,
		Base:        base,
	}
	airports := 0
	for _, ident := range idents {
		e := byIdent[ident]
		if len(e.rows) == 0 {
			continue
		}
		art.Rows = append(art.Rows, []any{ident, e.rows})
		airports++
	}

	meta := AdChartsMeta{
		GeneratedAt: now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Effective:   aip.AiracISO(effective),
		Source:      source,
		Cycle:       cycle,
		Base:        base,
		Airports:    airports,
		Charts:      total,
		ByFamily:    byFamily,
	}
	return art, meta, nil
}

// dtppMetaURL is the metafile URL for one cycle label.
func dtppMetaURL(cycle string) string {
	return dtppHost + cycle + "/xml_data/d-TPP_Metafile.xml"
}

// dtppChartBase is the directory the pdf names resolve against.
func dtppChartBase(cycle string) string {
	return dtppHost + cycle + "/"
}

// runAdCharts fetches (or reads offline) the current and next cycle
// metafiles and writes us-adcharts.json + its .next twin. The current
// cycle is fatal on error; the next cycle degrades to a warning (a 404 or
// a not-yet-published cycle must not sink the current slot).
func runAdCharts(ctx context.Context, outDir, currentFile, nextFile string, minAirports, minCharts int) error {
	now := time.Now
	nowT := now().UTC()

	writeSlot := func(slot, file string, effective time.Time, fatal bool) error {
		cycle := aip.AiracYYNN(effective)
		var data []byte
		var source string
		var err error
		if file != "" {
			data, err = readFile(file)
			source = file
		} else {
			source = dtppMetaURL(cycle)
			data, err = overlay.HTTPGetAll(ctx, source)
		}
		if err != nil {
			if fatal {
				return fmt.Errorf("%s cycle %s: %w", slot, cycle, err)
			}
			fmt.Fprintf(nowStderr(), "faa: %s cycle %s unavailable: %v\n", slot, cycle, err)
			return nil
		}
		art, meta, err := buildAdCharts(data, cycle, dtppChartBase(cycle), source, effective, now)
		if err != nil {
			if fatal {
				return err
			}
			fmt.Fprintf(nowStderr(), "faa: %s cycle %s: %v\n", slot, cycle, err)
			return nil
		}
		if meta.Airports < minAirports || meta.Charts < minCharts {
			err := fmt.Errorf("%s cycle %s below floors: %d airports / %d charts (want >= %d / %d)",
				slot, cycle, meta.Airports, meta.Charts, minAirports, minCharts)
			if fatal {
				return err
			}
			fmt.Fprintf(nowStderr(), "faa: %v (skipped)\n", err)
			return nil
		}
		if _, err := aip.WriteDataset(outDir, "us-adcharts", slot, meta.Effective, art, meta); err != nil {
			return err
		}
		fmt.Printf("wrote %d airports, %d charts from d-TPP cycle %s; effective %s; slot=%s\n",
			meta.Airports, meta.Charts, cycle, meta.Effective, slot)
		return nil
	}

	if err := writeSlot("current", currentFile, aip.CurrentAirac(nowT), true); err != nil {
		return err
	}
	// Offline (test) runs pass no next file and mean "current only".
	if currentFile != "" && nextFile == "" {
		return nil
	}
	return writeSlot("next", nextFile, aip.NextAirac(nowT), false)
}
