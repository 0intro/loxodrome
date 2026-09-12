package aixm5

import (
	"encoding/xml"
	"fmt"
	"math"
	"strconv"
	"strings"

	"github.com/0intro/loxodrome/internal/geodesy"
)

// parsePosList parses a "lat lon lat lon ..." string into [lat, lon]
// pairs. AIXM 5.1 always uses EPSG:4326 with srsDimension=2 and
// lat-first ordering for the documents this package consumes; both
// Donlon and the UK NATS / Spain ENAIRE publications follow this
// convention. Whitespace runs (newlines included) collapse.
func parsePosList(s string) ([][2]float64, error) {
	fields := strings.Fields(s)
	if len(fields)%2 != 0 {
		return nil, fmt.Errorf("posList has odd value count %d", len(fields))
	}
	out := make([][2]float64, 0, len(fields)/2)
	for i := 0; i < len(fields); i += 2 {
		lat, err := strconv.ParseFloat(fields[i], 64)
		if err != nil {
			return nil, fmt.Errorf("lat[%d] %q: %w", i, fields[i], err)
		}
		lon, err := strconv.ParseFloat(fields[i+1], 64)
		if err != nil {
			return nil, fmt.Errorf("lon[%d] %q: %w", i+1, fields[i+1], err)
		}
		out = append(out, [2]float64{lat, lon})
	}
	return out, nil
}

// parsePos parses a single "lat lon" pair from a gml:pos string.
func parsePos(s string) (lat, lon float64, ok bool) {
	fields := strings.Fields(s)
	if len(fields) != 2 {
		return 0, 0, false
	}
	la, err := strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return 0, 0, false
	}
	lo, err := strconv.ParseFloat(fields[1], 64)
	if err != nil {
		return 0, 0, false
	}
	return la, lo, true
}

// radiusToMeters parses an AIXM/GML radius value+unit into metres.
// Recognised units cover both the ICAO short forms and the UCUM
// (Unified Code for Units of Measure) syntax NATS UK uses:
//   - "NM" / "[nmi_i]" / "nmi" - nautical miles
//   - "KM" / "km"              - kilometres
//   - "M"                      - metres
//   - "FT" / "[ft_i]"          - feet
//   - "MI" / "[mi_i]"          - statute miles
func radiusToMeters(val, uom string) (float64, error) {
	v, err := strconv.ParseFloat(strings.TrimSpace(val), 64)
	if err != nil {
		return 0, fmt.Errorf("bad radius %q", val)
	}
	switch strings.ToUpper(strings.TrimSpace(uom)) {
	case "NM", "[NMI_I]", "NMI":
		return v * 1852, nil
	case "KM":
		return v * 1000, nil
	case "M":
		return v, nil
	case "FT", "[FT_I]":
		return v * 0.3048, nil
	case "MI", "[MI_I]":
		return v * 1609.344, nil
	default:
		return 0, fmt.Errorf("unknown radius unit %q", uom)
	}
}

// surfaceRing is one decoded boundary ring built from a gml:Surface
// (or aixm:Surface / aixm:ElevatedSurface, all schema-equivalent).
// Currently only the exterior of the first PolygonPatch is returned;
// interior holes are ignored. Empty when the surface has no
// usable geometry.
type surfaceRing struct {
	points [][2]float64
}

// gmlSurface mirrors aixm:Surface or gml:Surface; one or more
// PolygonPatch children.
type gmlSurface struct {
	Patches []gmlPolygonPatch `xml:"patches>PolygonPatch"`
}

type gmlPolygonPatch struct {
	Exterior gmlExterior `xml:"exterior"`
}

type gmlExterior struct {
	Ring gmlRing `xml:"Ring"`
}

type gmlRing struct {
	CurveMembers []gmlCurveMember `xml:"curveMember"`
}

type gmlCurveMember struct {
	Curve gmlCurve `xml:"Curve"`
}

type gmlCurve struct {
	Segments gmlSegments `xml:"segments"`
}

// gmlSegments keeps the curve's segments in DOCUMENT order across
// kinds. Publishers DO mix kinds inside one <gml:segments>: the NATS
// FIR boundaries interleave GeodesicString runs with linear
// LineStringSegment stretches along parallels (LONDON FIR: geodesic
// to 50N 000d15'W, linear along 50N, geodesic up the Irish Sea,
// linear along 55N), and per-kind grouping used to re-order those
// into a self-crossing bowtie. The custom UnmarshalXML below is what
// preserves the interleaving; encoding/xml's struct mapping cannot.
type gmlSegments struct {
	Items []gmlSegmentItem
}

// gmlSegmentItem is a one-of union: exactly one field is non-nil.
type gmlSegmentItem struct {
	Geodesic *gmlGeodesicString
	Line     *gmlLineStringSegment
	Circle   *gmlCircle
	Arc      *gmlArc
}

// UnmarshalXML walks the <gml:segments> children token by token so
// mixed segment kinds keep their document order. Unknown segment
// kinds are skipped (counted nowhere: the ring closes over them,
// which the degenerate-ring guard downstream catches when it
// matters).
func (s *gmlSegments) UnmarshalXML(d *xml.Decoder, _ xml.StartElement) error {
	for {
		tok, err := d.Token()
		if err != nil {
			return err
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "GeodesicString":
				var g gmlGeodesicString
				if err := d.DecodeElement(&g, &t); err != nil {
					return err
				}
				s.Items = append(s.Items, gmlSegmentItem{Geodesic: &g})
			case "LineStringSegment":
				var l gmlLineStringSegment
				if err := d.DecodeElement(&l, &t); err != nil {
					return err
				}
				s.Items = append(s.Items, gmlSegmentItem{Line: &l})
			case "CircleByCenterPoint":
				var c gmlCircle
				if err := d.DecodeElement(&c, &t); err != nil {
					return err
				}
				s.Items = append(s.Items, gmlSegmentItem{Circle: &c})
			case "ArcByCenterPoint":
				var a gmlArc
				if err := d.DecodeElement(&a, &t); err != nil {
					return err
				}
				s.Items = append(s.Items, gmlSegmentItem{Arc: &a})
			default:
				if err := d.Skip(); err != nil {
					return err
				}
			}
		case xml.EndElement:
			return nil
		}
	}
}

// gmlGeodesicString supports three AIXM 5.1 encodings:
//   - A single <gml:posList> with the entire boundary as space-
//     separated "lat lon lat lon ..." (Donlon convention; the
//     compact form recommended by the spec).
//   - A sequence of <gml:pos> children, each one vertex "lat lon"
//     (DFS Germany's "stroked border" files expand every shared
//     border into individual points this way).
//   - A sequence of <gml:pointProperty> children, each containing
//     either an inline <aixm:Point>/<gml:Point> with <gml:pos>, or
//     an xlink:href to a named point feature elsewhere in the
//     message (NATS UK convention; each vertex is a first-class
//     feature with its own metadata).
type gmlGeodesicString struct {
	PosList string             `xml:"posList"`
	Pos     []string           `xml:"pos"`
	Points  []xmlPointProperty `xml:"pointProperty"`
}

type gmlLineStringSegment struct {
	PosList string             `xml:"posList"`
	Pos     []string           `xml:"pos"`
	Points  []xmlPointProperty `xml:"pointProperty"`
}

type gmlCircle struct {
	// Two AIXM-permitted ways to give the centre: an inline gml:posList
	// or a gml:pointProperty wrapping an aixm:Point with its own
	// gml:pos. Donlon uses both; UK NATS and ENAIRE differ by
	// publisher. centrePos() picks whichever is populated.
	PosList       string            `xml:"posList"`
	PointProperty *xmlPointProperty `xml:"pointProperty"`
	Radius        gmlRadius         `xml:"radius"`
}

type gmlArc struct {
	PosList       string            `xml:"posList"` // "centerLat centerLon"
	PointProperty *xmlPointProperty `xml:"pointProperty"`
	Radius        gmlRadius         `xml:"radius"`
	StartAngle    gmlAngle          `xml:"startAngle"`
	EndAngle      gmlAngle          `xml:"endAngle"`
}

// xmlPointProperty wraps the GML pointProperty wrapper around an
// aixm:Point. xlink:href references to remote points are not
// resolved (no in-message Point index is built yet); they fall
// through to the empty centre case and the caller errors out
// loudly. Real production data we've seen inlines the point.
type xmlPointProperty struct {
	Point *xmlInlinePoint `xml:"Point"`
	Href  string          `xml:"href,attr"`
}

// xmlInlinePoint is an aixm:Point with an inline gml:pos child. The
// surrounding aixm:annotation noise (notes, reference-point
// descriptions) is ignored.
type xmlInlinePoint struct {
	Pos string `xml:"pos"`
}

type gmlRadius struct {
	UOM   string `xml:"uom,attr"`
	Value string `xml:",chardata"`
}

type gmlAngle struct {
	UOM   string `xml:"uom,attr"`
	Value string `xml:",chardata"`
}

// ringFromSurface flattens a Surface into a closed [lat,lon] ring.
// curveMembers are concatenated in document order; each curveMember
// contributes its segments in (geodesic, circle, arc) order.
//
// Soft failures (xlink-referenced points the decoder can't resolve)
// are counted into msg.UnresolvedXlinks and the affected vertex is
// silently skipped. The ring is dropped only if it ends up
// degenerate (<3 points); partial rings with one missing vertex
// among many emit with a barely-perceptible distortion rather than
// disappearing from the map entirely. Hard failures (parse errors,
// unknown units) still propagate as errors.
func ringFromSurface(s *gmlSurface, msg *Message) ([][2]float64, error) {
	if s == nil || len(s.Patches) == 0 {
		return nil, nil
	}
	patch := s.Patches[0]
	var ring [][2]float64
	var totalSoft int
	for _, cm := range patch.Exterior.Ring.CurveMembers {
		pts, soft, err := pointsFromSegments(&cm.Curve.Segments)
		if err != nil {
			return nil, err
		}
		totalSoft += soft
		ring = append(ring, pts...)
	}
	msg.UnresolvedXlinks += totalSoft
	// GML curve chaining repeats the junction vertex: each segment's
	// point list starts where the previous one ended, so a boundary
	// split over several segments / curveMembers concatenates with
	// consecutive duplicates. Collapse them before the closing check.
	ring = dedupAdjacent(roundRing(ring))
	if len(ring) < 3 {
		return nil, nil
	}
	// AIXM 5.1 publishers usually duplicate the first vertex at the
	// end of a GeodesicString posList (a self-closed polygon). France
	// (cmd/fr) emits open rings; Leaflet auto-closes them. Drop the
	// duplicate so per-country JSON files are shape-consistent.
	ring = dropClosingDuplicate(ring)
	return ring, nil
}

// dedupAdjacent removes consecutive duplicate vertices (post-round5
// exact equality), the artifact of GML segment chaining.
func dedupAdjacent(ring [][2]float64) [][2]float64 {
	if len(ring) < 2 {
		return ring
	}
	out := ring[:1]
	for _, p := range ring[1:] {
		last := out[len(out)-1]
		if p[0] == last[0] && p[1] == last[1] {
			continue
		}
		out = append(out, p)
	}
	return out
}

// dropClosingDuplicate trims a trailing vertex that coincides with
// the first vertex (after the 5-dp rounding the caller applies). A
// no-op for circle / arc-derived rings (which don't self-close in
// the source data).
func dropClosingDuplicate(ring [][2]float64) [][2]float64 {
	if len(ring) < 2 {
		return ring
	}
	first, last := ring[0], ring[len(ring)-1]
	if math.Abs(first[0]-last[0]) < 1e-5 && math.Abs(first[1]-last[1]) < 1e-5 {
		return ring[:len(ring)-1]
	}
	return ring
}

// pointsFromSegments turns one <gml:segments> into a sequence of
// [lat,lon] points, walking the segments in document order (a curve
// may interleave geodesic, linear and arc pieces; see gmlSegments).
// soft is the count of segments / vertices that couldn't be resolved
// because their location was an xlink:href the decoder doesn't follow
// in-message; the caller decides what to do.
func pointsFromSegments(seg *gmlSegments) (pts [][2]float64, soft int, err error) {
	for _, it := range seg.Items {
		switch {
		case it.Geodesic != nil:
			p, s, err := pointsFromVertexList(it.Geodesic.PosList, it.Geodesic.Pos, it.Geodesic.Points)
			if err != nil {
				return nil, 0, fmt.Errorf("GeodesicString: %w", err)
			}
			// The segment is DECLARED a great circle; densify long
			// vertex pairs so the ring follows it instead of the
			// straight Mercator chord (the London FIR's 450 km
			// southwest-approaches leg bowed 4.3 km). Linear
			// segments below stay chords: linear lat/lon
			// interpolation IS the straight map line.
			for i, v := range p {
				if i > 0 {
					pts = append(pts, geodesy.DensifyGreatCircle(p[i-1], v)...)
				}
				pts = append(pts, v)
			}
			soft += s
		case it.Line != nil:
			p, s, err := pointsFromVertexList(it.Line.PosList, it.Line.Pos, it.Line.Points)
			if err != nil {
				return nil, 0, fmt.Errorf("LineStringSegment: %w", err)
			}
			pts = append(pts, p...)
			soft += s
		case it.Circle != nil:
			p, ok, err := tessellateCircle(*it.Circle)
			if err != nil {
				return nil, 0, fmt.Errorf("CircleByCenterPoint: %w", err)
			}
			if !ok {
				soft++
				continue
			}
			pts = append(pts, p...)
		case it.Arc != nil:
			p, ok, err := tessellateArc(*it.Arc)
			if err != nil {
				return nil, 0, fmt.Errorf("ArcByCenterPoint: %w", err)
			}
			if !ok {
				soft++
				continue
			}
			pts = append(pts, p...)
		}
	}
	return pts, soft, nil
}

// pointsFromVertexList resolves the three equivalent vertex encodings
// AIXM 5.1 publishers use:
//   - posList: compact space-separated "lat lon lat lon ..." (Donlon)
//   - directPos: a sequence of <gml:pos> "lat lon" vertices (DFS
//     Germany's stroked-border files)
//   - Per-vertex <gml:pointProperty> with inline aixm:Point or
//     an xlink:href reference (NATS)
//
// Points specified by xlink:href that can't be resolved in-message
// (no inline aixm:Point present) bump soft so the caller counts the
// gap into UnresolvedXlinks.
func pointsFromVertexList(posList string, directPos []string, pps []xmlPointProperty) (pts [][2]float64, soft int, err error) {
	if posList != "" {
		p, err := parsePosList(posList)
		if err != nil {
			return nil, 0, err
		}
		return p, 0, nil
	}
	if len(directPos) > 0 {
		for _, s := range directPos {
			la, lo, ok := parsePos(s)
			if !ok {
				soft++
				continue
			}
			pts = append(pts, [2]float64{la, lo})
		}
		return pts, soft, nil
	}
	for _, pp := range pps {
		if pp.Point != nil {
			la, lo, ok := parsePos(pp.Point.Pos)
			if !ok {
				soft++
				continue
			}
			pts = append(pts, [2]float64{la, lo})
			continue
		}
		soft++ // xlink:href only; the in-message Point index
		// (post-stream resolveAirspaces) will eventually fill these.
	}
	return pts, soft, nil
}

// tessellateCircle approximates the circle as a closed ring. Same
// CircleSteps as France's pipeline so smallest-on-top ordering
// behaves consistently across the two AIXM versions. resolved=false
// when the centre was only provided as an xlink:href; caller bumps
// UnresolvedXlinks and skips the segment.
func tessellateCircle(c gmlCircle) (ring [][2]float64, resolved bool, err error) {
	lat, lon, ok := centrePos(c.PosList, c.PointProperty)
	if !ok {
		return nil, false, nil
	}
	rm, err := radiusToMeters(c.Radius.Value, c.Radius.UOM)
	if err != nil {
		return nil, false, err
	}
	return geodesy.CircleRing(lat, lon, rm), true, nil
}

// centrePos picks the inline centre from either a posList or an
// inline pointProperty/Point/pos. Returns ok=false when the AIXM
// only provided an xlink:href reference (production data we've
// inspected always inlines the centre).
func centrePos(posList string, pp *xmlPointProperty) (lat, lon float64, ok bool) {
	if posList != "" {
		return parsePos(posList)
	}
	if pp != nil && pp.Point != nil {
		return parsePos(pp.Point.Pos)
	}
	return 0, 0, false
}

// tessellateArc approximates the arc between startAngle and endAngle
// around the centre by stepping geodesy.ArcStepDeg-sized bearings,
// matching France's tessellation density. AIXM 5.1 angles are in
// degrees, clockwise from north when uom is "deg" (the default in
// every publisher's data we've seen).
func tessellateArc(a gmlArc) (ring [][2]float64, resolved bool, err error) {
	lat, lon, ok := centrePos(a.PosList, a.PointProperty)
	if !ok {
		return nil, false, nil
	}
	rm, err := radiusToMeters(a.Radius.Value, a.Radius.UOM)
	if err != nil {
		return nil, false, err
	}
	start, err := strconv.ParseFloat(strings.TrimSpace(a.StartAngle.Value), 64)
	if err != nil {
		return nil, false, fmt.Errorf("startAngle: %w", err)
	}
	end, err := strconv.ParseFloat(strings.TrimSpace(a.EndAngle.Value), 64)
	if err != nil {
		return nil, false, fmt.Errorf("endAngle: %w", err)
	}
	// Clockwise sweep in [0, 360); GML's angle convention is
	// clockwise-from-north (true bearing).
	sweep := math.Mod(end-start+360, 360)
	if sweep < 1e-6 {
		sweep = 360
	}
	steps := int(math.Ceil(sweep / geodesy.ArcStepDeg))
	pts := make([][2]float64, 0, steps+1)
	for i := 0; i <= steps; i++ {
		frac := float64(i) / float64(steps)
		bearing := start + frac*sweep
		la, lo := geodesy.DestPoint(lat, lon, bearing, rm)
		pts = append(pts, [2]float64{la, lo})
	}
	return pts, true, nil
}

// roundRing rounds every coordinate in a ring to 5 decimal places, the
// same precision the France pipeline uses (~1 metre at equatorial
// scale). Keeps the per-country JSON files diff-stable across runs.
func roundRing(ring [][2]float64) [][2]float64 {
	for i := range ring {
		ring[i][0] = round5(ring[i][0])
		ring[i][1] = round5(ring[i][1])
	}
	return ring
}

// round5 mirrors aip.Round5 (banker's rounding to 5 dp); avoids a
// dependency cycle between internal/aixm5 and internal/aip.
func round5(x float64) float64 {
	return math.Round(x*1e5) / 1e5
}
