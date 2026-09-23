// adcharts.go emits at-adcharts.json: per AIP aerodrome, the path of its
// AD 2 / AD 3 text section plus the chart files it publishes. Counterpart
// of the French fr-adcharts.json, which cmd/adcharts writes from the SIA
// eAIP.
//
// The dataset carries the edition it was scraped from, because the Austro
// Control eAIP path segment is the edition's own validity date rather than
// the AIRAC date (the cycle effective 09 JUL 2026 is published as edition
// 260710), so the app resolves stored paths against the stored base
// instead of recomputing one.

package main

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	defaultMinAdAerodromes = 40
	defaultMinAdCharts     = 100
)

// adChartsOutputFields describes the positional row layout; the nested
// chart tuples use adChartFields. Mirrored by the loader in
// src/lib/data/atAdcharts.ts.
var (
	adChartsOutputFields = []string{"icao", "ad", "charts"}
	adChartFields        = []string{"code", "title", "path"}
)

// AdChartsArtifact is the at-adcharts.json document. Edition and Base
// pin the tree the paths belong to; the app builds each absolute URL as
// Base + path.
type AdChartsArtifact struct {
	Fields      []string `json:"fields"`
	ChartFields []string `json:"chartFields"`
	Edition     string   `json:"edition"`
	Base        string   `json:"base"`
	Rows        []any    `json:"rows"`
}

// AdChartsMeta is the at-adcharts.meta.json sidecar. generatedAt lives
// here alone, so an unchanged edition yields a byte-identical artifact
// and the workflow's no-op gate holds.
type AdChartsMeta struct {
	GeneratedAt  string         `json:"generatedAt"`
	Source       string         `json:"source"`
	Effective    string         `json:"effective"`
	ValidUntil   string         `json:"validUntil,omitempty"`
	Edition      string         `json:"edition"`
	Base         string         `json:"base"`
	Aerodromes   int            `json:"aerodromes"`
	Heliports    int            `json:"heliports"`
	WithCharts   int            `json:"withCharts"`
	Charts       int            `json:"charts"`
	ByFamily     map[string]int `json:"byFamily"`
	UnknownChart []string       `json:"unknownChartNumbers"`
}

// AdChartsOptions configures BuildAdCharts.
type AdChartsOptions struct {
	Now           func() time.Time
	MinAerodromes int
	MinCharts     int
}

// chartNumberRe splits the ICAO Annex 4 chart number into its leading
// group and the rest ("13-1-2-1" -> "13").
var chartNumberRe = regexp.MustCompile(`^(\d+)`)

// chartFamilyByNumber maps the leading group of the AD 2.24 chart number
// onto the families the app already labels and orders (CHART_FAMILY_ORDER
// in src/lib/data/airports.ts). Austro Control numbers its charts by the
// ICAO Annex 4 sequence, so the group is the chart kind.
var chartFamilyByNumber = map[string]string{
	"1":  "ADC",     // Aerodrome Chart
	"2":  "APDC",    // Aircraft Parking / Docking Chart
	"3":  "GMC",     // Aerodrome Ground Movement Chart
	"4":  "AOC",     // Aerodrome Obstacle Chart, Type A
	"5":  "AOC",     // Aerodrome Obstacle Chart, Type B
	"6":  "AOC",     // Aerodrome Terrain and Obstacle Chart (electronic)
	"7":  "PATC",    // Precision Approach Terrain Chart
	"9":  "SID",     // Standard Departure Chart - Instrument
	"10": "STAR",    // Standard Arrival Chart - Instrument
	"11": "STAR",    // Arrival and RNAV transition charts
	"12": "ATCSMAC", // ATC Surveillance Minimum Altitude Chart
	"13": "IAC",     // Instrument Approach Chart
	"14": "VAC",     // Chart for VFR flights
}

// chartFamily resolves one chart number to its family, "MISC" for a
// number the published sequence has not used before (tracked in the
// meta's unknownChartNumbers).
func chartFamily(number string) string {
	m := chartNumberRe.FindStringSubmatch(number)
	if m == nil {
		return "MISC"
	}
	if f, ok := chartFamilyByNumber[m[1]]; ok {
		return f
	}
	return "MISC"
}

// BuildAdCharts assembles one edition's dataset. Every aerodrome the AD 2
// and AD 3 indexes list contributes a row, so each has its official AIP
// page; the charts are those of the aerodromes that publish a chart page.
func BuildAdCharts(t *eaipTree, opts AdChartsOptions) (AdChartsArtifact, AdChartsMeta, error) {
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	minAd, minCharts := opts.MinAerodromes, opts.MinCharts
	if minAd == 0 {
		minAd = defaultMinAdAerodromes
	}
	if minCharts == 0 {
		minCharts = defaultMinAdCharts
	}

	type entry struct {
		ad     adEntry
		charts []chartRef
	}
	entries := map[string]*entry{}
	var icaos []string
	unknownSet := map[string]bool{}
	heliports := 0

	for _, page := range []string{ad2IndexPage, ad3IndexPage} {
		doc, err := t.doc(page)
		if err != nil {
			return AdChartsArtifact{}, AdChartsMeta{}, err
		}
		for _, ad := range ParseADIndex(doc) {
			if _, dup := entries[ad.ICAO]; dup {
				continue
			}
			e := &entry{ad: ad}
			entries[ad.ICAO] = e
			icaos = append(icaos, ad.ICAO)
			if ad.Section == 3 {
				heliports++
			}
			if ad.ChartsPage == "" {
				continue
			}
			cdoc, err := t.doc(ad.ChartsPage)
			if err != nil {
				return AdChartsArtifact{}, AdChartsMeta{}, fmt.Errorf("%s: %w", ad.ICAO, err)
			}
			e.charts = ParseChartsPage(cdoc)
			for _, c := range e.charts {
				if c.Code == "MISC" {
					if m := chartPdfRe.FindStringSubmatch(c.Path); m != nil {
						unknownSet[m[1]] = true
					}
				}
			}
		}
	}
	sort.Strings(icaos)

	art := AdChartsArtifact{
		Fields:      adChartsOutputFields,
		ChartFields: adChartFields,
		Edition:     t.edition.Segment,
		Base:        t.edition.Base(),
	}
	byFamily := map[string]int{}
	withCharts, chartCount := 0, 0
	for _, icao := range icaos {
		e := entries[icao]
		rows := make([][]string, 0, len(e.charts))
		for _, c := range e.charts {
			rows = append(rows, []string{c.Code, c.Title, c.Path})
			byFamily[c.Code]++
		}
		if len(rows) > 0 {
			withCharts++
			chartCount += len(rows)
		}
		art.Rows = append(art.Rows, []any{icao, e.ad.ADPath, rows})
	}

	if len(art.Rows) < minAd {
		return AdChartsArtifact{}, AdChartsMeta{}, fmt.Errorf(
			"AT eAIP aerodrome count %d below floor %d - source format may have changed",
			len(art.Rows), minAd)
	}
	if chartCount < minCharts {
		return AdChartsArtifact{}, AdChartsMeta{}, fmt.Errorf(
			"AT eAIP chart count %d below floor %d - source format may have changed",
			chartCount, minCharts)
	}

	unknown := make([]string, 0, len(unknownSet))
	for k := range unknownSet {
		unknown = append(unknown, k)
	}
	sort.Strings(unknown)

	meta := AdChartsMeta{
		GeneratedAt:  now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Source:       "Austro Control eAIP " + strings.TrimSuffix(t.edition.Base(), "/"),
		Effective:    t.edition.From,
		ValidUntil:   t.edition.Until,
		Edition:      t.edition.Segment,
		Base:         t.edition.Base(),
		Aerodromes:   len(art.Rows) - heliports,
		Heliports:    heliports,
		WithCharts:   withCharts,
		Charts:       chartCount,
		ByFamily:     byFamily,
		UnknownChart: unknown,
	}
	return art, meta, nil
}
