// Command mk reads the AIP of North Macedonia, which M-NAV publishes as a
// PDF file per section in a framed package (ais.m-nav.info/eAIP/current),
// and builds mk-airspaces.json from ENR 2.1, 2.2, 5.1, 5.2, 5.3 and 5.5
// (airspaces.go). M-NAV's GEN 0.1.5 forbids reproduction or storage in
// databases without its written permission, so the build is HELD: it
// refuses public/data, and its output stays local until the permission
// docs/aip-permissions.md asks for is given.
//
// Run directly:
//
//	go run ./cmd/mk -out local/mk -keep local/mk-enr
//	go run ./cmd/mk -out local/mk -enr local/mk-enr/current
package main

import (
	"flag"
	"fmt"
	"os"
	"time"
)

// defaultOutDir is where the build must never write.
const defaultOutDir = "public/data"

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	outDir := flag.String("out", defaultOutDir, "output directory for mk-airspaces.json: a local one, the build being held")
	enr := flag.String("enr", "", "a -keep directory of the ENR PDFs (skips the fetch)")
	keep := flag.String("keep", "", "write the downloaded ENR PDFs under <dir>/current (replay with -enr)")
	firs := flag.String("firs", "public/data/pruatlas-firs.json", "pruatlas FIR dataset: the Skopje FIR ring a limit may follow")
	flag.Parse()
	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		return err
	}
	return buildMkAirspaces(*outDir, *enr, *keep, *firs, time.Now)
}
