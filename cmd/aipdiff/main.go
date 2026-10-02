// Command aipdiff scores the generic eAIP readers against a State's own
// structured data. It reads the State's eAIP the way cmd/eaip reads the
// cohort, through internal/eaip, builds the rows with the shared AIXM
// builder, and compares them with the dataset the same State's AIXM
// builds, which is independent of the HTML: the United Kingdom's eAIP
// against the NATS AIXM (uk-airports.json), the SIA's against the AIXM 4.5
// (fr-airports.json). Nothing is written to
// public/data; the report goes to stdout, and -snapshot keeps the pages.
//
// Run: go run ./cmd/aipdiff -state uk|fr [-snapshot local/aipdiff | -replay local/aipdiff]

package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/eaip"
)

// source is one State the harness knows: where its eAIP is, which dataset
// holds its AIXM truth, and how many pages it may be asked for at once.
type source struct {
	site    eaip.Site
	truth   string
	workers int
}

var sources = map[string]source{
	"uk": {
		site: eaip.Site{
			Country:   "EG",
			Family:    eaip.Eurocontrol,
			Base:      "https://www.aurora.nats.co.uk/htmlAIP/Publications",
			Templates: []string{"{ISO}-AIRAC"},
			Lang:      "en-GB",
			// The NATS site turns away clients that do not look like a
			// browser (cmd/ukcharts).
			Header: eaip.BrowserHeaders,
		},
		truth: "public/data/uk-airports.json",
	},
	// France: the SIA's eAIP, whose pages are bilingual under one
	// -fr-FR name, against the AIXM 4.5 cmd/fr builds fr-airports.json
	// from. One page at a time, as cmd/adcharts reads the same site.
	"fr": {
		site: eaip.Site{
			Country:   "FR",
			Family:    eaip.Eurocontrol,
			Base:      aip.SIAHost + "/media/dvd",
			Templates: []string{"eAIP_{DD}_{MON}_{YYYY}/FRANCE/AIRAC-{ISO}"},
			Lang:      "fr-FR",
		},
		truth:   "public/data/fr-airports.json",
		workers: 1,
	},
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	state := flag.String("state", "uk", "the State to score (uk, fr)")
	snapshot := flag.String("snapshot", "", "also write every fetched page under this directory")
	replay := flag.String("replay", "", "read every page from a -snapshot directory instead of the network")
	flag.Parse()
	src, ok := sources[*state]
	if !ok {
		return fmt.Errorf("unknown state %q", *state)
	}
	site := src.site
	if *snapshot != "" {
		site.Snapshot = filepath.Join(*snapshot, *state)
	}
	if *replay != "" {
		site.Replay = filepath.Join(*replay, *state)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	cyc, err := site.Resolve(ctx, "ENR 2.1", time.Now(), false)
	if err != nil {
		return err
	}
	workers := src.workers
	if workers == 0 {
		workers = 4
	}
	read, err := readAirports(ctx, &site, cyc, workers)
	if err != nil {
		return err
	}
	truth, err := loadRows(src.truth)
	if err != nil {
		return err
	}
	report(os.Stdout, *state, cyc, read, truth)
	return nil
}
