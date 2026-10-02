// geometry.go converts AIXM boundary geometry into decimal-degree polygon
// rings: arc tessellation, circle expansion, point-as-circle fallback for
// single-vertex D-OTHER zones. DMS decoding lives in internal/aip;
// geodesic math (bearings, arc points, unit conversion) in internal/geodesy.

package main

import (
	"fmt"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/geodesy"
)

// parseLat / parseLon / round5 forward to internal/aip so the rest of
// geometry.go can keep its short call sites.
func parseLat(s string) (float64, bool) { return aip.ParseLat(s) }
func parseLon(s string) (float64, bool) { return aip.ParseLon(s) }
func round5(x float64) float64          { return aip.Round5(x) }

// boundaryRing builds the decimal-degree polygon ring for an airspace
// boundary. GRC ("great circle") segments are densified through the shared
// geodesy.DensifyGreatCircle so the ring follows the declared geodesic
// instead of a straight Mercator chord (the LFRR 48°50'N 8°W -> 50°N 2°W
// leg bowed 4.3 km; the same helper serves the AIXM 5.1 pipeline, so a
// neighbour state publishing the same corners emits the same polyline).
// RHL ("rhumb line", the parallel runs) stays a chord: a rhumb IS the
// straight Mercator line. FNT ("follows national frontier") is approximated
// as a straight line; precise frontier geometry is not in AIXM. Overseas
// territories sit far from ±180°, so no antimeridian handling is needed.
func boundaryRing(abd *Abd) ([][2]float64, error) {
	if abd.Circle != nil {
		c := abd.Circle
		lat, okLat := parseLat(c.GeoLatCen)
		lon, okLon := parseLon(c.GeoLongCen)
		if !okLat || !okLon {
			return nil, fmt.Errorf("circle: bad centre coordinates")
		}
		rm, err := geodesy.RadiusMeters(c.ValRadius, c.UomRadius)
		if err != nil {
			return nil, fmt.Errorf("circle: %w", err)
		}
		return roundRing(geodesy.CircleRing(lat, lon, rm)), nil
	}

	n := len(abd.Avx)
	if n == 0 {
		return nil, fmt.Errorf("boundary has no vertices")
	}
	pos := make([][2]float64, n)
	for i, v := range abd.Avx {
		lat, okLat := parseLat(v.GeoLat)
		lon, okLon := parseLon(v.GeoLong)
		if !okLat || !okLon {
			return nil, fmt.Errorf("vertex %d: bad coordinates", i)
		}
		pos[i] = [2]float64{lat, lon}
	}

	var ring [][2]float64
	for i := 0; i < n; i++ {
		ring = append(ring, pos[i])
		v := abd.Avx[i]
		switch v.CodeType {
		case "CWA", "CCA":
			cenLat, okLat := parseLat(v.GeoLatArc)
			cenLon, okLon := parseLon(v.GeoLongArc)
			if !okLat || !okLon {
				return nil, fmt.Errorf("vertex %d: bad arc centre", i)
			}
			rm, err := geodesy.RadiusMeters(v.ValRadiusArc, v.UomRadiusArc)
			if err != nil {
				return nil, fmt.Errorf("vertex %d arc: %w", i, err)
			}
			next := pos[(i+1)%n]
			ring = append(ring, geodesy.ArcPoints(pos[i][0], pos[i][1], next[0], next[1], cenLat, cenLon, rm, v.CodeType == "CWA")...)
		case "GRC":
			ring = append(ring, geodesy.DensifyGreatCircle(pos[i], pos[(i+1)%n])...)
		default:
			// RHL / FNT: straight chord to the next vertex.
		}
	}
	// The SIA occasionally repeats a vertex verbatim (LFFF ships
	// 49°27'N 6°E twice in a row); collapse consecutive duplicates
	// after rounding, like the AIXM 5.1 decoder does.
	ring = dedupAdjacent(roundRing(ring))
	// A boundary is degenerate (a point or a line) only if it still has
	// fewer than three points after arcs are tessellated; a two-vertex
	// boundary with an arc edge is a valid area.
	if len(ring) < 3 {
		return nil, fmt.Errorf("boundary has only %d point(s)", len(ring))
	}
	return ring, nil
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

// pointBoundaryRing synthesises a closed ring around a single-vertex Abd.
// D-OTHER zones (paragliding launch points, winch sites, balloon centres,
// ...) systematically encode the location as one Avx without an explicit
// radius; default the visual to 0.5 NM (~926 m), large enough to be
// recognisable on the map without dominating it. Returns nil when the Abd
// has anything other than one Avx (caller falls back to boundaryRing's
// own error path).
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
