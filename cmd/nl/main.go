// Command nl reads the LVNL (Air Traffic Control the Netherlands) ArcGIS
// FeatureServers and emits the per-dataset JSON artefacts the SPA
// consumes: nl-airspaces.json, nl-airports.json and nl-navaids.json.
//
// LVNL publishes the Dutch AIP's spatial data openly under CC BY 4.0,
// with no registration: 21 airspace layers carrying ICAO class and
// vertical limits, the aerodromes split by civil / military / joint, the
// navaids one kind per layer, and the waypoints. It is the only new
// European source in docs/aip-sources.md that clears every bar at once.
//
// Single cycle: LVNL publishes no pre-release, so -target auto files
// whatever is current by its own effective date and no .next twin
// appears.
//
// Run directly:
//
//	go run ./cmd/nl
package main

import (
	"cmp"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/aixm5"
	"github.com/0intro/loxodrome/internal/aixm5build"
	"github.com/0intro/loxodrome/internal/overlay"
)

// defaultOutDir is resolved relative to the working directory, expected
// to be the repo root (`go run ./cmd/nl`).
const defaultOutDir = "public/data"

const fetchTimeout = 20 * time.Minute

const (
	defaultMinNlAirspaces = 200
	defaultMaxNlAirspaces = 2000
	defaultMinNlAirports  = 20
	defaultMaxNlAirports  = 500
	defaultMinNlNavaids   = 400
	defaultMaxNlNavaids   = 5000
)

// nlCountryFromIcao maps the Dutch ICAO prefix to ISO-3166. EH is the
// Netherlands family; the AIP publishes only Dutch aerodromes.
var nlCountryFromIcao = aixm5build.IcaoCountry(map[string]string{
	"EH": "NL",
}, "NL")

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	outDir := flag.String("out", defaultOutDir, "output directory for nl-*.json and nl-*.meta.json")
	target := flag.String("target", "auto", `output slot: "current" (nl-*.json), "next" (nl-*.next.json), or "auto" (decide from the effective date)`)
	only := flag.String("only", "", "comma-separated dataset filter; empty means all (airspaces,airports,navaids)")
	var win aip.SanityWindows
	win.Register(flag.CommandLine)
	flag.Parse()

	ctx, cancel := context.WithTimeout(context.Background(), fetchTimeout)
	defer cancel()

	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		return err
	}
	want := aip.DatasetFilter(*only)
	now := time.Now

	if want("airspaces") {
		if err := buildAirspaces(ctx, *outDir, *target, win, now); err != nil {
			return fmt.Errorf("airspaces: %w", err)
		}
	}
	if want("airports") {
		if err := buildAirports(ctx, *outDir, *target, win, now); err != nil {
			return fmt.Errorf("airports: %w", err)
		}
	}
	if want("navaids") {
		if err := buildNavaids(ctx, *outDir, *target, win, now); err != nil {
			return fmt.Errorf("navaids: %w", err)
		}
	}
	return nil
}

// nlAirspacesMeta wraps the shared overlay meta with the per-layer
// counters, the established pattern for a parser-fed publisher (cmd/at's
// atAirspacesMeta does the same).
type nlAirspacesMeta struct {
	GeneratedAt   string         `json:"generatedAt"`
	Source        string         `json:"source"`
	SourceSha256  string         `json:"sourceSha256"`
	Effective     string         `json:"effective"`
	AirspaceCount int            `json:"airspaceCount"`
	LayerCounts   map[string]int `json:"layerCounts"`
	SkippedType   int            `json:"skippedType"`
	SkippedNoID   int            `json:"skippedNoID"`
	SkippedNoGeo  int            `json:"skippedNoGeo"`
	Counts        map[string]int `json:"counts"`
	BBox          aip.BBox       `json:"bbox,omitempty"`
	// BBoxes splits that envelope into the pieces the rows really
	// occupy, for a publisher whose territory is not connected;
	// absent when the rows form one group.
	BBoxes []aip.BBox `json:"bboxes,omitempty"`
}

func buildAirspaces(ctx context.Context, outDir, target string, win aip.SanityWindows, now func() time.Time) error {
	var (
		rows      []overlay.Row
		raw       []byte
		stats     buildStats
		layerN    = map[string]int{}
		effective string
	)
	for _, l := range airspaceLayers {
		feats, body, err := fetchLayer(ctx, layerURL("Airspaces_data", l.id))
		if err != nil {
			return fmt.Errorf("layer %d (%s): %w", l.id, l.label, err)
		}
		raw = append(raw, body...)
		layerN[l.label] = len(feats)
		rows = append(rows, airspaceRows(l, feats, &stats)...)
		if e := latestEffective(feats); e > effective {
			effective = e
		}
	}
	art, counts := overlay.RowsToArtifact(rows)

	minA := cmp.Or(win.MinAirspaces, defaultMinNlAirspaces)
	maxA := cmp.Or(win.MaxAirspaces, defaultMaxNlAirspaces)
	if n := len(art.Rows); n < minA || n > maxA {
		return fmt.Errorf("NL airspace count %d outside sanity window [%d, %d] - source format may have changed",
			n, minA, maxA)
	}

	sum := sha256.Sum256(raw)
	meta := nlAirspacesMeta{
		GeneratedAt:   now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Source:        "LVNL Airspaces_data FeatureServer",
		SourceSha256:  hex.EncodeToString(sum[:]),
		Effective:     effective,
		AirspaceCount: len(art.Rows),
		LayerCounts:   layerN,
		SkippedType:   stats.skippedType,
		SkippedNoID:   stats.skippedNoID,
		SkippedNoGeo:  stats.skippedNoGeo,
		Counts:        counts,
		BBox:          aip.BBoxOfRows(art.Fields, art.Rows),
		BBoxes:        aip.BBoxClustersOfRows(art.Fields, art.Rows),
	}
	slot, err := aip.WriteDataset(outDir, "nl-airspaces", target, meta.Effective, art, meta)
	if err != nil {
		return err
	}
	fmt.Printf("wrote %d airspaces from %d LVNL layers; effective %s; slot=%s; skipped %d untyped, %d without an id, %d without geometry\n",
		meta.AirspaceCount, len(airspaceLayers), meta.Effective, slot,
		stats.skippedType, stats.skippedNoID, stats.skippedNoGeo)
	return nil
}

func buildAirports(ctx context.Context, outDir, target string, win aip.SanityWindows, now func() time.Time) error {
	var (
		msg       aixm5.Message
		raw       []byte
		stats     buildStats
		effective string
	)
	charts := map[string][]any{}
	for _, l := range aerodromeLayers {
		feats, body, err := fetchLayer(ctx, layerURL("Aerodrome", l.id))
		if err != nil {
			return fmt.Errorf("layer %d (%s): %w", l.id, l.label, err)
		}
		raw = append(raw, body...)
		msg.Airports = append(msg.Airports, parseAerodromes(l, feats, charts, &stats)...)
		if e := latestEffective(feats); e > effective {
			effective = e
		}
	}
	art, meta, err := aixm5build.BuildAirports(&msg, "LVNL Aerodrome FeatureServer", raw, effective,
		aixm5build.AirportsOptions{
			Country:         "NL",
			CountryFromIcao: nlCountryFromIcao,
			Now:             now,
			MinAirports:     cmp.Or(win.MinAirports, defaultMinNlAirports),
			MaxAirports:     cmp.Or(win.MaxAirports, defaultMaxNlAirports),
			Charts:          charts,
			ChartFields:     nlChartFields,
		})
	if err != nil {
		return err
	}
	slot, err := aip.WriteDataset(outDir, "nl-airports", target, meta.Effective, art, meta)
	if err != nil {
		return err
	}
	fmt.Printf("wrote %d airports (%d military, %d charts) from %d LVNL layers; effective %s; slot=%s\n",
		meta.AhpCount, meta.MilitaryCount, meta.ChartCount, len(aerodromeLayers), meta.Effective, slot)
	return nil
}

func buildNavaids(ctx context.Context, outDir, target string, win aip.SanityWindows, now func() time.Time) error {
	var (
		msg       aixm5.Message
		raw       []byte
		stats     buildStats
		effective string
	)

	// Read the ILS DME layer first: it decides whether a localizer emits
	// as ILS or ILS-DME.
	ilsDme, body, err := fetchLayer(ctx, layerURL("Navaid", ilsDmeLayer))
	if err != nil {
		return fmt.Errorf("ILS DME layer: %w", err)
	}
	raw = append(raw, body...)
	ilsDmeIdents := map[string]bool{}
	for i := range ilsDme {
		if d := prop(ilsDme[i].Properties, "Designator"); d != "" {
			ilsDmeIdents[strings.ToUpper(d)] = true
		}
	}

	for _, l := range navaidLayers {
		feats, body, err := fetchLayer(ctx, layerURL("Navaid", l.id))
		if err != nil {
			return fmt.Errorf("layer %d (%s): %w", l.id, l.label, err)
		}
		raw = append(raw, body...)
		msg.Navaids = append(msg.Navaids, parseNavaids(l, feats, ilsDmeIdents, &stats)...)
		if e := latestEffective(feats); e > effective {
			effective = e
		}
	}
	for _, l := range waypointLayers {
		feats, body, err := fetchLayer(ctx, layerURL("Waypoints_data", l.id))
		if err != nil {
			return fmt.Errorf("waypoint layer %d (%s): %w", l.id, l.label, err)
		}
		raw = append(raw, body...)
		msg.Navaids = append(msg.Navaids, parseWaypoints(l, feats, &stats)...)
		if e := latestEffective(feats); e > effective {
			effective = e
		}
	}

	art, meta, err := aixm5build.BuildNavaids(&msg, "LVNL Navaid + Waypoints FeatureServers", raw, effective,
		aixm5build.NavaidsOptions{
			IDPrefix:   "nl",
			Country:    "NL",
			Now:        now,
			MinNavaids: cmp.Or(win.MinNavaids, defaultMinNlNavaids),
			MaxNavaids: cmp.Or(win.MaxNavaids, defaultMaxNlNavaids),
		})
	if err != nil {
		return err
	}
	slot, err := aip.WriteDataset(outDir, "nl-navaids", target, meta.Effective, art, meta)
	if err != nil {
		return err
	}
	fmt.Printf("wrote %d navaids and points; effective %s; slot=%s; skipped %d aerodrome reference points\n",
		meta.NavaidCount, meta.Effective, slot, stats.skippedType)
	return nil
}

// latestEffective reads the newest EffectiveDate in a layer, as the
// ISO-8601 form aip.ResolveTarget parses. LVNL stamps it per feature in
// epoch milliseconds; the newest one across the fetched layers is the
// cycle the data set belongs to.
func latestEffective(feats []feature) string {
	newest := float64(0)
	for i := range feats {
		if v, ok := propNum(feats[i].Properties, "EffectiveDate"); ok && v > newest {
			newest = v
		}
	}
	if newest == 0 {
		return ""
	}
	t := time.UnixMilli(int64(newest)).UTC()
	return t.Format("2006-01-02") + "T00:00:00.000Z"
}
