// regions.go says which tiles the pack holds.
//
// Plan IGN draws France and the overseas territories IGN maps; elsewhere
// its pyramid is empty above zoom 8 to 11 and the service answers 404. The
// pack is therefore a set of boxes around those territories, each a little
// wider than IGN's own extent so the offshore islets are in (Ouessant, the
// Roches-Douvres, Lavezzi, the Îles du Salut, Petite-Terre), plus the whole
// world at the zooms where it costs nothing. Polynesia, New Caledonia and
// Wallis-et-Futuna are not IGN's to map and Plan IGN leaves them out.
//
// Where a box stops short of what IGN draws, the offline map shows its grey
// background where the live one shows IGN's tiles: the map, the sea, or the
// white IGN lays outside its own data extent out to its 404s (the straight
// blue edge round an overseas territory is IGN's own, online as offline).
// The first assembly showed it in the desktop drive, Guadeloupe at zoom 10.
// Two margins close it. Zoomed out, IGN draws past France at every edge (the
// neighbours and the sea at zooms 6 and 7, mostly its white from 8), so up
// to zoom 10 each box reaches lowZoomMargin tiles further. Zoomed in, past
// the mainland box IGN already answers 404 (Switzerland, Italy, Spain,
// probed at 1, 3 and 6 tiles), while round the overseas territories its
// extent reaches past their boxes, so those take a quarter degree more.
// What the 9,655 added tiles hold, measured: up to zoom 10, 471 map, 313
// sea, 1,651 white, 735 absent; at zoom 13 round the overseas, 588 map, 437
// sea, 2,425 white, 1,500 absent. The white and the sea are one tile each
// in the archive: the margins cost 4 MB.

package main

import (
	"fmt"
	"math"
)

const (
	// minZoom and maxZoom bound the pack. Zoom 13 is about 1:50 000 on
	// screen, every road and village; the app enlarges the zoom-13 tiles
	// beyond it offline and loads IGN's own above it online.
	// src/lib/offline/basemapPacks.ts states the same maxNativeZoom, pinned
	// by tests/planignPack.spec.ts through the fixture this command writes.
	minZoom = 0
	maxZoom = 13
	// worldMaxZoom is the last zoom held for the WHOLE world: 1,365 tiles,
	// mostly identical sea that the archive stores once, so an offline
	// overview of the continent is not a hole.
	worldMaxZoom = 5
	// lowZoomMargin is how many tiles each box reaches past itself on every
	// side, up to lowZoomMarginMaxZoom: about a phone screen at any of those
	// zooms, so a map of France zoomed out offline is not a rectangle.
	lowZoomMargin        = 3
	lowZoomMarginMaxZoom = 10
)

// region is a lon/lat box the pack covers above worldMaxZoom.
type region struct {
	Name  string  `json:"name"`
	West  float64 `json:"west"`
	South float64 `json:"south"`
	East  float64 `json:"east"`
	North float64 `json:"north"`
}

// regions are IGN's CSW extents for IGNF_PLAN-IGN with a margin, the
// overseas ones a quarter degree wider (see the top of this file).
// Mainland France includes Corsica; Saint-Martin's box holds
// Saint-Barthélemy.
var regions = []region{
	{"mainland", -5.30, 41.20, 9.70, 51.20},
	{"guadeloupe", -62.10, 15.55, -60.70, 16.80},
	{"martinique", -61.55, 14.10, -60.50, 15.18},
	{"guyane", -54.95, 1.80, -51.25, 6.10},
	{"reunion", 54.90, -21.70, 56.15, -20.55},
	{"mayotte", 44.65, -13.35, 45.60, -12.30},
	{"saint-pierre-et-miquelon", -56.75, 46.45, -55.80, 47.45},
	{"saint-martin", -63.45, 17.58, -62.50, 18.40},
}

// tile is one XYZ tile. y counts from the top, which is also the WMTS
// TILEROW of the Web Mercator matrix set.
type tile struct {
	z    uint8
	x, y uint32
}

func (t tile) String() string { return fmt.Sprintf("%d/%d/%d", t.z, t.x, t.y) }

// parent is the tile one zoom out that contains t.
func (t tile) parent() tile { return tile{t.z - 1, t.x / 2, t.y / 2} }

// lonToX is the column holding a longitude at zoom z, clamped to the grid.
func lonToX(lon float64, z uint8) uint32 {
	n := float64(uint64(1) << z)
	return clampTile(math.Floor((lon+180)/360*n), n)
}

// latToY is the Web Mercator row holding a latitude at zoom z.
func latToY(lat float64, z uint8) uint32 {
	n := float64(uint64(1) << z)
	r := lat * math.Pi / 180
	return clampTile(math.Floor((1-math.Log(math.Tan(r)+1/math.Cos(r))/math.Pi)/2*n), n)
}

func clampTile(v, n float64) uint32 {
	switch {
	case v < 0:
		return 0
	case v > n-1:
		return uint32(n - 1)
	}
	return uint32(v)
}

// enumerate lists every tile of the pack once: zoom by zoom, then box by
// box in row order. A tile two boxes share is listed under the first. Up to
// marginMax each box reaches margin tiles further on every side.
func enumerate(lo, hi, world uint8, boxes []region, margin uint32, marginMax uint8) []tile {
	seen := make(map[tile]struct{})
	var out []tile
	add := func(t tile) {
		if _, ok := seen[t]; !ok {
			seen[t] = struct{}{}
			out = append(out, t)
		}
	}
	for z := lo; z <= hi; z++ {
		if z <= world {
			n := uint32(1) << z
			for y := uint32(0); y < n; y++ {
				for x := uint32(0); x < n; x++ {
					add(tile{z, x, y})
				}
			}
			continue
		}
		m := uint32(0)
		if z <= marginMax {
			m = margin
		}
		last := uint32(1)<<z - 1
		grow := func(lo, hi uint32) (uint32, uint32) {
			lo = max(lo, m) - m
			return lo, min(hi+m, last)
		}
		for _, r := range boxes {
			x0, x1 := grow(lonToX(r.West, z), lonToX(r.East, z))
			y0, y1 := grow(latToY(r.North, z), latToY(r.South, z))
			for y := y0; y <= y1; y++ {
				for x := x0; x <= x1; x++ {
					add(tile{z, x, y})
				}
			}
		}
	}
	return out
}

// selectRegions resolves the -regions flag: "all", or a comma list of names.
func selectRegions(names []string) ([]region, error) {
	if len(names) == 1 && names[0] == "all" {
		return regions, nil
	}
	var out []region
	for _, n := range names {
		found := false
		for _, r := range regions {
			if r.Name == n {
				out = append(out, r)
				found = true
				break
			}
		}
		if !found {
			return nil, fmt.Errorf("unknown region %q", n)
		}
	}
	return out, nil
}
