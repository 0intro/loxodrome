package terrain

import (
	"math"
	"testing"
)

func TestLambert93HitsItsOwnOrigin(t *testing.T) {
	// The projection is DEFINED so that (3 E, 46.5 N) lands on
	// (700000, 6600000); if the constants are wrong this is where it shows.
	x, y := Lambert93().Forward(3, 46.5)
	if math.Abs(x-700000) > 1e-3 || math.Abs(y-6600000) > 1e-3 {
		t.Fatalf("origin maps to %.4f, %.4f, want 700000, 6600000", x, y)
	}
}

func TestLambert93IsTrueToScaleOnItsStandardParallels(t *testing.T) {
	// A conformal conic has scale 1 along its two standard parallels, so a
	// short arc there must map to its own true length. That tests the
	// development, not just the origin: an error in n or F moves this.
	for _, lat := range []float64{44, 49} {
		const d = 0.01 // degrees of longitude
		x1, y1 := Lambert93().Forward(3-d/2, lat)
		x2, y2 := Lambert93().Forward(3+d/2, lat)
		got := math.Hypot(x2-x1, y2-y1)
		// True length of the parallel arc on GRS80.
		e2 := 2*grs80F - grs80F*grs80F
		phi := rad(lat)
		n := grs80A / math.Sqrt(1-e2*math.Sin(phi)*math.Sin(phi))
		want := n * math.Cos(phi) * rad(d)
		if math.Abs(got-want)/want > 1e-6 {
			t.Fatalf("at %g N the arc maps to %.4f m, want %.4f m", lat, got, want)
		}
	}
}

func TestLambert93ScaleGrowsAwayFromTheParallels(t *testing.T) {
	// Between them the conic is short, outside it long: the sign of the
	// distortion is the shape of the projection and a transposed parameter
	// flips it.
	arc := func(lat float64) float64 {
		const d = 0.01
		x1, y1 := Lambert93().Forward(3-d/2, lat)
		x2, y2 := Lambert93().Forward(3+d/2, lat)
		e2 := 2*grs80F - grs80F*grs80F
		phi := rad(lat)
		n := grs80A / math.Sqrt(1-e2*math.Sin(phi)*math.Sin(phi))
		return math.Hypot(x2-x1, y2-y1) / (n * math.Cos(phi) * rad(d))
	}
	if k := arc(46.5); k >= 1 {
		t.Fatalf("scale between the parallels is %.6f, want under 1", k)
	}
	if k := arc(51); k <= 1 {
		t.Fatalf("scale beyond the parallels is %.6f, want over 1", k)
	}
}

func TestUTMHitsItsCentralMeridian(t *testing.T) {
	// On the central meridian the easting is exactly the false easting, and
	// the northing is the meridian arc times the scale factor.
	for _, z := range []struct {
		zone  int
		north bool
		lon   float64
	}{
		{22, true, -51}, // Guyane
		{20, true, -63}, // the Antilles
		{40, false, 57}, // La Reunion
	} {
		p := UTM(z.zone, z.north)
		if math.Abs(p.Lon0-z.lon) > 1e-9 {
			t.Fatalf("zone %d central meridian %g, want %g", z.zone, p.Lon0, z.lon)
		}
		x, _ := p.Forward(z.lon, 5)
		if math.Abs(x-500000) > 1e-6 {
			t.Fatalf("zone %d: the central meridian maps to x=%.4f, want 500000", z.zone, x)
		}
	}
	// The equator on a northern zone is the false northing itself.
	if _, y := UTM(22, true).Forward(-51, 0); math.Abs(y) > 1e-6 {
		t.Fatalf("the equator maps to y=%.4f, want 0", y)
	}
	if _, y := UTM(40, false).Forward(57, 0); math.Abs(y-10000000) > 1e-6 {
		t.Fatalf("the equator maps to y=%.4f on a southern zone, want 10000000", y)
	}
}

func TestUTMIsTrueToScaleWhereItsScaleFactorSaysSo(t *testing.T) {
	// 0.9996 on the central meridian, by construction.
	p := UTM(31, true)
	const d = 0.001
	_, y1 := p.Forward(3, 45-d/2)
	_, y2 := p.Forward(3, 45+d/2)
	// Meridian arc over the same interval on GRS80.
	e2 := 2*grs80F - grs80F*grs80F
	phi := rad(45.0)
	m := grs80A * (1 - e2) / math.Pow(1-e2*math.Sin(phi)*math.Sin(phi), 1.5)
	want := m * rad(d) * 0.9996
	if got := y2 - y1; math.Abs(got-want)/want > 1e-6 {
		t.Fatalf("meridian arc maps to %.6f m, want %.6f m", got, want)
	}
}

func TestHgtCornerReadsThePositionOutOfTheName(t *testing.T) {
	cases := []struct {
		name     string
		lat, lon float64
	}{
		{"N45E006.hgt", 45, 6},
		{"/tmp/x/S13W072.hgt", -13, -72},
		{"n00e000.hgt", 0, 0},
	}
	for _, c := range cases {
		lat, lon, err := hgtCorner(c.name)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if lat != c.lat || lon != c.lon {
			t.Fatalf("%s: got %g,%g want %g,%g", c.name, lat, lon, c.lat, c.lon)
		}
	}
	for _, bad := range []string{"", "hello.hgt", "X45E006.hgt", "N45X006.hgt"} {
		if _, _, err := hgtCorner(bad); err == nil {
			t.Errorf("%q was accepted", bad)
		}
	}
}
