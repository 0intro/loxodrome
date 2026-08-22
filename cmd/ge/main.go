// Command ge reads the Georgian AIP Data Set (Sakaeronavigatsia) and
// emits the per-dataset JSON artefacts the SPA consumes: ge-airspaces,
// ge-airports, ge-navaids and ge-obstacles.
//
// The source is a single anonymous download: one 280 KB zip holding
// UG_AIP_DS_FULL_<date>_AIRAC.xml, an AIXM 5.1.1 BasicMessage in the
// standard PANS-AIM shape, which internal/aixm5 reads unchanged. That
// makes Georgia the cheapest publisher in the repo; everything below the
// fetch is the shared builders.
//
// Licensing: none is published. The AIS site carries no terms, no
// copyright notice and no re-use statement, which is silence rather than
// a grant; see docs/ge-aip.md.
//
// Run directly:
//
//	go run ./cmd/ge                 # discover and fetch the current data set
//	go run ./cmd/ge -in local/UG_AIP_DS_20260709_AIRAC.zip
package main

import (
	"cmp"
	"context"
	"flag"
	"fmt"
	"os"
	"regexp"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/aixm5"
	"github.com/0intro/loxodrome/internal/aixm5build"
)

// defaultOutDir is resolved relative to the working directory, expected
// to be the repo root (`go run ./cmd/ge`).
const defaultOutDir = "public/data"

const fetchTimeout = 10 * time.Minute

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	in := flag.String("in", "", "path to a local UG_AIP_DS_*.zip (skips the fetch)")
	outDir := flag.String("out", defaultOutDir, "output directory for ge-*.json and ge-*.meta.json")
	target := flag.String("target", "auto", `output slot: "current" (ge-*.json), "next" (ge-*.next.json), or "auto" (decide from the AIRAC effective date)`)
	only := flag.String("only", "", "comma-separated dataset filter; empty means all (airspaces,obstacles,airports,navaids,facilities)")
	snapshot := flag.String("snapshot", "", "write the fetched data set here (offline fixture capture)")
	var win aip.SanityWindows
	win.Register(flag.CommandLine)
	flag.Parse()

	ctx, cancel := context.WithTimeout(context.Background(), fetchTimeout)
	defer cancel()

	var (
		src  []byte
		name string
		err  error
	)
	if *in != "" {
		src, name, err = aip.ReadLargestXML(*in)
	} else {
		src, name, err = fetchDataSet(ctx, *snapshot)
	}
	if err != nil {
		return err
	}

	msg, err := aixm5.Decode(src)
	if err != nil {
		return fmt.Errorf("decode %s: %w", name, err)
	}

	// The data set filename carries the AIRAC effective date
	// (UG_AIP_DS_FULL_20260709_AIRAC.xml); the messageMetadata dateStamp
	// is the publication date, which would slot a pre-release wrongly.
	effective := effectiveFromName(name)
	if effective == "" {
		effective = msg.Effective
	}

	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		return err
	}

	want := aip.DatasetFilter(*only)
	now := time.Now

	if want("airspaces") {
		artifact, meta, err := aixm5build.BuildAirspaces(msg, name, src, effective, aixm5build.AirspacesOptions{
			Country:      "GE",
			Now:          now,
			MinAirspaces: cmp.Or(win.MinAirspaces, defaultMinGeAirspaces),
			MaxAirspaces: cmp.Or(win.MaxAirspaces, defaultMaxGeAirspaces),
		})
		if err != nil {
			return fmt.Errorf("airspaces: %w", err)
		}
		slot, err := aip.WriteDataset(*outDir, "ge-airspaces", *target, meta.Effective, artifact, meta)
		if err != nil {
			return fmt.Errorf("airspaces: %w", err)
		}
		fmt.Printf("wrote %d airspaces from %s; effective %s; slot=%s; skipped %d non-baseline; %d unresolved xlinks\n",
			meta.AirspaceCount, name, meta.Effective, slot,
			meta.SkippedNonBaseline, meta.UnresolvedXlinks)
	}

	// The AIP Data Set carries no VerticalStructure features: Georgia
	// publishes its obstacles as a separate product. Emitting an empty
	// ge-obstacles.json would put a file on the map that says "no
	// obstacles here", which is a different claim from "not published".
	if want("obstacles") && len(msg.Obstacles) > 0 {
		artifact, meta, err := aixm5build.BuildObstacles(msg, name, src, effective, aixm5build.ObstaclesOptions{
			IDPrefix:     "ge",
			Country:      "GE",
			Now:          now,
			MinObstacles: win.MinObstacles,
			MaxObstacles: cmp.Or(win.MaxObstacles, defaultMaxGeObstacles),
		})
		if err != nil {
			return fmt.Errorf("obstacles: %w", err)
		}
		slot, err := aip.WriteDataset(*outDir, "ge-obstacles", *target, meta.Effective, artifact, meta)
		if err != nil {
			return fmt.Errorf("obstacles: %w", err)
		}
		fmt.Printf("wrote %d obstacles (%d lit) from %s; effective %s; slot=%s\n",
			meta.ObstacleCount, meta.LitCount, name, meta.Effective, slot)
	}

	if want("airports") {
		artifact, meta, err := aixm5build.BuildAirports(msg, name, src, effective, aixm5build.AirportsOptions{
			Country:         "GE",
			CountryFromIcao: geCountryFromIcao,
			Now:             now,
			MinAirports:     win.MinAirports,
			MaxAirports:     cmp.Or(win.MaxAirports, defaultMaxGeAirports),
		})
		if err != nil {
			return fmt.Errorf("airports: %w", err)
		}
		slot, err := aip.WriteDataset(*outDir, "ge-airports", *target, meta.Effective, artifact, meta)
		if err != nil {
			return fmt.Errorf("airports: %w", err)
		}
		fmt.Printf("wrote %d airports (%d runways, %d military) from %s; effective %s; slot=%s\n",
			meta.AhpCount, meta.RunwayCount, meta.MilitaryCount, name, meta.Effective, slot)
	}

	if want("navaids") {
		artifact, meta, err := aixm5build.BuildNavaids(msg, name, src, effective, aixm5build.NavaidsOptions{
			IDPrefix:   "ge",
			Country:    "GE",
			Now:        now,
			MinNavaids: win.MinNavaids,
			MaxNavaids: win.MaxNavaids,
		})
		if err != nil {
			return fmt.Errorf("navaids: %w", err)
		}
		slot, err := aip.WriteDataset(*outDir, "ge-navaids", *target, meta.Effective, artifact, meta)
		if err != nil {
			return fmt.Errorf("navaids: %w", err)
		}
		fmt.Printf("wrote %d navaids from %s; effective %s; slot=%s\n",
			meta.NavaidCount, name, meta.Effective, slot)
	}

	if want("facilities") {
		artifact, meta, err := aixm5build.BuildFacilities(msg, name, src, effective, aixm5build.FacilitiesOptions{
			Country:       "GE",
			Now:           now,
			MinAerodromes: defaultMinGeAerodromes,
			MaxAerodromes: defaultMaxGeAerodromes,
		})
		if err != nil {
			return fmt.Errorf("facilities: %w", err)
		}
		slot, err := aip.WriteDataset(*outDir, "ge-aerodrome-facilities", *target, meta.Effective, artifact, meta)
		if err != nil {
			return fmt.Errorf("facilities: %w", err)
		}
		fmt.Printf("wrote %d aerodrome facilities (%d heliports, %d notes skipped) from %s; effective %s; slot=%s\n",
			meta.AerodromeCount, meta.HeliportCount, meta.SkippedNotes, name, meta.Effective, slot)
	}

	return nil
}

// dataSetDateRe matches the AIRAC effective date in the published data
// set name: UG_AIP_DS_20260709_AIRAC.zip and the
// UG_AIP_DS_FULL_20260709_AIRAC.xml it holds.
var dataSetDateRe = regexp.MustCompile(`_(\d{8})_`)

// effectiveFromName extracts the AIRAC effective date, in the ISO-8601
// form aip.ResolveTarget parses. Empty when the name does not match, in
// which case the caller falls back to the messageMetadata dateStamp.
func effectiveFromName(name string) string {
	m := dataSetDateRe.FindStringSubmatch(name)
	if len(m) != 2 {
		return ""
	}
	d := m[1]
	return d[:4] + "-" + d[4:6] + "-" + d[6:8] + "T00:00:00.000Z"
}
