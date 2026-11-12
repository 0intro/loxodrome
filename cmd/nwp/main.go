// Command nwp ingests the open numerical weather prediction feeds Loxodrome
// serves its forecasts from (Météo-France AROME, AROME-OM and ARPEGE, ECMWF
// IFS) into the chunked archives the loxodrome-nwp Worker reads
// (docs/nwp-service.md).
//
//	nwp ingest -model arome0025 -run 2026-10-06T00 -blocks 0 -out dir|r2
//	nwp inspect [-lat 48.85 -lon 2.35 -vars elevation,wind_u@850] archive.pmtiles...
//	nwp compare -model arome0025 -archive dir
//	nwp list file.grib2...
package main

import (
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/0intro/loxodrome/internal/nwp"
)

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	cmds := map[string]func([]string) error{
		"list":    cmdList,
		"ingest":  cmdIngest,
		"inspect": cmdInspect,
		"compare": cmdCompare,
	}
	run, ok := cmds[os.Args[1]]
	if !ok {
		usage()
	}
	if err := run(os.Args[2:]); err != nil {
		fmt.Fprintln(os.Stderr, "nwp:", err)
		os.Exit(exitStatus(err))
	}
}

// exitStatus is the command's status for an error: a job stopped on
// request exits exitStopped (ingest.go), which the orchestrator charges
// nothing for; one past its deadline exitDeadline (which it ends with
// itself, from its timer); anything else 1.
func exitStatus(err error) int {
	var se *stopError
	if errors.As(err, &se) {
		return exitStopped
	}
	var de *deadlineError
	if errors.As(err, &de) {
		return exitDeadline
	}
	return 1
}

// modelIDs lists the ingested models for a flag's help.
func modelIDs() string {
	var ids []string
	for _, m := range nwp.Models {
		ids = append(ids, m.ID)
	}
	return strings.Join(ids, ", ")
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: nwp ingest|inspect|compare|list ...")
	os.Exit(2)
}
