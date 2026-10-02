package terrain

import (
	"math"
	"testing"
)

// fakeSource is a plane of `base` metres with one spike, over a bounded box:
// enough to see which pixel a value lands in and which band it reaches.
type fakeSource struct {
	west, south, east, north float64
	base                     float64
	spikeLon, spikeLat       float64
	spike                    float64
	hasSpike                 bool
}

func (f *fakeSource) covers(lon, lat float64) bool {
	return lon >= f.west && lon <= f.east && lat >= f.south && lat <= f.north
}

func (f *fakeSource) Pool(w, s, e, n float64) (float64, float64, float64, bool) {
	if e < f.west || w > f.east || n < f.south || s > f.north {
		return 0, 0, 0, false
	}
	min, mean, max := f.base, f.base, f.base
	if f.hasSpike && f.spikeLon >= w && f.spikeLon <= e && f.spikeLat >= s && f.spikeLat <= n {
		if f.spike > max {
			max = f.spike
		}
		if f.spike < min {
			min = f.spike
		}
		mean = (f.base + f.spike) / 2
	}
	return min, mean, max, true
}

func (f *fakeSource) Nearest(lon, lat float64) (float64, bool) {
	if !f.covers(lon, lat) {
		return 0, false
	}
	return f.base, true
}

// The z12 tile over the Alps the fixtures use.
const (
	tz = 12
	tx = 2125
	ty = 1464
)

// pixelCentre is where a value belongs to exactly one output pixel; the
// tile's own centre is a pixel CORNER and lands in four.
func pixelCentre(i, j int) (lon, lat float64) {
	return TileLon(tz, float64(tx)+(float64(i)+0.5)/Size),
		TileLat(tz, float64(ty)+(float64(j)+0.5)/Size)
}

func TestBuildTilePutsAPeakInItsOwnPixel(t *testing.T) {
	lon, lat := pixelCentre(100, 60)
	src := &fakeSource{
		west: -180, south: -85, east: 180, north: 85,
		base: 1000, spikeLon: lon, spikeLat: lat, spike: 3000, hasSpike: true,
	}
	tile, ok := BuildTile(tz, tx, ty, []Source{src}, nil)
	if !ok {
		t.Fatal("no coverage")
	}
	peaks := 0
	for i, v := range tile.Max {
		if v == 3000 {
			peaks++
		} else if v != 1000 {
			t.Fatalf("pixel %d has max %d, want 1000 or 3000", i, v)
		}
	}
	if peaks != 1 {
		t.Fatalf("%d pixels carry the peak, want 1", peaks)
	}
	// Its own pixel keeps the mean between the extremes; every other pixel is
	// flat, so min == mean == max there.
	for i := range tile.Mean {
		if tile.Min[i] > tile.Mean[i] || tile.Max[i] < tile.Mean[i] {
			t.Fatalf("pixel %d: %d..%d does not bracket %d", i, tile.Min[i], tile.Max[i], tile.Mean[i])
		}
	}
}

func TestBuildTileRaisesOnlyTheMaxBandFromTheSurface(t *testing.T) {
	lon, lat := pixelCentre(100, 60)
	ground := &fakeSource{west: -180, south: -85, east: 180, north: 85, base: 1000}
	surface := &fakeSource{
		west: -180, south: -85, east: 180, north: 85,
		base: 1030, spikeLon: lon, spikeLat: lat, spike: 1060, hasSpike: true,
	}
	tile, ok := BuildTile(tz, tx, ty, []Source{ground}, []Source{surface})
	if !ok {
		t.Fatal("no coverage")
	}
	for i := range tile.Mean {
		// The decision the bands exist for: canopy and buildings pad
		// clearance, and height above ground stays bare earth.
		if tile.Mean[i] != 1000 || tile.Min[i] != 1000 {
			t.Fatalf("pixel %d: the surface moved the bare-earth bands (%d/%d)", i, tile.Min[i], tile.Mean[i])
		}
		if tile.Max[i] != 1030 && tile.Max[i] != 1060 {
			t.Fatalf("pixel %d: max %d, want the surface's 1030 or 1060", i, tile.Max[i])
		}
	}
}

func TestBuildTileReportsGroundNobodyCovers(t *testing.T) {
	far := &fakeSource{west: 100, south: -10, east: 110, north: 10, base: 500}
	tile, ok := BuildTile(tz, tx, ty, []Source{far}, nil)
	if ok {
		t.Fatal("a source on the other side of the world reported coverage")
	}
	for i, v := range tile.Mean {
		if v != NoData {
			t.Fatalf("pixel %d is %d, want the sentinel", i, v)
		}
	}
}

func TestBuildTileTakesTheFirstSourceThatAnswers(t *testing.T) {
	lon, lat := pixelCentre(128, 128)
	national := &fakeSource{
		west: lon - 0.01, south: lat - 0.01, east: lon + 0.01, north: lat + 0.01, base: 2000,
	}
	global := &fakeSource{west: -180, south: -85, east: 180, north: 85, base: 100}
	tile, ok := BuildTile(tz, tx, ty, []Source{national, global}, nil)
	if !ok {
		t.Fatal("no coverage")
	}
	seen := map[int16]int{}
	for _, v := range tile.Mean {
		seen[v]++
	}
	if seen[2000] == 0 || seen[100] == 0 {
		t.Fatalf("expected both sources to show: %v", seen)
	}
}

func TestPool4KeepsTheExtremesOfEverythingBeneathIt(t *testing.T) {
	// The pyramid's whole promise, and the reason a corridor may be answered
	// at a coarse level: a parent's max IS the max of its children.
	mk := func(base, spike float64, at int) *Tile {
		tl := &Tile{Z: 12, Mean: make([]int16, Pixels), Max: make([]int16, Pixels), Min: make([]int16, Pixels)}
		for i := range tl.Mean {
			tl.Mean[i] = int16(base)
			tl.Max[i] = int16(base)
			tl.Min[i] = int16(base)
		}
		tl.Max[at] = int16(spike)
		tl.Min[at] = int16(base - 50)
		return tl
	}
	kids := [4]*Tile{mk(1000, 2500, 0), mk(1000, 1800, 999), mk(1000, 3300, 5), mk(1000, 1200, 60000)}
	parent, ok := Pool4(11, 1, 1, kids[0], kids[1], kids[2], kids[3])
	if !ok {
		t.Fatal("no parent")
	}
	max, min := int16(math.MinInt16), int16(math.MaxInt16)
	for i, v := range parent.Max {
		if v == NoData {
			continue
		}
		if v > max {
			max = v
		}
		if parent.Min[i] < min {
			min = parent.Min[i]
		}
	}
	if max != 3300 {
		t.Fatalf("parent max %d, want the children's 3300", max)
	}
	if min != 950 {
		t.Fatalf("parent min %d, want the children's 950", min)
	}
}

func TestPool4CarriesAMissingChildAsNoData(t *testing.T) {
	full := &Tile{Z: 12, Mean: make([]int16, Pixels), Max: make([]int16, Pixels), Min: make([]int16, Pixels)}
	for i := range full.Mean {
		full.Mean[i] = 700
		full.Max[i] = 700
		full.Min[i] = 700
	}
	parent, ok := Pool4(11, 0, 0, full, nil, nil, nil)
	if !ok {
		t.Fatal("no parent")
	}
	// The quadrant that had a child is ground; the other three are unknown.
	if parent.Mean[0] != 700 {
		t.Fatalf("the covered quadrant reads %d", parent.Mean[0])
	}
	if parent.Mean[Size-1] != NoData || parent.Mean[Pixels-1] != NoData {
		t.Fatal("a missing child must read as the sentinel, not as zero")
	}
}

func TestToMetresNeverLandsOnTheSentinel(t *testing.T) {
	if v := toMetres(-40000); v != NoData+1 {
		t.Fatalf("a value below the floor quantised to %d", v)
	}
	if v := toMetres(float64(NoData)); v == NoData {
		t.Fatal("a real elevation quantised onto the no-data sentinel")
	}
	if v := toMetres(100000); v != 32767 {
		t.Fatalf("a value above the ceiling quantised to %d", v)
	}
}

func TestTileLonLatAreTheSlippyInverse(t *testing.T) {
	// The pixel edges BuildTile works in have to be the same projection the
	// client reads them back with (map/terrain.ts lngLatToTile).
	for _, c := range []struct{ z, x, y int }{{0, 0, 0}, {12, 2125, 1464}, {14, 8500, 5800}} {
		lon := TileLon(c.z, float64(c.x))
		lat := TileLat(c.z, float64(c.y))
		n := float64(int(1) << uint(c.z))
		bx := (lon + 180) / 360 * n
		rad := lat * math.Pi / 180
		by := (1 - math.Log(math.Tan(rad)+1/math.Cos(rad))/math.Pi) / 2 * n
		if math.Abs(bx-float64(c.x)) > 1e-9 || math.Abs(by-float64(c.y)) > 1e-9 {
			t.Fatalf("z%d/%d/%d round-tripped to %.9f/%.9f", c.z, c.x, c.y, bx, by)
		}
	}
}

// A single-band tile means one value per pixel, not an unknown band, and it
// decodes with no Max or Min at all. Filling from one must not leave a pixel
// carrying ground with the sentinel for its ceiling: every consumer reads the
// bands as a bracket, and an unbracketed pixel is an AGL answered from a
// ceiling that does not exist.
func TestKeepUncoveredReadsASingleBandTileAsOneValue(t *testing.T) {
	dst := &Tile{Z: 11, Mean: make([]int16, Pixels), Max: make([]int16, Pixels), Min: make([]int16, Pixels)}
	for i := range dst.Mean {
		dst.Mean[i], dst.Max[i], dst.Min[i] = NoData, NoData, NoData
	}
	under := &Tile{Z: 11, Mean: make([]int16, Pixels)}
	for i := range under.Mean {
		under.Mean[i] = 400
	}

	KeepUncovered(dst, under)

	for i := range dst.Mean {
		if dst.Mean[i] != 400 || dst.Max[i] != 400 || dst.Min[i] != 400 {
			t.Fatalf("pixel %d is %d/%d/%d, want 400 in all three bands",
				i, dst.Min[i], dst.Mean[i], dst.Max[i])
		}
	}
}

// And it must not touch a pixel that was pooled.
func TestKeepUncoveredLeavesCoveredPixelsAlone(t *testing.T) {
	dst := &Tile{Z: 11, Mean: make([]int16, Pixels), Max: make([]int16, Pixels), Min: make([]int16, Pixels)}
	under := &Tile{Z: 11, Mean: make([]int16, Pixels), Max: make([]int16, Pixels), Min: make([]int16, Pixels)}
	for i := range dst.Mean {
		dst.Mean[i], dst.Max[i], dst.Min[i] = 1000, 1200, 900
		under.Mean[i], under.Max[i], under.Min[i] = 50, 50, 50
	}
	KeepUncovered(dst, under)
	if dst.Mean[0] != 1000 || dst.Max[0] != 1200 || dst.Min[0] != 900 {
		t.Fatalf("a covered pixel was overwritten: %d/%d/%d", dst.Min[0], dst.Mean[0], dst.Max[0])
	}
}
