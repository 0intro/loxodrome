// Command fr reads the French SIA AIXM 4.5 export and emits the per-dataset
// JSON artefacts the SPA consumes: fr-airspaces.json, fr-obstacles.json,
// fr-airports.json (and, once Phase 4 lands, fr-navaids.json). The shape
// mirrors cmd/uk and cmd/es so adding more countries is purely additive.
//
// SIA AIXM is proprietary and lives in gitignored local/; this command is
// run by an operator each AIRAC. There is no GitHub Action.
//
// Run directly: go run ./cmd/fr -in local/AIXM4.5_*.xml

package main

import (
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
)

// defaultOutDir is resolved relative to the working directory, expected to
// be the repo root (`go run ./cmd/fr`). Override with -out.
const defaultOutDir = "public/data"

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	in := flag.String("in", "", "path to the SIA export .zip or an AIXM .xml file")
	siaPath := flag.String("sia", "", "optional path to a standalone XML_SIA_*.xml; usually unset (the zip carries both files)")
	outDir := flag.String("out", defaultOutDir, "output directory for fr-*.json and fr-*.meta.json")
	target := flag.String("target", "auto", `output slot: "current" (fr-*.json), "next" (fr-*.next.json), or "auto" (decide from the AIXM effective date)`)
	only := flag.String("only", "", "comma-separated dataset filter; empty means all (airspaces,obstacles,airports,navaids,nature,facilities)")
	var win aip.SanityWindows
	win.Register(flag.CommandLine)
	minNature := flag.Int("min-nature", 0, "sanity window floor for nature-zone count (0 = default)")
	maxNature := flag.Int("max-nature", 0, "sanity window ceiling for nature-zone count (0 = default)")
	minFacilities := flag.Int("min-facilities", 0, "sanity window floor for aerodrome-facility count (0 = default)")
	maxFacilities := flag.Int("max-facilities", 0, "sanity window ceiling for aerodrome-facility count (0 = default)")
	flag.Parse()

	if *in == "" {
		return fmt.Errorf("-in is required (path to a .zip or .xml file)")
	}

	aixm, sia, name, err := aip.ReadSource(*in)
	if err != nil {
		return err
	}
	// -sia overrides whatever the zip carried, useful when -in is an
	// .xml-only path or for ad-hoc testing.
	if *siaPath != "" {
		sia, err = os.ReadFile(*siaPath)
		if err != nil {
			return fmt.Errorf("-sia: %w", err)
		}
	}

	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		return err
	}

	want := aip.DatasetFilter(*only)
	now := time.Now

	if want("airspaces") {
		artifact, meta, err := BuildAirspaces(aixm, AirspacesOptions{Source: name, SIASource: sia, Now: now, MinAirspaces: win.MinAirspaces, MaxAirspaces: win.MaxAirspaces})
		if err != nil {
			return fmt.Errorf("airspaces: %w", err)
		}
		slot, err := aip.WriteDataset(*outDir, "fr-airspaces", *target, meta.Effective, artifact, meta)
		if err != nil {
			return fmt.Errorf("airspaces: %w", err)
		}
		fmt.Printf("wrote %d airspaces (%d with radio) from %s; effective %s; slot=%s; skipped %d with no boundary; %d SIVs mapped by SIA\n",
			meta.AirspaceCount, meta.WithRadio, name, meta.Effective, slot,
			meta.SkippedNoBoundary, meta.SIASectorMappedCount)
	}

	if want("obstacles") {
		artifact, meta, err := BuildObstacles(aixm, ObstaclesOptions{Source: name, Now: now, MinObstacles: win.MinObstacles, MaxObstacles: win.MaxObstacles})
		if err != nil {
			return fmt.Errorf("obstacles: %w", err)
		}
		slot, err := aip.WriteDataset(*outDir, "fr-obstacles", *target, meta.Effective, artifact, meta)
		if err != nil {
			return fmt.Errorf("obstacles: %w", err)
		}
		fmt.Printf("wrote %d obstacles (%d lit, %d grouped) from %s; effective %s; slot=%s\n",
			meta.ObstacleCount, meta.LitCount, meta.GroupCount, name, meta.Effective, slot)
	}

	if want("airports") {
		artifact, meta, err := BuildAirports(aixm, AirportsOptions{Source: name, Now: now, MinAirports: win.MinAirports, MaxAirports: win.MaxAirports})
		if err != nil {
			return fmt.Errorf("airports: %w", err)
		}
		slot, err := aip.WriteDataset(*outDir, "fr-airports", *target, meta.Effective, artifact, meta)
		if err != nil {
			return fmt.Errorf("airports: %w", err)
		}
		fmt.Printf("wrote %d airports from %s; effective %s; slot=%s; access cap/restricted = %d/%d; military = %d\n",
			meta.AhpCount, name, meta.Effective, slot,
			meta.AccessCounts["cap"], meta.AccessCounts["restricted"], meta.MilitaryCount)
	}

	if want("navaids") {
		artifact, meta, err := BuildNavaids(aixm, NavaidsOptions{Source: name, Now: now, MinNavaids: win.MinNavaids, MaxNavaids: win.MaxNavaids})
		if err != nil {
			return fmt.Errorf("navaids: %w", err)
		}
		slot, err := aip.WriteDataset(*outDir, "fr-navaids", *target, meta.Effective, artifact, meta)
		if err != nil {
			return fmt.Errorf("navaids: %w", err)
		}
		fmt.Printf("wrote %d navaids from %s; effective %s; slot=%s; %s\n",
			meta.NavaidCount, name, meta.Effective, slot, formatCounts(meta.Counts))
	}

	if want("nature") {
		artifact, meta, err := BuildNature(sia, NatureOptions{Source: name, Now: now, MinZones: *minNature, MaxZones: *maxNature})
		if err != nil {
			return fmt.Errorf("nature: %w", err)
		}
		slot, err := aip.WriteDataset(*outDir, "fr-nature", *target, meta.Effective, artifact, meta)
		if err != nil {
			return fmt.Errorf("nature: %w", err)
		}
		fmt.Printf("wrote %d nature zones from %s; effective %s; slot=%s; %s\n",
			meta.ZoneCount, name, meta.Effective, slot, formatCounts(meta.Counts))
	}

	if want("facilities") {
		artifact, meta, err := BuildAerodromeFacilities(aixm, FacilitiesOptions{Source: name, SIASource: sia, Now: now, MinAerodromes: *minFacilities, MaxAerodromes: *maxFacilities})
		if err != nil {
			return fmt.Errorf("facilities: %w", err)
		}
		slot, err := aip.WriteDataset(*outDir, "fr-aerodrome-facilities", *target, meta.Effective, artifact, meta)
		if err != nil {
			return fmt.Errorf("facilities: %w", err)
		}
		fmt.Printf("wrote %d aerodrome facilities from %s; effective %s; slot=%s; %s\n",
			meta.AerodromeCount, name, meta.Effective, slot, formatCounts(meta.Counts))
	}

	return nil
}

// formatCounts renders a Counts map as "VOR=96, NDB=95, ..." for the
// per-dataset log line; entries sorted alphabetically for stable
// output.
func formatCounts(m map[string]int) string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]string, 0, len(keys))
	for _, k := range keys {
		out = append(out, fmt.Sprintf("%s=%d", k, m[k]))
	}
	return strings.Join(out, ", ")
}
