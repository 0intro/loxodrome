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
}

// The radius grammar differs between States in three ways, and all have
// to be accepted or a zone silently degrades to a default-size circle,
// which would be a false statement about where an aircraft may fly:
//
//   - the value may come BEFORE or AFTER the word "radius" ("of 3 NM
//     radius" in Belgium, "radius 3 KM" in Hungary and Portugal, "of
//     radius 1.1 NM" in Czechia);
//   - the word may be absent entirely ("a clockwise arc 25NM centred on");
//   - the unit may be NM, KM or M.
const radiusPat = `(?:(?:of\s+|with\s+a\s+)?([\d.]+)\s*(NM|KM|M)(?:\s+radius)?` +
	`|(?:of\s+|with\s+)?(?:a\s+)?radius\s*(?:of\s+)?([\d.]+)\s*(NM|KM|M))`

// centrePat is how a State names the centre of a circle or arc. Every
// wording in the cohort is here, and the differences are only wording:
// "centred on X" (Belgium), "centred at point: X" (Poland), "with the
// centre point at: X" (Slovakia), "centered on X" where the State
// follows FAA spelling. The preposition may sit on either side of the
// noun, which is why it appears twice and is optional both times.
const centrePat = `(?:cent(?:r|er)ed|with\s+(?:the\s+|a\s+)?cent(?:re|er))` +
	`(?:\s+(?:on|at|upon|of))?\s*(?:the\s+|a\s+)?(?:point|position|coordinates)?` +
	`(?:\s+(?:on|at|upon|of))?\s*:?\s*`

// dirPat is the sense an arc is traced in. States write it as one word,
// two words or hyphenated, and "anti" for "counter".
const dirPat = `(counter\s*-?\s*clockwise|anti\s*-?\s*clockwise|clockwise)`

var (
	arcRe = regexp.MustCompile(`(?i)\ban arc of (?:a )?circle\s*,?\s*` + radiusPat +
		`\s*,?\s*` + centrePat +
		CoordPat + `\s*,?\s+(?:and\s+)?traced\s+` + dirPat + `\s+to\s+` + CoordPat)
	// arcOpenRe is the same arc written WITHOUT its end point, which is
	// then simply the next coordinate of the list: "then a clockwise arc
	// radius 20 KM centred on 415124N 0064227W - 415632N 0065510W".
	// Portugal, Hungary and Poland all write arcs this way, and the sense
	// may sit before the word "arc", after it, or be absent altogether.
	arcOpenRe = regexp.MustCompile(`(?i)\b(?:` + dirPat + `\s+)?arc(?:\s+of\s+(?:a\s+)?circle)?\s*,?\s*(?:` +
		dirPat + `\s*,?\s*)?` + radiusPat +
		`\s*,?\s*` + centrePat + CoordPat)
	// The article is optional: Poland writes "Circle of 3 km radius
	// centred at point: ..." with none.
	fullCircleRe = regexp.MustCompile(`(?i)\b(?:an?\s+)?circle\s*,?\s*` + radiusPat +
		`\s*,?\s*` + centrePat + CoordPat)
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
	v, err := strconv.ParseFloat(val, 64)
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
	kind       byte // 'p' point, 'a' arc, 'A' open arc, 'c' circle
	// point / arc-end coordinates
	lat, lon float64
	// arc / circle parameters
	cenLat, cenLon, radiusM float64
	clockwise               bool
	// dirKnown is false when the State stated no sense; the arc is then
	// drawn the short way round, which is the one an AIP means when it
	// leaves the sense out.
	dirKnown bool
}

// clockwiseWord reads an arc sense out of whichever of the two capture
// slots the State filled.
func clockwiseWord(a, b string) (clockwise, known bool) {
	w := strings.ToLower(a + b)
	if w == "" {
		return false, false
	}
	return !strings.Contains(w, "counter") && !strings.Contains(w, "anti"), true
}

// ParseBoundary parses a lateral-limits sentence into a [lat, lon] ring.
// Returns nil when no geometry is recognisable.
func ParseBoundary(text string, border *BorderRing, st *BoundaryStats) [][2]float64 {
	text = NormSpace(text)
	var events []bEvent

	for _, m := range arcRe.FindAllStringSubmatchIndex(text, -1) {
		radiusM, okR := radiusMetres(group(text, m, 1), group(text, m, 2), group(text, m, 3), group(text, m, 4))
		cenLat, cenLon, ok1 := ParsePair(group(text, m, 5), group(text, m, 6))
		dir := strings.ToLower(group(text, m, 7))
		endLat, endLon, ok2 := ParsePair(group(text, m, 8), group(text, m, 9))
		if !okR || !ok1 || !ok2 {
			continue
		}
		events = append(events, bEvent{
			start: m[0], end: m[1], kind: 'a',
			lat: endLat, lon: endLon,
			cenLat: cenLat, cenLon: cenLon, radiusM: radiusM,
			clockwise: !strings.Contains(dir, "counter") && !strings.Contains(dir, "anti"),
			dirKnown:  true,
		})
	}
	for _, m := range arcOpenRe.FindAllStringSubmatchIndex(text, -1) {
		if inside(events, m[0]) {
			continue // the leading half of a fully written arc
		}
		radiusM, okR := radiusMetres(group(text, m, 3), group(text, m, 4), group(text, m, 5), group(text, m, 6))
		cenLat, cenLon, ok := ParsePair(group(text, m, 7), group(text, m, 8))
		if !okR || !ok {
			continue
		}
		cw, known := clockwiseWord(group(text, m, 1), group(text, m, 2))
		events = append(events, bEvent{
			start: m[0], end: m[1], kind: 'A',
			cenLat: cenLat, cenLon: cenLon, radiusM: radiusM,
			clockwise: cw, dirKnown: known,
		})
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
	for _, m := range CoordRe.FindAllStringSubmatchIndex(text, -1) {
		if inside(events, m[0]) {
			continue // part of an arc / circle phrase
		}
		lat, lon, ok := ParsePair(group(text, m, 1), group(text, m, 2))
		if !ok {
			continue
		}
		events = append(events, bEvent{start: m[0], end: m[1], kind: 'p', lat: lat, lon: lon})
	}
	// The spaced DMS form, which Slovenia writes its ENR 2 boundaries in.
	for _, m := range SpacedCoordRe.FindAllStringSubmatchIndex(text, -1) {
		if inside(events, m[0]) {
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
		if inside(events, m[0]) {
			continue
		}
		pt, ok := ShortCoord(text[m[0]:m[1]])
		if !ok {
			continue
		}
		events = append(events, bEvent{start: m[0], end: m[1], kind: 'p', lat: pt[0], lon: pt[1]})
	}

	sortEvents(events)

	var ring [][2]float64
	var open *bEvent // an arc awaiting its end point
	prevEnd := 0
	for i := range events {
		e := events[i]
		gap := text[clampIdx(prevEnd, len(text)):clampIdx(e.start, len(text))]
		switch e.kind {
		case 'p':
			if open != nil {
				drawArc(&ring, *open, [2]float64{e.lat, e.lon}, st)
				open = nil
			} else if borderWordRe.MatchString(gap) && len(ring) > 0 {
				appendStitch(&ring, border, [2]float64{e.lat, e.lon}, st)
			}
			appendPoint(&ring, [2]float64{e.lat, e.lon})
		case 'a':
			drawArc(&ring, e, [2]float64{e.lat, e.lon}, st)
			appendPoint(&ring, [2]float64{e.lat, e.lon})
		case 'A':
			open = &events[i]
		case 'c':
			st.Circles++
			ring = CircleRingAround([2]float64{e.cenLat, e.cenLon}, e.radiusM)
		}
		prevEnd = e.end
	}
	// An arc written last closes the ring back onto its first point.
	if open != nil && len(ring) > 0 {
		drawArc(&ring, *open, ring[0], st)
	}
	return ring
}

// drawArc tessellates one arc from the ring's current end to p. An arc
// whose sense the State did not state is drawn the short way round.
func drawArc(ring *[][2]float64, e bEvent, p [2]float64, st *BoundaryStats) {
	if len(*ring) == 0 {
		return
	}
	prev := (*ring)[len(*ring)-1]
	cw := e.clockwise
	if !e.dirKnown {
		cw = shorterSweepClockwise(prev, p, e.cenLat, e.cenLon)
	}
	st.Arcs++
	for _, q := range geodesy.ArcPoints(prev[0], prev[1], p[0], p[1], e.cenLat, e.cenLon, e.radiusM, cw) {
		appendPoint(ring, [2]float64{Round5(q[0]), Round5(q[1])})
	}
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
