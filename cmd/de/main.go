// Command de reads the DFS Germany AIXM 5.1.1 AIP datasets and emits
// the per-dataset JSON artefacts the SPA consumes: de-airspaces.json,
// de-airports.json, de-navaids.json and de-obstacles.json. Schema
// mirrors cmd/fr / cmd/uk (the SPA loader treats per-country files
// uniformly).
//
// DFS publishes at https://aip.dfs.de/datasets/ one AIP dataset split
// across per-feature-type files (ED_AirportHeliport_*, ED_Runway_*,
// ED_Service_*, ED_Navaids_*, ED_Waypoints_*,
// ED_Airspace_ReferencedBorders_*) plus a separate ED_Obstacles_Area_1_*
// file. Pass every file in one invocation: the runway / radio xlink
// resolution needs the AirportHeliport, Runway and Service features
// decoded together, which aixm5.DecodeAll does (decodeInputs).
//
// The effective AIRAC date comes from -effective (the workflow reads it
// from the DFS metadata AmdtNumeric); it falls back to the effective
// date embedded in the DFS filename (the second ISO date in
// ED_<Feature>_<published>_<effective>_revision.xml), then the AIXM
// messageMetadata dateStamp (the publication date, so a last resort).
//
// Run directly:
//
//	go run ./cmd/de -effective 20260709 local/ED_*.xml

package main

import (
	"cmp"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/aixm5build"
)

// defaultOutDir is resolved relative to the working directory,
// expected to be the repo root (`go run ./cmd/de`).
const defaultOutDir = "public/data"

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// inFlag captures repeated -in arguments. DFS publishes one AIP dataset
// as separate per-feature-type files; passing them all in one run lets
// aixm5.DecodeAll resolve runways and radios onto their airports and
// each builder emit a single merged de-*.json.
type inFlag []string

func (f *inFlag) String() string     { return strings.Join(*f, ",") }
func (f *inFlag) Set(v string) error { *f = append(*f, v); return nil }

func run() error {
	var ins inFlag
	flag.Var(&ins, "in", "path to a DFS Germany AIXM 5.1 .xml file or .zip wrapper (repeatable; trailing positional args are also accepted)")
	outDir := flag.String("out", defaultOutDir, "output directory for de-*.json and de-*.meta.json")
	target := flag.String("target", "auto", `output slot: "current" (de-*.json), "next" (de-*.next.json), or "auto" (decide from the AIXM effective date)`)
	only := flag.String("only", "", "comma-separated dataset filter; empty means all (airspaces,obstacles,airports,navaids,facilities,adcharts)")
	effectiveFlag := flag.String("effective", "", "AIRAC effective date (YYYY-MM-DD or YYYYMMDD); overrides the DFS filename / AIXM dateStamp")
	chartsIn := flag.String("charts-in", "", "offline mode for -only adcharts: read a saved DFS BasicVFR config.js instead of fetching it")
	minAdAerodromes := flag.Int("min-ad-aerodromes", 0, "sanity window floor for the eAIP aerodrome-link count (0 = default)")
	var win aip.SanityWindows
	win.Register(flag.CommandLine)
	flag.Parse()

	want := aip.DatasetFilter(*only)

	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		return err
	}

	// The aerodrome-link dataset comes from the DFS BasicVFR permalinks
	// index, not the AIXM files, so a charts-only run needs no -in input.
	needAIXM := want("airspaces") || want("obstacles") || want("airports") ||
		want("navaids") || want("facilities")

	if want("adcharts") {
		if err := buildAdCharts(*chartsIn, *outDir, AdChartsOptions{
			Now:           time.Now,
			MinAerodromes: *minAdAerodromes,
		}); err != nil {
			return fmt.Errorf("adcharts: %w", err)
		}
	}
	if !needAIXM {
		return nil
	}

	inputs := append([]string{}, ins...)
	inputs = append(inputs, flag.Args()...)
	if len(inputs) == 0 {
		return fmt.Errorf("at least one input file required (use -in or positional args)")
	}

	// DFS splits one AIP dataset across per-feature-type files;
	// decodeInputs streams them into one message via aixm5.DecodeAll so
	// runway / radio xlinks resolve onto their airports.
	msg, src, name, err := decodeInputs(inputs)
	if err != nil {
		return err
	}

	// Effective AIRAC date. The AIXM messageMetadata dateStamp is the
	// publication date (28 days before a NEXT amendment becomes
	// effective), so it cannot decide the current vs next slot. Prefer
	// the explicit -effective the workflow reads from the DFS metadata,
	// then the effective date embedded in the DFS filename, then the
	// dateStamp as a last resort.
	effective := normaliseEffective(*effectiveFlag)
	if effective == "" {
		effective = effectiveFromName(inputs[0])
	}
	if effective == "" {
		effective = msg.Effective
	}

	now := time.Now

	if want("airspaces") {
		artifact, meta, err := aixm5build.BuildAirspaces(msg, name, src, effective, aixm5build.AirspacesOptions{
			Country:      "DE",
			Now:          now,
			MinAirspaces: win.MinAirspaces,
			MaxAirspaces: win.MaxAirspaces,
		})
		if err != nil {
			return fmt.Errorf("airspaces: %w", err)
		}
		slot, err := aip.WriteDataset(*outDir, "de-airspaces", *target, meta.Effective, artifact, meta)
		if err != nil {
			return fmt.Errorf("airspaces: %w", err)
		}
		fmt.Printf("wrote %d airspaces from %s; effective %s; slot=%s; skipped %d non-baseline; %d unresolved xlinks\n",
			meta.AirspaceCount, name, meta.Effective, slot,
			meta.SkippedNonBaseline, meta.UnresolvedXlinks)
	}

	if want("obstacles") {
		artifact, meta, err := aixm5build.BuildObstacles(msg, name, src, effective, aixm5build.ObstaclesOptions{
			IDPrefix:     "de",
			Country:      "DE",
			Now:          now,
			MinObstacles: win.MinObstacles,
			MaxObstacles: cmp.Or(win.MaxObstacles, defaultMaxDeObstacles),
		})
		if err != nil {
			return fmt.Errorf("obstacles: %w", err)
		}
		slot, err := aip.WriteDataset(*outDir, "de-obstacles", *target, meta.Effective, artifact, meta)
		if err != nil {
			return fmt.Errorf("obstacles: %w", err)
		}
		fmt.Printf("wrote %d obstacles (%d lit) from %s; effective %s; slot=%s\n",
			meta.ObstacleCount, meta.LitCount, name, meta.Effective, slot)
	}

	if want("airports") {
		artifact, meta, err := aixm5build.BuildAirports(msg, name, src, effective, aixm5build.AirportsOptions{
			Country:         "DE",
			CountryFromIcao: deCountryFromIcao,
			Now:             now,
			MinAirports:     win.MinAirports,
			MaxAirports:     cmp.Or(win.MaxAirports, defaultMaxDeAirports),
		})
		if err != nil {
			return fmt.Errorf("airports: %w", err)
		}
		slot, err := aip.WriteDataset(*outDir, "de-airports", *target, meta.Effective, artifact, meta)
		if err != nil {
			return fmt.Errorf("airports: %w", err)
		}
		fmt.Printf("wrote %d airports (%d runways, %d military) from %s; effective %s; slot=%s\n",
			meta.AhpCount, meta.RunwayCount, meta.MilitaryCount, name, meta.Effective, slot)
	}

	if want("facilities") {
		artifact, meta, err := aixm5build.BuildFacilities(msg, name, src, effective, aixm5build.FacilitiesOptions{
			Country:       "DE",
			Now:           now,
			MinAerodromes: 900,
			MaxAerodromes: 2500,
		})
		if err != nil {
			return fmt.Errorf("facilities: %w", err)
		}
		slot, err := aip.WriteDataset(*outDir, "de-aerodrome-facilities", *target, meta.Effective, artifact, meta)
		if err != nil {
			return fmt.Errorf("facilities: %w", err)
		}
		fmt.Printf("wrote %d aerodrome facilities (%d heliports, %d notes skipped) from %s; effective %s; slot=%s\n",
			meta.AerodromeCount, meta.HeliportCount, meta.SkippedNotes, name, meta.Effective, slot)
	}

	if want("navaids") {
		artifact, meta, err := aixm5build.BuildNavaids(msg, name, src, effective, aixm5build.NavaidsOptions{
			IDPrefix:   "de",
			Country:    "DE",
			Now:        now,
			MinNavaids: win.MinNavaids,
			MaxNavaids: win.MaxNavaids,
		})
		if err != nil {
			return fmt.Errorf("navaids: %w", err)
		}
		slot, err := aip.WriteDataset(*outDir, "de-navaids", *target, meta.Effective, artifact, meta)
		if err != nil {
			return fmt.Errorf("navaids: %w", err)
		}
		fmt.Printf("wrote %d navaids from %s; effective %s; slot=%s\n",
			meta.NavaidCount, name, meta.Effective, slot)
	}

	return nil
}

// dfsDateRe matches the ISO dates embedded in a DFS dataset filename,
// ED_<Feature>_<published>_<effective>_revision.xml. The effective
// date is the second (last) one.
var dfsDateRe = regexp.MustCompile(`\d{4}-\d{2}-\d{2}`)

// effectiveFromName extracts the AIRAC effective date from a DFS
// filename, returning the ISO-8601 midnight form aip.ResolveTarget
// parses. Empty when the name carries no ISO date (e.g. the operator
// renamed the file).
func effectiveFromName(path string) string {
	m := dfsDateRe.FindAllString(filepath.Base(path), -1)
	if len(m) == 0 {
		return ""
	}
	return m[len(m)-1] + "T00:00:00.000Z"
}

// normaliseEffective accepts YYYYMMDD (the DFS metadata AmdtNumeric) or
// YYYY-MM-DD and returns the ISO-8601 midnight form; anything else
// (including an already-ISO timestamp) is passed through for
// aip.ResolveTarget to parse. Empty input returns empty.
func normaliseEffective(s string) string {
	s = strings.TrimSpace(s)
	switch {
	case s == "":
		return ""
	case len(s) == 8 && isAllDigits(s):
		return s[:4] + "-" + s[4:6] + "-" + s[6:8] + "T00:00:00.000Z"
	case len(s) == 10 && s[4] == '-' && s[7] == '-':
		return s + "T00:00:00.000Z"
	default:
		return s
	}
}

func isAllDigits(s string) bool {
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
