// zones.go is the generic reader for an eAIP's airspace tables.
//
// ENR 2.1, 2.2, 5.1, 5.2, 5.3 and 5.5 all describe volumes the same way,
// whichever State publishes them: a caption naming the zone, a lateral
// limits cell carrying the geometry as prose, a vertical limits cell,
// and some combination of class, hours and restriction. The two LAYOUTS
// that occur are handled here:
//
//   - labelled, where a header cell ("Lateral limits") sits beside its
//     value in the same row;
//   - columnar, where a header row names the columns and the rows below
//     it are the zones.
//
// What a State actually calls its columns, and how it types a zone from
// its section and designator, is the ZoneSpec it passes in. That is the
// per-State work, and it is a table rather than a parser.
//
// Generalised from cmd/be, which read the Belgian eAIP this way first.

package eaip

import (
	"strings"

	"github.com/0intro/loxodrome/internal/aixm5"
)

// ZoneStats counts what a run recognised and what it let go, so a
// changed eAIP shows up as a number rather than as missing airspace.
type ZoneStats struct {
	Boundary     BoundaryStats
	Tables       int
	Zones        int
	MultiRow     int
	FirRings     int
	PointCircles int
	// LimitsSwapped counts the zones whose vertical pair was published
	// lower-first and had to be put the right way up.
	LimitsSwapped int
	// ClassStacks counts the zones published with SEVERAL classes, which
	// the one-letter column cannot express and which are left blank.
	ClassStacks int
	// LimitsUnparsed counts the zones whose vertical text was there but
	// did not read as a pair, and which are left without limits rather
	// than with a guess.
	LimitsUnparsed int
	// PointOnly counts the zones published as a single point and dropped
	// for want of a published area.
	PointOnly int
	// SkippedTypes counts the captions whose type the spec did not
	// resolve, keyed by caption, so an unrecognised family is nameable.
	SkippedTypes map[string]int
}

// NewZoneStats returns stats with its map ready.
func NewZoneStats() *ZoneStats {
	return &ZoneStats{SkippedTypes: map[string]int{}}
}

// ZoneSpec configures the reader for one State's wording.
type ZoneSpec struct {
	// Type resolves the emitted airspace type from the section number,
	// the designator split off the caption and the caption itself.
	// Returning "" skips the table and counts it.
	Type func(section, designator, caption string) string
	// SplitCaption splits a caption into designator and name. Nil keeps
	// the whole caption as the name.
	SplitCaption func(section, caption string) (designator, name string)
	// IDPrefix names a zone whose caption carries no designator, as
	// "<prefix>-<slug>".
	IDPrefix string
	// IcaoPrefix is the State's two-letter ICAO prefix ("EI", "LK"). A
	// designator is only read when it starts with it: without that anchor
	// "NOTA 5700N 01500W" reads as designator NOTA5700N, since the
	// pattern's own letters happen to spell one.
	IcaoPrefix string
	// Border is the FIR ring a bare "the FIR boundary" reference borrows.
	// Nil leaves such a zone without geometry.
	Border *BorderRing
	// PointRadiusM turns a zone published as a single POINT into a circle
	// of this radius. Zero drops it instead, which is the honest reading
	// where a State lists activity SITES rather than volumes: Ireland's
	// ENR 5.5 gives a gliding club a name and one coordinate, and no
	// lateral limit exists to draw. Counted either way.
	PointRadiusM float64
	// Extra header words, beyond the defaults, that identify a column.
	// The defaults already match the EUROCONTROL wording.
	LateralWords, VerticalWords, ClassWords, HoursWords, RemarkWords []string
	// The ENR 2.1 columns beside the combined one: the ATS unit, its
	// call sign and its frequencies.
	UnitWords, CallSignWords, FreqWords []string
}

// ParseZoneTables reads every zone table in a section document.
func ParseZoneTables(doc *Node, section string, spec ZoneSpec, st *ZoneStats) []aixm5.Airspace {
	tables := FindAll(doc, func(n *Node) bool {
		return IsElem(n) && n.Data == "table"
	})
	var out []aixm5.Airspace
	for _, t := range tables {
		caption := NormSpace(TableCaption(t))
		if caption == "" {
			continue
		}
		st.Tables++
		out = append(out, parseZoneTable(t, caption, section, spec, st)...)
	}
	st.Zones = len(out)
	return out
}

func parseZoneTable(table *Node, caption, section string, spec ZoneSpec, st *ZoneStats) []aixm5.Airspace {
	desig, name := "", caption
	if spec.SplitCaption != nil {
		desig, name = spec.SplitCaption(section, caption)
	}
	typ := ""
	if spec.Type != nil {
		typ = spec.Type(section, desig, caption)
	}
	if typ == "" {
		st.SkippedTypes[skipKey(caption)]++
		return nil
	}
	id := desig
	if id == "" {
		id = spec.IDPrefix + "-" + Slug(name)
	}

	// Labelled layout first: a "Lateral limits" header cell whose
	// SAME-ROW value carries the geometry. In the columnar layout the
	// cell right of "Lateral limits" is the next header, which never
	// parses as geometry, so the test settles which layout this is.
	if lat := LabelledPrefix(table, words(spec.LateralWords, "LATERAL LIMITS")); HasGeometry(lat) {
		upper, lower := ParseVerticalPair(LabelledPrefix(table, words(spec.VerticalWords, "VERTICAL LIMITS")))
		st.Zones++
		return []aixm5.Airspace{{
			ID:         id,
			Designator: id,
			Name:       name,
			Type:       typ,
			ClassCode:  ClassLetter(LabelledPrefix(table, words(spec.ClassWords, "AIRSPACE CLASS", "CLASS"))),
			UpperLimit: upper,
			LowerLimit: lower,
			Ring:       ZoneRing(lat, spec, st),
			WorkHr:     LabelledPrefix(table, words(spec.HoursWords, "TIME OF ACTIVITY", "HOURS")),
			Rmk:        LabelledPrefix(table, words(spec.RemarkWords, "TYPE OF RESTRICTION", "REMARKS")),
		}}
	}

	matrix := ExpandTable(table)
	hi := zoneHeaderRow(matrix, words(spec.LateralWords, "LATERAL LIMITS"))
	if hi < 0 {
		return nil
	}
	cols := zoneColumns(matrix[hi], spec)
	var out []aixm5.Airspace
	for ri := hi + 1; ri < len(matrix); ri++ {
		row := matrix[ri]
		if len(row) == 0 || !HasGeometry(cell(row, cols.lateral)) {
			continue
		}
		upper, lower := ParseVerticalPair(cell(row, cols.vertical))
		out = append(out, aixm5.Airspace{
			ID:         id,
			Designator: id,
			Name:       name,
			Type:       typ,
			ClassCode:  ClassLetter(cell(row, cols.class)),
			UpperLimit: upper,
			LowerLimit: lower,
			Ring:       ZoneRing(cell(row, cols.lateral), spec, st),
			WorkHr:     cell(row, cols.hours),
			Rmk:        cell(row, cols.remark),
		})
	}
	if len(out) > 1 {
		st.MultiRow++
	}
	return out
}

// words returns the caller's header words, or the defaults when it gave
// none.
func words(custom []string, defaults ...string) []string {
	if len(custom) > 0 {
		return append(append([]string{}, custom...), defaults...)
	}
	return defaults
}

type zoneCols struct{ lateral, vertical, remark, hours, class, unit, callSign, freq int }

func zoneHeaderRow(matrix [][]string, lateral []string) int {
	for i, row := range matrix {
		if len(row) == 0 {
			continue
		}
		head := strings.ToUpper(strings.TrimSpace(row[0]))
		for _, w := range lateral {
			if strings.HasPrefix(head, w) {
				return i
			}
		}
	}
	return -1
}

func zoneColumns(header []string, spec ZoneSpec) zoneCols {
	cols := zoneCols{-1, -1, -1, -1, -1, -1, -1, -1}
	match := func(h string, ws []string) bool {
		for _, w := range ws {
			if strings.Contains(h, w) {
				return true
			}
		}
		return false
	}
	for i, h := range header {
		hu := strings.ToUpper(h)
		switch {
		case match(hu, words(spec.LateralWords, "LATERAL")):
			cols.lateral = i
		case match(hu, words(spec.VerticalWords, "VERTICAL")):
			cols.vertical = i
		case match(hu, words(spec.RemarkWords, "RESTRICTION", "HAZARD", "ACTIVITY TYPE", "TYPE OF", "REMARK")):
			cols.remark = i
		case match(hu, words(spec.HoursWords, "TIME", "HOURS")):
			cols.hours = i
		case match(hu, words(spec.ClassWords, "CLASS")):
			cols.class = i
		// The ENR 2.1 sibling columns. "UNIT" is tested before the call
		// sign because Slovenia heads one column "Unit providing service"
		// and the next "Call sign", and a State that runs them together
		// must land on the unit.
		case match(hu, words(spec.UnitWords, "UNIT")):
			cols.unit = i
		case match(hu, words(spec.CallSignWords, "CALL SIGN", "CALLSIGN")):
			cols.callSign = i
		case match(hu, words(spec.FreqWords, "FREQ")):
			cols.freq = i
		}
	}
	return cols
}

func cell(row []string, i int) string {
	if i < 0 || i >= len(row) {
		return ""
	}
	return row[i]
}

// HasGeometry reports whether a cell plausibly carries zone geometry: a
// coordinate pair, in either the full or the short minutes-only form.
func HasGeometry(s string) bool {
	s = NormSpace(s)
	return CoordRe.MatchString(s) || SpacedCoordRe.MatchString(s) || ShortCoordRe.MatchString(s)
}

// ZoneRing parses a lateral-limits cell, with the two eAIP special cases
// every State shows: a bare "the FIR boundary" reference borrows the FIR
// ring, and a single published point becomes a circle of the spec's
// point radius, or nothing when the spec sets none.
func ZoneRing(lat string, spec ZoneSpec, st *ZoneStats) [][2]float64 {
	border := spec.Border
	ring := ParseBoundary(lat, border, &st.Boundary)
	if len(ring) == 0 && strings.Contains(strings.ToUpper(lat), "FIR") && border != nil {
		st.FirRings++
		return append([][2]float64(nil), border.Pts...)
	}
	if len(ring) == 0 {
		if pt, ok := ShortCoord(lat); ok {
			ring = [][2]float64{pt}
		}
	}
	if len(ring) >= 1 && len(ring) <= 2 {
		if spec.PointRadiusM <= 0 {
			st.PointOnly++
			return nil
		}
		st.PointCircles++
		return CircleRingAround(ring[0], spec.PointRadiusM)
	}
	return ring
}

// LabelledPrefix returns the value beside a header cell whose text
// starts with any of the given words.
func LabelledPrefix(table *Node, prefixes []string) string {
	for _, tr := range TableRows(table) {
		cells := RowCells(tr)
		if len(cells) < 2 {
			continue
		}
		head := strings.ToUpper(NormSpace(NodeText(cells[0])))
		for _, p := range prefixes {
			if strings.HasPrefix(head, p) {
				return NormSpace(NodeText(cells[1]))
			}
		}
	}
	return ""
}

// ClassLetter reads the ICAO class letter out of a cell.
func ClassLetter(s string) string {
	s = strings.ToUpper(NormSpace(s))
	for _, f := range strings.Fields(s) {
		f = strings.Trim(f, ".,;:()")
		if len(f) == 1 && f >= "A" && f <= "G" {
			return f
		}
	}
	return ""
}

// Slug makes a stable id fragment out of a zone name.
func Slug(s string) string {
	var b strings.Builder
	prevDash := false
	for _, r := range strings.ToUpper(s) {
		switch {
		case r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			b.WriteRune(r)
			prevDash = false
		default:
			if !prevDash && b.Len() > 0 {
				b.WriteByte('-')
				prevDash = true
			}
		}
	}
	return strings.Trim(b.String(), "-")
}

// skipKey keeps the skipped-caption counter readable: the leading words
// of a caption are what name its family.
func skipKey(caption string) string {
	f := strings.Fields(strings.ToUpper(caption))
	if len(f) > 3 {
		f = f[:3]
	}
	return strings.Join(f, " ")
}
