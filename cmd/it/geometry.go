// geometry.go turns an OFMX boundary into a closed ring.
//
// Three vertex kinds appear in the Italian snapshot: GRC (a great-circle
// leg to the vertex), CWA / CCA (a clockwise / anticlockwise arc about a
// stated centre) and FNT (follow a named geographical border). The
// densification step is the shared geodesy one, so a boundary two states
// both publish comes out with the same polyline on either side.

package main

import (
	"math"
	"strings"

	"github.com/0intro/loxodrome/internal/geodesy"
)

// ringFrom builds the closed ring of a boundary. borders supplies the
// Gbr vertex lists an FNT leg walks along; stats counts what degraded.
func ringFrom(vs []Vertex, borders map[string][]Point, stats *buildStats) [][2]float64 {
	if len(vs) == 0 {
		return nil
	}
	// A boundary of ONE arc vertex is a full circle: the vertex is both
	// the start and the end of a 360-degree arc about the stated centre.
	// It is the AIXM 4.5 circle idiom and it is how 425 of Italy's 1 653
	// boundaries are filed, so treating a one-vertex boundary as
	// unusable would drop a quarter of the country's airspace.
	if len(vs) == 1 {
		v := vs[0]
		if v.Kind != "CWA" && v.Kind != "CCA" {
			return nil
		}
		if v.Centre == (Point{}) {
			return nil
		}
		r := geodesy.DistanceM(v.Centre.Lat, v.Centre.Lon, v.Pt.Lat, v.Pt.Lon)
		if r <= 0 {
			return nil
		}
		ring := geodesy.CircleRing(v.Centre.Lat, v.Centre.Lon, r)
		out := make([][2]float64, 0, len(ring))
		for _, p := range ring {
			out = append(out, [2]float64{round5(p[0]), round5(p[1])})
		}
		return out
	}
	if len(vs) < 2 {
		return nil
	}
	out := make([][2]float64, 0, len(vs)*4)
	push := func(p Point) {
		pt := [2]float64{round5(p.Lat), round5(p.Lon)}
		if n := len(out); n > 0 && out[n-1] == pt {
			return
		}
		out = append(out, pt)
	}
	push(vs[0].Pt)

	for i := 1; i <= len(vs); i++ {
		prev := vs[i-1]
		cur := vs[i%len(vs)]
		switch cur.Kind {
		case "CWA", "CCA":
			// The shared arc tessellator, so an arc drawn here matches one
			// drawn by any other publisher's pipeline.
			r := geodesy.DistanceM(cur.Centre.Lat, cur.Centre.Lon, prev.Pt.Lat, prev.Pt.Lon)
			if cur.Centre == (Point{}) || r <= 0 {
				stats.arcChords++
				break
			}
			for _, p := range geodesy.ArcPoints(
				prev.Pt.Lat, prev.Pt.Lon, cur.Pt.Lat, cur.Pt.Lon,
				cur.Centre.Lat, cur.Centre.Lon, r, cur.Kind == "CWA") {
				push(Point{Lat: p[0], Lon: p[1]})
			}
		case "FNT":
			pts, ok := borderRun(borders, cur.Border, prev.Pt, cur.Pt)
			if !ok {
				stats.borderChords++
				push(cur.Pt)
				continue
			}
			stats.borderStitched++
			for _, p := range pts {
				push(p)
			}
		default:
			// A great-circle leg is densified so a long one bends the way
			// it really does; the step is the one every publisher shares.
			for _, p := range geodesy.DensifyGreatCircle(
				[2]float64{prev.Pt.Lat, prev.Pt.Lon}, [2]float64{cur.Pt.Lat, cur.Pt.Lon}) {
				push(Point{Lat: p[0], Lon: p[1]})
			}
		}
		push(cur.Pt)
	}
	if len(out) < 3 {
		return nil
	}
	// Close the ring.
	if out[0] != out[len(out)-1] {
		out = append(out, out[0])
	}
	return out
}

// borderRun returns the stretch of a named geographical border between
// the two points, walked in whichever direction is shorter.
//
// Without this the Milano FIR and a dozen CTAs would cut straight across
// the Alps instead of following the French, Swiss and Austrian
// frontiers. When the border is not in the snapshot the caller falls
// back to a chord and counts it, the same degradation cmd/be records for
// the Belgian frontier.
func borderRun(borders map[string][]Point, name string, from, to Point) ([]Point, bool) {
	pts := borders[strings.TrimSpace(name)]
	if len(pts) < 2 {
		return nil, false
	}
	i := nearestIndex(pts, from)
	j := nearestIndex(pts, to)
	if i == j {
		return nil, false
	}
	var run []Point
	if i < j {
		run = append(run, pts[i:j+1]...)
	} else {
		for k := i; k >= j; k-- {
			run = append(run, pts[k])
		}
	}
	return run, true
}

func nearestIndex(pts []Point, p Point) int {
	best, bestD := 0, math.Inf(1)
	for i, q := range pts {
		d := geodesy.DistanceM(p.Lat, p.Lon, q.Lat, q.Lon)
		if d < bestD {
			best, bestD = i, d
		}
	}
	return best
}

func round5(v float64) float64 { return math.Round(v*1e5) / 1e5 }
