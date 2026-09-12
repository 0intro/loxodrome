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
		// A run carries its advance as a VECTOR, and a fixture that leaves
		// it zero is not upright text, it is a run with no direction at
		// all: every reader that walks a glyph's own frame then reads a
		// degenerate box and finds nothing, silently.
		if s.ax == 0 && s.ay == 0 {
			s.ax = s.adv
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

func TestParseLabelsPrefersTheWholeLabelOverItsFragment(t *testing.T) {
	// The plates draw each label twice, stroke then fill, and the two
	// passes do not always break the string the same way: Compiegne emits
	// the minutes both as one run "26'" and, at the same point, as "2"
	// followed by "6'". dedupeRuns cannot see it, since it matches on the
	// text as well as the place, and taking the first in stream order made
	// the label 49 02' 30" instead of 49 26' 30". Three of its four
	// parallels came out that way and pickAxis threw the family out as off
	// its own line; the coverage doc wrote them up as numbers belonging to
	// no grid.
	got := parseLabels(mkRuns(
		textRun{x: 53.57, y: 370.30, text: "49\u00b0"},
		textRun{x: 53.57, y: 361.94, text: "2"},
		textRun{x: 56.74, y: 361.94, text: "6'"},
		textRun{x: 53.57, y: 361.94, text: "26'"},
		textRun{x: 53.57, y: 354.97, text: "30\""},
	))
	if len(got) != 1 {
		t.Fatalf("got %d labels, want 1: %+v", len(got), got)
	}
	if want := 49*60 + 26 + 30.0/60; math.Abs(got[0].min-want) > 1e-9 {
		t.Errorf("read %.4f arcminutes, want %.4f (the fragment won)", got[0].min, want)
	}
	// And the rule is a PREFIX rule, not a longest-run rule: two different
	// numbers at one place are two different marks, and choosing between
	// them on length put LF330 sixty-nine kilometres out.
	got = parseLabels(mkRuns(
		textRun{x: 53.57, y: 370.30, text: "48\u00b0"},
		textRun{x: 53.57, y: 361.94, text: "2"},
		textRun{x: 53.57, y: 361.94, text: "47"},
	))
	if len(got) != 1 || math.Abs(got[0].min-(48*60+2)) > 1e-9 {
		t.Errorf("a different number at the same point overrode the label: %+v", got)
	}
}

func TestParseLabelsWantsAMarkAndNotALetterUnderTheDegrees(t *testing.T) {
	// Lesparre prints its seconds as their own run. Letting one head a
	// label collected whatever number sat below it, and "36 A" qualified as
	// the minutes because the separator was any non-digit at all: the
	// result was a label reading 1836 arcminutes, monotone with its
	// neighbours and so invisible to every guard downstream.
	got := parseLabels(mkRuns(
		textRun{x: 40, y: 300, text: "30\""},
		textRun{x: 40, y: 292, text: "36 A"},
	))
	if len(got) != 0 {
		t.Errorf("a seconds run headed a label: %+v", got)
	}
	// The mark itself stays unpinned: a quotesingle on some plates and a
	// U+2019 on others, which is what the supaip prime-mark bug taught.
	got = parseLabels(mkRuns(
		textRun{x: 40, y: 300, text: "48\u00b0"},
		textRun{x: 40, y: 292, text: "53\u2019"},
	))
	if len(got) != 1 || math.Abs(got[0].min-(48*60+53)) > 1e-9 {
		t.Errorf("a U+2019 prime was rejected: %+v", got)
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

func TestPickAxisShedsOneStrayLabel(t *testing.T) {
	// LFPT's landing chart, down its left edge: six parallels in order and
	// a seventh label that belongs to no axis at all, printed in the
	// header band above the neatline and invisible on the sheet.
	edge := []label{
		{x: 22.9, y: 142.9, min: 2943},
		{x: 22.9, y: 211.8, min: 2944},
		{x: 22.9, y: 281.0, min: 2945},
		{x: 22.9, y: 349.2, min: 2946},
		{x: 22.9, y: 418.4, min: 2947},
		{x: 22.9, y: 487.2, min: 2948},
		{x: 22.9, y: 549.1, min: 2943},
	}
	got := pickAxis(edge, false)
	if len(got) != 6 {
		t.Fatalf("got %d labels, want the 6 real ones: %v", len(got), got)
	}
	for i, l := range got {
		if want := float64(2943 + i); l.min != want {
			t.Errorf("label %d is %.0f, want %.0f", i, l.min, want)
		}
	}
	// Only where dropping one is the ONE reading that works: 1 3 2 4 can
	// be read two ways, so it is read neither way.
	either := []label{
		{x: 22.9, y: 100, min: 2941},
		{x: 22.9, y: 200, min: 2943},
		{x: 22.9, y: 300, min: 2942},
		{x: 22.9, y: 400, min: 2944},
	}
	if got := pickAxis(either, false); len(got) != 0 {
		t.Errorf("an ambiguous family was read anyway: %v", got)
	}
	// Three labels and a stray leaves a pair, which fixes a scale between
	// them with nothing left to say which of the three was the intruder.
	short := []label{
		{x: 22.9, y: 100, min: 2941},
		{x: 22.9, y: 200, min: 2942},
		{x: 22.9, y: 300, min: 2937},
	}
	if got := pickAxis(short, false); len(got) != 0 {
		t.Errorf("a family too short to survive a drop was rescued: %v", got)
	}
	// And what survives has to look like a graticule. LFAD's landing chart
	// and LFAK's keep three numbers that ascend down the edge and stand 91
	// and 81 points off the line they themselves draw: an arcminute is one
	// distance on a panel, so these belong to no grid. Both fitted, and
	// both were then left to the ARP gate, which resolves a panel to about
	// half its own width.
	crooked := []label{
		{x: 22.9, y: 50, min: 2942},
		{x: 22.9, y: 100, min: 2940},
		{x: 22.9, y: 120, min: 2941},
		{x: 22.9, y: 400, min: 2943},
	}
	if got := pickAxis(crooked, false); len(got) != 0 {
		t.Errorf("three numbers in order were read as an axis: %v", got)
	}
	// The same family with its middle label where the axis says it goes is
	// a graticule, and is kept.
	straight := []label{
		{x: 22.9, y: 50, min: 2942},
		{x: 22.9, y: 100, min: 2940},
		{x: 22.9, y: 200, min: 2941},
		{x: 22.9, y: 400, min: 2943},
	}
	if got := pickAxis(straight, false); len(got) != 3 {
		t.Errorf("got %d labels, want the 3 on the line: %v", len(got), got)
	}
	// An intruder that happens to run in ORDER with the family it lands
	// in. Villeneuve d'Ascq's approach sheet labels its meridians 003 00
	// and 003 05 on one baseline and prints a bearing three points below
	// it that parses as 109 00; all three ascend together, so the
	// monotonicity that used to be the only whole-family test passes, and
	// the trio reads 0.03 points to the arcminute. The scale band is what
	// says which pair is a grid.
	ordered := []label{
		{x: 84.61, y: 114.30, min: 180, lon: true},
		{x: 249.74, y: 114.30, min: 185, lon: true},
		{x: 295.48, y: 118.06, min: 6540, lon: true},
	}
	got = pickAxis(ordered, true)
	if len(got) != 2 || got[0].min != 180 || got[1].min != 185 {
		t.Errorf("got %v, want the two meridians without the bearing", got)
	}
	// And a rescue may leave a PAIR. Val Thorens labels its meridians
	// 006 33 and 006 35 on one baseline with a bearing BETWEEN them that
	// parses as 003 34, so the trio does not even run in order; the three
	// candidate pairs read 92.2, 0.51 and 0.51 points to the arcminute,
	// and the scale band is the whole answer.
	between := []label{
		{x: 130.27, y: 109.25, min: 393, lon: true},
		{x: 222.38, y: 109.25, min: 214, lon: true},
		{x: 314.59, y: 109.25, min: 395, lon: true},
	}
	got = pickAxis(between, true)
	if len(got) != 2 || got[0].min != 393 || got[1].min != 395 {
		t.Errorf("got %v, want the two meridians without the bearing between them", got)
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

func TestNeatlineTakesTheWindowAKnockoutLeft(t *testing.T) {
	// Sainte-Leocadie's approach sheet draws its neatline turned a fifth
	// of a degree, so it is neither an `re` rectangle nor a set of
	// axis-aligned strokes, and the only rectangle on the page the search
	// can see is the page-sized clip. What the plate does state squarely is
	// the white it paints around the panel, and the hole in it is the
	// frame.
	ticks := box{x0: 58.8, y0: 53.7, x1: 393.9, y1: 481.4}
	page := box{x0: 0, y0: 2.5, x1: 417.5, y1: 595}
	c := pageContent{
		media: box{x0: 0, y0: 0, x1: 419.5, y1: 595.3},
		rects: []box{page},
		masks: []box{{x0: 50.2, y0: 33, x1: 404.4, y1: 485.6}},
	}
	got := neatline(c, ticks)
	if got == nil || *got != c.masks[0] {
		t.Errorf("neatline %v, want the knockout's own window %v", got, c.masks[0])
	}
	// And it is a candidate, not an override: a rectangle drawn in ink
	// that holds the graticule more tightly is still the better frame.
	tighter := box{x0: 52, y0: 34, x1: 403, y1: 484}
	c.rects = append(c.rects, tighter)
	if got := neatline(c, ticks); got == nil || *got != tighter {
		t.Errorf("neatline %v, want the tighter drawn rectangle %v", got, tighter)
	}
}

func TestRephaseTakesThePhaseTheLabelsName(t *testing.T) {
	// Creteil's approach sheet: a ten-second graticule labelled every
	// thirty. The comb comes out at thirty seconds with a residual of
	// zero, on whichever of the three phases caught the most marks, and
	// between those the ticks have nothing to say. The labels do.
	const step = 105.24
	var marks []float64
	for i := range 10 {
		marks = append(marks, 149.6+float64(i)*step/3)
	}
	// The comb as fitted: every third mark from 149.6, which is one
	// ten-second tick off the phase the labels name.
	comb := &combFit{step: step, p0: 254.85, n: 4, lo: 149.6, hi: 465.3, coreLo: 149.6, coreHi: 465.3}
	// The labels, each a few points below its own tick (they are stacked
	// three lines deep and anchored in the middle).
	labels := []float64{213.5, 322.5, 424.0}
	got := rephase(comb, marks, labels)
	if got == nil {
		t.Fatal("no comb")
	}
	if math.Abs(got.step-step) > 1e-9 {
		t.Errorf("step %.3f, want %.3f: a phase correction may not rewrite the scale", got.step, step)
	}
	if off := math.Abs(math.Mod(got.p0-219.8, step)); off > 1 && math.Abs(off-step) > 1 {
		t.Errorf("p0 %.2f, want the phase through 219.8", got.p0)
	}

	// An anchor is not a phase. The same sheet with no finer graticule
	// keeps the comb it was given, however far its labels sit from it.
	var coarse []float64
	for i := range 4 {
		coarse = append(coarse, 254.85+float64(i-1)*step)
	}
	if got := rephase(comb, coarse, labels); got != comb {
		t.Errorf("p0 %.2f: with nothing drawn at the shifted phase there is nowhere to move", got.p0)
	}

	// And a shift no bigger than the wander that suggests it is not
	// evidence: Auxerre's sixth of a twenty-one point comb is three and
	// a half points.
	small := &combFit{step: 21.26, p0: 69.94, n: 16}
	var fine []float64
	for i := range 20 {
		fine = append(fine, 66.24+float64(i)*21.26/6)
	}
	if got := rephase(small, fine, []float64{110.4, 195.5, 280.7}); got != small {
		t.Errorf("p0 %.2f, want the comb left alone: the shift is label wander", got.p0)
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

func TestGateRefusesAMirroredPanel(t *testing.T) {
	// LFBT sits on the prime meridian and its approach sheet is labelled
	// 10' 0' 10' 20' from left to right. Nothing on the plate says the
	// first of those is west, so read with the aerodrome's own hemisphere
	// throughout the sheet fits perfectly backwards, 31 ticks at 0.08 pt,
	// with the ARP still on the panel: only the direction is wrong.
	mirrored := &panelFit{
		Clip: box{x0: 0, y0: 0, x1: 100, y1: 100},
		Geo:  northUp(0, 48.8, 0.001, 0, 2.55, -0.001),
	}
	if _, ok := gate(mirrored, latLon{lat: 48.85, lon: 2.5}); ok {
		t.Error("a sheet reading east to west was published")
	}
	flipped := &panelFit{
		Clip: box{x0: 0, y0: 0, x1: 100, y1: 100},
		Geo:  northUp(0, 48.85, -0.001, 0, 2.5, 0.001),
	}
	if _, ok := gate(flipped, latLon{lat: 48.8, lon: 2.55}); ok {
		t.Error("a sheet reading north to south was published")
	}
	// A ground chart is placed from its runway and may be turned a long
	// way round (LFPL's by about 75 degrees). A rotation is not a mirror
	// and must still pass.
	const rot = 75 * math.Pi / 180
	turned := &panelFit{
		Clip: box{x0: 0, y0: 0, x1: 100, y1: 100},
		Geo: geoAffine{
			A: 0.001 * math.Cos(rot), C: -0.001 * math.Sin(rot),
			B: 0.001 * math.Sin(rot), D: 0.001 * math.Cos(rot),
			E: 2.5, F: 48.8,
		},
	}
	if _, ok := gate(turned, latLon{lat: 48.83, lon: 2.53}); !ok {
		t.Error("a rotated panel was taken for a mirrored one")
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

func TestGatePublishesASheetItsOwnLabelsSayIsOutOfSquare(t *testing.T) {
	// The projection is a prior and a strong one, so a fit that disagrees
	// with it is refused: five times out of six that is a comb read off
	// the wrong marks. Saint-Cyr's landing sheet is the sixth. It draws
	// 104.3 points to the minute of latitude against 63.4 to the minute of
	// longitude, its own printed labels say so, and the panel is 8 per
	// cent out of square in fact rather than in error.
	fit := &panelFit{
		Clip:   box{x0: 0, y0: 0, x1: 100, y1: 100},
		Geo:    northUp(0, 48.8, 0.001, 0, 2.5, 0.001),
		DevPct: 8.5, LatN: 4, LonN: 7,
	}
	arp := latLon{lat: 48.85, lon: 2.55}
	if _, ok := gate(fit, arp); ok {
		t.Error("a fit 8.5% off the projection was published with nothing to excuse it")
	}
	fit.Axes = "stretched"
	if _, ok := gate(fit, arp); !ok {
		t.Error("a sheet its own labels say is out of square was still refused")
	}
	// The exception is for two real combs. A derived axis can come back as
	// a two-pick phase fit, which is no evidence about anything.
	thin := *fit
	thin.LatN = 2
	if _, ok := gate(&thin, arp); ok {
		t.Error("a two-tick axis was allowed to overrule the projection")
	}
}

func TestLabelsOverruleTheProjectionOnlyWhenTheyPayForIt(t *testing.T) {
	// Saint-Cyr: the re-fit built the latitude axis at 96.1 points to the
	// minute where the labels span 104.3, contradicting them by 7.9 per
	// cent, and the correction it made was worth 8.5. The two agree, so
	// the ticks and the labels of that axis are on the same side and the
	// projection is the only dissenter.
	if !labelsOverrule(96.1, 104.3, 0.085) {
		t.Error("an axis contradicting its own labels by what the correction was worth stood")
	}
	// The ordinary case: the correction moved the axis TOWARDS its labels,
	// which is what the constraint is for.
	if labelsOverrule(104.2, 104.3, 0.085) {
		t.Error("a re-fit that landed on its own labels was taken for a stretched sheet")
	}
	// Drafting tolerance is not a stretched sheet.
	if labelsOverrule(104.3*1.02, 104.3, 0.02) {
		t.Error("a two percent disagreement was published out of square")
	}
	// A contradiction the correction cannot account for is a misread comb
	// somewhere, and the projection stays the better guess.
	if labelsOverrule(80, 104.3, 0.05) {
		t.Error("a contradiction four times the correction was taken as evidence")
	}
	// An axis named once fixes an offset and never a scale.
	// The LF330 case, and the reason there is a ceiling at all: a plate
	// whose labels come apart reads 94 per cent out and AGREES with its
	// own displaced comb perfectly, so the agreement test alone would
	// publish it. A minute of latitude is longer than a minute of
	// longitude everywhere in France; a quarter off is not a drafting
	// decision.
	if labelsOverrule(6, 104.3, -0.94) {
		t.Error("a plate misread the same way on both readings was published out of square")
	}
	if labelsOverrule(96.1, 0, 0.085) {
		t.Error("an axis with no label span of its own overruled the projection")
	}
}
