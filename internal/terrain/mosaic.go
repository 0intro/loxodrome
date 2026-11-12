package terrain

// Turning source rasters into the tiles the application reads: one output
// pixel at a time from whichever source covers it, and then one level at a
// time up the pyramid.

import "math"

// Source is a raster the mosaic can read, whichever lattice it is on. Both
// Grid (geographic) and ProjectedGrid satisfy it, so the builder never asks
// which kind a region turned out to be.
type Source interface {
	// Pool is the extremes and the mean of every sample inside a geographic
	// box, or ok=false when it holds none.
	Pool(west, south, east, north float64) (min, mean, max float64, ok bool)
	// Nearest is the sample closest to a position, for an output pixel finer
	// than the source it is built from.
	Nearest(lon, lat float64) (float64, bool)
}

// TileLon is the longitude of a fractional slippy x at zoom z.
func TileLon(z int, x float64) float64 {
	return x/float64(int(1)<<uint(z))*360 - 180
}

// TileLat is the latitude of a fractional slippy y at zoom z.
func TileLat(z int, y float64) float64 {
	n := math.Pi * (1 - 2*y/float64(int(1)<<uint(z)))
	return math.Atan(math.Sinh(n)) * 180 / math.Pi
}

// BuildTile fills one output tile from `ground` in priority order, raising
// its MAX band with anything `surface` reports.
//
// The two lists are the decision that canopy and buildings keep padding
// terrain clearance while height above ground stays honest: `ground` is the
// bare-earth product where a country publishes one, and `surface` is the DSM
// over the same ground. So `max` is the higher of the two, which is what the
// minimum-altitude corridor and the drawn profile read, while `mean` and
// `min` stay bare earth, which is what an AGL floor reads.
//
// Pooling, never interpolation: a maximum that has been through a blend is
// not a maximum. Where an output pixel is finer than its source it falls back
// to the nearest post, which is the honest reading of a lattice that has
// nothing inside the pixel.
//
// Returns false when no source covered any pixel, so a caller can skip
// writing an object for ocean or for a gap.
func BuildTile(z, x, y int, ground []Source, surface []Source) (*Tile, bool) {
	t := &Tile{
		Z: z, X: x, Y: y,
		Mean: make([]int16, Pixels),
		Max:  make([]int16, Pixels),
		Min:  make([]int16, Pixels),
	}
	any := false
	for j := 0; j < Size; j++ {
		north := TileLat(z, float64(y)+float64(j)/Size)
		south := TileLat(z, float64(y)+float64(j+1)/Size)
		midLat := (north + south) / 2
		for i := 0; i < Size; i++ {
			west := TileLon(z, float64(x)+float64(i)/Size)
			east := TileLon(z, float64(x)+float64(i+1)/Size)
			k := j*Size + i
			lo, mid, hi, ok := poolFrom(ground, west, south, east, north, (west+east)/2, midLat)
			if !ok {
				t.Mean[k] = NoData
				t.Max[k] = NoData
				t.Min[k] = NoData
				continue
			}
			any = true
			if _, _, sHi, sOK := poolFrom(surface, west, south, east, north, (west+east)/2, midLat); sOK && sHi > hi {
				hi = sHi
			}
			t.Mean[k] = toMetres(mid)
			t.Max[k] = toMetres(hi)
			t.Min[k] = toMetres(lo)
			// Quantisation must not invert the bands: a mean rounding up past
			// a max would read as a footprint whose middle is above its top.
			if t.Max[k] < t.Mean[k] {
				t.Max[k] = t.Mean[k]
			}
			if t.Min[k] > t.Mean[k] {
				t.Min[k] = t.Mean[k]
			}
		}
	}
	return t, any
}

// poolFrom asks each source in turn and takes the first that answers, so the
// list is a priority: a national product over Copernicus, Copernicus over the
// global floor.
func poolFrom(
	sources []Source,
	west, south, east, north, lon, lat float64,
) (min, mean, max float64, ok bool) {
	for _, s := range sources {
		if lo, mid, hi, got := s.Pool(west, south, east, north); got {
			return lo, mid, hi, true
		}
		if v, got := s.Nearest(lon, lat); got {
			return v, v, v, true
		}
	}
	return 0, 0, 0, false
}

// toMetres rounds to the stored unit, keeping clear of the sentinel: a real
// elevation must never quantise onto "no data".
func toMetres(v float64) int16 {
	r := math.Round(v)
	if r <= float64(NoData) {
		return NoData + 1
	}
	if r > 32767 {
		return 32767
	}
	return int16(r)
}

// Pool4 builds the parent of four children, any of which may be missing.
// This is where the pyramid's promise is kept: a parent's max IS the max of
// everything under it, so a corridor answered at a coarse level is answered
// exactly, and the client can read four tiles where it used to read seventy.
// KeepUncovered fills the pixels `t` has no data for from `under`, and is what
// stops pooling from PUNCHING HOLES in a level that a coarser tier already
// wrote natively.
//
// The tiers reach different levels and their edges do not fall on tile
// boundaries: the 30 m box over Europe stops at longitude 25 W, which lands
// two thirds of the way across a z10 tile. Such a tile has some z11 children
// and not others, so Pool4 answers with real ground on one side and the
// no-data sentinel on the other. Written straight out, that REPLACES the 90 m
// floor's own tile, and the ground on the uncovered side is gone: measured on
// one boundary column, 59 of 252 tiles lost ground the floor held, the worst
// losing 88 % of its pixels. Because the levels below are pooled from this
// one, the hole then propagates all the way down and the point reads as "no
// terrain data" over ground the mosaic actually has.
//
// Pooling must only ever improve a tile.
//
// The corollary, for whoever RETIRES coverage rather than adds it: this keeps
// ground, so deleting a finer tier's tiles is not enough to make the mosaic
// forget them. The parents pooled from them have to go too, or the next pass
// will preserve what it can no longer derive. Every build so far has only
// ever grown, where this cannot fire at a level nothing writes natively,
// because the new pool covers everything the old one did.
func KeepUncovered(t, under *Tile) {
	if t == nil || under == nil {
		return
	}
	for i := range t.Mean {
		if t.Mean[i] != NoData || under.Mean[i] == NoData {
			continue
		}
		// A single-band tile decodes with no extremes at all, and it means one
		// value per pixel rather than an unknown band; Pool4 reads it the same
		// way. Copying Mean while leaving Max and Min on the sentinel would
		// make a pixel that has ground and no ceiling.
		m := under.Mean[i]
		lo, hi := m, m
		if under.Min != nil && under.Max != nil {
			lo, hi = under.Min[i], under.Max[i]
		}
		t.Mean[i] = m
		if t.Max != nil {
			t.Max[i] = hi
		}
		if t.Min != nil {
			t.Min[i] = lo
		}
	}
}

func Pool4(z, x, y int, nw, ne, sw, se *Tile) (*Tile, bool) {
	t := &Tile{
		Z: z, X: x, Y: y,
		Mean: make([]int16, Pixels),
		Max:  make([]int16, Pixels),
		Min:  make([]int16, Pixels),
	}
	child := func(cx, cy int) *Tile {
		switch {
		case cx == 0 && cy == 0:
			return nw
		case cx == 1 && cy == 0:
			return ne
		case cx == 0 && cy == 1:
			return sw
		default:
			return se
		}
	}
	any := false
	for j := 0; j < Size; j++ {
		for i := 0; i < Size; i++ {
			// The parent pixel (i,j) covers a 2x2 block of ONE child: the
			// half of the parent it lies in picks the child, and the rest of
			// the index addresses inside it.
			c := child(i/(Size/2), j/(Size/2))
			k := j*Size + i
			if c == nil {
				t.Mean[k] = NoData
				t.Max[k] = NoData
				t.Min[k] = NoData
				continue
			}
			bx := (i % (Size / 2)) * 2
			by := (j % (Size / 2)) * 2
			var lo, hi, sum float64
			n := 0
			for dy := 0; dy < 2; dy++ {
				for dx := 0; dx < 2; dx++ {
					ck := (by+dy)*Size + bx + dx
					m := c.Mean[ck]
					if m == NoData {
						continue
					}
					cLo, cHi := m, m
					if c.Min != nil && c.Max != nil {
						cLo, cHi = c.Min[ck], c.Max[ck]
					}
					if n == 0 || float64(cLo) < lo {
						lo = float64(cLo)
					}
					if n == 0 || float64(cHi) > hi {
						hi = float64(cHi)
					}
					sum += float64(m)
					n++
				}
			}
			if n == 0 {
				t.Mean[k] = NoData
				t.Max[k] = NoData
				t.Min[k] = NoData
				continue
			}
			any = true
			t.Mean[k] = toMetres(sum / float64(n))
			t.Max[k] = toMetres(hi)
			t.Min[k] = toMetres(lo)
			if t.Max[k] < t.Mean[k] {
				t.Max[k] = t.Mean[k]
			}
			if t.Min[k] > t.Mean[k] {
				t.Min[k] = t.Mean[k]
			}
		}
	}
	return t, any
}
