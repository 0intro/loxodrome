// Command dk reads Naviair's AIM document tree (aim.naviair.dk), where
// the AIP of Denmark, its VFR Flight Guide and the AIPs of the Faroe
// Islands and Greenland are published as PDF files behind an anonymous
// JSON API, and emits dk-adcharts.json: the charts of every aerodrome and
// heliport they publish, linked where Naviair serves them (adcharts.go).
// The rest is PDF text, and Denmark's terms hold it (docs/dk-aip.md): the
// airspace of ENR 2 and 5 builds only when asked for, into a local
// directory (airspaces.go), never into public/data.
//
// Run directly:
//
//	go run ./cmd/dk -only adcharts
//	go run ./cmd/dk -only airspaces -out local/dk -keep local/dk-enr
//	go run ./cmd/dk -only airspaces -out local/dk -enr local/dk-enr/2026-09-03

package main

import (
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
)

// defaultOutDir is resolved relative to the working directory, expected
// to be the repo root (`go run ./cmd/dk`).
const defaultOutDir = "public/data"

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	outDir := flag.String("out", defaultOutDir, "output directory for dk-*.json and dk-*.meta.json")
	only := flag.String("only", "", "comma-separated dataset filter; empty means adcharts (airspaces, HELD, only when named)")
	enr := flag.String("enr", "", "a -keep directory of one edition's ENR PDFs, named by its effective day (airspaces; skips the fetch)")
	keep := flag.String("keep", "", "write the downloaded ENR PDFs under <dir>/<edition> (replay with -enr)")
	firs := flag.String("firs", "public/data/pruatlas-firs.json", "pruatlas FIR dataset: the København FIR ring a limit may follow")
	flag.Parse()
	want := aip.DatasetFilter(*only)
	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		return err
	}
	if want("adcharts") && *enr == "" {
		if err := buildDkAdCharts(*outDir, time.Now); err != nil {
			return fmt.Errorf("adcharts: %w", err)
		}
	}
	// The airspace is held: built only when asked for by name.
	if strings.Contains(*only, "airspaces") {
		if err := buildDkAirspaces(*outDir, *enr, *keep, *firs, time.Now); err != nil {
			return fmt.Errorf("airspaces: %w", err)
		}
	}
	return nil
}
