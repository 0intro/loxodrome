package aixm5

import (
	"encoding/xml"
	"math"
	"strings"
)

// A boundary that follows a coastline or a State border is published as a
// curveMember LINKED to an aixm:GeoBorder rather than drawn out: NATS's
// coastlines (UK COASTLINE 1 to 14, the North Sea median line), Georgia's
// State borders. The border is one open polyline, and the airspace takes
// the stretch of it between the ring's vertices on either side of the
// link, in whichever direction the ring runs. Unfollowed, the ring cut
// across on a straight line: EGD802 CAPE WRATH up to 10 km off its coast,
// the Tbilisi FIR short of about 19 600 km2.
//
// The GeoBorder may come later in the file than the airspaces linking it
// (NATS files them at the end), so a ring with a link is assembled after
// the stream (resolveBorderRings); one whose border the message does not
// hold is counted in UnresolvedXlinks and UnresolvedGeometryXlinks and
// drawn across, as before.

// xmlGeoBorder mirrors aixm:GeoBorder: its identifier and the border
// curve of its BASELINE timeslice.
type xmlGeoBorder struct {
	GMLID      string              `xml:"id,attr"`
	Identifier string              `xml:"identifier"`
	TimeSlices []xmlGeoBorderSlice `xml:"timeSlice>GeoBorderTimeSlice"`
}

type xmlGeoBorderSlice struct {
	Interpretation string   `xml:"interpretation"`
	Border         gmlCurve `xml:"border>Curve"`
}

// decodeGeoBorderFeature reads one aixm:GeoBorder into msg's border index,
// its curve flattened into one polyline the way a ring's segments are
// (geodesic stretches densified).
func decodeGeoBorderFeature(dec *xml.Decoder, start *xml.StartElement, msg *Message) error {
	var f xmlGeoBorder
	if err := dec.DecodeElement(&f, start); err != nil {
		return err
	}
	for i := range f.TimeSlices {
		s := &f.TimeSlices[i]
		if !strings.EqualFold(strings.TrimSpace(s.Interpretation), "BASELINE") {
			msg.SkippedNonBaseline++
			continue
		}
		parts, soft, err := partsFromSegments(&s.Border.Segments)
		if err != nil {
			return err
		}
		msg.UnresolvedXlinks += soft
		line := dedupAdjacent(roundRing(joinParts(parts)))
		if len(line) < 2 {
			continue
		}
		if msg.borders == nil {
			msg.borders = map[string][][2]float64{}
		}
		msg.borders[featureIdentifier(f.GMLID, f.Identifier)] = line
	}
	return nil
}

// resolveBorderRings assembles the rings that link a GeoBorder, once the
// whole message is read.
func resolveBorderRings(msg *Message) {
	for i := range msg.Airspaces {
		a := &msg.Airspaces[i]
		if a.borderParts == nil {
			continue
		}
		a.Ring = ringFromParts(followBorders(a.borderParts, msg))
		a.borderParts = nil
	}
}

// hasBorderLink reports whether a ring's parts link a GeoBorder.
func hasBorderLink(parts []ringPart) bool {
	for _, p := range parts {
		if p.border != "" {
			return true
		}
	}
	return false
}

// followBorders replaces each border link among parts by the stretch of
// the border between the ring's vertices on either side of it: the
// border's own vertices strictly between where those two vertices fall on
// it, the two staying the ring's. A link to a border the message does not
// hold is dropped and counted, and the ring cuts across as it did.
func followBorders(parts []ringPart, msg *Message) []ringPart {
	out := make([]ringPart, 0, len(parts))
	for i, p := range parts {
		if p.border == "" {
			out = append(out, p)
			continue
		}
		line, ok := msg.borders[p.border]
		if !ok {
			msg.UnresolvedXlinks++
			msg.UnresolvedGeometryXlinks++
			continue
		}
		prev, okPrev := neighbourVertex(parts, i, -1)
		next, okNext := neighbourVertex(parts, i, +1)
		if !okPrev || !okNext {
			// Nothing on one side to say where the stretch ends: the
			// border whole.
			out = append(out, ringPart{pts: line})
			continue
		}
		out = append(out, ringPart{pts: borderStretch(line, prev, next)})
	}
	return out
}

// neighbourVertex is the ring's vertex on one side of parts[i]: the last
// point of the nearest part before it holding one (dir -1), or the first
// of the nearest after it (dir +1), around the ring. Another border link
// is passed over.
func neighbourVertex(parts []ringPart, i, dir int) ([2]float64, bool) {
	n := len(parts)
	for k := 1; k < n; k++ {
		p := parts[((i+dir*k)%n+n)%n]
		if p.border != "" || len(p.pts) == 0 {
			continue
		}
		if dir < 0 {
			return p.pts[len(p.pts)-1], true
		}
		return p.pts[0], true
	}
	return [2]float64{}, false
}

// borderStretch is the run of line's vertices strictly between where from
// and to fall on it (their nearest points on the polyline), in the order
// from runs to to.
func borderStretch(line [][2]float64, from, to [2]float64) [][2]float64 {
	a, b := positionOnLine(line, from), positionOnLine(line, to)
	var out [][2]float64
	if a <= b {
		for k := int(math.Floor(a)) + 1; float64(k) < b && k < len(line); k++ {
			out = append(out, line[k])
		}
		return out
	}
	for k := int(math.Ceil(a)) - 1; float64(k) > b && k >= 0; k-- {
		out = append(out, line[k])
	}
	return out
}

// positionOnLine is where p falls on line, the nearest point of it, as a
// vertex index plus the fraction of the next segment: 2.5 is halfway from
// line[2] to line[3]. Distances are read on a plane tangent at p, which
// over a border's short segments is exact enough to rank them.
func positionOnLine(line [][2]float64, p [2]float64) float64 {
	k := math.Cos(p[0] * math.Pi / 180)
	xy := func(q [2]float64) (float64, float64) { return (q[1] - p[1]) * k, q[0] - p[0] }
	best, bestD := 0.0, math.Inf(1)
	for i := 0; i+1 < len(line); i++ {
		ax, ay := xy(line[i])
		bx, by := xy(line[i+1])
		dx, dy := bx-ax, by-ay
		t := 0.0
		if l2 := dx*dx + dy*dy; l2 > 0 {
			t = math.Max(0, math.Min(1, -(ax*dx+ay*dy)/l2))
		}
		cx, cy := ax+t*dx, ay+t*dy
		if d := cx*cx + cy*cy; d < bestD {
			best, bestD = float64(i)+t, d
		}
	}
	return best
}
