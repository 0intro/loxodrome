// simplify.go: Douglas-Peucker polyline simplification for closed rings.
// Pruatlas and FAA geometries are far more detailed than a NOTAM-overlay
// needs; simplifying at ~500 m shrinks each artefact by ~4-5x without
// visible distortion at the zoom levels the app uses.

package overlay

// SimplifyTolerance is the Douglas-Peucker perpendicular distance, in
// degrees. 0.005 deg is roughly 500 m at the equator; fine enough to keep
// airspace shapes recognisable while shrinking each JSON ~4-5x.
const SimplifyTolerance = 0.005

// Simplify returns a Douglas-Peucker simplification of a closed ring at
// the given perpendicular-distance tolerance (in degrees, since the ring
// is already in lat/lon). The ring is treated as a closed polygon: the
// start and end are anchored at the same point, and the algorithm runs on
// two half-polylines split at the vertex furthest from the start.
func Simplify(ring [][2]float64, tol float64) [][2]float64 {
	n := len(ring)
	if n < 4 || tol <= 0 {
		return ring
	}
	keep := make([]bool, n)
	keep[0] = true
	keep[n-1] = true

	// Anchor a second pivot at the vertex furthest from ring[0]; this turns
	// the closed ring into two open polylines, each soluble by DP. Without
	// the pivot, DP on a closed ring with start==end collapses every
	// intermediate vertex.
	pivot, maxD := 0, 0.0
	for i := 1; i < n-1; i++ {
		d := dist2(ring[0], ring[i])
		if d > maxD {
			maxD = d
			pivot = i
		}
	}
	if pivot == 0 {
		return ring
	}
	keep[pivot] = true

	tol2 := tol * tol
	dp(ring, 0, pivot, tol2, keep)
	dp(ring, pivot, n-1, tol2, keep)

	out := make([][2]float64, 0, n)
	for i, k := range keep {
		if k {
			out = append(out, ring[i])
		}
	}
	if len(out) < 3 {
		return ring
	}
	return out
}

// dp recursively marks the vertices to keep on the polyline ring[lo..hi].
// The split point is the vertex furthest from the chord (lo, hi); if every
// vertex is within tol2 of that chord, the whole interior is dropped.
func dp(ring [][2]float64, lo, hi int, tol2 float64, keep []bool) {
	if hi <= lo+1 {
		return
	}
	a, b := ring[lo], ring[hi]
	maxIdx, maxD := -1, 0.0
	for i := lo + 1; i < hi; i++ {
		d := perpDist2(ring[i], a, b)
		if d > maxD {
			maxD = d
			maxIdx = i
		}
	}
	if maxD <= tol2 || maxIdx < 0 {
		return
	}
	keep[maxIdx] = true
	dp(ring, lo, maxIdx, tol2, keep)
	dp(ring, maxIdx, hi, tol2, keep)
}

func dist2(a, b [2]float64) float64 {
	dx := a[0] - b[0]
	dy := a[1] - b[1]
	return dx*dx + dy*dy
}

// perpDist2 returns the squared perpendicular distance from p to the
// segment (a, b), clamped at the endpoints (so points beyond a chord
// measure to the nearest endpoint rather than the infinite line).
func perpDist2(p, a, b [2]float64) float64 {
	dx := b[0] - a[0]
	dy := b[1] - a[1]
	denom := dx*dx + dy*dy
	if denom == 0 {
		return dist2(p, a)
	}
	t := ((p[0]-a[0])*dx + (p[1]-a[1])*dy) / denom
	if t < 0 {
		t = 0
	} else if t > 1 {
		t = 1
	}
	cx := a[0] + t*dx
	cy := a[1] + t*dy
	ex := p[0] - cx
	ey := p[1] - cy
	return ex*ex + ey*ey
}
