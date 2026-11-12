// supaip_geom.go: the ONE bilingual grammar that turns a linearized
// supplement body (supaip_blocks.go) into drawable zones, used by the
// HTML editions and the pdftotext fallback alike.
//
// The rule that keeps a NOTAM viewer honest: geometry is harvested only
// inside a zone scope, and inside a scope only from paragraphs and list
// items (and, in obstacle-table scope, from the table's own coordinate
// column). An AIRAC supplement's instrument-procedure annexes print
// waypoint coordinates in real tables ("COORDENADAS WAYPOINTS", the
// tabular procedure description, the holding table); a whole-document
// coordinate sweep would turn LULER and SIE into airspace. Every zone a
// scope produces must have geometry to be emitted at all, so the section
// headings the annexes bring with them fall away on their own.
//
// ENAIRE publishes each supplement in Spanish OR English, so every
// marker below is matched folded (accent- and case-insensitive) against
// both vocabularies.

package main

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/eaip"
)

const (
	// supCircleFloorM keeps a position-only zone (an obstacle table row)
	// visible and clickable: the supaip layer draws L.circle(radiusM)
	// and hit-tests distance <= radiusM, so radius 0 would be invisible.
	// Same floor and reason as cmd/be.
	supCircleFloorM = 500.0

	// arcStepDeg is the angular resolution of a polygonized arc.
	arcStepDeg = 5.0

	// radiusTolerance bounds how far a stated semicircle radius may sit
	// from the measured centre-to-endpoint distance before the layout is
	// declared unreadable. A wrong arc is worse than no arc.
	radiusTolerance = 0.15
)

// Spain's territory, the outer sanity box for every parsed vertex:
// peninsula and Balearics (lat 35.9..43.8, lon -9.3..4.4) plus the
// Canaries (lat 27.6..29.5, lon -18.2..-13.3). A pair outside it is a
// misread, most often a swapped latitude and longitude.
const (
	esMinLat, esMaxLat = 27.0, 45.0
	esMinLon, esMaxLon = -19.0, 5.0
)

var (
	// The zone-scope markers. "Limites laterales" arrives as a bold
	// paragraph, an <h4>, or an inline "Limites laterales: <coords>".
	lateralMarkerRe  = regexp.MustCompile(`^(?:limites laterales|limite lateral|lateral limits?|horizontal limits?)\b`)
	verticalMarkerRe = regexp.MustCompile(`^(?:limites verticales|limite vertical|vertical limits?)\b`)

	// An exclusion is phrased exactly like a defining circle, so it is
	// tested first and its coordinates are never harvested.
	exclusionRe = regexp.MustCompile(`\b(?:excepto|except|excluyendo|excluding|salvo)\b`)

	semicircleRe = regexp.MustCompile(`\bsemicirculo|semi-?circle\b`)
	circleRe     = regexp.MustCompile(`\bcirculo|circle\b`)
	radiusRe     = regexp.MustCompile(`(\d+(?:[.,]\d+)?)\s*(nm|km|m)\b`)
	// The figure standing NEXT to the word radius, preferred over the first
	// number-and-unit in the paragraph ("hasta 120 m AGL, en un circulo de
	// 1 KM de radio" must read 1 km, not 120 m).
	radiusAdjRe = regexp.MustCompile(
		`(\d+(?:[.,]\d+)?)\s*(nm|km|m)\s+(?:de\s+)?radi[ou]s?\b|\bradi[ou]s?\s+(?:de\s+|of\s+)?(\d+(?:[.,]\d+)?)\s*(nm|km|m)\b`)
	centreLabelRe  = regexp.MustCompile(`^(?:centro|centre|center)\b`)
	extremeLabelRe = regexp.MustCompile(`^(?:extremo|extreme|end)\b`)

	// A CORRIDOR: a half-width each side of the line joining the vertices
	// that follow ("2 NM a cada lado de la linea que une las siguientes
	// coordenadas:", "5 NM either side of the line joining ..."). Those
	// vertices are a CENTRELINE, never a ring: a triangle drawn from them
	// covered 112 km2 with its interior outside the real 3.7 km band, while
	// the corridor itself stayed undrawn (147/2026, TC ETAP SAN GREGORIO).
	corridorRe = regexp.MustCompile(
		`(\d+(?:[.,]\d+)?)\s*(nm|km|m)\s+(?:a\s+cada\s+lado|a\s+ambos\s+lados|(?:on\s+)?either\s+side|(?:on\s+)?each\s+side)\b`)

	// The widest radius a supplement zone plausibly states: an English
	// edition writing "1.852 KM" for one nautical mile would otherwise
	// normalise to 1852 km and draw a continent.
	maxRadiusM = 50_000.0

	// coordDecimalCommaRe and coordSpacedHemiRe normalise two printed
	// forms CoordRe does not read: decimal-comma seconds ("413435,08N")
	// and a space before the hemisphere letter ("0033637.05 W").
	coordDecimalCommaRe = regexp.MustCompile(`(\d),(\d{1,2})([NSEW])`)
	coordSpacedHemiRe   = regexp.MustCompile(`(\d)\s+([NSEW])\b`)

	// Obstacle tables: a coordinate column beside a height column. The
	// height column is what tells them from the annex "WPT | COORD"
	// table, which has no height and must not become airspace.
	obstCoordColRe = regexp.MustCompile(`^(?:coord|coordenadas?|coordinates?|position|posicion)\b`)
	// A pair split over two columns: "COORD | COORD" (178/2024, latitude
	// then longitude under one repeated header) or "LAT | LONG".
	obstLatColRe = regexp.MustCompile(`^(?:lat|latitud|latitude)\b`)
	obstLonColRe = regexp.MustCompile(`^(?:lon|long|longitud|longitude)\b`)
	// HGT is the height above ground the zone's upper limit takes; ELEV
	// is the elevation beside it and is deliberately not a match. HTG is
	// the source's own typo (075/2026), five turbines lost to it.
	obstHeightColRe = regexp.MustCompile(`^(?:hgt|htg|height|altura)\b`)
	obstUnitRe      = regexp.MustCompile(`\((m|ft)[^)]*\)`)
	// Columns that never name an obstacle: a time window, a date, the
	// elevation beside the height.
	obstNotIdColRe = regexp.MustCompile(`^(?:elev|lat|long|hora|hour|fecha|date|time|periodo|period|obs)\b`)
)

// normCoordText prepares a text for CoordRe: whitespace normalised, a
// decimal comma in the seconds turned into a point and a space before the
// hemisphere letter removed, both forms the corpus prints and neither of
// which the shared pattern reads.
func normCoordText(s string) string {
	s = eaip.NormSpace(s)
	s = coordDecimalCommaRe.ReplaceAllString(s, "$1.$2$3")
	s = coordSpacedHemiRe.ReplaceAllString(s, "$1$2")
	return s
}

// circleDef is a centre + radius before it becomes JSON.
type circleDef struct {
	name    string
	centre  [2]float64
	radiusM float64
	upper   any
}

// esZone is one drawable sub-area, in the shared row schema's shape.
type esZone struct {
	name   string
	geom   map[string]any
	bbox   []float64
	lower  any
	upper  any
	source string
}

// zoneAcc accumulates one zone scope: everything between two headings.
type zoneAcc struct {
	name    string
	subject string
	rings   [][][2]float64
	cur     [][2]float64

	// ringOK records that this scope declares a boundary: a "Limites
	// laterales" marker, a heading carrying the zone's vertical limits,
	// or an ordered vertex list. Coordinates in bare prose are NOT a
	// boundary on their own; a supplement naming the twelve power-line
	// beacons whose lights are out of service prints twelve positions in
	// a bulleted list, and joining them into a polygon would draw an
	// airspace the AIP never created.
	//
	// A scope that states VERTICAL limits authorises the ring too, and
	// is tested at build time because the statement follows the
	// coordinates ("se establece un corredor de transito en las
	// siguientes coordenadas: ... Limites verticales: FL145 - FL245").
	// A published volume always states how high it reaches; a list of
	// positions does not.
	ringOK bool
	// lateralDeclared records an explicit "Limites laterales" marker in
	// this scope: the one case where a BULLETED list is a vertex list
	// (the marker says so). Without it a <ul> is a set of positions,
	// whatever else the scope states.
	lateralDeclared bool
	// corridorHalfM > 0 turns the collected points into a CENTRELINE
	// buffered by this half-width, never a ring.
	corridorHalfM float64

	semi        bool
	semiRadiusM float64
	semiPts     [][2]float64

	circles []circleDef

	lower, upper any
	pendingVert  bool
}

// parseSupZones runs the grammar over a linearized body. subject names a
// zone the supplement did not name itself (a single-area supplement
// writes "Limites laterales:" under its own title and nothing else).
func parseSupZones(blocks []esBlock, subject string) ([]esZone, []string) {
	var out []esZone
	var warns []string
	warn := func(w string) {
		for _, have := range warns {
			if have == w {
				return
			}
		}
		warns = append(warns, w)
	}

	acc := &zoneAcc{name: subject, subject: subject}
	var obst *obstacleTable
	// An obstacle table recognised by its header but yielding no zone is
	// a table the row reader could not read (a header typo, an unread
	// coordinate form), and must say so rather than vanish.
	obstRows := 0
	closeObst := func() {
		if obst != nil && obstRows == 0 {
			warn("obstacle-table-unread")
		}
		obst = nil
		obstRows = 0
	}

	flush := func() {
		zones, ws := acc.build()
		out = append(out, zones...)
		for _, w := range ws {
			warn(w)
		}
		acc = &zoneAcc{name: acc.name, subject: subject}
	}

	for _, b := range blocks {
		txt := b.text
		f := fold(txt)

		// Table rows never carry prose markers; they are either an
		// obstacle table's own rows or an annex we must ignore.
		if b.kind == blockTableRow {
			if obst == nil {
				obst = detectObstacleTable(b.cells)
				continue
			}
			z, ok, w := obst.row(b.cells)
			if w != "" {
				warn(w)
			}
			if ok {
				out = append(out, z)
				obstRows++
			}
			continue
		}
		if obst != nil {
			closeObst()
		}

		switch {
		case lateralMarkerRe.MatchString(f):
			acc.closeRing()
			acc.ringOK = true
			acc.lateralDeclared = true
			acc.pendingVert = false
			// "Limites laterales: 4025N ..." puts the vertices on the
			// marker line itself.
			acc.addCoords(rest(txt))
			continue
		case verticalMarkerRe.MatchString(f):
			acc.closeRing()
			if !acc.setVerticals(rest(txt)) {
				// The template also writes the marker alone and the
				// values in the next paragraph.
				acc.pendingVert = true
			}
			continue
		}

		if b.kind == blockHeading {
			flush()
			name, vert := splitHeading(txt)
			acc.name = name
			if vert != "" {
				acc.setVerticals(vert)
				acc.ringOK = true
			}
			continue
		}

		if acc.pendingVert {
			acc.pendingVert = false
			if acc.setVerticals(txt) {
				continue
			}
		}

		// An exclusion is written as a circle; never harvest it. It also
		// ends any open run of vertices: a paragraph after it must not
		// silently extend the ring across the exclusion.
		if exclusionRe.MatchString(f) {
			acc.closeRing()
			warn("exclusion-not-modeled")
			continue
		}
		if m := corridorRe.FindStringSubmatch(f); m != nil {
			// The corridor sentence: its vertices follow (or sit on the
			// line itself); they are a centreline, and the scope is a
			// declared boundary.
			if r, ok := radiusFrom(m[1], m[2]); ok {
				acc.corridorHalfM = r
				acc.ringOK = true
			} else {
				warn("corridor-unreadable")
			}
			acc.addCoords(txt)
			continue
		}
		if semicircleRe.MatchString(f) {
			acc.semi = true
			if r, ok := parseRadiusM(f); ok {
				acc.semiRadiusM = r
			}
			// A semicircle phrase may carry its centre on the same line.
			acc.addCoords(txt)
			continue
		}
		if circleRe.MatchString(f) {
			if c, ok := parseCircle(txt, acc.name); ok {
				acc.circles = append(acc.circles, c)
			} else {
				// A circle the grammar cannot read must not fall through to
				// the vertex harvest: its centre would join the ring.
				warn("circle-unreadable")
			}
			continue
		}
		switch b.kind {
		case blockItem:
			// An ordered vertex list is itself a boundary declaration.
			acc.ringOK = true
		case blockBullet:
			// A bulleted list is a SET of positions, never a boundary,
			// unless an explicit lateral-limits marker opened this scope.
			if !acc.lateralDeclared {
				continue
			}
		}
		acc.addCoords(txt)
	}
	closeObst()
	flush()
	return out, warns
}

// rest returns what follows the first colon, or "" when there is none.
func rest(s string) string {
	if i := strings.Index(s, ":"); i >= 0 {
		return s[i+1:]
	}
	return ""
}

// splitHeading cuts "ZONA 1: SFC - 4000 ft AMSL MAX:" into its name and
// its vertical spec. A heading with no parseable spec after the colon
// keeps its whole text as the name ("DFN-26 ZONA E:").
func splitHeading(s string) (name, vert string) {
	s = strings.TrimSpace(s)
	i := strings.Index(s, ":")
	if i < 0 {
		return strings.TrimSpace(s), ""
	}
	name = strings.TrimSpace(s[:i])
	tail := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(s[i+1:]), ":"))
	if tail == "" {
		return name, ""
	}
	if _, _, ok := parseVerticalPair(tail); ok {
		return name, tail
	}
	return strings.TrimSuffix(s, ":"), ""
}

// addCoords appends every coordinate pair in s to the open ring, or, in
// semicircle scope, to the labelled-point list.
func (a *zoneAcc) addCoords(s string) {
	if strings.TrimSpace(s) == "" {
		return
	}
	ms := eaip.CoordRe.FindAllStringSubmatch(normCoordText(s), -1)
	if len(ms) == 0 {
		// Prose with no coordinates ends a run of vertices, so a later
		// paragraph cannot silently extend a closed ring.
		a.closeRing()
		return
	}
	for _, m := range ms {
		lat, lon, ok := eaip.ParsePair(m[1], m[2])
		if !ok {
			continue
		}
		p := [2]float64{lat, lon}
		if a.semi {
			a.semiPts = append(a.semiPts, p)
			continue
		}
		a.cur = append(a.cur, p)
	}
}

func (a *zoneAcc) closeRing() {
	if len(a.cur) > 0 {
		a.rings = append(a.rings, a.cur)
		a.cur = nil
	}
}

// setVerticals parses "SFC-FL100" / "GND-120 m AGL." and reports whether
// it read a pair.
func (a *zoneAcc) setVerticals(s string) bool {
	lo, up, ok := parseVerticalPair(s)
	if !ok {
		return false
	}
	a.lower, a.upper = lo, up
	return true
}

// build turns the accumulated scope into emittable zones.
func (a *zoneAcc) build() ([]esZone, []string) {
	a.closeRing()
	var out []esZone
	var warns []string

	if a.semi {
		ring, w := semicircleRing(a.semiPts, a.semiRadiusM)
		if w != "" {
			warns = append(warns, w)
		}
		if ring != nil {
			a.rings = append(a.rings, ring)
		}
	}

	if a.corridorHalfM > 0 {
		// The collected points are a CENTRELINE: buffer it. A ring drawn
		// from them would be the wrong airspace.
		var line [][2]float64
		for _, r := range a.rings {
			line = append(line, r...)
		}
		a.rings = nil
		if ring := corridorRing(line, a.corridorHalfM); ring != nil {
			a.rings = [][][2]float64{ring}
		} else {
			warns = append(warns, "corridor-too-short")
		}
	}

	var rings [][][2]float64
	if !a.ringOK && a.lower == nil && a.upper == nil {
		// Positions with neither a boundary declaration nor a vertical
		// extent: not an airspace.
		a.rings = nil
	}
	for _, r := range a.rings {
		clean, w := cleanRing(r)
		if w != "" {
			warns = append(warns, w)
		}
		if clean != nil {
			rings = append(rings, clean)
		}
	}

	name := zoneName(a.name, a.subject)
	polySource := "html-polygon"
	if a.corridorHalfM > 0 {
		polySource = "html-corridor"
	}

	switch {
	case len(rings) == 1:
		out = append(out, esZone{
			name:   name,
			geom:   map[string]any{"type": "polygon", "ring": ringJSON(rings[0])},
			bbox:   ringBbox(rings[0]),
			lower:  a.lower,
			upper:  a.upper,
			source: polySource,
		})
	case len(rings) > 1:
		var js []any
		var bbox []float64
		for _, r := range rings {
			js = append(js, ringJSON(r))
			bbox = unionBbox(bbox, ringBbox(r))
		}
		out = append(out, esZone{
			name:   name,
			geom:   map[string]any{"type": "multipolygon", "rings": js},
			bbox:   bbox,
			lower:  a.lower,
			upper:  a.upper,
			source: "html-polygon",
		})
	}

	for i, c := range a.circles {
		cn := name
		if len(a.circles) > 1 {
			cn = fmt.Sprintf("%s (%d)", name, i+1)
		}
		out = append(out, esZone{
			name:   cn,
			geom:   map[string]any{"type": "circle", "center": [2]float64{c.centre[0], c.centre[1]}, "radiusM": c.radiusM},
			bbox:   circleBbox(c.centre[0], c.centre[1], c.radiusM),
			lower:  a.lower,
			upper:  a.upper,
			source: "html-circle",
		})
	}
	return out, warns
}

// zoneName picks what the panel calls a zone. A published zone names
// itself briefly ("ZONA 1", "DFN-26 ZONA E", "AREA ETAP PIRINEOS
// (LETAPIRI)"); when the only heading in scope is a sentence of prose
// ("se establece un corredor de transito en las siguientes
// coordenadas:"), the supplement's own subject reads far better.
func zoneName(name, subject string) string {
	name = strings.TrimSpace(name)
	if name != "" && len(strings.Fields(name)) <= 8 {
		return name
	}
	if s := strings.TrimSpace(subject); s != "" {
		return s
	}
	if name != "" {
		return name
	}
	return "SUP AIP"
}

// cleanRing closes, de-duplicates and sanity-checks one ring. It returns
// nil (with a reason) rather than a doubtful polygon: an airspace drawn
// in the wrong place is the one output this pipeline must never produce.
func cleanRing(r [][2]float64) ([][2]float64, string) {
	var out [][2]float64
	for _, p := range r {
		if p[0] < esMinLat || p[0] > esMaxLat || p[1] < esMinLon || p[1] > esMaxLon {
			return nil, "vertex-outside-spain"
		}
		if n := len(out); n > 0 && out[n-1] == p {
			continue
		}
		out = append(out, p)
	}
	if len(out) > 1 && out[0] == out[len(out)-1] {
		out = out[:len(out)-1]
	}
	if len(out) < 3 {
		return nil, "ring-too-short"
	}
	if selfIntersects(out) {
		return nil, "ring-self-intersecting"
	}
	return append(out, out[0]), ""
}

// selfIntersects reports whether any two non-adjacent edges of the open
// ring cross: the signature of a misread column, which cmd/supaip drops
// for the same reason.
func selfIntersects(r [][2]float64) bool {
	n := len(r)
	for i := 0; i < n; i++ {
		a1, a2 := r[i], r[(i+1)%n]
		for j := i + 1; j < n; j++ {
			if j == i || (i == 0 && j == n-1) || j == i+1 {
				continue
			}
			b1, b2 := r[j], r[(j+1)%n]
			if segmentsCross(a1, a2, b1, b2) {
				return true
			}
		}
	}
	return false
}

func segmentsCross(p1, p2, q1, q2 [2]float64) bool {
	d1 := cross(q1, q2, p1)
	d2 := cross(q1, q2, p2)
	d3 := cross(p1, p2, q1)
	d4 := cross(p1, p2, q2)
	return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}

func cross(a, b, c [2]float64) float64 {
	return (b[1]-a[1])*(c[0]-a[0]) - (b[0]-a[0])*(c[1]-a[1])
}

// semicircleRing polygonizes the ENAIRE semicircle form: a centre, the
// two ends of the diameter and a third point naming the half that is
// meant. The endpoints are the pair whose bearings from the centre are
// nearest opposite, so the labels ("Extremo Oeste") need not be read.
func semicircleRing(pts [][2]float64, statedR float64) ([][2]float64, string) {
	if len(pts) != 4 {
		return nil, "semicircle-layout-unreadable"
	}
	centre, ext := pts[0], pts[1:]
	var brg [3]float64
	var dist [3]float64
	for i, p := range ext {
		brg[i] = bearingDeg(centre, p)
		dist[i] = distanceM(centre, p)
	}
	// The diameter pair: bearings closest to 180 degrees apart.
	bestI, bestJ, best := -1, -1, 1e9
	for i := 0; i < 3; i++ {
		for j := i + 1; j < 3; j++ {
			d := math.Abs(180 - angleDiff(brg[i], brg[j]))
			if d < best {
				best, bestI, bestJ = d, i, j
			}
		}
	}
	if best > 20 {
		return nil, "semicircle-layout-unreadable"
	}
	mid := 3 - bestI - bestJ
	r := statedR
	measured := (dist[bestI] + dist[bestJ]) / 2
	if r <= 0 {
		r = measured
	} else if measured > 0 && math.Abs(r-measured)/r > radiusTolerance {
		return nil, "semicircle-radius-mismatch"
	}
	ring := arcPoints(centre, r, brg[bestI], brg[bestJ], brg[mid])
	if len(ring) < 3 {
		return nil, "semicircle-layout-unreadable"
	}
	return ring, ""
}

// corridorRing buffers a centreline by halfM on each side: the left and
// right offset lines, joined at each interior vertex by a MITRE on the
// inside of the turn (the offset lines' intersection) and an arc on the
// outside, capped by semicircles at both ends. nil when the line has
// fewer than two distinct points. The result still goes through
// cleanRing: a turn too sharp for the width self-intersects and is
// refused rather than drawn wrong.
func corridorRing(line [][2]float64, halfM float64) [][2]float64 {
	var pts [][2]float64
	for _, p := range line {
		if n := len(pts); n > 0 && pts[n-1] == p {
			continue
		}
		pts = append(pts, p)
	}
	n := len(pts)
	if n < 2 || halfM <= 0 {
		return nil
	}
	brg := make([]float64, n-1)
	for i := 0; i < n-1; i++ {
		brg[i] = bearingDeg(pts[i], pts[i+1])
	}
	var left, right [][2]float64
	for i := 0; i < n-1; i++ {
		l0, l1 := destPoint(pts[i], norm360(brg[i]-90), halfM), destPoint(pts[i+1], norm360(brg[i]-90), halfM)
		r0, r1 := destPoint(pts[i], norm360(brg[i]+90), halfM), destPoint(pts[i+1], norm360(brg[i]+90), halfM)
		if i == 0 {
			left = append(left, l0)
			right = append(right, r0)
		}
		if i+1 < n-1 {
			// The turn at pts[i+1]: signed change of bearing, negative for a
			// left turn (the left side is then the INSIDE).
			turn := norm360(brg[i+1] - brg[i])
			if turn > 180 {
				turn -= 360
			}
			ln0, rn0 := destPoint(pts[i+1], norm360(brg[i+1]-90), halfM), destPoint(pts[i+1], norm360(brg[i+1]+90), halfM)
			if turn < 0 {
				left = append(left, mitre(pts[i+1], l0, l1, ln0, brg[i+1]))
				right = append(right, r1)
				right = append(right, shortArc(pts[i+1], halfM, norm360(brg[i]+90), norm360(brg[i+1]+90))...)
				right = append(right, rn0)
			} else {
				right = append(right, mitre(pts[i+1], r0, r1, rn0, brg[i+1]))
				left = append(left, l1)
				left = append(left, shortArc(pts[i+1], halfM, norm360(brg[i]-90), norm360(brg[i+1]-90))...)
				left = append(left, ln0)
			}
			continue
		}
		left = append(left, l1)
		right = append(right, r1)
	}
	last := brg[n-2]
	ring := append([][2]float64{}, left...)
	// The far cap, through the line's heading; the near cap, through its back.
	ring = append(ring, arcPoints(pts[n-1], halfM, norm360(last-90), norm360(last+90), last)[1:]...)
	for i := len(right) - 1; i >= 0; i-- {
		ring = append(ring, right[i])
	}
	first := brg[0]
	ring = append(ring, arcPoints(pts[0], halfM, norm360(first+90), norm360(first-90), norm360(first+180))[1:]...)
	return ring
}

// mitre is the inside join of two offset lines: where the segment a->b
// (the incoming offset) meets the outgoing offset through c at heading
// brg, computed on a local plane about the vertex. Falls back to c when
// the two run parallel.
func mitre(vertex, a, b, c [2]float64, brg float64) [2]float64 {
	cosLat := cosDeg(vertex[0])
	toXY := func(p [2]float64) (float64, float64) {
		return (p[1] - vertex[1]) * cosLat, p[0] - vertex[0]
	}
	ax, ay := toXY(a)
	bx, by := toXY(b)
	cx, cy := toXY(c)
	// Direction of the outgoing offset line: the heading, as a unit vector
	// in (x=east, y=north).
	dx, dy := math.Sin(rad(brg)), math.Cos(rad(brg))
	ex, ey := bx-ax, by-ay
	den := ex*dy - ey*dx
	if math.Abs(den) < 1e-12 {
		return c
	}
	t := ((cx-ax)*dy - (cy-ay)*dx) / den
	x, y := ax+t*ex, ay+t*ey
	return [2]float64{aip.Round5(vertex[0] + y), aip.Round5(vertex[1] + x/cosLat)}
}

// shortArc walks the shorter way round from bearing `from` to `to`,
// exclusive of both ends.
func shortArc(centre [2]float64, radiusM, from, to float64) [][2]float64 {
	d := norm360(to - from)
	if d > 180 {
		d -= 360
	}
	pts := arcPoints(centre, radiusM, from, to, norm360(from+d/2))
	if len(pts) <= 2 {
		return nil
	}
	return pts[1 : len(pts)-1]
}

// arcPoints walks the arc from bStart to bEnd the way round that passes
// through the bearing `through`, at arcStepDeg resolution.
func arcPoints(centre [2]float64, radiusM, bStart, bEnd, through float64) [][2]float64 {
	sweepCW := norm360(bEnd - bStart)
	throughCW := norm360(through - bStart)
	var sweep float64
	if throughCW < sweepCW {
		sweep = sweepCW
	} else {
		sweep = -(360 - sweepCW)
	}
	steps := int(math.Ceil(math.Abs(sweep) / arcStepDeg))
	if steps < 2 {
		steps = 2
	}
	out := make([][2]float64, 0, steps+1)
	for i := 0; i <= steps; i++ {
		b := bStart + sweep*float64(i)/float64(steps)
		out = append(out, destPoint(centre, norm360(b), radiusM))
	}
	return out
}

const earthRadiusM = 6371008.8

func rad(d float64) float64 { return d * math.Pi / 180 }
func deg(r float64) float64 { return r * 180 / math.Pi }

func norm360(d float64) float64 {
	d = math.Mod(d, 360)
	if d < 0 {
		d += 360
	}
	return d
}

// angleDiff is the absolute separation of two bearings, 0..180.
func angleDiff(a, b float64) float64 {
	d := math.Abs(norm360(a - b))
	if d > 180 {
		d = 360 - d
	}
	return d
}

func bearingDeg(from, to [2]float64) float64 {
	p1, p2 := rad(from[0]), rad(to[0])
	dl := rad(to[1] - from[1])
	y := math.Sin(dl) * math.Cos(p2)
	x := math.Cos(p1)*math.Sin(p2) - math.Sin(p1)*math.Cos(p2)*math.Cos(dl)
	return norm360(deg(math.Atan2(y, x)))
}

func distanceM(a, b [2]float64) float64 {
	p1, p2 := rad(a[0]), rad(b[0])
	dp := rad(b[0] - a[0])
	dl := rad(b[1] - a[1])
	h := math.Sin(dp/2)*math.Sin(dp/2) + math.Cos(p1)*math.Cos(p2)*math.Sin(dl/2)*math.Sin(dl/2)
	return 2 * earthRadiusM * math.Asin(math.Min(1, math.Sqrt(h)))
}

func destPoint(from [2]float64, bearing, distM float64) [2]float64 {
	ang := distM / earthRadiusM
	p1, b := rad(from[0]), rad(bearing)
	sinP := math.Sin(p1)*math.Cos(ang) + math.Cos(p1)*math.Sin(ang)*math.Cos(b)
	p2 := math.Asin(sinP)
	l2 := rad(from[1]) + math.Atan2(math.Sin(b)*math.Sin(ang)*math.Cos(p1), math.Cos(ang)-math.Sin(p1)*sinP)
	return [2]float64{aip.Round5(deg(p2)), aip.Round5(deg(l2))}
}

// normalizeNumber turns a printed figure into a bare decimal string.
//
// The editions mix conventions: a Spanish supplement writes three
// thousand feet "3.000 ft" and one and a half "1,5", an English one
// writes "3,000 ft" and "1.5". Reading "3.000" as three would publish a
// 3 ft ceiling for a 3000 ft one, so the grouping forms are recognised
// by their shape (groups of exactly three digits) and stripped.
var (
	dotGroupedRe   = regexp.MustCompile(`^\d{1,3}(?:\.\d{3})+$`)
	commaGroupedRe = regexp.MustCompile(`^\d{1,3}(?:,\d{3})+$`)
)

func normalizeNumber(s string) (string, bool) {
	s = strings.TrimSpace(s)
	switch {
	case dotGroupedRe.MatchString(s):
		s = strings.ReplaceAll(s, ".", "")
	case commaGroupedRe.MatchString(s):
		s = strings.ReplaceAll(s, ",", "")
	default:
		s = strings.Replace(s, ",", ".", 1)
	}
	if _, err := strconv.ParseFloat(s, 64); err != nil {
		return "", false
	}
	return s, true
}

// parseRadiusM reads "6 NM", "1 KM", "500 M" (decimal comma tolerated),
// preferring the figure that stands beside the word radius over the first
// number-and-unit in the paragraph, and refusing anything past maxRadiusM.
func parseRadiusM(f string) (float64, bool) {
	if m := radiusAdjRe.FindStringSubmatch(f); m != nil {
		num, unit := m[1], m[2]
		if num == "" {
			num, unit = m[3], m[4]
		}
		return radiusFrom(num, unit)
	}
	m := radiusRe.FindStringSubmatch(f)
	if m == nil {
		return 0, false
	}
	return radiusFrom(m[1], m[2])
}

// radiusFrom turns a printed figure and its unit into metres, refusing a
// non-positive or implausible radius.
func radiusFrom(figure, unit string) (float64, bool) {
	num, ok := normalizeNumber(figure)
	if !ok {
		return 0, false
	}
	v, err := strconv.ParseFloat(num, 64)
	if err != nil || v <= 0 {
		return 0, false
	}
	switch unit {
	case "nm":
		v *= 1852
	case "km":
		v *= 1000
	}
	if v > maxRadiusM {
		return 0, false
	}
	return v, true
}

// parseCircle reads "circulo de 1 KM de radio centrado en 402637N
// 0034414W" and its English twin.
func parseCircle(s, name string) (circleDef, bool) {
	f := fold(s)
	r, ok := parseRadiusM(f)
	if !ok {
		return circleDef{}, false
	}
	m := eaip.CoordRe.FindStringSubmatch(normCoordText(s))
	if m == nil {
		return circleDef{}, false
	}
	lat, lon, ok := eaip.ParsePair(m[1], m[2])
	if !ok {
		return circleDef{}, false
	}
	if lat < esMinLat || lat > esMaxLat || lon < esMinLon || lon > esMaxLon {
		return circleDef{}, false
	}
	return circleDef{name: name, centre: [2]float64{lat, lon}, radiusM: r}, true
}

// --- vertical limits ----------------------------------------------------

var (
	// Prefix-anchored, not whole-string: the bilingual PDFs print the
	// Spanish and English columns on one line ("Limites verticales:
	// FL145 - FL245. Vertical limits: FL145 - FL245."), so the value is
	// followed by the other column's text.
	flRe    = regexp.MustCompile(`^fl\s*(\d{2,3})\b`)
	valRe   = regexp.MustCompile(`^(\d+(?:[.,]\d+)*)\s*(ft|feet|pies|m|metros|meters)\b\s*(amsl|msl|agl|asfc|sfc|gnd|ground)?`)
	sfcRe   = regexp.MustCompile(`^(?:sfc|gnd|surface|suelo|superficie)\b`)
	unlRe   = regexp.MustCompile(`^(?:unl|unlimited|ilimitado)\b`)
	vertSep = regexp.MustCompile(`\s*[-/]\s*| a | to `)
)

// parseVerticalPair splits "SFC-FL100", "GND-120 m AGL." or
// "SFC - 4000 ft AMSL MAX" into the shared [code, value, uom] triples.
func parseVerticalPair(s string) (lower, upper any, ok bool) {
	f := fold(strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(s), ".")))
	if f == "" {
		return nil, nil, false
	}
	parts := vertSep.Split(f, 2)
	if len(parts) != 2 {
		return nil, nil, false
	}
	lo, ok1 := parseLevel(strings.TrimSpace(parts[0]))
	up, ok2 := parseLevel(strings.TrimSpace(parts[1]))
	if !ok1 || !ok2 {
		return nil, nil, false
	}
	return lo, up, true
}

// parseLevel reads one folded level token into its triple. The
// vocabulary is the one src/lib/vertical/limits.ts already decodes: HEI
// (above surface), ALT (AMSL), STD (flight level), UNL.
func parseLevel(f string) (any, bool) {
	switch {
	case f == "":
		return nil, false
	case sfcRe.MatchString(f):
		return []string{"HEI", "0", "FT"}, true
	case unlRe.MatchString(f):
		return []string{"UNL", "", ""}, true
	}
	if m := flRe.FindStringSubmatch(f); m != nil {
		return []string{"STD", m[1], "FL"}, true
	}
	if m := valRe.FindStringSubmatch(f); m != nil {
		val, ok := normalizeNumber(m[1])
		if !ok {
			return nil, false
		}
		uom := "FT"
		switch m[2] {
		case "m", "metros", "meters":
			uom = "M"
		}
		code := "ALT"
		switch m[3] {
		case "agl", "asfc", "sfc", "gnd", "ground":
			code = "HEI"
		}
		return []string{code, val, uom}, true
	}
	return nil, false
}

// --- obstacle tables ----------------------------------------------------

// obstacleTable is a table with a coordinate column AND a height column.
// The height column is the discriminator: an AIRAC supplement's annex
// prints a "WPT | COORD" table with no height, and those waypoints must
// never become airspace.
type obstacleTable struct {
	idCol, coordCol, hgtCol int
	// coordCol2 >= 0: the pair is split, the longitude in this column.
	coordCol2 int
	hgtUnit   string
}

func detectObstacleTable(cells []string) *obstacleTable {
	t := &obstacleTable{idCol: -1, coordCol: -1, coordCol2: -1, hgtCol: -1, hgtUnit: "M"}
	for i, c := range cells {
		f := fold(c)
		if obstCoordColRe.MatchString(f) {
			// The first COORD column holds the pair, or its latitude when
			// a second COORD column follows with the longitude.
			if t.coordCol < 0 {
				t.coordCol = i
			} else if t.coordCol2 < 0 {
				t.coordCol2 = i
			}
			continue
		}
		if obstLatColRe.MatchString(f) && t.coordCol < 0 {
			t.coordCol = i
			continue
		}
		if obstLonColRe.MatchString(f) && t.coordCol2 < 0 {
			t.coordCol2 = i
			continue
		}
		if obstHeightColRe.MatchString(f) && t.hgtCol < 0 {
			t.hgtCol = i
			if m := obstUnitRe.FindStringSubmatch(f); m != nil && m[1] == "ft" {
				t.hgtUnit = "FT"
			}
			continue
		}
		// The NAME column: the first that is neither of the two above nor
		// a time / date / elevation column (a zone named "0730-2100 HL" or
		// by its own coordinates is what the old first-column rule gave).
		if t.idCol < 0 && !obstNotIdColRe.MatchString(f) && strings.TrimSpace(f) != "" {
			t.idCol = i
		}
	}
	if t.coordCol < 0 || t.hgtCol < 0 {
		return nil
	}
	return t
}

// row turns one obstacle-table data row into a circle zone.
func (t *obstacleTable) row(cells []string) (esZone, bool, string) {
	if t.coordCol >= len(cells) {
		return esZone{}, false, ""
	}
	coordText := cells[t.coordCol]
	if t.coordCol2 >= 0 && t.coordCol2 < len(cells) {
		coordText += " " + cells[t.coordCol2]
	}
	m := eaip.CoordRe.FindStringSubmatch(normCoordText(coordText))
	if m == nil {
		// "-" is how the table says the element shares the row above's
		// position (a mobile crane beside its mast); nothing to draw.
		return esZone{}, false, "obstacle-row-without-position"
	}
	lat, lon, ok := eaip.ParsePair(m[1], m[2])
	if !ok || lat < esMinLat || lat > esMaxLat || lon < esMinLon || lon > esMaxLon {
		return esZone{}, false, "vertex-outside-spain"
	}
	name := ""
	if t.idCol >= 0 && t.idCol < len(cells) {
		name = strings.TrimSpace(cells[t.idCol])
	}
	if name == "" {
		name = "SUP AIP"
	}
	var upper any
	if t.hgtCol < len(cells) {
		if v := strings.TrimSpace(cells[t.hgtCol]); v != "" && v != "-" {
			if num, ok := normalizeNumber(v); ok {
				upper = []string{"HEI", num, t.hgtUnit}
			}
		}
	}
	return esZone{
		name:   name,
		geom:   map[string]any{"type": "circle", "center": [2]float64{lat, lon}, "radiusM": supCircleFloorM},
		bbox:   circleBbox(lat, lon, supCircleFloorM),
		lower:  []string{"HEI", "0", "FT"},
		upper:  upper,
		source: "html-position",
	}, true, ""
}

// --- small geometry helpers --------------------------------------------

func ringJSON(r [][2]float64) []any {
	out := make([]any, 0, len(r))
	for _, p := range r {
		out = append(out, [2]float64{p[0], p[1]})
	}
	return out
}

func ringBbox(ring [][2]float64) []float64 {
	minLat, minLon := ring[0][0], ring[0][1]
	maxLat, maxLon := minLat, minLon
	for _, p := range ring {
		minLat, maxLat = math.Min(minLat, p[0]), math.Max(maxLat, p[0])
		minLon, maxLon = math.Min(minLon, p[1]), math.Max(maxLon, p[1])
	}
	return []float64{aip.Round5(minLat), aip.Round5(minLon), aip.Round5(maxLat), aip.Round5(maxLon)}
}

func circleBbox(lat, lon, radiusM float64) []float64 {
	dLat := radiusM / 111320.0
	dLon := radiusM / (111320.0 * cosDeg(lat))
	return []float64{aip.Round5(lat - dLat), aip.Round5(lon - dLon), aip.Round5(lat + dLat), aip.Round5(lon + dLon)}
}

func cosDeg(d float64) float64 {
	c := math.Cos(rad(d))
	if c < 0.1 {
		return 0.1
	}
	return c
}

func unionBbox(a, b []float64) []float64 {
	if len(b) != 4 {
		return a
	}
	if len(a) != 4 {
		return append([]float64(nil), b...)
	}
	return []float64{math.Min(a[0], b[0]), math.Min(a[1], b[1]), math.Max(a[2], b[2]), math.Max(a[3], b[3])}
}
