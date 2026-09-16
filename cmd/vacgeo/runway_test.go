package main

import (
	"math"
	"testing"
)

// LFPL, as the 2026-08-06 export files it: runway 08/26, 700 m by 20 m,
// running about 080 true.
var lfplRunway = runwayRef{
	le: "08", he: "26",
	lePos:  latLon{lat: 48.82059, lon: 2.62133},
	hePos:  latLon{lat: 48.8215, lon: 2.63074},
	widthM: 20,
}

func TestRunwayRefGeometry(t *testing.T) {
	if got := lfplRunway.lengthM(); math.Abs(got-700) > 25 {
		t.Errorf("length %.0f m, want about 700", got)
	}
	if got := lfplRunway.aspect(); math.Abs(got-35) > 2 {
		t.Errorf("aspect %.1f, want about 35", got)
	}
}

func TestFitSimilarityRecoversARotation(t *testing.T) {
	// A quarter turn, doubled, shifted: the transform a rotated
	// ground-movement chart needs.
	page := [][2]float64{{0, 0}, {10, 0}, {0, 5}}
	var metric [][2]float64
	for _, p := range page {
		metric = append(metric, [2]float64{-2*p[1] + 100, 2*p[0] - 50})
	}
	s := fitSimilarity(page, metric)
	if s == nil {
		t.Fatal("no fit")
	}
	if math.Abs(s.scale()-2) > 1e-9 {
		t.Errorf("scale %.6f, want 2", s.scale())
	}
	if s.resid > 1e-9 {
		t.Errorf("residual %.6f on an exact case", s.resid)
	}
	x, y := s.apply(10, 5)
	if math.Abs(x-90) > 1e-9 || math.Abs(y+30) > 1e-9 {
		t.Errorf("apply(10,5) = (%.6f, %.6f), want (90, -30)", x, y)
	}
	// Two points fix it exactly, which is why the residual cannot be the
	// gate for a single-runway sheet.
	if s := fitSimilarity(page[:2], metric[:2]); s == nil || s.resid > 1e-9 {
		t.Errorf("a two-point fit should be exact: %v", s)
	}
	if fitSimilarity(page[:1], metric[:1]) != nil {
		t.Error("one point is not a similarity")
	}
	// Coincident points are degenerate, not a transform.
	if fitSimilarity([][2]float64{{1, 1}, {1, 1}}, [][2]float64{{0, 0}, {5, 5}}) != nil {
		t.Error("coincident page points accepted")
	}
}

func TestOrientNeedsBothDesignatorsBesideTheirOwnEnd(t *testing.T) {
	q := quad{a: [2]float64{297.6, 163.7}, b: [2]float64{297.3, 426.7}, length: 263, width: 8.1}
	// LFPL's ground-movement chart: 08 printed at the low end, 26 at the
	// high one, which is the only thing that says the sheet is not upside
	// down.
	runs := []textRun{
		{x: 289.5, y: 153.9, text: "08"},
		{x: 297.2, y: 436.8, text: "26"},
	}
	le, he, ok := orient(runs, q, lfplRunway)
	if !ok {
		t.Fatal("not oriented")
	}
	if le != q.a || he != q.b {
		t.Errorf("oriented %v/%v, want a/b", le, he)
	}
	// Swap the labels and the answer swaps with them.
	swapped := []textRun{
		{x: 289.5, y: 153.9, text: "26"},
		{x: 297.2, y: 436.8, text: "08"},
	}
	le, he, ok = orient(swapped, q, lfplRunway)
	if !ok || le != q.b || he != q.a {
		t.Errorf("swapped labels gave %v/%v ok=%v", le, he, ok)
	}
	// One designator missing: refuse rather than guess. A diagram placed
	// backwards is the failure the whole method has to avoid.
	if _, _, ok := orient(runs[:1], q, lfplRunway); ok {
		t.Error("oriented from one designator")
	}
	// Both printed but far from their ends (a legend, a table) is not
	// evidence about which end is which.
	far := []textRun{{x: 40, y: 300, text: "08"}, {x: 45, y: 300, text: "26"}}
	if _, _, ok := orient(far, q, lfplRunway); ok {
		t.Error("oriented from labels nowhere near the runway")
	}
}

// wholePage is a box no run can fall outside, for the cases that are not
// about which panel a bar belongs to.
var wholePage = box{x0: -1e6, y0: -1e6, x1: 1e6, y1: 1e6}

func TestScaleBarPtPerM(t *testing.T) {
	// "0 ......... 300 m" on one baseline: the sheet's own statement of
	// its scale, and the one measurement that owes the runway fit nothing.
	runs := []textRun{
		{x: 76.6, y: 49, adv: 4, text: "0"},
		{x: 182.9, y: 49, adv: 16, text: "300 m"},
		{x: 200, y: 400, adv: 10, text: "1200"},
	}
	got, ok := scaleBarPtPerM(pageContent{}, runs, wholePage)
	if !ok {
		t.Fatal("no scale bar")
	}
	if math.Abs(got-0.3743) > 0.01 {
		t.Errorf("scale %.4f pt/m, want about 0.374", got)
	}
	// Kilometres and nautical miles read too.
	km, ok := scaleBarPtPerM(pageContent{}, []textRun{
		{x: 98, y: 60, adv: 4, text: "0"},
		{x: 193, y: 60, adv: 14, text: "1 km"},
	}, wholePage)
	if !ok || math.Abs(km-0.1) > 0.005 {
		t.Errorf("km bar = %.4f, want 0.1", km)
	}
	// A sheet with no bar says so rather than inventing one.
	if _, ok := scaleBarPtPerM(pageContent{}, []textRun{{x: 10, y: 10, text: "hello"}}, wholePage); ok {
		t.Error("a scale bar was invented")
	}
	// The LONGEST bar wins, not the steepest. Comparing a distance
	// against a ratio kept the largest points-per-metre instead, so every
	// misread biased the bar upwards and the deviation it feeds negative.
	longest, ok := scaleBarPtPerM(pageContent{}, []textRun{
		{x: 100, y: 40, adv: 4, text: "0"},
		{x: 130, y: 40, adv: 14, text: "20 m"},
		{x: 400, y: 40, adv: 16, text: "500 m"},
	}, wholePage)
	if !ok || math.Abs(longest-0.6) > 0.02 {
		t.Errorf("bar = %.3f pt/m, want the 300 pt span over 500 m (0.6)", longest)
	}

	// A bar belongs to the panel it annotates. A composite sheet carries
	// the map's bar and the aerodrome diagram's, drawn to quite different
	// scales, and reading the wrong one is not a small error.
	panel := box{x0: 0, y0: 0, x1: 300, y1: 300}
	near, ok := scaleBarPtPerM(pageContent{}, []textRun{
		{x: 40, y: 60, adv: 4, text: "0"},
		{x: 140, y: 60, adv: 16, text: "500 m"},
		{x: 40, y: 500, adv: 4, text: "0"},
		{x: 340, y: 500, adv: 14, text: "50 m"},
	}, panel)
	// 0.212, not 0.2: a mark is the centre of its whole run, unit and all.
	if !ok || math.Abs(near-0.212) > 0.005 {
		t.Errorf("bar = %.3f pt/m, want the panel's own (0.212), not the diagram's", near)
	}

	// WHERE THE BAR IS DRAWN, the ink is the measurement. The far label
	// carries its unit, so its centre stands right of the end it names and
	// the label span reads long: here by six points in a hundred.
	ink := pageContent{segs: []seg{
		{76.6, 44, 176.6, 44}, // the rule, 100 pt for 300 m
		{76.6, 44, 76.6, 47},  // and its two end ticks
		{176.6, 44, 176.6, 47},
	}}
	drawn, ok := scaleBarPtPerM(ink, runs, wholePage)
	if !ok {
		t.Fatal("no scale bar")
	}
	if math.Abs(drawn-100.0/300) > 0.002 {
		t.Errorf("scale %.4f pt/m, want the ink's %.4f", drawn, 100.0/300)
	}
	// A rule that is not the bar's, standing somewhere else entirely,
	// leaves the labels to answer.
	elsewhere := pageContent{segs: []seg{{300, 44, 400, 44}}}
	if got, ok := scaleBarPtPerM(elsewhere, runs, wholePage); !ok || math.Abs(got-0.3743) > 0.01 {
		t.Errorf("scale %.4f pt/m, want the label span where no rule stands at it", got)
	}

	// A pair on different baselines is not a scale bar.
	if _, ok := scaleBarPtPerM(pageContent{}, []textRun{
		{x: 78, y: 49, adv: 4, text: "0"},
		{x: 175, y: 300, adv: 16, text: "300 m"},
	}, wholePage); ok {
		t.Error("two unrelated labels read as a scale bar")
	}
}

func TestRunwayQuadsKeepsOnlyLongThinShapes(t *testing.T) {
	long := poly{filled: true, pts: []float64{
		290, 160, 305, 160, 305, 430, 290, 430, 290, 160,
	}}
	square := poly{filled: true, pts: []float64{100, 100, 160, 100, 160, 160, 100, 160, 100, 100}}
	tiny := poly{filled: true, pts: []float64{10, 10, 12, 10, 12, 30, 10, 30, 10, 10}}
	got := runwayQuads(pageContent{polys: []poly{square, long, tiny}})
	if len(got) != 1 {
		t.Fatalf("kept %d shapes, want the long thin one only: %v", len(got), got)
	}
	if math.Abs(got[0].length-270) > 1 || math.Abs(got[0].width-15) > 1 {
		t.Errorf("measured %.1f x %.1f, want 270 x 15", got[0].length, got[0].width)
	}
}

// A strip with a notch at a threshold, a step at a displaced one or a stub
// where a taxiway meets it has a short edge that says nothing about how
// wide it is. The width is how far the outline reaches ACROSS its own long
// axis.
func TestRunwayQuadWidthIsMeasuredAcrossTheLongAxis(t *testing.T) {
	// 270 long, 60 wide, with a 3 pt step cut out of one corner.
	notched := poly{filled: true, pts: []float64{
		100, 100, 160, 100, 160, 367, 157, 367, 157, 370, 100, 370, 100, 100,
	}}
	got := runwayQuads(pageContent{polys: []poly{notched}})
	if len(got) != 0 {
		t.Errorf("a 270 x 60 strip read as %.1f x %.1f (aspect %.1f); "+
			"its 3 pt step is not its width", got[0].length, got[0].width, got[0].aspect())
	}
	// A hairline is not a runway either, however long: its own shortest
	// edge is a hairline, so the old measure made every centreline a
	// candidate.
	hair := poly{filled: true, pts: []float64{
		100, 100, 100.2, 100, 100.2, 400, 100, 400, 100, 100,
	}}
	if got := runwayQuads(pageContent{polys: []poly{hair}}); len(got) != 1 {
		t.Errorf("a 0.2 pt hairline: kept %d, want 1 (it IS long and thin)", len(got))
	}
}

func TestFitRunwayPlacesLFPLGroundChart(t *testing.T) {
	// The ground-movement sheet as LFPL draws it: the runway up the page,
	// its designators beside their own ends, a 300 m scale bar, and a
	// frame. Nothing here is north up.
	arp := latLon{lat: 48.821944, lon: 2.622778}
	c := pageContent{
		media: box{x1: 419.528, y1: 595.276},
		rects: []box{{x0: 50.5, y0: 33.5, x1: 403.2, y1: 549.5}},
		polys: []poly{{filled: true, pts: []float64{
			293.6, 163.7, 301.6, 163.7, 301.3, 426.7, 293.3, 426.7, 293.6, 163.7,
		}}},
		runs: []textRun{
			{x: 289.5, y: 153.9, adv: 8, text: "08"},
			{x: 297.2, y: 436.8, adv: 8, text: "26"},
			{x: 76.6, y: 49, adv: 4, text: "0"},
			{x: 182.9, y: 49, adv: 16, text: "300 m"},
		},
	}
	fit, why := fitRunway(c, []runwayRef{lfplRunway}, arp)
	if fit == nil {
		t.Fatalf("no fit: %s", why)
	}
	if fit.Method != "runway" || fit.Runways != 1 {
		t.Errorf("method %q over %d runways", fit.Method, fit.Runways)
	}
	// The drawn runway ends must land on the published ones.
	lat, lon := fit.Geo.at(297.6, 163.7)
	if d := (latLon{lat: lat, lon: lon}).dist(lfplRunway.lePos); d > 15 {
		t.Errorf("the 08 end landed %.0f m from its published position", d)
	}
	lat, lon = fit.Geo.at(297.3, 426.7)
	if d := (latLon{lat: lat, lon: lon}).dist(lfplRunway.hePos); d > 15 {
		t.Errorf("the 26 end landed %.0f m from its published position", d)
	}
	// And the sheet is rotated: a north-up fit would leave B and C at zero.
	if math.Abs(fit.Geo.B) < 1e-9 && math.Abs(fit.Geo.C) < 1e-9 {
		t.Error("the fit came out north-up on a sheet that is turned 75 degrees")
	}
	if _, ok := gate(fit, arp); !ok {
		t.Error("the aerodrome does not fall on its own ground chart")
	}
}

func TestFitRunwayRefusesWhatItCannotCheck(t *testing.T) {
	arp := latLon{lat: 48.821944, lon: 2.622778}
	base := pageContent{
		media: box{x1: 419.528, y1: 595.276},
		rects: []box{{x0: 50.5, y0: 33.5, x1: 403.2, y1: 549.5}},
		polys: []poly{{filled: true, pts: []float64{
			293.6, 163.7, 301.6, 163.7, 301.3, 426.7, 293.3, 426.7, 293.6, 163.7,
		}}},
		runs: []textRun{
			{x: 289.5, y: 153.9, adv: 8, text: "08"},
			{x: 297.2, y: 436.8, adv: 8, text: "26"},
		},
	}
	// A scale bar that disagrees with the fit means one of the two is
	// reading the wrong thing, and there is no way to tell which.
	bad := base
	bad.runs = append(append([]textRun(nil), base.runs...),
		textRun{x: 76.6, y: 49, adv: 4, text: "0"},
		textRun{x: 182.9, y: 49, adv: 16, text: "600 m"})
	if fit, why := fitRunway(bad, []runwayRef{lfplRunway}, arp); fit != nil {
		t.Errorf("published against a scale bar twice the fitted scale (%s)", why)
	}
	// An aerodrome with no runway positions cannot be placed this way.
	if fit, _ := fitRunway(base, nil, arp); fit != nil {
		t.Error("placed a sheet with no published runway to fit")
	}
	// A shape whose proportions are nothing like the runway's.
	fat := base
	fat.polys = []poly{{filled: true, pts: []float64{
		200, 160, 300, 160, 300, 430, 200, 430, 200, 160,
	}}}
	if fit, _ := fitRunway(fat, []runwayRef{lfplRunway}, arp); fit != nil {
		t.Error("fitted a runway to a shape three times too wide")
	}
}

// A north-up panel whose scale is right and whose position is not, with the
// runway drawn on it: the failure runwayAnchor exists for. A misread label
// moves a panel by a whole arcminute with nothing in the comb's residual to
// say so, and the ARP gate's margin is far too coarse to see it.
func anchorFixture(shiftLat, shiftLon float64) (pageContent, *panelFit) {
	// Fine enough that a 700 m runway is over runwayQuads' 40 pt floor.
	const degLatPerPt = 0.0001
	const degLonPerPt = 0.00015
	// Where the runway's ends land on the page under the TRUE mapping.
	trueGeo := geoAffine{A: degLonPerPt, D: degLatPerPt, E: 2.6, F: 48.8}
	pageOf := func(p latLon) [2]float64 {
		return [2]float64{(p.lon - trueGeo.E) / trueGeo.A, (p.lat - trueGeo.F) / trueGeo.D}
	}
	a, b := pageOf(lfplRunway.lePos), pageOf(lfplRunway.hePos)
	// The runway as drawn: a long thin closed shape through those points.
	dx, dy := b[0]-a[0], b[1]-a[1]
	n := math.Hypot(dx, dy)
	half := n / lfplRunway.aspect() / 2 // the runway's own proportions
	wx, wy := -dy/n*half, dx/n*half
	c := pageContent{polys: []poly{{filled: true, pts: []float64{
		a[0] + wx, a[1] + wy, b[0] + wx, b[1] + wy,
		b[0] - wx, b[1] - wy, a[0] - wx, a[1] - wy,
	}}}}
	// The fit the graticule produced: the same scale, the wrong place.
	fit := &panelFit{
		Clip: box{x0: -400, y0: -400, x1: 400, y1: 400},
		Geo:  geoAffine{A: degLonPerPt, D: degLatPerPt, E: 2.6 + shiftLon, F: 48.8 + shiftLat},
	}
	return c, fit
}

func TestRunwayAnchorMovesAPanelOntoItsOwnRunway(t *testing.T) {
	// A quarter of an arcminute out in both axes, which is the size of miss
	// the corpus actually shows and which no other gate here can see.
	const shiftLat, shiftLon = 0.004, 0.006
	c, fit := anchorFixture(shiftLat, shiftLon)
	dLat, dLon, resid, ok := runwayAnchor(c, fit, []runwayRef{lfplRunway})
	if !ok {
		t.Fatal("the runway drawn on the panel was not recognised")
	}
	// Within a runway's own width. The drawn shape's ends are the corners
	// of the painted strip, so they sit a half-width beyond the centreline
	// points the AIP publishes; that is the floor on this method and it is
	// two orders below the misses it corrects.
	dN := math.Abs(dLat+shiftLat) * 111320
	dE := math.Abs(dLon+shiftLon) * 111320 * math.Cos(48.8*math.Pi/180)
	if dN > 20 || dE > 20 {
		t.Errorf("shift off by %.0f m N, %.0f m E; want the panel put back where it belongs", dN, dE)
	}
	// Two points and a translation: what is left over is scale and rotation.
	if resid > 20 {
		t.Errorf("ends still miss %.0f m after the move, want under 20", resid)
	}
}

func TestRunwayAnchorRefusesAShapeThatIsNotTheRunway(t *testing.T) {
	c, fit := anchorFixture(0.004, 0.006)
	// The same shape against a runway of a quite different length: the
	// proportions still pass, the length does not, and a panel must never
	// be moved onto a shape that is not its runway.
	other := lfplRunway
	other.lePos = latLon{lat: 48.82059, lon: 2.62133}
	other.hePos = latLon{lat: 48.82500, lon: 2.66000}
	other.widthM = 80
	if _, _, _, ok := runwayAnchor(c, fit, []runwayRef{other}); ok {
		t.Error("moved the panel onto a shape three times its runway's length")
	}
}

// Where only ONE shape answers a runway it wins whatever it asks for, and
// a candidate asking to be carried a whole runway length is a different
// strip, not the same one placed a little wrong.
func TestRunwayAnchorRefusesToRelocateAPanel(t *testing.T) {
	c, fit := anchorFixture(0.004, 0.006)
	// The published runway moved two of its own lengths away: the drawn
	// shape still has the right proportions and the right mapped length,
	// and the only thing wrong with it is that it is somewhere else.
	far := lfplRunway
	far.lePos.lat += 0.05
	far.hePos.lat += 0.05
	if _, _, _, ok := runwayAnchor(c, fit, []runwayRef{far}); ok {
		t.Error("carried the panel more than a runway length onto a distant strip")
	}
}

func TestRunwayAnchorIgnoresShapesOffThePanel(t *testing.T) {
	c, fit := anchorFixture(0.004, 0.006)
	// An ATT page is composite: the aerodrome diagram below the map draws
	// the same runway at its own scale, and reading it as the map's would
	// place the panel by a picture that is not on it.
	fit.Clip = box{x0: -400, y0: 300, x1: 400, y1: 400}
	if _, _, _, ok := runwayAnchor(c, fit, []runwayRef{lfplRunway}); ok {
		t.Error("used a shape lying outside the panel's own clip")
	}
}

func TestNamedRunwayReadsTheLabelBesideTheStrip(t *testing.T) {
	// Besancon Thise's landing sheet, in miniature: two parallel grass
	// strips of one length, and a drawn shape that answers BOTH published
	// centrelines to the centimetre. No residual can separate them, no
	// proportion can either (a drawn width is a drawing choice), and the
	// anchor put this one on the wrong strip and reported 0.7 m for it.
	// What separates them is printed on the sheet: "06L" beside this
	// strip's end and "06R" beside the other's.
	q := quad{a: [2]float64{180.8, 287.4}, b: [2]float64{269.5, 330.5}, length: 98.6, width: 8}
	rwys := []runwayRef{
		{le: "06L", he: "24R"},
		{le: "06R", he: "24L"},
	}
	runs := []textRun{
		{x: 168.9, y: 285.2, adv: 11, text: "06L"},
		{x: 174.9, y: 273.1, adv: 11, text: "06R"},
		{x: 298.8, y: 333.6, adv: 11, text: "24R"},
		{x: 304.3, y: 322.5, adv: 11, text: "24L"},
	}
	got, ok := namedRunway(runs, q, rwys)
	if !ok || got != 0 {
		t.Errorf("namedRunway = %d, %v; want the 06L the sheet prints beside it", got, ok)
	}
	// Arcachon La Teste prints "07" for its grass strip and "07R" for the
	// hard one within a couple of points of each other. A name that close
	// to another runway's name names nothing, and a veto on it would
	// withdraw an anchor that was doing its job.
	crowd := []runwayRef{{le: "07R", he: "25L"}, {le: "07", he: "25"}}
	near := []textRun{
		{x: 170, y: 286, adv: 11, text: "07R"},
		{x: 172, y: 288, adv: 8, text: "07"},
		{x: 298, y: 333, adv: 11, text: "25L"},
		{x: 300, y: 335, adv: 8, text: "25"},
	}
	if got, ok := namedRunway(near, q, crowd); ok {
		t.Errorf("namedRunway = %d, true; want nothing: two names sit on the same end", got)
	}
	// And a sheet that prints no designator near the shape at all names
	// nothing, which is what leaves Lognes to the geometry.
	if _, ok := namedRunway(nil, q, rwys); ok {
		t.Error("namedRunway found a name on a sheet with no labels")
	}
	// A label half the runway away is not a label for that end.
	far := []textRun{{x: 20, y: 20, adv: 11, text: "06L"}, {x: 400, y: 500, adv: 11, text: "24R"}}
	if _, ok := namedRunway(far, q, rwys); ok {
		t.Error("namedRunway read a label half a page away as this strip's own")
	}
}
