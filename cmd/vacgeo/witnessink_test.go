// The witness's other half: which of a plate's own ink is a statement about
// the ground, and therefore worth measuring against it.
//
// Most of what a VAC sheet draws is not. Text, leader lines, arrows, north
// roses, obstacle marks, windsocks and stand numbers correspond to nothing
// on the ground, and a score that samples them is diluted by them. What
// does correspond is the line work of things that are there: buildings,
// aprons, runways, woods, water, pitches.
//
// Test file on purpose: cmd/vacgeo cannot link any of this.
package main

import (
	"math"
	"testing"
)

// inkEdge is one straight edge the plate drew, in page points, with enough
// of where it came from to tell chart line work from chart furniture.
type inkEdge struct {
	x1, y1, x2, y2 float64
	shape          int  // the subpath it belongs to, -1 for a lone stroke
	chord          bool // the chord of a bend, not a line the sheet drew
}

func (e inkEdge) lenPt() float64 { return math.Hypot(e.x2-e.x1, e.y2-e.y1) }

// witnessEdges is every straight edge on the page, each knowing the shape it
// belongs to.
//
// The walk records a subpath TWICE, once as its own poly and once as the
// consecutive pairs in segs, so the polys are read first and their edges
// struck off the segs. What is left is the strokes drawn on their own.
//
// OPEN edges are kept, and that was measured rather than assumed. The
// reference is made of outlines, so a road or a leader line matches nothing
// in it, and dropping every edge that closes nothing looked like free
// signal. It is not: over the 126 anchored panels readable both ways the
// median reading moved from 28.7 m to 30.4 m, which is to say nowhere, and
// the sheets it changed most were confident ones it made worse. Unmatched
// ink raises the score everywhere ALIKE, and a constant does not move a
// peak.
func witnessEdges(c pageContent) []inkEdge {
	out := make([]inkEdge, 0, len(c.segs))
	seen := make(map[[4]float64]bool, len(c.segs))
	key := func(x1, y1, x2, y2 float64) [4]float64 {
		return [4]float64{math.Round(x1*100) / 100, math.Round(y1*100) / 100,
			math.Round(x2*100) / 100, math.Round(y2*100) / 100}
	}
	for n, p := range c.polys {
		for i := 0; i+3 < len(p.pts); i += 2 {
			e := inkEdge{p.pts[i], p.pts[i+1], p.pts[i+2], p.pts[i+3], n, p.curved(i / 2)}
			seen[key(e.x1, e.y1, e.x2, e.y2)] = true
			out = append(out, e)
		}
	}
	for _, s := range c.segs {
		if seen[key(s.x1, s.y1, s.x2, s.y2)] {
			continue
		}
		out = append(out, inkEdge{s.x1, s.y1, s.x2, s.y2, -1, false})
	}
	return out
}

// repeatedShapes are the subpaths the page draws over and over: the north
// rose, the obstacle mark, the windsock, the tree, the P in its box. They
// are SYMBOLS, they stand where a draughtsman put them and not where
// anything is, and the page carries dozens of each.
//
// Congruence is tested after translation and to a third of a point, which
// is tighter than any two real outlines on a sheet ever agree and looser
// than the rounding a repeated symbol suffers.
func repeatedShapes(c pageContent, atLeast int) map[int]bool {
	sig := map[string][]int{}
	for n, p := range c.polys {
		if len(p.pts) < 6 || len(p.pts) > 200 {
			continue
		}
		b := p.bounds()
		if b.width() > 40 || b.height() > 40 {
			continue // a symbol is small; a building outline is not
		}
		k := ""
		for i := 0; i+1 < len(p.pts); i += 2 {
			k += string(rune(int(math.Round((p.pts[i]-b.x0)*3)))) +
				string(rune(int(math.Round((p.pts[i+1]-b.y0)*3))))
		}
		sig[k] = append(sig[k], n)
	}
	out := map[int]bool{}
	for _, ns := range sig {
		if len(ns) < atLeast {
			continue
		}
		for _, n := range ns {
			out[n] = true
		}
	}
	return out
}

// inkSample is one point of chart line work, in the panel's local metre
// frame, with the weight it carries in the score.
type inkSample struct{ x, y, w float64 }

// How many samples one edge may contribute. A ground chart's runway edge is
// four hundred metres of perfectly straight ink and would otherwise own the
// answer on its own, which would make the reading a measurement of one line.
const maxEdgeSamples = 24

// groundInk is the chart line work of one panel, projected onto the ground
// the panel claims and sampled.
//
// Thresholds are in GROUND METRES, never in points, so that they follow the
// panel's own scale: a two metre edge is line work on a pad detail and noise
// on a landing chart, and the same number cannot serve both.
func groundInk(c pageContent, pn box, g geoAffine, fr local, loM, hiM, stepM float64) []inkSample {
	mPerPt := groundPerPoint(g, fr)
	inner := box{
		x0: pn.x0 + pn.width()*0.02, y0: pn.y0 + pn.height()*0.02,
		x1: pn.x1 - pn.width()*0.02, y1: pn.y1 - pn.height()*0.02,
	}
	symbols := repeatedShapes(c, 3)
	text := textBoxes(c)
	var out []inkSample
	seen := map[[4]float64]bool{}
	for _, e := range witnessEdges(c) {
		if e.chord || symbols[e.shape] {
			continue
		}
		mx, my := (e.x1+e.x2)/2, (e.y1+e.y2)/2
		if !inner.holds([2]float64{mx, my}) {
			continue
		}
		lm := e.lenPt() * mPerPt
		if lm < loM || lm > hiM {
			continue
		}
		if inAnyBox(text, mx, my) {
			continue
		}
		k := [4]float64{math.Round(e.x1*10) / 10, math.Round(e.y1*10) / 10,
			math.Round(e.x2*10) / 10, math.Round(e.y2*10) / 10}
		if seen[k] {
			continue // stroke then fill is one shape, not two
		}
		seen[k] = true
		n := int(lm/stepM) + 1
		if n > maxEdgeSamples {
			n = maxEdgeSamples
		}
		for i := 0; i <= n; i++ {
			t := float64(i) / float64(n)
			lat, lon := g.at(e.x1+(e.x2-e.x1)*t, e.y1+(e.y2-e.y1)*t)
			p := fr.to(latLon{lat: lat, lon: lon})
			out = append(out, inkSample{p[0], p[1], 1})
		}
	}
	return out
}

// textBoxes are the boxes the page's own lettering occupies, inflated a
// little. An underline, a boxed label and a leader tick all sit inside one.
func textBoxes(c pageContent) []box {
	out := make([]box, 0, len(c.runs))
	for _, r := range c.runs {
		out = append(out, box{
			x0: r.x - 0.5, y0: r.y - 0.25*r.size - 0.5,
			x1: r.x + r.adv + 0.5, y1: r.y + 0.9*r.size + 0.5,
		})
	}
	return out
}

func inAnyBox(bs []box, x, y float64) bool {
	for _, b := range bs {
		if b.holds([2]float64{x, y}) {
			return true
		}
	}
	return false
}

// groundPerPoint is how many metres of ground one page point covers, read
// off the affine in the ellipsoid's own frame.
func groundPerPoint(g geoAffine, fr local) float64 {
	sx := math.Hypot(g.A*fr.mPerLon, g.B*fr.mPerLat)
	sy := math.Hypot(g.C*fr.mPerLon, g.D*fr.mPerLat)
	return (sx + sy) / 2
}

func TestWitnessEdgesKnowTheirShape(t *testing.T) {
	// One triangle drawn as a path and one stroke drawn on its own, as the
	// walk would record them: the poly AND its edges in segs.
	tri := []float64{10, 10, 30, 10, 30, 30, 10, 10}
	c := pageContent{
		polys: []poly{{pts: tri}},
		segs: []seg{
			{10, 10, 30, 10}, {30, 10, 30, 30}, {30, 30, 10, 10},
			{100, 100, 160, 100},
		},
	}
	got := witnessEdges(c)
	if len(got) != 4 {
		t.Fatalf("%d edges, want 4 (the triangle's three, counted once, and the lone stroke)", len(got))
	}
	for i := 0; i < 3; i++ {
		if got[i].shape != 0 {
			t.Errorf("edge %d belongs to shape %d, want the triangle", i, got[i].shape)
		}
	}
	if got[3].shape != -1 {
		t.Errorf("the lone stroke belongs to shape %d, want none", got[3].shape)
	}
}

func TestWitnessDropsTheChordOfABend(t *testing.T) {
	// A circle drawn as four beziers reaches the walk as a diamond whose
	// sides lie a third of the radius inside the ink. Those are not the
	// sheet's line work at all, and they are long and confident-looking.
	circle := poly{
		pts:   []float64{100, 60, 140, 100, 100, 140, 60, 100, 100, 60},
		curve: []bool{false, true, true, true, true},
	}
	c := pageContent{polys: []poly{circle}}
	for _, e := range witnessEdges(c) {
		if !e.chord {
			t.Errorf("edge %v read as drawn line work, want a chord", e)
		}
	}
	// And a plain quadrilateral is not a chord.
	plain := poly{pts: []float64{10, 10, 40, 10, 40, 40, 10, 40, 10, 10}}
	for _, e := range witnessEdges(pageContent{polys: []poly{plain}}) {
		if e.chord {
			t.Errorf("edge %v read as a chord, want drawn line work", e)
		}
	}
}

func TestWitnessDropsRepeatedSymbols(t *testing.T) {
	// Six obstacle marks of the same shape scattered over a sheet, and one
	// building outline that happens to have the same number of points.
	mark := []float64{0, 0, 4, 6, 8, 0, 0, 0}
	var polys []poly
	for _, at := range [][2]float64{{50, 50}, {120, 80}, {200, 300}, {310, 120}, {80, 400}, {260, 460}} {
		p := append([]float64(nil), mark...)
		for i := 0; i+1 < len(p); i += 2 {
			p[i] += at[0]
			p[i+1] += at[1]
		}
		polys = append(polys, poly{pts: p})
	}
	polys = append(polys, poly{pts: []float64{100, 100, 160, 100, 160, 150, 100, 150, 100, 100}})
	rep := repeatedShapes(pageContent{polys: polys}, 3)
	for i := 0; i < 6; i++ {
		if !rep[i] {
			t.Errorf("shape %d not read as a repeated symbol", i)
		}
	}
	if rep[6] {
		t.Error("the building outline was read as a symbol")
	}
	// Two of a shape is a coincidence a real pair of buildings can be.
	if rep := repeatedShapes(pageContent{polys: polys[:2]}, 3); len(rep) != 0 {
		t.Errorf("two alike read as symbols: %v", rep)
	}
}

func TestGroundInkFiltersToLineWork(t *testing.T) {
	// A panel one metre to the point, so the ground thresholds and the page
	// numbers read alike.
	fr := newLocal(latLon{lat: 48.8, lon: 2.4})
	g := geoAffine{
		A: 1 / fr.mPerLon, D: 1 / fr.mPerLat,
		E: 2.4, F: 48.8,
	}
	pn := box{x0: 0, y0: 0, x1: 400, y1: 400}
	c := pageContent{
		media: box{x1: 419, y1: 595},
		polys: []poly{{pts: []float64{50, 50, 150, 50, 150, 150, 50, 150, 50, 50}}},
		segs: []seg{
			{50, 50, 150, 50}, {150, 50, 150, 150}, {150, 150, 50, 150}, {50, 150, 50, 50},
			{200, 200, 203, 200}, // too short to be a statement about the ground
			{10, 380, 390, 380},  // outside the inner clip? no: long, and kept
		},
		runs: []textRun{{x: 195, y: 195, size: 8, adv: 40, text: "Urgences"}},
	}
	got := groundInk(c, pn, g, fr, 20, 500, 10)
	if len(got) == 0 {
		t.Fatal("no ink at all")
	}
	// Nothing may land on the lettering.
	for _, s := range got {
		if math.Abs(s.x-200) < 3 && math.Abs(s.y-200) < 3 {
			t.Errorf("a sample landed on the label at %v", s)
		}
	}
	// The building's four sides, at most maxEdgeSamples+1 points each,
	// plus the long stroke. The three-point stroke is under the floor.
	if len(got) > 5*(maxEdgeSamples+1) {
		t.Errorf("%d samples, more than the line work can carry", len(got))
	}
}

func TestGroundPerPointIsTheEllipsoid(t *testing.T) {
	fr := newLocal(latLon{lat: 48.79876, lon: 2.45348})
	// The Creteil landing sheet's own affine: 1.6212 m to the point.
	g := geoAffine{A: 2.2104e-05, B: 3.2e-07, C: -4.86e-07, D: 1.456e-05, E: 2.44955, F: 48.79277}
	if got := groundPerPoint(g, fr); math.Abs(got-1.6212) > 0.005 {
		t.Errorf("%.4f m per point, want 1.6212", got)
	}
}
