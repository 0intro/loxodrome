// Command at builds the Austria datasets (at-airspaces.json,
// at-airports.json, at-navaids.json, at-obstacles.json + .meta.json
// sidecars) from the two public Austro Control AIM products:
//
//   - the Luftraumstruktur KML, which carries the civil and military
//     airspace, the sporting areas, the aerodromes and heliports, the
//     radio navigation aids and the VFR reporting points;
//   - the Obstacle Data Set (ICAO), Area 1 in AIXM 5.1.1, which is
//     Austria's obstacle publication since the ENR 5.4 tables were
//     withdrawn.
//
// Both are free downloads off austrocontrol.at, listed one cycle at a
// time with the AIRAC effective date stamped into the filename. FIR /
// UIR rows are left to pruatlas-firs.json, which ships the LOVV ring.
// See docs/at-aip.md for the parser contract.
//
// Run directly: go run ./cmd/at
// Offline:      go run ./cmd/at -in local/at-snapshot
package main

import (
	"cmp"
	"context"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/aixm5"
	"github.com/0intro/loxodrome/internal/aixm5build"
)

// defaultOutDir is resolved relative to the working directory, expected
// to be the repo root (`go run ./cmd/at`).
const defaultOutDir = "public/data"

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	in := flag.String("in", "", "offline mode: read a snapshot directory instead of fetching austrocontrol.at")
	snapshot := flag.String("snapshot", "", "live mode: dump every fetched download under this directory")
	outDir := flag.String("out", defaultOutDir, "output directory for at-*.json and at-*.meta.json")
	target := flag.String("target", "auto", `output slot: "current" (at-*.json), "next" (at-*.next.json), or "auto" (decide from the AIRAC effective date)`)
	only := flag.String("only", "", "comma-separated dataset filter; empty means all (airspaces,airports,navaids,obstacles,adcharts)")
	effectiveFlag := flag.String("effective", "", "AIRAC effective date (YYYY-MM-DD or YYYYMMDD); overrides the date stamped into the download filename")
	var win aip.SanityWindows
	win.Register(flag.CommandLine)
	minAdAerodromes := flag.Int("min-ad-aerodromes", 0, "sanity window floor for the eAIP aerodrome count (0 = default)")
	minAdCharts := flag.Int("min-ad-charts", 0, "sanity window floor for the eAIP chart count (0 = default)")
	flag.Parse()

	want := aip.DatasetFilter(*only)
	needKML := want("airspaces") || want("airports") || want("navaids")
	needObstacles := want("obstacles")
	needCharts := want("adcharts")

	ctx := context.Background()
	f := newFetcher()

	var src *sources
	var err error
	switch {
	case !needKML && !needObstacles:
		// A charts-only run reads the eAIP alone; the AIM product
		// downloads are several megabytes and feed the other datasets.
		src = &sources{}
	case *in != "":
		src, err = acquireOffline(*in, time.Now())
	default:
		src, err = acquireLive(ctx, f, *snapshot, time.Now(), needKML, needObstacles)
	}
	if err != nil {
		return err
	}

	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		return err
	}

	override := normaliseEffective(*effectiveFlag)
	now := time.Now

	if needKML {
		editions := slotEditions(src.airspaceEditions(), *target)
		if len(editions) == 0 {
			return fmt.Errorf("no Luftraumstruktur KML available")
		}
		for _, edition := range editions {
			if err := buildKML(edition, *target, *outDir, override, now, want, win); err != nil {
				return err
			}
		}
	}

	if needObstacles {
		editions := slotEditions(src.obstacleEditions(), *target)
		if len(editions) == 0 {
			return fmt.Errorf("no Obstacle Data Set available")
		}
		for _, edition := range editions {
			if err := buildObstacles(edition, *target, *outDir, override, now, win); err != nil {
				return err
			}
		}
	}

	if needCharts {
		if err := buildAdCharts(ctx, f, *in, *snapshot, *outDir, AdChartsOptions{
			Now:           now,
			MinAerodromes: *minAdAerodromes,
			MinCharts:     *minAdCharts,
		}); err != nil {
			return fmt.Errorf("adcharts: %w", err)
		}
	}

	return nil
}

// slotEditions narrows the editions a product offers to the ones this run
// should write. Under the default "auto" both are built and each lands in
// the slot its own effective date selects; an explicit -target names one
// slot, so only that edition is built, or the second would overwrite the
// first. A -target current run with nothing but a pre-release listed still
// builds it, since acquireProduct only returns a lone future edition when
// that is all the publisher has out.
func slotEditions(editions []*download, target string) []*download {
	if len(editions) == 0 {
		return nil
	}
	switch target {
	case "next":
		if len(editions) > 1 {
			return editions[1:]
		}
		return editions[:1]
	case "current":
		return editions[:1]
	default:
		return editions
	}
}

// buildKML writes the airspace / airport / navaid datasets for one
// Luftraumstruktur edition.
func buildKML(src *download, target, outDir, override string, now func() time.Time, want func(string) bool, win aip.SanityWindows) error {
	payload, inner, err := KMLPayload(src.name, src.data)
	if err != nil {
		return err
	}
	pms, err := ParseKML(payload)
	if err != nil {
		return err
	}
	effective := firstNonEmpty(override, src.effective)
	source := "Austro Control " + src.name
	raw := src.data

	if want("airspaces") {
		parsed := parseAirspaces(pms)
		msg := aixm5.Message{Airspaces: parsed.airspaces}
		artifact, meta, err := aixm5build.BuildAirspaces(&msg, source, raw, effective, aixm5build.AirspacesOptions{
			Country:      "AT",
			Now:          now,
			MinAirspaces: orDefault(win.MinAirspaces, defaultMinAtAirspaces),
			MaxAirspaces: orDefault(win.MaxAirspaces, defaultMaxAtAirspaces),
		})
		if err != nil {
			return fmt.Errorf("airspaces: %w", err)
		}
		wrapped := atAirspacesMeta{
			AirspacesMeta:  meta,
			Placemarks:     parsed.placemarks,
			MultiFootprint: parsed.multiFootprint,
			UnparsedLimits: parsed.unparsed,
			FolderCounts:   parsed.folderCounts,
		}
		slot, err := aip.WriteDataset(outDir, "at-airspaces", target, meta.Effective, artifact, wrapped)
		if err != nil {
			return fmt.Errorf("airspaces: %w", err)
		}
		fmt.Printf("wrote %d airspaces from %s; effective %s; slot=%s; %d placemarks, %d unparsed limits\n",
			meta.AirspaceCount, inner, meta.Effective, slot, parsed.placemarks, len(parsed.unparsed))
	}

	if want("airports") {
		artifact, meta, err := BuildAirports(pms, source, raw, effective, AirportsOptions{
			Now:         now,
			MinAirports: win.MinAirports,
			MaxAirports: win.MaxAirports,
		})
		if err != nil {
			return fmt.Errorf("airports: %w", err)
		}
		slot, err := aip.WriteDataset(outDir, "at-airports", target, meta.Effective, artifact, meta)
		if err != nil {
			return fmt.Errorf("airports: %w", err)
		}
		fmt.Printf("wrote %d airports (%d heliports, %d military) from %s; effective %s; slot=%s\n",
			meta.AhpCount, meta.HeliportCount, meta.MilitaryCount, inner, meta.Effective, slot)
	}

	if want("navaids") {
		msg := aixm5.Message{Navaids: parseNavaids(pms)}
		artifact, meta, err := aixm5build.BuildNavaids(&msg, source, raw, effective, aixm5build.NavaidsOptions{
			IDPrefix:   "at",
			Country:    "AT",
			Now:        now,
			MinNavaids: orDefault(win.MinNavaids, defaultMinAtNavaids),
			MaxNavaids: orDefault(win.MaxNavaids, defaultMaxAtNavaids),
		})
		if err != nil {
			return fmt.Errorf("navaids: %w", err)
		}
		slot, err := aip.WriteDataset(outDir, "at-navaids", target, meta.Effective, artifact, meta)
		if err != nil {
			return fmt.Errorf("navaids: %w", err)
		}
		fmt.Printf("wrote %d navaids from %s; effective %s; slot=%s\n",
			meta.NavaidCount, inner, meta.Effective, slot)
	}

	return nil
}

// buildObstacles writes the obstacle dataset for one Obstacle Data Set
// edition.
func buildObstacles(src *download, target, outDir, override string, now func() time.Time, win aip.SanityWindows) error {
	payload, inner, err := ObstacleXML(src.name, src.data)
	if err != nil {
		return err
	}
	msg, err := aixm5.Decode(payload)
	if err != nil {
		return fmt.Errorf("obstacles: %w", err)
	}
	effective := firstNonEmpty(override, src.effective, msg.Effective)
	artifact, meta, err := aixm5build.BuildObstacles(msg, "Austro Control "+src.name, src.data, effective, aixm5build.ObstaclesOptions{
		IDPrefix:     "at",
		Country:      "AT",
		Now:          now,
		MinObstacles: cmp.Or(win.MinObstacles, defaultMinAtObstacles),
		MaxObstacles: cmp.Or(win.MaxObstacles, defaultMaxAtObstacles),
	})
	if err != nil {
		return fmt.Errorf("obstacles: %w", err)
	}
	slot, err := aip.WriteDataset(outDir, "at-obstacles", target, meta.Effective, artifact, meta)
	if err != nil {
		return fmt.Errorf("obstacles: %w", err)
	}
	fmt.Printf("wrote %d obstacles (%d lit) from %s; effective %s; slot=%s\n",
		meta.ObstacleCount, meta.LitCount, inner, meta.Effective, slot)
	return nil
}

// buildAdCharts writes the chart-link dataset for each edition the eAIP
// serves: the one in force into the current slot, the one that follows it
// into the .next slot. Both are online at once, so the app already holds
// the next edition's links when the changeover withdraws this one's.
func buildAdCharts(ctx context.Context, f *fetcher, in, snapshot, outDir string, opts AdChartsOptions) error {
	var trees []*eaipTree
	var err error
	if in != "" {
		trees, err = acquireEaipOffline(in, opts.Now)
	} else {
		trees, err = acquireEaipLive(ctx, f, snapshot, opts.Now)
	}
	if err != nil {
		return err
	}
	for i, t := range trees {
		slot := "current"
		if i > 0 {
			slot = "next"
		}
		artifact, meta, err := BuildAdCharts(t, opts)
		if err != nil {
			// A partial current edition would silently drop aerodromes;
			// a future edition still being assembled is not yet news.
			if slot == "current" {
				return err
			}
			fmt.Fprintf(os.Stderr, "at: eAIP edition %s skipped: %v\n", t.edition.Segment, err)
			continue
		}
		written, err := aip.WriteDataset(outDir, "at-adcharts", slot, meta.Effective, artifact, meta)
		if err != nil {
			return err
		}
		fmt.Printf("wrote %d aerodromes (%d with charts, %d charts) from eAIP edition %s; effective %s; slot=%s\n",
			meta.Aerodromes+meta.Heliports, meta.WithCharts, meta.Charts,
			meta.Edition, meta.Effective, written)
	}
	return nil
}

// normaliseEffective accepts YYYYMMDD or YYYY-MM-DD and returns the
// ISO-8601 midnight form; anything else (including an already-ISO
// timestamp) is passed through for aip.ResolveTarget to parse.
func normaliseEffective(s string) string {
	s = strings.TrimSpace(s)
	switch {
	case s == "":
		return ""
	case len(s) == 8 && isAllDigits(s):
		return s[:4] + "-" + s[4:6] + "-" + s[6:8] + "T00:00:00.000Z"
	case len(s) == 10 && s[4] == '-' && s[7] == '-':
		return s + "T00:00:00.000Z"
	default:
		return s
	}
}

func isAllDigits(s string) bool {
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func orDefault(v, def int) int {
	if v == 0 {
		return def
	}
	return v
}
