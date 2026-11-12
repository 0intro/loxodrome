// Command ro reads AIP Romania, which ROMATSA publishes as PDF files in an
// open directory per AIRAC edition (www.aisro.ro/aip/<ISO>/DOCS/...), and
// emits ro-adcharts.json, the charts of every aerodrome and heliport,
// linked where ROMATSA serves them (adcharts.go); ro-obstacles.json, from
// the Area 1 obstacle data set ROMATSA publishes as a CSV beside the AIP
// (obstacles.go); ro-airspaces.json, the airspace of ENR 2.1, 5.1 and 5.2,
// their PDF tables rebuilt for the eAIP readers (airspaces.go), and of
// each aerodrome's AD 2.17; ro-navaids.json, ENR 4.1's navaids and ENR
// 4.4's points (navaids.go); and ro-airports.json and
// ro-aerodrome-facilities.json, the aerodromes and heliports of AD 2 and
// AD 3 (airports.go). The aerodrome pages are read once for the three
// datasets that need them, so a pass that fails fails all three: the
// airspace is not written without its control zones.
//
// Run directly:
//
//	go run ./cmd/ro [-target next]
//	go run ./cmd/ro -only obstacles -keep local/ro-obstacles
//	go run ./cmd/ro -only obstacles -in local/ro-obstacles/Obstacle_Data_LRBB_Area_1_16_APR_2026.csv
//	go run ./cmd/ro -only airspaces,airports,facilities -keep local/ro-enr
//	go run ./cmd/ro -only airspaces,navaids,airports,facilities -enr local/ro-enr/2026-09-03

package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/eaip"
)

// defaultOutDir is resolved relative to the working directory, expected
// to be the repo root (`go run ./cmd/ro`).
const defaultOutDir = "public/data"

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	outDir := flag.String("out", defaultOutDir, "output directory for ro-*.json and ro-*.meta.json")
	target := flag.String("target", "current", `edition read: "current" (the one in force) or "next" (the soonest after it)`)
	only := flag.String("only", "", "comma-separated dataset filter; empty means all (adcharts, obstacles, airspaces, navaids, airports, facilities)")
	in := flag.String("in", "", "a local Obstacle_Data_*.csv, its .crc32q beside it (obstacles only; skips the fetch)")
	enr := flag.String("enr", "", "a -keep directory of one edition's PDFs, named by its effective day, the aerodromes' under AD/ (airspaces, navaids, airports, facilities; skips the fetch)")
	keep := flag.String("keep", "", "write the downloaded obstacle data set and its .crc32q, and the ENR and aerodrome PDFs under <dir>/<edition>, into this directory (replay with -in, -enr)")
	firs := flag.String("firs", "public/data/pruatlas-firs.json", "pruatlas FIR dataset: the Bucharest FIR ring zones are cut back to")
	var win aip.SanityWindows
	win.Register(flag.CommandLine)
	flag.Parse()
	if *target != "current" && *target != "next" {
		return fmt.Errorf("-target %q: current or next", *target)
	}
	want := aip.DatasetFilter(*only)
	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		return err
	}
	if want("adcharts") && *in == "" {
		if err := buildRoAdCharts(*outDir, *target, time.Now); err != nil {
			return fmt.Errorf("adcharts: %w", err)
		}
	}
	if want("obstacles") {
		if err := buildRoObstacles(*outDir, *target, *in, *keep, win, time.Now); err != nil {
			return fmt.Errorf("obstacles: %w", err)
		}
	}
	if *in != "" || !(want("airspaces") || want("navaids") || want("airports") || want("facilities")) {
		return nil
	}
	// The PDF datasets read one edition, opened once, and the aerodrome
	// pages once for the three that need them.
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	edition, err := openRoENR(ctx, *target, *enr, *keep, time.Now)
	if err != nil || edition == nil {
		return err
	}
	var pass *roADPass
	var spec eaip.ZoneSpec
	if want("airspaces") || want("airports") || want("facilities") {
		if spec, err = roZoneSpec(*firs); err != nil {
			return err
		}
		if pass, err = readRoAerodromes(ctx, edition, spec); err != nil {
			return fmt.Errorf("aerodromes: %w", err)
		}
	}
	if want("airspaces") {
		if err := buildRoAirspaces(*outDir, *target, edition, pass, spec, win, time.Now); err != nil {
			return fmt.Errorf("airspaces: %w", err)
		}
	}
	if want("navaids") {
		if err := buildRoNavaids(*outDir, *target, edition, win, time.Now); err != nil {
			return fmt.Errorf("navaids: %w", err)
		}
	}
	if want("airports") {
		if err := writeRoAirports(*outDir, *target, edition, pass, win, time.Now); err != nil {
			return fmt.Errorf("airports: %w", err)
		}
	}
	if want("facilities") {
		if err := writeRoFacilities(*outDir, *target, edition, pass, time.Now); err != nil {
			return fmt.Errorf("facilities: %w", err)
		}
	}
	return nil
}
