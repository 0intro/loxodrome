// Command fi reads the Finnish Area 1 obstacle data set and emits
// fi-obstacles.json.
//
// Obstacles only, and deliberately so. Finland's airspace is not
// available as AIXM or as a generated eAIP package: Fintraffic ANS
// publishes the AIP as PDF sections, which this repo does not parse
// (docs/aip-sources.md). What IS published in a machine-readable form,
// free of charge and on the AIRAC grid, is the obstacle register.
//
// That is worth having on its own. Area 1 is the whole territory at or
// above 100 m AGL: about 2700 obstacles, four in five of them wind
// turbines, in a country whose VFR traffic flies low over forest with
// very little else to navigate by.
//
// Licence: Fintraffic ANS holds the copyright and grants the data "for
// further refining and research without a separate fee or agreement",
// reserving only the resale of its products "as such". Refining the
// register into this repo's own schema is the permitted act, and nothing
// here is resold (docs/fi-aip.md).
//
// Unlike the other publishers, BOTH AIRAC slots come free: the index
// carries the current cycle's file and the next one side by side, so
// -target picks which release to fetch as well as which slot to write.
//
// Run directly:
//
//	go run ./cmd/fi
//	go run ./cmd/fi -target next
//	go run ./cmd/fi -in local/ef_efin_area1_obstdata_06_aug_2026.zip
package main

import (
	"cmp"
	"context"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/aixm5"
	"github.com/0intro/loxodrome/internal/aixm5build"
)

const (
	// defaultOutDir is resolved relative to the working directory,
	// expected to be the repo root (`go run ./cmd/fi`).
	defaultOutDir = "public/data"

	// The register is filtered to 100 m AGL, which is what keeps it in
	// the low thousands; the window is wide enough for real growth and
	// tight enough to catch a truncated download.
	defaultMinFiObstacles = 1500
	defaultMaxFiObstacles = 10000

	fetchTimeout = 10 * time.Minute
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	in := flag.String("in", "", "path to a local ef_efin_area1_obstdata_*.zip or .csv (skips the fetch)")
	outDir := flag.String("out", defaultOutDir, "output directory for fi-obstacles.json and fi-obstacles.meta.json")
	target := flag.String("target", "auto", `release and output slot: "current" (fi-obstacles.json), "next" (fi-obstacles.next.json), or "auto"`)
	only := flag.String("only", "", "comma-separated dataset filter; empty means all (obstacles)")
	keep := flag.String("keep", "", "write the downloaded archive here (offline replay with -in)")
	var win aip.SanityWindows
	win.Register(flag.CommandLine)
	flag.Parse()

	want := aip.DatasetFilter(*only)
	if !want("obstacles") {
		return nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), fetchTimeout)
	defer cancel()

	var (
		archive   []byte
		name      string
		effective string
	)
	if *in != "" {
		b, err := os.ReadFile(*in)
		if err != nil {
			return err
		}
		archive, name = b, filepath.Base(*in)
		effective = effectiveFromName(name)
		if effective == "" {
			return fmt.Errorf("%s: no dd_mmm_yyyy effective date in the name", name)
		}
	} else {
		rel, err := resolveRelease(ctx, *target, time.Now())
		if err != nil {
			return err
		}
		if rel == nil {
			// A pre-release the publisher has not posted yet is normal, not
			// a failure: the current slot stays on the cycle in force.
			fmt.Println("no pre-release published; nothing to do")
			return nil
		}
		b, err := download(ctx, rel.URL, *keep)
		if err != nil {
			return err
		}
		archive, name, effective = b, rel.Name, rel.Effective
	}

	data, csvName, err := readCSV(archive, name)
	if err != nil {
		return err
	}

	obstacles, st, err := parseObstacles(data)
	if err != nil {
		return fmt.Errorf("%s: %w", csvName, err)
	}

	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		return err
	}

	msg := &aixm5.Message{Obstacles: obstacles}
	artifact, meta, err := aixm5build.BuildObstacles(msg, csvName, data, effective,
		aixm5build.ObstaclesOptions{
			IDPrefix:     "fi",
			Country:      "FI",
			Now:          time.Now,
			MinObstacles: cmp.Or(win.MinObstacles, defaultMinFiObstacles),
			MaxObstacles: cmp.Or(win.MaxObstacles, defaultMaxFiObstacles),
		})
	if err != nil {
		return err
	}

	slot, err := aip.WriteDataset(*outDir, "fi-obstacles", *target, meta.Effective, artifact, meta)
	if err != nil {
		return err
	}
	fmt.Printf("wrote %d obstacles (%d lit) from %s; effective %s; slot=%s\n",
		meta.ObstacleCount, meta.LitCount, csvName, meta.Effective, slot)
	if st.SkippedNoPosition > 0 {
		fmt.Printf("skipped %d rows with an unreadable position\n", st.SkippedNoPosition)
	}
	if len(meta.UnknownTypes) > 0 {
		fmt.Printf("unmapped obstacle types: %v\n", meta.UnknownTypes)
	}
	return nil
}
