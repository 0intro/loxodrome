// Command vacgeo builds public/data/fr-vacgeo.json (+ .meta.json): where on
// the ground each panel of each French Atlas VAC plate sits, so the app can
// draw the SIA's own approach and landing charts over the map.
//
// The plates are pure vector PDFs carrying a lat/lon graticule. panels.go
// reads the graticule's tick marks and turns them into a linear mapping
// from page points to coordinates; build.go throws away any panel that
// does not then contain the aerodrome it claims to show.
//
// It reads the plates cmd/aipdocs has already fetched, and enumerates them
// from the same committed fr-adcharts.json membership column, so the
// dataset, the offline pack and this georeference are three views of one
// cycle and cannot disagree about which plates exist.
//
//	go run ./cmd/vacgeo                       # current cycle
//	go run ./cmd/vacgeo -target auto          # + the pre-release when it exists
//	go run ./cmd/vacgeo -only LFPL -dump      # one plate, printed not written
package main

import (
	"flag"
	"fmt"
	"log"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
)

func main() {
	log.SetFlags(0)
	log.SetPrefix("vacgeo: ")
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	outDir := flag.String("out", "public/data", "output directory")
	dataDir := flag.String("data", "public/data", "directory holding fr-adcharts.json and fr-airports.json")
	cacheDir := flag.String("cache", "local/aipdocs-cache", "cmd/aipdocs plate cache root")
	ovPath := flag.String("overrides", "cmd/vacgeo/overrides.tsv", "hand-placed panels")
	target := flag.String("target", "current", "AIRAC slot: current, next or auto")
	only := flag.String("only", "", "comma-separated ident filter (debug; skips the sanity floor)")
	minPanels := flag.Int("min-panels", 500, "sanity floor: panels emitted")
	dump := flag.Bool("dump", false, "print the panels instead of writing the dataset")
	rep := flag.Bool("report", false, "print one line per page that yielded no panel")
	flag.Parse()

	if *rep {
		report = func(ident string, section, page int, kind, why string, fit *panelFit) {
			extra := ""
			if fit != nil {
				extra = fmt.Sprintf(" ticks %d/%d rms %.3f dev %+.2f%%", fit.LatN, fit.LonN,
					math.Max(fit.LatRMS, fit.LonRMS), fit.DevPct)
			}
			fmt.Printf("%s/%d p%d %-4s %s%s\n", ident, section, page, kind, why, extra)
		}
	}

	filter := aip.DatasetFilter(*only)
	slots := []struct{ suffix, target string }{{"", "current"}}
	if *target == "next" {
		slots = []struct{ suffix, target string }{{".next", "next"}}
	} else if *target == "auto" {
		// Oldest first: writing the current slot is what retires a
		// pre-release it has caught up with.
		slots = append(slots, struct{ suffix, target string }{".next", "next"})
	}

	ov, err := loadOverrides(*ovPath)
	if err != nil {
		return err
	}

	for _, slot := range slots {
		charts := filepath.Join(*dataDir, "fr-adcharts"+slot.suffix+".json")
		if _, err := os.Stat(charts); err != nil {
			if slot.suffix == "" {
				return fmt.Errorf("%s: %w", charts, err)
			}
			log.Printf("next: %s not published yet", filepath.Base(charts))
			continue
		}
		art, meta, err := build(*dataDir, *cacheDir, charts, slot.suffix, ov, filter)
		if err != nil {
			if slot.suffix == "" {
				return err
			}
			log.Printf("next: %v (skipped)", err)
			continue
		}
		if *dump {
			dumpPanels(art)
			continue
		}
		if *only == "" && meta.Panels < *minPanels {
			err := fmt.Errorf("sanity floor: %d panels (want >= %d)", meta.Panels, *minPanels)
			if slot.suffix == "" {
				return err
			}
			log.Printf("next: %v (skipped)", err)
			continue
		}
		if _, err := aip.WriteDataset(*outDir, "fr-vacgeo", slot.target, meta.Effective, art, meta); err != nil {
			return err
		}
		log.Printf("%s %s: %d panels over %d aerodromes from %d plates (%v by %v); %d unplaced, %d gate-rejected, %d missing; failures %v",
			slot.target, meta.Effective, meta.Panels, meta.Aerodromes, meta.Plates,
			meta.ByKind, meta.ByMethod, meta.NoGraticule, meta.GateRejected, meta.MissingPlate, meta.ByReason)
	}
	return nil
}

func build(dataDir, cacheDir, chartsPath, suffix string, ov overrides, filter func(string) bool) (*Artifact, *Meta, error) {
	rows, err := loadVacRows(chartsPath)
	if err != nil {
		return nil, nil, err
	}
	metaPath := strings.TrimSuffix(chartsPath, ".json") + ".meta.json"
	effective, err := aip.ReadEffective(metaPath)
	if err != nil {
		return nil, nil, err
	}
	positions, err := airportPositions(filepath.Join(dataDir, "fr-airports"+suffix+".json"))
	if err != nil {
		// The pre-release airports slot may not exist; the current one
		// is then the best independent check available.
		positions, err = airportPositions(filepath.Join(dataDir, "fr-airports.json"))
		if err != nil {
			return nil, nil, err
		}
	}

	cycle := aip.EAIPDateSegment(effective)
	plateDir := filepath.Join(cacheDir, "vac", cycle)
	if _, err := os.Stat(plateDir); err != nil {
		return nil, nil, fmt.Errorf("plate cache %s: %w (run cmd/aipdocs first)", plateDir, err)
	}

	st := stats{byKind: map[string]int{}, byReason: map[string]int{}, byMethod: map[string]int{}}
	var panels []panelRow
	idents := map[string]bool{}
	for _, r := range rows {
		if !filter(r.Ident) {
			continue
		}
		for _, section := range aip.SIAVacSections(r.Vac) {
			name := aip.SIAVacPlateName(r.Ident, section)
			p := plate{ident: strings.ToUpper(r.Ident), section: section, path: filepath.Join(plateDir, name)}
			if _, err := os.Stat(p.path); err != nil {
				st.missingPlate++
				continue
			}
			var ref *airportRef
			if a, ok := positions[p.ident]; ok {
				ref = &a
			}
			got, err := readPlate(p, ref, ov, &st)
			if err != nil {
				log.Printf("%s: %v", name, err)
				continue
			}
			for _, g := range got {
				panels = append(panels, g)
				idents[g.ident] = true
			}
		}
	}

	sort.Slice(panels, func(i, j int) bool {
		a, b := panels[i], panels[j]
		if a.ident != b.ident {
			return a.ident < b.ident
		}
		if a.section != b.section {
			return a.section < b.section
		}
		return a.page < b.page
	})

	art := &Artifact{Fields: artifactFields}
	for _, p := range panels {
		art.Rows = append(art.Rows, rowOf(p))
	}
	meta := &Meta{
		GeneratedAt: time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Effective:   aip.AiracISO(effective),
		Source: sourceMeta{
			Site:    aip.SIAHost,
			Dataset: "fr-adcharts" + suffix + ".json",
			Plates:  aip.SIAAtlasVACBase(effective),
		},
		Plates: st.plates, Panels: st.panels, Aerodromes: len(idents),
		ByKind: st.byKind, ByMethod: st.byMethod, Overrides: st.overridden,
		NoGraticule: st.noGraticule, GateRejected: st.gateReject, MissingPlate: st.missingPlate,
		ByReason:      st.byReason,
		BBox:          aip.BBoxOfRows(art.Fields, art.Rows),
		ParserVersion: parserVersion,
	}
	return art, meta, nil
}

func dumpPanels(art *Artifact) {
	for _, r := range art.Rows {
		row := r.([]any)
		clip := row[4].([]float64)
		sw := row[5].([]float64)
		ne := row[6].([]float64)
		q := row[10].(quality)
		fmt.Printf("%s/%v p%v %-3s %-9s clip %.1f %.1f %.1f %.1f  %.5f,%.5f .. %.5f,%.5f  ticks %d/%d rms %.3f dev %+.2f%% rwy %d resid %.1fm scaledev %+.2f%% arp %.0fm\n",
			row[0], row[1], row[2], row[3], q.Method, clip[0], clip[1], clip[2], clip[3],
			sw[0], sw[1], ne[0], ne[1], q.LatN, q.LonN, q.RMS, q.DevPct,
			q.Runways, q.ResidM, q.ScaleDev, q.ARPm)
	}
}
