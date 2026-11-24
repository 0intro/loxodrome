package main

// sd_oracle_test.go holds the ENR readers against the structured-data tags
// the packages built from an EAD-SDO database carry (internal/eaip/sd.go):
// the United Kingdom's, and Czechia's and Norway's, which are held and read
// here only from a local snapshot. The tags are a truth the readers never
// see, so every figure they disagree on is either a reader failure or a
// drop the reader makes on purpose (an ATC sector, a Free Route Airspace),
// and the floors below are what the readers score today.
//
//	EAIP_SD=local/ad2snap go test ./cmd/eaip -run SDOracle -v
//
// EAIP_SD is a -snapshot root (<root>/<cc>/<host>/<path>); EAIP_SD_FILL=1
// fetches a page the snapshot lacks, and EAIP_SD_DATE (YYYY-MM-DD, default
// today) picks the cycle the snapshot holds. Four checks, none of which
// needs the tags grouped by zone (Norway tags no names):
//
//   - every tagged vertex lies on a ring the reader drew from that page;
//   - the tagged volumes' (upper, lower) pairs, as a multiset, against the
//     readers' zones' pairs;
//   - the tagged classes against the zones' classes, likewise;
//   - the tagged frequencies against the zones' radios, likewise.

import (
	"context"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/0intro/loxodrome/internal/aixm5"
	"github.com/0intro/loxodrome/internal/eaip"
)

// sdUK is the United Kingdom's eAIP as a State the oracle reads, beside the
// cohort's rows: its data ships from the NATS AIXM (cmd/uk), never from
// these pages.
var sdUK = State{
	CC:    "uk",
	Label: "NATS United Kingdom",
	Site: eaip.Site{
		Country:   "EG",
		Family:    eaip.Eurocontrol,
		Base:      "https://www.aurora.nats.co.uk/htmlAIP/Publications",
		Templates: []string{"{ISO}-AIRAC"},
		Lang:      "en-GB",
		Header:    eaip.BrowserHeaders,
	},
	Sections:      enrSections,
	NavaidSection: navaidSection,
	Layout:        IcaoTables,
	Spec:          eaip.ZoneSpec{Type: sectionType, IDPrefix: "UK", IcaoPrefix: "EG"},
}

// sdFloors are the scores the readers reach today, per State, a little
// under what they measured on the 2026-09-03 packages so the next cycle's
// pages do not trip them: the share of the tagged vertices, arcs, limit
// pairs, classes and frequencies the reader agrees with. A reader change
// that loses ground fails here.
//
// What the rest is, measured: the UK's missing frequencies are the London
// FIR's list of 78, and its unmatched limit pairs the point-only sites of
// ENR 5.5, which the reader leaves out for want of an area. Czechia's
// rest is its ATC sectors and FIR, dropped, the parts of its Z buffer
// zones, the free route airspace's channels, and TMA III PRAHA, whose
// lateral limits are another zone's by reference. Norway's is the ACC
// sectors of ENR 2.2, in a table the unit leads, dropped; the areas whose
// ATS it delegates or takes over, in a table headed "Limits" rather than
// "Lateral limits"; and the HTZs of tangent circles. Both are held States.
//
// Norway's floors rose on 2026-09-24 (limit pairs from 0.47, classes from
// 0.31), when a zone's further volumes, one row apiece, stopped being
// appended to its first.
var sdFloors = map[string]map[string]float64{
	"uk": {"vertices": 0.999, "arcs": 0.99, "limit pairs": 0.93, "classes": 0.99, "frequencies": 0.83},
	"cz": {"vertices": 0.85, "arcs": 0.98, "limit pairs": 0.86, "classes": 0.75, "frequencies": 0.39},
	"no": {"vertices": 0.90, "limit pairs": 0.90, "classes": 0.89, "frequencies": 0.82},
}

// sdScore counts one State's agreement.
type sdScore struct {
	vertices, verticesFound int
	arcs, arcsFound         int
	pairs, pairsFound       int
	classes, classesFound   int
	freqs, freqsFound       int
	samples                 map[string][]string
}

func (s *sdScore) miss(kind, what string) {
	if s.samples == nil {
		s.samples = map[string][]string{}
	}
	if len(s.samples[kind]) < 12 {
		s.samples[kind] = append(s.samples[kind], what)
	}
}

func ratio(a, b int) float64 {
	if b == 0 {
		return 1
	}
	return float64(a) / float64(b)
}

func TestSDOracle(t *testing.T) {
	root := os.Getenv("EAIP_SD")
	if root == "" {
		t.Skip("EAIP_SD unset: point it at a -snapshot root holding uk, cz or no")
	}
	date := time.Now()
	if d := os.Getenv("EAIP_SD_DATE"); d != "" {
		var err error
		if date, err = time.Parse("2006-01-02", d); err != nil {
			t.Fatal(err)
		}
	}
	candidates := []State{sdUK}
	for _, s := range states {
		if s.CC == "cz" || s.CC == "no" {
			candidates = append(candidates, s)
		}
	}
	for _, s := range candidates {
		if _, err := os.Stat(filepath.Join(root, s.CC)); err != nil {
			continue
		}
		t.Run(s.CC, func(t *testing.T) {
			sc := sdState(t, s, root, date)
			t.Logf("%s: vertices %d/%d (%.1f%%), arcs %d/%d (%.1f%%), limit pairs %d/%d (%.1f%%), classes %d/%d (%.1f%%), frequencies %d/%d (%.1f%%)",
				s.CC, sc.verticesFound, sc.vertices, 100*ratio(sc.verticesFound, sc.vertices),
				sc.arcsFound, sc.arcs, 100*ratio(sc.arcsFound, sc.arcs),
				sc.pairsFound, sc.pairs, 100*ratio(sc.pairsFound, sc.pairs),
				sc.classesFound, sc.classes, 100*ratio(sc.classesFound, sc.classes),
				sc.freqsFound, sc.freqs, 100*ratio(sc.freqsFound, sc.freqs))
			kinds := make([]string, 0, len(sc.samples))
			for k := range sc.samples {
				kinds = append(kinds, k)
			}
			sort.Strings(kinds)
			for _, k := range kinds {
				t.Logf("  %s: %s", k, strings.Join(sc.samples[k], "; "))
			}
			for _, c := range []struct {
				name   string
				got, n int
			}{
				{"vertices", sc.verticesFound, sc.vertices},
				{"arcs", sc.arcsFound, sc.arcs},
				{"limit pairs", sc.pairsFound, sc.pairs},
				{"classes", sc.classesFound, sc.classes},
				{"frequencies", sc.freqsFound, sc.freqs},
			} {
				if floor, ok := sdFloors[s.CC][c.name]; ok && ratio(c.got, c.n) < floor {
					t.Errorf("%s %s: %d/%d, below the floor %.3f", s.CC, c.name, c.got, c.n, floor)
				}
			}
		})
	}
}

// sdState reads one State's ENR sections from the snapshot and scores them.
func sdState(t *testing.T, s State, root string, date time.Time) sdScore {
	t.Helper()
	fill := os.Getenv("EAIP_SD_FILL") != ""
	setReplay(&s, filepath.Join(root, s.CC), fill)
	if s.FirIdent != "" {
		border, err := eaip.LoadBorderRing(filepath.Join("..", "..", "public", "data", "pruatlas-firs.json"), s.FirIdent)
		if err != nil {
			t.Logf("%s: border ring: %v", s.CC, err)
		}
		s.Spec.Border = border
	}
	ctx := context.Background()
	cyc, err := s.Site.Resolve(ctx, s.Sections[0], date, false)
	if err != nil {
		t.Fatalf("%s: %v", s.CC, err)
	}
	var sc sdScore
	stats := eaip.NewZoneStats()
	for _, section := range append([]string{s.NavaidSection}, s.Sections...) {
		body, err := s.Site.Get(ctx, s.Site.PageURL(cyc, section))
		if err != nil {
			t.Logf("%s %s: %v", s.CC, section, err)
			continue
		}
		doc, err := eaip.ParseHTML(body)
		if err != nil {
			t.Fatalf("%s %s: %v", s.CC, section, err)
		}
		if section == s.NavaidSection {
			navaids := eaip.ParseNavaidTables(doc, strings.ToUpper(s.CC), eaip.NewNavaidStats())
			s.Spec.Refs = eaip.Refs{Navaid: navaidRefs(navaids)}
			continue
		}
		var zones []aixm5.Airspace
		switch s.Layout {
		case ZoneTables:
			zones = eaip.ParseZoneTables(doc, section, s.Spec, stats)
		default:
			zones = eaip.ParseIcaoZoneTables(doc, section, s.Spec, stats)
		}
		tags := eaip.SDTags(doc)
		var ss sdScore
		sdCompare(&ss, section, tags, zones)
		t.Logf("%s %s: %d zones; vertices %d/%d, arcs %d/%d, limit pairs %d/%d, classes %d/%d, frequencies %d/%d",
			s.CC, section, len(zones), ss.verticesFound, ss.vertices, ss.arcsFound, ss.arcs, ss.pairsFound, ss.pairs,
			ss.classesFound, ss.classes, ss.freqsFound, ss.freqs)
		sc.add(ss)
		if os.Getenv("EAIP_SD_DUMP") == s.CC+":"+section {
			sdDump(t, tags, zones)
		}
	}
	return sc
}

// add folds a section's score into the State's.
func (s *sdScore) add(o sdScore) {
	s.vertices += o.vertices
	s.verticesFound += o.verticesFound
	s.arcs += o.arcs
	s.arcsFound += o.arcsFound
	s.pairs += o.pairs
	s.pairsFound += o.pairsFound
	s.classes += o.classes
	s.classesFound += o.classesFound
	s.freqs += o.freqs
	s.freqsFound += o.freqsFound
	for k, v := range o.samples {
		for _, x := range v {
			s.miss(k, x)
		}
	}
}

// sdDump prints a section's tagged volumes beside the zones read from
// it, for EAIP_SD_DUMP=<cc>:<section>.
func sdDump(t *testing.T, tags []eaip.SDValue, zones []aixm5.Airspace) {
	t.Helper()
	name := ""
	for _, v := range tags {
		switch {
		case v.Table == "TAIRSPACE" && v.Column == "TXT_NAME":
			name = v.Value
		case v.Table == "TAIRSPACE_VOLUME" && v.Column == "VAL_DIST_VER_UPPER":
			t.Logf("  tag  %-40s %s", name, v.Value)
		}
	}
	vols, order := sdRecords(tags, "TAIRSPACE_VOLUME")
	for _, rec := range order {
		v := vols[rec]
		t.Logf("  pair %s %s/%s", rec,
			sdLimitKey(v["VAL_DIST_VER_UPPER"], v["UOM_DIST_VER_UPPER"], v["CODE_DIST_VER_UPPER"]),
			sdLimitKey(v["VAL_DIST_VER_LOWER"], v["UOM_DIST_VER_LOWER"], v["CODE_DIST_VER_LOWER"]))
	}
	for _, z := range zones {
		t.Logf("  read %-40s %-8s %s/%s class %q, %d vertices", z.Name, z.Type,
			readerLimitKey(z.UpperLimit), readerLimitKey(z.LowerLimit), z.ClassCode, len(z.Ring))
	}
}

// sdRecords groups the tags of one table by record, column by column.
func sdRecords(tags []eaip.SDValue, table string) (map[string]map[string]string, []string) {
	recs := map[string]map[string]string{}
	var order []string
	for _, v := range tags {
		if v.Table != table {
			continue
		}
		r := recs[v.Record]
		if r == nil {
			r = map[string]string{}
			recs[v.Record] = r
			order = append(order, v.Record)
		}
		if _, ok := r[v.Column]; !ok {
			r[v.Column] = v.Value
		}
	}
	return recs, order
}

// sdCompare scores one section's tags against the zones read from it.
func sdCompare(sc *sdScore, section string, tags []eaip.SDValue, zones []aixm5.Airspace) {
	// Vertices: each tagged one must lie on a ring read from the page.
	grid := map[[2]int][][2]float64{}
	cellOf := func(lat, lon float64) [2]int { return [2]int{int(math.Floor(lat * 50)), int(math.Floor(lon * 50))} }
	for _, z := range zones {
		for _, p := range z.Ring {
			c := cellOf(p[0], p[1])
			grid[c] = append(grid[c], p)
		}
	}
	near := func(lat, lon float64) bool {
		c := cellOf(lat, lon)
		for di := -1; di <= 1; di++ {
			for dj := -1; dj <= 1; dj++ {
				for _, p := range grid[[2]int{c[0] + di, c[1] + dj}] {
					if metresApart(lat, lon, p[0], p[1]) <= 50 {
						return true
					}
				}
			}
		}
		return false
	}
	verts, order := sdRecords(tags, "TAIRSPACE_VERTEX")
	lone := loneVertices(tags)
	for _, rec := range order {
		v := verts[rec]
		if c, r, ok := sdArc(v); ok {
			sc.arcs++
			if onArc(zones, c, r) {
				sc.arcsFound++
			} else {
				sc.miss("arc missing", fmt.Sprintf("%s %s %s r %s %s", section, v["GEO_LAT_ARC"], v["GEO_LONG_ARC"], v["VAL_RADIUS_ARC"], v["UOM_RADIUS_ARC"]))
			}
		}
		latS, lonS := v["GEO_LAT"], v["GEO_LONG"]
		if latS == "" || lonS == "" || lone[rec] {
			continue
		}
		lat, lon, ok := eaip.ParsePair(latS, lonS)
		if !ok {
			sc.miss("vertex unreadable", section+" "+latS+" "+lonS)
			continue
		}
		sc.vertices++
		if near(lat, lon) {
			sc.verticesFound++
		} else {
			sc.miss("vertex missing", section+" "+latS+" "+lonS)
		}
	}

	// Limit pairs, as multisets.
	have := map[string]int{}
	for _, z := range zones {
		have[readerLimitKey(z.UpperLimit)+"/"+readerLimitKey(z.LowerLimit)]++
	}
	vols, order := sdRecords(tags, "TAIRSPACE_VOLUME")
	for _, rec := range order {
		v := vols[rec]
		up := sdLimitKey(v["VAL_DIST_VER_UPPER"], v["UOM_DIST_VER_UPPER"], v["CODE_DIST_VER_UPPER"])
		lo := sdLimitKey(v["VAL_DIST_VER_LOWER"], v["UOM_DIST_VER_LOWER"], v["CODE_DIST_VER_LOWER"])
		if up == "" && lo == "" {
			continue
		}
		sc.pairs++
		k := up + "/" + lo
		if have[k] > 0 {
			have[k]--
			sc.pairsFound++
		} else {
			sc.miss("limit pair missing", section+" "+k)
		}
	}
	for k, n := range have {
		for ; n > 0; n-- {
			sc.miss("limit pair read only", section+" "+k)
		}
	}

	// Classes, likewise.
	classes := map[string]int{}
	for _, z := range zones {
		if z.ClassCode != "" {
			classes[z.ClassCode]++
		}
	}
	cls, order := sdRecords(tags, "TAIRSPACE_LAYER_CLASS")
	for _, rec := range order {
		c := strings.TrimSpace(cls[rec]["CODE_CLASS"])
		if c == "" {
			continue
		}
		sc.classes++
		if classes[c] > 0 {
			classes[c]--
			sc.classesFound++
		} else {
			sc.miss("class missing", section+" "+c)
		}
	}

	// Frequencies, likewise.
	freqs := map[string]int{}
	for _, z := range zones {
		for _, r := range z.Radio {
			if f, ok := freqKey(r.Freq); ok {
				freqs[f]++
			}
		}
	}
	fr, order := sdRecords(tags, "TFREQUENCY")
	for _, rec := range order {
		f, ok := freqKey(fr[rec]["VAL_FREQ_TRANS"])
		if !ok {
			continue
		}
		sc.freqs++
		if freqs[f] > 0 {
			freqs[f]--
			sc.freqsFound++
		} else {
			sc.miss("frequency missing", section+" "+f)
		}
	}
}

// loneVertices are the vertices that are a named site's only point and no
// arc's: the reader drops a point with no area (ZoneStats.PointOnly), so
// they are not held against it. A page that tags no names is one run.
func loneVertices(tags []eaip.SDValue) map[string]bool {
	lone := map[string]bool{}
	var run []string
	arc := false
	flush := func() {
		if len(run) == 1 && !arc {
			lone[run[0]] = true
		}
		run, arc = nil, false
	}
	seen := map[string]bool{}
	for _, v := range tags {
		switch {
		case v.Table == "TAIRSPACE" && v.Column == "TXT_NAME":
			flush()
			seen = map[string]bool{}
		case v.Table == "TAIRSPACE_VERTEX":
			if strings.Contains(v.Column, "ARC") {
				arc = true
			} else if !seen[v.Record] {
				seen[v.Record] = true
				run = append(run, v.Record)
			}
		}
	}
	flush()
	return lone
}

// sdArc reads a tagged arc or circle: its centre and its radius in metres.
func sdArc(v map[string]string) ([2]float64, float64, bool) {
	lat, lon, ok := eaip.ParsePair(v["GEO_LAT_ARC"], v["GEO_LONG_ARC"])
	if !ok {
		return [2]float64{}, 0, false
	}
	r, err := strconv.ParseFloat(strings.TrimSpace(v["VAL_RADIUS_ARC"]), 64)
	if err != nil || r <= 0 {
		return [2]float64{}, 0, false
	}
	switch strings.ToUpper(strings.TrimSpace(v["UOM_RADIUS_ARC"])) {
	case "NM":
		r *= 1852
	case "KM":
		r *= 1000
	case "M":
	default:
		return [2]float64{}, 0, false
	}
	return [2]float64{lat, lon}, r, true
}

// onArc reports whether some ring read from the page runs along the arc:
// a point of it at the radius from the centre, within 2 percent or 50 m.
func onArc(zones []aixm5.Airspace, c [2]float64, r float64) bool {
	tol := math.Max(50, r*0.02)
	for _, z := range zones {
		for _, p := range z.Ring {
			if math.Abs(metresApart(c[0], c[1], p[0], p[1])-r) <= tol {
				return true
			}
		}
	}
	return false
}

// sdLimitKey spells a tagged limit the way readerLimitKey spells a read
// one: "FL195", "2500MSL", "1000SFC", "SFC", "UNL".
func sdLimitKey(val, uom, code string) string {
	val = strings.ToUpper(strings.TrimSpace(val))
	switch val {
	case "":
		return ""
	case "GND", "SFC", "MSL":
		// A floor at MSL, as Avinor tags its sea areas' ("Lower limit:
		// MSL"), is 0 ft above sea level, which the reader keeps and the
		// key spells like any zero.
		return "SFC"
	case "UNL", "UNLIMITED":
		return "UNL"
	}
	n, err := strconv.ParseFloat(strings.ReplaceAll(val, " ", ""), 64)
	if err != nil {
		return "?" + val
	}
	switch strings.ToUpper(strings.TrimSpace(uom)) {
	case "FL":
		return fmt.Sprintf("FL%d", int(math.Round(n)))
	case "M":
		n /= eaip.FtPerM
	}
	if n == 0 {
		return "SFC"
	}
	ref := "MSL"
	switch strings.ToUpper(strings.TrimSpace(code)) {
	case "HEI", "AGL", "SFC", "ASFC":
		ref = "SFC"
	}
	return fmt.Sprintf("%d%s", int(math.Round(n)), ref)
}

// readerLimitKey spells a read limit for the comparison.
func readerLimitKey(v *aixm5.VerticalLimit) string {
	if v == nil {
		return ""
	}
	switch v.Value {
	case "GND", "SFC":
		return "SFC"
	case "UNL":
		return "UNL"
	}
	n, err := strconv.ParseFloat(v.Value, 64)
	if err != nil {
		return "?" + v.Value
	}
	switch v.Unit {
	case "FL":
		return fmt.Sprintf("FL%d", int(math.Round(n)))
	case "M":
		n /= eaip.FtPerM
	}
	if n == 0 {
		return "SFC"
	}
	ref := "MSL"
	if v.Ref == "SFC" {
		ref = "SFC"
	}
	return fmt.Sprintf("%d%s", int(math.Round(n)), ref)
}

// freqKey spells a frequency of the VHF COM band to three decimals: the
// readers keep that band alone, the one a civil pilot can set.
func freqKey(s string) (string, bool) {
	fields := strings.Fields(s)
	if len(fields) == 0 {
		return "", false
	}
	f, err := strconv.ParseFloat(fields[0], 64)
	if err != nil || f < 118 || f >= 137 {
		return "", false
	}
	return strconv.FormatFloat(f, 'f', 3, 64), true
}

// metresApart is a short distance on the sphere.
func metresApart(lat1, lon1, lat2, lon2 float64) float64 {
	const r = 6371008.8
	p1, p2 := lat1*math.Pi/180, lat2*math.Pi/180
	dp, dl := p2-p1, (lon2-lon1)*math.Pi/180
	a := math.Sin(dp/2)*math.Sin(dp/2) + math.Cos(p1)*math.Cos(p2)*math.Sin(dl/2)*math.Sin(dl/2)
	return 2 * r * math.Asin(math.Min(1, math.Sqrt(a)))
}
