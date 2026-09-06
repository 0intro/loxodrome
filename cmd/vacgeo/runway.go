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
		lo, hi := math.MaxFloat64, 0.0
		var ai, bi int
		for i := 0; i+3 < len(p.pts); i += 2 {
			d := math.Hypot(p.pts[i+2]-p.pts[i], p.pts[i+3]-p.pts[i+1])
			if d > hi {
				hi, ai, bi = d, i, i+2
			}
			if d < lo && d > 0.05 {
				lo = d
			}
		}
		if hi < minRunwayLenPt || lo == math.MaxFloat64 || hi/lo < minRunwayAspect {
			continue
		}
		out = append(out, quad{
			a:      [2]float64{p.pts[ai], p.pts[ai+1]},
			b:      [2]float64{p.pts[bi], p.pts[bi+1]},
			length: hi,
			width:  lo,
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
	const mPerDeg = 111320.0
	return local{origin: o, mPerLat: mPerDeg, mPerLon: mPerDeg * math.Cos(o.lat*math.Pi/180)}
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

// scaleBarPtPerM reads the sheet's own scale bar: a "0" and a distance
// label on one baseline, the points between them spanning that distance.
// It is the one measurement on the page that owes nothing to the runway
// fit, which is what makes it worth reading.
func scaleBarPtPerM(runs []textRun, within box) (float64, bool) {
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
			r := d / e.m
			if r < minPtPerM || r > maxPtPerM {
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

// frameOnly is the sheet's drawn frame, for a page with no graticule to
// bound. The page-sized clip every plate opens with is not one.
func frameOnly(c pageContent) *box {
	var best *box
	sheet := c.media.width() * c.media.height()
	for i := range c.rects {
		b := c.rects[i]
		if b.width() < c.media.width()*0.4 || b.height() < c.media.height()*0.3 {
			continue
		}
		if sheet > 0 && b.width()*b.height() > sheet*0.95 {
			continue
		}
		if best == nil || b.width()*b.height() > best.width()*best.height() {
			b := b
			best = &b
		}
	}
	return best
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
		// A frame drawn as four strokes rather than one rectangle is
		// invisible to frameOnly, which only ever sees what the `re`
		// operator recorded. The graticule path has carried a fallback
		// for exactly that since the beginning (strokeFrame); this one
		// never did, and 22 sheets were refused for having their neatline
		// drawn the other way. The runways stand in for the ticks as the
		// box the frame has to bracket.
		frame = strokeFrame(c, quadsBox(quads))
	}
	if frame == nil {
		return nil, "neatline"
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
	if bar, ok := scaleBarPtPerM(runs, *frame); ok {
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
func runwayAnchor(c pageContent, fit *panelFit, rwys []runwayRef) (dLat, dLon, resid float64, ok bool) {
	if fit == nil || len(rwys) == 0 {
		return 0, 0, 0, false
	}
	best := math.MaxFloat64
	for _, q := range runwayQuads(c) {
		// The shape has to be ON this panel: an ATT page is composite, and
		// the aerodrome diagram below it is drawn at its own scale.
		if !fit.Clip.holds(q.a) || !fit.Clip.holds(q.b) {
			continue
		}
		for _, r := range rwys {
			if r.lengthM() <= 0 || r.aspect() <= 0 ||
				math.Abs(q.aspect()/r.aspect()-1) > maxAspectMismatch {
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
				if res < best {
					best = res
					dLat, dLon, resid, ok = sLat, sLon, res, true
				}
			}
		}
	}
	if ok && resid > maxAnchorResidM {
		// Nothing on the panel resembles its own runway closely enough to
		// be it. Say so rather than move the panel onto a guess.
		return 0, 0, resid, false
	}
	return dLat, dLon, resid, ok
}
