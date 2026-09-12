package main

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"
)

// TestShippedSimilaritiesStandOnTheEllipsoid reads the COMMITTED dataset
// and asks of every panel a similarity placed, the ground-movement charts
// and the helistation landing sheets, whether its two axes stand in the
// ratio the ellipsoid imposes at a latitude the panel actually covers.
//
// That ratio, metres per degree of latitude over metres per degree of
// longitude, IS axisRatio, the identity the graticule half of this command
// reads off the printed ticks. A similarity is a rotation and a uniform
// SCALE, so the only thing that can make its two axes disagree in degrees
// is the frame it was built in, and that is exactly where this went wrong:
// a SPHERE of 111320 metres to the degree is 0.09 % short of the meridian
// and 0.19 % long of the parallel at French latitudes, so every such panel
// came out 0.3 % out of square, with neither axis at the scale its own
// sheet prints. Nothing downstream would have said so. The panel is still
// square on the page, still contains its aerodrome, and still agrees with
// the runway it was fitted to.
//
// The test reads the artifact rather than the fit, so it covers the emitted
// affine too, which is where the metres are turned back into degrees.
func TestShippedSimilaritiesStandOnTheEllipsoid(t *testing.T) {
	path := filepath.Join("..", "..", "public", "data", "fr-vacgeo.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("no dataset: %v", err)
	}
	var ds struct {
		Fields []string `json:"fields"`
		Rows   [][]any  `json:"rows"`
	}
	if err := json.Unmarshal(raw, &ds); err != nil {
		t.Fatal(err)
	}
	idx := map[string]int{}
	for i, f := range ds.Fields {
		idx[f] = i
	}
	for _, f := range []string{"ident", "page", "sw", "ne", "aff", "quality"} {
		if _, ok := idx[f]; !ok {
			t.Fatalf("dataset has no %q column", f)
		}
	}
	n := 0
	for _, r := range ds.Rows {
		q, _ := r[idx["quality"]].(map[string]any)
		method, _ := q["method"].(string)
		if method != "runway" && method != "helipad" {
			continue
		}
		aff := r[idx["aff"]].([]any)
		a := aff[0].(float64) // d lon / d page x
		b := aff[1].(float64) // d lat / d page x
		c := aff[2].(float64) // d lon / d page y
		d := aff[3].(float64) // d lat / d page y
		south := r[idx["sw"]].([]any)[0].(float64)
		north := r[idx["ne"]].([]any)[0].(float64)
		lonPer := math.Hypot(a, c)
		latPer := math.Hypot(b, d)
		if lonPer <= 0 || latPer <= 0 {
			t.Errorf("%v p%v: degenerate affine", r[idx["ident"]], r[idx["page"]])
			continue
		}
		// A tangent frame is conformal at its own origin and nowhere else,
		// and the origin is a point inside the panel (the aerodrome, or
		// the pad), so the ratio has to land between what the ellipsoid
		// asks at the panel's two edges.
		//
		// The margin is the ninth decimal place the emitted affine is
		// rounded to and nothing else: a tenth of a millimetre per page
		// point, which is nothing on a ground chart and a per mille on a
		// fifty-metre pad detail, where a coefficient is itself only a few
		// millionths of a degree. The sphere's own 0.3 % stands clear of
		// it at either size.
		eps := 1e-9/lonPer + 1e-9/latPer + 2e-5
		lo, hi := axisRatio(south), axisRatio(north)
		got := lonPer / latPer
		if got < lo*(1-eps) || got > hi*(1+eps) {
			t.Errorf("%v p%v (%s): axes stand in %.6f, the ellipsoid asks %.6f..%.6f over %.4f..%.4f (%.3f%% out)",
				r[idx["ident"]], r[idx["page"]], method, got, lo, hi, south, north,
				(got/((lo+hi)/2)-1)*100)
		}
		n++
	}
	if n < 80 {
		t.Errorf("only %d similarity-placed panels checked, want the runway and pad fits", n)
	}
	t.Logf("%d similarity-placed panels, every one on the ellipsoid", n)
}

// TestMetrePerDegIsTheEllipsoid pins the frame every fit is built in
// against the identity the graticule half reads off the printed ticks. The
// two have to be the same ellipsoid or the two halves of this command place
// the same ground differently.
func TestMetrePerDegIsTheEllipsoid(t *testing.T) {
	for _, lat := range []float64{0, 15, 43, 48.8, 51, 66} {
		mLat, mLon := metrePerDeg(lat)
		if got, want := mLat/mLon, axisRatio(lat); math.Abs(got/want-1) > 1e-12 {
			t.Errorf("at %g deg the frame stands in %.6f, the projection in %.6f", lat, got, want)
		}
	}
	// And the values themselves, against the published WGS84 table.
	mLat, mLon := metrePerDeg(45)
	if math.Abs(mLat-111131.75) > 0.5 {
		t.Errorf("metres per degree of latitude at 45 deg = %.2f, want about 111131.75", mLat)
	}
	if math.Abs(mLon-78846.81) > 0.5 {
		t.Errorf("metres per degree of longitude at 45 deg = %.2f, want about 78846.81", mLon)
	}
}
