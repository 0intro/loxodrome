// build.go assembles the uk-adcharts.json artifact and meta from the
// per-aerodrome chart lists. Same shape as fr-adcharts.json so the SPA
// loader and airport panel treat them uniformly.

package main

import (
	"sort"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
)

// adPage is one aerodrome page discovered in the eAIP menu.
type adPage struct {
	ICAO    string
	Section int // 2 = AD 2 aerodromes, 3 = AD 3 heliports
}

// chartRef is one published chart: Code the family the title maps to,
// Title the published English description, Path the graphics/<n>.pdf href
// relative to the AIRAC-root base.
type chartRef struct {
	Code  string
	Title string
	Path  string
}

var (
	outputFields = []string{"icao", "charts"}
	chartFields  = []string{"code", "title", "path"}
)

// Artifact is the uk-adcharts.json payload. Base is the AIRAC-root URL
// the stored paths resolve against; the app rebuilds its own at render
// (the dated segment rotates every cycle), so Base is informational.
type Artifact struct {
	Fields      []string `json:"fields"`
	ChartFields []string `json:"chartFields"`
	Base        string   `json:"base"`
	Rows        [][]any  `json:"rows"`
}

// Meta is the uk-adcharts.meta.json sidecar. generatedAt lives here
// alone, so an unchanged cycle yields a byte-identical artifact.
type Meta struct {
	GeneratedAt  string         `json:"generatedAt"`
	Effective    string         `json:"effective"`
	Source       string         `json:"source"`
	Base         string         `json:"base"`
	Aerodromes   int            `json:"aerodromes"`
	Charts       int            `json:"charts"`
	ByFamily     map[string]int `json:"byFamily"`
	PagesFetched int            `json:"pagesFetched"`
	MiscTitles   []string       `json:"miscTitles"`
}

// build sorts the aerodromes by ICAO, drops those with no charts, and
// records the distinct titles that fell through to MISC so a new title
// style is visible cycle to cycle.
func build(charts map[string][]chartRef, effective time.Time, base, menuURL string, fetched int, now time.Time) (Artifact, Meta) {
	icaos := make([]string, 0, len(charts))
	for icao := range charts {
		icaos = append(icaos, icao)
	}
	sort.Strings(icaos)

	art := Artifact{Fields: outputFields, ChartFields: chartFields, Base: base}
	meta := Meta{
		GeneratedAt:  now.UTC().Format("2006-01-02T15:04:05.000Z"),
		Effective:    aip.AiracISO(effective),
		Source:       menuURL,
		Base:         base,
		ByFamily:     map[string]int{},
		PagesFetched: fetched,
	}
	miscSet := map[string]bool{}
	for _, icao := range icaos {
		refs := charts[icao]
		if len(refs) == 0 {
			continue
		}
		rows := make([][]string, 0, len(refs))
		for _, c := range refs {
			rows = append(rows, []string{c.Code, c.Title, c.Path})
			meta.ByFamily[c.Code]++
			if c.Code == "MISC" {
				miscSet[c.Title] = true
			}
		}
		art.Rows = append(art.Rows, []any{icao, rows})
		meta.Aerodromes++
		meta.Charts += len(refs)
	}
	for t := range miscSet {
		meta.MiscTitles = append(meta.MiscTitles, t)
	}
	sort.Strings(meta.MiscTitles)
	return art, meta
}
