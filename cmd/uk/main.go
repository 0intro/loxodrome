// Command uk reads a UK NATS AIXM 5.1 ICAO AIP Dataset (and / or the
// companion Obstacle Dataset Area 1) and emits the per-dataset JSON
// artefacts the SPA consumes: uk-airspaces.json and uk-obstacles.json.
// Schema mirrors cmd/fr (the SPA loader treats per-country files
// uniformly).
//
// Phase 2 scope: -in points to a local .zip or .xml. Auto-discovery
// against the NATS digital datasets index, with optional bearer token,
// arrives once anonymous access is confirmed.
//
// Run directly: go run ./cmd/uk -in local/EG_AIP_DS_*.zip

package main

import (
	"cmp"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/aixm5"
	"github.com/0intro/loxodrome/internal/aixm5build"
)

// defaultOutDir is resolved relative to the working directory,
// expected to be the repo root (`go run ./cmd/uk`).
const defaultOutDir = "public/data"

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	in := flag.String("in", "", "path to a UK NATS AIXM 5.1 .zip or .xml file")
	outDir := flag.String("out", defaultOutDir, "output directory for uk-*.json and uk-*.meta.json")
	target := flag.String("target", "auto", `output slot: "current" (uk-*.json), "next" (uk-*.next.json), or "auto" (decide from the AIXM effective date)`)
	only := flag.String("only", "", "comma-separated dataset filter; empty means all (airspaces,obstacles,airports,navaids,facilities)")
	var win aip.SanityWindows
	win.Register(flag.CommandLine)
	flag.Parse()

	if *in == "" {
		return fmt.Errorf("-in is required (path to a .zip or .xml file)")
	}

	src, name, err := aip.ReadLargestXML(*in)
	if err != nil {
		return err
	}
	msg, err := aixm5.Decode(src)
	if err != nil {
		return fmt.Errorf("decode %s: %w", name, err)
	}

	// Effective date: prefer the filename's YYYYMMDD when present (NATS
	// convention; matches the AIRAC effective day). Fall back to the
	// dateStamp the publisher embedded in messageMetadata.
	effective := effectiveFromName(*in)
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
			Country:      "UK",
			Now:          now,
			MinAirspaces: win.MinAirspaces,
			MaxAirspaces: win.MaxAirspaces,
		})
		if err != nil {
			return fmt.Errorf("airspaces: %w", err)
		}
		slot, err := aip.WriteDataset(*outDir, "uk-airspaces", *target, meta.Effective, artifact, meta)
		if err != nil {
			return fmt.Errorf("airspaces: %w", err)
		}
		fmt.Printf("wrote %d airspaces from %s; effective %s; slot=%s; skipped %d non-baseline; %d unresolved xlinks\n",
			meta.AirspaceCount, name, meta.Effective, slot,
			meta.SkippedNonBaseline, meta.UnresolvedXlinks)
	}

	if want("obstacles") {
		artifact, meta, err := aixm5build.BuildObstacles(msg, name, src, effective, aixm5build.ObstaclesOptions{
			IDPrefix:     "uk",
			Country:      "UK",
			Now:          now,
			MinObstacles: win.MinObstacles,
			MaxObstacles: cmp.Or(win.MaxObstacles, defaultMaxUkObstacles),
		})
		if err != nil {
			return fmt.Errorf("obstacles: %w", err)
		}
		slot, err := aip.WriteDataset(*outDir, "uk-obstacles", *target, meta.Effective, artifact, meta)
		if err != nil {
			return fmt.Errorf("obstacles: %w", err)
		}
		fmt.Printf("wrote %d obstacles (%d lit) from %s; effective %s; slot=%s\n",
			meta.ObstacleCount, meta.LitCount, name, meta.Effective, slot)
	}

	if want("airports") {
		artifact, meta, err := aixm5build.BuildAirports(msg, name, src, effective, aixm5build.AirportsOptions{
			Country:         "UK",
			CountryFromIcao: ukCountryFromIcao,
			Now:             now,
			MinAirports:     win.MinAirports,
			MaxAirports:     cmp.Or(win.MaxAirports, defaultMaxUkAirports),
		})
		if err != nil {
			return fmt.Errorf("airports: %w", err)
		}
		slot, err := aip.WriteDataset(*outDir, "uk-airports", *target, meta.Effective, artifact, meta)
		if err != nil {
			return fmt.Errorf("airports: %w", err)
		}
		fmt.Printf("wrote %d airports (%d runways, %d military) from %s; effective %s; slot=%s\n",
			meta.AhpCount, meta.RunwayCount, meta.MilitaryCount, name, meta.Effective, slot)
	}

	if want("navaids") {
		artifact, meta, err := aixm5build.BuildNavaids(msg, name, src, effective, aixm5build.NavaidsOptions{
			IDPrefix:   "uk",
			Country:    "UK",
			Now:        now,
			MinNavaids: win.MinNavaids,
			MaxNavaids: win.MaxNavaids,
		})
		if err != nil {
			return fmt.Errorf("navaids: %w", err)
		}
		slot, err := aip.WriteDataset(*outDir, "uk-navaids", *target, meta.Effective, artifact, meta)
		if err != nil {
			return fmt.Errorf("navaids: %w", err)
		}
		fmt.Printf("wrote %d navaids from %s; effective %s; slot=%s\n",
			meta.NavaidCount, name, meta.Effective, slot)
	}

	if want("facilities") {
		artifact, meta, err := aixm5build.BuildFacilities(msg, name, src, effective, aixm5build.FacilitiesOptions{
			Country:       "UK",
			Now:           now,
			MinAerodromes: 60,
			MaxAerodromes: 400,
		})
		if err != nil {
			return fmt.Errorf("facilities: %w", err)
		}
		slot, err := aip.WriteDataset(*outDir, "uk-aerodrome-facilities", *target, meta.Effective, artifact, meta)
		if err != nil {
			return fmt.Errorf("facilities: %w", err)
		}
		fmt.Printf("wrote %d aerodrome facilities (%d heliports, %d notes skipped) from %s; effective %s; slot=%s\n",
			meta.AerodromeCount, meta.HeliportCount, meta.SkippedNotes, name, meta.Effective, slot)
	}

	return nil
}

// natsDateRe matches the YYYYMMDD effective date embedded in NATS
// filenames (EG_AIP_DS_20260514_XML.zip, EG_OBS_DS_AREA1_FULL_20260514_XML.zip).
var natsDateRe = regexp.MustCompile(`_(\d{8})_`)

// effectiveFromName extracts an AIRAC effective date from a NATS
// filename. Returns the ISO-8601 form (YYYY-MM-DDT00:00:00Z) so
// aip.ResolveTarget can parse it. Empty when the name doesn't
// match the NATS pattern (e.g. the operator renamed the file or it
// came from a different publisher).
func effectiveFromName(path string) string {
	m := natsDateRe.FindStringSubmatch(filepath.Base(path))
	if len(m) != 2 {
		return ""
	}
	d := m[1]
	return d[:4] + "-" + d[4:6] + "-" + d[6:8] + "T00:00:00.000Z"
}
