package terrain

import (
	"math"
	"testing"
)

// The claim every clearance number in the application rests on: an output
// pixel's max is the max of the SOURCE POSTS inside it, not a resampling of
// them. A tile built by interpolation would pass every other test in this
// package and still be wrong, because the pyramid above it would faithfully
// preserve a smoothed maximum: the 663 ft the mosaic being replaced loses on
// the Matterhorn is exactly that error, and it is invisible without comparing
// against the raw source.
//
// The source here is the real Alpine grid the fixtures carry, given a
// geographic placement so it can be pooled like any other.

// alpineSource places the committed grid over the ground it came from: the
// z12 tile 2125/1464, which spans one tile's worth of longitude and latitude.
func alpineSource(t *testing.T) *Grid {
	t.Helper()
	mean := realGrid(t)
	west := TileLon(12, 2125)
	north := TileLat(12, 1464)
	east := TileLon(12, 2126)
	south := TileLat(12, 1465)
	return &Grid{
		W: Size, H: Size,
		Lon0: west, Lat0: north,
		StepLon: (east - west) / Size,
		StepLat: (north - south) / Size,
		Data:    toFloat(mean),
	}
}

func toFloat(v []int16) []float32 {
	out := make([]float32, len(v))
	for i, x := range v {
		out[i] = float32(x)
	}
	return out
}

func TestNativeLevelPoolsTheSourceRatherThanResamplingIt(t *testing.T) {
	src := alpineSource(t)
	// One level coarser than the source, so each output pixel covers four
	// posts and a resampling would have somewhere to hide.
	const z, x, y = 11, 1062, 732
	tile, ok := BuildTile(z, x, y, []Source{src}, nil)
	if !ok {
		t.Fatal("the source did not cover its own ground")
	}
	checked := 0
	for j := 0; j < Size; j++ {
		north := TileLat(z, float64(y)+float64(j)/Size)
		south := TileLat(z, float64(y)+float64(j+1)/Size)
		for i := 0; i < Size; i++ {
			k := j*Size + i
			if tile.Mean[k] == NoData {
				continue
			}
			west := TileLon(z, float64(x)+float64(i)/Size)
			east := TileLon(z, float64(x)+float64(i+1)/Size)
			// The same footprint, read straight off the source.
			lo, _, hi, has := src.Pool(west, south, east, north)
			if !has {
				continue
			}
			if int16(math.Round(hi)) != tile.Max[k] {
				t.Fatalf("pixel %d,%d: tile max %d, source max %.0f", i, j, tile.Max[k], hi)
			}
			if int16(math.Round(lo)) != tile.Min[k] {
				t.Fatalf("pixel %d,%d: tile min %d, source min %.0f", i, j, tile.Min[k], lo)
			}
			checked++
		}
	}
	if checked < 1000 {
		t.Fatalf("only %d pixels had source under them; the placement is wrong", checked)
	}
}

func TestPoolingBeatsTheCentrePointOnRealGround(t *testing.T) {
	// What the pooling is FOR. Over real Alpine ground, reading the middle of
	// an output pixel instead of pooling it loses tens of metres per pixel
	// and hundreds over a tile: the same error, one level down, that this
	// whole mosaic exists to stop repeating.
	src := alpineSource(t)
	const z, x, y = 10, 531, 366
	tile, ok := BuildTile(z, x, y, []Source{src}, nil)
	if !ok {
		t.Fatal("no coverage")
	}
	worst, tileMax, centreMax := 0.0, math.Inf(-1), math.Inf(-1)
	for j := 0; j < Size; j++ {
		lat := TileLat(z, float64(y)+(float64(j)+0.5)/Size)
		for i := 0; i < Size; i++ {
			k := j*Size + i
			if tile.Max[k] == NoData {
				continue
			}
			lon := TileLon(z, float64(x)+(float64(i)+0.5)/Size)
			centre, has := src.Nearest(lon, lat)
			if !has {
				continue
			}
			if d := float64(tile.Max[k]) - centre; d > worst {
				worst = d
			}
			tileMax = math.Max(tileMax, float64(tile.Max[k]))
			centreMax = math.Max(centreMax, centre)
		}
	}
	if worst < 20 {
		t.Fatalf("pooling gained only %.0f m over centre sampling; is it pooling at all?", worst)
	}
	if tileMax < centreMax {
		t.Fatalf("the pooled maximum %.0f is BELOW the centre-sampled %.0f", tileMax, centreMax)
	}
	t.Logf("pooled max %.0f m, centre-sampled %.0f m, worst pixel %.0f m", tileMax, centreMax, worst)
}
