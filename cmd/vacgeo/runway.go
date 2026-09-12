// runway.go places a sheet that has no graticule to read, by fitting the
// runway it draws to the runway's own published ends.
//
// A ground-movement chart carries no grid at all. What it does carry is the
// runway, drawn as a long thin quadrilateral, and the app now holds where
// that runway really is: cmd/fr reads the AIXM centreline points and
// fr-airports.json states both physical ends. Two points fix a similarity
// transform, and a similarity is exactly what these sheets are, because
// they are ROTATED. LFPL's ground-movement chart is turned about 75
// degrees, its runway drawn up the page, so nothing here may assume north
// is up.
//
// Two points also fix the transform EXACTLY, which means the fit has no
// residual of its own to be judged by. Everything that makes this safe is
// therefore external to it:
//
//   - the drawn shape's proportions must match the published runway's;
//   - both designators must be printed, each nearest its own end, which is
//     what stops a sheet being placed upside down;
//   - the scale the fit implies must match the scale bar the sheet prints,
//     where it prints one;
//   - a second runway, where the aerodrome has one, must land where the
//     first runway's transform says it should;
//   - and the aerodrome must fall on the finished panel, the same gate
//     every graticule panel passes.
//
// A sheet that cannot clear those is not published. A taxiway diagram in
// the wrong place, or the right place upside down, is worse than none.

package main

import (
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// A drawn runway is long and thin; nothing else on an aerodrome diagram is
// this long and this thin at once.
const (
	minRunwayLenPt    = 40
	minRunwayAspect   = 6
	maxAspectMismatch = 0.45
)

// Plausible scales for an aerodrome diagram, in points of paper per metre
// of ground: about 1:2000 to 1:25000.
const (
	minPtPerM = 0.08
	maxPtPerM = 1.60
)

// How far a second runway's ends may miss where the first runway's
// transform puts them.
const maxCrossResidM = 30

// How far the fitted scale may differ from the printed scale bar.
const maxScaleDev = 0.08

// runwayRef is one published runway with both physical ends.
type runwayRef struct {
	le, he       string
	lePos, hePos latLon
	widthM       float64
}

func (r runwayRef) lengthM() float64 {
	return r.lePos.dist(r.hePos)
}

func (r runwayRef) aspect() float64 {
	if r.widthM <= 0 {
		return 0
	}
	return r.lengthM() / r.widthM
}

// quad is a candidate drawn runway: the two ends of its long axis, and how
// long and thin it is.
type quad struct {
	a, b   [2]float64
	length float64
	width  float64
}

func (q quad) aspect() float64 { return q.length / q.width }

// quadsBox is the extent of the drawn runways, which is what a frame has to
// contain on a sheet with no graticule to bracket.
func quadsBox(quads []quad) box {
	b := box{x0: math.MaxFloat64, y0: math.MaxFloat64, x1: -math.MaxFloat64, y1: -math.MaxFloat64}
	for _, q := range quads {
		for _, p := range [2][2]float64{q.a, q.b} {
			b.x0 = math.Min(b.x0, p[0])
			b.y0 = math.Min(b.y0, p[1])
			b.x1 = math.Max(b.x1, p[0])
			b.y1 = math.Max(b.y1, p[1])
		}
	}
	return b
}

// runwayQuads finds the long thin closed shapes on a page. Both filled and
// stroked count: a paved runway is drawn solid and a grass one outlined.
func runwayQuads(c pageContent) []quad {
	var out []quad
	for _, p := range c.polys {
		n := len(p.pts) / 2
		if n < 4 || n > 8 {
			continue
		}
		hi := 0.0
		var ai, bi int
		for i := 0; i+3 < len(p.pts); i += 2 {
			d := math.Hypot(p.pts[i+2]-p.pts[i], p.pts[i+3]-p.pts[i+1])
			if d > hi {
				hi, ai, bi = d, i, i+2
			}
		}
		if hi < minRunwayLenPt {
			continue
		}
		// The width is the width: how far the outline reaches ACROSS its
		// own long axis, and not the shortest edge anywhere on it.
		//
		// The shortest edge was a proxy for the width and it is a bad one.
		// A runway is drawn with a notch at a threshold, a step at a
		// displaced one, or a stub where a taxiway meets it, and any of
		// those is a short edge that says nothing about how wide the
		// strip is: over the 25 pages the reader cannot tie, 71 of the 157
		// shapes it accepts (45 %) read more than twice their true aspect
		// this way and 25 of them read past 100. Merville Calonne's whole
		// accepted list is hairlines 0.10 to 0.50 points wide, which are
		// centrelines and edge lines drawn as filled hair paths, admitted
		// because a hairline's own short edge is a hairline.
		th := math.Atan2(p.pts[bi+1]-p.pts[ai+1], p.pts[bi]-p.pts[ai])
		_, across := extentIn(p.pts, th)
		if across <= 0.05 || hi/across < minRunwayAspect {
			continue
		}
		out = append(out, quad{
			a:      [2]float64{p.pts[ai], p.pts[ai+1]},
			b:      [2]float64{p.pts[bi], p.pts[bi+1]},
			length: hi,
			width:  across,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].length > out[j].length })
	if len(out) > 12 {
		out = out[:12]
	}
	return out
}

// designatorAt finds the run printing one runway designator nearest a page
// point, and how far away it is. A designator is set beside its own end of
// the runway, which is what tells this reader which way round the sheet is.
func designatorAt(runs []textRun, desig string, near [2]float64) (float64, bool) {
	want := strings.TrimSpace(desig)
	best := math.MaxFloat64
	for _, r := range runs {
		if strings.TrimSpace(r.text) != want {
			continue
		}
		d := math.Hypot(r.x-near[0], r.y-near[1])
		if d < best {
			best = d
		}
	}
	return best, best < math.MaxFloat64
}

// orient decides which end of a drawn quad is which threshold, by which
// designator is printed nearest it. It reports nothing when either
// designator is missing or when the two answers disagree, because an
// aerodrome diagram placed backwards is the failure this whole file exists
// to avoid and there is no second signal to break a tie.
func orient(runs []textRun, q quad, r runwayRef) (le, he [2]float64, ok bool) {
	dLeA, okLeA := designatorAt(runs, r.le, q.a)
	dHeB, okHeB := designatorAt(runs, r.he, q.b)
	dLeB, okLeB := designatorAt(runs, r.le, q.b)
	dHeA, okHeA := designatorAt(runs, r.he, q.a)
	if !okLeA || !okHeB || !okLeB || !okHeA {
		return le, he, false
	}
	// The designator has to be BESIDE its end, not merely nearer it than
	// the other one is: a label half the runway away is not a label for
	// that end.
	limit := q.length * 0.45
	forward := dLeA + dHeB
	backward := dLeB + dHeA
	if forward < backward && dLeA < limit && dHeB < limit {
		return q.a, q.b, true
	}
	if backward < forward && dLeB < limit && dHeA < limit {
		return q.b, q.a, true
	}
	return le, he, false
}

// local is a metric frame centred on a point: metres east and north.
type local struct {
	origin           latLon
	mPerLat, mPerLon float64
}

func newLocal(o latLon) local {
	mLat, mLon := metrePerDeg(o.lat)
	return local{origin: o, mPerLat: mLat, mPerLon: mLon}
}

func (l local) to(p latLon) [2]float64 {
	return [2]float64{(p.lon - l.origin.lon) * l.mPerLon, (p.lat - l.origin.lat) * l.mPerLat}
}

// similarity is a rotation, a uniform scale and a translation, fitted by
// least squares from page points to metric ones (the Procrustes form).
type similarity struct {
	scos, ssin float64 // scale times cos / sin of the rotation
	tx, ty     float64
	resid      float64 // worst point residual, metres
}

func (s similarity) scale() float64 { return math.Hypot(s.scos, s.ssin) }

func (s similarity) apply(x, y float64) (float64, float64) {
	return s.scos*x - s.ssin*y + s.tx, s.ssin*x + s.scos*y + s.ty
}

func fitSimilarity(page, metric [][2]float64) *similarity {
	n := len(page)
	if n < 2 || n != len(metric) {
		return nil
	}
	var pcx, pcy, qcx, qcy float64
	for i := range page {
		pcx += page[i][0]
		pcy += page[i][1]
		qcx += metric[i][0]
		qcy += metric[i][1]
	}
	fn := float64(n)
	pcx, pcy, qcx, qcy = pcx/fn, pcy/fn, qcx/fn, qcy/fn
	var dot, cross, den float64
	for i := range page {
		px, py := page[i][0]-pcx, page[i][1]-pcy
		qx, qy := metric[i][0]-qcx, metric[i][1]-qcy
		dot += px*qx + py*qy
		cross += px*qy - py*qx
		den += px*px + py*py
	}
	if den < 1e-9 {
		return nil
	}
	s := similarity{scos: dot / den, ssin: cross / den}
	s.tx = qcx - (s.scos*pcx - s.ssin*pcy)
	s.ty = qcy - (s.ssin*pcx + s.scos*pcy)
	for i := range page {
		x, y := s.apply(page[i][0], page[i][1])
		if d := math.Hypot(x-metric[i][0], y-metric[i][1]); d > s.resid {
			s.resid = d
		}
	}
	return &s
}

var scaleBarRe = regexp.MustCompile(`^(\d+(?:[.,]\d+)?)\s*(m|km|NM)$`)

// scaleBarPtPerM reads the sheet's own scale bar: a rule with a tick at
// each end, a "0" under one and a distance under the other. It is the one
// measurement on the page that owes nothing to the runway fit, which is
// what makes it worth reading.
func scaleBarPtPerM(c pageContent, runs []textRun, within box) (float64, bool) {
	return scaleBarWithin(c, runs, within, minPtPerM, maxPtPerM)
}

// scaleBarWithin is the same reading at a stated range of scales. An
// aerodrome diagram and a hospital pad are three orders of magnitude apart,
// so the plausible window is the caller's to state: the one that keeps a
// runway table's "1250 x 80 m" out of a ground chart would refuse
// Abbeville's site plan, which is drawn at 1:1400.
func scaleBarWithin(c pageContent, runs []textRun, within box, lo, hi float64) (float64, bool) {
	type mark struct {
		x, y, m float64
	}
	var zeros, ends []mark
	for _, r := range runs {
		// A scale bar belongs to the panel it annotates. Without that,
		// every "0" on the sheet is paired against every distance label
		// anywhere else on it - a runway table's "1250 x 80 m", an
		// obstacle note, or the aerodrome diagram's own bar, which is
		// drawn to a quite different scale. A composite sheet carries two
		// bars and the wrong one is not a small error.
		if !within.holds([2]float64{r.x + r.adv/2, r.y}) {
			continue
		}
		t := strings.Join(strings.Fields(r.text), " ")
		if t == "0" {
			zeros = append(zeros, mark{x: r.x + r.adv/2, y: r.y})
			continue
		}
		m := scaleBarRe.FindStringSubmatch(t)
		if m == nil {
			continue
		}
		v, err := strconv.ParseFloat(strings.Replace(m[1], ",", ".", 1), 64)
		if err != nil || v <= 0 {
			continue
		}
		switch m[2] {
		case "km":
			v *= 1000
		case "NM":
			v *= 1852
		}
		ends = append(ends, mark{x: r.x + r.adv/2, y: r.y, m: v})
	}
	best, span, ok := 0.0, 0.0, false
	for _, z := range zeros {
		for _, e := range ends {
			if math.Abs(e.y-z.y) > 2 {
				continue
			}
			d := math.Abs(e.x - z.x)
			if d < 20 || e.m <= 0 {
				continue
			}
			// THE BAR IS THE INK, NOT THE LABELS. The far label carries
			// its unit, so its centre stands to the right of the end it
			// names by half of " m" or " km", and the bar reads that much
			// LONG: over the 1043 bars the corpus draws a rule for, the
			// median reading was 2.5 % long, the worst twentieth 9 % and
			// the worst of all nearly double. A panel placed on that is
			// drawn that much small.
			if ink, got := barInk(c, z.x, e.x, z.y, within); got {
				d = ink
			}
			r := d / e.m
			if r < lo || r > hi {
				continue
			}
			// The longest bar on the sheet is the scale bar; a stray
			// pair is short. Comparing d against best*e.m did not say
			// that: best is a RATIO, so the test reduced to r > best and
			// kept the largest points-per-metre instead of the longest
			// span. Every misread therefore biased the bar upwards, and
			// the deviation it feeds negative, which is the -50 % to
			// -80 % skew the corpus showed against fits the runway
			// confirms to a metre.
			if d > span || !ok {
				best, span, ok = r, d, true
			}
		}
	}
	return best, ok
}

// barInk measures the rule a scale bar is drawn as: a horizontal stroke
// within a line of the labels, its two ends standing at the two of them.
//
// The labels say WHICH end is zero and what the other is worth, exactly as
// a graticule's labels say which arcminute a tick is; the rule says how
// long the thing is. Where no rule can be found the caller keeps the
// label span, which is a reading with a known bias rather than none.
func barInk(c pageContent, zx, ex, y float64, within box) (float64, bool) {
	lo, hi := math.Min(zx, ex), math.Max(zx, ex)
	span := hi - lo
	best, bestErr := 0.0, math.MaxFloat64
	for _, s := range c.segs {
		if math.Abs(s.y2-s.y1) > 0.4 {
			continue
		}
		my := (s.y1 + s.y2) / 2
		// The rule sits on the labels' own line, a little above or below.
		if my > y+4 || my < y-20 || !within.holds([2]float64{(s.x1 + s.x2) / 2, my}) {
			continue
		}
		l := s.length()
		if l < span*0.55 || l > span*1.45 {
			continue
		}
		a, b := math.Min(s.x1, s.x2), math.Max(s.x1, s.x2)
		// Each end has to stand at its own label, or the stroke is some
		// other rule that happens to be the right length.
		e := math.Abs(a-lo) + math.Abs(b-hi)
		if e > 0.5*span || e > 24 {
			continue
		}
		if e < bestErr {
			best, bestErr = l, e
		}
	}
	return best, bestErr < math.MaxFloat64
}

// frameOnly is the sheet's drawn frame, for a page with no graticule to
// bound. The page-sized clip every plate opens with is not one.
//
// It reads `re` rectangles alone, and that was measured rather than left
// alone. Offering it every closed path that fills its own bounding box, the
// reading the pad sheets use, finds a TIGHTER box on six of these pages, and
// the tighter box is inside the neatline: it crops real chart off the sheet.
// docs/fr-vacgeo-coverage.md, "The frame readers", has the plates.
func frameOnly(c pageContent) *box {
	var best *box
	for _, b := range c.rects {
		if !framePlausible(c, b) {
			continue
		}
		if best == nil || b.width()*b.height() > best.width()*best.height() {
			b := b
			best = &b
		}
	}
	return best
}

// framePlausible is the size a frame has to be on THIS page to be a frame:
// most of the sheet in both directions, and not the sheet itself.
func framePlausible(c pageContent, b box) bool {
	if b.width() < c.media.width()*0.4 || b.height() < c.media.height()*0.3 {
		return false
	}
	sheet := c.media.width() * c.media.height()
	return sheet <= 0 || b.width()*b.height() <= sheet*0.95
}

// fitRunway places a graticule-less sheet from the runways it draws.
func fitRunway(c pageContent, rwys []runwayRef, arp latLon) (*panelFit, string) {
	if len(rwys) == 0 {
		return nil, "no-runways"
	}
	quads := runwayQuads(c)
	if len(quads) == 0 {
		return nil, "no-quad"
	}
	runs := dedupeRuns(c.runs)
	frame := frameOnly(c)
	if frame == nil {
		// A frame drawn as four bare strokes that close nothing is
		// invisible even to closedFrames. The graticule path has carried
		// a fallback for exactly that since the beginning (strokeFrame),
		// and the runways stand in for the ticks as the box the frame has
		// to bracket.
		//
		// That substitution is also why the answer is checked. strokeFrame
		// measures "long" against the box it is given, and the drawn
		// runways are a fraction of the sheet, so on a ground-movement
		// chart almost any rule is long enough to qualify and the
		// innermost-wins rule will take a taxiway edge or a table rule. It
		// would not be refused: it would become the panel's published clip
		// and the window the scale bar is read in. A frame this small is
		// not a frame, and saying so loses a panel where taking it would
		// have got one wrong.
		if f := strokeFrame(c, quadsBox(quads)); f != nil && framePlausible(c, *f) {
			frame = f
		}
	}
	if frame == nil {
		return nil, "neatline"
	}
	// A ground chart may be three charts. Le Luc Le Cannet stacks its
	// aerodrome diagram over two configuration diagrams and a text block
	// inside ONE drawn frame, which is the structure the pad sheets have
	// and `stackedPanels` already cuts: the rules across the frame are the
	// cuts. Publishing the sheet's outer frame would carry the two insets,
	// drawn at their own scale and each holding its own copy of both
	// runways, onto the ground south of the field.
	//
	// The band to keep is the one holding the LONGEST drawn runway, which
	// is the sheet's own diagram: an inset is a smaller copy by
	// construction. The extent of ALL the quads is no use here, since the
	// insets draw runways too and their box is the whole sheet.
	if bands := stackedPanels(c); len(bands) > 1 {
		for _, b := range bands {
			if !b.holds(quads[0].a) || !b.holds(quads[0].b) {
				continue
			}
			var keep []quad
			for _, q := range quads {
				if b.holds(q.a) && b.holds(q.b) {
					keep = append(keep, q)
				}
			}
			frame, quads = &b, keep
			break
		}
	}
	fr := newLocal(arp)

	// Match every drawn shape that could be a runway to the runway whose
	// proportions it shares, and keep the pairs the designators confirm.
	type pair struct {
		page   [2][2]float64
		metric [2][2]float64
		lenPt  float64
	}
	var pairs []pair
	used := map[string]bool{}
	for _, q := range quads {
		for _, r := range rwys {
			if used[r.le+"/"+r.he] || r.aspect() <= 0 {
				continue
			}
			if math.Abs(q.aspect()/r.aspect()-1) > maxAspectMismatch {
				continue
			}
			le, he, ok := orient(runs, q, r)
			if !ok {
				continue
			}
			used[r.le+"/"+r.he] = true
			pairs = append(pairs, pair{
				page:   [2][2]float64{le, he},
				metric: [2][2]float64{fr.to(r.lePos), fr.to(r.hePos)},
				lenPt:  q.length,
			})
			break
		}
	}
	if len(pairs) == 0 {
		return nil, "no-match"
	}

	var page, metric [][2]float64
	for _, p := range pairs {
		page = append(page, p.page[0], p.page[1])
		metric = append(metric, p.metric[0], p.metric[1])
	}
	sim := fitSimilarity(page, metric)
	if sim == nil {
		return nil, "degenerate"
	}
	// The scale comes out as metres per point; the sheet's own units are
	// the other way round.
	mPerPt := sim.scale()
	if mPerPt <= 0 {
		return nil, "degenerate"
	}
	ptPerM := 1 / mPerPt
	if ptPerM < minPtPerM || ptPerM > maxPtPerM {
		return nil, "scale"
	}
	// With one runway the fit is exact and its residual says nothing; with
	// two it is the real check.
	if len(pairs) > 1 && sim.resid > maxCrossResidM {
		return nil, "cross"
	}
	scaleDev := 0.0
	if bar, ok := scaleBarPtPerM(c, runs, *frame); ok {
		scaleDev = ptPerM/bar - 1
		if math.Abs(scaleDev) > maxScaleDev {
			return nil, "scale-bar"
		}
	}

	geo := geoAffine{
		A: sim.scos / fr.mPerLon, C: -sim.ssin / fr.mPerLon,
		E: arp.lon + sim.tx/fr.mPerLon,
		B: sim.ssin / fr.mPerLat, D: sim.scos / fr.mPerLat,
		F: arp.lat + sim.ty/fr.mPerLat,
	}
	return &panelFit{
		Clip:     *frame,
		Geo:      geo,
		Method:   "runway",
		Runways:  len(pairs),
		ResidM:   sim.resid,
		ScaleDev: scaleDev * 100,
		PtPerNM:  ptPerM * 1852,
	}, ""
}

// How far the two ends may still miss after the panel has been shifted onto
// its runway. A translation cannot fix a wrong scale or a wrong rotation, so
// what survives it is evidence about those, and a panel whose graticule
// disagrees with its own runway about the SHAPE of the ground is not one to
// correct: it is one to disown.
const maxAnchorResidM = 45

// And how far it may move the panel, as a share of the runway it matched.
//
// The rule under "smallest move wins" is that the graticule has already
// placed the panel to within its own error, so a candidate asking for a
// kilometre is contradicting the grid. That was a tiebreak and it needed to
// be a refusal too: where only ONE shape answers, it wins whatever it asks
// for, and Florac Sainte-Enimie's crossing pair asked for 801 m and got it,
// carrying a panel that read 1.2 m against the ground out to 97.7.
//
// A whole runway length is the bound, because that is the distance at which
// "the same strip, placed a little wrong" becomes "a different strip". The
// corpus agrees at both ends: at one length it takes Florac's anchor back
// and touches nothing else, 1 panel better and 0 worse; at half a length it
// also takes Ussel Thalamy's, which moves 827 m and is RIGHT, and
// that panel falls from 27.6 m against the ground to 137.0.
const maxAnchorMoveFrac = 1.00

// runwayAnchor corrects a graticule-fitted panel against the runway the
// plate draws ON it, which is evidence the graticule fit had no part in.
//
// It moves the panel and nothing else. The graticule reads the SCALE to
// about a metre and the conformal check confirms it, so the scale and the
// rotation are the parts of a graticule fit worth keeping; what a misread
// label or a mis-phased comb ruins is WHERE the panel sits, and that is one
// translation. One runway gives two points and a translation needs one, so
// the fit is over-determined and what is left over is a real check.
//
// This is the check the ARP gate cannot make. That gate asks whether the
// aerodrome falls somewhere on the panel, with a margin, so on a sheet
// kilometres across it catches a misread degree and nothing finer. A runway
// is a metre-accurate published position drawn on the same paper.
//
// It does NOT need the designators fitRunway insists on, and the reason is
// worth stating: that rule exists because two points fix a similarity in
// two ways and nothing geometric tells a half-turn apart. Here the
// graticule has already fixed the rotation, so the half-turn is not free,
// it is a thousand-metre residual. What confirms the match instead is that
// the drawn shape, once moved, lies along the published runway end to end
// within a few tens of metres: a taxiway of the right proportions does not
// also have the right length AND the right bearing to that tolerance.
// Requiring designators here would have refused Lognes, whose landing
// panel draws its runway and prints the designators on the aerodrome
// diagram below it.
//
// THERE IS ONE THING THE GEOMETRY CANNOT SAY, and it is the reason a drawn
// shape is asked which runway it is wherever the plate says so. An
// aerodrome with two PARALLEL runways of one length publishes two
// centrelines a drawn strip answers equally well: same length, same
// bearing, same proportions, and residuals that agree to the centimetre.
// Besancon Thise draws its 06L and the anchor put it on the published 06R,
// seventy-three metres south, and reported a residual of 0.7 m for it,
// because that residual is measured against the runway the anchor chose.
// What separated them was printed on the sheet the whole time: "06L" six
// points from that strip's end and "06R" fourteen.
// designatorNear is designatorAt measured from the label's CENTRE. orient
// compares one label's distance against another's and the origin serves it
// fine; telling two labels a few points apart from each other does not
// survive half a label's width of bias.
func designatorNear(runs []textRun, desig string, near [2]float64) (float64, bool) {
	want := strings.TrimSpace(desig)
	best := math.MaxFloat64
	for _, r := range runs {
		if strings.TrimSpace(r.text) != want {
			continue
		}
		if d := math.Hypot(r.x+r.adv/2-near[0], r.y-near[1]); d < best {
			best = d
		}
	}
	return best, best < math.MaxFloat64
}

// namedRunway asks which published runway the plate prints beside a drawn
// shape's OWN ENDS. The nearest designator to each end names a runway, and
// the shape is that runway only when both ends agree.
//
// Nearest, and not "printed somewhere near", because on a parallel pair the
// two sets of labels sit a few points apart: at Besancon Thise "06L" is 6.8
// points from the strip the reader found and "06R" is 14.3, which is the
// seventy-three metres between the two centrelines drawn to scale.
func namedRunway(runs []textRun, q quad, rwys []runwayRef) (int, bool) {
	// A label half the runway away is not a label for that end.
	limit := q.length * 0.45
	at := func(p [2]float64) (int, bool) {
		best, which := limit, -1
		for i, r := range rwys {
			for _, d := range []string{r.le, r.he} {
				if got, ok := designatorNear(runs, d, p); ok && got < best {
					best, which = got, i
				}
			}
		}
		if which < 0 {
			return 0, false
		}
		// And the nearest label has to be CLEARLY the nearest. Arcachon La
		// Teste prints "07" for its grass strip and "07R" for the hard one
		// within a few points of each other, and a name read off that pair
		// names whichever the rounding favoured. A name that close to
		// another runway's name is not a name. Twice as near, because
		// Besancon's pair answers at 2.3 and Arcachon's at less.
		for i, r := range rwys {
			if i == which {
				continue
			}
			for _, d := range []string{r.le, r.he} {
				if got, ok := designatorNear(runs, d, p); ok && got < best*2 {
					return 0, false
				}
			}
		}
		return which, true
	}
	// ONE clear label is enough, and asking for two is asking too much: at
	// the far end of a parallel pair both names are a long way off and a
	// few points apart, so that end can never speak clearly. What it may
	// not do is contradict the end that can.
	ia, oka := at(q.a)
	ib, okb := at(q.b)
	switch {
	case oka && okb && ia != ib:
		return 0, false
	case oka:
		return ia, true
	case okb:
		return ib, true
	}
	return 0, false
}

func runwayAnchor(c pageContent, fit *panelFit, rwys []runwayRef) (dLat, dLon, resid float64, ok bool) {
	if fit == nil || len(rwys) == 0 {
		return 0, 0, 0, false
	}
	runs := dedupeRuns(c.runs)
	bestMove, bestResid := math.MaxFloat64, math.MaxFloat64
	for _, q := range runwayQuads(c) {
		// The shape has to be ON this panel: an ATT page is composite, and
		// the aerodrome diagram below it is drawn at its own scale.
		if !fit.Clip.holds(q.a) || !fit.Clip.holds(q.b) {
			continue
		}
		named, isNamed := namedRunway(runs, q, rwys)
		for ri, r := range rwys {
			// Where the plate names the strip, the name VETOES. It does
			// not enable: a name is read off whichever label happens to
			// be nearest an end, and on a busy sheet that is weaker
			// evidence than the geometry it would be overruling. What it
			// is strong enough to do is refuse, because a plate that
			// prints "06L" beside a strip has said that strip is not the
			// 06R, however well the 06R's proportions answer.
			if isNamed && ri != named {
				continue
			}
			if r.lengthM() <= 0 || r.aspect() <= 0 {
				continue
			}
			// Where the plate names the strip, its proportions still have
			// to answer. Exempting a named runway from the aspect test,
			// and halving the test's strictness for one, were both
			// measured: they restore Arcachon La Teste's anchor and cost
			// more than they buy, because a name says WHICH runway and
			// says nothing about which shape on the page is a runway.
			// Measured against the ground over the corpus, the exemption
			// is 4 panels better and 6 worse, 121 metres of disagreement
			// ADDED, with one panel falling from 6.4 m out to 87.4 on an
			// anchor whose own residual is a metre.
			if math.Abs(q.aspect()/r.aspect()-1) > maxAspectMismatch {
				continue
			}
			for _, o := range [2][2][2]float64{{q.a, q.b}, {q.b, q.a}} {
				aLat, aLon := fit.Geo.at(o[0][0], o[0][1])
				bLat, bLon := fit.Geo.at(o[1][0], o[1][1])
				// A shape whose mapped length is not the runway's length is
				// not the runway, whatever its proportions suggest.
				drawn := latLon{aLat, aLon}.dist(latLon{bLat, bLon})
				if math.Abs(drawn/r.lengthM()-1) > 0.15 {
					continue
				}
				// The shift that puts the drawn runway on the published one.
				sLat := (r.lePos.lat + r.hePos.lat - aLat - bLat) / 2
				sLon := (r.lePos.lon + r.hePos.lon - aLon - bLon) / 2
				// What the shift cannot fix: scale and rotation, read off
				// the ends once the panel is where it belongs. This is also
				// what tells the two orderings apart, by a factor of a
				// hundred, where no designator is printed to do it.
				e1 := latLon{aLat + sLat, aLon + sLon}.dist(r.lePos)
				e2 := latLon{bLat + sLat, bLon + sLon}.dist(r.hePos)
				res := math.Max(e1, e2)
				if res < bestResid {
					// Kept whatever happens, so a refusal can still say
					// how far off the best shape on the sheet was.
					bestResid = res
					if !ok {
						resid = res
					}
				}
				if res > maxAnchorResidM {
					continue
				}
				// Among the shapes that ANSWER a runway, the one that
				// moves the panel LEAST is the one to believe.
				//
				// A residual says how WELL a shape answers a runway. It
				// does not say the shape IS that runway, and on a busy
				// sheet the smallest residual is regularly won by a
				// taxiway or an apron edge of about the right length lying
				// somewhere else: Saint-Cyr l'Ecole's sheet was carried
				// 873 m by a shape east of the runway answering within
				// 14 m where the runway itself answered 43. The graticule
				// has already placed the panel to within its own error, so
				// a candidate asking for a kilometre is contradicting the
				// grid, and a candidate asking for eighty metres is
				// agreeing with it.
				move := latLon{aLat, aLon}.dist(latLon{aLat + sLat, aLon + sLon})
				if move > r.lengthM()*maxAnchorMoveFrac {
					continue
				}
				if !ok || move < bestMove {
					bestMove = move
					dLat, dLon, resid, ok = sLat, sLon, res, true
				}
			}
		}
	}
	if !ok {
		// Nothing on the panel resembles its own runway closely enough to
		// be it. Say so, with the best miss, rather than move the panel
		// onto a guess.
		return 0, 0, resid, false
	}
	return dLat, dLon, resid, ok
}
