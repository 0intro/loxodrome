// Command es reads a Spain ENAIRE AIXM 5.1 dataset (LE_Amdt_*) and
// emits the per-dataset JSON artefacts the SPA consumes:
// es-airspaces.json and es-obstacles.json. Schema mirrors cmd/fr /
// cmd/uk (the SPA loader treats per-country files uniformly).
//
// ENAIRE publishes bare .xml files via aip.enaire.es (no zip
// wrapping); per-airport obstacle files live alongside the main
// airspace dataset.
//
// Phase 3 scope: -in points to a local .xml. Auto-discovery against
// the ENAIRE digital datasets index page arrives in a follow-up.
//
// Run directly: go run ./cmd/es -in local/LE_Amdt_A_*_AIP_DS_FULL_Airspace.xml

package main

import (
	"cmp"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/aixm5build"
)

// defaultOutDir is resolved relative to the working directory,
// expected to be the repo root (`go run ./cmd/es`).
const defaultOutDir = "public/data"

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// inFlag captures repeated -in arguments. ENAIRE publishes per-
// aerodrome obstacle files separately; passing all 51 in one run
// avoids re-decoding overhead and lets BuildObstacles emit a single
// merged es-obstacles.json.
type inFlag []string

func (f *inFlag) String() string     { return strings.Join(*f, ",") }
func (f *inFlag) Set(v string) error { *f = append(*f, v); return nil }

func run() error {
	var ins inFlag
	flag.Var(&ins, "in", "path to a Spain ENAIRE AIXM 5.1 .xml file or .zip wrapper (repeatable; trailing positional args are also accepted)")
	outDir := flag.String("out", defaultOutDir, "output directory for es-*.json and es-*.meta.json")
	target := flag.String("target", "auto", `output slot: "current" (es-*.json), "next" (es-*.next.json), or "auto" (decide from the AIXM effective date)`)
	only := flag.String("only", "", "comma-separated dataset filter; empty means all (airspaces,obstacles,airports,navaids,facilities,supaip)")
	var win aip.SanityWindows
	win.Register(flag.CommandLine)
	supIn := flag.String("sup-in", "", "read the supplement corpus from a snapshot directory instead of aip.enaire.es")
	supSnapshot := flag.String("sup-snapshot", "", "write every fetched supplement document to this directory")
	minSupaip := flag.Int("min-supaip", 0, "sanity window floor for supplement count (0 = default)")
	maxSupaip := flag.Int("max-supaip", 0, "sanity window ceiling for supplement count (0 = default)")
	flag.Parse()

	want := aip.DatasetFilter(*only)
	now := time.Now

	// The supplements come from the public listing, not from the AIXM
	// export, so `-only=supaip` is a network-only run with no inputs.
	needAixm := want("airspaces") || want("obstacles") || want("airports") ||
		want("navaids") || want("facilities")

	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		return err
	}

	if want("supaip") {
		if err := buildSupaipDataset(*outDir, *supIn, *supSnapshot, now, *minSupaip, *maxSupaip); err != nil {
			return fmt.Errorf("supaip: %w", err)
		}
	}
	if !needAixm {
		return nil
	}

	inputs := append([]string{}, ins...)
	inputs = append(inputs, flag.Args()...)
	if len(inputs) == 0 {
		return fmt.Errorf("at least one input file required (use -in or positional args)")
	}

	// ENAIRE publishes airspaces, en-route and per-aerodrome obstacles
	// as separate files; decodeInputs merges them so each builder emits
	// one es-*.json covering every aerodrome. The effective AIRAC date
	// comes from the first file's messageMetadata dateStamp (ENAIRE
	// filenames carry an amendment number, not a publication date).
	msg, src, name, err := decodeInputs(inputs)
	if err != nil {
		return err
	}
	effective := msg.Effective

	if want("airspaces") {
		artifact, meta, err := aixm5build.BuildAirspaces(msg, name, src, effective, aixm5build.AirspacesOptions{
			Country:      "ES",
			Now:          now,
			MinAirspaces: win.MinAirspaces,
			MaxAirspaces: win.MaxAirspaces,
		})
		if err != nil {
			return fmt.Errorf("airspaces: %w", err)
		}
		slot, err := aip.WriteDataset(*outDir, "es-airspaces", *target, meta.Effective, artifact, meta)
		if err != nil {
			return fmt.Errorf("airspaces: %w", err)
		}
		fmt.Printf("wrote %d airspaces from %s; effective %s; slot=%s; skipped %d non-baseline; %d unresolved xlinks\n",
			meta.AirspaceCount, name, meta.Effective, slot,
			meta.SkippedNonBaseline, meta.UnresolvedXlinks)
	}

	if want("obstacles") {
		artifact, meta, err := aixm5build.BuildObstacles(msg, name, src, effective, aixm5build.ObstaclesOptions{
			IDPrefix:     "es",
			Country:      "ES",
			Now:          now,
			MinObstacles: win.MinObstacles,
			MaxObstacles: cmp.Or(win.MaxObstacles, defaultMaxEsObstacles),
			MinHeightM:   esMinObstacleHeightM,
		})
		if err != nil {
			return fmt.Errorf("obstacles: %w", err)
		}
		slot, err := aip.WriteDataset(*outDir, "es-obstacles", *target, meta.Effective, artifact, meta)
		if err != nil {
			return fmt.Errorf("obstacles: %w", err)
		}
		fmt.Printf("wrote %d obstacles (%d lit) from %s; effective %s; slot=%s\n",
			meta.ObstacleCount, meta.LitCount, name, meta.Effective, slot)
	}

	if want("airports") {
		artifact, meta, err := aixm5build.BuildAirports(msg, name, src, effective, aixm5build.AirportsOptions{
			Country:         "ES",
			CountryFromIcao: esCountryFromIcao,
			Now:             now,
			MinAirports:     win.MinAirports,
			MaxAirports:     cmp.Or(win.MaxAirports, defaultMaxEsAirports),
		})
		if err != nil {
			return fmt.Errorf("airports: %w", err)
		}
		slot, err := aip.WriteDataset(*outDir, "es-airports", *target, meta.Effective, artifact, meta)
		if err != nil {
			return fmt.Errorf("airports: %w", err)
		}
		fmt.Printf("wrote %d airports (%d runways, %d military) from %s; effective %s; slot=%s\n",
			meta.AhpCount, meta.RunwayCount, meta.MilitaryCount, name, meta.Effective, slot)
	}

	if want("navaids") {
		artifact, meta, err := aixm5build.BuildNavaids(msg, name, src, effective, aixm5build.NavaidsOptions{
			IDPrefix:   "es",
			Country:    "ES",
			Now:        now,
			MinNavaids: win.MinNavaids,
			MaxNavaids: win.MaxNavaids,
		})
		if err != nil {
			return fmt.Errorf("navaids: %w", err)
		}
		slot, err := aip.WriteDataset(*outDir, "es-navaids", *target, meta.Effective, artifact, meta)
		if err != nil {
			return fmt.Errorf("navaids: %w", err)
		}
		fmt.Printf("wrote %d navaids from %s; effective %s; slot=%s\n",
			meta.NavaidCount, name, meta.Effective, slot)
	}

	if want("facilities") {
		artifact, meta, err := aixm5build.BuildFacilities(msg, name, src, effective, aixm5build.FacilitiesOptions{
			Country:       "ES",
			Now:           now,
			MinAerodromes: 150,
			MaxAerodromes: 800,
		})
		if err != nil {
			return fmt.Errorf("facilities: %w", err)
		}
		slot, err := aip.WriteDataset(*outDir, "es-aerodrome-facilities", *target, meta.Effective, artifact, meta)
		if err != nil {
			return fmt.Errorf("facilities: %w", err)
		}
		fmt.Printf("wrote %d aerodrome facilities (%d heliports, %d notes skipped) from %s; effective %s; slot=%s\n",
			meta.AerodromeCount, meta.HeliportCount, meta.SkippedNotes, name, meta.Effective, slot)
	}

	return nil
}
