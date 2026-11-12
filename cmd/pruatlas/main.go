// Command pruatlas builds the worldwide FIR/UIR overlay artefact pair,
// public/data/pruatlas-firs.json and pruatlas-firs.meta.json, from the
// EUROCONTROL pruatlas GeoJSON (https://github.com/euctrl-pru/pruatlas).
//
// Run directly:
//
//	go run ./cmd/pruatlas
//
// Offline / test:
//
//	go run ./cmd/pruatlas \
//	    -pru-file ./cmd/pruatlas/testdata/pruatlas-sample.geojson
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/0intro/loxodrome/internal/overlay"
)

const (
	// Resolved relative to the working directory, which is expected to be
	// the repo root (`go run ./cmd/pruatlas`). Workflows invoke it that
	// way; local users can override with -out.
	defaultOutDir = "public/data"
	defaultPruURL = "https://raw.githubusercontent.com/euctrl-pru/pruatlas/master/inst/extdata/ir-524.geojson"
	// pruatlas is a single static GeoJSON off GitHub Pages; a tight budget
	// is fine, but we keep one minute of headroom for slow networks.
	fetchTimeout = 1 * time.Minute
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	out := flag.String("out", defaultOutDir, "output directory for pruatlas-firs.json and pruatlas-firs.meta.json")
	pruURL := flag.String("pru", defaultPruURL, "pruatlas FIR GeoJSON URL")
	pruFile := flag.String("pru-file", "", "use local pruatlas geojson instead of fetching")
	flag.Parse()

	ctx, cancel := context.WithTimeout(context.Background(), fetchTimeout)
	defer cancel()

	// If the user didn't override -pru and we're not loading a local file,
	// ask GitHub for the newest ir-NNN.geojson; pruatlas drops a fresh
	// file roughly per AIRAC and our pinned URL would otherwise serve
	// stale data forever. The pinned default stays as the safety net on
	// any discovery error.
	if *pruFile == "" && *pruURL == defaultPruURL {
		if u, cycle, err := discoverLatestPruURL(ctx); err == nil {
			fmt.Fprintf(os.Stderr, "pruatlas: discovered AIRAC %d at %s\n", cycle, u)
			*pruURL = u
		} else {
			fmt.Fprintf(os.Stderr, "pruatlas: discovery failed (using %s): %v\n", defaultPruURL, err)
		}
	}

	data, err := loadOrFetch(ctx, *pruFile, *pruURL)
	if err != nil {
		return fmt.Errorf("pruatlas: %w", err)
	}
	art, meta, err := Build(data, Options{URL: *pruURL, Now: time.Now})
	if err != nil {
		return err
	}
	if err := os.MkdirAll(*out, 0o755); err != nil {
		return err
	}
	if err := overlay.WriteCompactJSON(filepath.Join(*out, "pruatlas-firs.json"), art); err != nil {
		return err
	}
	if err := overlay.WritePrettyJSON(filepath.Join(*out, "pruatlas-firs.meta.json"), meta); err != nil {
		return err
	}
	suffix := ""
	if meta.Source.Cycle != 0 {
		suffix = fmt.Sprintf(" (ir-%d)", meta.Source.Cycle)
	}
	fmt.Printf("wrote pruatlas-firs.json: %d FIRs%s\n", meta.AirspaceCount, suffix)
	return nil
}

func loadOrFetch(ctx context.Context, file, url string) ([]byte, error) {
	if file != "" {
		return os.ReadFile(file)
	}
	return fetchPruatlas(ctx, url)
}
