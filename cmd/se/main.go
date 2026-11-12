// Command se builds the Swedish datasets from LFV's Digital AIM WFS.
//
// LFV serves AIP Sweden's spatial data as a public, AIRAC-synchronised
// GeoServer (daim.lfv.se), licensed "under Creative Commons 4.0 BY" in the
// service's own AccessConstraints, attribution LFV. One typename per kind of
// feature: the airspace volumes, the navaids and designated points, the
// aerodrome and heliport reference points, the en-route obstacles. The
// eAIP beside it (IDS AIRNAV, no copyright clause) is read for one thing
// only, the datum of the few limits the WFS carries without one (datum.go).
//
// Run directly:
//
//	go run ./cmd/se
//	go run ./cmd/se -only airspaces -out local/se
package main

import (
	"cmp"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/aixm5"
	"github.com/0intro/loxodrome/internal/aixm5build"
	"github.com/0intro/loxodrome/internal/gis"
)

const (
	wfsBase      = "https://daim.lfv.se/geoserver/wfs"
	sourceLabel  = "LFV Digital AIM WFS"
	fetchTimeout = 15 * time.Minute
)

// Sanity windows: the 2026-09-03 service carries 404 airspace rows, 1 813
// points, 184 aerodromes and heliports and 5 832 obstacles.
const (
	defaultMinAirspaces = 200
	defaultMaxAirspaces = 1500
	defaultMinNavaids   = 500
	defaultMaxNavaids   = 5000
	defaultMinAirports  = 80
	defaultMaxAirports  = 500
	defaultMinObstacles = 2000
	defaultMaxObstacles = 20000
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	outDir := flag.String("out", "public/data", "output directory")
	target := flag.String("target", "auto", `output slot: "current", "next" or "auto"`)
	only := flag.String("only", "", `comma-separated dataset filter ("airspaces", "navaids", "airports", "obstacles"); empty means all`)
	noEAIP := flag.Bool("no-eaip", false, "skip the eAIP datum cross-check (every bare limit read as ft AMSL)")
	var win aip.SanityWindows
	win.Register(flag.CommandLine)
	flag.Parse()
	want := aip.DatasetFilter(*only)

	ctx, cancel := context.WithTimeout(context.Background(), fetchTimeout)
	defer cancel()
	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		return err
	}

	if want("airspaces") {
		var hints *datumHints
		eaipDir := ""
		if !*noEAIP {
			var err error
			hints, eaipDir, err = loadDatumHints(ctx, time.Now())
			if err != nil {
				return err
			}
		}
		if err := buildAirspaces(ctx, *outDir, *target, hints, eaipDir, win); err != nil {
			return fmt.Errorf("airspaces: %w", err)
		}
	}
	if want("navaids") {
		if err := buildNavaids(ctx, *outDir, *target, win); err != nil {
			return fmt.Errorf("navaids: %w", err)
		}
	}
	if want("airports") {
		if err := buildAirports(ctx, *outDir, *target, win); err != nil {
			return fmt.Errorf("airports: %w", err)
		}
	}
	if want("obstacles") {
		if err := buildObstacles(ctx, *outDir, *target, win); err != nil {
			return fmt.Errorf("obstacles: %w", err)
		}
	}
	return nil
}

// fetchAll reads several typenames, hashing every response body.
func fetchAll(ctx context.Context, typenames []string) (map[string][]gis.Feature, []byte, error) {
	out := map[string][]gis.Feature{}
	h := sha256.New()
	for _, t := range typenames {
		feats, raw, err := gis.FetchWFS(ctx, wfsBase, "mais:"+t)
		if err != nil {
			return nil, nil, err
		}
		h.Write(raw)
		out[t] = feats
	}
	return out, h.Sum(nil), nil
}

// effectiveOf is the latest WEF the features carry: the AIRAC cycle the
// service is synchronised to.
func effectiveOf(byType map[string][]gis.Feature, key string) string {
	best := ""
	for _, feats := range byType {
		for _, f := range feats {
			if v := gis.Prop(f.Properties, key); len(v) >= 10 && v[:10] > best {
				best = v[:10]
			}
		}
	}
	if best == "" {
		return ""
	}
	return best + "T00:00:00.000Z"
}

// airspacesMeta carries the shared sidecar fields plus the counters of
// this source, so a changed typename shows up as a number, not as missing
// rows.
type airspacesMeta struct {
	aixm5build.AirspacesMeta
	// EAIP names the eAIP package the datums were cross-checked against.
	EAIP string `json:"eaip,omitempty"`
	airspaceStats
}

func buildAirspaces(ctx context.Context, outDir, target string, hints *datumHints, eaipDir string, win aip.SanityWindows) error {
	byType, sum, err := fetchAll(ctx, airspaceTypenames)
	if err != nil {
		return err
	}
	st := airspaceStats{}
	var msg aixm5.Message
	for _, t := range airspaceTypenames {
		msg.Airspaces = append(msg.Airspaces, parseAirspaces(t, byType[t], hints, &st)...)
	}
	effective := effectiveOf(byType, "WEF")
	artifact, shared, err := aixm5build.BuildAirspaces(&msg, sourceLabel, nil, effective,
		aixm5build.AirspacesOptions{
			Country:      "SE",
			Now:          time.Now,
			MinAirspaces: cmp.Or(win.MinAirspaces, defaultMinAirspaces),
			MaxAirspaces: cmp.Or(win.MaxAirspaces, defaultMaxAirspaces),
		})
	if err != nil {
		return err
	}
	shared.SourceSha256 = hex.EncodeToString(sum)
	meta := airspacesMeta{AirspacesMeta: shared, EAIP: eaipDir, airspaceStats: st}
	slot, err := aip.WriteDataset(outDir, "se-airspaces", target, effective, artifact, meta)
	if err != nil {
		return err
	}
	fmt.Printf("se: wrote %d airspaces (%s); %d limits given their datum by the eAIP; effective %s; slot=%s\n",
		shared.AirspaceCount, summary(shared.Counts), st.DatumFromEAIP, effective, slot)
	return nil
}

type navaidsMeta struct {
	aixm5build.NavaidsMeta
	navaidStats
}

func buildNavaids(ctx context.Context, outDir, target string, win aip.SanityWindows) error {
	byType, sum, err := fetchAll(ctx, navaidTypenames)
	if err != nil {
		return err
	}
	st := navaidStats{}
	var msg aixm5.Message
	for _, t := range navaidTypenames {
		msg.Navaids = append(msg.Navaids, parseNavaids(t, byType[t], &st)...)
	}
	effective := effectiveOf(byType, "WEF")
	artifact, shared, err := aixm5build.BuildNavaids(&msg, sourceLabel, nil, effective,
		aixm5build.NavaidsOptions{
			IDPrefix:   "SE",
			Country:    "SE",
			Now:        time.Now,
			MinNavaids: cmp.Or(win.MinNavaids, defaultMinNavaids),
			MaxNavaids: cmp.Or(win.MaxNavaids, defaultMaxNavaids),
		})
	if err != nil {
		return err
	}
	shared.SourceSha256 = hex.EncodeToString(sum)
	slot, err := aip.WriteDataset(outDir, "se-navaids", target, effective, artifact, navaidsMeta{shared, st})
	if err != nil {
		return err
	}
	fmt.Printf("se: wrote %d navaids and points (%s); slot=%s\n", shared.NavaidCount, summary(shared.Counts), slot)
	return nil
}

func buildAirports(ctx context.Context, outDir, target string, win aip.SanityWindows) error {
	types := []string{"ARP", "HKP_ARP"}
	byType, sum, err := fetchAll(ctx, types)
	if err != nil {
		return err
	}
	st := navaidStats{}
	var msg aixm5.Message
	for _, t := range types {
		msg.Airports = append(msg.Airports, parseAerodromes(t, byType[t], &st)...)
	}
	effective := effectiveOf(byType, "WEF")
	artifact, shared, err := aixm5build.BuildAirports(&msg, sourceLabel, nil, effective,
		aixm5build.AirportsOptions{
			Country:         "SE",
			CountryFromIcao: countryFromIcao,
			Now:             time.Now,
			MinAirports:     cmp.Or(win.MinAirports, defaultMinAirports),
			MaxAirports:     cmp.Or(win.MaxAirports, defaultMaxAirports),
		})
	if err != nil {
		return err
	}
	shared.SourceSha256 = hex.EncodeToString(sum)
	slot, err := aip.WriteDataset(outDir, "se-airports", target, effective, artifact, shared)
	if err != nil {
		return err
	}
	fmt.Printf("se: wrote %d aerodromes and heliports; slot=%s\n", shared.AhpCount, slot)
	return nil
}

// countryFromIcao maps an indicator to its ISO country. LFV's data reaches
// past Sweden where Swedish units serve (Bornholm's EKRN).
func countryFromIcao(icao string) string {
	switch {
	case strings.HasPrefix(icao, "EK"):
		return "DK"
	case strings.HasPrefix(icao, "EF"):
		return "FI"
	case strings.HasPrefix(icao, "EN"):
		return "NO"
	}
	return "SE"
}

type obstaclesMeta struct {
	aixm5build.ObstaclesMeta
	navaidStats
}

func buildObstacles(ctx context.Context, outDir, target string, win aip.SanityWindows) error {
	byType, sum, err := fetchAll(ctx, []string{"OBSE"})
	if err != nil {
		return err
	}
	st := navaidStats{}
	msg := aixm5.Message{Obstacles: parseObstacles(byType["OBSE"], &st)}
	effective := effectiveOf(byType, "CYCLE_ID")
	artifact, shared, err := aixm5build.BuildObstacles(&msg, sourceLabel, nil, effective,
		aixm5build.ObstaclesOptions{
			IDPrefix:     "se",
			Country:      "SE",
			Now:          time.Now,
			MinObstacles: cmp.Or(win.MinObstacles, defaultMinObstacles),
			MaxObstacles: cmp.Or(win.MaxObstacles, defaultMaxObstacles),
		})
	if err != nil {
		return err
	}
	shared.SourceSha256 = hex.EncodeToString(sum)
	slot, err := aip.WriteDataset(outDir, "se-obstacles", target, effective, artifact, obstaclesMeta{shared, st})
	if err != nil {
		return err
	}
	fmt.Printf("se: wrote %d obstacles (%d lit); unknown types %v; slot=%s\n",
		shared.ObstacleCount, shared.LitCount, shared.UnknownTypes, slot)
	return nil
}

func summary(counts map[string]int) string {
	parts := make([]string, 0, len(counts))
	for k, v := range counts {
		parts = append(parts, fmt.Sprintf("%s:%d", k, v))
	}
	sort.Strings(parts)
	return strings.Join(parts, " ")
}
