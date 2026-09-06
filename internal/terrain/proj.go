package terrain

// The two map projections the national elevation grids are published on, in
// the forward direction only: a projected grid is asked "what is at this
// longitude and latitude", so it needs to turn that into its own easting and
// northing, never the other way.
//
// Both are the standard ellipsoidal developments (Snyder, USGS Professional
// Paper 1395). cmd/vacgeo already reasons about a conformal conic on the
// ellipsoid for the VAC plates; this is the same family with its parameters
// published rather than measured.

import "math"

// Projection turns a geographic position into a projected one.
type Projection interface {
	Forward(lon, lat float64) (x, y float64)
}

// GRS80 is the ellipsoid every CRS below uses (RGF93, RGFG95, RGAF09, RGR92,
// RGM04 all realise ETRS89-style datums on it).
const (
	grs80A = 6378137.0
	grs80F = 1 / 298.257222101
)

func rad(d float64) float64 { return d * math.Pi / 180 }

// LambertConic is a Lambert Conformal Conic with two standard parallels,
// which is Lambert-93 (EPSG:2154, the CRS of RGE ALTI over metropolitan
// France) and its Corsican sibling.
type LambertConic struct {
	Lat0, Lon0 float64 // the origin, degrees
	Lat1, Lat2 float64 // the standard parallels, degrees
	X0, Y0     float64 // false easting / northing
	A, F       float64 // ellipsoid

	n, bigF, rho0 float64
	ready         bool
}

// Lambert93 is EPSG:2154.
func Lambert93() *LambertConic {
	return &LambertConic{
		Lat0: 46.5, Lon0: 3, Lat1: 44, Lat2: 49,
		X0: 700000, Y0: 6600000, A: grs80A, F: grs80F,
	}
}

func (p *LambertConic) prepare() {
	if p.ready {
		return
	}
	e := math.Sqrt(2*p.F - p.F*p.F)
	m := func(phi float64) float64 {
		s := math.Sin(phi)
		return math.Cos(phi) / math.Sqrt(1-e*e*s*s)
	}
	t := func(phi float64) float64 {
		s := math.Sin(phi)
		return math.Tan(math.Pi/4-phi/2) / math.Pow((1-e*s)/(1+e*s), e/2)
	}
	p1, p2, p0 := rad(p.Lat1), rad(p.Lat2), rad(p.Lat0)
	m1, m2 := m(p1), m(p2)
	t1, t2, t0 := t(p1), t(p2), t(p0)
	if math.Abs(p.Lat1-p.Lat2) < 1e-12 {
		p.n = math.Sin(p1)
	} else {
		p.n = (math.Log(m1) - math.Log(m2)) / (math.Log(t1) - math.Log(t2))
	}
	p.bigF = m1 / (p.n * math.Pow(t1, p.n))
	p.rho0 = p.A * p.bigF * math.Pow(t0, p.n)
	p.ready = true
}

func (p *LambertConic) Forward(lon, lat float64) (float64, float64) {
	p.prepare()
	e := math.Sqrt(2*p.F - p.F*p.F)
	phi := rad(lat)
	s := math.Sin(phi)
	t := math.Tan(math.Pi/4-phi/2) / math.Pow((1-e*s)/(1+e*s), e/2)
	rho := p.A * p.bigF * math.Pow(t, p.n)
	theta := p.n * rad(lon-p.Lon0)
	return p.X0 + rho*math.Sin(theta), p.Y0 + p.rho0 - rho*math.Cos(theta)
}

// TransverseMercator covers the UTM zones the overseas grids are on: Guyane
// on 22N, the Antilles on 20N, Mayotte on 38S, La Reunion on 40S.
type TransverseMercator struct {
	Lon0   float64 // central meridian, degrees
	K0     float64
	X0, Y0 float64
	A, F   float64
}

// UTM is the zone's projection; `north` picks the false northing.
func UTM(zone int, north bool) *TransverseMercator {
	y0 := 0.0
	if !north {
		y0 = 10000000
	}
	return &TransverseMercator{
		Lon0: float64(zone)*6 - 183, K0: 0.9996,
		X0: 500000, Y0: y0, A: grs80A, F: grs80F,
	}
}

func (p *TransverseMercator) Forward(lon, lat float64) (float64, float64) {
	a := p.A
	e2 := 2*p.F - p.F*p.F
	ep2 := e2 / (1 - e2)
	phi := rad(lat)
	sinPhi, cosPhi, tanPhi := math.Sin(phi), math.Cos(phi), math.Tan(phi)
	n := a / math.Sqrt(1-e2*sinPhi*sinPhi)
	t := tanPhi * tanPhi
	c := ep2 * cosPhi * cosPhi
	al := rad(lon-p.Lon0) * cosPhi
	m := a * ((1-e2/4-3*e2*e2/64-5*e2*e2*e2/256)*phi -
		(3*e2/8+3*e2*e2/32+45*e2*e2*e2/1024)*math.Sin(2*phi) +
		(15*e2*e2/256+45*e2*e2*e2/1024)*math.Sin(4*phi) -
		(35*e2*e2*e2/3072)*math.Sin(6*phi))
	x := p.X0 + p.K0*n*(al+(1-t+c)*al*al*al/6+
		(5-18*t+t*t+72*c-58*ep2)*math.Pow(al, 5)/120)
	y := p.Y0 + p.K0*(m+n*tanPhi*(al*al/2+(5-t+9*c+4*c*c)*math.Pow(al, 4)/24+
		(61-58*t+t*t+600*c-330*ep2)*math.Pow(al, 6)/720))
	return x, y
}

// ProjectedGrid is a source raster on a projected lattice: the ESRI ASCII
// grids the national agencies ship. It answers the same questions as Grid,
// through its own projection, so the mosaic builder does not care which kind
// a region turned out to be.
type ProjectedGrid struct {
	W, H   int
	X0, Y0 float64 // the sample at column 0, row 0 (north-west post)
	Step   float64
	Data   []float32

	NoData    float32
	HasNoData bool
	Proj      Projection
}

func (g *ProjectedGrid) at(x, y int) (float64, bool) {
	if x < 0 || y < 0 || x >= g.W || y >= g.H {
		return 0, false
	}
	v := g.Data[y*g.W+x]
	if g.HasNoData && v == g.NoData {
		return 0, false
	}
	if math.IsNaN(float64(v)) || v < -12000 || v > 9500 {
		return 0, false
	}
	return float64(v), true
}

// Pool is Grid.Pool over a geographic box: the corners are projected and the
// samples inside the resulting extent are pooled. The box is small (one
// output pixel) and the projections are conformal, so its projected shape is
// a rectangle to well within a sample.
func (g *ProjectedGrid) Pool(west, south, east, north float64) (min, mean, max float64, ok bool) {
	if g.Proj == nil {
		return 0, 0, 0, false
	}
	x1, y1 := g.Proj.Forward(west, north)
	x2, y2 := g.Proj.Forward(east, north)
	x3, y3 := g.Proj.Forward(west, south)
	x4, y4 := g.Proj.Forward(east, south)
	minX := math.Min(math.Min(x1, x2), math.Min(x3, x4))
	maxX := math.Max(math.Max(x1, x2), math.Max(x3, x4))
	minY := math.Min(math.Min(y1, y2), math.Min(y3, y4))
	maxY := math.Max(math.Max(y1, y2), math.Max(y3, y4))
	c0 := int(math.Ceil((minX - g.X0) / g.Step))
	c1 := int(math.Floor((maxX - g.X0) / g.Step))
	r0 := int(math.Ceil((g.Y0 - maxY) / g.Step))
	r1 := int(math.Floor((g.Y0 - minY) / g.Step))
	min, max = math.Inf(1), math.Inf(-1)
	sum, n := 0.0, 0
	for y := r0; y <= r1; y++ {
		for x := c0; x <= c1; x++ {
			v, has := g.at(x, y)
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

// Nearest is the sample closest to a position, for an output pixel finer than
// the source it is being built from.
func (g *ProjectedGrid) Nearest(lon, lat float64) (float64, bool) {
	if g.Proj == nil {
		return 0, false
	}
	x, y := g.Proj.Forward(lon, lat)
	return g.at(int(math.Round((x-g.X0)/g.Step)), int(math.Round((g.Y0-y)/g.Step)))
}
