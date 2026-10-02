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
	"errors"
	"flag"
	"fmt"
	"math"
	"os"
	"path/filepath"
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
	only := flag.String("only", "", `comma-separated dataset filter ("airspaces", "navaids", "airports", "facilities", "adcharts"); empty means all`)
	list := flag.Bool("list", false, "list the cohort and exit")
	snapshot := flag.String("snapshot", "", "also write every fetched page under this directory, per State (<dir>/<cc>/<host>/<path>)")
	replay := flag.String("replay", "", "read every page from a -snapshot directory instead of the network")
	fill := flag.Bool("fill", false, "with -replay, fetch a page the snapshot lacks and add it")
	var win aip.SanityWindows
	win.Register(flag.CommandLine)
	flag.Parse()
	if *snapshot != "" && *replay != "" {
		return fmt.Errorf("-snapshot and -replay exclude each other")
	}
	if *snapshot != "" {
		for i := range states {
			setSnapshot(&states[i], filepath.Join(*snapshot, states[i].CC))
		}
	}
	if *replay != "" {
		for i := range states {
			setReplay(&states[i], filepath.Join(*replay, states[i].CC), *fill)
		}
	}

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
		want := aip.DatasetFilter(*only)
		for i := range states {
			w := want
			if states[i].ChartsOnly && !want("adcharts") {
				continue
			}
			if states[i].Consent != "" {
				if !want("adcharts") {
					fmt.Fprintf(os.Stderr, "%s: skipped, %s\n", states[i].CC, states[i].Consent)
					continue
				}
				// A held State's data stays out, but its chart index is
				// links to the publisher's own files, which copies nothing
				// (docs/aip-sources.md, "Chart links are not copies").
				fmt.Fprintf(os.Stderr, "%s: chart links only, %s\n", states[i].CC, states[i].Consent)
				w = func(name string) bool { return name == "adcharts" }
			}
			if err := build(ctx, &states[i], *outDir, *target, *cycleDir, *firs, w, win); err != nil {
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
	GeneratedAt  string `json:"generatedAt"`
	Source       string `json:"source"`
	SourceSha256 string `json:"sourceSha256"`
	Effective    string `json:"effective"`
	resolution
	AirspaceCount int `json:"airspaceCount"`
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
	// ArcsUnread counts the zones whose arc or circle no pattern read,
	// sampled in UnreadArcs.
	ArcsUnread int      `json:"arcsUnread"`
	UnreadArcs []string `json:"unreadArcs,omitempty"`
	// ArcSensesInferred counts the rings an arc of unstated sense closes
	// only the long way round.
	ArcSensesInferred int `json:"arcSensesInferred,omitempty"`
	// ClippedToFIR counts the rings cut back at the State's own FIR
	// ("except where inside SOFIA FIR"), ClippedAway those the cut left
	// empty and ClipRefused those it could not take, kept whole.
	ClippedToFIR int `json:"clippedToFir,omitempty"`
	ClippedAway  int `json:"clippedAway,omitempty"`
	ClipRefused  int `json:"clipRefused,omitempty"`
	// ADZones counts the zones the aerodrome pages publish for themselves
	// (AD 2.17, AD 3.16); ADRepublished those an ENR section already
	// carries, left out; ADInferredCTR those taken for the control zone
	// they are though their section names no kind.
	ADZones       int `json:"adZones"`
	ADRepublished int `json:"adRepublished"`
	ADInferredCTR int `json:"adInferredCtr"`
	// RefsResolved counts the centres named by an aerodrome's ARP or a
	// radio aid that the package's own pages placed.
	RefsResolved int `json:"refsResolved"`
	// BufferColumns counts the areas published with a flight-plan buffer
	// ring beside their own, which is left out.
	BufferColumns int `json:"bufferColumns"`
	// Aggregates counts the zones dropped as the outline of parts listed
	// beside them, which carry the limits.
	Aggregates int `json:"aggregates,omitempty"`
	// LimitsTextual counts the limits stated in words ("Lower limit of ATS
	// routes"), left unknown and kept with the remarks.
	LimitsTextual int `json:"limitsTextual,omitempty"`
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
	if s.ChartsOnly {
		// Its airspace is another command's; only the chart index is read.
		if !want("adcharts") {
			fmt.Printf("%s: %s; nothing else to build\n", s.CC, s.Note)
			return nil
		}
		want = func(name string) bool { return name == "adcharts" }
	}
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

	cyc := eaip.Cycle{Dir: cycleDir}
	if cycleDir == "" {
		// The package is located by probing the AIRAC grid (or the State's
		// own index), confirmed by reading the first section (a directory
		// that exists but is not yet populated must not be taken for a
		// published cycle), and judged against what the publisher states
		// is in force, so a package that moved fails here instead of the
		// previous cycle shipping as current.
		var err error
		cyc, err = s.Site.Resolve(ctx, s.Sections[0], time.Now(), target == "next")
		if err != nil {
			return err
		}
		if cyc.Dir == "" && cyc.Effective == "" && target == "next" {
			fmt.Printf("%s: no pre-release package published; nothing written\n", s.CC)
			return nil
		}
		if cyc.PointerErr != "" {
			fmt.Fprintf(os.Stderr, "%s: warning: the publisher's pointer could not be read: %s\n", s.CC, cyc.PointerErr)
		}
		if cyc.Lag > 0 && !cyc.Confirmed {
			fmt.Fprintf(os.Stderr, "%s: warning: %q is %d cycle(s) behind the AIRAC cycle in force and nothing confirms it; the build fails once the grace ends\n",
				s.CC, cyc.Dir, cyc.Lag)
		}
	}
	dir, effective := cyc.Dir, cyc.Effective
	if dir == "" && cyc.Base != "" {
		// A fixed forthcoming package is named by its own base.
		dir = cyc.Base
	}
	resolved := resolution{
		CycleLag:   cyc.Lag,
		Confirmed:  cyc.Confirmed,
		ResolvedBy: cyc.ResolvedBy,
		Lang:       cyc.Lang,
	}
	enr := want("airspaces") || want("navaids") || (want("obstacles") && s.ObstacleSection != "")
	var pass *adPass
	if want("adcharts") || want("airports") || want("facilities") || want("airspaces") || want("navaids") {
		// One pass over the aerodrome pages serves the chart index, the
		// aerodromes and the airspace each aerodrome publishes for itself
		// (AD 2.17); each is an addition to the ENR airspace, never a
		// precondition of it.
		var err error
		pass, err = readAerodromePages(ctx, s, cyc, target, want("adcharts"))
		switch {
		case err != nil && !enr:
			return err
		case err != nil:
			fmt.Fprintf(os.Stderr, "%s: aerodrome pages: %v\n", s.CC, err)
			pass = nil
		default:
			var errs []error
			if want("adcharts") {
				if err := writeAdCharts(ctx, s, pass, cyc, dir, effective, resolved, outDir, target); err != nil {
					errs = append(errs, fmt.Errorf("adcharts: %w", err))
				}
			}
			if want("airports") {
				if err := writeAirports(s, pass, dir, effective, resolved, outDir, target, win); err != nil {
					errs = append(errs, fmt.Errorf("airports: %w", err))
				}
			}
			if want("facilities") {
				if err := writeFacilities(s, pass, dir, effective, outDir, target); err != nil {
					errs = append(errs, fmt.Errorf("facilities: %w", err))
				}
			}
			if len(errs) > 0 {
				if !enr {
					return errors.Join(errs...)
				}
				fmt.Fprintf(os.Stderr, "%s: %v\n", s.CC, errors.Join(errs...))
			}
		}
	}
	if !enr {
		return nil
	}

	stats := eaip.NewZoneStats()
	navStats := eaip.NewNavaidStats()
	sectionCounts := map[string]int{}
	sectionErrors := map[string]string{}
	h := sha256.New()
	var zones []aixm5.Airspace
	var navaids []aixm5.Navaid
	var obstacles []aixm5.Obstacle

	// The navaid section is read first, when there is one: its radio aids
	// are where a limit "centred on VOR/DME COK" is, and the airspace
	// needs them before it reads.
	sections := s.Sections
	if (want("navaids") || want("airspaces")) && s.NavaidSection != "" {
		sections = append([]string{s.NavaidSection}, sections...)
	}
	if want("navaids") {
		sections = append(sections, pointSection)
	}
	if want("obstacles") && s.ObstacleSection != "" {
		sections = append(sections, s.ObstacleSection)
	}
	refs := eaip.Refs{ARP: aerodromeRefs(pass)}
	s.Spec.Refs = refs
	for _, section := range sections {
		url := s.Site.PageURL(cyc, section)
		body, err := s.Site.Get(ctx, url)
		if err != nil {
			// A State that does not publish a section at all is normal;
			// record it and carry on rather than losing the others.
			sectionErrors[section] = err.Error()
			continue
		}
		h.Write(body)
		if cyc.FromPages {
			// A fixed-path package names its effective date only on its
			// pages, and a section the latest amendment left alone keeps
			// an older one, so the package's date is the latest read.
			if e := eaip.PageEffective(body); e != "" && e+"T00:00:00.000Z" > effective {
				effective = e + "T00:00:00.000Z"
			}
		}
		doc, err := eaip.ParseHTML(body)
		if err != nil {
			sectionErrors[section] = err.Error()
			continue
		}
		if section == s.NavaidSection {
			// The navaid section keeps its count out of the airspace
			// meta's sectionCounts, which reports airspace only.
			navaids = append(navaids, eaip.ParseNavaidTables(doc, strings.ToUpper(s.CC), navStats)...)
			refs.Navaid = navaidRefs(navaids)
			s.Spec.Refs = refs
			continue
		}
		if section == pointSection {
			navaids = append(navaids, eaip.ParsePointTables(doc, navStats)...)
			continue
		}
		if section == s.ObstacleSection {
			obstacles = append(obstacles, eaip.ParseObstacleTables(doc)...)
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

	if want("navaids") {
		// The visual reporting points the aerodrome pages list join the
		// radio aids and the significant points.
		if pass != nil {
			for _, pg := range pass.pages {
				navaids = append(navaids, pg.points...)
			}
		}
		// A State whose ENR 4.1 is not in the ICAO shape (Poland heads
		// its columns in Polish) must still get its airspace: the navaid
		// table is an addition, not a precondition.
		if err := writeNavaids(s, outDir, target, dir, effective, resolved, navaids, navStats, win); err != nil {
			fmt.Fprintf(os.Stderr, "%s: navaids: %v\n", s.CC, err)
		}
	}
	obstacleSource := "eAIP " + dir + " " + s.ObstacleSection
	if want("obstacles") && s.Register != nil {
		// The register stands in for ENR 5.4, the edition in force on the
		// slot's day read.
		day, err := time.Parse("2006-01-02", effective[:min(len(effective), 10)])
		if err != nil {
			day = time.Now()
		}
		if got, source, err := s.Register.read(ctx, s, day); err != nil {
			fmt.Fprintf(os.Stderr, "%s: obstacle register: %v\n", s.CC, err)
		} else {
			obstacles, obstacleSource = got, source
		}
	}
	if want("obstacles") && s.ObstacleSection != "" {
		if err := writeObstacles(s, outDir, target, obstacleSource, effective, resolved, obstacles, win); err != nil {
			fmt.Fprintf(os.Stderr, "%s: obstacles: %v\n", s.CC, err)
		}
	}
	if !want("airspaces") {
		return nil
	}

	// The airspace the aerodrome pages publish for themselves joins the
	// ENR's, less what an ENR section already publishes.
	var adZones []aixm5.Airspace
	if pass != nil {
		for _, pg := range pass.pages {
			adZones = append(adZones, pg.zones...)
			if pg.zstats != nil {
				stats.Add(pg.zstats)
			}
		}
	}
	adKept, republished := eaip.DropRepublished(zones, adZones)
	if pass != nil {
		sectionCounts["AD 2.17"] = len(adKept)
	}
	zones = append(zones, adKept...)

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
		GeneratedAt:       shared.GeneratedAt,
		Source:            s.Label + " eAIP " + dir,
		SourceSha256:      hex.EncodeToString(h.Sum(nil)),
		Effective:         effective,
		resolution:        resolved,
		AirspaceCount:     shared.AirspaceCount,
		SectionCounts:     sectionCounts,
		Tables:            stats.Tables,
		LimitsSwapped:     stats.LimitsSwapped,
		ClassStacks:       stats.ClassStacks,
		WithRadio:         countRadio(msg.Airspaces),
		PointCircles:      stats.PointCircles,
		PointOnly:         stats.PointOnly,
		FirRings:          stats.FirRings,
		BorderStitched:    stats.Boundary.BorderStitched,
		BorderChords:      stats.Boundary.BorderChords,
		ArcsUnread:        stats.Boundary.ArcsUnread,
		ArcSensesInferred: stats.Boundary.ArcSensesInferred,
		ClippedToFIR:      stats.Boundary.ClippedToFIR,
		ClippedAway:       stats.Boundary.ClippedAway,
		ClipRefused:       stats.Boundary.ClipRefused,
		UnreadArcs:        stats.UnreadArcs,
		ADZones:           len(adZones),
		ADRepublished:     republished,
		ADInferredCTR:     stats.ADInferredCTR,
		RefsResolved:      stats.RefsResolved,
		BufferColumns:     stats.BufferColumns,
		Aggregates:        stats.Aggregates,
		LimitsTextual:     stats.LimitsTextual,
		Counts:            shared.Counts,
		BBox:              shared.BBox,
		BBoxes:            shared.BBoxes,
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

// resolution is how the package was found, which every meta carries so a
// State reading an older package than the cycle in force says why it is
// right (confirmed by the publisher) or that it is not yet known.
type resolution struct {
	// CycleLag is how many AIRAC cycles the package trailed the cycle in
	// force when it was read; 0 when current.
	CycleLag int `json:"cycleLag"`
	// Confirmed says the publisher's own index or pointer names the
	// package as the one in force.
	Confirmed bool `json:"confirmed"`
	// ResolvedBy says how the package was located.
	ResolvedBy string `json:"resolvedBy,omitempty"`
	// Lang is the language suffix the package's section files carry.
	Lang string `json:"lang,omitempty"`
}

// aerodromeRefs is where the pass's aerodromes are, by location
// indicator, for a limit centred on one's ARP.
func aerodromeRefs(pass *adPass) map[string][2]float64 {
	if pass == nil {
		return nil
	}
	out := map[string][2]float64{}
	for _, pg := range pass.pages {
		if pg.airport != nil {
			out[pg.airport.Designator] = [2]float64{pg.airport.Lat, pg.airport.Lon}
		}
	}
	return out
}

// navaidRefs is where the radio aids are, by identifier; one identifier
// at two places (a VOR and an NDB sharing letters far apart) names
// neither.
func navaidRefs(navaids []aixm5.Navaid) map[string][2]float64 {
	out := map[string][2]float64{}
	bad := map[string]bool{}
	for _, n := range navaids {
		p := [2]float64{n.Lat, n.Lon}
		if q, ok := out[n.Designator]; ok && math.Abs(q[0]-p[0])+math.Abs(q[1]-p[1]) > 0.01 {
			bad[n.Designator] = true
		}
		out[n.Designator] = p
	}
	for d := range bad {
		delete(out, d)
	}
	return out
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

// setSnapshot points a State's sites, its own and the further packages
// its chart index reads, at a snapshot directory.
func setSnapshot(s *State, dir string) {
	s.Site.Snapshot = dir
	for _, p := range s.ChartSites {
		if site := p.site(); site != nil {
			site.Snapshot = dir
		}
	}
}

// setReplay reads a State's sites back from a snapshot directory, filling
// in what it lacks from the network when fill is set.
func setReplay(s *State, dir string, fill bool) {
	s.Site.Replay, s.Site.Fill = dir, fill
	for _, p := range s.ChartSites {
		if site := p.site(); site != nil {
			site.Replay, site.Fill = dir, fill
		}
	}
}
