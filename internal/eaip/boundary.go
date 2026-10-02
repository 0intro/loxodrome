// boundary.go: turn an eAIP lateral-limits sentence into a ring. The
// grammar is prose but formulaic: coordinate pairs separated by " - ",
// "an arc of circle, R NM radius, centred on <pt> and traced
// (counter)clockwise to <pt>" phrases, full Circles, and "along the
// <countries> border" segments. Border segments are stitched along the
// State's own FIR ring (pruatlas-firs.json), which IS the national
// boundary every published border segment lies on; without the ring (or
// when an endpoint sits too far from it) they degrade to the straight
// chord, counted in the meta.

package eaip

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"regexp"
	"strconv"
	"strings"

	"github.com/0intro/loxodrome/internal/geodesy"
)

// BoundaryStats aggregates geometry-parse events for the meta sidecar.
type BoundaryStats struct {
	Arcs           int
	Circles        int
	BorderStitched int
	BorderChords   int
	// ArcSensesInferred counts the rings an arc of unstated sense closes
	// only the long way round, the short way crossing the ring.
	ArcSensesInferred int
	// ArcsUnread counts the rings whose text names an arc or a circle no
	// pattern read. Such a ring is wrong, not approximate: the centre
	// becomes a vertex and the boundary spikes into it, which is how
	// AirNav's Dublin CTA was drawn until "arc 15NM radius centre X" read.
	ArcsUnread int
	// ClippedToFIR counts the rings cut back at the State's own FIR
	// ("except where inside SOFIA FIR"), ClippedAway those the cut left
	// empty, and ClipRefused those whose shape the clip cannot take,
	// kept whole.
	ClippedToFIR int
	ClippedAway  int
	ClipRefused  int
}

// The radius grammar differs between States in three ways, and all have
// to be accepted or a zone silently degrades to a default-size circle,
// which would be a false statement about where an aircraft may fly:
//
//   - the value may come BEFORE or AFTER the word "radius" ("of 3 NM
//     radius" in Belgium, "with 11NM radius" in Iceland, "radius 3 KM" in
//     Hungary and Portugal, "of radius 1.1 NM" in Czechia);
//   - the word may be absent entirely ("a clockwise arc 25NM centred on");
//   - the unit may be NM, KM or M.
//
// SMATSA runs the article into the word ("with aradius of 2.5 KM"), EANS
// follows the value with its metric twin ("6 NM (11.1 km )"), which the
// pattern reads through, ROMATSA puts the twin before the word ("of 6 NM
// (12 KM) radius"), and LPS SR writes a decimal comma ("5,7 NM").
const radiusPat = `(?:(?:of\s+|with\s+(?:a\s+)?)?(\d*[.,]?\d+)\s*(NM|KM|M)(?:\s+radius)?` +
	`|(?:of\s+|with\s+)?(?:a\s*)?radius\s*(?:of\s+)?(\d*[.,]?\d+)\s*(NM|KM|M))` +
	`(?:\s*\(\s*[\d.,]+\s*(?:NM|KM|M)\s*\)(?:\s+radius)?)?`

// centrePat is how a State names the centre of a circle or arc. Every
// wording in the cohort is here, and the differences are only wording:
// "centred on X" (Belgium), "centred at point: X" (Poland), "with the
// centre point at: X" (Slovakia), "centered on X" where the State
// follows FAA spelling, the bare noun (AirNav's "arc 15NM radius centre
// X") and "around X" (LPS SR's "circular arc CW 7 NM around X"). The
// preposition may sit on either side of the noun, which is why it
// appears twice and is optional both times. The centre may also be named
// by the reference it is, its coordinate after the name, bracketed or
// not, the name itself optional (NAV Portugal's "centred at ARP (365826N
// 0251016W)"): ANS CR's "centred at ARP LKKL ( 500646.49N 0140523.49E )" and
// "centred at DME OKL ( ... )", PANSA's "centred at ARP Rönne
// (550404N 0144448E)", Slovenia Control's "centered at VOR /DME DOL
// 455207.84N 0151725.20E", Avinor's "on Gjoa (611954N 0035342E)". And a
// few more wordings: "and centre of Arc on X" (Slovenia), "and
// centerpoint X" (EANS), "centre, X" (AirNav), ROMATSA's "centred on
// point of coordinates: X", and AirNav's "arc 15NM radius of X", the
// centre a radius is OF.
const centrePat = `(?:and\s+)?(?:(?:cent(?:r|er)ed|with\s+(?:the\s+|a\s+)?cent(?:re|er)|cent(?:re|er)|around)` +
	`(?:\s+of\s+(?:the\s+)?arc)?` +
	`(?:\s+(?:on|at|upon|of))?\s*(?:the\s+|a\s+)?(?:point|position|coordinates)?` +
	`(?:\s+(?:on|at|upon|of))?(?:\s+coordinates)?\s*[:,]?\s*` +
	`(?:(?:ARP|D?VOR(?:\s*/\s*DME)?|DME|NDB|TACAN|VORTAC)(?:\s+AD)?(?:\s+[^\s()]{2,20})?\s*\(?\s*)?` +
	`|of\s+|on\s+[^()\d]{1,40}\(\s*)`

// dirPat is the sense an arc is traced in. States write it as one word,
// two words or hyphenated, "anti" for "counter", and the abbreviations
// CW and CCW (LPS SR).
const dirPat = `(counter\s*-?\s*clockwise|anti\s*-?\s*clockwise|clockwise|CCW|CW)`

var (
	arcRe = regexp.MustCompile(`(?i)\ban arc of (?:a )?circle\s*,?\s*` + radiusPat +
		`\s*,?\s*` + centrePat +
		CoordPat + `\s*,?\s+(?:and\s+)?traced\s+` + dirPat + `\s+to\s+` + CoordPat)
	// arcSenseAfterRe is an arc whose sense follows its centre, then its
	// end point: KANS's "ARC 20 Nm centered on 423422.000N 0210209.000E
	// Clockwise 423251.213N 0203509.908E". The end point is part of the
	// phrase, so a sense word is never taken from the arc after it.
	arcSenseAfterRe = regexp.MustCompile(`(?i)\barc\s*,?\s*` + radiusPat + `\s*,?\s*` + centrePat + CoordPat +
		`\s*,?\s*` + dirPat + `\s*(?:to\s+)?[-–,]?\s*` + CoordPat)
	// arcOpenRe is the same arc written WITHOUT its end point, which is
	// then simply the next coordinate of the list: "then a clockwise arc
	// radius 20 KM centred on 415124N 0064227W - 415632N 0065510W".
	// Portugal, Hungary and Poland all write arcs this way, and the sense
	// may sit before the word "arc", after it, or be absent altogether.
	// Avians writes "then clockwise along an arc with 11NM radius
	// centered on" and, for an arc traced the other way, "clockwise along
	// a counter arc": the geometry of the FAXI collars says "counter"
	// flips the sense and the "clockwise" before it is boilerplate.
	arcOpenRe = regexp.MustCompile(`(?i)\b(?:` + dirPat + `\s+(?:direction\s+)?(?:(?:along|on)\s+(?:the\s+|an?\s+)?)?)?(counter\s+)?arc(?:\s+of\s+(?:a\s+)?circle)?\s*,?\s*(?:` +
		dirPat + `\s*,?\s*)?` + radiusPat +
		`\s*,?\s*` + centrePat + CoordPat)
	// cwaArcRe is ANS CR's abbreviation, CWA and CCA for a clockwise and
	// a counter-clockwise arc, written without its end point: "CWA with
	// radius 3 NM centred at 485647.00N 0142539.00E - 485746.96N ...".
	cwaArcRe = regexp.MustCompile(`(?i)\b(CWA|CCA|CCWA)\b\s*,?\s*` + radiusPat +
		`\s*,?\s*` + centrePat + CoordPat)
	// arcCentreFirstRe names the centre before the radius, LGS's "then a
	// counter-clockwise arc centered on 563116N0274139E and radius 4 NM -
	// 562848N0274720E", the end point again the next coordinate, and
	// ROMATSA's "arc of circle centred at 473930N 0232758E (ARP) and radius
	// 13.3 NM", the centre followed by the reference it is.
	arcCentreFirstRe = regexp.MustCompile(`(?i)\b(?:` + dirPat + `\s+)?(counter\s+)?arc(?:\s+of\s+(?:a\s+)?circle)?\s*,?\s*(?:` +
		dirPat + `\s*,?\s*)?` + centrePat + CoordPat + `(?:\s*\(\s*[^()\d]{1,20}\))?\s*,?\s*(?:and\s+)?(?:with\s+)?` + radiusPat)
	// arcNoRadiusRe is an arc whose radius the text leaves out, AirNav's
	// "then a counter-clockwise arc radius centred on 533843N 0061348W -
	// 533754N 0060857W": it is the distance from the centre to the point
	// the arc leaves (drawArc).
	arcNoRadiusRe = regexp.MustCompile(`(?i)\b(?:` + dirPat + `\s+)?(counter\s+)?arc\s*,?\s*(?:` +
		dirPat + `\s*,?\s*)?(?:radius\s*,?\s*)?` + centrePat + CoordPat)
	// circleAfterRe is a circle written after its centre: Avinor's
	// "Oslo Sentrum 595500N 0104400E - A circle with radius 1.0 NM".
	circleAfterRe = regexp.MustCompile(`(?i)` + CoordPat + `\s*[-–,]?\s*(?:an?\s+)?circle\s*,?\s*(?:with\s+)?` + radiusPat)
	// radiusAfterRe is the same circle with the word left out, the dash
	// and the radius alone saying it: Avinor's ENR 5.5 "Ulven 601130N
	// 0052525E - Radius 1 NM".
	radiusAfterRe = regexp.MustCompile(`(?i)` + CoordPat + `\s*[-–]\s*radius\s+(\d*[.,]?\d+)\s*(NM|KM|M)\b`)
	// sectorRe is a sector of a circle, between two true bearings from its
	// centre and swept clockwise from the first to the second: Avinor's
	// "691642N 0160031E - Sector 270° - 360° (T), radius 1 NM" (Alomar
	// Nv, the north-west quadrant; Alomar Sø's 090° - 180° is the
	// south-east), a sector of an annulus ("radius 1 - 5 NM"), and a
	// circle with a sector reaching beyond it, "1. A circle, radius 1.1
	// NM 2. A sector 330° - 030° (T), radius 3.3 NM".
	sectorRe = regexp.MustCompile(`(?i)` + CoordPat + `\s*[-–]\s*(?:1\.\s*)?` +
		`(?:an?\s+circle\s*,?\s*radius\s+(\d*[.,]?\d+)\s*(NM|KM|M)\s*(?:2\.\s*)?)?` +
		`(?:an?\s+)?sector\s+(\d{1,3}(?:[.,]\d+)?)\s*[°º]\s*[-–]\s*(\d{1,3}(?:[.,]\d+)?)\s*[°º]\s*(?:\(\s*T\s*\))?\s*,?\s*` +
		`radius\s+(\d*[.,]?\d+)(?:\s*(?:NM|KM|M))?(?:\s*[-–]\s*(\d*[.,]?\d+))?\s*(NM|KM|M)\b`)
	// The article is optional: Poland writes "Circle of 3 km radius
	// centred at point: ..." with none. So is the word for the centre,
	// which AirNav leaves out: "Circle, radius 15 NM 515029N 0082928W".
	fullCircleRe = regexp.MustCompile(`(?i)\b(?:an?\s+)?circle\s*,?\s*` + radiusPat +
		`\s*,?\s*(?:` + centrePat + `)?` + CoordPat)
	// The words a State runs a segment along its own limits with. BDRY is
	// ICAO's abbreviation for boundary, and BHANSA writes "along the FIR
	// BDRY Sarajevo/Beograd" where Belgium writes "along the
	// Belgian-Dutch border": the same instruction, and the same ring to
	// walk.
	borderWordRe = regexp.MustCompile(`(?i)\b(border|frontier|boundary|bdry)\b`)
)

// radiusMetres reads the two alternative radius captures the pattern
// above produces: one pair is filled and the other empty.
func radiusMetres(valA, uomA, valB, uomB string) (float64, bool) {
	val, uom := valA, uomA
	if val == "" {
		val, uom = valB, uomB
	}
	v, err := strconv.ParseFloat(strings.Replace(val, ",", ".", 1), 64)
	if err != nil || v <= 0 {
		return 0, false
	}
	switch strings.ToUpper(uom) {
	case "NM":
		return v * 1852, true
	case "KM":
		return v * 1000, true
	case "M":
		return v, true
	}
	return 0, false
}

// bEvent is one geometry token found in a lateral-limits sentence.
type bEvent struct {
	start, end int
	kind       byte // 'p' point, 'a' arc, 'A' open arc, 'c' circle, 's' sector
	// point / arc-end coordinates
	lat, lon float64
	// arc / circle parameters
	cenLat, cenLon, radiusM float64
	// sector parameters: the true bearings it is swept between,
	// clockwise, the radius it starts at (an annulus's), and the radius
	// of a circle it reaches beyond; radiusM is its outer radius.
	fromDeg, toDeg, innerM, coreM float64
	clockwise                     bool
	// dirKnown is false when the State stated no sense; the arc is then
	// drawn the short way round, unless the ring crosses itself that way
	// and not the other (ParseBoundary).
	dirKnown bool
}

// clockwiseWord reads an arc sense out of whichever of the two capture
// slots the State filled.
func clockwiseWord(a, b string) (clockwise, known bool) {
	w := strings.ToLower(a + b)
	if w == "" {
		return false, false
	}
	return !strings.Contains(w, "counter") && !strings.Contains(w, "anti") && w != "ccw", true
}

// pairRe is a coordinate pair written with a comma between its halves
// ("530422N,0060211W", AirNav) or a space before a hemisphere letter
// ("355922 N 0264135 W", NAV Portugal), which ParseBoundary closes up so
// one pattern reads every pair.
var pairRe = regexp.MustCompile(`\b(\d{6}(?:\.\d+)?)\s?([NS])\s*,?\s*(\d{7}(?:\.\d+)?)\s?([EW])\b`)

// centreTailRe ends the text before a coordinate that is a CENTRE: the
// word for it and nothing after but its connectors. Such a coordinate is
// never a vertex, even where its phrase went unread: the ring degrades to
// the chord the arc spans, counted, rather than spiking into the centre.
var centreTailRe = regexp.MustCompile(`(?i)\b(?:cent(?:r|er)ed|cent(?:re|er)(?:\s*point)?|around)` +
	`(?:\s+(?:of|on|at|upon|the|point|position|coordinates))*\s*[:,(]?\s*$`)

// ParseBoundary parses a lateral-limits sentence into a [lat, lon] ring.
// Returns nil when no geometry is recognisable.
func ParseBoundary(text string, border *BorderRing, st *BoundaryStats) [][2]float64 {
	// The minutes-only pair is written out to seconds first, the value
	// ShortCoord gives it, so an arc may be centred on one (Avians'
	// "counter arc with 40NM radius centered on 6359N 02236W").
	text = ShortCoordRe.ReplaceAllString(NormSpace(text), "${1}00${2} ${3}00${4}")
	text = pairRe.ReplaceAllString(text, "$1$2 $3$4")
	var events []bEvent

	for _, m := range arcRe.FindAllStringSubmatchIndex(text, -1) {
		radiusM, okR := radiusMetres(group(text, m, 1), group(text, m, 2), group(text, m, 3), group(text, m, 4))
		cenLat, cenLon, ok1 := ParsePair(group(text, m, 5), group(text, m, 6))
		cw, _ := clockwiseWord(group(text, m, 7), "")
		endLat, endLon, ok2 := ParsePair(group(text, m, 8), group(text, m, 9))
		if !okR || !ok1 || !ok2 {
			continue
		}
		events = append(events, bEvent{
			start: m[0], end: m[1], kind: 'a',
			lat: endLat, lon: endLon,
			cenLat: cenLat, cenLon: cenLon, radiusM: radiusM,
			clockwise: cw,
			dirKnown:  true,
		})
	}
	for _, m := range arcSenseAfterRe.FindAllStringSubmatchIndex(text, -1) {
		if inside(events, m[0]) {
			continue
		}
		radiusM, okR := radiusMetres(group(text, m, 1), group(text, m, 2), group(text, m, 3), group(text, m, 4))
		cenLat, cenLon, ok1 := ParsePair(group(text, m, 5), group(text, m, 6))
		cw, _ := clockwiseWord(group(text, m, 7), "")
		endLat, endLon, ok2 := ParsePair(group(text, m, 8), group(text, m, 9))
		if !okR || !ok1 || !ok2 {
			continue
		}
		events = append(events, bEvent{
			start: m[0], end: m[1], kind: 'a',
			lat: endLat, lon: endLon,
			cenLat: cenLat, cenLon: cenLon, radiusM: radiusM,
			clockwise: cw,
			dirKnown:  true,
		})
	}
	for _, m := range arcOpenRe.FindAllStringSubmatchIndex(text, -1) {
		if inside(events, m[0]) {
			continue // the leading half of a fully written arc
		}
		radiusM, okR := radiusMetres(group(text, m, 4), group(text, m, 5), group(text, m, 6), group(text, m, 7))
		cenLat, cenLon, ok := ParsePair(group(text, m, 8), group(text, m, 9))
		if !okR || !ok {
			continue
		}
		cw, known := clockwiseWord(group(text, m, 1), group(text, m, 3))
		if group(text, m, 2) != "" {
			cw, known = false, true // a counter arc
		}
		events = append(events, bEvent{
			start: m[0], end: m[1], kind: 'A',
			cenLat: cenLat, cenLon: cenLon, radiusM: radiusM,
			clockwise: cw, dirKnown: known,
		})
	}
	for _, m := range cwaArcRe.FindAllStringSubmatchIndex(text, -1) {
		if inside(events, m[0]) {
			continue
		}
		radiusM, okR := radiusMetres(group(text, m, 2), group(text, m, 3), group(text, m, 4), group(text, m, 5))
		cenLat, cenLon, ok := ParsePair(group(text, m, 6), group(text, m, 7))
		if !okR || !ok {
			continue
		}
		events = append(events, bEvent{
			start: m[0], end: m[1], kind: 'A',
			cenLat: cenLat, cenLon: cenLon, radiusM: radiusM,
			clockwise: strings.EqualFold(group(text, m, 1), "CWA"), dirKnown: true,
		})
	}
	for _, m := range arcCentreFirstRe.FindAllStringSubmatchIndex(text, -1) {
		if inside(events, m[0]) {
			continue
		}
		cenLat, cenLon, ok := ParsePair(group(text, m, 4), group(text, m, 5))
		radiusM, okR := radiusMetres(group(text, m, 6), group(text, m, 7), group(text, m, 8), group(text, m, 9))
		if !okR || !ok {
			continue
		}
		cw, known := clockwiseWord(group(text, m, 1), group(text, m, 3))
		if group(text, m, 2) != "" {
			cw, known = false, true
		}
		events = append(events, bEvent{
			start: m[0], end: m[1], kind: 'A',
			cenLat: cenLat, cenLon: cenLon, radiusM: radiusM,
			clockwise: cw, dirKnown: known,
		})
	}
	for _, m := range arcNoRadiusRe.FindAllStringSubmatchIndex(text, -1) {
		if inside(events, m[0]) {
			continue
		}
		cenLat, cenLon, ok := ParsePair(group(text, m, 4), group(text, m, 5))
		if !ok {
			continue
		}
		cw, known := clockwiseWord(group(text, m, 1), group(text, m, 3))
		if group(text, m, 2) != "" {
			cw, known = false, true
		}
		// radiusM zero: drawArc takes the distance to the point it leaves.
		events = append(events, bEvent{
			start: m[0], end: m[1], kind: 'A',
			cenLat: cenLat, cenLon: cenLon,
			clockwise: cw, dirKnown: known,
		})
	}
	for _, m := range sectorRe.FindAllStringSubmatchIndex(text, -1) {
		if inside(events, m[0]) {
			continue
		}
		cenLat, cenLon, ok := ParsePair(group(text, m, 1), group(text, m, 2))
		from, err1 := strconv.ParseFloat(strings.Replace(group(text, m, 5), ",", ".", 1), 64)
		to, err2 := strconv.ParseFloat(strings.Replace(group(text, m, 6), ",", ".", 1), 64)
		unit := group(text, m, 9)
		r1, ok1 := radiusMetres(group(text, m, 7), unit, "", "")
		if !ok || err1 != nil || err2 != nil || !ok1 {
			continue
		}
		e := bEvent{
			start: m[0], end: m[1], kind: 's',
			cenLat: cenLat, cenLon: cenLon, radiusM: r1,
			fromDeg: from, toDeg: to,
		}
		if group(text, m, 8) != "" {
			r2, ok2 := radiusMetres(group(text, m, 8), unit, "", "")
			if !ok2 || r2 <= r1 {
				continue
			}
			e.innerM, e.radiusM = r1, r2
		}
		if group(text, m, 3) != "" {
			core, okC := radiusMetres(group(text, m, 3), group(text, m, 4), "", "")
			if !okC || core >= e.radiusM || e.innerM > 0 {
				continue
			}
			e.coreM = core
		}
		events = append(events, e)
	}
	for _, m := range fullCircleRe.FindAllStringSubmatchIndex(text, -1) {
		if inside(events, m[0]) {
			continue // "an ARC OF CIRCLE, ..." also matches the circle regex
		}
		radiusM, okR := radiusMetres(group(text, m, 1), group(text, m, 2), group(text, m, 3), group(text, m, 4))
		cenLat, cenLon, ok := ParsePair(group(text, m, 5), group(text, m, 6))
		if !okR || !ok {
			continue
		}
		events = append(events, bEvent{
			start: m[0], end: m[1], kind: 'c',
			cenLat: cenLat, cenLon: cenLon, radiusM: radiusM,
		})
	}
	for _, m := range circleAfterRe.FindAllStringSubmatchIndex(text, -1) {
		if inside(events, m[0]) || overlaps(events, m[0], m[1]) {
			continue
		}
		// "P, circle 15NM radius centre C": the circle's centre is C, not
		// the point before it.
		if rest := strings.TrimLeft(text[m[1]:], " ,"); centreStartRe.MatchString(rest) {
			continue
		}
		cenLat, cenLon, ok := ParsePair(group(text, m, 1), group(text, m, 2))
		radiusM, okR := radiusMetres(group(text, m, 3), group(text, m, 4), group(text, m, 5), group(text, m, 6))
		if !okR || !ok {
			continue
		}
		events = append(events, bEvent{
			start: m[0], end: m[1], kind: 'c',
			cenLat: cenLat, cenLon: cenLon, radiusM: radiusM,
		})
	}
	for _, m := range radiusAfterRe.FindAllStringSubmatchIndex(text, -1) {
		if inside(events, m[0]) || overlaps(events, m[0], m[1]) {
			continue
		}
		if rest := strings.TrimLeft(text[m[1]:], " ,"); centreStartRe.MatchString(rest) || strings.HasPrefix(rest, "-") {
			// A centre named after it, or a second radius: an arc's
			// phrase or an annulus, which this is not.
			continue
		}
		cenLat, cenLon, ok := ParsePair(group(text, m, 1), group(text, m, 2))
		radiusM, okR := radiusMetres(group(text, m, 3), group(text, m, 4), "", "")
		if !okR || !ok {
			continue
		}
		events = append(events, bEvent{
			start: m[0], end: m[1], kind: 'c',
			cenLat: cenLat, cenLon: cenLon, radiusM: radiusM,
		})
	}
	for _, m := range CoordRe.FindAllStringSubmatchIndex(text, -1) {
		if inside(events, m[0]) {
			continue // part of an arc / circle phrase
		}
		if centreTailRe.MatchString(text[:m[0]]) {
			continue // the centre of a phrase no pattern read
		}
		lat, lon, ok := ParsePair(group(text, m, 1), group(text, m, 2))
		if !ok {
			continue
		}
		events = append(events, bEvent{start: m[0], end: m[1], kind: 'p', lat: lat, lon: lon})
	}
	// The spaced DMS form, which Slovenia writes its ENR 2 boundaries in.
	for _, m := range SpacedCoordRe.FindAllStringSubmatchIndex(text, -1) {
		if inside(events, m[0]) || centreTailRe.MatchString(text[:m[0]]) {
			continue
		}
		pt, ok := SpacedCoord(text[m[0]:m[1]])
		if !ok {
			continue
		}
		events = append(events, bEvent{start: m[0], end: m[1], kind: 'p', lat: pt[0], lon: pt[1]})
	}
	// The minutes-only form, which the FIR and upper-airspace descriptions
	// are written in. It is scanned last so a full coordinate is never
	// read as one.
	for _, m := range ShortCoordRe.FindAllStringSubmatchIndex(text, -1) {
		if inside(events, m[0]) || centreTailRe.MatchString(text[:m[0]]) {
			continue
		}
		pt, ok := ShortCoord(text[m[0]:m[1]])
		if !ok {
			continue
		}
		events = append(events, bEvent{start: m[0], end: m[1], kind: 'p', lat: pt[0], lon: pt[1]})
	}

	sortEvents(events)
	if unreadArc(text, events) {
		st.ArcsUnread++
	}

	// An arc whose sense the State left out is drawn the short way round,
	// unless that ring crosses itself and the long way does not: ROMATSA's
	// Baia Mare CTR is the circle round the aerodrome with its western side
	// drawn by three points instead, its one arc swept three quarters of a
	// turn, and drawn the short way it was a sliver out to the west.
	var sense arcSense
	ring, walked := walkBoundary(text, events, border, &sense, st)
	if sense.unknown > 0 && sense.unknown <= maxSenseTrials && crossesItself(ring) {
		for flip := uint(1); flip < 1<<sense.unknown; flip++ {
			var scratch BoundaryStats
			r, w := walkBoundary(text, events, border, &arcSense{flip: flip}, &scratch)
			if !crossesItself(r) {
				ring, walked = r, w
				st.ArcSensesInferred++
				break
			}
		}
	}
	orientWalked(ring, walked)
	if border != nil && len(ring) > 2 && exceptFIRRe.MatchString(text) {
		return clipToFIR(ring, border, st)
	}
	return ring
}

// arcSense is the sense given the arcs a State left it out of: the short
// way round each, except those whose bit is set in flip, in the order
// they are drawn. unknown counts them.
type arcSense struct {
	flip    uint
	unknown int
}

// maxSenseTrials bounds the arcs whose senses are tried both ways, the
// trials doubling with each.
const maxSenseTrials = 4

// walkBoundary builds the ring from the events, and returns with it the
// spans a walked circle fills, [from, to).
func walkBoundary(text string, events []bEvent, border *BorderRing, sense *arcSense, st *BoundaryStats) ([][2]float64, [][2]int) {
	var ring [][2]float64
	var open *bEvent    // an arc awaiting its end point
	var walked [][2]int // the ring spans a walked circle fills, [from, to)
	prevEnd := 0
	for i := range events {
		e := events[i]
		gap := text[clampIdx(prevEnd, len(text)):clampIdx(e.start, len(text))]
		switch e.kind {
		case 'p':
			if open != nil {
				drawArc(&ring, *open, [2]float64{e.lat, e.lon}, sense, st)
				open = nil
			} else if borderWordRe.MatchString(gap) && len(ring) > 0 {
				appendStitch(&ring, border, [2]float64{e.lat, e.lon}, st)
			}
			appendPoint(&ring, [2]float64{e.lat, e.lon})
		case 'a':
			drawArc(&ring, e, [2]float64{e.lat, e.lon}, sense, st)
			appendPoint(&ring, [2]float64{e.lat, e.lon})
		case 'A':
			open = &events[i]
		case 's':
			// A sector is the whole of its zone, as a circle named by its
			// centre is.
			st.Circles++
			ring = sectorRing(e)
		case 'c':
			st.Circles++
			n := len(ring)
			if n == 0 || !onCircle(ring[n-1], e) {
				ring = CircleRingAround([2]float64{e.cenLat, e.cenLon}, e.radiusM)
				break
			}
			// A circle named after a point ON it continues the boundary
			// along it, to wherever the boundary goes next.
			p := ring[n-1]
			to, closing := ring[0], true
			if i+1 < len(events) {
				to, closing = [2]float64{events[i+1].lat, events[i+1].lon}, false
				if events[i+1].kind != 'p' {
					to = p
				}
			}
			if to != p && onCircle(to, e) && (n >= 3 || !closing) {
				// Around to the next point, or back to the first one when
				// the circle ends the text (Avinor's END452: four points,
				// then "A circle, radius 5.4 NM centred on", the first and
				// the last on it), in the sense the boundary already runs.
				arc := e
				arc.clockwise, arc.dirKnown = signedArea(ring) < 0, n >= 3
				drawArc(&ring, arc, to, sense, st)
				break
			}
			// "P, circle 15NM radius centre C, P, ...": the whole circle,
			// from the point back to it, and the boundary goes on from
			// there (AirNav's Shannon CTA, a circle and a lobe beside it).
			from := len(ring)
			for _, q := range rotateFrom(CircleRingAround([2]float64{e.cenLat, e.cenLon}, e.radiusM), p) {
				appendPoint(&ring, q)
			}
			walked = append(walked, [2]int{from, len(ring)})
			appendPoint(&ring, p)
		}
		prevEnd = e.end
	}
	// An arc written last closes the ring back onto its first point, and
	// so does a run along the border to the point of origin with no point
	// after it ("... 422314N 0201342E along Tirana FIR boundary to the
	// point of origin."), which is the border walked back to the start.
	tail := text[clampIdx(prevEnd, len(text)):]
	switch {
	case open != nil && len(ring) > 0:
		drawArc(&ring, *open, ring[0], sense, st)
	case len(ring) > 2 && borderWordRe.MatchString(tail) && originRe.MatchString(tail):
		appendStitch(&ring, border, ring[0], st)
	}
	return ring, walked
}

// exceptFIRRe is a ring cut back at the State's own FIR: ROMATSA's "Circle
// of 5 KM radius centred on point of coordinates: 434424N 0234644E, except
// where inside SOFIA FIR", the Romanian part of a circle round the
// Kozloduy plant on the Bulgarian bank, and "except airspace within
// Belgrad FIR" for its anti-hail areas on the Serbian border. The FIR the
// words name is the neighbour's; what remains is the part inside the
// State's own, which is the border ring.
var exceptFIRRe = regexp.MustCompile(`(?i)\bexcept\s+(?:where\s+|airspace\s+)?(?:inside|within)\s+[A-Z][^\s,.;]*\s+FIR\b`)

// clipToFIR cuts a ring back to the State's FIR ring: the FIR clipped by
// the ring (Sutherland-Hodgman), which is exact only when the clipping
// ring is convex, as a circle is. A ring that is not is kept whole and
// counted rather than clipped wrong. A ring left empty is dropped: none of
// the zone lies in the State's airspace.
func clipToFIR(ring [][2]float64, border *BorderRing, st *BoundaryStats) [][2]float64 {
	whole := true
	for _, p := range ring {
		if !inRing(border.Pts, p[0], p[1]) {
			whole = false
			break
		}
	}
	if whole {
		return ring // nothing of it lies in the neighbour's FIR
	}
	if !convex(ring) {
		st.ClipRefused++
		return ring
	}
	out := clipConvex(border.Pts, ring)
	if len(out) < 3 {
		st.ClippedAway++
		return nil
	}
	st.ClippedToFIR++
	return out
}

// cross is the planar cross product of (b-a) and (p-a), longitude as x.
func cross(a, b, p [2]float64) float64 {
	return (b[1]-a[1])*(p[0]-a[0]) - (b[0]-a[0])*(p[1]-a[1])
}

// crossesItself reports two edges of the ring crossing, each through the
// other's interior: a boundary that is no area's. Edges that only touch
// are not a crossing, which is where a walked circle comes back to the
// point it left.
func crossesItself(ring [][2]float64) bool {
	n := len(ring)
	if n > 1 && ring[0] == ring[n-1] {
		n--
	}
	if n < 4 {
		return false
	}
	side := func(a, b, p [2]float64) int {
		c := cross(a, b, p)
		switch {
		case c > 1e-12:
			return 1
		case c < -1e-12:
			return -1
		}
		return 0
	}
	for i := 0; i < n; i++ {
		a, b := ring[i], ring[(i+1)%n]
		for j := i + 2; j < n; j++ {
			if i == 0 && j == n-1 {
				continue // the closing edge shares ring[0]
			}
			c, d := ring[j], ring[(j+1)%n]
			if side(a, b, c)*side(a, b, d) < 0 && side(c, d, a)*side(c, d, b) < 0 {
				return true
			}
		}
	}
	return false
}

// convex reports a ring turning the same way at every vertex.
func convex(ring [][2]float64) bool {
	sign := 0.0
	n := len(ring)
	for i := range ring {
		c := cross(ring[i], ring[(i+1)%n], ring[(i+2)%n])
		if math.Abs(c) < 1e-12 {
			continue
		}
		if sign == 0 {
			sign = c
		} else if (c > 0) != (sign > 0) {
			return false
		}
	}
	return sign != 0
}

// clipConvex returns subject clipped by the convex polygon clip, a vertex
// the clip's edges cut through rounded like every other.
func clipConvex(subject, clip [][2]float64) [][2]float64 {
	turn := 0.0
	for i := range clip {
		turn += cross(clip[i], clip[(i+1)%len(clip)], clip[(i+2)%len(clip)])
	}
	inside := func(a, b, p [2]float64) bool {
		if turn > 0 {
			return cross(a, b, p) >= 0
		}
		return cross(a, b, p) <= 0
	}
	cut := func(p, q, a, b [2]float64) [2]float64 {
		// Where segment p-q meets the line through a and b.
		cp, cq := cross(a, b, p), cross(a, b, q)
		t := cp / (cp - cq)
		return [2]float64{Round5(p[0] + t*(q[0]-p[0])), Round5(p[1] + t*(q[1]-p[1]))}
	}
	out := subject
	for i := range clip {
		a, b := clip[i], clip[(i+1)%len(clip)]
		in := out
		out = nil
		if len(in) == 0 {
			break
		}
		prev := in[len(in)-1]
		for _, cur := range in {
			switch {
			case inside(a, b, cur):
				if !inside(a, b, prev) {
					out = append(out, cut(prev, cur, a, b))
				}
				out = append(out, cur)
			case inside(a, b, prev):
				out = append(out, cut(prev, cur, a, b))
			}
			prev = cur
		}
	}
	return out
}

// orientWalked turns each walked circle to the sense the rest of the ring
// runs in. The State names no sense for it, and walked against the rest
// the circle's area and the rest's subtract instead of adding up: the
// Shannon CTA would lose its lobe from the circle it sits beside.
func orientWalked(ring [][2]float64, walked [][2]int) {
	for _, w := range walked {
		rest := append(append([][2]float64(nil), ring[:w[0]]...), ring[w[1]:]...)
		want := signedArea(rest)
		if want == 0 || math.Signbit(want) == math.Signbit(signedArea(ring[w[0]:w[1]])) {
			continue
		}
		for i, j := w[0], w[1]-1; i < j; i, j = i+1, j-1 {
			ring[i], ring[j] = ring[j], ring[i]
		}
	}
}

// signedArea is a ring's shoelace area in degrees, longitude scaled by the
// cosine of its mean latitude: only its sign is read.
func signedArea(ring [][2]float64) float64 {
	if len(ring) < 3 {
		return 0
	}
	lat := 0.0
	for _, p := range ring {
		lat += p[0]
	}
	k := math.Cos(lat / float64(len(ring)) * math.Pi / 180)
	a := 0.0
	for i := range ring {
		p, q := ring[i], ring[(i+1)%len(ring)]
		a += p[1]*k*q[0] - q[1]*k*p[0]
	}
	return a / 2
}

// arcWordRe is a word that only an arc or a circle phrase uses.
var arcWordRe = regexp.MustCompile(`(?i)\b(?:arcs?|circles?|circular|CWA|CCA|CCWA)\b`)

// unreadArc reports text naming an arc or a circle outside every phrase
// that was read.
func unreadArc(text string, events []bEvent) bool {
	for _, m := range arcWordRe.FindAllStringIndex(text, -1) {
		read := false
		for _, e := range events {
			if e.kind != 'p' && m[0] >= e.start-40 && m[0] < e.end {
				// Inside a phrase, or just before one: "circular arc CW 7
				// NM around" opens where the match begins, at "arc".
				read = true
				break
			}
		}
		if !read {
			return true
		}
	}
	return false
}

// originRe is the start of a ring named in words.
var originRe = regexp.MustCompile(`(?i)\b(?:origin|beginning|starting\s+point|first\s+point)\b`)

// onCircle reports p lying on the circle e describes, within 3% of its
// radius: the point a circle is walked from, as against its centre
// written before it (Avians gives the Icelandic phrase, which no pattern
// reads, and then the English one).
func onCircle(p [2]float64, e bEvent) bool {
	d := geodesy.DistanceM(e.cenLat, e.cenLon, p[0], p[1])
	return math.Abs(d-e.radiusM) <= 0.03*e.radiusM
}

// rotateFrom returns the circle's points starting from the one nearest p.
func rotateFrom(circle [][2]float64, p [2]float64) [][2]float64 {
	best, bestD := 0, math.Inf(1)
	for i, q := range circle {
		if d := geodesy.DistanceM(p[0], p[1], q[0], q[1]); d < bestD {
			best, bestD = i, d
		}
	}
	return append(append([][2]float64(nil), circle[best:]...), circle[:best]...)
}

// drawArc tessellates one arc from the ring's current end to p. An arc
// whose sense the State did not state is drawn the short way round, or
// the long way where sense says so.
func drawArc(ring *[][2]float64, e bEvent, p [2]float64, sense *arcSense, st *BoundaryStats) {
	if len(*ring) == 0 {
		return
	}
	prev := (*ring)[len(*ring)-1]
	cw := e.clockwise
	if !e.dirKnown {
		cw = shorterSweepClockwise(prev, p, e.cenLat, e.cenLon)
		if sense.flip&(1<<sense.unknown) != 0 {
			cw = !cw
		}
		sense.unknown++
	}
	r := e.radiusM
	if r == 0 {
		// The arc leaves prev, which is on it.
		r = geodesy.DistanceM(e.cenLat, e.cenLon, prev[0], prev[1])
	}
	st.Arcs++
	for _, q := range geodesy.ArcPoints(prev[0], prev[1], p[0], p[1], e.cenLat, e.cenLon, r, cw) {
		appendPoint(ring, [2]float64{Round5(q[0]), Round5(q[1])})
	}
}

// sectorRing draws a sector: from the centre out along the first bearing,
// clockwise round to the second and back, or, for an annulus's, out along
// the first bearing at the outer radius and back along the inner. A
// sector reaching beyond a circle round the same centre runs round that
// circle from the second bearing to the first, the rest of it, and then
// round the sector's own arc.
func sectorRing(e bEvent) [][2]float64 {
	c := [2]float64{e.cenLat, e.cenLon}
	at := func(bearing, r float64) [2]float64 {
		lat, lon := geodesy.DestPoint(c[0], c[1], bearing, r)
		return [2]float64{Round5(lat), Round5(lon)}
	}
	var ring [][2]float64
	arc := func(from, to, r float64, clockwise bool) {
		p, q := at(from, r), at(to, r)
		appendPoint(&ring, p)
		for _, x := range geodesy.ArcPoints(p[0], p[1], q[0], q[1], c[0], c[1], r, clockwise) {
			appendPoint(&ring, [2]float64{Round5(x[0]), Round5(x[1])})
		}
		appendPoint(&ring, q)
	}
	switch {
	case e.coreM > 0:
		arc(e.toDeg, e.fromDeg, e.coreM, true)
		arc(e.fromDeg, e.toDeg, e.radiusM, true)
	case e.innerM > 0:
		arc(e.fromDeg, e.toDeg, e.radiusM, true)
		arc(e.toDeg, e.fromDeg, e.innerM, false)
	default:
		appendPoint(&ring, [2]float64{Round5(c[0]), Round5(c[1])})
		arc(e.fromDeg, e.toDeg, e.radiusM, true)
	}
	return ring
}

// shorterSweepClockwise picks the sense that sweeps less than half a
// turn between the two radii.
func shorterSweepClockwise(a, b [2]float64, cenLat, cenLon float64) bool {
	b0 := geodesy.InitialBearing(cenLat, cenLon, a[0], a[1])
	b1 := geodesy.InitialBearing(cenLat, cenLon, b[0], b[1])
	return math.Mod(b1-b0+360, 360) <= 180
}

// appendStitch inserts the border-ring vertices between the ring's last
// point and next. Falls back to the plain chord (nothing inserted) when no
// usable path exists.
func appendStitch(ring *[][2]float64, border *BorderRing, next [2]float64, st *BoundaryStats) {
	prev := (*ring)[len(*ring)-1]
	Pts := border.stitch(prev, next)
	if Pts == nil {
		st.BorderChords++
		return
	}
	st.BorderStitched++
	for _, p := range Pts {
		appendPoint(ring, p)
	}
}

func appendPoint(ring *[][2]float64, p [2]float64) {
	if n := len(*ring); n > 0 && (*ring)[n-1] == p {
		return
	}
	*ring = append(*ring, p)
}

func group(s string, m []int, i int) string {
	if 2*i+1 >= len(m) || m[2*i] < 0 {
		return ""
	}
	return s[m[2*i]:m[2*i+1]]
}

// centreStartRe begins a centre phrase.
var centreStartRe = regexp.MustCompile(`(?i)^(?:and\s+)?(?:cent(?:r|er)ed|cent(?:re|er)|around|with\s+(?:the\s+|a\s+)?cent)`)

// overlaps reports a span meeting any event already read.
func overlaps(events []bEvent, start, end int) bool {
	for _, e := range events {
		if start < e.end && e.start < end {
			return true
		}
	}
	return false
}

func inside(events []bEvent, pos int) bool {
	for _, e := range events {
		if pos >= e.start && pos < e.end {
			return true
		}
	}
	return false
}

func sortEvents(events []bEvent) {
	for i := 1; i < len(events); i++ {
		for j := i; j > 0 && events[j].start < events[j-1].start; j-- {
			events[j], events[j-1] = events[j-1], events[j]
		}
	}
}

func clampIdx(i, n int) int {
	if i < 0 {
		return 0
	}
	if i > n {
		return n
	}
	return i
}

func Round5(x float64) float64 { return math.Round(x*1e5) / 1e5 }

// CircleRingAround tessellates a full circle around c.
func CircleRingAround(c [2]float64, radiusM float64) [][2]float64 {
	out := make([][2]float64, 0, geodesy.CircleSteps)
	for _, p := range geodesy.CircleRing(c[0], c[1], radiusM) {
		out = append(out, [2]float64{Round5(p[0]), Round5(p[1])})
	}
	return out
}

// --- border ring ------------------------------------------------------------

// maxStitchDistM is how far a boundary point may sit from the FIR ring and
// still be considered "on the border". Published zone vertices sit ON the
// border; the pruatlas ring is a simplification, so allow a few km.
const maxStitchDistM = 20000

// BorderRing is the EBBU FIR boundary used to interpolate "along the
// ... border" segments.
type BorderRing struct {
	Pts [][2]float64
}

// LoadBorderRing reads one FIR ring from the checked-in pruatlas dataset
// ({fields, rows} with positional rows). A State's own FIR ring IS the
// national boundary every published border segment lies on, which is what
// makes it the stitching path. Returns nil (no error) when the file
// exists but carries no row for the ident.
func LoadBorderRing(path, ident string) (*BorderRing, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var doc struct {
		Fields []string          `json:"fields"`
		Rows   []json.RawMessage `json:"rows"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	idIdx, ringIdx := -1, -1
	for i, f := range doc.Fields {
		switch f {
		case "id":
			idIdx = i
		case "ring":
			ringIdx = i
		}
	}
	if idIdx < 0 || ringIdx < 0 {
		return nil, fmt.Errorf("%s: no id/ring fields", path)
	}
	for _, raw := range doc.Rows {
		var row []json.RawMessage
		if err := json.Unmarshal(raw, &row); err != nil || len(row) <= max(idIdx, ringIdx) {
			continue
		}
		var id string
		if json.Unmarshal(row[idIdx], &id) != nil || id != ident {
			continue
		}
		var ring [][2]float64
		if err := json.Unmarshal(row[ringIdx], &ring); err != nil {
			return nil, fmt.Errorf("%s: %s ring: %w", path, ident, err)
		}
		if len(ring) < 3 {
			return nil, fmt.Errorf("%s: %s ring too short", path, ident)
		}
		return &BorderRing{Pts: ring}, nil
	}
	return nil, nil
}

// stitch returns the ring vertices to walk from near a to near b (endpoints
// of the walk included, a and b themselves excluded), following the shorter
// way around the ring. nil when either point is too far from the ring.
func (r *BorderRing) stitch(a, b [2]float64) [][2]float64 {
	if r == nil || len(r.Pts) < 3 {
		return nil
	}
	ia, da := r.nearest(a)
	ib, db := r.nearest(b)
	if da > maxStitchDistM || db > maxStitchDistM || ia == ib {
		return nil
	}
	n := len(r.Pts)
	fwd := r.pathLen(ia, ib, +1)
	bwd := r.pathLen(ia, ib, -1)
	step := +1
	if bwd < fwd {
		step = -1
	}
	var out [][2]float64
	for i := ia; ; i = (i + step + n) % n {
		out = append(out, r.Pts[i])
		if i == ib {
			break
		}
		if len(out) > n {
			return nil // safety: malformed ring
		}
	}
	return out
}

// nearest returns the index of the ring vertex closest to p and its
// distance in metres.
func (r *BorderRing) nearest(p [2]float64) (int, float64) {
	best, bestD := 0, math.MaxFloat64
	for i, q := range r.Pts {
		if d := distM(p, q); d < bestD {
			best, bestD = i, d
		}
	}
	return best, bestD
}

// pathLen sums the segment lengths walking the ring from ia to ib in the
// given direction.
func (r *BorderRing) pathLen(ia, ib, step int) float64 {
	n := len(r.Pts)
	total := 0.0
	for i := ia; i != ib; {
		j := (i + step + n) % n
		total += distM(r.Pts[i], r.Pts[j])
		i = j
		if total > 1e9 {
			break
		}
	}
	return total
}

// distM is the equirectangular distance in metres, plenty at Belgian
// latitudes for nearest-vertex tests.
func distM(a, b [2]float64) float64 {
	latRad := (a[0] + b[0]) / 2 * math.Pi / 180
	dLat := (a[0] - b[0]) * math.Pi / 180
	dLon := (a[1] - b[1]) * math.Pi / 180 * math.Cos(latRad)
	return math.Sqrt(dLat*dLat+dLon*dLon) * geodesy.EarthRadiusM
}
