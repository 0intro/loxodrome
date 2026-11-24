// exclusions.go: the sectors a zone takes out of its volume ("à l'exclusion
// du secteur d'aérodrome de Condom", 228/2026), each defined elsewhere in the
// supplement with its own vertical limits.

package main

import (
	"math"
	"regexp"
	"slices"
	"strings"

	"github.com/0intro/loxodrome/internal/geodesy"
)

// An exclusion is a sector a zone's lateral limits take out of its volume,
// between the sector's own vertical limits, and only during its hours when
// the supplement prints some ("valables LS-CS", 107/2026).
type exclusion struct {
	name         string
	geom         *geometry
	bbox         []float64
	lower, upper []string
	hours        [][2]string // daily windows, clock times or sun codes, none for all day
}

// A sectorDef is a sector a supplement defines outside its zone tables, with
// the folded words a zone's exclusion text cites it by, and whether a
// heading naming exclusion sectors sets it.
type sectorDef struct {
	exclusion
	keys  []string
	under bool
}

// sectorHead is a heading over sector definitions ("Secteurs d'exclusion
// des aérodromes : SFC / 1500ft ASFC", 231/2026) at row: the limits it gives
// each definition under it that prints none of its own. It holds over the
// rows of its list (listRow).
type sectorHead struct {
	set          bool
	row          int
	lower, upper []string
}

// icaoNameRe opens a sector named for its aerodrome by code: "LFKE
// (Saint-Jean-en-Royans)".
var icaoNameRe = regexp.MustCompile(`^\s*LF[A-Z]{2}\b`)

// icaoRe is an aerodrome's code in parentheses, with the name before it:
// "Aubenasson (LFJF)", "la RMZ Valence (LFLU)" (207/2026).
var icaoRe = regexp.MustCompile(`([^,()]*?)\s*\((LF[A-Z]{2})\)`)

// listHeadRe ends the head of an aerodrome list, before its first name:
// "Des secteurs d'exclusion sont définis pour : - les aérodromes de".
var listHeadRe = regexp.MustCompile(`(?i)a.rodromes?\s*d(?:e|['’\x00-\x1f])|:\s*-?`)

// genericSectorsRe is a citation of a supplement's sectors as a class,
// naming none ("à l'exclusion des secteurs d'aérodromes définis en
// dispositions complémentaires", 231/2026), read on one clause's letters:
// the accents fall out, and a ligature "fi" with them.
var genericSectorsRe = regexp.MustCompile(`^(?:a?lexclusion)?(?:des|les)secteurs(?:dexclusion)?(?:d(?:es)?ae?rodromes?)?(?:de?(?:fi)?nis(?:en|dans)(?:les)?dispositionscomple?mentaires)?$`)

// bulletRe opens a clause of a citation listing several: "A l'exclusion :
// - des LF-D569 et LF-D595 ... - des secteurs ...".
var bulletRe = regexp.MustCompile(`(?:^|[\s:;,.])-`)

// foldedCoordRe is a coordinate in letters ("44°26'17"N" as "442617n"),
// which poppler sets into a citation from the column beside it.
var foldedCoordRe = regexp.MustCompile(`\d{4,7}[nsew]`)

// sfcSurface is the surface a sector's limits print in words: "du sol à
// 1500ft AGL".
var sfcSurface = []string{"HEI", "0", "FT"}

// arpRe finds the aerodrome a circle is centred on: "centré sur l'ARP de
// l'aérodrome de Corte (LFKT)" (106/2026).
var arpRe = regexp.MustCompile(`ARP[^()]*\(([A-Z]{4})\)`)

// leadCapsRe is the run of capitals a sector's name may open on, the word
// a zone cites it by: "CONDOM Valence sur Baïse" is the Condom sector.
var leadCapsRe = regexp.MustCompile(`^[A-Z]{4,}`)

// sectorDefs returns the sectors a supplement defines outside its zone
// tables (inZone marks the rows of those): a named circle on one row
// ("Séderon : Cercle de 2.5Nm de rayon centré sur 44°13'19″N,
// 005°30'20″E, de SFC à 1500 ft ASFC", 107/2026), one centred on an
// aerodrome's ARP (106/2026), or a ring whose vertex rows follow a head ending
// in a colon ("Belle Ile :", 002/2026). Its vertical limits are those its
// statement or the rows around its ring state, and its hours those of the
// heading above it. A sector whose limits do not read, or whose heading
// qualifies it with hours that do not, is left out, and the zones citing it
// keep it.
func sectorDefs(rows []prow, inZone []bool, nav navaidTable) []sectorDef {
	free := func(k int) bool { return k >= 0 && k < len(rows) && !inZone[k] }
	vertexRow := func(k int) bool {
		t := rows[k].text()
		return free(k) && !strings.Contains(t, ":") && (rowHasCoord(rows[k]) || isArcLine(fold(t)))
	}
	var defs []sectorDef
	var heading sectorHead
	for i := 0; i < len(rows); i++ {
		if !free(i) {
			heading = sectorHead{}
			continue
		}
		t := rows[i].text()
		f := letters(t)
		// One circle per aerodrome a list names, on its ARP: "les aérodromes
		// de Aubenasson (LFJF), La Motte-Chalancon (LFJE), ..." over "cercle
		// de 2nm de rayon centré sur l'ARP du sol à 1500ft AGL" (207/2026).
		if strings.Contains(fold(t), "cercle") && strings.Contains(t, "ARP") && !rowHasCoord(rows[i]) && !strings.Contains(t, ":") {
			defs = append(defs, arpListDefs(rows, inZone, free, i, nav, heading)...)
			continue
		}
		if strings.Contains(f, "exclusion") && !rowHasCoord(rows[i]) && !isArcLine(fold(t)) {
			lower, upper := parseVerticals([]string{t})
			heading = sectorHead{set: true, row: i, lower: lower, upper: upper}
			continue
		}
		head, rest, ok := strings.Cut(t, ":")
		if !ok {
			if !listRow(rows[i]) {
				heading = sectorHead{}
			}
			continue
		}
		var g *geometry
		var limits []string
		name, from := head, i
		switch {
		case isArcLine(fold(rest)):
			// The statement runs on to a next row that is no other
			// definition and holds no vertex: 106/2026's ARP and limits,
			// 201/2026's "AMSL".
			if next := i + 1; free(next) && !strings.Contains(rows[next].text(), ":") && !rowHasCoord(rows[next]) {
				rest += " " + rows[next].text()
				i = next
			}
			g = sectorCircle(rest, nav)
			limits = []string{rest}
		case strings.TrimSpace(rest) == "" && i+1 < len(rows) && vertexRow(i+1):
			j := i + 1
			for j < len(rows) && vertexRow(j) {
				j++
			}
			if g = sectorRing(rows[i+1 : j]); g == nil {
				continue
			}
			// The limits printed under the ring (001/2026), never the next
			// definition's head (207/2026), else on its head or the
			// paragraph above it.
			for _, k := range []int{j, i, i - 1, i - 2} {
				if free(k) && !(k == j && strings.Contains(rows[k].text(), ":")) {
					limits = append(limits, rows[k].text())
				}
			}
			// A sentence names its sector in the row above it, unless it
			// heads the sector's own code ("la RMZ Valence (LFLU) étendue
			// SFC/3500ft AMSL définie par", 207/2026), and a row printing
			// a coordinate is no name.
			if isSentenceHead(head) && !icaoRe.MatchString(head) && free(i-1) && len(scanCoords(rows[i-1].text())) == 0 {
				// "départs et arrivées ..., est défini ci- après :" ends the
				// paragraph whose first words name the sector: "CONDOM
				// Valence sur Baïse (LFID), un secteur, ..." (228/2026).
				name, from = rows[i-1].text(), i-1
			}
			i = j - 1
		default:
			heading = sectorHead{}
			continue
		}
		if g == nil {
			continue
		}
		lower, upper := parseVerticals(limits)
		if (lower == nil || upper == nil) && heading.set {
			lower, upper = heading.lower, heading.upper
		}
		if lower == nil || upper == nil {
			continue
		}
		hours, ok := sectorHours(rows, inZone, from, heading)
		if !ok {
			continue
		}
		codes := icaoRe.FindAllStringSubmatch(name, -1)
		name = sectorName(name)
		keys := sectorKeys(name)
		// A sector heading its aerodrome's code is cited by it too ("la
		// RMZ de Valence LFLU", 207/2026, for "la RMZ Valence (LFLU)").
		for _, c := range codes {
			keys = append(keys, strings.ToLower(c[2]))
		}
		if len(keys) == 0 {
			continue
		}
		defs = append(defs, sectorDef{exclusion{name, g, geomBbox(g), lower, upper, hours}, keys, heading.set})
	}
	return defs
}

// arpListDefs returns a circle on each aerodrome the rows above row i list
// by code, of the radius and limits row i states. The surface of "du sol"
// is SFC, and a heading over them gives the limits they print none of.
func arpListDefs(rows []prow, inZone []bool, free func(int) bool, i int, nav navaidTable, heading sectorHead) []sectorDef {
	t := rows[i].text()
	rm := radiusRe.FindStringSubmatch(t)
	if rm == nil {
		return nil
	}
	radiusM, err := geodesy.RadiusMeters(strings.ReplaceAll(rm[1], ",", "."), rm[2])
	if err != nil {
		return nil
	}
	lower, upper := parseVerticals([]string{t})
	if lower == nil && strings.Contains(letters(t), "dusol") {
		lower = sfcSurface
	}
	if (lower == nil || upper == nil) && heading.set {
		lower, upper = heading.lower, heading.upper
	}
	hours, ok := sectorHours(rows, inZone, i, heading)
	if lower == nil || upper == nil || !ok {
		return nil
	}
	var list string
	for k := i - 1; k >= max(0, i-3) && free(k) && !rowHasCoord(rows[k]); k-- {
		list = rows[k].text() + " " + list
	}
	var defs []sectorDef
	for _, m := range icaoRe.FindAllStringSubmatch(list, -1) {
		c, ok := nav[m[2]]
		if !ok {
			continue
		}
		name := m[1]
		if loc := listHeadRe.FindAllStringIndex(name, -1); loc != nil {
			name = name[loc[len(loc)-1][1]:]
		}
		name = strings.TrimSpace(strings.Trim(strings.TrimSpace(name), "-"))
		g := &geometry{kind: "circle", center: roundPt(c), radiusM: math.Round(radiusM)}
		keys := []string{strings.ToLower(m[2])}
		if k := letters(name); len(k) >= 4 {
			keys = append(keys, k)
		}
		defs = append(defs, sectorDef{exclusion{name + " (" + m[2] + ")", g, geomBbox(g), lower, upper, hours}, keys, heading.set})
	}
	return defs
}

// aerodromeNameRe names the aerodrome a sector is associated with, before
// its ICAO code: "l'aérodrome d'Ouessant (LFEC)" (077/2026), whose apostrophe
// the native text gives as a C0 byte.
var aerodromeNameRe = regexp.MustCompile(`a.rodrome\s*d(?:['’\x00-\x1f]|e\s)\s*([^()]+?)\s*\(([A-Z]{4})\)`)

// inlineSector reads a sector a zone's exclusion text states whole: "du
// secteur associé à l'aérodrome d'Ouessant (LFEC) suivant : cercle de 3 NM
// de rayon centré sur 48°27'48″ N, 005°03'49″ W SFC2500ft." (077/2026),
// its limits printed after its circle.
func inlineSector(text string) (exclusion, bool) {
	f := fold(text)
	if !isArcLine(f) || strings.Contains(letters(text), "valabl") {
		return exclusion{}, false
	}
	a, ok := arcFromCell(text, f)
	loc := arcKeywordRe.FindStringIndex(text)
	if !ok || !a.spec.circle || !a.hasCenter || len(a.lead) > 0 || loc == nil {
		return exclusion{}, false
	}
	lower, upper := parseVerticals([]string{text[loc[0]:]})
	if lower == nil || upper == nil {
		return exclusion{}, false
	}
	name := "secteur"
	if m := aerodromeNameRe.FindStringSubmatch(text); m != nil {
		name = strings.TrimSpace(m[1])
	}
	g := &geometry{kind: "circle", center: roundPt(a.spec.center), radiusM: math.Round(a.spec.radiusM)}
	return exclusion{name: name, geom: g, bbox: geomBbox(g), lower: lower, upper: upper}, true
}

// isSentenceHead reports whether a head ending in a colon is a sentence
// ("est défini ci- après", "délimité comme suit") rather than a name.
func isSentenceHead(s string) bool {
	if icaoNameRe.MatchString(s) {
		return false
	}
	f := letters(s)
	return strings.Contains(f, "dfini") || strings.Contains(f, "defini") ||
		strings.Contains(f, "dlimit") || strings.Contains(f, "delimit") || len(f) > 40
}

// sectorCircle reads the circle a sector's statement gives: its centre
// printed, or an aerodrome's ARP the navaid table places. An arc printed
// with a centre and no end points is its whole circle ("arc horaire de
// 1.50nm de rayon centré sur 44°26'17″ N,006°22'28″ E", 201/2026).
func sectorCircle(text string, nav navaidTable) *geometry {
	f := fold(text)
	if a, ok := arcFromCell(text, f); ok && a.hasCenter && len(a.lead) == 0 {
		return &geometry{kind: "circle", center: roundPt(a.spec.center), radiusM: math.Round(a.spec.radiusM)}
	}
	m := arpRe.FindStringSubmatch(text)
	rm := radiusRe.FindStringSubmatch(text)
	if m == nil || rm == nil {
		return nil
	}
	c, ok := nav[m[1]]
	radiusM, err := geodesy.RadiusMeters(strings.ReplaceAll(rm[1], ",", "."), rm[2])
	if !ok || err != nil {
		return nil
	}
	return &geometry{kind: "circle", center: roundPt(c), radiusM: math.Round(radiusM)}
}

// sectorRing builds the ring a sector's vertex rows print, arcs spliced in
// as a zone column's are.
func sectorRing(rs []prow) *geometry {
	// Each row is read whole: poppler sets an arc's centre over several
	// cells, its hemisphere letter apart ("... centré sur 46°43'03″" /
	// "N-002°23'33″" / "W(ARPLFEY)", 001/2026).
	lines := make([]prow, 0, len(rs))
	for _, r := range rs {
		if len(r.cells) > 0 {
			lines = append(lines, prow{y: r.y, cells: []cell{{x: r.cells[0].x, text: r.text()}}})
		}
	}
	if len(lines) == 0 {
		return nil
	}
	cx := lines[0].cells[0].x
	g := collectColumns(lines, []float64{cx})[cx]
	z, _, ok := buildZone("", g.verts, g.arcs, g.circles, "", nil, []float64{cx}, cx)
	if !ok {
		return nil
	}
	return z.geom
}

// sectorHours returns the daily windows a sector's heading gives it, read
// from the nearest row at or above row i that names an exclusion or a
// validity ("Zones d'exclusion en ZRT SAINT CHRISTOL APLHA valables LS-CS",
// 107/2026), back to the heading over its list, else over four rows. It
// reports false for a validity it cannot read.
func sectorHours(rows []prow, inZone []bool, i int, heading sectorHead) ([][2]string, bool) {
	stop := i - 4
	if heading.set {
		stop = heading.row
	}
	for k := i; k >= max(0, stop) && !inZone[k]; k-- {
		t := rows[k].text()
		f := letters(t)
		valid := strings.Contains(f, "valabl")
		if !valid && !strings.Contains(f, "exclusion") {
			continue
		}
		ws := windowsIn(t)
		if len(ws) == 0 && valid {
			return nil, false
		}
		return ws, true
	}
	return nil, true
}

// listRow reports whether row r continues a list of sector definitions: it
// prints a coordinate or half of one ("... centré sur 44°13'19″N," over
// "005°30'20″E SFC/1500ft ASFC"), or names an aerodrome by its code
// ("(LFHE), Saint Jean en Royans (LFKE),", 207/2026).
func listRow(r prow) bool {
	t := r.text()
	return coordRe.MatchString(t) || icaoRe.MatchString(t)
}

// sectorName trims a definition's head to the sector's name: what follows
// "secteur d'exclusion" ("Définition du secteur d'exclusion Corte"), up to
// the first parenthesis or comma ("CONDOM Valence sur Baïse (LFID), un
// secteur").
func sectorName(s string) string {
	if i := strings.LastIndex(strings.ToLower(s), "exclusion"); i >= 0 {
		s = s[i+len("exclusion"):]
	}
	// A name opening on its aerodrome's code keeps the town after it.
	if icaoNameRe.MatchString(s) {
		return strings.TrimSpace(strings.Trim(strings.TrimSpace(s), ":"))
	}
	if i := strings.IndexAny(s, "(,"); i >= 0 {
		s = s[:i]
	}
	return strings.TrimSpace(strings.Trim(strings.TrimSpace(s), ":-–"))
}

// sectorKeys returns the folded words a zone's exclusion text cites a
// sector by: its whole name ("belleile" for "Belle Ile", cited as
// "Belle-Ile") and the run of capitals it opens on ("condom").
func sectorKeys(name string) []string {
	var keys []string
	if k := letters(name); len(k) >= 4 {
		keys = append(keys, k)
	}
	if m := leadCapsRe.FindString(name); m != "" {
		// "CONDOMValencesurBaïse", jammed: the capital opening the next
		// word is no part of the run.
		if len(m) < len(name) && name[len(m)] >= 'a' && name[len(m)] <= 'z' {
			m = m[:len(m)-1]
		}
		if len(m) >= 4 {
			keys = append(keys, letters(m))
		}
	}
	return slices.Compact(keys)
}

// letters folds s to its lower-case ASCII letters and digits, the form in
// which a jammed native row and a spaced one compare.
func letters(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// attachExclusions gives each zone the sectors its exclusion text cites by
// name, and those a heading sets centred in the zone where it cites them as
// a class (genericSectors). A sector cited by name lying clear of the
// zone's box is a misreading and goes.
func attachExclusions(zones []zone, defs []sectorDef) []string {
	var warns []string
	for i := range zones {
		z := &zones[i]
		if z.exclText == "" || z.geom == nil {
			continue
		}
		if e, ok := inlineSector(z.exclText); ok && bboxesOverlap(z.bbox, e.bbox) {
			z.exclusions = append(z.exclusions, e)
		}
		ref := letters(z.exclText)
		cited := func(d sectorDef) bool {
			return slices.ContainsFunc(d.keys, func(k string) bool { return strings.Contains(ref, k) })
		}
		generic := genericSectors(z.exclText)
		for _, d := range defs {
			switch {
			case cited(d):
				if !bboxesOverlap(z.bbox, d.bbox) {
					warns = append(warns, "exclusion-outside-zone")
					continue
				}
			case generic && d.under:
				if !geomHolds(z.geom, geomCentre(d.geom)) {
					continue
				}
			default:
				continue
			}
			if slices.ContainsFunc(z.exclusions, func(e exclusion) bool { return e.name == d.name }) {
				continue
			}
			z.exclusions = append(z.exclusions, d.exclusion)
		}
	}
	return warns
}

// genericSectors reports whether an exclusion text cites the supplement's
// sectors as a class in one of its clauses, naming none.
func genericSectors(text string) bool {
	for _, c := range bulletRe.Split(text, -1) {
		if genericSectorsRe.MatchString(foldedCoordRe.ReplaceAllString(letters(c), "")) {
			return true
		}
	}
	return false
}

// geomCentre returns a circle's centre, else the middle of the geometry's
// box.
func geomCentre(g *geometry) latlon {
	if g.kind == "circle" {
		return g.center
	}
	b := geomBbox(g)
	return latlon{(b[0] + b[2]) / 2, (b[1] + b[3]) / 2}
}

// geomHolds reports whether point p lies in geometry g.
func geomHolds(g *geometry, p latlon) bool {
	switch g.kind {
	case "circle":
		return geodesy.DistanceM(g.center[0], g.center[1], p[0], p[1]) <= g.radiusM
	case "multipolygon":
		return slices.ContainsFunc(g.rings, func(r []latlon) bool { return ringHolds(r, p) })
	default:
		return ringHolds(g.ring, p)
	}
}

// ringHolds reports whether point p lies in ring r, by the crossings of a
// ray to the east.
func ringHolds(r []latlon, p latlon) bool {
	in := false
	for i, j := 0, len(r)-1; i < len(r); j, i = i, i+1 {
		a, b := r[i], r[j]
		if (a[0] > p[0]) != (b[0] > p[0]) && p[1] < a[1]+(p[0]-a[0])*(b[1]-a[1])/(b[0]-a[0]) {
			in = !in
		}
	}
	return in
}

// An excludedAirspace is an airspace a zone's lateral limits take out of it
// ("à l'exclusion de la LF-D595 lorsqu'elle est active", 107/2026): a P, R
// or D zone by its fr-airspaces.json id, or a zone of the same supplement by
// its name, and whether the text takes it out only while it is active.
type excludedAirspace struct {
	id, zone   string
	whenActive bool
}

// prdRe opens a P, R or D zone's designator, spaced, jammed or split over a
// row: "LF-R13A1", "LF-R 275", "LF- R14", "LFP225L".
var prdRe = regexp.MustCompile(`LF\s*-?\s*([PRD])\s*-?\s*(\d{1,4})`)

// partSepRe joins the parts a designator lists after its first: "LF-R13A1,A2,
// B1,B2 et C", "LF-R115A/B/C", "LF-R110A et B".
var partSepRe = regexp.MustCompile(`^\s*(?:,|/|&|et)\s*`)

// whileActiveRe, on a clause's letters, takes its airspaces out only while
// they are active: "lorsqu'elles sont actives", "si celle-ci est active".
var whileActiveRe = regexp.MustCompile(`(?:lorsqu|sicelle)[a-z]{0,30}activ`)

// clauseRe ends a clause of an exclusion text: a list item's dash, a
// semicolon, a sentence's end.
var clauseRe = regexp.MustCompile(`(?:^|[\s:;,.])-|;|\.\s`)

// excludeAirspaces gives each zone the airspaces its exclusion text cites:
// each P, R or D designator whose id ids holds, and each other zone of the
// supplement it names, with the condition of the clause citing it. A
// designator citing a group the dataset files only in parts ("LF-R84",
// filed as 84 A and 84 B) takes every part.
func excludeAirspaces(zones []zone, ids map[string]bool) {
	for i := range zones {
		z := &zones[i]
		if z.exclText == "" {
			continue
		}
		for _, c := range clauseRe.Split(z.exclText, -1) {
			active := whileActiveRe.MatchString(letters(c))
			add := func(e excludedAirspace) {
				e.whenActive = active
				if !slices.ContainsFunc(z.excluded, func(x excludedAirspace) bool { return x.id == e.id && x.zone == e.zone }) {
					z.excluded = append(z.excluded, e)
				}
			}
			for _, id := range designatorIDs(c, ids) {
				add(excludedAirspace{id: id})
			}
			for _, n := range zonesNamed(c, zones, i) {
				add(excludedAirspace{zone: n})
			}
		}
	}
}

// numberListRe continues a designator with another number of its kind:
// "LF-R 83, 106 et LF-P 234L" (174/2026).
var numberListRe = regexp.MustCompile(`^\s*(?:,|&|et)\s*(\d{1,4})`)

// designatorIDs returns the ids of the P, R and D zones text cites that ids
// holds, a list of numbers after one designator each of its kind.
func designatorIDs(text string, ids map[string]bool) []string {
	var out []string
	for _, m := range prdRe.FindAllStringSubmatchIndex(text, -1) {
		kind, num, at := text[m[2]:m[3]], text[m[4]:m[5]], m[1]
		for {
			got, n := numberParts(kind, num, text[at:], ids)
			out = append(out, got...)
			at += n
			l := numberListRe.FindStringSubmatchIndex(text[at:])
			if l == nil || at+l[1] < len(text) && text[at+l[1]] >= '0' && text[at+l[1]] <= '9' {
				break
			}
			num, at = text[at+l[2]:at+l[3]], at+l[1]
		}
	}
	return slices.Compact(out)
}

// numberParts returns the ids a designator of kind and number num cites,
// num read as printed or as the dataset files it (LF-P47 is LFP047), and
// the bytes of rest its parts took.
func numberParts(kind, num, rest string, ids map[string]bool) ([]string, int) {
	for _, n := range numberForms(num) {
		if got, used := designatorParts("LF"+kind+n, rest, ids); len(got) > 0 {
			return got, used
		}
	}
	return nil, 0
}

// numberForms returns the forms a designator's number takes in an id: as
// printed, without its leading zeros, and on three figures.
func numberForms(num string) []string {
	forms := []string{num}
	if t := strings.TrimLeft(num, "0"); t != num && t != "" {
		forms = append(forms, t)
	}
	if len(num) < 3 {
		forms = append(forms, strings.Repeat("0", 3-len(num))+num)
	}
	return forms
}

// designatorParts returns the ids a designator opening on base cites, and
// the bytes of rest they took: the part rest prints after it and the parts
// it lists on ("A1,A2,B1", "A/B/C", "A et B", the jammed "CD,E" of
// 077/2026), else base, else every part of base the dataset files (a group
// cited whole, "LF-R84").
func designatorParts(base, rest string, ids map[string]bool) ([]string, int) {
	id, n := partID(base, rest, ids)
	switch {
	case id == "" && ids[base]:
		return []string{base}, 0
	case id == "":
		return partsOf(base, ids), 0
	}
	out := []string{id}
	used := n
	rest = rest[n:]
	for {
		sep := partSepRe.FindString(rest)
		jammed := len(id) == len(base)+1 && rest != "" && rest[0] >= 'A' && rest[0] <= 'Z'
		if sep == "" && !jammed {
			break
		}
		next, n := partID(base, rest[len(sep):], ids)
		if next == "" {
			break
		}
		out = append(out, next)
		used += len(sep) + n
		id, rest = next, rest[len(sep)+n:]
	}
	return out, used
}

// jammedWordRe opens the word that may follow a designator's part with no
// space: "LF-R64Blorsqu'elle", "LF-R231Aet des".
var jammedWordRe = regexp.MustCompile(`^(?:et|lorsqu|qui|si|sauf)`)

// partID reads the part a designator prints after base at the start of
// rest ("A1", "LOW", "/2", " A"), the longest that makes an id ids holds,
// and returns that id and the bytes it took. A capital opening a word
// ("Baccarat", "Reinhardsmunster") is no part, one before a word
// jammedWordRe opens is.
func partID(base, rest string, ids map[string]bool) (string, int) {
	lead := len(rest) - len(strings.TrimLeft(rest, " "))
	if lead > 1 {
		return "", 0
	}
	var part []byte
	for k := lead; k < len(rest) && len(part) < 4; k++ {
		c := rest[k]
		upper := c >= 'A' && c <= 'Z'
		if !upper && (c < '0' || c > '9') && c != '/' {
			break
		}
		if upper && k+1 < len(rest) && rest[k+1] >= 'a' && rest[k+1] <= 'z' && !jammedWordRe.MatchString(rest[k+1:]) {
			break
		}
		part = append(part, c)
	}
	for n := len(part); n > 0; n-- {
		if id := base + string(part[:n]); ids[id] {
			return id, lead + n
		}
	}
	return "", 0
}

// partsOf returns the ids ids holds for base's parts: base and a part
// opening on a capital or a slash ("LFR84A", "LFR205/2", never "LFR840").
func partsOf(base string, ids map[string]bool) []string {
	var out []string
	for id := range ids {
		if rest, ok := strings.CutPrefix(id, base); ok && rest != "" && (rest[0] == '/' || rest[0] >= 'A' && rest[0] <= 'Z') {
			out = append(out, id)
		}
	}
	slices.Sort(out)
	return out
}

// zonesNamed returns the names of the zones text names other than zones[self],
// each matched on its folded name, a name the next figure would extend
// ("ZRT 1" in "ZRT 12") excepted.
func zonesNamed(text string, zones []zone, self int) []string {
	f := letters(text)
	var out []string
	for j, z := range zones {
		key := letters(z.name)
		if j == self || len(key) < 4 {
			continue
		}
		for at := 0; ; {
			k := strings.Index(f[at:], key)
			if k < 0 {
				break
			}
			end := at + k + len(key)
			if end == len(f) || f[end] < '0' || f[end] > '9' {
				out = append(out, z.name)
				break
			}
			at = end
		}
	}
	return out
}

// bboxesOverlap reports whether two [minLat, minLon, maxLat, maxLon] boxes
// meet.
func bboxesOverlap(a, b []float64) bool {
	return len(a) == 4 && len(b) == 4 && a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]
}
