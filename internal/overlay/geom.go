// geom.go: GeoJSON geometry helpers shared by the pruatlas and FAA parsers.

package overlay

import (
	"encoding/json"
	"fmt"
	"math"
)

// Round5 rounds a coordinate to 5 decimal places (~1 m). Matches the
// precision emitted by cmd/fr (internal/aip.Round5).
func Round5(x float64) float64 {
	return math.Round(x*1e5) / 1e5
}

// GeomToRings extracts every outer polygon ring from a GeoJSON Polygon or
// MultiPolygon, in [lat, lon] order (Leaflet-friendly). Inner holes are
// dropped; the SIA-derived schema has no concept of holes, and an outer
// ring alone is a faithful enough approximation for an overlay. The closing
// duplicate vertex GeoJSON includes is stripped so the ring matches
// cmd/fr output. Decimal coordinates are rounded to 5 decimals.
func GeomToRings(raw json.RawMessage) ([][][2]float64, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var head struct {
		Type        string          `json:"type"`
		Coordinates json.RawMessage `json:"coordinates"`
	}
	if err := json.Unmarshal(raw, &head); err != nil {
		return nil, err
	}
	switch head.Type {
	case "Polygon":
		// Polygon: [[[lon,lat,...], ...], [hole], ...]
		var c [][][]float64
		if err := json.Unmarshal(head.Coordinates, &c); err != nil {
			return nil, fmt.Errorf("decode Polygon: %w", err)
		}
		if len(c) == 0 {
			return nil, nil
		}
		return [][][2]float64{toRing(c[0])}, nil
	case "MultiPolygon":
		// MultiPolygon: [polygon, polygon, ...]
		var c [][][][]float64
		if err := json.Unmarshal(head.Coordinates, &c); err != nil {
			return nil, fmt.Errorf("decode MultiPolygon: %w", err)
		}
		var out [][][2]float64
		for _, poly := range c {
			if len(poly) > 0 {
				out = append(out, toRing(poly[0]))
			}
		}
		return out, nil
	default:
		return nil, fmt.Errorf("unsupported geometry %q", head.Type)
	}
}

// SplitAntimeridian returns ring split into one polygon per side of the
// +/-180 deg meridian whenever it crosses. Pacific-spanning FIRs (KZAK,
// NZZO, UHMM, ...) otherwise render as a flat sliver across the whole map
// because Leaflet draws a straight line from a vertex at +179 to one at
// -179. Rings entirely inside [-180, 180] without crossings are returned
// unchanged.
//
// A "crossing" is detected by adjacent vertices whose longitude delta
// exceeds 180 deg; the polygon model has no notion of going-the-long-way-
// round, so any such pair is the data jumping the antimeridian, not
// crossing half the planet. At each crossing we interpolate the latitude
// where the segment hits the meridian, close the current piece with a
// (lat, +/-180) vertex, and open the next piece with (lat, -/+180). The
// final partial piece (which started after the last crossing) is stitched
// onto the front of the first piece since they belong to the same
// hemisphere of the polygon.
//
// Holds for the typical 2-crossing FIRs we ship; rings with more crossings
// still split correctly, but the stitch step only joins the first and last
// pieces, which is the case 2-crossings produces. Polar rings (which would
// "cross" without a clean meridian split) aren't in the data we ingest.
func SplitAntimeridian(ring [][2]float64) [][][2]float64 {
	n := len(ring)
	if n < 3 {
		if n > 0 {
			return [][][2]float64{ring}
		}
		return nil
	}
	hasCrossing := false
	for i := 0; i < n; i++ {
		j := (i + 1) % n
		if abs(ring[j][1]-ring[i][1]) > 180 {
			hasCrossing = true
			break
		}
	}
	if !hasCrossing {
		return [][][2]float64{ring}
	}

	var pieces [][][2]float64
	var cur [][2]float64
	for i := 0; i < n; i++ {
		a := ring[i]
		b := ring[(i+1)%n]
		cur = append(cur, a)
		dlon := b[1] - a[1]
		if abs(dlon) <= 180 {
			continue
		}
		// dlon < -180: a near +180, b near -180. Exit at +180, enter at -180.
		// dlon >  180: a near -180, b near +180. Exit at -180, enter at +180.
		var aBoundary, bBoundary, bAdj float64
		if dlon < -180 {
			aBoundary, bBoundary = 180, -180
			bAdj = b[1] + 360
		} else {
			aBoundary, bBoundary = -180, 180
			bAdj = b[1] - 360
		}
		// Linear lat interpolation along the (a, b-adjusted) segment at the
		// meridian. The actual antimeridian path is a great-circle, but at
		// the precision we output (5 decimals) and the simplification
		// tolerance we apply (~500 m), the straight-line approximation is
		// indistinguishable. When a and b both sit *on* the meridian (the
		// FAA pre-pins +/-180 at dateline-touch vertices), the adjusted
		// segment has zero longitudinal extent and the division becomes
		// 0/0; fall back to a's latitude, which is the only meaningful
		// answer since the whole segment lives on the meridian.
		denom := bAdj - a[1]
		var latAt float64
		if abs(denom) < 1e-9 {
			latAt = Round5(a[0])
		} else {
			t := (aBoundary - a[1]) / denom
			latAt = Round5(a[0] + t*(b[0]-a[0]))
		}
		cur = append(cur, [2]float64{latAt, aBoundary})
		pieces = append(pieces, cur)
		cur = [][2]float64{{latAt, bBoundary}}
	}
	if len(pieces) > 0 && len(cur) > 0 {
		// Stitch the tail onto the front of the first piece: both belong to
		// the same hemisphere, separated only by the walk having started in
		// the middle of that hemisphere's run of vertices.
		pieces[0] = append(cur, pieces[0]...)
	} else if len(cur) >= 3 {
		pieces = append(pieces, cur)
	}
	out := pieces[:0]
	for _, p := range pieces {
		if len(p) >= 3 {
			out = append(out, p)
		}
	}
	return out
}

func abs(x float64) float64 {
	if x < 0 {
		return -x
	}
	return x
}

// toRing converts a GeoJSON outer ring ([[lon,lat], ...]) into our
// [[lat, lon], ...] format, dropping the closing duplicate vertex and
// rounding to 5 decimals.
func toRing(in [][]float64) [][2]float64 {
	n := len(in)
	if n >= 2 && len(in[0]) >= 2 && len(in[n-1]) >= 2 &&
		in[0][0] == in[n-1][0] && in[0][1] == in[n-1][1] {
		n--
	}
	out := make([][2]float64, 0, n)
	for i := 0; i < n; i++ {
		if len(in[i]) < 2 {
			continue
		}
		lat := Round5(in[i][1])
		lon := Round5(in[i][0])
		out = append(out, [2]float64{lat, lon})
	}
	return out
}
