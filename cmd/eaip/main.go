// Command eaip builds the airspace datasets of the States whose AIP is
// published only as a generated eAIP package.
//
// One command rather than seven near-identical ones: the parsing is
// shared (internal/eaip) and what differs per State is a table row in
// states.go, so seven copies of a main.go would be exactly the
// duplication the shared builders were extracted to remove. Each State
// still gets its own dataset prefix, its own workflow and its own
// entry in the SPA, so nothing downstream can tell the difference.
//
// Run directly:
//
//	go run ./cmd/eaip -state hu
//	go run ./cmd/eaip -state all
package main

import (
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
	"github.com/0intro/loxodrome/internal/eaip"
)

const (
	defaultOutDir = "public/data"
	fetchTimeout  = 20 * time.Minute
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	state := flag.String("state", "", `State to build ("hu", "pt", ...), or "all"`)
	outDir := flag.String("out", defaultOutDir, "output directory")
	target := flag.String("target", "auto", `output slot: "current", "next" or "auto"`)
	cycleDir := flag.String("cycle-dir", "", "package directory to read (skips cycle discovery)")
	firs := flag.String("firs", "public/data/pruatlas-firs.json", "pruatlas FIR dataset, for border stitching")
	only := flag.String("only", "", `comma-separated dataset filter ("airspaces", "navaids"); empty means all`)
	list := flag.Bool("list", false, "list the cohort and exit")
	var win aip.SanityWindows
	win.Register(flag.CommandLine)
	flag.Parse()

	if *list {
		for _, s := range states {
			note := s.Note
			if s.Consent != "" {
				note = "HELD: " + s.Consent
			}
			fmt.Printf("%-4s %-26s %s\n", s.CC, s.Label, note)
		}
		return nil
	}
	if *state == "" {
		return fmt.Errorf("-state is required (one of the cohort, or \"all\"; -list shows them)")
	}

	ctx, cancel := context.WithTimeout(context.Background(), fetchTimeout)
	defer cancel()

	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		return err
	}

	if *state == "all" {
		var failed []string
		for i := range states {
			if states[i].Consent != "" {
				fmt.Fprintf(os.Stderr, "%s: skipped, %s\n", states[i].CC, states[i].Consent)
				continue
			}
			if err := build(ctx, &states[i], *outDir, *target, *cycleDir, *firs, aip.DatasetFilter(*only), win); err != nil {
				// One State's site being down must not cost the others
				// their refresh; the caller sees which failed.
				fmt.Fprintf(os.Stderr, "%s: %v\n", states[i].CC, err)
				failed = append(failed, states[i].CC)
			}
		}
		if len(failed) > 0 {
			return fmt.Errorf("failed: %s", strings.Join(failed, ", "))
		}
		return nil
	}

	st := stateByCC(*state)
	if st == nil {
		return fmt.Errorf("unknown state %q; -list shows the cohort", *state)
	}
	return build(ctx, st, *outDir, *target, *cycleDir, *firs, aip.DatasetFilter(*only), win)
}

// airspacesMeta is the <cc>-airspaces.meta.json document for a cohort
// State. It carries the parse counters beside the shared fields, so an
// eAIP that changed its table wording shows up as a number rather than
// as missing airspace.
type airspacesMeta struct {
	GeneratedAt   string `json:"generatedAt"`
	Source        string `json:"source"`
	SourceSha256  string `json:"sourceSha256"`
	Effective     string `json:"effective"`
	AirspaceCount int    `json:"airspaceCount"`
	// SectionCounts is the emitted count per AIP section read.
	SectionCounts map[string]int `json:"sectionCounts"`
	// SectionErrors names the sections that could not be fetched, so a
	// partial build is never mistaken for a complete one.
	SectionErrors map[string]string `json:"sectionErrors,omitempty"`
	Tables        int               `json:"tables"`
	// LimitsSwapped counts the zones a State published lower-limit first.
	LimitsSwapped int `json:"limitsSwapped"`
	// ClassStacks counts the zones published with several classes at
	// once, which the one-letter column cannot express.
	ClassStacks int `json:"classStacks"`
	// WithRadio counts the zones that came with a frequency.
	WithRadio    int `json:"withRadio"`
	PointCircles int `json:"pointCircles"`
	// PointOnly counts the rows the State published as a single point,
	// which carry no lateral limit to draw.
	PointOnly      int `json:"pointOnly"`
	FirRings       int `json:"firRings"`
	BorderStitched int `json:"borderStitched"`
	BorderChords   int `json:"borderChords"`
	// SkippedTypes counts the captions whose family was not recognised.
	SkippedTypes map[string]int `json:"skippedTypes,omitempty"`
	Counts       map[string]int `json:"counts"`
	BBox         aip.BBox       `json:"bbox,omitempty"`
	// BBoxes splits that envelope into the pieces the rows really
	// occupy, for a publisher whose territory is not connected;
	// absent when the rows form one group.
	BBoxes []aip.BBox `json:"bboxes,omitempty"`
}

func build(ctx context.Context, s *State, outDir, target, cycleDir, firs string, want func(string) bool, win aip.SanityWindows) error {
	// The State's own FIR ring is what an "along the border" segment is
	// stitched along. Its absence costs chords, not zones, so a missing
	// dataset is reported and the build carries on.
	if s.FirIdent != "" && s.Spec.Border == nil {
		border, err := eaip.LoadBorderRing(firs, s.FirIdent)
		if err != nil {
			fmt.Fprintf(os.Stderr, "%s: border ring %s: %v (border segments become chords)\n", s.CC, s.FirIdent, err)
		}
		s.Spec.Border = border
	}

	dir := cycleDir
	effective := ""
	if dir == "" {
		// The package is located by probing the AIRAC grid (or the State's
		// own index), and confirmed by reading the first section: a
		// directory that exists but is not yet populated must not be taken
		// for a published cycle.
		cyc, err := s.Site.Resolve(ctx, s.Sections[0], time.Now(), target == "next")
		if err != nil {
			return err
		}
		if cyc.Dir == "" && cyc.Effective == "" && target == "next" {
			fmt.Printf("%s: no pre-release package published; nothing written\n", s.CC)
			return nil
		}
		dir, effective = cyc.Dir, cyc.Effective
	}

	stats := eaip.NewZoneStats()
	navStats := eaip.NewNavaidStats()
	sectionCounts := map[string]int{}
	sectionErrors := map[string]string{}
	h := sha256.New()
	var zones []aixm5.Airspace
	var navaids []aixm5.Navaid

	sections := s.Sections
	if want("navaids") && s.NavaidSection != "" {
		sections = append(append([]string{}, sections...), s.NavaidSection)
	}
	for _, section := range sections {
		url := s.Site.SectionURL(dir, section)
		body, err := s.Site.Get(ctx, url)
		if err != nil {
			// A State that does not publish a section at all is normal;
			// record it and carry on rather than losing the others.
			sectionErrors[section] = err.Error()
			continue
		}
		h.Write(body)
		doc, err := eaip.ParseHTML(body)
		if err != nil {
			sectionErrors[section] = err.Error()
			continue
		}
		if section == s.NavaidSection {
			// The navaid section keeps its count out of the airspace
			// meta's sectionCounts, which reports airspace only.
			navaids = append(navaids, eaip.ParseNavaidTables(doc, strings.ToUpper(s.CC), navStats)...)
			continue
		}
		var got []aixm5.Airspace
		switch s.Layout {
		case ZoneTables:
			got = eaip.ParseZoneTables(doc, section, s.Spec, stats)
		default:
			got = eaip.ParseIcaoZoneTables(doc, section, s.Spec, stats)
		}
		sectionCounts[section] = len(got)
		zones = append(zones, got...)
	}

	if len(sectionErrors) == len(sections) {
		return fmt.Errorf("no section could be read; first error: %s", anyValue(sectionErrors))
	}

	if want("navaids") && s.NavaidSection != "" {
		// A State whose ENR 4.1 is not in the ICAO shape (Poland heads
		// its columns in Polish) must still get its airspace: the navaid
		// table is an addition, not a precondition.
		if err := writeNavaids(s, outDir, target, dir, effective, navaids, navStats, win); err != nil {
			fmt.Fprintf(os.Stderr, "%s: navaids: %v\n", s.CC, err)
		}
	}
	if !want("airspaces") {
		return nil
	}

	msg := aixm5.Message{Airspaces: dedupeZones(zones)}
	artifact, shared, err := aixm5build.BuildAirspaces(&msg, s.Label, nil, effective,
		aixm5build.AirspacesOptions{
			Country:      strings.ToUpper(s.CC),
			Now:          time.Now,
			MinAirspaces: orDefault(win.MinAirspaces, s.MinAirspaces),
			MaxAirspaces: orDefault(win.MaxAirspaces, s.MaxAirspaces),
		})
	if err != nil {
		return err
	}

	meta := airspacesMeta{
		GeneratedAt:    shared.GeneratedAt,
		Source:         s.Label + " eAIP " + dir,
		SourceSha256:   hex.EncodeToString(h.Sum(nil)),
		Effective:      effective,
		AirspaceCount:  shared.AirspaceCount,
		SectionCounts:  sectionCounts,
		Tables:         stats.Tables,
		LimitsSwapped:  stats.LimitsSwapped,
		ClassStacks:    stats.ClassStacks,
		WithRadio:      countRadio(msg.Airspaces),
		PointCircles:   stats.PointCircles,
		PointOnly:      stats.PointOnly,
		FirRings:       stats.FirRings,
		BorderStitched: stats.Boundary.BorderStitched,
		BorderChords:   stats.Boundary.BorderChords,
		Counts:         shared.Counts,
		BBox:           shared.BBox,
		BBoxes:         shared.BBoxes,
	}
	if len(sectionErrors) > 0 {
		meta.SectionErrors = sectionErrors
	}
	if len(stats.SkippedTypes) > 0 {
		meta.SkippedTypes = stats.SkippedTypes
	}

	slot, err := aip.WriteDataset(outDir, s.CC+"-airspaces", target, meta.Effective, artifact, meta)
	if err != nil {
		return err
	}
	fmt.Printf("%s: wrote %d airspaces from %d sections (%s); effective %s; slot=%s\n",
		s.CC, meta.AirspaceCount, len(sectionCounts), sectionSummary(sectionCounts), meta.Effective, slot)
	if len(sectionErrors) > 0 {
		fmt.Printf("%s: %d section(s) unread: %s\n", s.CC, len(sectionErrors), strings.Join(sortedKeys(sectionErrors), ", "))
	}
	return nil
}

// dedupeZones drops a zone republished VERBATIM, which happens where a
// State lists a danger area in both ENR 5.1 and ENR 5.2, and where a
// table's rowspans repeat one row. The geometry is part of the key on
// purpose: several volumes commonly share one id (a CTA in parts, a TMA
// and its sub-areas), and the app addresses those by key rather than id,
// so dropping them would lose real airspace.
func dedupeZones(in []aixm5.Airspace) []aixm5.Airspace {
	seen := map[string]bool{}
	out := make([]aixm5.Airspace, 0, len(in))
	for _, z := range in {
		key := fmt.Sprintf("%s|%s|%v|%v|%v", z.ID, z.Type, z.UpperLimit, z.LowerLimit, z.Ring)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, z)
	}
	return out
}

// countRadio reports how many zones came with a frequency, the counter
// that says whether ENR 2.1's sibling columns were read.
func countRadio(as []aixm5.Airspace) int {
	n := 0
	for _, a := range as {
		if len(a.Radio) > 0 {
			n++
		}
	}
	return n
}

func orDefault(v, def int) int {
	if v != 0 {
		return v
	}
	return def
}

func anyValue(m map[string]string) string {
	for _, k := range sortedKeys(m) {
		return m[k]
	}
	return ""
}

// sortedIntKeys is sortedKeys for the count maps.
func sortedIntKeys(m map[string]int) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func sortedKeys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func sectionSummary(m map[string]int) string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, fmt.Sprintf("%s:%d", strings.TrimPrefix(k, "ENR "), m[k]))
	}
	return strings.Join(parts, " ")
}
