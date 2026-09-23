package geodesy

import (
	"math"
	"testing"
)

// haversineM is an independent great-circle distance (a different formula
// from DestPoint's forward law-of-cosines) used to confirm that generated
// ring / arc points really sit radiusM from the centre.
func haversineM(lat1, lon1, lat2, lon2 float64) float64 {
	p1, p2 := radians(lat1), radians(lat2)
	dp, dl := radians(lat2-lat1), radians(lon2-lon1)
	a := math.Sin(dp/2)*math.Sin(dp/2) + math.Cos(p1)*math.Cos(p2)*math.Sin(dl/2)*math.Sin(dl/2)
	return 2 * EarthRadiusM * math.Asin(math.Sqrt(a))
}

func TestInitialBearing(t *testing.T) {
	tests := []struct {
		name                   string
		latA, lonA, latB, lonB float64
		want                   float64
	}{
		{"east", 0, 0, 0, 1, 90},
		{"north", 0, 0, 1, 0, 0},
		{"west", 0, 0, 0, -1, 270},
		{"south", 0, 0, -1, 0, 180},
	}
	for _, tc := range tests {
		if got := InitialBearing(tc.latA, tc.lonA, tc.latB, tc.lonB); math.Abs(got-tc.want) > 1e-6 {
			t.Errorf("InitialBearing(%s) = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestRadiusMeters(t *testing.T) {
	tests := []struct {
		val, uom string
		want     float64
		wantErr  bool
	}{
		{"5", "NM", 9260, false},
		{"3", "KM", 3000, false},
		{"250", "M", 250, false},
		{"x", "NM", 0, true}, // unparseable value
		{"5", "FT", 0, true}, // unknown unit
	}
	for _, tc := range tests {
		got, err := RadiusMeters(tc.val, tc.uom)
		if (err != nil) != tc.wantErr {
			t.Errorf("RadiusMeters(%q, %q) err = %v, wantErr %v", tc.val, tc.uom, err, tc.wantErr)
			continue
		}
		if err == nil && math.Abs(got-tc.want) > 1e-6 {
			t.Errorf("RadiusMeters(%q, %q) = %v, want %v", tc.val, tc.uom, got, tc.want)
		}
	}
}

func TestCircleRing(t *testing.T) {
	const r = 9260 // 5 NM
	ring := CircleRing(0, 0, r)
	if len(ring) != CircleSteps {
		t.Fatalf("CircleRing len = %d, want %d", len(ring), CircleSteps)
	}
	for i, p := range ring {
		if d := haversineM(0, 0, p[0], p[1]); math.Abs(d-r) > 1e-3 {
			t.Errorf("ring[%d] distance = %v, want %v", i, d, r)
		}
		wantB := float64(i) * 360 / CircleSteps
		b := InitialBearing(0, 0, p[0], p[1])
		// Bearing matches if it differs from wantB by ~0 or ~360 (wraparound).
		if diff := math.Abs(b - wantB); diff > 1e-6 && 360-diff > 1e-6 {
			t.Errorf("ring[%d] bearing = %v, want %v", i, b, wantB)
		}
	}
}

func TestArcPoints(t *testing.T) {
	const r = 9260
	nLat, nLon := DestPoint(0, 0, 0, r)  // north of centre
	eLat, eLon := DestPoint(0, 0, 90, r) // east of centre

	// Clockwise from north (0°) to east (90°): a 90° sweep, 18 steps, 17
	// interior points with initial bearings 5°..85°.
	cw := ArcPoints(nLat, nLon, eLat, eLon, 0, 0, r, true)
	if len(cw) != 17 {
		t.Fatalf("CW arc len = %d, want 17", len(cw))
	}
	for i, p := range cw {
		if d := haversineM(0, 0, p[0], p[1]); math.Abs(d-r) > 1e-3 {
			t.Errorf("cw[%d] distance = %v, want %v", i, d, r)
		}
	}
	if b := InitialBearing(0, 0, cw[0][0], cw[0][1]); math.Abs(b-5) > 1e-6 {
		t.Errorf("cw first bearing = %v, want 5", b)
	}
	if b := InitialBearing(0, 0, cw[len(cw)-1][0], cw[len(cw)-1][1]); math.Abs(b-85) > 1e-6 {
		t.Errorf("cw last bearing = %v, want 85", b)
	}

	// Same endpoints counter-clockwise: the long way round, 270° sweep, 53
	// interior points — exercises the CCA branch.
	ccw := ArcPoints(nLat, nLon, eLat, eLon, 0, 0, r, false)
	if len(ccw) != 53 {
		t.Fatalf("CCW arc len = %d, want 53", len(ccw))
	}

	// start == end: the sweep<1e-6 guard renders a full circle (71 interior
	// points of a 72-step ring).
	full := ArcPoints(nLat, nLon, nLat, nLon, 0, 0, r, true)
	if len(full) != 71 {
		t.Fatalf("full-circle arc len = %d, want 71", len(full))
	}
}
