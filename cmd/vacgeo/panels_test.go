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

func TestCutAxisKeepsTheMapSide(t *testing.T) {
	// An ATT sheet: frame from y 153 to 550, the longitude ticks straddling
	// an internal parallel at 352, the latitude ticks above it. Only the
	// upper part is a map; below it is the aerodrome diagram. The line is
	// held as the outer reach of its marks, since a tick straddling a
	// parallel puts its family anchors a tick length either side of it.
	lines := []tickLine{{lo: 352.2, hi: 357}}
	lo, hi := cutAxis(153, 550, 408, 492, lines, false)
	if math.Abs(lo-352.2) > 0.01 || math.Abs(hi-550) > 0.01 {
		t.Errorf("cut to %.2f..%.2f, want the panel above the parallel", lo, hi)
	}
	// The mirror: latitude ticks below the parallel keep the lower half.
	lo, hi = cutAxis(153, 550, 200, 300, lines, false)
	if math.Abs(lo-153) > 0.01 || math.Abs(hi-357) > 0.01 {
		t.Errorf("cut to %.2f..%.2f, want the panel below the parallel", lo, hi)
	}
}

func TestCutAxisBoundsAFrameThatOvershootsBothWays(t *testing.T) {
	// Le Plessis-Belleville: the frame search returns the whole content
	// box, with the title band above the map and the special-instructions
	// block below it. Cutting on ONE side only leaves whichever half of
	// the furniture the reader happened not to pick, and which half that
	// was came down to a stray mark in the footer.
	lines := []tickLine{{lo: 33.4, hi: 38}, {lo: 240, hi: 245}, {lo: 480, hi: 484.8}}
	lo, hi := cutAxis(2.5, 594, 66, 434, lines, false)
	if math.Abs(lo-33.4) > 0.01 || math.Abs(hi-484.8) > 0.01 {
		t.Errorf("cut to %.2f..%.2f, want the band the graticule spans", lo, hi)
	}
}

func TestCutAxisKeepsASideWhoseGraticuleRanOut(t *testing.T) {
	// Orleans-Bricy prints a graticule this reader reads only near the
	// bottom of the sheet. Ticks beyond the outermost line mean the LINES
	// ran out, not the map, and cutting there halves a continuous chart.
	lo, hi := cutAxis(32, 484, 60, 460, []tickLine{{lo: 31.4, hi: 41.2}}, false)
	if math.Abs(hi-484) > 0.01 || math.Abs(lo-32) > 0.01 {
		t.Errorf("cut to %.2f..%.2f, want the frame left alone", lo, hi)
	}
}

func TestCutAxisAllowsATickPastTheLine(t *testing.T) {
	// A line is the outer REACH of the marks on it, so two marks within a
	// tick length of each other cannot be told apart as inside the
	// neatline or outside it. Chambery draws a mark three points above its
	// own top parallel, and refusing the cut for it kept the whole
	// frequency block on the chart.
	lines := []tickLine{{lo: 33, hi: 38.2}, {lo: 474.2, hi: 478.4}}
	lo, hi := cutAxis(33.68, 515.98, 35.6, 481.5, lines, false)
	if math.Abs(hi-478.4) > 0.01 {
		t.Errorf("cut to %.2f..%.2f, want the title band off", lo, hi)
	}
	// A tick well past the line still holds the side.
	_, hi = cutAxis(33.68, 515.98, 35.6, 500, lines, false)
	if math.Abs(hi-515.98) > 0.01 {
		t.Errorf("cut to %.2f, want the side held", hi)
	}
}

func TestCutAxisWantsBothSidesForTheWidth(t *testing.T) {
	// Nothing on these sheets is divided left from right, so a meridian is
	// either a neatline or an internal graticule line and a lone one is
	// evidence of nothing. Auberive draws a single readable meridian a
	// third of the way across its approach chart, and taking it amputated
	// the map; Bale-Mulhouse lost two thirds of its landing chart the same
	// way when the cut was free to choose a side.
	lone := []tickLine{{lo: 89.5, hi: 91.2}}
	lo, hi := cutAxis(52.8, 404.44, 121.7, 331.9, lone, true)
	if math.Abs(lo-52.8) > 0.01 || math.Abs(hi-404.44) > 0.01 {
		t.Errorf("cut to %.2f..%.2f, want the width kept", lo, hi)
	}
	// Both edges drawn: Chalons-Vatry, whose frame runs to the page trim.
	both := []tickLine{{lo: 49.2, hi: 53.6}, {lo: 397.7, hi: 402.2}}
	lo, hi = cutAxis(0, 402.35, 50.4, 399.8, both, true)
	if math.Abs(lo-49.2) > 0.01 || math.Abs(hi-402.2) > 0.01 {
		t.Errorf("cut to %.2f..%.2f, want the page margin off", lo, hi)
	}
}

func TestCutAxisTakesANeatlineTickForTheEdge(t *testing.T) {
	// A tick is up to tickMax long and its family may be keyed on the FAR
	// end, so a tick hanging off the neatline puts an anchor that far
	// inside the frame. The line is the marks' OUTER reach, so the edge
	// survives instead of losing a tick's length every time.
	lines := []tickLine{{lo: 153, hi: 153 + tickMax - 1}, {lo: 545, hi: 550}}
	lo, hi := cutAxis(153, 550, 200, 500, lines, false)
	if math.Abs(lo-153) > 0.01 || math.Abs(hi-550) > 0.01 {
		t.Errorf("cut to %.2f..%.2f, want the frame edges left alone", lo, hi)
	}
}

func TestRefineTakesTheLongestContiguousRun(t *testing.T) {
	// Etain's approach sheet has a 1.8 pt mark in the page footer landing
	// on the grid five slots below the lowest real tick. The comb's full
	// extent then reaches the page trim, which dragged the frame search
	// down with it and held the cut off; the graticule is a regular
	// series, so a pick reachable only across a gap of missing slots says
	// nothing about how far it reaches.
	picks := []pick{{k: -20, v: 2.7}, {k: -18, v: 35.9}}
	for k := -13; k <= 9; k++ {
		picks = append(picks, pick{k: k, v: 329.8 + float64(k)*16.333})
	}
	f := refine(picks)
	if f == nil {
		t.Fatal("no fit")
	}
	if math.Abs(f.lo-2.7) > 0.01 {
		t.Errorf("full extent starts at %.2f, want the stray included", f.lo)
	}
	if math.Abs(f.coreLo-117.47) > 0.5 || math.Abs(f.coreHi-476.8) > 0.5 {
		t.Errorf("core %.2f..%.2f, want the contiguous run alone", f.coreLo, f.coreHi)
	}
}

func TestTickFamiliesIgnoresTheSidesOfASmallBox(t *testing.T) {
	// The SIA sets its own logo in the page footer as a 13 pt square, well
	// below any map, and its two horizontal sides are exactly as long as a
	// graticule tick and start at exactly the x the left neatline stands
	// at. One of the pair lands on the comb by luck, which stretched the
	// tick extent down into the footer and took the panel with it:
	// Aulnay-sous-Bois and Le Plessis-Belleville both shipped their
	// approach chart with the footer drawn over the countryside.
	logo := box{x0: 50.5, y0: 14.1, x1: 63.9, y1: 27.6}
	c := pageContent{
		media: box{x0: 0, y0: 0, x1: 419, y1: 595},
		rects: []box{logo},
		segs: []seg{
			{logo.x0, logo.y0, logo.x1, logo.y0},
			{logo.x0, logo.y1, logo.x1, logo.y1},
			{50.8, 144.7, 61.3, 144.7},
			{50.8, 202.5, 61.3, 202.5},
			{50.8, 260.2, 61.3, 260.2},
		},
	}
	for _, f := range tickFamilies(c, true) {
		for _, p := range f.pos {
			if p < 100 {
				t.Errorf("the logo box side at y %.1f was offered as a tick", p)
			}
		}
	}
	// A degenerate rectangle is still a tick: a plate is free to draw its
	// graticule as zero-width boxes and some do.
	thin := box{x0: 50.8, y0: 317.9, x1: 50.8, y1: 328.4}
	c.rects = append(c.rects, thin)
	c.segs = append(c.segs,
		seg{thin.x0, thin.y0, thin.x0, thin.y1},
		seg{100.4, thin.y0, 100.4, thin.y1})
	found := false
	for _, f := range tickFamilies(c, false) {
		for _, p := range f.pos {
			if math.Abs(p-50.8) < 0.01 {
				found = true
			}
		}
	}
	if !found {
		t.Error("a tick drawn as a zero-width rectangle was thrown away with the boxes")
	}
}

func TestTickLinesWantHalfTheComb(t *testing.T) {
	// A boundary parallel carries the graticule along its whole length. A
	// handful of marks that happen to land on the grid does not make one,
	// and where the comb is fine (Orleans-Bricy prints a meridian every 14
	// points) three of them are easy to come by.
	fit := &combFit{step: 14, p0: 30, n: 25}
	var edge, clutter tickSet
	edge.anchor = 31.4
	for i := range 20 {
		edge.pos = append(edge.pos, fit.p0+float64(i)*fit.step)
	}
	clutter.anchor = 284.7
	for i := range 3 {
		clutter.pos = append(clutter.pos, fit.p0+float64(i*4)*fit.step)
	}
	lines := tickLines([]tickSet{edge, clutter}, fit)
	if len(lines) != 1 || math.Abs(lines[0].lo-31.4) > 0.01 {
		t.Errorf("lines %v, want the neatline alone", lines)
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

func TestGateTakesARunwayOverTheAerodromeReferencePoint(t *testing.T) {
	// The bounds test answers "is this panel over the right ground?" to
	// within half a panel. A drawn runway lying along its own published
	// centreline answers it to tens of metres, so where one has confirmed
	// the panel, an ARP falling off a tightly cut clip is a fact about
	// the CLIP and not about the ground.
	fit := &panelFit{
		Clip: box{x0: 0, y0: 0, x1: 100, y1: 100},
		Geo:  northUp(0, 48.8, 0.001, 0, 2.5, 0.001),
	}
	off := latLon{lat: 49.9, lon: 2.55}
	if _, ok := gate(fit, off); ok {
		t.Fatal("the fixture is meant to fail the bounds test")
	}
	fit.Anchored, fit.AnchorResidM = true, 12
	if _, ok := gate(fit, off); !ok {
		t.Error("a panel its own runway confirms to 12 m was still refused")
	}
	// Confirmation is not a blanket pass: a runway that does NOT land
	// where it belongs says nothing for the panel.
	fit.AnchorResidM = maxAnchorResidM + 1
	if _, ok := gate(fit, off); ok {
		t.Error("a runway missing by more than the anchor allows was taken as proof")
	}
	// And the projection test still applies.
	fit.AnchorResidM, fit.DevPct = 12, 9
	if _, ok := gate(fit, off); ok {
		t.Error("a runway was allowed to excuse a broken projection")
	}
}
