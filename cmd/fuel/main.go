// Command fuel builds public/data/fr-fuel.json (+ .meta.json): which fuel
// grades each French aerodrome publishes, typed, so the app can answer
// whether a given aeroplane can refuel at a given field.
//
// There is no structured fuel field anywhere in the French AIP, so this is
// a grammar over two bodies of prose (internal/fuel):
//
//   - the VAC plate's item "10 - AVT", carried by 417 of the 419 aerodrome
//     plates, read out of the cache cmd/aipdocs already filled and
//     enumerated from the same committed fr-adcharts.json membership column
//     cmd/vacgeo uses;
//   - the AIXM AD 2.4 service entry, taken from the `fuel` column cmd/fr
//     writes into fr-aerodrome-facilities.json. The Atlas VAC is
//     metropolitan only, so this is what covers the overseas fields and the
//     air bases, and it carries most of the entries that state NIL.
//
// Neither source is complete and they agree where they overlap, so the two
// are unioned and the sidecar counts how they related.
//
//	go run ./cmd/fuel                        # current cycle
//	go run ./cmd/fuel -target auto           # + the pre-release when both halves have one
//	go run ./cmd/fuel -only LFPL -dump       # one aerodrome, printed not written
//	go run ./cmd/fuel -report                # every entry that yielded no grade
package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/fuel"
)

func main() {
	log.SetFlags(0)
	log.SetPrefix("fuel: ")
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	outDir := flag.String("out", "public/data", "output directory")
	dataDir := flag.String("data", "public/data", "directory holding fr-adcharts.json and fr-aerodrome-facilities.json")
	cacheDir := flag.String("cache", "local/aipdocs-cache", "cmd/aipdocs plate cache root")
	target := flag.String("target", "current", "AIRAC slot: current, next or auto")
	only := flag.String("only", "", "comma-separated ident filter (debug; skips the sanity floor)")
	minRows := flag.Int("min-rows", 400, "sanity floor: aerodromes emitted")
	dump := flag.Bool("dump", false, "print the rows instead of writing the dataset")
	rep := flag.Bool("report", false, "print one line per entry that yielded no grade")
	flag.Parse()

	filter := aip.DatasetFilter(*only)
	slots := []struct{ suffix, target string }{{"", "current"}}
	switch *target {
	case "next":
		slots = []struct{ suffix, target string }{{".next", "next"}}
	case "auto":
		// Oldest first, so writing the current slot retires a pre-release
		// it has caught up with.
		slots = append(slots, struct{ suffix, target string }{".next", "next"})
	}

	for _, slot := range slots {
		charts := filepath.Join(*dataDir, "fr-adcharts"+slot.suffix+".json")
		facilities := filepath.Join(*dataDir, "fr-aerodrome-facilities"+slot.suffix+".json")
		// Both halves or neither. A next slot built from the AIXM alone
		// would be a few hundred rows short of the current one, and
		// pickActiveDataset would switch to it at the AIRAC flip: the app
		// would silently forget every plate-derived aerodrome.
		if missing := firstMissing(charts, facilities); missing != "" {
			if slot.suffix == "" {
				return fmt.Errorf("%s: not found", missing)
			}
			log.Printf("next: %s not published yet, skipping the slot", filepath.Base(missing))
			continue
		}

		art, meta, rows, err := build(*dataDir, *cacheDir, charts, facilities, slot.suffix, filter, *rep)
		if err != nil {
			if slot.suffix == "" {
				return err
			}
			log.Printf("next: %v (skipped)", err)
			continue
		}
		if *dump {
			dumpRows(art)
			continue
		}
		if *only == "" {
			if err := checkSanity(meta, *minRows); err != nil {
				if slot.suffix == "" {
					return err
				}
				log.Printf("next: %v (skipped)", err)
				continue
			}
		}
		if ids := divergentIdents(rows); len(ids) > 0 {
			// Not fatal: a cycle boundary can leave the two halves stating
			// different things for a moment. Loud, because the steady state
			// is zero and anything else means one of the two readers has
			// drifted.
			log.Printf("WARNING: the plate and the AIXM disagree at %s", strings.Join(ids, ", "))
		}
		if _, err := aip.WriteDataset(*outDir, "fr-fuel", slot.target, meta.Effective, art, meta); err != nil {
			return err
		}
		log.Printf("%s %s (AIXM %s): %d aerodromes, %d with grades, %d no fuel, %d unread; sources %v, agreement %v; grades %v; plates %d/%d with an item, %d cut by a page",
			slot.target, meta.Effective, meta.AixmEffective, meta.Aerodromes, meta.WithGrades,
			meta.NoFuel, meta.StatedNoGrade, meta.BySource, meta.Agreement, meta.ByGrade,
			meta.Plates.WithItem, meta.Plates.Plates, meta.Plates.CutByPage)
	}
	return nil
}

func firstMissing(paths ...string) string {
	for _, p := range paths {
		if _, err := os.Stat(p); err != nil {
			return p
		}
	}
	return ""
}

// build reads one AIRAC slot.
func build(dataDir, cacheDir, charts, facilities, suffix string, keep func(string) bool, rep bool) (Artifact, Meta, []row, error) {
	effective, err := aip.ReadEffective(filepath.Join(dataDir, "fr-adcharts"+suffix+".meta.json"))
	if err != nil {
		return Artifact{}, Meta{}, nil, err
	}
	aixmEffective, err := aip.ReadEffective(filepath.Join(dataDir, "fr-aerodrome-facilities"+suffix+".meta.json"))
	if err != nil {
		return Artifact{}, Meta{}, nil, err
	}

	cycle := aip.EAIPDateSegment(effective)
	plateDir := filepath.Join(cacheDir, "vac", cycle)
	if _, err := os.Stat(plateDir); err != nil {
		return Artifact{}, Meta{}, nil, fmt.Errorf("plate cache %s: %w (run cmd/aipdocs first)", plateDir, err)
	}

	vacRows, err := aip.ReadVacRows(charts)
	if err != nil {
		return Artifact{}, Meta{}, nil, err
	}
	items, ps, err := readPlates(plateDir, vacRows, keep)
	if err != nil {
		return Artifact{}, Meta{}, nil, err
	}

	aixms, err := readFacilitiesFuel(facilities)
	if err != nil {
		return Artifact{}, Meta{}, nil, err
	}
	kept := aixms[:0]
	for _, a := range aixms {
		if keep(a.Ident) {
			kept = append(kept, a)
		}
	}

	rows := mergeSources(items, kept)
	if rep {
		reportUnread(rows)
	}
	art, meta := buildArtifact(rows, ps, time.Now(), aip.AiracISO(effective),
		aip.AiracISO(aixmEffective), aip.SIAAtlasVACBase(effective))
	return art, meta, rows, nil
}

// divergentIdents names the aerodromes whose two sources contradict each
// other. The steady state is none: where both speak they agree, or one
// knows more than the other. Anything else means one of the two readers has
// drifted, and naming the rows is the difference between a number nobody
// can act on and a list somebody can open a plate against.
func divergentIdents(rows []row) []string {
	var out []string
	for _, r := range rows {
		if r.agree == fuel.AgreeDiverge {
			out = append(out, r.ident)
		}
	}
	return out
}

// reportUnread prints the entries a grade could not be read from. Working
// that list down is how the grammar improves, and it is the reason the
// residue is a counted field in the sidecar rather than an accepted loss.
func reportUnread(rows []row) {
	for _, r := range rows {
		if len(r.st.Grades) > 0 || r.st.Avail == fuel.AvailNo {
			continue
		}
		fmt.Printf("%s [%s] %s\n", r.ident, r.src, oneLine(r.st.Text, 140))
	}
}

func dumpRows(art Artifact) {
	for _, raw := range art.Rows {
		r, ok := raw.([]any)
		if !ok || len(r) < 6 {
			continue
		}
		var grades []string
		if gs, ok := r[2].([]any); ok {
			for _, g := range gs {
				if pair, ok := g.([]string); ok && len(pair) == 2 {
					if pair[1] == "" {
						grades = append(grades, pair[0])
					} else {
						grades = append(grades, pair[0]+"("+pair[1]+")")
					}
				}
			}
		}
		fmt.Printf("%-6v %-3v %-40s %v %v\n", r[0], r[1], strings.Join(grades, " "), r[3], r[4])
		fmt.Printf("       %s\n", oneLine(fmt.Sprint(r[5]), 160))
	}
}

func oneLine(s string, max int) string {
	s = strings.Join(strings.Fields(strings.ReplaceAll(s, "#", " ")), " ")
	if len(s) > max {
		s = s[:max] + "..."
	}
	return s
}
