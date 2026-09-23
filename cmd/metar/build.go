// build.go: the pure core. Turn NOAA AWC stationinfo responses into the
// metar-stations.json artefact + meta the browser consumes. No I/O lives
// here (the HTTP crawl is injected as a fetch func), so the pipeline stays
// test-friendly, exactly like cmd/airports.

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
)

const (
	defaultMinStations = 4000
	defaultMaxStations = 30000
)

// Station is one entry of the AWC stationinfo response
// (aviationweather.gov/api/data/stationinfo?format=json). Nulls decode to
// the zero value (empty string / nil pointer). Units as delivered: elev is
// METRES MSL (converted to feet at the display edge, matching the METAR
// obs feed); lat/lon decimal degrees.
type Station struct {
	ID       string   `json:"id"`
	ICAOID   string   `json:"icaoId"`
	IATAID   string   `json:"iataId"`
	FAAID    string   `json:"faaId"`
	WMOID    string   `json:"wmoId"`
	Site     string   `json:"site"`
	Lat      float64  `json:"lat"`
	Lon      float64  `json:"lon"`
	Elev     *float64 `json:"elev"`
	State    string   `json:"state"`
	Country  string   `json:"country"`
	Priority int      `json:"priority"`
	// e.g. ["METAR","TAF"]; the catalog keeps only stations that issue METAR.
	SiteType []string `json:"siteType"`
}

// Bbox is a stationinfo query box (minLat,minLon,maxLat,maxLon, the order
// the AWC bbox param and the notam-proxy /wx routes both use).
type Bbox struct {
	MinLat, MinLon, MaxLat, MaxLon float64
}

// CrawlOptions tunes the worldwide bbox quadtree. Zero values fall back to
// the production defaults; SeedBoxes overrides the world seed grid (tests).
type CrawlOptions struct {
	SeedDeg      float64
	MinCellDeg   float64
	CapThreshold int
	SeedBoxes    []Bbox
}

// parseStationPage decodes one stationinfo JSON array. An empty body (the
// upstream 204-ish case) is the empty slice, not an error.
func parseStationPage(b []byte) ([]Station, error) {
	b = bytes.TrimSpace(b)
	if len(b) == 0 {
		return nil, nil
	}
	var sts []Station
	if err := json.Unmarshal(b, &sts); err != nil {
		return nil, err
	}
	return sts, nil
}

// crawlStations walks the world with a bbox quadtree: a coarse seed grid,
// splitting any tile whose response reaches the cap threshold (the ~400-row
// endpoint limit) down to MinCellDeg, so a dense cell never silently
// truncates. Stations shared across tile edges are deduped by key. The fetch
// is injected so the recursion is pure and testable; it returns the deduped
// stations and the request count (a meta diagnostic).
func crawlStations(ctx context.Context, fetch func(context.Context, Bbox) ([]Station, error), opts CrawlOptions) ([]Station, int, error) {
	if opts.SeedDeg == 0 {
		opts.SeedDeg = 16
	}
	if opts.MinCellDeg == 0 {
		opts.MinCellDeg = 2
	}
	if opts.CapThreshold == 0 {
		opts.CapThreshold = 350
	}
	seeds := opts.SeedBoxes
	if seeds == nil {
		seeds = seedGrid(opts.SeedDeg)
	}

	// Dedup index across tile edges; first visit wins (visit order is
	// deterministic, so the kept record is stable even before the sort).
	seen := map[string]Station{}
	reqs := 0
	var visit func(b Bbox) error
	visit = func(b Bbox) error {
		sts, err := fetch(ctx, b)
		if err != nil {
			return err
		}
		reqs++
		splittable := (b.MaxLat-b.MinLat) > opts.MinCellDeg+1e-9 && (b.MaxLon-b.MinLon) > opts.MinCellDeg+1e-9
		if len(sts) >= opts.CapThreshold && splittable {
			for _, q := range quadrants(b) {
				if err := visit(q); err != nil {
					return err
				}
			}
			return nil
		}
		for _, s := range sts {
			k := stationKey(s)
			if k == "" {
				continue
			}
			if _, ok := seen[k]; !ok {
				seen[k] = s
			}
		}
		return nil
	}
	for _, b := range seeds {
		if err := visit(b); err != nil {
			return nil, reqs, err
		}
	}
	out := make([]Station, 0, len(seen))
	for _, s := range seen {
		out = append(out, s)
	}
	return out, reqs, nil
}

// seedGrid tiles [-90,90] x [-180,180] into deg-sized boxes (clamped at the
// edges). With deg=16 and integer origins every quadtree midpoint stays an
// integer down to the 2-degree floor.
func seedGrid(deg float64) []Bbox {
	var out []Bbox
	for lat := -90.0; lat < 90; lat += deg {
		hi := math.Min(lat+deg, 90)
		for lon := -180.0; lon < 180; lon += deg {
			ro := math.Min(lon+deg, 180)
			out = append(out, Bbox{lat, lon, hi, ro})
		}
	}
	return out
}

// quadrants splits a box into its four children at the midpoints.
func quadrants(b Bbox) []Bbox {
	ml := (b.MinLat + b.MaxLat) / 2
	mn := (b.MinLon + b.MaxLon) / 2
	return []Bbox{
		{b.MinLat, b.MinLon, ml, mn},
		{b.MinLat, mn, ml, b.MaxLon},
		{ml, b.MinLon, b.MaxLat, mn},
		{ml, mn, b.MaxLat, b.MaxLon},
	}
}

// stationKey is the ident the live /wx feed serves the station under: the
// ICAO id when present, else the raw id (numeric WMO-only platforms).
func stationKey(s Station) string {
	if s.ICAOID != "" {
		return s.ICAOID
	}
	return s.ID
}

func hasType(types []string, want string) bool {
	for _, t := range types {
		if strings.EqualFold(t, want) {
			return true
		}
	}
	return false
}

// Artifact is the top-level shape written to data/metar-stations.json. Field
// order here determines key order in the compact JSON output; the positional
// rows mirror MetarStationRow in src/lib/data/metarStations.ts.
type Artifact struct {
	Fields []string `json:"fields"`
	Rows   []any    `json:"rows"`
}

// Meta is the data/metar-stations.meta.json sidecar. generatedAt churns each
// run, so the refresh workflow diff-guards on the .json only.
type Meta struct {
	GeneratedAt  string `json:"generatedAt"`
	Source       string `json:"source"`
	StationCount int    `json:"stationCount"`
	TafCount     int    `json:"tafCount"`
	CountryCount int    `json:"countryCount"`
	Requests     int    `json:"requests"`
}

// Result bundles what the build returns to the caller.
type Result struct {
	Catalog Artifact
	Meta    Meta
}

// Options tunes the build: the sanity window, the crawl request count (for
// the meta), and an optional Now hook for tests.
type Options struct {
	MinStations int
	MaxStations int
	Requests    int
	Now         func() time.Time
}

// Positional row layout, mirrored by MetarStationRow in
// src/lib/data/metarStations.ts. Keep the two in lockstep.
var outputFields = []string{
	"icaoId",
	"iata",
	"faa",
	"wmo",
	"site",
	"lat",
	"lon",
	"elev",
	"country",
	"region",
	"priority",
	"taf",
}

// buildArtifact filters the crawl result to METAR-capable stations, dedupes
// by key, sorts for a deterministic diff, and assembles the artefact + meta.
// The sanity window guards against a broken crawl landing an empty file.
func buildArtifact(stations []Station, opts Options) (Result, error) {
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	minS, maxS := opts.MinStations, opts.MaxStations
	if minS == 0 {
		minS = defaultMinStations
	}
	if maxS == 0 {
		maxS = defaultMaxStations
	}

	seen := map[string]bool{}
	kept := make([]Station, 0, len(stations))
	for _, s := range stations {
		if !hasType(s.SiteType, "METAR") {
			continue
		}
		k := stationKey(s)
		if k == "" || seen[k] {
			continue
		}
		seen[k] = true
		kept = append(kept, s)
	}
	sort.Slice(kept, func(i, j int) bool { return stationKey(kept[i]) < stationKey(kept[j]) })

	if len(kept) < minS || len(kept) > maxS {
		return Result{}, fmt.Errorf("METAR station count %d outside sanity window [%d, %d]; refusing to write", len(kept), minS, maxS)
	}

	rows := make([]any, 0, len(kept))
	tafCount := 0
	countries := map[string]bool{}
	for _, s := range kept {
		taf := hasType(s.SiteType, "TAF")
		if taf {
			tafCount++
		}
		if s.Country != "" {
			countries[s.Country] = true
		}
		var elev any
		if s.Elev != nil {
			elev = int(math.Round(*s.Elev))
		}
		rows = append(rows, []any{
			stationKey(s),
			s.IATAID,
			s.FAAID,
			s.WMOID,
			s.Site,
			aip.Round5(s.Lat),
			aip.Round5(s.Lon),
			elev,
			s.Country,
			s.State,
			s.Priority,
			taf,
		})
	}

	return Result{
		Catalog: Artifact{Fields: outputFields, Rows: rows},
		Meta: Meta{
			GeneratedAt:  now().UTC().Format("2006-01-02T15:04:05.000Z"),
			Source:       stationInfoURL,
			StationCount: len(kept),
			TafCount:     tafCount,
			CountryCount: len(countries),
			Requests:     opts.Requests,
		},
	}, nil
}
