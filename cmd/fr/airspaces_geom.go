// geometry.go converts AIXM boundary geometry into decimal-degree polygon
// rings: arc tessellation, circle expansion, border walks, point-as-circle
// fallback for single-vertex D-OTHER zones. DMS decoding lives in
// internal/aip; geodesic math (bearings, arc points, unit conversion) in
// internal/geodesy.

package main

import (
	"fmt"
	"math"
	"strings"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/geodesy"
)

// parseLat / parseLon / round5 forward to internal/aip so the rest of
// geometry.go can keep its short call sites.
func parseLat(s string) (float64, bool) { return aip.ParseLat(s) }
func parseLon(s string) (float64, bool) { return aip.ParseLon(s) }
func round5(x float64) float64          { return aip.Round5(x) }

// boundaryRing builds the decimal-degree polygon ring for an airspace
// boundary. Each vertex says how the edge leaving it, to the next vertex,
// is drawn. GRC ("great circle") edges are densified through the shared
// geodesy.DensifyGreatCircle so the ring follows the declared geodesic
// instead of a straight Mercator chord (the LFRR 48°50'N 8°W -> 50°N 2°W
// leg bowed 4.3 km; the same helper serves the AIXM 5.1 pipeline, so a
// neighbour state publishing the same corners emits the same polyline).
// RHL ("rhumb line", the parallel runs) stays a chord: a rhumb IS the
// straight Mercator line. FNT ("follows national frontier") walks the
// border the vertex names (geoBorders.run), and falls back to the chord
// when that border is missing or an end lies off it, which edges counts.
// Overseas territories sit far from ±180°, so no antimeridian handling is
// needed.
func boundaryRing(abd *Abd, borders geoBorders) ([][2]float64, fntEdges, error) {
	var edges fntEdges
	if abd.Circle != nil {
		c := abd.Circle
		lat, okLat := parseLat(c.GeoLatCen)
		lon, okLon := parseLon(c.GeoLongCen)
		if !okLat || !okLon {
			return nil, edges, fmt.Errorf("circle: bad centre coordinates")
		}
		rm, err := geodesy.RadiusMeters(c.ValRadius, c.UomRadius)
		if err != nil {
			return nil, edges, fmt.Errorf("circle: %w", err)
		}
		return roundRing(geodesy.CircleRing(lat, lon, rm)), edges, nil
	}

	n := len(abd.Avx)
	if n == 0 {
		return nil, edges, fmt.Errorf("boundary has no vertices")
	}
	pos := make([][2]float64, n)
	for i, v := range abd.Avx {
		lat, okLat := parseLat(v.GeoLat)
		lon, okLon := parseLon(v.GeoLong)
		if !okLat || !okLon {
			return nil, edges, fmt.Errorf("vertex %d: bad coordinates", i)
		}
		pos[i] = [2]float64{lat, lon}
	}

	var ring [][2]float64
	for i := 0; i < n; i++ {
		ring = append(ring, pos[i])
		v := abd.Avx[i]
		next := pos[(i+1)%n]
		switch v.CodeType {
		case "CWA", "CCA":
			cenLat, okLat := parseLat(v.GeoLatArc)
			cenLon, okLon := parseLon(v.GeoLongArc)
			if !okLat || !okLon {
				return nil, edges, fmt.Errorf("vertex %d: bad arc centre", i)
			}
			rm, err := geodesy.RadiusMeters(v.ValRadiusArc, v.UomRadiusArc)
			if err != nil {
				return nil, edges, fmt.Errorf("vertex %d arc: %w", i, err)
			}
			ring = append(ring, geodesy.ArcPoints(pos[i][0], pos[i][1], next[0], next[1], cenLat, cenLon, rm, v.CodeType == "CWA")...)
		case "GRC":
			ring = append(ring, geodesy.DensifyGreatCircle(pos[i], next)...)
		case "FNT":
			run, ok := borders.run(v.GbrName, pos[i], next)
			if !ok {
				edges.chords++
				break
			}
			edges.walked++
			ring = append(ring, run...)
		default:
			// RHL: straight chord to the next vertex.
		}
	}
	// The SIA occasionally repeats a vertex verbatim (LFFF ships
	// 49°27'N 6°E twice in a row); collapse consecutive duplicates
	// after rounding, like the AIXM 5.1 decoder does.
	ring = dedupAdjacent(roundRing(ring))
	// A boundary is degenerate (a point or a line) only if it still has
	// fewer than three points after arcs are tessellated and borders
	// walked; a two-vertex boundary with an arc or a border edge is a
	// valid area.
	if len(ring) < 3 {
		return nil, edges, fmt.Errorf("boundary has only %d point(s)", len(ring))
	}
	return ring, edges, nil
}

// fntEdges counts a boundary's FNT edges: walked along their border, or
// drawn as a chord because the border is missing or an end lies off it.
type fntEdges struct {
	walked, chords int
}

// borderSnapM is how far an FNT edge's ends may lie from the border they
// follow. On the 2026-10-29 export both ends of every FNT edge but one lie
// within 1.3 km of its border: a FIR corner at round minutes beside the
// Luxembourg border (590 m), the Biarritz delegation's closing vertex
// (1.3 km), which the SIA's own drawing in XML_SIA also takes along the
// border. The one beyond is CTA33001's vertex 42°46'N 1°06'E, filed on
// FRANCE_SPAIN_EAST and lying 58 km from it, on the western border.
const borderSnapM = 2000.0

// borderSpikeM is how far a border vertex may stand from both of its
// neighbours, while they lie within borderSnapM of each other, before it
// is taken as filed out of sequence and dropped. The 2026-11-26 export
// files the Mont Dolent tripoint (45°55'N 7°03'E) as FRANCE_SWITZERLAND's
// vertex 691, 30 km from vertices 690 and 692, which lie 198 m apart, and
// the SIA's own drawings in XML_SIA pass from 690 to 692. The most jagged
// coast vertex of the export stands 2 km from its neighbours.
const borderSpikeM = 10000.0

// geoBorders holds the export's geographical borders by name, each as its
// [lat, lon] vertices in filed order.
type geoBorders map[string][][2]float64

// indexBorders parses every Gbr and returns the borders with the count of
// vertices dropped as filed out of sequence. A border with a vertex that
// does not parse is left out, so the FNT edges naming it fall back to
// their chord and are counted.
func indexBorders(gbrs []Gbr) (geoBorders, int) {
	out := make(geoBorders, len(gbrs))
	spikes := 0
	for _, g := range gbrs {
		pts, ok := borderPoints(g)
		if !ok || len(pts) < 2 {
			continue
		}
		pts, n := dropSpikes(pts)
		out[strings.TrimSpace(g.Name)] = pts
		spikes += n
	}
	return out, spikes
}

func borderPoints(g Gbr) ([][2]float64, bool) {
	pts := make([][2]float64, 0, len(g.Gbv))
	for _, v := range g.Gbv {
		lat, okLat := parseLat(v.GeoLat)
		lon, okLon := parseLon(v.GeoLong)
		if !okLat || !okLon {
			return nil, false
		}
		pts = append(pts, [2]float64{lat, lon})
	}
	return pts, true
}

// dropSpikes returns the border without the vertices filed out of
// sequence (borderSpikeM) and how many it dropped. A vertex is weighed
// against the last one kept and the next.
func dropSpikes(pts [][2]float64) ([][2]float64, int) {
	dist := func(a, b [2]float64) float64 { return geodesy.DistanceM(a[0], a[1], b[0], b[1]) }
	out := make([][2]float64, 0, len(pts))
	dropped := 0
	for i, p := range pts {
		if i > 0 && i+1 < len(pts) {
			prev, next := out[len(out)-1], pts[i+1]
			if dist(prev, p) > borderSpikeM && dist(p, next) > borderSpikeM && dist(prev, next) < borderSnapM {
				dropped++
				continue
			}
		}
		out = append(out, p)
	}
	return out, dropped
}

// run returns the vertices of the named border strictly between from and
// to, in the order an edge from one to the other passes them, and false
// when the border is missing or an end lies more than borderSnapM off it.
// Each end is placed at its nearest point on the border's polyline, so an
// end beside the border, or between two of its vertices, joins it where
// it is. A closed border (Réunion's coast) is walked the shorter way
// round.
func (g geoBorders) run(name string, from, to [2]float64) ([][2]float64, bool) {
	pts := g[strings.TrimSpace(name)]
	if len(pts) < 2 {
		return nil, false
	}
	a, da := linePosition(pts, from)
	b, db := linePosition(pts, to)
	if da > borderSnapM || db > borderSnapM {
		return nil, false
	}
	run := borderSpan(pts, a, b)
	if last := len(pts) - 1; pts[0] == pts[last] {
		// The other way round passes the vertex that closes the ring.
		other := b + float64(last)
		if b > a {
			other = b - float64(last)
		}
		if alt := borderSpan(pts, a, other); pathM(from, alt, to) < pathM(from, run, to) {
			run = alt
		}
	}
	return run, true
}

// linePosition returns where p falls on the polyline, as its segment index
// plus the fraction along that segment, and its distance from it in
// metres. The distance is planar about p, plenty for the metres an FNT
// end lies off its border.
func linePosition(pts [][2]float64, p [2]float64) (pos, distM float64) {
	k := math.Cos(p[0] * math.Pi / 180)
	distM = math.Inf(1)
	for i := 0; i+1 < len(pts); i++ {
		ax, ay := (pts[i][1]-p[1])*k, pts[i][0]-p[0]
		bx, by := (pts[i+1][1]-p[1])*k, pts[i+1][0]-p[0]
		dx, dy := bx-ax, by-ay
		t := 0.0
		if l := dx*dx + dy*dy; l > 0 {
			t = min(1, max(0, -(ax*dx+ay*dy)/l))
		}
		d := math.Hypot(ax+t*dx, ay+t*dy) * math.Pi / 180 * geodesy.EarthRadiusM
		if d < distM {
			pos, distM = float64(i)+t, d
		}
	}
	return pos, distM
}

// borderSpan returns the vertices whose index lies strictly between
// positions a and b, in walking order. Indices are taken modulo the
// segment count, which only the walk round a closed border reaches.
func borderSpan(pts [][2]float64, a, b float64) [][2]float64 {
	segs := len(pts) - 1
	at := func(k int) [2]float64 { return pts[((k%segs)+segs)%segs] }
	var out [][2]float64
	if a < b {
		for k := int(math.Floor(a)) + 1; float64(k) < b; k++ {
			out = append(out, at(k))
		}
		return out
	}
	for k := int(math.Ceil(a)) - 1; float64(k) > b; k-- {
		out = append(out, at(k))
	}
	return out
}

// pathM is the length in metres of the path from, via, to.
func pathM(from [2]float64, via [][2]float64, to [2]float64) float64 {
	total, prev := 0.0, from
	for _, p := range via {
		total += geodesy.DistanceM(prev[0], prev[1], p[0], p[1])
		prev = p
	}
	return total + geodesy.DistanceM(prev[0], prev[1], to[0], to[1])
}

// dedupAdjacent removes consecutive duplicate vertices (post-round5
// exact equality).
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

// zoneSymbolM is the radius of the circle drawn about a zone the AIP
// places by one point, and the half-width of the corridor about one it
// places by a two-point axis: 0.5 NM, large enough to be recognisable on
// the map without dominating it.
const zoneSymbolM = 0.5 * 1852

// pointBoundaryRing synthesises a closed ring around a single-vertex Abd.
// D-OTHER zones (paragliding launch points, winch sites, balloon centres,
// ...) systematically encode the location as one Avx without an explicit
// radius, and so does ENR 5.1 for two areas (LF-D 595, NW-R 1). Returns
// nil when the Abd has anything other than one Avx (caller falls back to
// boundaryRing's own error path).
func pointBoundaryRing(abd *Abd, radiusM float64) [][2]float64 {
	if abd.Circle != nil || len(abd.Avx) != 1 {
		return nil
	}
	v := abd.Avx[0]
	lat, okLat := parseLat(v.GeoLat)
	lon, okLon := parseLon(v.GeoLong)
	if !okLat || !okLon {
		return nil
	}
	return roundRing(geodesy.CircleRing(lat, lon, radiusM))
}

// axisBoundaryRing synthesises the ring of a zone the AIP places by a
// two-point axis, an Abd of two straight (GRC or RHL) vertices: the
// corridor halfM either side of the line between them, with a half circle
// round each end. ENR 5.5 files nine aerobatic zones so ("Axe 154°/334° de
// 2500 m", VILLEMUR SUR TARN). Returns nil for any other Abd.
func axisBoundaryRing(abd *Abd, halfM float64) [][2]float64 {
	if abd.Circle != nil || len(abd.Avx) != 2 {
		return nil
	}
	var end [2][2]float64
	for i, v := range abd.Avx {
		if v.CodeType != "GRC" && v.CodeType != "RHL" {
			return nil
		}
		lat, okLat := parseLat(v.GeoLat)
		lon, okLon := parseLon(v.GeoLong)
		if !okLat || !okLon {
			return nil
		}
		end[i] = [2]float64{lat, lon}
	}
	a, b := end[0], end[1]
	if a == b {
		return nil
	}
	side := func(p [2]float64, bearing float64) [2]float64 {
		lat, lon := geodesy.DestPoint(p[0], p[1], bearing, halfM)
		return [2]float64{lat, lon}
	}
	ahead := geodesy.InitialBearing(a[0], a[1], b[0], b[1])
	back := geodesy.InitialBearing(b[0], b[1], a[0], a[1])
	la, ra := side(a, ahead-90), side(a, ahead+90)
	lb, rb := side(b, back+90), side(b, back-90)
	ring := [][2]float64{la, lb}
	ring = append(ring, geodesy.ArcPoints(lb[0], lb[1], rb[0], rb[1], b[0], b[1], halfM, true)...)
	ring = append(ring, rb, ra)
	ring = append(ring, geodesy.ArcPoints(ra[0], ra[1], la[0], la[1], a[0], a[1], halfM, true)...)
	return roundRing(ring)
}

// pointInRing reports whether a [lat, lon] point lies inside a ring, by the
// even-odd crossing rule in plain lat/lon space. The rings this serves are
// French airspace boundaries, tens of nautical miles wide and far from the
// poles and the antimeridian, where the planar test and the spherical one
// agree. A point exactly on an edge falls either way; airspaces_sectors.go
// samples areas, not edges, so no caller depends on that.
func pointInRing(p [2]float64, ring [][2]float64) bool {
	inside := false
	n := len(ring)
	for i := 0; i < n; i++ {
		a, b := ring[i], ring[(i+1)%n]
		if (a[0] > p[0]) == (b[0] > p[0]) {
			continue
		}
		lon := a[1] + (p[0]-a[0])*(b[1]-a[1])/(b[0]-a[0])
		if p[1] < lon {
			inside = !inside
		}
	}
	return inside
}

// ringBBox returns a ring's bounding box as (minLat, maxLat, minLon, maxLon).
func ringBBox(ring [][2]float64) (minLat, maxLat, minLon, maxLon float64) {
	if len(ring) == 0 {
		return 0, 0, 0, 0
	}
	minLat, maxLat = ring[0][0], ring[0][0]
	minLon, maxLon = ring[0][1], ring[0][1]
	for _, p := range ring[1:] {
		minLat = min(minLat, p[0])
		maxLat = max(maxLat, p[0])
		minLon = min(minLon, p[1])
		maxLon = max(maxLon, p[1])
	}
	return minLat, maxLat, minLon, maxLon
}

// roundRing rounds every coordinate in a ring to 5 decimal places.
func roundRing(ring [][2]float64) [][2]float64 {
	for i := range ring {
		ring[i][0] = round5(ring[i][0])
		ring[i][1] = round5(ring[i][1])
	}
	return ring
}
