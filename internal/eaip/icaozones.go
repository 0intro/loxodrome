// icaozones.go reads the ICAO-layout airspace tables.
//
// This is the layout most States publish ENR 5.1, 5.2, 5.3 and 5.5 in,
// and it is quite different from the per-zone tables cmd/be found in the
// Belgian eAIP. Here one TABLE holds every zone of a family, one ROW per
// zone, in the three columns ICAO Annex 15 Appendix 1 prescribes:
//
//	| Identification, Name and Lateral limits | Upper / Lower limit | Remarks |
//	| LHP1 / PAKS  A circle radius 3 KM ...   | FL 195 / GND        | H24 ... |
//	| LPP2 PINHAL DO ARNEIRO  383435N 0090... | 2000FT AMSL GND     | H24 MIL |
//
// So the designator, the name and the geometry all share one cell, and
// both vertical limits share the next. Splitting those two cells is the
// whole job, and it is the same job in every State: the wording of the
// headers differs, the shape does not.

package eaip

import (
	"regexp"
	"strings"
	"sync"

	"github.com/0intro/loxodrome/internal/aixm5"
)

// icaoHeadWords recognise the first column of an ICAO zone table. States
// word it "Identification, Name and Lateral limits" (Hungary), "Name
// Lateral limits" (Portugal), "Identification and lateral limits", and
// so on; the two invariants are the word "lateral" and its position.
var icaoHeadWords = []string{"LATERAL", "IDENTIFICATION", "NAME"}

// geometryLeadRe finds where the geometry starts inside the first cell:
// either a coordinate, or one of the phrases a circle is described with.
// Everything before it is the identification and the name.
var geometryLeadRe = regexp.MustCompile(`(?i)\b(\d{6}(?:\.\d+)?[NS]|\d{4}[NS]\s+\d{5}[EW]|A circle|Circle|An arc|Area bounded|Bounded by|The area|A line joining)`)

// designatorRe recognises the leading designator of a zone: the State's
// two-letter ICAO prefix, the family letter, and a number. The prefix is
// the State's own where it gave one, since a generic two-letter class
// would read "NOTA 5700N 01500W" (the North Oceanic Transition Area,
// followed by its first coordinate) as a designator.
var designatorRe = regexp.MustCompile(`^([A-Z]{2}\s?[PRDTA][A-Z]*\s?\d+[A-Z]*)`)

// designatorFor returns the designator pattern for one State, cached.
var designatorCache sync.Map // prefix -> *regexp.Regexp

func designatorFor(icaoPrefix string) *regexp.Regexp {
	if icaoPrefix == "" {
		return designatorRe
	}
	if re, ok := designatorCache.Load(icaoPrefix); ok {
		return re.(*regexp.Regexp)
	}
	re := regexp.MustCompile(`^(` + regexp.QuoteMeta(icaoPrefix) + `\s?[PRDTA][A-Z]*\s?\d+[A-Z]*)`)
	designatorCache.Store(icaoPrefix, re)
	return re
}

// ParseIcaoZoneTables reads every ICAO-layout zone table in a section.
//
// spec.Type is called with the section, the designator split off the
// row, and the row's name, exactly as for the per-zone layout, so a
// State can share one type resolver across both.
func ParseIcaoZoneTables(doc *Node, section string, spec ZoneSpec, st *ZoneStats) []aixm5.Airspace {
	// Headings are collected with the tables, in document order, because a
	// State may give each zone its own table and name it in the heading
	// above ("3. BANJA LUKA TMA"), leaving the rows themselves nameless.
	nodes := FindAll(doc, func(n *Node) bool {
		return IsElem(n) && (n.Data == "table" || isHeadingTag(n.Data))
	})
	var out []aixm5.Airspace
	heading := ""
	for _, n := range nodes {
		if isHeadingTag(n.Data) {
			heading = cleanHeading(NodeText(n))
			continue
		}
		matrix := ExpandTable(n)
		hi, lat0, combined := icaoHeaderRow(matrix)
		if hi < 0 {
			continue
		}
		st.Tables++
		if combined {
			out = append(out, parseCombinedTable(matrix, hi, section, heading, spec, st)...)
			continue
		}
		out = append(out, parseColumnarTable(matrix, hi, lat0, section, spec, st)...)
	}
	st.Zones += len(out)
	return out
}

func isHeadingTag(tag string) bool {
	return len(tag) == 2 && tag[0] == 'h' && tag[1] >= '1' && tag[1] <= '6'
}

// headingNumberRe strips the ordinal an eAIP numbers its headings with
// ("3. BANJA LUKA TMA", "ENR 2.1.4 MOSTAR TMA").
var headingNumberRe = regexp.MustCompile(`^(?:[A-Z]{3}\s+)?[\d.]+\.?\s+`)

func cleanHeading(s string) string {
	return strings.TrimSpace(headingNumberRe.ReplaceAllString(NormSpace(strings.TrimSpace(s)), ""))
}

// parseColumnarTable reads the layout where the lateral-limits column
// carries the identification and the geometry, and the columns to its
// right carry the vertical limits and the remarks: ICAO's ENR 5 tables,
// and Hungary's ENR 2.2.
func parseColumnarTable(matrix [][]string, hi, lat0 int, section string, spec ZoneSpec, st *ZoneStats) []aixm5.Airspace {
	var out []aixm5.Airspace
	// A State may put the name on one row and the geometry on the
	// next, the columns beside them spanning both. A geometry-only row
	// therefore continues the row above it rather than being nameless.
	prevDesig, prevName := "", ""
	for ri := hi + 1; ri < len(matrix); ri++ {
		row := matrix[ri]
		if len(row) == 0 {
			continue
		}
		// The row under the header is the column-number legend
		// ("1", "2", "3") that ICAO prints; it carries no geometry
		// and falls out on the test below.
		head := cell(row, lat0)
		if !HasGeometry(head) && !hasCircleWords(head) {
			// Remember a name-only row for the geometry row under it.
			if lat0 == 0 {
				if d, n, lateral := splitIcaoHead(head, spec.IcaoPrefix); lateral == "" && n != "" {
					prevDesig, prevName = d, n
				}
			}
			continue
		}
		var desig, name, lateral string
		if lat0 == 0 {
			desig, name, lateral = splitIcaoHead(head, spec.IcaoPrefix)
		} else {
			// The identification is the column immediately left of the
			// limits: Poland's ENR 5.5 opens with a serial number
			// column ("Lp.") that is not the designator, and the
			// left-neighbour rule reads both its tables right.
			desig, name = splitDesignator(cell(row, lat0-1), spec.IcaoPrefix)
			lateral = head
		}
		if name == "" && desig == "" {
			desig, name = prevDesig, prevName
		}
		if name == "" && desig == "" {
			st.SkippedTypes["NO NAME"]++
			continue
		}
		prevDesig, prevName = desig, name
		typ := zoneType(section, desig, name, spec, st)
		if typ == "" {
			continue
		}
		ring, ok := zoneRingOf(lateral, spec, st)
		if !ok {
			continue
		}
		upper, lower := ParseVerticalPair(cell(row, lat0+1))
		out = append(out, aixm5.Airspace{
			ID:         idOf(desig, name, spec),
			Designator: idOf(desig, name, spec),
			Name:       name,
			Type:       typ,
			UpperLimit: upper,
			LowerLimit: lower,
			Ring:       ring,
			Rmk:        cell(row, lat0+2),
			WorkHr:     hoursFromRemark(cell(row, lat0+2)),
		})
	}
	return out
}

// parseCombinedTable reads ICAO's ENR 2.1 layout, where the first column
// carries the name, the lateral limits, the VERTICAL limits and the
// class together, and the columns beside it carry the ATS unit, its call
// sign, its frequencies and the remarks.
//
// A zone here is a BLOCK of rows, not a row: Hungary, Slovakia, Portugal
// and Slovenia run the four parts together in one cell, while AirNav
// Ireland gives each its own row (name, then geometry, then
// "SFC / FL 245 - Class C/G/A"), the columns beside them spanning all
// three. Accumulating the first column until the next row that opens a
// zone reads both shapes with one rule.
func parseCombinedTable(matrix [][]string, hi int, section, heading string, spec ZoneSpec, st *ZoneStats) []aixm5.Airspace {
	cols := zoneColumns(matrix[hi], spec)
	var out []aixm5.Airspace
	var head string    // the accumulated first column
	var owner []string // the row the sibling columns come from
	flush := func() {
		if head == "" {
			return
		}
		if a, ok := combinedZone(head, owner, cols, section, heading, spec, st); ok {
			out = append(out, a)
		}
		head, owner = "", nil
	}
	for ri := hi + 1; ri < len(matrix); ri++ {
		row := matrix[ri]
		if len(row) == 0 {
			continue
		}
		c0 := NormSpace(strings.TrimSpace(cell(row, 0)))
		// The column-number legend ICAO prints under the header ("1", "2",
		// "3") is not a zone, and left in it swallows the row beneath it.
		if c0 == "" || isLegendRow(row) {
			continue
		}
		if continuesZone(c0) && head != "" {
			// A cell spanning several rows repeats verbatim once
			// ExpandTable has filled the span; appending it again would
			// trace the same boundary twice.
			if !strings.HasSuffix(head, c0) {
				head += " " + c0
			}
			continue
		}
		flush()
		head, owner = c0, row
	}
	flush()
	return out
}

// continuesZone reports whether a first-column cell adds to the zone
// above rather than opening a new one: it holds only geometry, or only
// the vertical limits and the class that follow it.
func continuesZone(c0 string) bool {
	if loc := geometryLeadRe.FindStringIndex(c0); loc != nil && loc[0] == 0 {
		return true
	}
	rest, _ := splitClassPhrase(c0)
	rest = strings.TrimSpace(strings.Trim(rest, "-,;: "))
	if rest == "" {
		return true
	}
	// A frequency on its own row continues the unit above it: Slovakia
	// prints the Bratislava ACC channels one per row, in the first
	// column.
	if isFreqOnly(rest) {
		return true
	}
	loc := limitStartRe.FindStringIndex(rest)
	return loc != nil && loc[0] == 0
}

// freqOnlyRe matches a cell holding nothing but frequencies and their
// unit words.
var freqOnlyRe = regexp.MustCompile(`(?i)^(\d{2,3}[.,]\d{1,3}|MHZ|KHZ|UHF|VHF|/|,|;|\(|\)|-|\d\)|PRIMARY|SECONDARY|EMERGENCY|\s)+$`)

func isFreqOnly(s string) bool {
	return freqOnlyRe.MatchString(s) && len(FreqsComVHF(s)) > 0
}

// combinedZone turns one accumulated block into an airspace.
func combinedZone(head string, row []string, cols zoneCols, section, heading string, spec ZoneSpec, st *ZoneStats) (aixm5.Airspace, bool) {
	desig, name, lateral, upper, lower, class := splitIcaoComposite(head, spec.IcaoPrefix, st)
	if name == "" && desig == "" {
		// A State that gives every zone its own table names it in the
		// heading above and starts the cell with the geometry (BHANSA).
		name = heading
	}
	if name == "" && desig == "" {
		st.SkippedTypes["NO NAME"]++
		return aixm5.Airspace{}, false
	}
	typ := zoneType(section, desig, name, spec, st)
	if typ == "" {
		return aixm5.Airspace{}, false
	}
	ring, ok := zoneRingOf(lateral, spec, st)
	if !ok {
		return aixm5.Airspace{}, false
	}
	callSign := cell(row, cols.callSign)
	// A State may print the channels in the first column instead of the
	// frequency one, on their own rows under the zone (Slovakia).
	freqText := cell(row, cols.freq)
	if len(FreqsComVHF(freqText)) == 0 {
		freqText = freqTail(head)
	}
	return aixm5.Airspace{
		ID:         idOf(desig, name, spec),
		Designator: idOf(desig, name, spec),
		Name:       name,
		Type:       typ,
		ClassCode:  class,
		UpperLimit: upper,
		LowerLimit: lower,
		Ring:       ring,
		Rmk:        cell(row, cols.remark),
		// The call-sign column is where ENR 2.1 prints the hours
		// ("BUDAPEST CONTROL/RADAR EN H24"); the remarks column rarely
		// repeats them.
		WorkHr: firstNonEmpty(hoursFromRemark(callSign), hoursFromRemark(cell(row, cols.remark))),
		Radio:  RadioChannelsFrom(freqText, cell(row, cols.unit), callSign),
	}, true
}

// freqTail returns the frequencies an accumulated block carried in its
// own column, which is where Slovakia prints them. Only the part after
// the last limit is scanned, so a coordinate or a radius cannot be read
// as a channel.
func freqTail(head string) string {
	spans := limitSpans(head)
	if len(spans) == 0 {
		return ""
	}
	return head[spans[len(spans)-1][1]:]
}

// zoneType resolves the emitted type, counting what the spec rejects.
func zoneType(section, desig, name string, spec ZoneSpec, st *ZoneStats) string {
	if spec.Type == nil {
		return ""
	}
	typ := spec.Type(section, desig, name)
	if typ == "" {
		st.SkippedTypes[skipKey(name)]++
	}
	return typ
}

// zoneRingOf parses the lateral limits, counting a zone left without
// geometry (a point-only row counts itself, in ZoneRing).
func zoneRingOf(lateral string, spec ZoneSpec, st *ZoneStats) ([][2]float64, bool) {
	pointOnly := st.PointOnly
	ring := ZoneRing(lateral, spec, st)
	if len(ring) < 3 {
		if st.PointOnly == pointOnly {
			st.SkippedTypes["NO GEOMETRY"]++
		}
		return nil, false
	}
	return ring, true
}

// idOf is the row's id: its designator, or the State prefix and a slug
// of its name where the AIP gives none.
func idOf(desig, name string, spec ZoneSpec) string {
	if desig != "" {
		return desig
	}
	return spec.IDPrefix + "-" + Slug(name)
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// icaoHeaderRow finds the header row of an ICAO zone table, the index of
// its lateral-limits column, and whether that column is the COMBINED one
// ENR 2.1 uses.
//
// Three shapes occur. In ICAO's ENR 5 tables the first column carries the
// identification, the name and the lateral limits, and the vertical
// limits follow in the next column. In ENR 2.1 the first column carries
// the vertical limits and the class as well, which the header says
// outright ("Name Lateral limits Vertical limits Class of airspace"), and
// the columns beside it belong to the ATS unit. Poland instead gives the
// name its own column and the limits the next.
//
// The decision is per TABLE and from the header, never from the section
// number: Hungary publishes ENR 2.2 in the ENR 5 shape while Slovakia
// publishes it in the ENR 2.1 one.
func icaoHeaderRow(matrix [][]string) (row, lateralCol int, combined bool) {
	for i, r := range matrix {
		if len(r) < 2 {
			continue
		}
		if isSectorHeader(r) {
			// An ACC elementary-sector table: controller positions, not
			// volumes a pilot is cleared into, and laid out with the
			// vertical limits to the LEFT of the lateral ones, so reading
			// it would name each row after a level band.
			return -1, 0, false
		}
		for c, h := range r {
			head := strings.ToUpper(NormSpace(h))
			if !strings.Contains(head, "LATERAL") {
				continue
			}
			if c > 0 {
				return i, c, false
			}
			if strings.Contains(head, "VERTICAL") {
				return i, 0, true
			}
			for _, w := range icaoHeadWords {
				if strings.Contains(head, w) {
					return i, 0, false
				}
			}
		}
	}
	return -1, 0, false
}

// isSectorHeader recognises the ACC elementary-sector tables ICAO's
// ENR 2.2 carries beside the control areas ("Sector group /
// Identification / Class of airspace | Sector name / Identification |
// Vertical limits | Lateral limits | Remarks").
func isSectorHeader(row []string) bool {
	for _, h := range row {
		u := strings.ToUpper(NormSpace(h))
		if strings.Contains(u, "SECTOR NAME") || strings.Contains(u, "SECTOR GROUP") {
			return true
		}
	}
	return false
}

// classPhraseRe matches the class the ENR 2.1 cell states after its
// limits, in the wordings the cohort uses: Slovenia's "Class of
// airspace: C,D,E,G", Ireland's "- Class C/G/A", Portugal's "Class of
// Airspace: C".
var classPhraseRe = regexp.MustCompile(`(?i)[-,;(]?\s*class(?:\s+of\s+(?:the\s+)?airspace)?\s*:?\s*([A-G](?:\s*[/,]\s*[A-G])*)\b`)

// splitClassPhrase cuts the class phrase and EVERYTHING AFTER IT off a
// cell, returning what precedes it and the letters it stated.
//
// Cutting the tail matters as much as reading the class. ICAO's order
// puts the class last of the four parts, so anything beyond it is prose
// the cell has appended: Portugal closes the Lisboa TMA with "Class of
// Airspace: C The LISBOA TMA (LPPT TMA) comprises the following sectors
// *:", and leaving that in place hides the vertical limits behind it.
func splitClassPhrase(s string) (rest, letters string) {
	m := classPhraseRe.FindStringSubmatchIndex(s)
	if m == nil {
		return s, ""
	}
	return strings.TrimSpace(s[:m[0]]), strings.ToUpper(NormSpace(s[m[2]:m[3]]))
}

// classFromLetters keeps a single published class and drops a STACK.
//
// A volume published "C,D,E,G" or "C/G/A" is several classes at
// different levels, which the one-letter column cannot express. Picking
// the first would understate the Shannon FIR's class A, and picking the
// most restrictive would tell a VFR pilot the whole FIR is closed to
// them. Leaving it empty is what the app already renders as "controlled,
// letter unknown", and the stack is counted in the meta.
func classFromLetters(letters string, st *ZoneStats) string {
	fields := strings.FieldsFunc(letters, func(r rune) bool {
		return r == '/' || r == ',' || r == ' '
	})
	switch len(fields) {
	case 0:
		return ""
	case 1:
		return ClassLetter(fields[0])
	}
	st.ClassStacks++
	return ""
}

// splitIcaoComposite cuts the accumulated first column into its four
// ICAO parts. The class comes off FIRST: ParseVerticalPair splits on the
// first slash it sees, so "SFC / FL 245 - Class C/G/A" left whole would
// read the class letters as a limit.
func splitIcaoComposite(s, icaoPrefix string, st *ZoneStats) (
	designator, name, lateral string, upper, lower *aixm5.VerticalLimit, class string,
) {
	s = NormSpace(s)
	rest, letters := splitClassPhrase(s)
	class = classFromLetters(letters, st)

	// Labelled limits need no guessing at all: the State says which is
	// which ("Upper limit: FL 660 Lower limit: GND"), and the positional
	// rules below would read that pair as one limit, since the label
	// between them breaks the run.
	if geo, up, lo, ok := splitLabelledLimits(rest); ok {
		upper, lower = ParseVLimit(trimLimitText(up)), ParseVLimit(trimLimitText(lo))
		if !PlausibleLimit(upper) || !PlausibleLimit(lower) {
			st.LimitsUnparsed++
			upper, lower = nil, nil
		} else if up == "" || lo == "" {
			// A single "Vertical limits:" value holds the pair, and the
			// State may write it either way up.
			upper, lower = ParseVerticalPair(trimLimitText(up + lo))
			if OrderLimits(&upper, &lower) {
				st.LimitsSwapped++
			}
		}
		designator, name, lateral = splitIcaoHead(geo, icaoPrefix)
		if zone := zoneNameFromPhrase(name); zone != "" {
			name = zone
		}
		return designator, name, lateral, upper, lower, class
	}

	// The vertical limits come off BEFORE the name and the geometry are
	// separated, because a State may publish neither: Slovakia's FIR
	// reads "BRATISLAVA FIR State boundary with Poland, ... UNL / GND",
	// which carries no coordinate at all and would otherwise lose its
	// limits along with its geometry.
	rest, upperText, lowerText := splitVerticalTail(rest)
	if upperText != "" {
		upper, lower = ParseVLimit(trimLimitText(upperText)), ParseVLimit(trimLimitText(lowerText))
		if !PlausibleLimit(upper) || !PlausibleLimit(lower) {
			// The eAIP loses the spacing between inline values often
			// enough to matter: Portugal prints one Lisboa TMA sector's
			// limits as "FL2451000FT", which reads as FL 2451000. A limit
			// no aircraft could fly is a parse failure, not a limit.
			st.LimitsUnparsed++
			upper, lower = nil, nil
		} else if OrderLimits(&upper, &lower) {
			st.LimitsSwapped++
		}
	}
	designator, name, lateral = splitIcaoHead(rest, icaoPrefix)
	if zone := zoneNameFromPhrase(name); zone != "" {
		name = zone
	}
	return designator, name, lateral, upper, lower, class
}

// limitLabelRe matches a limit written with its NAME, which is the one
// case needing no inference at all: the label says which limit it is.
// BHANSA writes "Upper limit: FL 660 Lower limit: GND" and, for the
// Mostar TMA, the two the other way round.
var limitLabelRe = regexp.MustCompile(`(?i)\b(upper|lower|vertical)\s+limits?\s*:?\s*`)

// splitLabelledLimits cuts the labelled limits off a cell, returning the
// text before the first label and the two values. A lone "Vertical
// limits:" holds both, and the caller splits it.
func splitLabelledLimits(s string) (geometry, upper, lower string, ok bool) {
	locs := limitLabelRe.FindAllStringSubmatchIndex(s, -1)
	if len(locs) == 0 {
		return "", "", "", false
	}
	for i, m := range locs {
		end := len(s)
		if i+1 < len(locs) {
			end = locs[i+1][0]
		}
		val := strings.TrimSpace(s[m[1]:end])
		switch strings.ToUpper(s[m[2]:m[3]]) {
		case "UPPER":
			upper = val
		case "LOWER":
			lower = val
		default:
			if upper == "" && lower == "" {
				upper = val
			}
		}
	}
	if upper == "" && lower == "" {
		return "", "", "", false
	}
	return strings.TrimSpace(strings.Trim(s[:locs[0][0]], " -,;/.")), upper, lower, true
}

// limitTailRe matches what may follow the last limit and still leave it
// at the end of the cell: its own reference word, and punctuation. A
// limit is often written "300M AGL/AMSL", and a State may close the cell
// with a footnote marker.
var limitTailRe = regexp.MustCompile(`(?i)^[\s./)*,;-]*(?:(?:AMSL|AGL|ASFC|SFC|MSL|GND|ALT|STD|UNL)[\s./)*,;-]*)*(?:\d\)[\s.]*)?$`)

// splitVerticalTail cuts the vertical limits off the end of a cell that
// carries the geometry before them, returning the geometry and the two
// limits as text.
//
// The pair is taken from the END, not from the first tokens that look
// like limits: a lateral limit may quote "a circle of radius 100 M",
// which reads exactly like one, and only its position tells the two
// apart. The tokens must also form an unbroken RUN of exactly two, so
// Portugal's "FL245 300M AGL/AMSL 450M AGL/AMSL" — a ceiling and two
// alternative floors — is left alone rather than reduced to a band the
// AIP never published.
func splitVerticalTail(s string) (geometry, upperText, lowerText string) {
	spans := limitSpans(s)
	if len(spans) == 0 {
		return s, "", ""
	}
	last := spans[len(spans)-1]
	if !limitTailRe.MatchString(s[last[1]:]) {
		return s, "", ""
	}
	// Walk back over the tokens that only punctuation and footnote
	// markers separate: that run is what the State wrote as the vertical
	// limits.
	run := 1
	for i := len(spans) - 1; i > 0; i-- {
		if !limitTailRe.MatchString(s[spans[i-1][1]:spans[i][0]]) {
			break
		}
		run++
	}
	tokens := spans[len(spans)-run:]
	// A run longer than a pair is either the pair written TWICE, which
	// Slovenia does ("7500 ft MSL / 4500 ft MSL 1) 7500 ft MSL / 4500 ft
	// MSL"), or something that is not a pair at all: Portugal gives the
	// Lisboa TMA a ceiling and two alternative floors, and reducing that
	// to a band would state limits the AIP never published.
	if distinctLimits(s, tokens) > 2 {
		return s, "", ""
	}
	geometry = strings.TrimSpace(strings.Trim(s[:tokens[0][0]], " -,;/"))
	if run == 1 {
		return geometry, strings.TrimSpace(s[tokens[0][0]:]), ""
	}
	// The last two tokens are the pair: a repetition restates it.
	prev := spans[len(spans)-2]
	return geometry, strings.TrimSpace(s[prev[0]:last[0]]), strings.TrimSpace(s[last[0]:])
}

// refWordRe is a bare vertical REFERENCE, which limitStartRe also
// matches because a cell may hold nothing else ("MSL").
var refWordRe = regexp.MustCompile(`(?i)^(AMSL|MSL|AGL|ASFC)[\s./)*,;-]*$`)

// limitSpans locates the limit tokens in a cell, folding a reference
// word back into the value it belongs to: "7500 ft MSL" is one limit,
// and counting its MSL as a second would turn a pair written twice into
// four different values.
func limitSpans(s string) [][]int {
	locs := limitStartRe.FindAllStringIndex(s, -1)
	out := make([][]int, 0, len(locs))
	for i, loc := range locs {
		end := len(s)
		if i+1 < len(locs) {
			end = locs[i+1][0]
		}
		if len(out) > 0 && refWordRe.MatchString(strings.TrimSpace(s[loc[0]:end])) {
			out[len(out)-1][1] = loc[1]
			continue
		}
		out = append(out, []int{loc[0], loc[1]})
	}
	return out
}

// distinctLimits counts how many DIFFERENT limits a run of tokens
// states, so a pair written twice is still a pair.
func distinctLimits(s string, spans [][]int) int {
	seen := map[string]bool{}
	for i, sp := range spans {
		end := len(s)
		if i+1 < len(spans) {
			end = spans[i+1][0]
		}
		v := ParseVLimit(trimLimitText(s[sp[0]:end]))
		if v == nil {
			continue
		}
		seen[v.Value+"|"+v.Unit+"|"+v.Ref] = true
	}
	return len(seen)
}

// footnoteTailRe matches the marker a State closes a limit with
// ("GND 2)").
var footnoteTailRe = regexp.MustCompile(`\s*\d\)\s*$`)

// trimLimitText tidies one limit before ParseVLimit, whose patterns are
// anchored and so cannot see past a trailing separator or footnote.
func trimLimitText(s string) string {
	s = footnoteTailRe.ReplaceAllString(strings.TrimSpace(s), "")
	return strings.TrimSpace(strings.Trim(s, " /-,;."))
}

// splitDesignator cuts a leading area designator off a name cell
// ("EPP1 PIONKI"). Spaces inside the designator are dropped, since
// States write "EP P 1" and "EPP1" for the same area.
func splitDesignator(s, icaoPrefix string) (designator, name string) {
	s = NormSpace(strings.TrimSpace(s))
	if m := designatorFor(icaoPrefix).FindStringSubmatch(s); m != nil {
		designator = strings.Join(strings.Fields(m[1]), "")
		name = strings.TrimSpace(strings.Trim(s[len(m[1]):], "-/,: "))
	} else {
		name = s
	}
	if name == "" {
		name = designator
	}
	return designator, name
}

// lateralPhraseRe reads the zone out of the sentence a State may open
// its lateral limits with: "The lateral limits of BANJA LUKA TMA
// (outside of BANJA LUKA CTR), are defined by the following
// coordinates:". Taking the whole sentence as the name would file the
// zone under the first type it happens to mention, which here is the CTR
// and not the TMA it describes.
var lateralPhraseRe = regexp.MustCompile(`(?i)^the\s+(?:lateral\s+)?(?:limits|boundaries)\s+of\s+(.+?)\s*(?:\(|,|\bare\b|\bis\b|:)`)

// zoneNameFromPhrase returns the zone a lateral-limits sentence names,
// or "" when the text is not one.
func zoneNameFromPhrase(s string) string {
	m := lateralPhraseRe.FindStringSubmatch(NormSpace(strings.TrimSpace(s)))
	if m == nil {
		return ""
	}
	return strings.TrimSpace(m[1])
}

// splitIcaoHead cuts the first column into its three parts. The
// designator is the leading token when the cell starts with one; the
// geometry starts at the first coordinate or circle phrase; the name is
// what lies between.
func splitIcaoHead(s, icaoPrefix string) (designator, name, lateral string) {
	s = NormSpace(s)
	rest := s
	if m := designatorFor(icaoPrefix).FindStringSubmatch(s); m != nil {
		designator = strings.Join(strings.Fields(m[1]), "")
		rest = strings.TrimSpace(s[len(m[1]):])
		rest = strings.TrimPrefix(rest, "/")
		rest = strings.TrimSpace(rest)
	}
	if loc := geometryLeadRe.FindStringIndex(rest); loc != nil {
		name = strings.TrimSpace(strings.Trim(rest[:loc[0]], "-/,: "))
		lateral = strings.TrimSpace(rest[loc[0]:])
	} else {
		name = rest
	}
	if name == "" {
		name = designator
	}
	return designator, name, lateral
}

func hasCircleWords(s string) bool {
	u := strings.ToUpper(s)
	return strings.Contains(u, "CIRCLE") || strings.Contains(u, "AREA BOUNDED") ||
		strings.Contains(u, "BOUNDED BY")
}

// hoursRe finds an activity time in a remarks cell: H24, or a UTC
// window, which is how the ICAO layout carries what the per-zone layout
// puts in its own column.
var hoursRe = regexp.MustCompile(`(?i)\b(H24|\d{4}\s*-\s*\d{4}(?:\s*UTC)?|SR\s*-\s*SS|SS\s*-\s*SR)\b`)

func hoursFromRemark(s string) string {
	if m := hoursRe.FindString(NormSpace(s)); m != "" {
		return strings.ToUpper(strings.Join(strings.Fields(m), " "))
	}
	return ""
}
