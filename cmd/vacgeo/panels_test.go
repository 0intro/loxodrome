package main

import (
	"math"
	"testing"
)

// mkRuns builds show runs at a nominal size, the shape parseLabels sees.
func mkRuns(specs ...textRun) []textRun {
	out := make([]textRun, 0, len(specs))
	for _, s := range specs {
		if s.size == 0 {
			s.size = 7
		}
		if s.adv == 0 {
			s.adv = float64(len(s.text)) * 3
		}
		out = append(out, s)
	}
	return out
}

func TestParseLabelsPrintedForms(t *testing.T) {
	// The four forms the corpus prints, each named for a plate that shows
	// it. Values are arcminutes.
	cases := []struct {
		name string
		runs []textRun
		want []label
	}{
		{
			// LFPL: degrees and minutes in one run, along the bottom edge.
			name: "one run",
			runs: mkRuns(textRun{x: 100, y: 40, text: "002°  40'", adv: 22}),
			want: []label{{x: 111, y: 40, min: 160, lon: true}},
		},
		{
			// LFPL: stacked down the left edge, with the prime.
			name: "stacked",
			runs: mkRuns(textRun{x: 50, y: 400, text: "48°", adv: 9}, textRun{x: 50, y: 391, text: "53'", adv: 8}),
			want: []label{{x: 54.5, y: 395.5, min: 2933}},
		},
		{
			// LFAT: the same, with NO prime mark at all.
			name: "stacked without a prime",
			runs: mkRuns(textRun{x: 52, y: 300, text: "50°", adv: 9}, textRun{x: 52, y: 291, text: "40", adv: 8}),
			want: []label{{x: 56.5, y: 295.5, min: 3040}},
		},
		{
			// AD-3.LF019: degrees, minutes and seconds stacked.
			name: "stacked DMS",
			runs: mkRuns(
				textRun{x: 17, y: 475, text: "43°", adv: 9},
				textRun{x: 17, y: 467, text: "55'", adv: 8},
				textRun{x: 17, y: 459, text: "20\"", adv: 8}),
			want: []label{{x: 21.5, y: 467, min: 43*60 + 55 + 20.0/60}},
		},
		{
			// AD-3.LF019: minutes in the run, seconds abutting it.
			name: "seconds beside",
			runs: mkRuns(
				textRun{x: 20, y: 261, text: "004° 47'", adv: 21},
				textRun{x: 41, y: 261, text: " 30\"", adv: 10}),
			want: []label{{x: 30.5, y: 261, min: 4*60 + 47 + 0.5, lon: true}},
		},
	}
	for _, c := range cases {
		got := parseLabels(c.runs)
		if len(got) != len(c.want) {
			t.Errorf("%s: got %d labels, want %d (%v)", c.name, len(got), len(c.want), got)
			continue
		}
		for i := range got {
			w := c.want[i]
			if math.Abs(got[i].min-w.min) > 1e-6 || got[i].lon != w.lon {
				t.Errorf("%s: got %+v, want %+v", c.name, got[i], w)
			}
			if math.Abs(got[i].x-w.x) > 0.51 || math.Abs(got[i].y-w.y) > 0.51 {
				t.Errorf("%s: anchor (%.2f,%.2f), want (%.2f,%.2f)", c.name, got[i].x, got[i].y, w.x, w.y)
			}
		}
	}
}

func TestParseLabelsRejectsBearings(t *testing.T) {
	// Every one of these parses as a plausible coordinate on its own; the
	// corpus is full of them and none is a graticule label.
	runs := mkRuns(
		textRun{x: 100, y: 200, text: "051° 10 NM"},
		textRun{x: 150, y: 250, text: "264° 12 NM CLM"},
		textRun{x: 200, y: 300, text: "343° 2.3 NM"},
	)
	if got := parseLabels(runs); len(got) != 0 {
		t.Errorf("bearings parsed as labels: %v", got)
	}
}

func TestPickAxisNeedsALine(t *testing.T) {
	// Three collinear, monotone longitude labels plus two scattered
	// bearing-shaped ones: only the line survives.
	labels := []label{
		{x: 60, y: 40, min: 155, lon: true},
		{x: 115, y: 40, min: 156, lon: true},
		{x: 170, y: 40, min: 157, lon: true},
		{x: 220, y: 300, min: 133, lon: true},
		{x: 90, y: 180, min: 306, lon: true},
	}
	if got := pickAxis(labels, true); len(got) != 3 {
		t.Errorf("got %d labels, want the 3 on the line: %v", len(got), got)
	}
	// A lone candidate is kept: one label fixes an offset and the
	// projection supplies the scale (LFDF names 44°51' once).
	if got := pickAxis([]label{{x: 60, y: 200, min: 2691}}, false); len(got) != 1 {
		t.Errorf("a single latitude label should stand, got %d", len(got))
	}
	// Two candidates that do not line up are not a graticule.
	two := []label{{x: 60, y: 200, min: 2691}, {x: 300, y: 90, min: 2755}}
	if got := pickAxis(two, false); len(got) != 0 {
		t.Errorf("scattered candidates accepted: %v", got)
	}
}

func TestFitCombFindsTheGraticule(t *testing.T) {
	// A comb of 9 ticks 51.6 pt apart, with map furniture mixed in.
	var cands []float64
	for i := 0; i < 9; i++ {
		cands = append(cands, 33.0+float64(i)*51.6)
	}
	cands = append(cands, 41.2, 118.9, 260.3, 402.7)
	f := fitComb(cands, 51.0)
	if f == nil {
		t.Fatal("no comb")
	}
	if math.Abs(f.step-51.6) > 0.05 || f.n < 9 {
		t.Errorf("step %.3f n %d, want 51.6 over 9 ticks", f.step, f.n)
	}
	if f.rms > 0.01 {
		t.Errorf("rms %.4f, want a clean fit", f.rms)
	}
	// A comb at half the seed is a legitimate 30-second graticule.
	var half []float64
	for i := 0; i < 12; i++ {
		half = append(half, 20.0+float64(i)*27.5)
	}
	if f := fitComb(half, 55.0); f == nil || math.Abs(f.step-27.5) > 0.05 {
		t.Errorf("half-step comb: %v", f)
	}
}

func TestAxisRatioIsConformalOnTheEllipsoid(t *testing.T) {
	// The measured ratio on AD-2.LFPL's approach sheet is 51.36 pt to the
	// arcminute of latitude against 33.95 of longitude, at 48.84 N.
	want := axisRatio(48.84)
	got := 51.36 / 33.95
	if math.Abs(got/want-1) > 0.005 {
		t.Errorf("LFPL axis ratio %.5f, model %.5f (%.2f%% apart)", got, want, (got/want-1)*100)
	}
	// The ellipsoid term is what that half-percent is: sec(phi) alone is
	// not close enough to be a gate.
	sec := 1 / math.Cos(48.84*math.Pi/180)
	if math.Abs(want/sec-0.9971) > 0.0005 {
		t.Errorf("M/N term %.5f, want ~0.9971", want/sec)
	}
}

func TestAssignFromOneLabelNeedsAScale(t *testing.T) {
	f := &combFit{step: 51.6, p0: 33, n: 9}
	one := []label{{y: 33 + 5*51.6, min: 2933}}
	if a := assign(f, one, false, 0); a != nil {
		t.Error("one label assigned with no scale supplied")
	}
	a := assign(f, one, false, 51.6)
	if a == nil {
		t.Fatal("one label with a known scale should assign")
	}
	if math.Abs(a.perTick-1) > 1e-9 || math.Abs(a.at0-2928) > 1e-6 {
		t.Errorf("perTick %.4f at0 %.4f, want 1 and 2928", a.perTick, a.at0)
	}
}

func TestCutPanelKeepsTheMapSide(t *testing.T) {
	// An ATT sheet: frame from y 153 to 550, the longitude ticks sitting
	// on an internal parallel at 352, the latitude ticks above it. Only
	// the upper part is a map; below it is the aerodrome diagram.
	frame := box{x0: 14, y0: 153, x1: 367, y1: 550}
	lat := &combFit{lo: 408, hi: 492}
	lon := &combFit{lo: 33, hi: 337}
	got := cutPanel(frame, lat, lon, 14.7, 352.2)
	if math.Abs(got.y0-352.2) > 0.01 || math.Abs(got.y1-550) > 0.01 {
		t.Errorf("cut to %v, want the panel above the parallel", got)
	}
	// The mirror: ticks below the parallel keep the lower half.
	lat = &combFit{lo: 200, hi: 300}
	got = cutPanel(frame, lat, lon, 14.7, 352.2)
	if math.Abs(got.y1-352.2) > 0.01 {
		t.Errorf("cut to %v, want the panel below the parallel", got)
	}
}

func TestGateRefusesAPanelThatMissesItsAerodrome(t *testing.T) {
	fit := &panelFit{
		Clip: box{x0: 0, y0: 0, x1: 100, y1: 100},
		Geo:  northUp(0, 48.8, 0.001, 0, 2.5, 0.001),
	}
	if _, ok := gate(fit, latLon{lat: 48.85, lon: 2.55}); !ok {
		t.Error("an ARP inside the panel was refused")
	}
	if _, ok := gate(fit, latLon{lat: 49.9, lon: 2.55}); ok {
		t.Error("an ARP a degree away was accepted")
	}
	// A fit that breaks the projection is refused whatever the ARP says.
	bad := *fit
	bad.DevPct = 9
	if _, ok := gate(&bad, latLon{lat: 48.85, lon: 2.55}); ok {
		t.Error("a fit 9% off the conformal model was accepted")
	}
}
