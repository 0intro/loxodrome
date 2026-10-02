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
	"slices"
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
// Everything before it is the identification and the name. KANS opens
// its boundaries with "Line joining the points:", "Polygon:" (and
// "Poligon:"), "Polygon-like shape defined by points:" and "DEFINED BY THE
// FOLLOWING HORIZONTAL POINTS/COORDINATES:", each of which was read as
// the end of the name. M-NAV opens its limits with "From" before the first
// coordinate.
var geometryLeadRe = regexp.MustCompile(`(?i)\b(\d{6}(?:\.\d+)?[NS]|\d{4}[NS]\s+\d{5}[EW]|A circle|Circle|An arc|Area bounded|Bounded by|The area|(?:A\s+)?lines?\s+joining|Pol[iy]gon\b|defined\s+by\s+the\s+following|From\s+\d{4,6}(?:\.\d+)?\s?[NS])`)

// designatorRe recognises the leading designator of a zone: the State's
// two-letter ICAO prefix, the family letter, and a number. The prefix is
// the State's own where it gave one, since a generic two-letter class
// would read "NOTA 5700N 01500W" (the North Oceanic Transition Area,
// followed by its first coordinate) as a designator.
var designatorRe = regexp.MustCompile(`^([A-Z]{2}\s?[PRDTA][A-Z]*\s?\d+[A-Z0-9]*)`)

// designatorFor returns the designator pattern for one State, cached.
var designatorCache sync.Map // prefix -> *regexp.Regexp

func designatorFor(icaoPrefix string) *regexp.Regexp {
	if icaoPrefix == "" {
		return designatorRe
	}
	if re, ok := designatorCache.Load(icaoPrefix); ok {
		return re.(*regexp.Regexp)
	}
	// Digits may follow the letters after the number: Iceland's BID8NV1.
	re := regexp.MustCompile(`^(` + regexp.QuoteMeta(icaoPrefix) + `\s?[PRDTA][A-Z]*\s?\d+[A-Z0-9]*)`)
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
	text := NodeText
	if spec.Bilingual {
		text = EnglishText
	}
	var out []aixm5.Airspace
	heading := ""
	var lastHeader []string // the last combined table's header
	zoneTables := map[*Node]bool{}
	for _, n := range nodes {
		if isHeadingTag(n.Data) {
			heading = cleanHeading(NodeText(n))
			continue
		}
		cells := ExpandCells(n)
		matrix := TextMatrix(cells, text)
		if sectorTable(matrix) {
			// Its width may match the combined table before it, whose
			// headerless continuation it would otherwise pass for.
			lastHeader = nil
			continue
		}
		hi, lat0, combined := icaoHeaderRow(matrix)
		if hi < 0 {
			// A combined table the State continues in a table of its own
			// with no header: Avians prints the BIAR TMA after the FAXI
			// one that way. Same width, not nested in a zone table read
			// already (where it is a zone's parts), and carrying geometry.
			if lastHeader != nil && !insideZoneTable(n, zoneTables) && tableWidth(matrix) == len(lastHeader) && anyGeometry(matrix) {
				zoneTables[n] = true
				st.Tables++
				out = append(out, parseCombinedTable(matrix, cells, lastHeader, 0, section, heading, spec, st)...)
			}
			continue
		}
		zoneTables[n] = true
		st.Tables++
		if combined {
			lastHeader = matrix[hi]
			out = append(out, parseCombinedTable(matrix, cells, matrix[hi], hi+1, section, heading, spec, st)...)
			continue
		}
		lastHeader = nil
		out = append(out, parseColumnarTable(matrix, hi, lat0, section, spec, st)...)
	}
	out = foldAggregates(out, spec, st)
	st.Zones += len(out)
	return out
}

// An ENR 2.1 table may name a TMA made of parts twice over. ROMATSA prints
// the whole as a row of its own, its outline and class but no limits,
// before its parts ("BUCUREŞTI TMA (BUCUREŞTI TMA 1 + BUCUREŞTI TMA 2)",
// "NAPOC TMA"), or heads the first part's cell with the whole ("BUCUREȘTI
// CTA (BUCUREȘTI CTA consists of BUCUREȘTI CTA 1 and BUCUREȘTI CTA 2)
// BUCUREŞTI CTA 1"), and a group of parts heads the first of them ("NAPOC
// NORTH SECTOR NAPOC TMA 1").

// partListRe is a parenthesis listing the parts a zone is made of.
var partListRe = regexp.MustCompile(`\s*\((?:[^()]*\bconsists\s+of\b[^()]*|[^()]*\+[^()]*)\)\s*`)

// partNameRe is a name ending in a numbered part, "NAPOC TMA 1", and what
// stands before it.
var partNameRe = regexp.MustCompile(`(?i)^(.+?)\s+(\S+\s+(?:TMA|CTA|CTR|ATZ|TIZ|TIA|FIZ|RMZ|TMZ)\s+\d+[A-Z]?)$`)

// sameLetters folds the two spellings Romanian gives its S and T, the
// comma below and the cedilla, which one AIP uses a row apart.
var sameLetters = strings.NewReplacer("\u0218", "\u015e", "\u0219", "\u015f", "\u021a", "\u0162", "\u021b", "\u0163")

func nameKey(s string) string {
	return strings.ToUpper(sameLetters.Replace(strings.TrimSpace(NormSpace(s))))
}

// ownName is a zone's name without the whole it belongs to: the list of
// parts is dropped, and a heading before a numbered part is dropped when
// it repeats the part's own base name, which is how a heading reads.
func ownName(name string) string {
	n := strings.TrimSpace(NormSpace(partListRe.ReplaceAllString(name, " ")))
	if m := partNameRe.FindStringSubmatch(n); m != nil {
		base := nameKey(strings.Fields(m[2])[0])
		for _, w := range strings.Fields(m[1]) {
			if nameKey(w) == base {
				return m[2]
			}
		}
	}
	return n
}

// foldAggregates names each part by its own name and drops the wholes: a
// zone with no designator and no vertical limit whose name heads two or
// more other zones of the section ("NAPOC TMA" over "NAPOC TMA 1" to "8")
// is the outline of parts that carry the limits, and kept, it would stand
// from the ground to unlimited over them.
func foldAggregates(zones []aixm5.Airspace, spec ZoneSpec, st *ZoneStats) []aixm5.Airspace {
	// A zone the AIP gives no designator is named by its slug, which is
	// its designator and its id both, so a new name takes a new slug.
	slugged := func(z *aixm5.Airspace) bool { return z.Designator == idOf("", z.Name, spec) }
	for i := range zones {
		z := &zones[i]
		if !slugged(z) {
			continue
		}
		if n := ownName(z.Name); n != z.Name {
			id := idOf("", n, spec)
			z.Name, z.ID, z.Designator = n, id, id
		}
	}
	out := zones[:0:0]
	for i, z := range zones {
		if slugged(&z) && z.UpperLimit == nil && z.LowerLimit == nil {
			prefix, parts := nameKey(z.Name)+" ", 0
			for j, o := range zones {
				if rest, ok := strings.CutPrefix(nameKey(o.Name), prefix); ok && j != i && rest != "" && rest[0] >= '0' && rest[0] <= '9' {
					parts++
				}
			}
			if parts >= 2 {
				st.Aggregates++
				continue
			}
		}
		out = append(out, z)
	}
	return out
}

// insideZoneTable reports a table nested in one already read as a zone
// table.
func insideZoneTable(n *Node, zoneTables map[*Node]bool) bool {
	for p := n.Parent; p != nil; p = p.Parent {
		if zoneTables[p] {
			return true
		}
	}
	return false
}

func tableWidth(matrix [][]string) int {
	if len(matrix) == 0 {
		return 0
	}
	return len(matrix[0])
}

func anyGeometry(matrix [][]string) bool {
	for _, row := range matrix {
		for _, c := range row {
			if HasGeometry(c) {
				return true
			}
		}
	}
	return false
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
	// A second geometry column beside the lateral limits is a wider ring
	// the State files with each area, SMATSA's "TSA with FBZ", the
	// flight-plan buffer zone: a filing construct, like Finland's Z rings,
	// so the column is passed over and the limits and remarks are read
	// beyond it. It is a property of the table, since an area with no
	// buffer reads NIL there. A cell repeating the lateral limits' own
	// text is a note spanning the table, no buffer: ROMATSA closes ENR 5.1
	// with one carrying coordinates.
	buffer := false
	for ri := hi + 1; ri < len(matrix) && !buffer; ri++ {
		next := cell(matrix[ri], lat0+1)
		if next != cell(matrix[ri], lat0) && (HasGeometry(next) || hasCircleWords(next)) {
			buffer = true
		}
	}
	// A table with a frequency column carries the ATS unit's columns as
	// ENR 2.1 does, and names its remarks: ANS CR's ENR 2.2 RMZs ("Name
	// Lateral limits Class of airspace | Vertical limits | Unit providing
	// service | Call sign Hours of service | FREQ | Remarks"), where the
	// column after the limits is the unit, not a remark.
	cols := zoneColumns(matrix[hi], spec)
	ats := cols.freq >= 0
	// The lateral column may also carry the vertical limits and the
	// class, after the geometry, as ENR 2.1's first column does: NAV
	// Portugal's ENR 2.2 FIZs ("Name | Lateral Limits Vertical Limits
	// Class of Airspace | Call-sign ... | Frequency | Remarks"), whose
	// limits the next column, the call sign's, never held.
	combinedLateral := lat0 > 0 && strings.Contains(strings.ToUpper(cell(matrix[hi], lat0)), "VERTICAL")
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
			id := lat0 - 1
			lateral = head
			if id > 0 && loneCoordRe.MatchString(NormSpace(cell(row, id))) {
				// A column of its own for the position, AirNav's
				// "Geographical Coordinates" beside "Circle with radius of
				// 10NM": the position is the circle's centre, and the name
				// is the column before it.
				if !HasGeometry(head) {
					lateral = cell(row, id) + " - " + head
				}
				id--
			}
			desig, name = splitDesignator(cell(row, id), spec.IcaoPrefix)
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
		var upper, lower *aixm5.VerticalLimit
		class := ""
		if combinedLateral {
			_, _, lateral, upper, lower, class = splitIcaoComposite(lateral, spec.IcaoPrefix, st)
		}
		ring, ok := zoneRingOf(lateral, spec, st)
		if !ok {
			continue
		}
		vcol := lat0 + 1
		if buffer {
			if next := cell(row, vcol); HasGeometry(next) || hasCircleWords(next) {
				st.BufferColumns++
			}
			vcol++
		}
		vtext := ""
		if !combinedLateral {
			vtext = strings.TrimSpace(cell(row, vcol))
			upper, lower = ParseVerticalPair(vtext)
		}
		rmkCol := vcol + 1
		if (ats || combinedLateral) && cols.remark >= 0 {
			rmkCol = cols.remark
		}
		// The hours stay the remarks': the call-sign column gives the
		// unit's, and ANS CR heads it "Hours of service (service / area)",
		// an RMZ's "H24 / HX" being the unit's H24 and the zone's HX.
		var radio []aixm5.RadioChannel
		if callSign := cell(row, cols.callSign); ats && !broadcastRe.MatchString(callSign) {
			radio = RadioChannelsFrom(cell(row, cols.freq), cell(row, cols.unit), callSign)
		}
		workHr := hoursFromRemark(cell(row, rmkCol))
		rmk := cell(row, rmkCol)
		if upper == nil && lower == nil && nilText(vtext) != "" {
			// Nothing read, SMATSA's two bands for one area ("Within 2000 FT
			// AMSL / GND and FL 195 / FL 120"): the text is kept with the
			// remarks, where the panel shows it, rather than lost.
			st.LimitsUnparsed++
			rmk = strings.TrimSpace(vtext + " " + rmk)
		}
		out = append(out, aixm5.Airspace{
			ID:         idOf(desig, name, spec),
			Designator: idOf(desig, name, spec),
			Name:       name,
			Type:       typ,
			ClassCode:  class,
			UpperLimit: upper,
			LowerLimit: lower,
			Ring:       ring,
			Rmk:        rmk,
			WorkHr:     workHr,
			Radio:      radio,
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
// zone reads both shapes with one rule, and it reads a third: Avians
// nests a control area's parts as a table inside the first cell, one
// statement per row, which is the same block run one level down.
func parseCombinedTable(matrix [][]string, cells [][]*Node, header []string, first int, section, heading string, spec ZoneSpec, st *ZoneStats) []aixm5.Airspace {
	cols := zoneColumns(header, spec)
	var blocks []*zoneBlock
	var cur *zoneBlock // the block a continuing row extends
	// extend adds a continuing statement, unless it is already there: a
	// cell spanning several rows repeats verbatim once the span is
	// filled, and appending it again would trace the same boundary twice.
	// The continuing rows' own units join the zone's: SMATSA opens a TMA
	// with its name on a row of its own and prints the unit beside the
	// geometry.
	extend := func(b *zoneBlock, c0 string, owners [][]string) {
		if !strings.HasSuffix(b.head, c0) {
			b.head += " " + c0
		}
		b.owners = append(b.owners, owners...)
	}
	for ri := first; ri < len(matrix); {
		// The rows a first-column cell spans are ONE zone, whose units
		// they list one per row (Keflavik and Reykjavik approach over
		// the FAXI TMA). Read again, the zone would be drawn once per
		// unit.
		node := firstCell(cells[ri])
		end := ri + 1
		for node != nil && end < len(matrix) && firstCell(cells[end]) == node {
			end++
		}
		owners := matrix[ri:end]
		row := matrix[ri]
		ri = end
		c0 := NormSpace(strings.TrimSpace(cell(row, 0)))
		// The column-number legend ICAO prints under the header ("1", "2",
		// "3") is not a zone, and left in it swallows the row beneath it.
		if len(row) == 0 || c0 == "" || isLegendRow(row) {
			continue
		}
		if group, parts, ok := nestedParts(node, spec); ok {
			var b *zoneBlock
			for _, p := range parts {
				// A nested list is one statement per row, so only a row
				// stating nothing but a name opens a part: Avians' BIAR
				// TMA gives its limits as "Efri mörk / Upper Limit: 7000
				// fet MSL / 7000 feet MSL", the label not leading.
				if b != nil && !namesOnly(p) {
					extend(b, p, nil)
					continue
				}
				b = &zoneBlock{head: p, group: group, owners: owners}
				blocks = append(blocks, b)
			}
			cur = nil
			continue
		}
		if cur != nil && continuesZone(c0) && !strings.HasSuffix(cur.head, c0) && wholeVolume(c0, spec) && wholeVolume(cur.head, spec) {
			// A row stating a volume whole, under a zone already whole, is
			// the zone's next volume: Avinor prints the Oslo TMA's eight
			// one row apiece under its name, each its own ring, limits
			// and class with nothing beside it, and appended to the first
			// they were never read. The row's own units are the volume's;
			// a row stating none flies under the zone's.
			if cur.family == nil {
				cur.family = &[]*zoneBlock{cur}
			}
			own := owners
			if !statesRadio(owners, cols) {
				own = append(append([][]string(nil), owners...), (*cur.family)[0].owners...)
			}
			next := &zoneBlock{head: zoneNamePart(cur.head) + " " + c0, owners: own, family: cur.family}
			*cur.family = append(*cur.family, next)
			cur = next
			blocks = append(blocks, cur)
			continue
		}
		if cur != nil && continuesZone(c0) {
			extend(cur, c0, owners)
			continue
		}
		if cur != nil && partJoinRe.MatchString(c0) {
			// "and" between two runs of limits: SMATSA's BEOGRAD TMA is
			// two volumes under one name, the second with its own
			// limits and no name of its own.
			if cur.family == nil {
				cur.family = &[]*zoneBlock{cur}
			}
			next := &zoneBlock{head: zoneNamePart(cur.head), owners: cur.owners, family: cur.family}
			*cur.family = append(*cur.family, next)
			cur = next
			blocks = append(blocks, cur)
			continue
		}
		cur = &zoneBlock{head: c0, owners: owners}
		blocks = append(blocks, cur)
	}
	var out []aixm5.Airspace
	for _, whole := range blocks {
		for _, b := range classBands(whole) {
			if a, ok := combinedZone(b, cols, section, heading, spec, st); ok {
				if a.ClassCode == "" {
					a.ClassCode = familyClass(b)
				}
				out = append(out, a)
			}
		}
	}
	return out
}

// classBandsRe is a class stated band by band after the limits the bands
// divide: ANS CR's CTA 2 PRAHA, "FL 660 / 1000 ft AGL Class of airspace:
// E : FL 95 / 1000 ft AGL C : FL 660 / FL 95", class E up to FL 95 and C
// above it. Read as the first letter, the whole area was class E.
var classBandsRe = regexp.MustCompile(`(?i)\bclass\s+of\s+airspace\s*:\s*((?-i:[A-G])\s*:.*)$`)

// classBandRe opens one band: its class letter and a colon.
var classBandRe = regexp.MustCompile(`(?:^|\s)((?-i:[A-G]))\s*:\s*`)

// classBands splits a block whose class is stated band by band into one
// volume per band, the geometry and the units shared. Any other block is
// returned as it is, and so is one whose bands do not each read as a
// pair of limits.
func classBands(b *zoneBlock) []*zoneBlock {
	head := NormSpace(b.head)
	loc := classBandsRe.FindStringSubmatchIndex(head)
	if loc == nil {
		return []*zoneBlock{b}
	}
	tail := head[loc[2]:loc[3]]
	opens := classBandRe.FindAllStringSubmatchIndex(tail, -1)
	if len(opens) < 2 {
		return []*zoneBlock{b}
	}
	geometry, _, _ := splitVerticalTail(strings.TrimSpace(head[:loc[0]]))
	var out []*zoneBlock
	for i, o := range opens {
		end := len(tail)
		if i+1 < len(opens) {
			end = opens[i+1][0]
		}
		limits := strings.TrimSpace(tail[o[1]:end])
		if u, l := ParseVerticalPair(limits); u == nil || l == nil {
			return []*zoneBlock{b}
		}
		band := *b
		band.head = geometry + " " + limits + " Class of airspace: " + tail[o[2]:o[3]]
		out = append(out, &band)
	}
	return out
}

// familyClass is the class the other parts of a zone state when this
// part states none: SMATSA prints the BEOGRAD TMA's "Airspace class: C"
// once, after its second part.
func familyClass(b *zoneBlock) string {
	if b.family == nil {
		return ""
	}
	if _, letters := splitClassPhrase(NormSpace(b.head)); letters != "" {
		return "" // a stack, which stays unstated
	}
	class := ""
	for _, other := range *b.family {
		if other == b {
			continue
		}
		_, letters := splitClassPhrase(NormSpace(other.head))
		// A scratch tally: the stack was counted when that part was read.
		c := classFromLetters(letters, NewZoneStats())
		switch {
		case c == "":
			continue
		case class != "" && class != c:
			return ""
		}
		class = c
	}
	return class
}

// partJoinRe is a row joining two parts of one zone.
var partJoinRe = regexp.MustCompile(`(?i)^(?:and|or|plus)$`)

// lateralLabelRe is the lateral limits' label, on a row of its own or
// closing a name.
var lateralLabelRe = regexp.MustCompile(`(?i)^lateral\s+limits?\s*:?\s*$`)

// zoneNamePart is what an accumulated block says before its geometry and
// its limits: the zone's name.
func zoneNamePart(head string) string {
	end := len(head)
	for _, re := range []*regexp.Regexp{geometryLeadRe, limitLabelRe, lateralLabelInRe} {
		if loc := re.FindStringIndex(head); loc != nil && loc[0] < end {
			end = loc[0]
		}
	}
	return strings.TrimSpace(head[:end])
}

// lateralLabelInRe finds the lateral limits' label inside a block.
var lateralLabelInRe = regexp.MustCompile(`(?i)\blateral\s+limits?\s*:`)

// nameNoiseRe is what a name may close with that is not part of it: the
// lateral limits' label, the sentence introducing them ("BEOGRAD TMA is
// the airspace defined by:"), a footnote mark ("BATAJNICA TMA *").
var nameNoiseRe = regexp.MustCompile(`(?i)(?:\s+is\s+the\s+airspace\s+defined\s+by\b.*|\s*\blateral\s+limits?\b\s*:?|\s*\*+)\s*$`)

// cleanZoneName strips that noise, as often as it is stacked.
func cleanZoneName(name string) string {
	for {
		clean := strings.TrimSpace(nameNoiseRe.ReplaceAllString(name, ""))
		if clean == name {
			return clean
		}
		name = clean
	}
}

// zoneBlock is one zone's accumulated first column and the rows its
// sibling columns come from.
type zoneBlock struct {
	head string
	// group names the zone a nested part belongs to ("FAXI TMA"), or is
	// empty.
	group  string
	owners [][]string
	// family lists the parts an "and" joined into one zone, or is nil.
	family *[]*zoneBlock
}

// nestedParts reads a first-column cell holding its zone's parts as a
// table of their own: Avians prints "FAXI TMA", then a one-column table
// running its six parts one statement per row (the name, the geometry,
// the upper limit, the lower limit, the class). The cell's own text is
// the group they belong to. ok is false unless the nested rows carry the
// geometry and the cell's own text none, so a table nested for another
// purpose is read flattened, as before.
func nestedParts(cell *Node, spec ZoneSpec) (group string, parts []string, ok bool) {
	if cell == nil {
		return "", nil, false
	}
	tables := NestedTables(cell)
	if len(tables) == 0 {
		return "", nil, false
	}
	group = NormSpace(OwnText(cell, spec.Bilingual))
	if HasGeometry(group) || hasCircleWords(group) {
		return "", nil, false
	}
	text := NodeText
	if spec.Bilingual {
		text = EnglishText
	}
	geometry := false
	for _, t := range tables {
		for _, r := range TextMatrix(ExpandCells(t), text) {
			p := NormSpace(strings.TrimSpace(cell0(r)))
			if p == "" {
				continue
			}
			if HasGeometry(p) || hasCircleWords(p) {
				geometry = true
			}
			if len(parts) == 0 || parts[len(parts)-1] != p {
				parts = append(parts, p)
			}
		}
	}
	if !geometry {
		return "", nil, false
	}
	return group, parts, true
}

// namesOnly reports a statement carrying no geometry, no limit and no
// class: in a list of a zone's statements, the name of the next part.
func namesOnly(s string) bool {
	if HasGeometry(s) || hasCircleWords(s) || limitLabelRe.MatchString(s) || limitStartRe.MatchString(s) {
		return false
	}
	_, letters := splitClassPhrase(s)
	return letters == ""
}

func firstCell(row []*Node) *Node {
	if len(row) == 0 {
		return nil
	}
	return row[0]
}

func cell0(row []string) string {
	if len(row) == 0 {
		return ""
	}
	return row[0]
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
	// A limit given with its label ("Upper Limit: FL 245") on a row of
	// its own continues the zone as much as a bare one does, and so does
	// the label SMATSA sets on a row of its own above the geometry
	// ("Lateral limits:").
	if loc := limitLabelRe.FindStringIndex(rest); loc != nil && loc[0] == 0 {
		return true
	}
	if lateralLabelRe.MatchString(rest) {
		return true
	}
	loc := limitStartRe.FindStringIndex(rest)
	return loc != nil && loc[0] == 0
}

// wholeVolume reports whether a first-column text states a volume whole:
// its ring and both its vertical limits.
func wholeVolume(s string, spec ZoneSpec) bool {
	// A scratch tally: the text is counted when its zone is read.
	_, _, lateral, upper, lower, _ := splitIcaoComposite(s, spec.IcaoPrefix, NewZoneStats())
	return upper != nil && lower != nil && HasGeometry(lateral)
}

// statesRadio reports whether a zone's rows name a unit, a call sign or a
// frequency beside the first column.
func statesRadio(owners [][]string, cols zoneCols) bool {
	for _, row := range owners {
		for _, c := range []int{cols.unit, cols.callSign, cols.freq} {
			if strings.TrimSpace(cell(row, c)) != "" {
				return true
			}
		}
	}
	return false
}

// freqOnlyRe matches a cell holding nothing but frequencies and their
// unit words.
var freqOnlyRe = regexp.MustCompile(`(?i)^(\d{2,3}[.,]\d{1,3}|MHZ|KHZ|UHF|VHF|/|,|;|\(|\)|-|\d\)|PRIMARY|SECONDARY|EMERGENCY|\s)+$`)

func isFreqOnly(s string) bool {
	return freqOnlyRe.MatchString(s) && len(FreqsComVHF(s)) > 0
}

// textualFloorRe is a floor stated in words, which no altitude grammar
// reads: ROMATSA's BUCUREŞTI CTA 2 runs from FL 245 down to the "Lower
// limit of ATS routes". Left in the cell it stops the ceiling reading too.
var textualFloorRe = regexp.MustCompile(`(?i)\blower\s+limit\s+of\s+(?:the\s+)?ATS\s+routes\b`)

// combinedZone turns one accumulated block into an airspace.
func combinedZone(b *zoneBlock, cols zoneCols, section, heading string, spec ZoneSpec, st *ZoneStats) (aixm5.Airspace, bool) {
	// A floor stated in words comes off the cell so the ceiling reads,
	// and goes to the remarks, where the panel shows it.
	head, floorText := b.head, ""
	if m := textualFloorRe.FindString(head); m != "" {
		head, floorText = strings.Replace(head, m, " ", 1), m
	}
	// So does an exception written after the limits, which would hide
	// them too.
	exceptText := ""
	if m := exceptAfterLimitsRe.FindStringSubmatchIndex(head); m != nil && endsWithLimit(head[:m[0]]) {
		exceptText = head[m[2]:m[3]]
		head = head[:m[0]] + " " + group(head, m, 2)
	}
	desig, name, lateral, upper, lower, class := splitIcaoComposite(head, spec.IcaoPrefix, st)
	name = cleanZoneName(name)
	if name == "" && desig == "" && b.group == "" {
		// A State that gives every zone its own table names it in the
		// heading above and starts the cell with the geometry (BHANSA).
		name = heading
	}
	var typ string
	if b.group != "" {
		// A part is of its group's kind whatever its own name mentions:
		// "BIRD CTA within BGGL FIR" is a control area, and "Domestic
		// Area excluding FAXI TMA and BIAR TMA" is not a terminal area.
		name = partName(b.group, name)
		typ = zoneType(section, "", b.group, spec, st)
	} else {
		if name == "" && desig == "" {
			st.SkippedTypes["NO NAME"]++
			return aixm5.Airspace{}, false
		}
		typ = zoneType(section, desig, name, spec, st)
	}
	if typ == "" {
		return aixm5.Airspace{}, false
	}
	ring, ok := zoneRingOf(lateral, spec, st)
	if !ok {
		return aixm5.Airspace{}, false
	}
	var radio []aixm5.RadioChannel
	workHr := ""
	for _, row := range b.owners {
		callSign := cell(row, cols.callSign)
		if broadcastRe.MatchString(callSign) {
			// A broadcast a unit transmits (Štefánik's arrival and
			// departure ATIS, listed under the approach unit) is not a
			// channel anyone answers on.
			continue
		}
		radio = appendRadio(radio, RadioChannelsFrom(cell(row, cols.freq), cell(row, cols.unit), callSign))
		// The call-sign column is where ENR 2.1 prints the hours
		// ("BUDAPEST CONTROL/RADAR EN H24"); the remarks column rarely
		// repeats them.
		if workHr == "" {
			workHr = firstNonEmpty(hoursFromRemark(callSign), hoursFromRemark(cell(row, cols.remark)))
		}
	}
	if len(radio) == 0 {
		// A State may print the channels in the first column instead of
		// the frequency one, on their own rows under the zone (Slovakia).
		first := b.owners[0]
		radio = RadioChannelsFrom(freqTail(b.head), cell(first, cols.unit), cell(first, cols.callSign))
	}
	rmk := firstRemark(b.owners, cols.remark)
	if floorText != "" {
		rmk = strings.TrimSpace(floorText + " " + rmk)
		st.LimitsTextual++
	}
	if exceptText != "" {
		rmk = strings.TrimSpace(exceptText + ". " + rmk)
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
		Rmk:        rmk,
		WorkHr:     workHr,
		Radio:      radio,
	}, true
}

// exceptAfterLimitsRe is an exception a State writes after the limits and
// before the class: ANS CR's MTMA I ČÁSLAV, "FL 95 / 2000 ft AMSL Except
// MCTR . Class of airspace: D", the military control zone cut out of it.
// The exception names what it excepts by its designation, in capitals.
var exceptAfterLimitsRe = regexp.MustCompile(`(?i)\s+(except\s+(?-i:[A-Z][A-Z0-9]*(?:\s+[A-Z][A-Z0-9]*){0,2}))\s*\.?\s*((?:airspace\s+)?class\b.*)?$`)

// endsWithLimit reports a text ending on a vertical limit, its reference
// word included.
func endsWithLimit(s string) bool {
	spans := limitSpans(s)
	return len(spans) > 0 && limitTailRe.MatchString(s[spans[len(spans)-1][1]:])
}

// broadcastRe recognises a call-sign cell naming a broadcast service.
var broadcastRe = regexp.MustCompile(`(?i)\b(?:D-)?(?:ATIS|VOLMET)\b`)

// firstRemark is the first remark the zone's rows carry.
func firstRemark(owners [][]string, col int) string {
	for _, row := range owners {
		if r := cell(row, col); r != "" {
			return r
		}
	}
	return ""
}

// appendRadio adds the channels not already listed.
func appendRadio(to, from []aixm5.RadioChannel) []aixm5.RadioChannel {
	for _, c := range from {
		dup := false
		for _, have := range to {
			if have == c {
				dup = true
				break
			}
		}
		if !dup {
			to = append(to, c)
		}
	}
	return to
}

// bracketDesignationRe reads the designation a group gives itself in
// brackets: "Reykjavik Control Area (BIRD CTA)".
var bracketDesignationRe = regexp.MustCompile(`\(([^()]+)\)\s*$`)

// partName names a part after its group unless it already does: "FAXI
// TMA" and "The Collar 1000a" make "FAXI TMA The Collar 1000a", while
// "BIRD CTA within BGGL FIR" already carries the designation its group
// gives in brackets.
func partName(group, name string) string {
	short := group
	if m := bracketDesignationRe.FindStringSubmatch(group); m != nil {
		short = strings.TrimSpace(m[1])
	}
	switch {
	case name == "":
		return group
	case strings.Contains(strings.ToUpper(name), strings.ToUpper(short)):
		return name
	}
	return short + " " + name
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
	if spec.Drop != nil {
		if why := spec.Drop(section, desig, name); why != "" {
			st.SkippedTypes[why]++
			return ""
		}
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

// loneCoordRe is a cell holding one coordinate pair and nothing else.
var loneCoordRe = regexp.MustCompile(`^` + CoordPat + `$`)

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
// Vertical limits | Lateral limits | Remarks"), and the tables a unit
// leads, which list its areas of responsibility rather than airspace:
// Avinor's "Unit providing service | Lateral limits, Vertical limits |
// Callsign | FREQ | RMK", Polaris ACC Oslo's sectors 1 to 7 from the
// ground up, then NEFAB and the Bodø Oceanic free route airspace.
func isSectorHeader(row []string) bool {
	for _, h := range row {
		u := strings.ToUpper(NormSpace(h))
		if strings.Contains(u, "SECTOR NAME") || strings.Contains(u, "SECTOR GROUP") {
			return true
		}
	}
	if len(row) > 1 && strings.Contains(strings.ToUpper(NormSpace(row[0])), "UNIT PROVIDING SERVICE") {
		for _, h := range row[1:] {
			if strings.Contains(strings.ToUpper(NormSpace(h)), "LATERAL") {
				return true
			}
		}
	}
	return false
}

// sectorTable reports a table headed as a sector table, which is read
// neither as zones nor as the continuation of the table before it. The
// header is the first row naming the lateral limits, as icaoHeaderRow
// finds it.
func sectorTable(matrix [][]string) bool {
	for _, r := range matrix {
		if isSectorHeader(r) {
			return true
		}
		for _, h := range r {
			if strings.Contains(strings.ToUpper(h), "LATERAL") {
				return false
			}
		}
	}
	return false
}

// classPhraseRe matches the class the ENR 2.1 cell states after its
// limits, in the wordings the cohort uses: Slovenia's "Class of
// airspace: C,D,E,G", Ireland's "- Class C/G/A", Portugal's "Class of
// Airspace: C", SMATSA's "Airspace class: C".
//
// The letters are capitals only: SMATSA enumerates its FIR's classes as
// "Airspace class: a) Serbia: - Class C : TMAs ...", and "a)" is not
// class A.
var classPhraseRe = regexp.MustCompile(`(?i)[-,;(]?\s*(?:airspace\s+)?class(?:\s+of\s+(?:the\s+)?airspace)?\s*:?\s*(?:-\s*)?((?-i:[A-G])(?:\s*[/,]\s*(?-i:[A-G]))*)\b`)

// dashClassRe is a class listed as an item of its own after the first,
// ROMATSA's "Class of airspace: - C ABV, but not including FL 105, ATS
// routes, CTRs, TMA - A TMA - G outside other regulated airspace": the
// dash and a capital letter standing alone.
var dashClassRe = regexp.MustCompile(`(?:^|\s)-\s*([A-G])\b`)

// splitClassPhrase cuts the class phrase and EVERYTHING AFTER IT off a
// cell, returning what precedes it and the letters it stated.
//
// Cutting the tail matters as much as reading the class. ICAO's order
// puts the class last of the four parts, so anything beyond it is prose
// the cell has appended: Portugal closes the Lisboa TMA with "Class of
// Airspace: C The LISBOA TMA (LPPT TMA) comprises the following sectors
// *:", and leaving that in place hides the vertical limits behind it.
func splitClassPhrase(s string) (rest, letters string) {
	if rest, letters, ok := bandClasses(s); ok {
		return rest, letters
	}
	m := classPhraseRe.FindStringSubmatchIndex(s)
	if m == nil {
		return s, ""
	}
	letters = strings.ToUpper(NormSpace(s[m[2]:m[3]]))
	// A class bounded by a level ("Class A above FL 195. Class C at or
	// below FL 195.") covers only part of the limits read before it, the
	// other phrases the rest: as much a stack as "C/G/A", and reading the
	// first alone would state class A down to the floor. Any phrase's
	// bound says so, since Avians' English half of the BIRK Approach
	// reads "Class A fyrir ofan FL 195. Class D at or below FL 195.". With
	// no bound anywhere, a class is the class of the limits just before
	// it, and what follows is the next band with its own (Ireland's
	// "FL 055/ FL 660 - Class A FL 660/UNL - Class G"), which the cut
	// leaves out.
	stacked := classBoundRe.MatchString(s[m[1]:])
	var more []string
	for _, x := range classPhraseRe.FindAllStringSubmatchIndex(s[m[1]:], -1) {
		more = append(more, strings.ToUpper(NormSpace(s[m[1]+x[2]:m[1]+x[3]])))
		if classBoundRe.MatchString(s[m[1]+x[1]:]) {
			stacked = true
		}
	}
	if len(more) == 0 {
		// The other classes may be listed without the word, one item a
		// class, after a first bounded by a level.
		for _, x := range dashClassRe.FindAllStringSubmatch(s[m[1]:], -1) {
			more = append(more, x[1])
		}
	}
	if stacked && len(more) > 0 {
		letters += "/" + strings.Join(more, "/")
	}
	return strings.TrimSpace(s[:m[0]]), letters
}

// bandClassRe finds Fintraffic's class statement, which gives each band
// in ICAO's abbreviations and the class AFTER it: "AIRSPACE CLASS BTN FL 95
// - 2000 FT MSL D", and for the FIR "AIRSPACE CLASS ABV FL 660 G BTN FL 660
// - FL 95 C BLW FL 95 G".
var bandClassRe = regexp.MustCompile(`(?i)\bairspace\s+class\s+(?:BTN|ABV|BLW)\b`)

// bandWordRe is a word a band statement is written in, besides the class
// letters.
var bandWordRe = regexp.MustCompile(`^(?:BTN|ABV|BLW|AND|FL\d*|\d+(?:FT|M)?|FT|M|MSL|AMSL|AGL|ASFC|SFC|GND|UNL|-|/)$`)

// bandClasses reads that statement: the letters of its bands, a stack
// where they differ. It ends at the first word no band is written in.
func bandClasses(s string) (rest, letters string, ok bool) {
	loc := bandClassRe.FindStringIndex(s)
	if loc == nil {
		return s, "", false
	}
	var ls []string
words:
	for _, w := range strings.Fields(s[loc[0]:])[2:] {
		w = strings.Trim(w, ".,;:")
		switch {
		case len(w) == 1 && w[0] >= 'A' && w[0] <= 'G':
			ls = append(ls, w)
		case bandWordRe.MatchString(strings.ToUpper(w)):
		default:
			break words
		}
	}
	if len(ls) == 0 {
		return s, "", false
	}
	return strings.TrimSpace(s[:loc[0]]), strings.Join(ls, "/"), true
}

// classBoundRe matches the level bound a class phrase may carry, in words
// or in ICAO's abbreviations (ROMATSA's "C ABV, but not including FL 105").
var classBoundRe = regexp.MustCompile(`(?i)^\s*(?:above|below|ABV|BLW|between|at\s+(?:or|and)\s+(?:above|below)|up\s+to)\b`)

// classFromLetters keeps a single published class and drops a STACK.
//
// A volume published "C,D,E,G" or "C/G/A" is several classes at
// different levels, which the one-letter column cannot express. Picking
// the first would understate the Shannon FIR's class A, and picking the
// most restrictive would tell a VFR pilot the whole FIR is closed to
// them. Leaving it empty is what the app already renders as "controlled,
// letter unknown", and the stack is counted in the meta.
func classFromLetters(letters string, st *ZoneStats) string {
	var fields []string
	for _, f := range strings.FieldsFunc(letters, func(r rune) bool {
		return r == '/' || r == ',' || r == ' '
	}) {
		if !slices.Contains(fields, f) {
			fields = append(fields, f)
		}
	}
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
		} else if up == "" {
			// A floor on its own is the floor, its ceiling published
			// elsewhere (splitLabelledLimits files a lone "Vertical
			// limits:" as the upper, so an empty upper means a lower
			// label alone).
			if lower == nil {
				lower = firstLimit(lo)
			}
		} else if lo == "" {
			// A single "Vertical limits:" value holds the pair, and the
			// State may write it either way up.
			upper, lower = ParseVerticalPair(trimLimitText(up))
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
var limitTailRe = regexp.MustCompile(`(?i)^[\s./)*,;-]*(?:(?:AMSL|AGL|ASFC|SFC|MSL|GND|ALT|QNH|STD|UNL)[\s./)*,;-]*)*(?:\d\)[\s.]*)?$`)

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
