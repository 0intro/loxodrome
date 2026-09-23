// Command be builds the Belgium & Luxembourg datasets (be-airspaces.json,
// be-airports.json, be-navaids.json, be-obstacles.json, be-nature.json,
// be-supaip.json + .meta.json sidecars, and the .next.* twins while skeyes
// pre-publishes the next cycle) from the public skeyes eAIP: the joint
// "AIP Belgium and Luxembourg" published as Eurocontrol-eAIP HTML at
// ops.skeyes.be. There is no public AIXM for Belgium; the HTML tables are
// machine-regular and parsed directly (see docs/be-aip.md for the parser
// contract). FIR / UIR rows are skipped on purpose: pruatlas-firs.json
// already ships the EBBU ring with true border geometry, which this tool
// also borrows to stitch "along the ... border" zone segments.
//
// Live mode fetches both slots (eAIP_Main → the current dataset files,
// eAIP_Next → the .next twins when it serves a newer cycle) and needs a
// browser-style User-Agent (the skeyes WAF rejects generic clients).
// Offline mode (-in) reads a -snapshot directory back, no network.
//
// Run directly: go run ./cmd/be
// Offline:      go run ./cmd/be -in local/be-eaip/main

package main

import (
	"cmp"
	"context"
	"flag"
	"fmt"
	"github.com/0intro/loxodrome/internal/eaip"
	"os"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/aixm5"
	"github.com/0intro/loxodrome/internal/aixm5build"
)

// defaultOutDir is resolved relative to the working directory, expected to
// be the repo root (`go run ./cmd/be`).
const defaultOutDir = "public/data"

// defaultFirsPath is the checked-in pruatlas dataset carrying the EBBU
// border ring.
const defaultFirsPath = "public/data/pruatlas-firs.json"

const (
	defaultMinBeAirspaces = 120
	defaultMaxBeAirspaces = 2000
	defaultMinBeNavaids   = 250
	defaultMaxBeNavaids   = 2000
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// buildConfig carries the per-run settings buildAll needs.
type buildConfig struct {
	outDir               string
	want                 func(string) bool
	win                  aip.SanityWindows
	minNature, maxNature int
	minSupaip, maxSupaip int
	border               *eaip.BorderRing
}

func run() error {
	in := flag.String("in", "", "offline mode: read a snapshot directory instead of fetching ops.skeyes.be")
	snapshot := flag.String("snapshot", "", "live mode: dump every fetched page under this directory (per-slot subdirectories)")
	outDir := flag.String("out", defaultOutDir, "output directory for be-*.json and be-*.meta.json")
	target := flag.String("target", "auto", `offline-mode output slot: "current", "next", or "auto" (decide from the eAIP validity date); live mode writes eAIP_Main to current and eAIP_Next to next`)
	only := flag.String("only", "", "comma-separated dataset filter; empty means all (airspaces,airports,navaids,obstacles,nature,facilities,supaip)")
	firs := flag.String("firs", defaultFirsPath, "pruatlas-firs.json path providing the EBBU border ring")
	var win aip.SanityWindows
	win.Register(flag.CommandLine)
	minNature := flag.Int("min-nature", 0, "sanity window floor for bird-area count (0 = default)")
	maxNature := flag.Int("max-nature", 0, "sanity window ceiling for bird-area count (0 = default)")
	minSupaip := flag.Int("min-supaip", 0, "sanity window floor for supplement count (0 = default)")
	maxSupaip := flag.Int("max-supaip", 0, "sanity window ceiling for supplement count (0 = default)")
	flag.Parse()

	border, err := eaip.LoadBorderRing(*firs, "EBBU")
	if err != nil || border == nil {
		fmt.Fprintf(os.Stderr, "be: no EBBU border ring (%s: %v); border segments degrade to chords\n", *firs, err)
	}

	cfg := buildConfig{
		outDir:    *outDir,
		want:      aip.DatasetFilter(*only),
		win:       win,
		minNature: *minNature,
		maxNature: *maxNature,
		minSupaip: *minSupaip,
		maxSupaip: *maxSupaip,
		border:    border,
	}
	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		return err
	}

	if *in != "" {
		t, err := acquireOffline(*in)
		if err != nil {
			return err
		}
		return buildAll(t, cfg, *target, true)
	}

	ctx := context.Background()
	f := newFetcher()
	needAD := cfg.want("airspaces") || cfg.want("airports") || cfg.want("facilities")

	mainTree, err := acquireLive(ctx, f, slotMain, needAD, cfg.want("supaip"), snapDir(*snapshot, "main"))
	if err != nil {
		return fmt.Errorf("eAIP_Main: %w", err)
	}
	if err := buildAll(mainTree, cfg, "current", true); err != nil {
		return err
	}

	// The pre-released next cycle. Fail-soft on purpose: between
	// publications the slot may be absent or stale, and that must not
	// fail the whole refresh (a workflow `|| true` would also mask real
	// Main breakage).
	nextTree, err := acquireLive(ctx, f, slotNext, needAD, false, snapDir(*snapshot, "next"))
	if err != nil {
		fmt.Fprintf(os.Stderr, "be: eAIP_Next unavailable, next slot skipped: %v\n", err)
		return nil
	}
	if nextTree.effective == "" || nextTree.effective <= mainTree.effective {
		fmt.Printf("eAIP_Next still serves %s (Main %s); next slot skipped\n",
			shortDate(nextTree.effective), shortDate(mainTree.effective))
		return nil
	}
	return buildAll(nextTree, cfg, "next", false)
}

func snapDir(root, slot string) string {
	if root == "" {
		return ""
	}
	return root + "/" + slot
}

func shortDate(effective string) string {
	if len(effective) >= 10 {
		return effective[:10]
	}
	return "?"
}

// beAirspacesMeta wraps the shared airspaces meta with the HTML-parse
// counters (geometry events and skipped tables) so upstream drift is
// visible cycle to cycle.
type beAirspacesMeta struct {
	aixm5build.AirspacesMeta
	Pages          int            `json:"pages"`
	Arcs           int            `json:"arcs"`
	Circles        int            `json:"circles"`
	BorderStitched int            `json:"borderStitched"`
	BorderChords   int            `json:"borderChords"`
	MultiRowTables int            `json:"multiRowTables"`
	SkippedTables  map[string]int `json:"skippedTables"`
}

// buildAll parses one publication tree and writes every requested dataset
// into the given slot. withSup gates the supplements (Main slot only:
// fr-supaip has no .next twin either).
func buildAll(t *tree, cfg buildConfig, target string, withSup bool) error {
	raw := t.rawConcat()
	effective := t.effective
	source := "skeyes eAIP"
	if effective != "" {
		source += " " + shortDate(effective)
	}
	now := time.Now

	st := newEnrStats()
	var msg aixm5.Message
	var charts map[string][]chartRef
	if cfg.want("airspaces") || cfg.want("airports") || cfg.want("facilities") {
		ad := parseAirportPages(t, cfg.border, st)
		msg.Airports = ad.airports
		charts = ad.charts
		if cfg.want("airspaces") {
			msg.Airspaces = append(parseEnrAirspaces(t, cfg.border, st), ad.ctrs...)
		}
	}
	if cfg.want("navaids") {
		msg.Navaids = parseNavaids(t)
	}
	if cfg.want("obstacles") {
		msg.Obstacles = parseObstacles(t)
	}

	if cfg.want("airspaces") {
		artifact, meta, err := aixm5build.BuildAirspaces(&msg, source, raw, effective, aixm5build.AirspacesOptions{
			Country:      "BE",
			Now:          now,
			MinAirspaces: orDefault(cfg.win.MinAirspaces, defaultMinBeAirspaces),
			MaxAirspaces: orDefault(cfg.win.MaxAirspaces, defaultMaxBeAirspaces),
		})
		if err != nil {
			return fmt.Errorf("airspaces: %w", err)
		}
		wrapped := beAirspacesMeta{
			AirspacesMeta:  meta,
			Pages:          len(t.pages),
			Arcs:           st.boundary.Arcs,
			Circles:        st.boundary.Circles,
			BorderStitched: st.boundary.BorderStitched,
			BorderChords:   st.boundary.BorderChords,
			MultiRowTables: st.multiRow,
			SkippedTables:  st.skippedTypes,
		}
		slot, err := aip.WriteDataset(cfg.outDir, "be-airspaces", target, meta.Effective, artifact, wrapped)
		if err != nil {
			return fmt.Errorf("airspaces: %w", err)
		}
		fmt.Printf("wrote %d airspaces from %s; effective %s; slot=%s; %d stitched / %d chord border segments; skipped %d tables\n",
			meta.AirspaceCount, t.label, meta.Effective, slot,
			st.boundary.BorderStitched, st.boundary.BorderChords, len(st.skippedTypes))
	}

	if cfg.want("airports") {
		artifact, meta, err := aixm5build.BuildAirports(&msg, source, raw, effective, aixm5build.AirportsOptions{
			Country:         "BE",
			CountryFromIcao: beCountryFromIcao,
			Now:             now,
			MinAirports:     cmp.Or(cfg.win.MinAirports, defaultMinBeAirports),
			MaxAirports:     cmp.Or(cfg.win.MaxAirports, defaultMaxBeAirports),
			Charts:          beChartColumn(charts),
			ChartFields:     beChartFields,
		})
		if err != nil {
			return fmt.Errorf("airports: %w", err)
		}
		slot, err := aip.WriteDataset(cfg.outDir, "be-airports", target, meta.Effective, artifact, meta)
		if err != nil {
			return fmt.Errorf("airports: %w", err)
		}
		fmt.Printf("wrote %d airports (%d runways, %d military, %d charts) from %s; effective %s; slot=%s\n",
			meta.AhpCount, meta.RunwayCount, meta.MilitaryCount, meta.ChartCount, t.label, meta.Effective, slot)
	}

	if cfg.want("facilities") {
		artifact, meta, err := aixm5build.BuildFacilities(&msg, source, raw, effective, aixm5build.FacilitiesOptions{
			Country:       "BE",
			Now:           now,
			MinAerodromes: 60,
			MaxAerodromes: 400,
		})
		if err != nil {
			return fmt.Errorf("facilities: %w", err)
		}
		slot, err := aip.WriteDataset(cfg.outDir, "be-aerodrome-facilities", target, meta.Effective, artifact, meta)
		if err != nil {
			return fmt.Errorf("facilities: %w", err)
		}
		fmt.Printf("wrote %d aerodrome facilities (%d heliports, %d notes skipped) from %s; effective %s; slot=%s\n",
			meta.AerodromeCount, meta.HeliportCount, meta.SkippedNotes, t.label, meta.Effective, slot)
	}

	if cfg.want("navaids") {
		artifact, meta, err := aixm5build.BuildNavaids(&msg, source, raw, effective, aixm5build.NavaidsOptions{
			IDPrefix:   "be",
			Country:    "BE",
			Now:        now,
			MinNavaids: orDefault(cfg.win.MinNavaids, defaultMinBeNavaids),
			MaxNavaids: orDefault(cfg.win.MaxNavaids, defaultMaxBeNavaids),
		})
		if err != nil {
			return fmt.Errorf("navaids: %w", err)
		}
		slot, err := aip.WriteDataset(cfg.outDir, "be-navaids", target, meta.Effective, artifact, meta)
		if err != nil {
			return fmt.Errorf("navaids: %w", err)
		}
		fmt.Printf("wrote %d navaids from %s; effective %s; slot=%s\n",
			meta.NavaidCount, t.label, meta.Effective, slot)
	}

	if cfg.want("obstacles") {
		artifact, meta, err := aixm5build.BuildObstacles(&msg, source, raw, effective, aixm5build.ObstaclesOptions{
			IDPrefix:     "be",
			Country:      "BE",
			Now:          now,
			MinObstacles: cmp.Or(cfg.win.MinObstacles, defaultMinBeObstacles),
			MaxObstacles: cmp.Or(cfg.win.MaxObstacles, defaultMaxBeObstacles),
		})
		if err != nil {
			return fmt.Errorf("obstacles: %w", err)
		}
		slot, err := aip.WriteDataset(cfg.outDir, "be-obstacles", target, meta.Effective, artifact, meta)
		if err != nil {
			return fmt.Errorf("obstacles: %w", err)
		}
		fmt.Printf("wrote %d obstacles (%d lit) from %s; effective %s; slot=%s\n",
			meta.ObstacleCount, meta.LitCount, t.label, meta.Effective, slot)
	}

	if cfg.want("nature") {
		artifact, meta, err := BuildNature(parseBirdAreas(t), source, raw, effective, now, cfg.minNature, cfg.maxNature)
		if err != nil {
			return fmt.Errorf("nature: %w", err)
		}
		slot, err := aip.WriteDataset(cfg.outDir, "be-nature", target, meta.Effective, artifact, meta)
		if err != nil {
			return fmt.Errorf("nature: %w", err)
		}
		fmt.Printf("wrote %d bird areas from %s; effective %s; slot=%s\n",
			meta.ZoneCount, t.label, meta.Effective, slot)
	}

	if _, hasSupList := t.pages[supListPage]; withSup && cfg.want("supaip") && !hasSupList {
		// A tree without the eSUP listing (the Next snapshot: supplements
		// are not AIRAC-sliced and only ride the Main fetch) skips the
		// dataset instead of tripping the sanity window.
		fmt.Fprintf(os.Stderr, "be: no eSUP listing in %s; supplements skipped\n", t.label)
		withSup = false
	}
	if withSup && cfg.want("supaip") {
		artifact, meta, err := BuildSupaip(parseSupplements(t), supListingSha(t), now, cfg.minSupaip, cfg.maxSupaip)
		if err != nil {
			return fmt.Errorf("supaip: %w", err)
		}
		if err := aip.WriteCompactJSON(cfg.outDir+"/be-supaip.json", artifact); err != nil {
			return fmt.Errorf("supaip: %w", err)
		}
		if err := aip.WritePrettyJSON(cfg.outDir+"/be-supaip.meta.json", meta); err != nil {
			return fmt.Errorf("supaip: %w", err)
		}
		fmt.Printf("wrote %d supplements (%d with geometry) from %s\n",
			meta.Total, meta.WithGeometry, t.label)
	}

	return nil
}

func orDefault(v, def int) int {
	if v == 0 {
		return def
	}
	return v
}
