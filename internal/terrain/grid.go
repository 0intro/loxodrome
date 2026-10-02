package terrain

import "math"

// Grid is one source raster on a regular geographic lattice: what the mosaic
// builder needs from a DEM and nothing else.
//
// The lattice is POINT-sampled, which is what the elevation products are:
// Copernicus states RasterPixelIsPoint, an ESRI ASCII grid's header gives
// either cell centres or corners and says which, and an HGT is defined as
// posts. A reader that treats a point lattice as an area one puts every
// value half a cell out, which is 15 m at 1 arc-second and a whole pixel at
// the output resolutions this feeds.
type Grid struct {
	W, H int
	// Geographic position of the sample at column 0, row 0, and the step per
	// column (east) and per row (SOUTH, so latitude decreases with y).
	Lon0, Lat0 float64
	StepLon    float64
	StepLat    float64
	// Values in metres, row-major, W*H of them.
	Data []float32
	// NoData is the source's own marker; HasNoData says whether it set one.
	NoData    float32
	HasNoData bool
}

// At reads one sample, reporting whether the source has data there.
func (g *Grid) At(x, y int) (float64, bool) {
	if x < 0 || y < 0 || x >= g.W || y >= g.H {
		return 0, false
	}
	v := g.Data[y*g.W+x]
	if g.HasNoData && v == g.NoData {
		return 0, false
	}
	if math.IsNaN(float64(v)) || math.IsInf(float64(v), 0) {
		return 0, false
	}
	// Beyond any elevation on Earth in either direction: some products carry
	// -9999 or -32767 without declaring it, and a value nobody could stand on
	// is a marker whatever the header says.
	if v < -12000 || v > 9500 {
		return 0, false
	}
	return float64(v), true
}

// Bounds are the geographic extent of the SAMPLES (not of any cell around
// them): west, south, east, north.
func (g *Grid) Bounds() (w, s, e, n float64) {
	w = g.Lon0
	e = g.Lon0 + float64(g.W-1)*g.StepLon
	n = g.Lat0
	s = g.Lat0 - float64(g.H-1)*g.StepLat
	return
}

// Column returns the fractional column of a longitude, Row the fractional row
// of a latitude. Callers pool over a range of them rather than interpolating:
// the extremes of a footprint are the whole point, and an interpolation is
// exactly what loses them.
func (g *Grid) Column(lon float64) float64 { return (lon - g.Lon0) / g.StepLon }
func (g *Grid) Row(lat float64) float64    { return (g.Lat0 - lat) / g.StepLat }

// Pool is the extremes and the mean of every sample whose position falls in
// the geographic box, or ok=false when the box holds no data at all.
//
// POOLING, never interpolation: a maximum that has been through a bilinear
// blend is not a maximum, and the 663 ft the old source lost on the
// Matterhorn is exactly that error.
func (g *Grid) Pool(west, south, east, north float64) (min, mean, max float64, ok bool) {
	x0 := int(math.Ceil(g.Column(west) - 1e-9))
	x1 := int(math.Floor(g.Column(east) + 1e-9))
	y0 := int(math.Ceil(g.Row(north) - 1e-9))
	y1 := int(math.Floor(g.Row(south) + 1e-9))
	if x0 < 0 {
		x0 = 0
	}
	if y0 < 0 {
		y0 = 0
	}
	if x1 > g.W-1 {
		x1 = g.W - 1
	}
	if y1 > g.H-1 {
		y1 = g.H - 1
	}
	min, max = math.Inf(1), math.Inf(-1)
	sum, n := 0.0, 0
	for y := y0; y <= y1; y++ {
		for x := x0; x <= x1; x++ {
			v, has := g.At(x, y)
			if !has {
				continue
			}
			if v < min {
				min = v
			}
			if v > max {
				max = v
			}
			sum += v
			n++
		}
	}
	if n == 0 {
		return 0, 0, 0, false
	}
	return min, sum / float64(n), max, true
}

// Nearest is the sample closest to a position, for a box that fell between
// two of them: an output pixel finer than its source has no posts inside it,
// and the honest answer there is the post it sits on rather than a hole.
func (g *Grid) Nearest(lon, lat float64) (float64, bool) {
	x := int(math.Round(g.Column(lon)))
	y := int(math.Round(g.Row(lat)))
	return g.At(x, y)
}
