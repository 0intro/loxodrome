package main

import (
	"math"
	"testing"
)

// sq builds a closed rectangle outline, rotated about its own centre.
func sq(cx, cy, w, h, degrees float64) []float64 {
	th := degrees * math.Pi / 180
	cs, sn := math.Cos(th), math.Sin(th)
	var pts []float64
	for _, c := range [4][2]float64{{-w / 2, -h / 2}, {w / 2, -h / 2}, {w / 2, h / 2}, {-w / 2, h / 2}} {
		pts = append(pts, cx+c[0]*cs-c[1]*sn, cy+c[0]*sn+c[1]*cs)
	}
	return append(pts, pts[0], pts[1])
}

// cross builds the twelve-corner hospital marking, rotated the same way.
func cross(cx, cy, side, arm, degrees float64) []float64 {
	th := degrees * math.Pi / 180
	cs, sn := math.Cos(th), math.Sin(th)
	a, b := side/2, arm/2
	local := [12][2]float64{
		{-b, -a}, {b, -a}, {b, -b}, {a, -b}, {a, b}, {b, b},
		{b, a}, {-b, a}, {-b, b}, {-a, b}, {-a, -b}, {-b, -b},
	}
	var pts []float64
	for _, c := range local {
		pts = append(pts, cx+c[0]*cs-c[1]*sn, cy+c[0]*sn+c[1]*cs)
	}
	return append(pts, pts[0], pts[1])
}

func TestPadMarkIsFoundAtAnyAngle(t *testing.T) {
	panel := box{x0: 0, y0: 0, x1: 300, y1: 300}
	// Half these panels are turned, so the marking is too. A test against
	// the page's own axes found the upright sheets and none of the others.
	for _, deg := range []float64{0, 7, 15, 23.5, 45, 88} {
		c := pageContent{polys: []poly{{pts: cross(150, 150, 30, 12, deg), filled: true}}}
		got := padMarks(c, panel)
		if len(got) != 1 {
			t.Fatalf("%.1f deg: got %d markings, want 1", deg, len(got))
		}
		if math.Abs(got[0].cx-150) > 0.5 || math.Abs(got[0].cy-150) > 0.5 {
			t.Errorf("%.1f deg: centre (%.1f,%.1f), want (150,150)", deg, got[0].cx, got[0].cy)
		}
		if math.Abs(got[0].side-30) > 0.5 {
			t.Errorf("%.1f deg: side %.1f, want 30", deg, got[0].side)
		}
	}
	// A shape with a diagonal in it is not a marking, whatever its corner
	// count: a building is a rectangle and a symbol is not square.
	star := []float64{100, 100, 130, 110, 140, 140, 110, 130, 100, 100}
	c := pageContent{polys: []poly{{pts: star, filled: true}}}
	if got := padMarks(c, panel); len(got) != 0 {
		t.Errorf("a diagonal shape was read as a marking: %v", got)
	}
	// And an outline drawn twice, stroke then fill, is one marking.
	c = pageContent{polys: []poly{
		{pts: cross(150, 150, 30, 12, 0), filled: true},
		{pts: cross(150.2, 150.1, 30.1, 12, 0), filled: true},
	}}
	if got := padMarks(c, panel); len(got) != 1 {
		t.Errorf("got %d markings for one drawn twice, want 1", len(got))
	}
}

func TestPadSquaresMeasureTheirOwnSides(t *testing.T) {
	mark := padMarkShape{cx: 150, cy: 150, side: 20}
	// A square drawn at an angle has a square BOUNDING BOX a third bigger
	// than itself, so the side has to come off the corners.
	c := pageContent{polys: []poly{
		{pts: sq(150, 150, 30, 30, 30)},
		{pts: sq(150, 150, 60, 60, 30)},
	}}
	got := padSquares(c, mark)
	if len(got) != 2 {
		t.Fatalf("squares %v, want two", got)
	}
	if math.Abs(got[0]-30) > 0.5 || math.Abs(got[1]-60) > 0.5 {
		t.Errorf("sides %v, want 30 and 60 (the bounding boxes are 41 and 82)", got)
	}
	// The stroke's two edges are one square.
	c.polys = append(c.polys, poly{pts: sq(150, 150, 31.5, 31.5, 30)})
	if got := padSquares(c, mark); len(got) != 2 {
		t.Errorf("squares %v, want the stroke's two edges folded into one", got)
	}
	// A courtyard is not the pad: bounded above, and off centre is out.
	c.polys = append(c.polys, poly{pts: sq(150, 150, 200, 200, 0)}, poly{pts: sq(200, 150, 40, 40, 0)})
	if got := padSquares(c, mark); len(got) != 2 {
		t.Errorf("squares %v, want the two concentric ones alone", got)
	}
}

// A round pad arrives as a four-point DIAMOND, one chord per bezier, and a
// diamond is square to a frame at 45 degrees, so every other clause accepts
// it and measures the chord: 29 % under the circle the plate drew.
func TestPadSquaresMeasureACircleAsACircle(t *testing.T) {
	mark := padMarkShape{cx: 150, cy: 150, side: 10}
	ring := poly{
		pts:   []float64{130, 150, 150, 170, 170, 150, 150, 130, 130, 150},
		curve: []bool{true, true, true, true, true},
	}
	got := padSquares(pageContent{polys: []poly{ring}}, mark)
	if len(got) != 1 || math.Abs(got[0]-40) > 0.5 {
		t.Errorf("squares %v, want one of 40 (the diameter, not the 28.3 chord)", got)
	}
	// A real square at 45 degrees is the chord, and nothing says otherwise.
	ring.curve = nil
	got = padSquares(pageContent{polys: []poly{ring}}, mark)
	if len(got) != 1 || math.Abs(got[0]-28.28) > 0.5 {
		t.Errorf("squares %v, want one of 28.3 (its own side)", got)
	}
	// Two arcs and two straight sides is a LOZENGE, not a circle, and the
	// corpus draws 86 of them. The flags are per point and mark the one a
	// curve reached, so this reads false at the side arriving at the third
	// point; a test that walks corner indices instead ORs its way past it
	// and measures the box, 41 % too wide.
	lozenge := poly{
		pts:   []float64{130, 150, 150, 170, 170, 150, 150, 130, 130, 150},
		curve: []bool{false, true, false, true, false},
	}
	got = padSquares(pageContent{polys: []poly{lozenge}}, mark)
	if len(got) != 1 || math.Abs(got[0]-28.28) > 0.5 {
		t.Errorf("squares %v, want one of 28.3: two arcs and two lines is not a circle", got)
	}
}

// An `H` typed into the middle of the square it names is a marking, and
// five landing sheets set theirs at 90 degrees.
func TestPadGlyphMarkIsIsolatedAndEnclosed(t *testing.T) {
	panel := box{x0: 0, y0: 0, x1: 300, y1: 300}
	ring := poly{pts: sq(150, 150, 30, 30, 0)}
	// Upright, isolated, enclosed.
	h := textRun{x: 145, y: 145, size: 10, adv: 10, ax: 10, text: "H"}
	c := pageContent{runs: []textRun{h}, polys: []poly{ring}}
	got := padGlyphMarks(c, panel)
	if len(got) != 1 {
		t.Fatalf("got %d markings, want 1", len(got))
	}
	if math.Abs(got[0].cx-150) > 0.5 || math.Abs(got[0].cy-150) > 0.5 {
		t.Errorf("centre (%.1f,%.1f), want (150,150)", got[0].cx, got[0].cy)
	}
	// Set at 90 degrees: `size` reads 0 and the advance runs up the page.
	// The box has to be walked in the run's own frame or the square is no
	// longer concentric with it.
	turned := textRun{x: 155, y: 145, size: 0, adv: 10, ay: 10, text: "H"}
	c.runs = []textRun{turned}
	if got := padGlyphMarks(c, panel); len(got) != 1 {
		t.Errorf("got %d markings for a turned H, want 1", len(got))
	}
	// A letter of a word is not a marking, however well enclosed.
	c.runs = []textRun{h, {x: 155.5, y: 145, size: 10, adv: 8, ax: 8, text: "OP"}}
	if got := padGlyphMarks(c, panel); len(got) != 0 {
		t.Errorf("a word fragment was read as a marking: %v", got)
	}
	// And an H with nothing drawn around it is a caption.
	c = pageContent{runs: []textRun{h}}
	if got := padGlyphMarks(c, panel); len(got) != 0 {
		t.Errorf("an unenclosed H was read as a marking: %v", got)
	}
	// One marking drawn twice is one marking. These plates set everything
	// twice, stroke then fill, and the second draw lands on the first or a
	// hundredth of a point off it; counted as two the page is refused
	// `two-marks`, and counted as a NEIGHBOUR the marking is refused for
	// not being isolated.
	for _, off := range []float64{0, 0.021} {
		twice := h
		twice.y += off
		c = pageContent{runs: []textRun{h, twice}, polys: []poly{ring}}
		if got := padGlyphMarks(c, panel); len(got) != 1 {
			t.Errorf("a marking drawn twice %.3f pt apart gave %d markings, want 1", off, len(got))
		}
	}
}

func TestPadScaleWantsTwoReadings(t *testing.T) {
	sizes := []float64{11.4, 20.6, 28}
	// With a bar: the bar gives the scale and the drawn pad checks it.
	if _, dev, _, ok := padScale([]float64{27.4}, sizes, 2.4, true); !ok || math.Abs(dev) > 0.02 {
		t.Errorf("bar + pad: ok=%v dev=%.3f, want a match", ok, dev)
	}
	// 25 m is within a tenth of the 28 m safety area, so the square that
	// has to be refused is one no published size is near.
	if _, _, why, ok := padScale([]float64{110}, sizes, 2.4, true); ok || why != "pad-bar" {
		t.Errorf("a square that is no published size: ok=%v why=%q", ok, why)
	}
	// Without one, the squares' own ratio is the reading, and the scale
	// follows from it.
	scale, dev, _, ok := padScale([]float64{27.4, 67.2}, sizes, 0, false)
	if !ok || math.Abs(dev) > 0.03 {
		t.Fatalf("ratio: ok=%v dev=%.3f, want the 11.4 / 28 pair", ok, dev)
	}
	if math.Abs(scale-2.4) > 0.05 {
		t.Errorf("scale %.3f pt/m, want about 2.4", scale)
	}
	// Every refusal says which of the four it is, because they are four
	// different problems and only one of them is about the sheet.
	for _, tc := range []struct {
		name    string
		squares []float64
		sizes   []float64
		want    string
	}{
		// One square and no bar is ONE reading, and one reading is not
		// evidence: the marking would be taken on trust.
		{"one square", []float64{27.4}, sizes, "pad-one-square"},
		// Two readings of the same square are still one square.
		{"two alike", []float64{27.4, 28.9}, sizes, "pad-alike"},
		// A pad the AIP states once cannot supply a ratio at all. That is
		// a gap in our own data and nothing to do with the plate.
		{"one published size", []float64{27.4, 67.2}, []float64{11.4}, "pad-one-size"},
		// Both had a pair, and no two agreed.
		{"no ratio", []float64{27.4, 41.0}, sizes, "pad-ratio"},
	} {
		if _, _, why, ok := padScale(tc.squares, tc.sizes, 0, false); ok || why != tc.want {
			t.Errorf("%s: ok=%v why=%q, want %q", tc.name, ok, why, tc.want)
		}
	}
}

func TestNorthArrowNeedsAllThreeMarks(t *testing.T) {
	panel := box{x0: 0, y0: 0, x1: 300, y1: 300}
	// A shaft, a filled head at its point, and the letter beyond it.
	arrow := func(deg float64) pageContent {
		th := deg * math.Pi / 180
		cs, sn := math.Cos(th), math.Sin(th)
		tail := [2]float64{150 - 30*cs, 150 - 30*sn}
		head := [2]float64{150, 150}
		letter := [2]float64{150 + 12*cs, 150 + 12*sn}
		return pageContent{
			segs:  []seg{{tail[0], tail[1], head[0], head[1]}},
			polys: []poly{{pts: sq(head[0], head[1], 4, 6, deg), filled: true}},
			runs:  []textRun{{x: letter[0], y: letter[1], size: 9, adv: 5, text: "N"}},
		}
	}
	for _, deg := range []float64{90, 105, 60, 180, -45} {
		got, _, ok := northArrow(arrow(deg), panel)
		if !ok {
			t.Fatalf("%.0f deg: no arrow read", deg)
		}
		if d := math.Abs(math.Remainder(got-deg*math.Pi/180, 2*math.Pi)); d > 2*math.Pi/180 {
			t.Errorf("%.0f deg: read %.1f deg", deg, got*180/math.Pi)
		}
	}
	// The letter has to lie AHEAD of the point. A blob near an N with a
	// stroke through it is otherwise an arrow in any direction you please.
	c := arrow(90)
	c.runs[0].y = 150 - 12
	if _, _, ok := northArrow(c, panel); ok {
		t.Error("a letter behind the head was read as an arrow")
	}
	// Two arrows on one panel that disagree are not evidence.
	c = arrow(90)
	other := arrow(30)
	for i := range other.segs {
		other.segs[i].x1 += 90
		other.segs[i].x2 += 90
	}
	for i := range other.polys {
		for j := 0; j+1 < len(other.polys[i].pts); j += 2 {
			other.polys[i].pts[j] += 90
		}
	}
	other.runs[0].x += 90
	c.segs = append(c.segs, other.segs...)
	c.polys = append(c.polys, other.polys...)
	c.runs = append(c.runs, other.runs...)
	if _, _, ok := northArrow(c, panel); ok {
		t.Error("two arrows pointing different ways were still read")
	}
}

func TestPrintedPadSizesReadsTheSheetsOwnNotes(t *testing.T) {
	got := printedPadSizes([]string{
		"Aire de securite : 27 x 27 m",
		"FATO : 20.6 m x 20.6 m", // the unit twice over, which the corpus prints
		"TLOF : 10 x 10 m",
		"Safety area 26,5 x 26,5 m", // the French decimal comma
		"9 - Force portante / Strength : 6.0 t",
		"793 x 90 m", // a runway, named by nothing
	})
	want := []float64{27, 27, 20.6, 20.6, 10, 10, 26.5, 26.5}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range got {
		if math.Abs(got[i]-want[i]) > 1e-9 {
			t.Errorf("size %d = %v, want %v", i, got[i], want[i])
		}
	}
}

func TestStatedSizesReadsTheAipsOwnProse(t *testing.T) {
	// The four forms AD 1.3-2 writes a pad dimension in, and the one row
	// of 156 that states no figure at all.
	for _, tc := range []struct {
		text string
		want []float64
	}{
		{"20 x 20 m", []float64{20, 20}},
		{"25x30", []float64{25, 30}},
		{"11.4 X 11.4", []float64{11.4, 11.4}},
		{"27,5 × 27,5", []float64{27.5, 27.5}}, // the multiplication sign
		{"Diamètre 20", []float64{20}},
		{"Ø 25", []float64{25}},
		{"voir VAC", nil},
		{"Diametre 1", nil}, // under any touchdown area
	} {
		got := statedSizes(tc.text)
		if len(got) != len(tc.want) {
			t.Errorf("%q: got %v, want %v", tc.text, got, tc.want)
			continue
		}
		for i := range got {
			if math.Abs(got[i]-tc.want[i]) > 1e-9 {
				t.Errorf("%q: got %v, want %v", tc.text, got, tc.want)
				break
			}
		}
	}
}

func TestStackedPanelsCutAtTheRules(t *testing.T) {
	media := box{x1: 419.5, y1: 595.3}
	// Two rails with a rule across them: a site plan over a pad detail,
	// which is the shape of every one of these sheets.
	c := pageContent{media: media, segs: []seg{
		{14.3, 118, 14.3, 527},
		{366.1, 118, 366.1, 527},
		{14.3, 214.7, 366.1, 214.7},
		{14.3, 33.5, 366.7, 33.5}, // the notes block, outside the rails
		{20, 300, 60, 300},        // a scale bar, too short to cut anything
	}}
	got := stackedPanels(c)
	if len(got) != 2 {
		t.Fatalf("panels %v, want two", got)
	}
	if math.Abs(got[0].y0-214.7) > 0.1 || math.Abs(got[0].y1-527) > 0.1 {
		t.Errorf("first panel %v, want the upper one", got[0])
	}
	if math.Abs(got[1].y0-118) > 0.1 || math.Abs(got[1].y1-214.7) > 0.1 {
		t.Errorf("second panel %v, want the lower one", got[1])
	}
	// The page trim is not a panel.
	c.segs = []seg{{0, 0, 0, 595.3}, {419.5, 0, 419.5, 595.3}}
	if got := stackedPanels(c); len(got) != 0 {
		t.Errorf("panels %v, want none: that is the page", got)
	}
}

func TestStackedPanelsReadTheDrawnFrame(t *testing.T) {
	media := box{x1: 419.5, y1: 595.3}
	// The frame is ONE path and its corners are worked, so the straight
	// sides stop short of the frame's own extent. Both shapes the corpus
	// draws have to come out at the frame's BOUNDS and not at its rails.
	for _, tc := range []struct {
		name string
		pts  []float64
		y0   float64
		cut  float64
		y1   float64
	}{{
		// Creteil Henri Mondor: corners CHAMFERED at forty-five degrees,
		// the rails fourteen points short at each end.
		name: "chamfered",
		pts: []float64{
			28.1, 541.4,
			352.8, 541.4,
			366.7, 527.2,
			366.7, 123.3,
			352.9, 109.4,
			28.1, 109.4,
			14.2, 123.3,
			14.2, 527.2,
			28.1, 541.4,
		},
		y0: 109.4, cut: 266.3, y1: 541.4,
	}, {
		// Abbeville: corners ROUNDED, which reaches this reader as a chord
		// because the walk keeps one straight edge per curve operator. The
		// rails are ALSO drawn out of plumb, 0.68 pt over 285, and their
		// straight portions differ by 3.98 pt because the radii do.
		name: "rounded",
		pts: []float64{
			28.918, 541.639,
			352.461, 541.639,
			366.379, 531.702,
			367.059, 246.881,
			353.383, 239.964,
			29.836, 239.964,
			15.684, 246.881,
			15.000, 527.725,
			28.918, 541.639,
		},
		y0: 239.964, cut: 390.0, y1: 541.639,
	}} {
		t.Run(tc.name, func(t *testing.T) {
			b := poly{pts: tc.pts}.bounds()
			c := pageContent{media: media, polys: []poly{{pts: tc.pts}}, segs: []seg{
				{b.x0, tc.cut, b.x1, tc.cut}, // the rule between the two panels
			}}
			got := stackedPanels(c)
			if len(got) != 2 {
				t.Fatalf("panels %v, want two", got)
			}
			if math.Abs(got[0].y1-tc.y1) > 0.1 || math.Abs(got[0].y0-tc.cut) > 0.1 {
				t.Errorf("upper panel %v, want it cut at the frame's own %.2f", got[0], tc.y1)
			}
			if math.Abs(got[1].y0-tc.y0) > 0.1 || math.Abs(got[1].y1-tc.cut) > 0.1 {
				t.Errorf("lower panel %v, want it cut at the frame's own %.2f", got[1], tc.y0)
			}
			if math.Abs(got[0].x0-b.x0) > 0.1 || math.Abs(got[0].x1-b.x1) > 0.1 {
				t.Errorf("panel width %v, want the frame's own %.2f..%.2f", got[0], b.x0, b.x1)
			}
		})
	}
}

func TestPanelFramesRefuseAShapeThatIsNotOne(t *testing.T) {
	media := box{x1: 419.5, y1: 595.3}
	// A frame FILLS its own bounding box. This L-shaped block is big
	// enough to be one and fills three quarters of its box, which is what
	// separates a frame from the largest thing drawn inside it.
	ell := []float64{20, 120, 360, 120, 360, 300, 200, 300, 200, 520, 20, 520, 20, 120}
	c := pageContent{media: media, polys: []poly{{pts: ell}}}
	if got := panelFrames(c); len(got) != 0 {
		t.Errorf("frames %v, want none: that is a block, not a frame", got)
	}
	// And it must not fall through to a rail pair either: the two long
	// vertical edges do not share a y range.
	if got := stackedPanels(c); len(got) != 0 {
		t.Errorf("panels %v, want none", got)
	}
	// The page trim fills its box perfectly and is still not a frame.
	trim := []float64{0, 0, 419.5, 0, 419.5, 595.3, 0, 595.3, 0, 0}
	if got := panelFrames(pageContent{media: media, polys: []poly{{pts: trim}}}); len(got) != 0 {
		t.Errorf("frames %v, want none: that is the page", got)
	}
}

// axis builds a two-headed sector: one shaft, a filled point at each end,
// with a bearing printed beside each point.
func sectorPlate(cx, cy, halfLen, deg float64, a, b string) pageContent {
	th := deg * math.Pi / 180
	cs, sn := math.Cos(th), math.Sin(th)
	e1 := [2]float64{cx + halfLen*cs, cy + halfLen*sn}
	e2 := [2]float64{cx - halfLen*cs, cy - halfLen*sn}
	return pageContent{
		segs: []seg{{e2[0], e2[1], e1[0], e1[1]}},
		polys: []poly{
			{pts: sq(e1[0], e1[1], 5, 7, deg), filled: true},
			{pts: sq(e2[0], e2[1], 5, 7, deg), filled: true},
		},
		runs: []textRun{
			{x: e1[0] - 20*cs, y: e1[1] - 20*sn, size: 9, adv: 15, text: a},
			{x: e2[0] + 20*cs, y: e2[1] + 20*sn, size: 9, adv: 15, text: b},
		},
	}
}

func TestBearingLabelsWantTheDegreeSign(t *testing.T) {
	panel := box{x0: 0, y0: 0, x1: 400, y1: 400}
	c := pageContent{runs: []textRun{
		{x: 100, y: 200, size: 9, adv: 15, text: "087°"},
		{x: 140, y: 200, size: 9, adv: 12, text: "267"},  // the digits alone
		{x: 152, y: 200, size: 9, adv: 3, text: "°"},     // and its sign, abutting
		{x: 200, y: 300, size: 7, adv: 12, text: "483"},  // an obstacle height
		{x: 250, y: 300, size: 7, adv: 10, text: "1335"}, // and a taller one
	}}
	got := bearingLabels(c, panel)
	if len(got) != 2 {
		t.Fatalf("got %v, want the two bearings", got)
	}
	if got[0].deg != 87 || got[1].deg != 267 {
		t.Errorf("read %.0f and %.0f, want 087 and 267", got[0].deg, got[1].deg)
	}
}

func TestBearingNorthReadsATwoHeadedSector(t *testing.T) {
	panel := box{x0: 0, y0: 0, x1: 400, y1: 400}
	// An axis drawn exactly east-west and labelled 087 at its western
	// point and 267 at its eastern one, each naming the leg that leads
	// away from it. North is then three degrees off the top of the page,
	// which is what a plate that draws an 087 sector horizontally says.
	c := sectorPlate(200, 200, 70, 0, "267°", "087°")
	got, ok := bearingNorth(c, panel)
	if !ok {
		t.Fatal("no reading from a labelled sector axis")
	}
	if d := math.Abs(angleDiff(got, 87*math.Pi/180)) * 180 / math.Pi; d > 0.5 {
		t.Errorf("north at %+.1f deg, want 87", got*180/math.Pi)
	}
	// The same axis on a panel turned twenty degrees.
	c = sectorPlate(200, 200, 70, 20, "267°", "087°")
	got, ok = bearingNorth(c, panel)
	if !ok || math.Abs(angleDiff(got, 107*math.Pi/180))*180/math.Pi > 0.5 {
		t.Errorf("north at %+.1f deg (%v), want 107", got*180/math.Pi, ok)
	}
	// One label is one reading, and one reading is a label paired with
	// whatever arrow happened to be nearest it.
	c = sectorPlate(200, 200, 70, 0, "267°", "")
	if _, ok := bearingNorth(c, panel); ok {
		t.Error("a single label placed a panel")
	}
	// A single-headed arrow is not a sector: the plates label those the
	// other way round and nothing on the page says which is which.
	c = sectorPlate(200, 200, 70, 0, "267°", "087°")
	c.polys = c.polys[:1]
	if _, ok := bearingNorth(c, panel); ok {
		t.Error("a one-headed arrow was read as a sector axis")
	}
}

func TestPanelNorthPrefersTheArrow(t *testing.T) {
	panel := box{x0: 0, y0: 0, x1: 400, y1: 400}
	// An arrow pointing up and a sector axis that disagrees with it: the
	// arrow is three marks drawn to say one thing and it wins.
	c := sectorPlate(200, 120, 60, 0, "180°", "000°")
	arrow := pageContent{
		segs:  []seg{{60, 250, 60, 300}},
		polys: []poly{{pts: sq(60, 305, 4, 6, 90), filled: true}},
		runs:  []textRun{{x: 60, y: 318, size: 9, adv: 5, text: "N"}},
	}
	c.segs = append(c.segs, arrow.segs...)
	c.polys = append(c.polys, arrow.polys...)
	c.runs = append(c.runs, arrow.runs...)
	got, ok := panelNorth(c, panel)
	if !ok || math.Abs(angleDiff(got.Angle, math.Pi/2))*180/math.Pi > 1 {
		t.Errorf("north %+.1f deg (%v), want the arrow's 90", got.Angle*180/math.Pi, ok)
	}
	// And it says the arrow said so, with the shaft it read it off and the
	// gap to the sectors it did not take.
	if got.From != "arrow" || got.ShaftPt < 40 || got.DisagreeDeg == 0 {
		t.Errorf("north read %+v, want the arrow, its shaft, and the gap to the sectors", got)
	}
	// A sector reading a long way round from up is the approach-versus-
	// departure flip, not a sheet drawn upside down, and it is refused
	// where there is no arrow to settle it.
	flipped := sectorPlate(200, 200, 70, 0, "087°", "267°")
	if _, ok := panelNorth(flipped, panel); ok {
		t.Error("a sector reading a half turn from up was believed")
	}
}
