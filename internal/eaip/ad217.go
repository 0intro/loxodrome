// ad217.go reads the airspace an aerodrome page publishes for itself:
// ICAO's AD 2.17 "ATS airspace" (AD 3.16 on a heliport's page), the
// control zone, the aerodrome traffic zone or the flight or traffic
// information zone around the field. Several States publish these ONLY
// there: Finland, Ireland, Iceland and Serbia list none of their control
// zones in ENR 2.1, so without this section a map has terminal areas over
// every major aerodrome and nothing under them.
//
// ICAO fixes the seven items (PANS-AIM, AD 2.17): 1 designation and
// lateral limits, 2 vertical limits, 3 airspace classification, 4 the ATS
// unit's call sign and languages, 5 the transition altitude, 6 the hours
// of applicability, 7 remarks. The generators set them a row per item
// (EUROCONTROL) or a column per item under a header row (IDS AIRNAV, and
// ALBCONTROL's EUROCONTROL package), and a State may describe several
// zones in one item, each named before its geometry (HungaroControl's
// DEBRECEN TIZ1 to TIZ3, LGS's LIELVARDE CTR sectors, SMATSA's VRŠAC CTR
// and VRŠAC ATZ /RMZ).

package eaip

import (
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"

	"github.com/0intro/loxodrome/internal/aixm5"
)

// atsRecord is one AD 2.17 description as printed: the items of a row
// layout, or one data row under a column layout.
type atsRecord struct {
	// head is a zone name set above the items rather than in item 1:
	// NAV Portugal's "Santa Maria CTR" row, item 1 being "Lateral limits".
	head                                           string
	lateral, vertical, class, callSign, hours, rmk string
	// msl says the vertical column's heading states the reference its
	// figures leave out: PANSA's "Vertical Limits (AMSL)", "1800 ft GND".
	msl bool
}

// The item labels, in the words the AIPs print them (a bilingual
// publisher's first row may be its own language, whose row is then
// passed over for the English one).
var (
	atsLateralRe    = regexp.MustCompile(`(?i)LATERAL|DESIGNATION`)
	atsVerticalRe   = regexp.MustCompile(`(?i)VERTICAL`)
	atsClassLabelRe = regexp.MustCompile(`(?i)CLASS`)
	atsCallRe       = regexp.MustCompile(`(?i)CALL\s*SIGN`)
	atsHoursLabelRe = regexp.MustCompile(`(?i)HOURS|APPLICAB`)
	atsRmkLabelRe   = regexp.MustCompile(`(?i)REMARK|\bRMK\b`)
	atsTransRe      = regexp.MustCompile(`(?i)TRANSITION`)
	atsAMSLRe       = regexp.MustCompile(`(?i)\bA?MSL\b`)
)

// atsRecords reads a section's tables into records, a table at a time,
// since a State may give each zone a table of its own.
func atsRecords(tables []*Node) []atsRecord {
	var out []atsRecord
	for _, t := range tables {
		matrix := ExpandTable(t)
		if hi, cols := atsHeader(matrix); hi >= 0 {
			for _, row := range matrix[hi+1:] {
				if numberingRow(row) != nil || blankRow(row) {
					continue
				}
				r := atsRecord{
					lateral:  NormSpace(cell(row, cols.lateral)),
					vertical: NormSpace(cell(row, cols.vertical)),
					class:    NormSpace(cell(row, cols.class)),
					callSign: NormSpace(cell(row, cols.callSign)),
					hours:    NormSpace(cell(row, cols.hours)),
					rmk:      NormSpace(cell(row, cols.remark)),
					msl:      cols.vertical >= 0 && atsAMSLRe.MatchString(matrix[hi][cols.vertical]),
				}
				if r.lateral != "" {
					out = append(out, r)
				}
			}
			continue
		}
		items := ADItems([]*Node{t})
		lat, ok := strictItem(items, 1, atsLateralRe)
		if !ok {
			continue
		}
		r := atsRecord{head: atsHead(matrix), lateral: itemText(lat)}
		if it, ok := strictItem(items, 2, atsVerticalRe); ok {
			r.vertical = itemText(it)
		}
		if it, ok := strictItem(items, 3, atsClassLabelRe); ok {
			r.class = itemText(it)
		}
		if it, ok := strictItem(items, 4, atsCallRe); ok {
			r.callSign = itemText(it)
		}
		if it, ok := strictItem(items, 6, atsHoursLabelRe); ok {
			r.hours = itemText(it)
		}
		if it, ok := strictItem(items, 7, atsRmkLabelRe); ok {
			r.rmk = itemText(it)
		}
		out = append(out, r)
	}
	return out
}

// atsCols are a column layout's columns, -1 where absent.
type atsCols struct{ lateral, vertical, class, callSign, hours, remark int }

// atsHeader finds a column layout's header row: one naming the lateral
// limits and the vertical limits in cells of their own.
func atsHeader(matrix [][]string) (int, atsCols) {
	for i, row := range matrix {
		cols := atsCols{-1, -1, -1, -1, -1, -1}
		for j, c := range row {
			switch {
			case cols.lateral < 0 && atsLateralRe.MatchString(c):
				cols.lateral = j
			case cols.vertical < 0 && atsVerticalRe.MatchString(c):
				cols.vertical = j
			case cols.class < 0 && atsClassLabelRe.MatchString(c):
				cols.class = j
			case cols.callSign < 0 && atsCallRe.MatchString(c):
				cols.callSign = j
			case atsTransRe.MatchString(c):
			case cols.hours < 0 && atsHoursLabelRe.MatchString(c):
				cols.hours = j
			case cols.remark < 0 && atsRmkLabelRe.MatchString(c):
				cols.remark = j
			}
		}
		if cols.lateral >= 0 && cols.vertical > cols.lateral {
			return i, cols
		}
	}
	return -1, atsCols{}
}

// atsHead is a zone name a table sets on a row of its own above the
// items: a row whose one distinct cell names an ATS zone.
func atsHead(matrix [][]string) string {
	for _, row := range matrix {
		cells := distinctCells(row)
		if len(cells) == 0 {
			continue
		}
		if itemNumberRe.MatchString(cells[0]) {
			return ""
		}
		if len(cells) == 1 && atsTypeRe.MatchString(cells[0]) && !adHeadingRe.MatchString(cells[0]) {
			return cells[0]
		}
	}
	return ""
}

// strictItem is item n when its label fits, else the item whose label
// does, else the English row of an item numbered twice (Avians prints its
// own language first): never an item whose label does NOT fit, which is
// how LPS SR's remarks, its item 6, would be read as the hours.
func strictItem(items map[int]ADItem, n int, label *regexp.Regexp) (ADItem, bool) {
	if it, ok := items[n]; ok && label.MatchString(it.Label) {
		return it, true
	}
	nums := make([]int, 0, len(items))
	for k := range items {
		nums = append(nums, k)
	}
	sort.Ints(nums)
	for _, k := range nums {
		if label.MatchString(items[k].Label) {
			return items[k], true
		}
	}
	if it, ok := items[n]; ok {
		for _, row := range it.More {
			if len(row) > 1 && label.MatchString(row[0]) {
				return ADItem{Label: row[0], Values: row[1:]}, true
			}
		}
	}
	return ADItem{}, false
}

// itemText is an item's whole text: its values and the rows continuing
// it, less the label a continuation row repeats (AirNav sets Shannon's
// name, its circle and "(See Remarks)" on three rows numbered 1).
func itemText(it ADItem) string {
	parts := append([]string(nil), it.Values...)
	for _, row := range it.More {
		if len(row) > 1 && row[0] == it.Label {
			row = row[1:]
		}
		parts = append(parts, row...)
	}
	return NormSpace(strings.Join(parts, " "))
}

// atsTypeRe finds the kind of an ATS zone in its designation, in the
// abbreviation or in words, the military prefix and a part's number
// included ("TIZ1", "MCTR"). The groups are, in order of precedence: a
// control zone, an information zone or area, a traffic zone, and the
// radio and transponder mandatory zones a designation may add.
var atsTypeRe = regexp.MustCompile(`(?i)\b(?:(M?CTR)|CONTROL\s+ZONE|(FIZ|TIZ|TIA)|(FLIGHT\s+INFORMATION\s+ZONE)|(TRAFFIC\s+INFORMATION\s+(?:ZONE|AREA))|(M?ATZ)|((?:AERODROME|AIRFIELD)\s+TRAFFIC\s+ZONE)|(RMZ)|(TMZ))\d*\b`)

// atsType is the kind a designation names, the State's own word where it
// has one (the builder draws TIZ, TIA and FIZ as the radio mandatory zones
// they are, and MCTR and MATZ as the civil kinds, keeping the word).
func atsType(desig string) string {
	best, rank := "", 99
	for _, m := range atsTypeRe.FindAllStringSubmatch(desig, -1) {
		typ, r := "", 99
		switch {
		case m[1] != "":
			typ, r = strings.ToUpper(m[1]), 0
		case strings.Contains(strings.ToUpper(m[0]), "CONTROL"):
			typ, r = "CTR", 0
		case m[2] != "":
			typ, r = strings.ToUpper(m[2]), 1
		case m[3] != "":
			typ, r = "FIZ", 1
		case m[4] != "":
			typ, r = "TIZ", 1
		case m[5] != "":
			typ, r = strings.ToUpper(m[5]), 2
		case m[6] != "":
			typ, r = "ATZ", 2
		case m[7] != "":
			typ, r = "RMZ", 3
		case m[8] != "":
			typ, r = "TMZ", 4
		}
		if r < rank {
			best, rank = typ, r
		}
	}
	return best
}

// notCTRWordRe marks a designation that names something other than the
// aerodrome's control zone, which an untyped controlled zone is taken for
// only when nothing says otherwise: AirNav's "Weston Area of
// Responsibility" is class C from the surface and no control zone, and
// Avians' "UNCONTROLLED AIRSPACE" carries no geometry anyway.
var notCTRWordRe = regexp.MustCompile(`(?i)\b(?:AREA|SECTOR|RESPONSIBILITY|UNCONTROLLED|AIRSPACE|TMA|CTA|FIR|PART)\b`)

// geomStartRe opens a lateral limit: the words States lead one with, a
// coordinate, or a circle or an arc.
var geomStartRe = regexp.MustCompile(`(?i)\b(?:area\s+bounded|(?:the\s+)?lines?\s+joining|linia\b|within\b|lateral\s+limits|(?:an?\s+)?circle|circular|hringur|arc\b)|\b\d{6}(?:\.\d+)?\s?[NS]\b|\b\d{4}[NS]\s*\d{5}[EW]`)

// atsZone is one zone of an item 1: its designation as printed and its
// lateral limits.
type atsZone struct{ desig, lateral string }

// zoneQualRe is what may follow a zone's kind in its designation: a
// part's number ("CTR 2"), a second kind ("ATZ /RMZ"), a part ("SECTOR
// B", "LOWER"), the kind's own abbreviation after the words ("(ATZ)").
var zoneQualRe = regexp.MustCompile(`(?i)^(?:\s+\d{1,2}[A-Z]?\b)?(?:\s*/\s*(?:RMZ|TMZ|ATZ|TIZ|FIZ))?(?:\s*\((?:ATZ|CTR|TIZ|FIZ|RMZ)\))?(?:\s+(?:SECTOR|PART)\s+[A-Z0-9]+|\s+(?:LOWER|UPPER)\b)?`)

// designationWordRe is a word a designation never holds and geometry
// does, which is what tells a zone named after another's geometry from a
// type word inside a limit ("along the boundary of X CTR").
var designationWordRe = regexp.MustCompile(`(?i)\b(?:along|boundary|border|bdry|excluding|except|within|joining|between|arc|circle|radius|cent(?:re|er)d?|around|point|origin|then|to)\b`)

// splitATSZones cuts an item 1 into its zones: the designation before the
// first geometry, then each further designation set after a geometry.
func splitATSZones(text, head string) []atsZone {
	text = NormSpace(text)
	g := geomStartRe.FindStringIndex(text)
	if g == nil {
		return nil
	}
	first := atsZone{desig: cleanDesignation(text[:g[0]])}
	if first.desig == "" {
		first.desig = head
	}
	// Each coordinate's end is where a following zone's name may begin.
	var ends []int
	for _, re := range []*regexp.Regexp{CoordRe, SpacedCoordRe} {
		for _, m := range re.FindAllStringIndex(text, -1) {
			ends = append(ends, m[1])
		}
	}
	zones := []atsZone{first}
	start := g[0]
	for _, m := range atsTypeRe.FindAllStringIndex(text, -1) {
		if m[0] < g[0] {
			continue
		}
		from := -1
		for _, e := range ends {
			if e <= m[0] && e > from {
				from = e
			}
		}
		if from < start {
			continue
		}
		q := zoneQualRe.FindStringIndex(text[m[1]:])
		end := m[1] + q[1]
		// The previous zone's limits may close before the name ("to point
		// of origin.", a full stop): the name starts after that.
		at := from + zoneCloserRe.FindStringIndex(text[from:end])[1]
		name := cleanDesignation(text[at:end])
		if name == "" || designationWordRe.MatchString(name) || CoordRe.MatchString(name) {
			continue
		}
		zones[len(zones)-1].lateral = text[start:at]
		zones = append(zones, atsZone{desig: name})
		start = end
	}
	zones[len(zones)-1].lateral = text[start:]
	return zones
}

// zoneCloserRe is what ends the previous zone's limits before the next
// one's name: punctuation and "to (the) point of origin".
var zoneCloserRe = regexp.MustCompile(`(?i)^[\s.,;:)\-–]*(?:to\s+(?:the\s+)?point\s+of\s+(?:the\s+)?origin[\s.,;:)\-–]*)?`)

// cleanDesignation tidies a designation: the punctuation around it and
// the lead-in words a State puts between it and the geometry.
func cleanDesignation(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimSuffix(s, ":")
	s = strings.Trim(s, " .,;:-–/")
	return NormSpace(s)
}

// trimDesignation ends a designation at its kind, which a State may
// restate in words after the abbreviation (Avians' "Reykjavík CTR Control
// Zone, ATZ Aerodrome Traffic Zone"). A designation LED by its kind keeps
// the name after it (ANS CR's "ATZ České Budějovice", "MCTR ČÁSLAV").
func trimDesignation(s string) string {
	m := atsTypeRe.FindStringIndex(s)
	if m == nil || strings.TrimSpace(s[:m[0]]) == "" {
		return s
	}
	end := m[1] + zoneQualRe.FindStringIndex(s[m[1]:])[1]
	return cleanDesignation(s[:end])
}

// englishDesignation is the English half of a designation a bilingual
// State prints in both languages ("Egilsstaðir vallarsvið / Egilsstadir
// Aerodrome Traffic Zone (ATZ)"): the last half naming the kind.
func englishDesignation(s string) string {
	parts := strings.Split(s, " / ")
	for i := len(parts) - 1; i > 0; i-- {
		if atsTypeRe.MatchString(parts[i]) {
			return strings.TrimSpace(strings.Join(parts[i:], " / "))
		}
	}
	return s
}

// ATSAirspace reads an aerodrome's ATS airspace. ap is the aerodrome
// ReadAerodrome read off the same page: its reference point stands in for
// a circle "centred on the ARP" that prints no coordinate, its name names
// a zone published without one, and its radios are what the zone's unit
// answers on. spec is the State's zone spec, for the border ring and the
// references a limit may name.
func ATSAirspace(doc *Node, ap aixm5.Airport, spec ZoneSpec, st *ZoneStats) []aixm5.Airspace {
	sec := "17"
	if ap.Type == "HP" {
		sec = "16"
	}
	tables := ADSectionTables(doc, ap.Designator)[sec]
	if len(tables) == 0 {
		return nil
	}
	spec.PointRadiusM = 0
	var out []aixm5.Airspace
	for _, r := range atsRecords(tables) {
		zones := splitATSZones(r.lateral, r.head)
		if len(zones) == 0 {
			st.SkippedTypes["AD 2.17 NO GEOMETRY"]++
			continue
		}
		nameParts(zones)
		names := make([]string, len(zones))
		for i, z := range zones {
			names[i] = z.desig
		}
		limits := atsLimits(r.vertical, names, r.msl, st)
		radio := atsRadio(ap.Radio, r.callSign, len(zones))
		for i, z := range zones {
			a, ok := atsZoneAirspace(z, i, names, limits, r, ap, spec, st)
			if !ok {
				continue
			}
			a.Radio = radio
			out = append(out, a)
		}
	}
	return out
}

// zonePartsRe is the parts a designation says the zone is made of:
// ROMATSA's "BRAȘOV CTR (CTR1+CTR2+CTR3)", each part's lateral limits then
// set under a bare "CTR 1", "CTR 2", "CTR 3".
var zonePartsRe = regexp.MustCompile(`\s*\((?:[A-Z]+\s*\d{1,2}[A-Z]?\s*\+\s*)+[A-Z]+\s*\d{1,2}[A-Z]?\)`)

// barePartRe is a designation that is a kind and a part's number alone.
var barePartRe = regexp.MustCompile(`(?i)^(M?CTR|M?ATZ|TIZ|TIA|FIZ|RMZ|TMZ)\s*(\d{1,2}[A-Z]?)$`)

// nameParts names each part of a zone listed as parts after the place the
// whole is named after: "BRAȘOV CTR 1", "BRAȘOV CTR 2". Read as printed,
// the first part was the whole and the others a bare "CTR".
func nameParts(zones []atsZone) {
	first := zones[0].desig
	loc := zonePartsRe.FindStringIndex(first)
	if loc == nil {
		return
	}
	whole := first[:loc[0]]
	m := atsTypeRe.FindStringIndex(whole)
	if m == nil {
		return
	}
	place := strings.TrimSpace(whole[:m[0]])
	if place == "" {
		return
	}
	for i := range zones {
		d := zones[i].desig
		if i == 0 {
			d = strings.TrimSpace(first[loc[1]:])
		}
		if pm := barePartRe.FindStringSubmatch(d); pm != nil {
			zones[i].desig = place + " " + strings.ToUpper(pm[1]) + " " + pm[2]
		}
	}
}

// atsZoneAirspace builds one zone.
func atsZoneAirspace(z atsZone, i int, names []string, limits [][2]*aixm5.VerticalLimit, r atsRecord, ap aixm5.Airport, spec ZoneSpec, st *ZoneStats) (aixm5.Airspace, bool) {
	desig := z.desig
	if spec.Bilingual {
		desig = englishDesignation(desig)
	}
	desig = trimDesignation(desig)
	var upper, lower *aixm5.VerticalLimit
	if i < len(limits) {
		upper, lower = limits[i][0], limits[i][1]
	}
	class := atsClass(r.class, names, i)
	typ := atsType(desig)
	name := desig
	if typ == "" {
		// A zone the section does not type is the aerodrome's control
		// zone only when it is controlled, rises from the surface, and
		// its designation, if any, names nothing else: AirNav prints
		// Dublin's limits with no designation at all, and KANS
		// "PRISTINA Area bounded by lines joining points".
		if !strings.Contains("ABCDE", class) || class == "" || !fromSurface(lower) || notCTRWordRe.MatchString(desig) {
			st.SkippedTypes["AD 2.17 UNTYPED"]++
			return aixm5.Airspace{}, false
		}
		typ = "CTR"
		if name == "" {
			name = ctrPlace(ap.Name)
		}
		name += " CTR"
		st.ADInferredCTR++
	}
	ring := ZoneRing(arpCentre(z.lateral, ap), spec, st)
	if len(ring) < 3 {
		st.SkippedTypes["AD 2.17 NO GEOMETRY"]++
		return aixm5.Airspace{}, false
	}
	id := spec.IDPrefix + "-" + Slug(name)
	return aixm5.Airspace{
		ID:         id,
		Designator: id,
		Name:       name,
		Type:       typ,
		ClassCode:  class,
		UpperLimit: upper,
		LowerLimit: lower,
		Ring:       ring,
		WorkHr:     nilText(r.hours),
		Rmk:        nilText(r.rmk),
	}, true
}

// placeSuffixRe is a word an aerodrome's name carries that its control
// zone's does not.
var placeSuffixRe = regexp.MustCompile(`(?i)\s+(?:INTERNATIONAL|INTL|AIRPORT|AERODROME|AIRFIELD)$`)

// ctrPlace is the place a control zone printed with no designation is
// named after: the aerodrome's city, AirNav's "DUBLIN INTERNATIONAL" the
// DUBLIN CTR of its chart, SMATSA's "BEOGRAD/Nikola Tesla" BEOGRAD.
func ctrPlace(name string) string {
	if i := strings.Index(name, "/"); i > 0 {
		name = name[:i]
	}
	name = strings.TrimSpace(name)
	for {
		t := placeSuffixRe.ReplaceAllString(name, "")
		if t == name || t == "" {
			break
		}
		name = t
	}
	return strings.ToUpper(name)
}

// fromSurface reports a lower limit at the surface, or none stated: an
// aerodrome's zone printed with one figure rises from the ground to it.
func fromSurface(v *aixm5.VerticalLimit) bool {
	if v == nil {
		return true
	}
	switch strings.ToUpper(v.Value) {
	case "GND", "SFC", "0":
		return true
	}
	return false
}

// nilTextRe is an item a State fills with its word for nothing.
var nilTextRe = regexp.MustCompile(`(?i)^(?:NIL|N/A|NONE|-+|—)\.?$`)

func nilText(s string) string {
	s = strings.TrimSpace(s)
	if nilTextRe.MatchString(s) {
		return ""
	}
	return s
}

// arpRefRe is a centre given as the aerodrome reference point with no
// coordinate after it: SMATSA's "centered at ARP .", BHANSA's "centered
// on ARP AD LQBK;".
var arpRefRe = regexp.MustCompile(`(?i)\bARP\b(?:\s+AD)?(?:\s+([A-Z]{4})\b)?`)

// arpCentre writes the page's own reference point in where a limit names
// it as a centre without its coordinate, and leaves every other ARP: one
// naming another aerodrome, or one followed by its coordinate (NAV
// Portugal's "centred at ARP (365826N 0251016W)").
func arpCentre(lateral string, ap aixm5.Airport) string {
	var b strings.Builder
	last := 0
	for _, m := range arpRefRe.FindAllStringSubmatchIndex(lateral, -1) {
		if m[2] >= 0 && lateral[m[2]:m[3]] != ap.Designator {
			continue
		}
		if !centreTailRe.MatchString(lateral[:m[0]]) {
			continue
		}
		if next := lateral[m[1]:min(len(lateral), m[1]+25)]; CoordRe.MatchString(next) {
			continue
		}
		b.WriteString(lateral[last:m[0]])
		b.WriteString(FormatCoord(ap.Lat, ap.Lon))
		last = m[1]
	}
	b.WriteString(lateral[last:])
	return b.String()
}

// FormatCoord writes a position in the compact form the parsers read,
// seconds to the hundredth: "481012.00N 0171246.00E".
func FormatCoord(lat, lon float64) string {
	return dms(lat, 2, "N", "S") + " " + dms(lon, 3, "E", "W")
}

func dms(v float64, degDigits int, pos, neg string) string {
	h := pos
	if v < 0 {
		h, v = neg, -v
	}
	cs := int(math.Round(v * 360000))
	d, cs := cs/360000, cs%360000
	m, cs := cs/6000, cs%6000
	return fmt.Sprintf("%0*d%02d%02d.%02d%s", degDigits, d, m, cs/100, cs%100, h)
}

// atsLimitsCleanRe drops what a vertical-limits item carries beside the
// limits: the metric twin in brackets ("2000 FT ALT (600 M)").
var atsLimitsCleanRe = regexp.MustCompile(`(?i)\(\s*\d[\d ,.]*\s*M\s*\)`)

// altRefRe is ICAO's ALT, an altitude above mean sea level, after a figure
// (HungaroControl's "3500 FT ALT / GND", NAV Portugal's "2000 FT ALT").
var altRefRe = regexp.MustCompile(`(?i)(\d\s*(?:FT|M))\s+ALT\b`)

// atsLimits reads the vertical limits for each zone of a record: every
// zone's own pair where the item names them one by one, the pairs in order
// where it lists as many as there are zones, else one pair for all. A
// single figure is the ceiling, the zone rising from the surface.
func atsLimits(text string, names []string, msl bool, st *ZoneStats) [][2]*aixm5.VerticalLimit {
	text = altRefRe.ReplaceAllString(atsLimitsCleanRe.ReplaceAllString(NormSpace(text), ""), "$1 AMSL")
	n := len(names)
	out := make([][2]*aixm5.VerticalLimit, n)
	if nilText(text) == "" {
		return out
	}
	if n > 1 {
		if segs, ok := namedSegments(text, names); ok {
			for i, s := range segs {
				out[i] = atsPair(s, msl, st)
			}
			return out
		}
		if lims := limitTokens(text); len(lims) == 2*n {
			for i := range out {
				u, l := lims[2*i], lims[2*i+1]
				if OrderLimits(&u, &l) {
					st.LimitsSwapped++
				}
				out[i] = [2]*aixm5.VerticalLimit{withRef(u, msl), withRef(l, msl)}
			}
			return out
		}
	}
	p := atsPair(text, msl, st)
	for i := range out {
		out[i] = p
	}
	return out
}

// namedSegments cuts a text at each zone's name, when every name is there
// and in order: HungaroControl's "DEBRECEN TIZ1: 2 000 FT ALT / GND
// DEBRECEN TIZ2: 9 500 FT ALT / 2 000 FT ALT ...".
func namedSegments(text string, names []string) ([]string, bool) {
	up := strings.ToUpper(text)
	at := make([]int, len(names))
	from := 0
	for i, n := range names {
		n = strings.ToUpper(strings.TrimSpace(n))
		if n == "" {
			return nil, false
		}
		j := strings.Index(up[from:], n)
		if j < 0 {
			return nil, false
		}
		at[i] = from + j + len(n)
		from = at[i]
	}
	segs := make([]string, len(names))
	for i := range names {
		end := len(text)
		if i+1 < len(names) {
			end = at[i+1] - len(strings.TrimSpace(names[i+1]))
		}
		segs[i] = text[at[i]:end]
	}
	return segs, true
}

// atsPair reads one zone's limits: labelled ("Upper limit: FL115 Lower
// limit: GND", Avians' "Efri mörk / Upper Limit: 3000 FT AMSL Neðri mörk:
// Jörð / Lower Limit: SFC"), a pair either way up ("5 000 ft AMSL / GND",
// "GND - 5500 FT AMSL", "SFC to 1500FT AMSL", Fintraffic's "1300 FT MSL
// SFC"), or a single figure, the ceiling.
func atsPair(text string, msl bool, st *ZoneStats) [2]*aixm5.VerticalLimit {
	var upper, lower *aixm5.VerticalLimit
	if _, u, l, ok := splitLabelledLimits(text); ok {
		upper, lower = firstLimit(u), firstLimit(l)
	} else {
		switch lims := limitTokens(text); len(lims) {
		case 0:
			return [2]*aixm5.VerticalLimit{}
		case 1:
			upper = lims[0]
		case 2:
			upper, lower = lims[0], lims[1]
		default:
			st.LimitsUnparsed++
			return [2]*aixm5.VerticalLimit{}
		}
	}
	if upper != nil && lower == nil {
		lower = &aixm5.VerticalLimit{Value: "GND"}
	}
	if upper != nil && lower != nil && OrderLimits(&upper, &lower) {
		st.LimitsSwapped++
	}
	return [2]*aixm5.VerticalLimit{withRef(upper, msl), withRef(lower, msl)}
}

// limitTokens reads every limit a text states, in order.
func limitTokens(text string) []*aixm5.VerticalLimit {
	spans := limitSpans(text)
	var out []*aixm5.VerticalLimit
	for i, sp := range spans {
		end := len(text)
		if i+1 < len(spans) {
			end = spans[i+1][0]
		}
		if v := ParseVLimit(trimLimitText(text[sp[0]:end])); v != nil {
			out = append(out, v)
		} else if v := firstLimit(text[sp[0]:end]); v != nil {
			out = append(out, v)
		}
	}
	return out
}

// firstLimit reads the first limit a text states, whatever follows it.
//
// Its callers hand it one labelled value, which is ONE limit, so a
// surface word straight after a height is that height's reference and no
// second limit: Avinor's "Lower limit: 3500 FT SFC" is 3500 ft above the
// surface, the AIXM reference spelt out. Read positionally, where a line
// break may have stood between them, the two stay two limits.
func firstLimit(s string) *aixm5.VerticalLimit {
	s = strings.TrimSpace(s)
	spans := limitSpans(s)
	if len(spans) == 0 {
		return nil
	}
	end := len(s)
	if len(spans) > 1 {
		end = spans[1][0]
		if surfaceWordRe.MatchString(s[spans[1][0]:spans[1][1]]) && heightRe.MatchString(strings.TrimSpace(s[spans[0][0]:spans[1][0]])) {
			end = spans[1][1]
		}
	}
	tok := trimLimitText(s[spans[0][0]:end])
	if v := ParseVLimit(tok); v != nil {
		return v
	}
	// The token runs into words: keep its figure, unit and reference.
	if m := leadLimitRe.FindString(tok); m != "" {
		return ParseVLimit(m)
	}
	return nil
}

// surfaceWordRe is a limit token that can also be a height's reference.
var surfaceWordRe = regexp.MustCompile(`(?i)^(?:SFC|GND)$`)

// leadLimitRe is the limit at the head of a longer text.
var leadLimitRe = regexp.MustCompile(`(?i)^(?:FL\s*\d+|UNL|GND|SFC|\d[\d ]*\s*(?:FT|M)\b(?:\s*(?:AMSL|MSL|ALT|QNH|AGL|ASFC|SFC|GND))?)`)

// withRef gives a height with no reference the one the column heading
// states.
func withRef(v *aixm5.VerticalLimit, msl bool) *aixm5.VerticalLimit {
	if v == nil || !msl || v.Ref != "" || (v.Unit != "FT" && v.Unit != "M") {
		return v
	}
	c := *v
	c.Ref = "MSL"
	return &c
}

// atsClassRe is one "Class X" statement, in English or a State's own
// word before it.
var atsClassRe = regexp.MustCompile(`(?i)\b(?:class|classe|klasa|flokkur)\s+([A-G])\b`)

// atsClass reads zone i's class: after its own name where the item names
// the zones, the i-th statement where there are as many as zones, else the
// one letter the item states (a second letter "outside hours" is what the
// zone becomes when the tower closes, and the first is its class).
func atsClass(text string, names []string, i int) string {
	n := len(names)
	if n > 1 {
		if segs, ok := namedSegments(text, names); ok {
			if c := ClassLetter(segs[i]); c != "" {
				return c
			}
		}
		if ms := atsClassRe.FindAllStringSubmatch(text, -1); len(ms) == n {
			return strings.ToUpper(ms[i][1])
		}
	}
	return ClassLetter(text)
}

// atsRadio is the aerodrome's channels the zone's unit answers on: those
// whose call sign the item names. A record describing several zones names
// several units (SMATSA gives VRŠAC's CTR its tower and its ATZ its
// radio), and then none is given, rather than the tower's channel to an
// information zone.
func atsRadio(radio []aixm5.RadioChannel, callSign string, zones int) []aixm5.RadioChannel {
	named := callKey(callSign)
	if named == "" {
		return nil
	}
	var out []aixm5.RadioChannel
	units := map[string]bool{}
	dup := map[string]bool{}
	for _, r := range radio {
		cs := callKey(r.CallSign)
		if cs == "" || !strings.Contains(named, cs) {
			continue
		}
		units[cs] = true
		// The table repeats a channel under each of its hours or uses.
		if k := r.Freq + "|" + cs; !dup[k] {
			dup[k] = true
			out = append(out, r)
		}
	}
	if zones > 1 && len(units) > 1 {
		return nil
	}
	return out
}

// callKey is a call sign as compared: its letters upper-cased and their
// accents dropped, since an AD 2.17 and the AD 2.18 of the same page may
// spell one call sign differently ("Keflavík Tower", "KEFLAVIK TOWER";
// ROMATSA's "Brașov Tower" with a comma below and "Braşov Tower" with a
// cedilla), and ICAO's abbreviations spelt out ("Timişoara TWR",
// "Timişoara Tower").
func callKey(s string) string {
	var b strings.Builder
	space := false
	for _, r := range strings.ToUpper(s) {
		if f, ok := letterFold[r]; ok {
			r = f
		}
		switch {
		case r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			if space && b.Len() > 0 {
				b.WriteByte(' ')
			}
			b.WriteRune(r)
			space = false
		default:
			space = true
		}
	}
	words := strings.Fields(b.String())
	for i, w := range words {
		if full, ok := callWords[w]; ok {
			words[i] = full
		}
	}
	return strings.Join(words, " ")
}

// callWords are the ICAO abbreviations (Doc 8400) a call sign may be
// written with.
var callWords = map[string]string{
	"TWR":  "TOWER",
	"APP":  "APPROACH",
	"GND":  "GROUND",
	"INFO": "INFORMATION",
	"RDO":  "RADIO",
}

// letterFold is the base letter of each accented capital the cohort's
// languages write, for comparing call signs (callKey) and for ids (Slug).
var letterFold = func() map[rune]rune {
	m := map[rune]rune{}
	for base, set := range map[rune]string{
		'A': "ÀÁÂÃÄÅĀĂĄ", 'C': "ÇĆČ", 'D': "ĎĐÐ", 'E': "ÈÉÊËĒĖĘĚ", 'G': "Ğ",
		'I': "ÌÍÎÏĪĮİ", 'L': "ĹĽŁ", 'N': "ÑŃŇ", 'O': "ÒÓÔÕÖØŌŐ", 'R': "ŔŘ",
		'S': "ŚŠŞȘ", 'T': "ŤŢȚÞ", 'U': "ÙÚÛÜŪŮŰŲ", 'Y': "ÝŸ", 'Z': "ŹŻŽ",
	} {
		for _, r := range set {
			m[r] = base
		}
	}
	return m
}()

// DropRepublished leaves out the aerodrome zones an ENR section already
// publishes, which is common (KANS lists PRISTINA CTR in ENR 2.1 and in
// its AD 2.17): the same volume laterally, the two rings sharing at least
// four fifths of their union, and vertically, the same two limits. A
// zone the ENR publishes with other limits is another volume, as
// Fintraffic's FIZ UPPER in ENR 2.1 is to its FIZ LOWER in AD 2.17.
func DropRepublished(enr, ad []aixm5.Airspace) ([]aixm5.Airspace, int) {
	var out []aixm5.Airspace
	dropped := 0
	for _, a := range ad {
		twin := false
		for _, e := range enr {
			if sameLimits(a, e) && ringOverlap(a.Ring, e.Ring) >= 0.8 {
				twin = true
				break
			}
		}
		if twin {
			dropped++
			continue
		}
		out = append(out, a)
	}
	return out, dropped
}

// sameLimits compares two volumes' limits in feet, a surface floor
// however it is written.
func sameLimits(a, b aixm5.Airspace) bool {
	return sameLimit(a.UpperLimit, b.UpperLimit) && sameLimit(a.LowerLimit, b.LowerLimit)
}

func sameLimit(a, b *aixm5.VerticalLimit) bool {
	if fromSurface(a) && fromSurface(b) {
		return true
	}
	fa, oka := limitFt(a)
	fb, okb := limitFt(b)
	return oka && okb && math.Abs(fa-fb) <= 50
}

// ringOverlap is the share of their union two rings have in common,
// sampled on a grid over both.
func ringOverlap(a, b [][2]float64) float64 {
	if len(a) < 3 || len(b) < 3 {
		return 0
	}
	minLat, minLon, maxLat, maxLon := math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1)
	for _, r := range [][][2]float64{a, b} {
		for _, p := range r {
			minLat, maxLat = math.Min(minLat, p[0]), math.Max(maxLat, p[0])
			minLon, maxLon = math.Min(minLon, p[1]), math.Max(maxLon, p[1])
		}
	}
	const n = 48
	both, either := 0, 0
	for i := 0; i < n; i++ {
		lat := minLat + (maxLat-minLat)*(float64(i)+0.5)/n
		for j := 0; j < n; j++ {
			lon := minLon + (maxLon-minLon)*(float64(j)+0.5)/n
			ina, inb := inRing(a, lat, lon), inRing(b, lat, lon)
			if ina && inb {
				both++
			}
			if ina || inb {
				either++
			}
		}
	}
	if either == 0 {
		return 0
	}
	return float64(both) / float64(either)
}

// inRing is the even-odd point-in-polygon test on [lat, lon] pairs.
func inRing(ring [][2]float64, lat, lon float64) bool {
	in := false
	for i, j := 0, len(ring)-1; i < len(ring); j, i = i, i+1 {
		pi, pj := ring[i], ring[j]
		if (pi[0] > lat) != (pj[0] > lat) && lon < (pj[1]-pi[1])*(lat-pi[0])/(pj[0]-pi[0])+pi[1] {
			in = !in
		}
	}
	return in
}
