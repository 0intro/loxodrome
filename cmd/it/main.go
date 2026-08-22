// Command it reads the Italian OFMX snapshot published by open
// flightmaps and emits it-airspaces.json, it-airports.json,
// it-navaids.json and it-nature.json.
//
// Italy has no free OFFICIAL data. ENAV moved the eAIP behind a free
// account in July 2023 and its AIXM 5.1.1 is a paid SWIM service, so
// this is the one dataset in the repo that is NOT a State AIS product.
// It is community-maintained by the open flightmaps association, and the
// app labels it that way wherever it appears.
//
// Licence: the OFMA General Users' License, which grants a worldwide,
// royalty-free, non-exclusive right to use the database, commercial use
// included, on two conditions this repo has to honour:
//
//   - the open flightmaps database is attributed as the source (the
//     About dialog's card and the Layers row both name it);
//   - an application gives its end users a way to report errors and
//     submit corrections back to OFMA (the About card carries the link).
//
// A dated copy of the licence text is kept beside this command, because
// OFMA publishes it only through in-page modals and it has no stable URL.
//
// Run directly:
//
//	go run ./cmd/it
//	go run ./cmd/it -in local/ofmx_li.zip
package main

import (
	"cmp"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/aixm5"
	"github.com/0intro/loxodrome/internal/aixm5build"
	"github.com/0intro/loxodrome/internal/overlay"
)

const (
	defaultOutDir = "public/data"
	// region is open flightmaps' code for the Italian snapshot.
	region       = "li"
	fetchTimeout = 15 * time.Minute

	defaultMinItAirspaces = 500
	defaultMaxItAirspaces = 5000
	defaultMinItAirports  = 100
	defaultMaxItAirports  = 2000
	defaultMinItNavaids   = 200
	defaultMaxItNavaids   = 5000
	defaultMinItNature    = 50
	defaultMaxItNature    = 2000
)

// itCountryFromIcao maps the Italian ICAO prefix to ISO-3166.
var itCountryFromIcao = aixm5build.IcaoCountry(map[string]string{
	"LI": "IT",
}, "IT")

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	in := flag.String("in", "", "path to a local ofmx_li.zip (skips the fetch)")
	outDir := flag.String("out", defaultOutDir, "output directory for it-*.json and it-*.meta.json")
	target := flag.String("target", "auto", `output slot: "current" (it-*.json), "next" (it-*.next.json), or "auto"`)
	only := flag.String("only", "", "comma-separated dataset filter; empty means all (airspaces,airports,navaids,nature)")
	cycle := flag.String("cycle", "", "AIRAC snapshot to fetch (YYNN); empty picks the current cycle")
	keep := flag.String("keep", "", "write the downloaded archive here (offline replay with -in)")
	var win aip.SanityWindows
	win.Register(flag.CommandLine)
	flag.Parse()

	ctx, cancel := context.WithTimeout(context.Background(), fetchTimeout)
	defer cancel()

	path := *in
	if path == "" {
		p, cleanup, err := download(ctx, *cycle, *keep)
		if err != nil {
			return err
		}
		defer cleanup()
		path = p
	}

	rc, name, err := openSnapshot(path)
	if err != nil {
		return err
	}
	defer func() {
		_ = rc.Close()
	}()

	h := sha256.New()
	snap, err := DecodeOFMX(io.TeeReader(rc, h))
	if err != nil {
		return fmt.Errorf("decode %s: %w", name, err)
	}
	sum := hex.EncodeToString(h.Sum(nil))
	effective := effectiveOf(snap.Effective)
	source := "open flightmaps OFMX " + strings.ToUpper(region)

	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		return err
	}
	want := aip.DatasetFilter(*only)
	now := time.Now
	var stats buildStats

	rows, nature := airspaceRows(snap, &stats)

	if want("airspaces") {
		art, counts := overlay.RowsToArtifact(rows)
		minA := cmp.Or(win.MinAirspaces, defaultMinItAirspaces)
		maxA := cmp.Or(win.MaxAirspaces, defaultMaxItAirspaces)
		if n := len(art.Rows); n < minA || n > maxA {
			return fmt.Errorf("IT airspace count %d outside sanity window [%d, %d] - source format may have changed",
				n, minA, maxA)
		}
		meta := itAirspacesMeta{
			GeneratedAt:    now().UTC().Format("2006-01-02T15:04:05.000Z"),
			Source:         source,
			SourceSha256:   sum,
			Effective:      effective,
			AirspaceCount:  len(art.Rows),
			SkippedType:    stats.skippedType,
			SkippedNoGeo:   stats.skippedNoGeo,
			NatureRows:     stats.natureRows,
			BorderStitched: stats.borderStitched,
			BorderChords:   stats.borderChords,
			ArcChords:      stats.arcChords,
			Counts:         counts,
			BBox:           aip.BBoxOfRows(art.Fields, art.Rows),
			BBoxes:         aip.BBoxClustersOfRows(art.Fields, art.Rows),
		}
		slot, err := aip.WriteDataset(*outDir, "it-airspaces", *target, meta.Effective, art, meta)
		if err != nil {
			return fmt.Errorf("airspaces: %w", err)
		}
		fmt.Printf("wrote %d airspaces from %s; effective %s; slot=%s; %d border runs stitched / %d chords; %d nature zones split off\n",
			meta.AirspaceCount, name, meta.Effective, slot,
			stats.borderStitched, stats.borderChords, stats.natureRows)
	}

	if want("nature") {
		art, meta, err := buildNature(nature, source, sum, effective, now,
			cmp.Or(win.MinAirspaces, defaultMinItNature), defaultMaxItNature)
		if err != nil {
			return fmt.Errorf("nature: %w", err)
		}
		slot, err := aip.WriteDataset(*outDir, "it-nature", *target, meta.Effective, art, meta)
		if err != nil {
			return fmt.Errorf("nature: %w", err)
		}
		fmt.Printf("wrote %d nature zones; effective %s; slot=%s\n", meta.ZoneCount, meta.Effective, slot)
	}

	if want("airports") {
		msg := aixm5.Message{Airports: airportValues(snap)}
		art, meta, err := aixm5build.BuildAirports(&msg, source, nil, effective, aixm5build.AirportsOptions{
			Country:         "IT",
			CountryFromIcao: itCountryFromIcao,
			Now:             now,
			MinAirports:     cmp.Or(win.MinAirports, defaultMinItAirports),
			MaxAirports:     cmp.Or(win.MaxAirports, defaultMaxItAirports),
		})
		if err != nil {
			return fmt.Errorf("airports: %w", err)
		}
		meta.SourceSha256 = sum
		slot, err := aip.WriteDataset(*outDir, "it-airports", *target, meta.Effective, art, meta)
		if err != nil {
			return fmt.Errorf("airports: %w", err)
		}
		fmt.Printf("wrote %d airports (%d runways); effective %s; slot=%s\n",
			meta.AhpCount, meta.RunwayCount, meta.Effective, slot)
	}

	if want("navaids") {
		msg := aixm5.Message{Navaids: navaidValues(snap)}
		art, meta, err := aixm5build.BuildNavaids(&msg, source, nil, effective, aixm5build.NavaidsOptions{
			IDPrefix:   "it",
			Country:    "IT",
			Now:        now,
			MinNavaids: cmp.Or(win.MinNavaids, defaultMinItNavaids),
			MaxNavaids: cmp.Or(win.MaxNavaids, defaultMaxItNavaids),
		})
		if err != nil {
			return fmt.Errorf("navaids: %w", err)
		}
		meta.SourceSha256 = sum
		slot, err := aip.WriteDataset(*outDir, "it-navaids", *target, meta.Effective, art, meta)
		if err != nil {
			return fmt.Errorf("navaids: %w", err)
		}
		fmt.Printf("wrote %d navaids and points; effective %s; slot=%s\n",
			meta.NavaidCount, meta.Effective, slot)
	}
	return nil
}

// itAirspacesMeta is the it-airspaces.meta.json document. It carries the
// geometry counters beside the shared fields, so a border that stopped
// stitching shows up as a number.
type itAirspacesMeta struct {
	GeneratedAt   string `json:"generatedAt"`
	Source        string `json:"source"`
	SourceSha256  string `json:"sourceSha256"`
	Effective     string `json:"effective"`
	AirspaceCount int    `json:"airspaceCount"`
	SkippedType   int    `json:"skippedType"`
	SkippedNoGeo  int    `json:"skippedNoGeo"`
	// NatureRows counts the volumes moved to it-nature.json: every NRA,
	// and the codeType P sites that carry no prohibited-area designator.
	NatureRows     int            `json:"natureRows"`
	BorderStitched int            `json:"borderStitched"`
	BorderChords   int            `json:"borderChords"`
	ArcChords      int            `json:"arcChords"`
	Counts         map[string]int `json:"counts"`
	BBox           aip.BBox       `json:"bbox,omitempty"`
	// BBoxes splits that envelope into the pieces the rows really
	// occupy, for a publisher whose territory is not connected;
	// absent when the rows form one group.
	BBoxes []aip.BBox `json:"bboxes,omitempty"`
}

// effectiveOf normalises the snapshot's own effective stamp into the
// ISO-8601 form aip.ResolveTarget parses.
func effectiveOf(s string) string {
	s = strings.TrimSpace(s)
	if len(s) < 10 {
		return ""
	}
	return s[:10] + "T00:00:00.000Z"
}
