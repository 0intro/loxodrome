// build.go: top-level orchestrator. Turn the OurAirports CSVs into the
// artefact + meta the browser consumes (the worldwide baseline). France
// AIXM enrichment is produced separately by cmd/fr and merged by the
// SPA loader. No I/O lives here so the pipeline stays test-friendly.

package main

import (
	"time"
)

const (
	defaultMinRows = 60000
	defaultMaxRows = 120000
)

// Output fields. Order matters: the browser references them via index
// constants in src/lib/data/airports.ts.
//
// "access", "military", "vfr", "ifr", "joint" are AIXM-derived extras the
// SPA fills in from the per-country *-airports.json files after merging; the
// OurAirports baseline writes empty/false values into these slots so the row
// shape stays stable. "frequencies" is the exception: the baseline populates
// it from OurAirports' airport-frequencies.csv (worldwide), and the AIXM
// overlay replaces it where it has authoritative data (France, UK).
var outputFields = []string{
	"ident",
	"type",
	"name",
	"lat",
	"lon",
	"elev_ft",
	"iso_country",
	"municipality",
	"iata",
	"runways",
	"access",
	"military",
	"vfr",
	"ifr",
	"joint",
	"frequencies",
}

// Per-runway sub-array shape (must mirror RUNWAY_IDX in
// src/lib/data/airports.ts). The eight per-direction declared-distance
// fields (LDA / TORA / TODA / ASDA on the LE and HE thresholds) are
// null in the OurAirports baseline (AIXM populates them in the
// per-country *-airports.json files).
var runwayFields = []string{
	"le", "he", "length_ft", "width_ft", "surface", "lit",
	"le_lda_ft", "le_tora_ft", "le_toda_ft", "le_asda_ft",
	"he_lda_ft", "he_tora_ft", "he_toda_ft", "he_asda_ft",
}

// Per-frequency sub-array shape (must mirror FREQ_IDX in
// src/lib/data/airports.ts). One triple per radio service: the published
// MHz string, the curated service label (TWR / APP / ATIS / AFIS / A/A / …),
// and the spoken call sign (may be empty).
var frequencyFields = []string{"freq", "unit", "call"}

// Artifact is the top-level shape written to data/airports.json. Field
// order here determines key order in the compact JSON output.
type Artifact struct {
	Fields          []string `json:"fields"`
	RunwayFields    []string `json:"runwayFields"`
	FrequencyFields []string `json:"frequencyFields"`
	Rows            []any    `json:"rows"`
}

// Meta is the shape written to data/airports.meta.json. Field declaration
// order is the on-disk key order.
type Meta struct {
	GeneratedAt    string `json:"generatedAt"`
	SourceSha256   string `json:"sourceSha256"`
	RawRowCount    int    `json:"rawRowCount"`
	RowCount       int    `json:"rowCount"`
	RunwayCount    int    `json:"runwayCount"`
	FrequencyCount int    `json:"frequencyCount"`
	// ShortRows counts data rows with fewer cells than the header
	// promised; they are skipped rather than indexed (which would
	// panic), and a non-zero count flags upstream format drift.
	ShortRows    int      `json:"shortRows"`
	UnknownTypes []string `json:"unknownTypes"`
}

// Result bundles what the orchestrator returns to its caller.
type Result struct {
	Airports Artifact
	Meta     Meta
}

// Options tunes the build: sanity-window bounds, the runways and
// frequencies sources (parsed or raw CSV), and an optional Now hook for
// tests.
type Options struct {
	MinRows            int
	MaxRows            int
	RunwaysCsv         string
	RunwaysByIdent     map[string][]any
	FrequenciesCsv     string
	FrequenciesByIdent map[string][]any
	Now                func() time.Time
}

// buildArtifact runs the full pipeline: load runways → parse OurAirports CSV
// → assemble the artefact and meta.
func buildArtifact(csv string, opts Options) (Result, error) {
	minRows, maxRows := rowLimits(opts)
	now := opts.Now
	if now == nil {
		now = time.Now
	}

	runways, err := resolveRunways(opts)
	if err != nil {
		return Result{}, err
	}
	frequencies, err := resolveFrequencies(opts)
	if err != nil {
		return Result{}, err
	}
	parsed, err := parseRowsFromCsv(csv, runways, frequencies, minRows, maxRows)
	if err != nil {
		return Result{}, err
	}

	return Result{
		Airports: Artifact{
			Fields:          outputFields,
			RunwayFields:    runwayFields,
			FrequencyFields: frequencyFields,
			Rows:            parsed.rows,
		},
		Meta: buildMeta(csv, parsed, parsed.rows, now()),
	}, nil
}

func rowLimits(opts Options) (minRows, maxRows int) {
	minRows, maxRows = opts.MinRows, opts.MaxRows
	if minRows == 0 {
		minRows = defaultMinRows
	}
	if maxRows == 0 {
		maxRows = defaultMaxRows
	}
	return
}

// resolveRunways prefers a pre-parsed map (test path), falls back to the raw
// CSV string, and finally returns an empty map.
func resolveRunways(opts Options) (map[string][]any, error) {
	if opts.RunwaysByIdent != nil {
		return opts.RunwaysByIdent, nil
	}
	if opts.RunwaysCsv != "" {
		return parseRunways(opts.RunwaysCsv)
	}
	return map[string][]any{}, nil
}

// resolveFrequencies prefers a pre-parsed map (test path), falls back to the
// raw CSV string, and finally returns an empty map.
func resolveFrequencies(opts Options) (map[string][]any, error) {
	if opts.FrequenciesByIdent != nil {
		return opts.FrequenciesByIdent, nil
	}
	if opts.FrequenciesCsv != "" {
		return parseFrequencies(opts.FrequenciesCsv)
	}
	return map[string][]any{}, nil
}
