package geodesy

import (
	"math"
	"testing"
)

func TestToMeters(t *testing.T) {
	tests := []struct {
		val  float64
		uom  string
		want float64
		ok   bool
	}{
		{5, "NM", 9260, true},
		{3, "KM", 3000, true},
		{250, "M", 250, true},
		{1, "nm", 1852, true}, // case-insensitive
		{1, "FT", 0, false},   // unsupported unit
	}
	for _, tc := range tests {
		got, ok := ToMeters(tc.val, tc.uom)
		if ok != tc.ok || (ok && math.Abs(got-tc.want) > 1e-6) {
			t.Errorf("ToMeters(%v, %q) = %v, %v; want %v, %v", tc.val, tc.uom, got, ok, tc.want, tc.ok)
		}
	}
}

func TestDestPoint(t *testing.T) {
	deg := EarthRadiusM * math.Pi / 180 // one degree of arc
	lat, lon := DestPoint(0, 0, 0, deg) // due north
	if math.Abs(lat-1) > 1e-6 || math.Abs(lon) > 1e-6 {
		t.Errorf("DestPoint north = (%v, %v), want (1, 0)", lat, lon)
	}
	lat, lon = DestPoint(0, 0, 90, deg) // due east
	if math.Abs(lat) > 1e-6 || math.Abs(lon-1) > 1e-6 {
		t.Errorf("DestPoint east = (%v, %v), want (0, 1)", lat, lon)
	}
}

func TestDistanceM(t *testing.T) {
	// One degree of latitude along a meridian.
	want := EarthRadiusM * math.Pi / 180
	if got := DistanceM(48, 2, 49, 2); math.Abs(got-want) > 1 {
		t.Errorf("DistanceM meridian degree = %v, want %v", got, want)
	}
	if got := DistanceM(50, -2, 50, -2); got != 0 {
		t.Errorf("DistanceM identical points = %v, want 0", got)
	}
}

func TestDensifyGreatCircle(t *testing.T) {
	// The LFRR / EGTT southwest-approaches segment: the great circle
	// between 48°50'N 8°W and 50°N 2°W passes 49.4555°N 5.0357°W at its
	// midpoint, 4.3 km north of the straight lat/lon chord (49.4167).
	// Every densified point must sit on the slerp reference at its
	// fraction (the initial-bearing walk IS the great circle).
	a, b := [2]float64{48.83333, -8}, [2]float64{50, -2}
	pts := DensifyGreatCircle(a, b)
	if len(pts) < 10 {
		t.Fatalf("densified point count = %d, want >= 10 (~450 km at 25 km steps)", len(pts))
	}
	steps := len(pts) + 1
	for i, p := range pts {
		want := slerp(a, b, float64(i+1)/float64(steps))
		if math.Abs(p[0]-want[0]) > 1e-6 || math.Abs(p[1]-want[1]) > 1e-6 {
			t.Fatalf("point %d = %v, want %v (off the great circle)", i, p, want)
		}
	}
	mid := slerp(a, b, 0.5)
	if math.Abs(mid[0]-49.4555) > 0.001 || math.Abs(mid[1]-(-5.0357)) > 0.001 {
		t.Errorf("slerp midpoint = %v, want ~[49.4555 -5.0357] (reference self-check)", mid)
	}
	// Every point spaced at most one step from its neighbours.
	prev := a
	for _, p := range append(pts, b) {
		if d := DistanceM(prev[0], prev[1], p[0], p[1]); d > GreatCircleStepM+1 {
			t.Fatalf("step %v -> %v is %v m, want <= %v", prev, p, d, GreatCircleStepM)
		}
		prev = p
	}
	// A pair within one step yields nothing.
	if pts := DensifyGreatCircle([2]float64{50, -2}, [2]float64{50.1, -2}); pts != nil {
		t.Errorf("short pair densified to %v, want nil", pts)
	}
	// A meridian pair stays on the meridian (a meridian IS a great circle).
	for _, p := range DensifyGreatCircle([2]float64{50, -0.25}, [2]float64{46.5, -0.25}) {
		if math.Abs(p[1]-(-0.25)) > 1e-9 {
			t.Fatalf("meridian densify left the meridian: %v", p)
		}
	}
}

// slerp is the classic great-circle interpolation, the independent
// reference for TestDensifyGreatCircle.
func slerp(a, b [2]float64, f float64) [2]float64 {
	la1, lo1 := radians(a[0]), radians(a[1])
	la2, lo2 := radians(b[0]), radians(b[1])
	d := 2 * math.Asin(math.Sqrt(
		math.Sin((la2-la1)/2)*math.Sin((la2-la1)/2)+
			math.Cos(la1)*math.Cos(la2)*math.Sin((lo2-lo1)/2)*math.Sin((lo2-lo1)/2)))
	A := math.Sin((1-f)*d) / math.Sin(d)
	B := math.Sin(f*d) / math.Sin(d)
	x := A*math.Cos(la1)*math.Cos(lo1) + B*math.Cos(la2)*math.Cos(lo2)
	y := A*math.Cos(la1)*math.Sin(lo1) + B*math.Cos(la2)*math.Sin(lo2)
	z := A*math.Sin(la1) + B*math.Sin(la2)
	return [2]float64{degrees(math.Atan2(z, math.Hypot(x, y))), degrees(math.Atan2(y, x))}
}
