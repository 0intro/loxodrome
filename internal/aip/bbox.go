// bbox.go computes the lat/lon envelope of an emitted dataset, which
// every builder writes into its .meta.json sidecar.
//
// The point is what the SPA does with it: reference datasets are large
// and there are a lot of publishers, so a country's rows are fetched only
// when the map, a route or a loaded NOTAM actually reaches its territory.
// The sidecar is already read before the dataset (it is what picks the
// AIRAC slot), so the envelope costs no extra request.
//
// Deliberately the DATA's envelope, not the State's borders: a publisher
// that carries cross-border reference rows, or an FIR reaching out over
// water, must not be gated out of its own coverage.

package aip

import (
	"math"
	"sort"
)

// BBox is a GeoJSON-order envelope: [minLon, minLat, maxLon, maxLat].
// Nil (and omitted from the sidecar) when the dataset holds no usable
// coordinates, which the SPA must read as "no idea, load it".
type BBox []float64

// BBoxBuilder accumulates points into an envelope.
type BBoxBuilder struct {
	minLat, minLon, maxLat, maxLon float64
	seen                           bool
}

// NewBBox returns an empty envelope.
func NewBBox() *BBoxBuilder {
	return &BBoxBuilder{
		minLat: math.Inf(1), minLon: math.Inf(1),
		maxLat: math.Inf(-1), maxLon: math.Inf(-1),
	}
}

// Add takes one point. Coordinates that are not finite, and the (0, 0)
// null island a row whose position failed to parse lands on, are
// ignored: either would stretch the envelope across half the planet and
// defeat the gate.
func (b *BBoxBuilder) Add(lat, lon float64) {
	if math.IsNaN(lat) || math.IsNaN(lon) || math.IsInf(lat, 0) || math.IsInf(lon, 0) {
		return
	}
	if lat == 0 && lon == 0 {
		return
	}
	if lat < -90 || lat > 90 || lon < -180 || lon > 180 {
		return
	}
	b.seen = true
	b.minLat = math.Min(b.minLat, lat)
	b.minLon = math.Min(b.minLon, lon)
	b.maxLat = math.Max(b.maxLat, lat)
	b.maxLon = math.Max(b.maxLon, lon)
}

// AddRing takes a boundary as the [lat, lon] pairs the artifacts carry.
func (b *BBoxBuilder) AddRing(ring [][2]float64) {
	for _, p := range ring {
		b.Add(p[0], p[1])
	}
}

// Result rounds outward to 3 decimals (about 100 m) so the envelope
// never crops the data it describes, and returns nil when nothing was
// added.
func (b *BBoxBuilder) Result() BBox {
	if !b.seen {
		return nil
	}
	floor3 := func(v float64) float64 { return math.Floor(v*1000) / 1000 }
	ceil3 := func(v float64) float64 { return math.Ceil(v*1000) / 1000 }
	return BBox{floor3(b.minLon), floor3(b.minLat), ceil3(b.maxLon), ceil3(b.maxLat)}
}

// clusterCellDeg is the grid a dataset's points are snapped to before
// connected cells are merged into boxes. Four degrees is coarse enough
// that a country never breaks into pieces (its own gaps are far smaller)
// and fine enough to separate territories an ocean apart.
const clusterCellDeg = 4.0

// mergeGapDeg folds two pieces back together when they sit closer than
// this. The flood fill alone requires the occupied cells to touch, so a
// sparse dataset (a country with a handful of navaids) would split at
// every internal hole, which says nothing useful and costs sidecar. What
// the split is FOR is territory an ocean apart, so anything closer than
// a few cells is one piece.
const mergeGapDeg = 8.0

// maxClusters bounds the sidecar. A publisher with more disjoint pieces
// than this gains nothing from further splitting, and the SPA tests every
// box on every pan.
const maxClusters = 16

// BBoxClustersOfRows measures a dataset as a SET of envelopes, one per
// group of rows that sit together.
//
// One envelope is wrong for a publisher whose territory is not connected:
// France's AIP covers Guadeloupe, Guyane, Reunion, Polynesia and New
// Caledonia beside the metropole, so its single envelope spans from 157 W
// to 170 E and is true of almost any viewport. That silently disables the
// on-demand gate for the largest dataset in the repository. Splitting it
// into the pieces it actually occupies restores it, and costs a few
// numbers in a sidecar.
//
// Returns nil when the rows form one group, in which case the caller's
// plain envelope already says everything.
func BBoxClustersOfRows(fields []string, rows []any) []BBox {
	pts := pointsOfRows(fields, rows)
	if len(pts) == 0 {
		return nil
	}
	// Snap to the grid and flood-fill the occupied cells.
	type cell struct{ x, y int }
	occupied := make(map[cell][]int, len(pts))
	for i, p := range pts {
		c := cell{int(math.Floor(p[1] / clusterCellDeg)), int(math.Floor(p[0] / clusterCellDeg))}
		occupied[c] = append(occupied[c], i)
	}
	seen := make(map[cell]bool, len(occupied))
	var boxes []BBox
	for c := range occupied {
		if seen[c] {
			continue
		}
		b := NewBBox()
		stack := []cell{c}
		seen[c] = true
		for len(stack) > 0 {
			cur := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			for _, i := range occupied[cur] {
				b.Add(pts[i][0], pts[i][1])
			}
			for dx := -1; dx <= 1; dx++ {
				for dy := -1; dy <= 1; dy++ {
					n := cell{cur.x + dx, cur.y + dy}
					if _, ok := occupied[n]; ok && !seen[n] {
						seen[n] = true
						stack = append(stack, n)
					}
				}
			}
		}
		if r := b.Result(); r != nil {
			boxes = append(boxes, r)
		}
	}
	boxes = mergeNearby(boxes)
	if len(boxes) <= 1 {
		return nil
	}
	sort.Slice(boxes, func(i, j int) bool {
		if boxes[i][0] != boxes[j][0] {
			return boxes[i][0] < boxes[j][0]
		}
		return boxes[i][1] < boxes[j][1]
	})
	for len(boxes) > maxClusters {
		boxes = mergeClosestPair(boxes)
	}
	return boxes
}

// mergeNearby folds together every pair of pieces closer than
// mergeGapDeg, repeatedly, until only genuinely separated ones remain.
func mergeNearby(boxes []BBox) []BBox {
	for len(boxes) > 1 {
		merged := false
		for i := 0; i < len(boxes) && !merged; i++ {
			for j := i + 1; j < len(boxes); j++ {
				if boxGapDeg(boxes[i], boxes[j]) > mergeGapDeg {
					continue
				}
				boxes[i] = BBox{
					math.Min(boxes[i][0], boxes[j][0]), math.Min(boxes[i][1], boxes[j][1]),
					math.Max(boxes[i][2], boxes[j][2]), math.Max(boxes[i][3], boxes[j][3]),
				}
				boxes = append(boxes[:j], boxes[j+1:]...)
				merged = true
				break
			}
		}
		if !merged {
			break
		}
	}
	return boxes
}

// mergeClosestPair folds the two nearest boxes together, which is how a
// dataset with more pieces than the sidecar carries loses the least.
func mergeClosestPair(boxes []BBox) []BBox {
	bi, bj, best := 0, 1, math.Inf(1)
	for i := range boxes {
		for j := i + 1; j < len(boxes); j++ {
			d := boxGapDeg(boxes[i], boxes[j])
			if d < best {
				bi, bj, best = i, j, d
			}
		}
	}
	merged := BBox{
		math.Min(boxes[bi][0], boxes[bj][0]), math.Min(boxes[bi][1], boxes[bj][1]),
		math.Max(boxes[bi][2], boxes[bj][2]), math.Max(boxes[bi][3], boxes[bj][3]),
	}
	out := make([]BBox, 0, len(boxes)-1)
	for k, b := range boxes {
		if k == bi || k == bj {
			continue
		}
		out = append(out, b)
	}
	return append(out, merged)
}

// boxGapDeg is the separation of two envelopes, zero where they overlap.
func boxGapDeg(a, b BBox) float64 {
	dx := math.Max(0, math.Max(a[0]-b[2], b[0]-a[2]))
	dy := math.Max(0, math.Max(a[1]-b[3], b[1]-a[3]))
	return math.Hypot(dx, dy)
}

// pointsOfRows collects every [lat, lon] an artifact carries, from the
// same columns BBoxOfRows reads.
func pointsOfRows(fields []string, rows []any) [][2]float64 {
	latIdx, lonIdx, ringIdx := -1, -1, -1
	for i, f := range fields {
		switch f {
		case "lat":
			latIdx = i
		case "lon":
			lonIdx = i
		case "ring":
			ringIdx = i
		}
	}
	var out [][2]float64
	add := func(lat, lon float64) {
		b := NewBBox()
		b.Add(lat, lon)
		if b.seen {
			out = append(out, [2]float64{lat, lon})
		}
	}
	for _, r := range rows {
		cells, ok := r.([]any)
		if !ok {
			continue
		}
		if latIdx >= 0 && lonIdx >= 0 && latIdx < len(cells) && lonIdx < len(cells) {
			lat, latOK := numeric(cells[latIdx])
			lon, lonOK := numeric(cells[lonIdx])
			if latOK && lonOK {
				add(lat, lon)
			}
		}
		if ringIdx >= 0 && ringIdx < len(cells) {
			forEachRingPoint(cells[ringIdx], add)
		}
	}
	return out
}

// forEachRingPoint walks the ring encodings the builders produce.
func forEachRingPoint(cell any, fn func(lat, lon float64)) {
	switch ring := cell.(type) {
	case [][2]float64:
		for _, p := range ring {
			fn(p[0], p[1])
		}
	case [][]float64:
		for _, p := range ring {
			if len(p) >= 2 {
				fn(p[0], p[1])
			}
		}
	case []any:
		for _, p := range ring {
			switch pt := p.(type) {
			case [2]float64:
				fn(pt[0], pt[1])
			case []float64:
				if len(pt) >= 2 {
					fn(pt[0], pt[1])
				}
			case []any:
				if len(pt) >= 2 {
					lat, latOK := numeric(pt[0])
					lon, lonOK := numeric(pt[1])
					if latOK && lonOK {
						fn(lat, lon)
					}
				}
			}
		}
	}
}

// BBoxOfRows reads the envelope straight off a finished artifact, which
// is what the builders with their own row assembly use: it finds the
// "lat" / "lon" columns by name, and failing those the "ring" column,
// so any builder emitting the shared schemas gets an envelope from one
// call. Rows shorter than the field list (an older artifact) are read as
// far as they go.
func BBoxOfRows(fields []string, rows []any) BBox {
	latIdx, lonIdx, ringIdx := -1, -1, -1
	for i, f := range fields {
		switch f {
		case "lat":
			latIdx = i
		case "lon":
			lonIdx = i
		case "ring":
			ringIdx = i
		}
	}
	b := NewBBox()
	for _, r := range rows {
		cells, ok := r.([]any)
		if !ok {
			continue
		}
		if latIdx >= 0 && lonIdx >= 0 && latIdx < len(cells) && lonIdx < len(cells) {
			lat, latOK := numeric(cells[latIdx])
			lon, lonOK := numeric(cells[lonIdx])
			if latOK && lonOK {
				b.Add(lat, lon)
			}
		}
		if ringIdx >= 0 && ringIdx < len(cells) {
			addRingCell(b, cells[ringIdx])
		}
	}
	return b.Result()
}

// addRingCell accepts the ring encodings the builders produce: the
// decoded [][2]float64 the AIXM path carries, and the []any of pairs the
// GeoJSON overlays assemble.
func addRingCell(b *BBoxBuilder, cell any) {
	switch ring := cell.(type) {
	case [][2]float64:
		b.AddRing(ring)
	case [][]float64:
		for _, p := range ring {
			if len(p) >= 2 {
				b.Add(p[0], p[1])
			}
		}
	case []any:
		for _, p := range ring {
			switch pt := p.(type) {
			case [2]float64:
				b.Add(pt[0], pt[1])
			case []float64:
				if len(pt) >= 2 {
					b.Add(pt[0], pt[1])
				}
			case []any:
				if len(pt) >= 2 {
					lat, latOK := numeric(pt[0])
					lon, lonOK := numeric(pt[1])
					if latOK && lonOK {
						b.Add(lat, lon)
					}
				}
			}
		}
	}
}

// numeric reads a coordinate cell, which the builders may have stored as
// any of Go's float or int kinds.
func numeric(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	}
	return 0, false
}
