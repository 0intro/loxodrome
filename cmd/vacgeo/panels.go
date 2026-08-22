// panels.go turns one drawn page into a georeference: which rectangle of it
// is a map, and what latitude and longitude each point of that rectangle is.
//
// The evidence is the graticule TICKS, not the labels. A tick is a short
// axis-aligned segment anchored on the neatline (the APP sheets) or
// straddling an internal parallel or meridian (the ATT sheets), and a
// panel's ticks form a regular comb: identical marks, evenly spaced, all
// starting from the same edge. Fitting that comb reads the scale to about a
// hundredth of a point, which is a metre and a half on the ground; fitting
// the labels instead reads it to a few percent, which is a hundred metres.
//
// The projection is the other half of the evidence. These plates are drawn
// in a conformal conic (the measured cone constant is 0.723, Lambert-93's is
// 0.7256), so the two axes are not independent: one arcminute of latitude
// and one of longitude must stand in the ratio
//
//	sec(phi) * M/N
//
// where M/N is the ellipsoid's meridian-to-prime-vertical curvature ratio,
// 0.9971 at French latitudes. That identity is worth as much as a second
// comb: when the two axes disagree, the better-populated one is right and
// the other is re-fitted at the step the projection demands. It is what
// makes a panel with three latitude ticks and twelve longitude ticks come
// out as accurate as one with twelve of each.

package main

import (
	"math"
	"sort"
)

// hemisphere carries the signs the graticule labels leave off, +1 for north
// and east, -1 for south and west.
type hemisphere struct{ lat, lon float64 }

// wgs84E2 is the WGS84 first eccentricity squared.
const wgs84E2 = 0.00669437999014

// axisRatio is the points-per-arcminute ratio a conformal projection on the
// ellipsoid imposes between the latitude and longitude axes at a latitude.
func axisRatio(latDeg float64) float64 {
	s := math.Sin(latDeg * math.Pi / 180)
	mOverN := (1 - wgs84E2) / (1 - wgs84E2*s*s)
	return mOverN / math.Cos(latDeg*math.Pi/180)
}

// Tick geometry bounds. A graticule tick is a short mark; anything longer is
// map furniture, anything shorter is a dot on a symbol.
const (
	tickMin = 1.5
	tickMax = 15.0
	// A segment counts as axis-aligned within this many points of drift
	// over its length.
	tickSkew = 0.35
)

// tickSet is one family of ticks: marks that share a cross-axis anchor, so
// they all spring from the same edge or the same internal graticule line.
type tickSet struct {
	anchor float64 // where the family springs from, cross-axis
	pos    []float64
}

// tickFamilies groups the page's short axis-aligned segments by the edge
// they spring from. horizontal=true collects horizontal marks, whose
// positions are latitudes and whose anchor is an x.
//
// Ticks are clustered three ways, by their near end, their far end and
// their middle, because the corpus draws them both ways round. A tick
// hanging off a neatline shares its near end with its family and nothing
// else; a tick STRADDLING an internal graticule line shares its middle,
// and its ends wander by a point or two because the SIA does not draw them
// all the same length. Keying on one of the three splits the other kind
// into singletons, and the comb fit then has nothing to work with. Trying
// all three costs one pass and lets fitComb arbitrate.
func tickFamilies(segs []seg, horizontal bool) []tickSet {
	type mark struct{ near, far, mid, pos float64 }
	var marks []mark
	for _, s := range segs {
		l := s.length()
		if l < tickMin || l > tickMax {
			continue
		}
		dx, dy := math.Abs(s.x2-s.x1), math.Abs(s.y2-s.y1)
		if horizontal {
			if dy > tickSkew {
				continue
			}
			lo, hi := math.Min(s.x1, s.x2), math.Max(s.x1, s.x2)
			marks = append(marks, mark{near: lo, far: hi, mid: (lo + hi) / 2, pos: (s.y1 + s.y2) / 2})
		} else {
			if dx > tickSkew {
				continue
			}
			lo, hi := math.Min(s.y1, s.y2), math.Max(s.y1, s.y2)
			marks = append(marks, mark{near: lo, far: hi, mid: (lo + hi) / 2, pos: (s.x1 + s.x2) / 2})
		}
	}
	var out []tickSet
	for _, key := range []func(mark) float64{
		func(m mark) float64 { return m.near },
		func(m mark) float64 { return m.far },
		func(m mark) float64 { return m.mid },
	} {
		ms := append([]mark(nil), marks...)
		sort.Slice(ms, func(i, j int) bool { return key(ms[i]) < key(ms[j]) })
		for i := 0; i < len(ms); {
			j := i
			for j < len(ms) && key(ms[j])-key(ms[i]) < 1.5 {
				j++
			}
			set := tickSet{anchor: key(ms[i])}
			for _, m := range ms[i:j] {
				set.pos = append(set.pos, m.pos)
			}
			sort.Float64s(set.pos)
			if len(set.pos) >= 2 {
				out = append(out, set)
			}
			i = j
		}
	}
	return out
}

// combFit is a regular comb of ticks: a step, the position of its index 0,
// how many ticks fell on it and how far off they were.
type combFit struct {
	step   float64
	p0     float64
	n      int
	rms    float64
	anchor float64
	lo, hi float64 // the comb's own extent
}

// fitComb finds the best regular comb in a candidate list, with the step
// constrained to the neighbourhood of the label-derived scale. Ticks may be
// printed every arcminute or every half one, so the search allows a step of
// seed or seed/2 and nothing finer: a comb at seed/4 would also "fit", with
// three times the inliers and a scale three times wrong.
func fitComb(cands []float64, seed float64) *combFit {
	if len(cands) < 3 || seed <= 0 {
		return nil
	}
	c := append([]float64(nil), cands...)
	sort.Float64s(c)
	if len(c) > 400 {
		c = c[:400]
	}
	lo, hi := seed*0.42, seed*1.15
	const tol = 0.8
	type best struct {
		n     int
		err   float64
		picks []pick
		step  float64
	}
	var bst *best
	step := 1
	if len(c) > 80 {
		step = len(c) / 80
	}
	for i := 0; i < len(c); i += step {
		for j := i + 1; j < len(c); j++ {
			d := c[j] - c[i]
			if d < lo {
				continue
			}
			if d > hi*2.05 {
				break
			}
			for k := 1; k <= 2; k++ {
				st := d / float64(k)
				if st < lo || st > hi {
					continue
				}
				picks := map[int]float64{}
				errs := map[int]float64{}
				for _, v := range c {
					idx := int(math.Round((v - c[i]) / st))
					e := math.Abs(c[i] + float64(idx)*st - v)
					if e >= tol {
						continue
					}
					if prev, ok := errs[idx]; !ok || e < prev {
						picks[idx], errs[idx] = v, e
					}
				}
				if len(picks) < 3 {
					continue
				}
				sorted := sortedPicks(picks)
				kmin, kmax := sorted[0].k, sorted[len(sorted)-1].k
				total := 0.0
				for _, sp := range sorted {
					total += errs[sp.k]
				}
				// The comb must be mostly filled: a handful of marks
				// that happen to land on a wide grid is not a graticule.
				if kmax-kmin+1 > len(picks)*2 {
					continue
				}
				if bst == nil || len(sorted) > bst.n || (len(sorted) == bst.n && total < bst.err) {
					bst = &best{n: len(sorted), err: total, picks: sorted, step: st}
				}
			}
		}
	}
	if bst == nil {
		return nil
	}
	return refine(bst.picks)
}

// pick is one tick matched to its comb index.
type pick struct {
	k int
	v float64
}

// sortedPicks flattens the match map into index order. Go randomises map
// iteration and floating-point addition is not associative, so summing the
// least squares straight off the map makes the fit depend on the run: a
// panel near a gate threshold would then appear and disappear between
// builds, and the artifact would never be byte-identical.
func sortedPicks(m map[int]float64) []pick {
	out := make([]pick, 0, len(m))
	for k, v := range m {
		out = append(out, pick{k: k, v: v})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].k < out[j].k })
	return out
}

// refine least-squares a set of index -> position picks into a step and an
// origin, and measures how well the comb actually holds.
func refine(picks []pick) *combFit {
	n := float64(len(picks))
	if n == 0 {
		return nil
	}
	var sk, sv, skk, skv float64
	lo, hi := math.MaxFloat64, -math.MaxFloat64
	for _, p := range picks {
		fk := float64(p.k)
		sk += fk
		sv += p.v
		skk += fk * fk
		skv += fk * p.v
		lo, hi = math.Min(lo, p.v), math.Max(hi, p.v)
	}
	den := n*skk - sk*sk
	if math.Abs(den) < 1e-9 {
		return nil
	}
	step := (n*skv - sk*sv) / den
	p0 := (sv - step*sk) / n
	var sq float64
	for _, p := range picks {
		d := p0 + float64(p.k)*step - p.v
		sq += d * d
	}
	return &combFit{step: step, p0: p0, n: len(picks), rms: math.Sqrt(sq / n), lo: lo, hi: hi}
}

// fitPhase re-fits a comb whose STEP is already known, which is what the
// conformal constraint hands back: only the origin is still free.
func fitPhase(cands []float64, step float64) *combFit {
	if len(cands) < 2 || step <= 0 {
		return nil
	}
	c := append([]float64(nil), cands...)
	sort.Float64s(c)
	if len(c) > 400 {
		c = c[:400]
	}
	const tol = 0.6
	var bst []pick
	for _, anchor := range c {
		picks := map[int]float64{}
		errs := map[int]float64{}
		for _, v := range c {
			idx := int(math.Round((v - anchor) / step))
			e := math.Abs(anchor + float64(idx)*step - v)
			if e >= tol {
				continue
			}
			if prev, ok := errs[idx]; !ok || e < prev {
				picks[idx], errs[idx] = v, e
			}
		}
		if len(picks) < 2 {
			continue
		}
		sorted := sortedPicks(picks)
		kmin, kmax := sorted[0].k, sorted[len(sorted)-1].k
		if kmax-kmin+1 > len(sorted)*2 {
			continue
		}
		if len(sorted) > len(bst) {
			bst = sorted
		}
	}
	if bst == nil {
		return nil
	}
	f := refine(bst)
	if f != nil {
		f.step = step
	}
	return f
}

// assignment ties a comb to real coordinates: how many arcminutes one tick
// is worth, and the value at the comb's own origin.
type assignment struct {
	perTick float64
	at0     float64
	err     float64
}

// niceSteps are the graticule intervals the SIA prints, in arcminutes.
var niceSteps = []float64{0.25, 0.5, 1, 2, 5, 10, 15, 30, 60}

// assign works out what each tick of a comb is worth by dropping the labels
// onto it.
//
// With ppm <= 0 the tick interval comes from two labels, which is what most
// panels carry. With ppm set, the interval is already known from the other
// axis through the conformal constraint and ONE label is enough: it fixes
// the offset only. That is what a panel naming its latitude once needs, and
// it is safe only because a wrong offset moves the whole panel by whole
// arcminutes, which the ARP gate in build.go then throws out.
func assign(f *combFit, labels []label, lon bool, ppm float64) *assignment {
	type obs struct {
		k int
		v float64
	}
	var os []obs
	for _, l := range labels {
		p := l.y
		if lon {
			p = l.x
		}
		q := (p - f.p0) / f.step
		if math.Abs(q-math.Round(q)) > 0.45 {
			continue
		}
		os = append(os, obs{k: int(math.Round(q)), v: l.min})
	}
	need := 2
	if ppm > 0 {
		need = 1
	}
	if len(os) < need {
		return nil
	}
	sort.Slice(os, func(i, j int) bool { return os[i].k < os[j].k })
	var per float64
	switch {
	case ppm > 0:
		per = f.step / ppm
	default:
		dk := os[len(os)-1].k - os[0].k
		dv := os[len(os)-1].v - os[0].v
		if dk == 0 {
			return nil
		}
		per = dv / float64(dk)
	}
	nice := niceSteps[0]
	for _, s := range niceSteps {
		if math.Abs(s-math.Abs(per)) < math.Abs(nice-math.Abs(per)) {
			nice = s
		}
	}
	if math.Abs(math.Abs(per)-nice) > nice*0.15 {
		return nil
	}
	if per == 0 {
		return nil
	}
	per = math.Copysign(nice, per)
	var sum float64
	for _, o := range os {
		sum += o.v - float64(o.k)*per
	}
	at0 := sum / float64(len(os))
	worst := 0.0
	for _, o := range os {
		worst = math.Max(worst, math.Abs(at0+float64(o.k)*per-o.v))
	}
	return &assignment{perTick: per, at0: at0, err: worst}
}

// geoAffine maps a page point to a position:
//
//	lon = A*x + C*y + E
//	lat = B*x + D*y + F
//
// Six coefficients rather than two scales and two origins, because a
// ground-movement chart is ROTATED: LFPL's is turned about 75 degrees, its
// runway drawn up the page. A graticule panel is the special case where B
// and C are zero, and the app re-applies the same six numbers either way.
type geoAffine struct {
	A, B, C, D, E, F float64
}

func (g geoAffine) at(x, y float64) (lat, lon float64) {
	return g.B*x + g.D*y + g.F, g.A*x + g.C*y + g.E
}

// northUp builds the axis-aligned case from a scale and a reference point
// per axis.
func northUp(yRef, latAt0, degLatPerPt, xRef, lonAt0, degLonPerPt float64) geoAffine {
	return geoAffine{
		A: degLonPerPt, B: 0,
		C: 0, D: degLatPerPt,
		E: lonAt0 - xRef*degLonPerPt,
		F: latAt0 - yRef*degLatPerPt,
	}
}

// panelFit is one georeferenced panel of one page.
type panelFit struct {
	Clip    box
	Geo     geoAffine
	LatN    int
	LonN    int
	LatRMS  float64
	LonRMS  float64
	DevPct  float64
	Forced  string // which axis the conformal constraint re-fitted, if any
	PtPerNM float64
	// Set by the runway fit instead of the graticule one.
	Method   string
	Runways  int
	ResidM   float64
	ScaleDev float64
	// Set when the drawn runway moved a graticule fit onto its own ground:
	// how far it moved, and what the two ends still missed by afterwards.
	AnchorM      float64
	AnchorResidM float64
}

// corners returns the panel's four clip corners as positions, which a
// rotated panel needs and an axis-aligned one gets right for free.
func (f *panelFit) corners() [4][2]float64 {
	var out [4][2]float64
	pts := [4][2]float64{
		{f.Clip.x0, f.Clip.y0}, {f.Clip.x1, f.Clip.y0},
		{f.Clip.x1, f.Clip.y1}, {f.Clip.x0, f.Clip.y1},
	}
	for i, p := range pts {
		lat, lon := f.Geo.at(p[0], p[1])
		out[i] = [2]float64{lat, lon}
	}
	return out
}

// bounds is the panel's axis-aligned geographic envelope, which is what the
// map layer culls on and what a rotated panel does not get from two
// corners.
func (f *panelFit) bounds() (south, west, north, east float64) {
	c := f.corners()
	south, north = c[0][0], c[0][0]
	west, east = c[0][1], c[0][1]
	for _, p := range c[1:] {
		south, north = math.Min(south, p[0]), math.Max(north, p[0])
		west, east = math.Min(west, p[1]), math.Max(east, p[1])
	}
	return
}

// fitPanel reads one page's georeference. It returns nil when the page
// carries no graticule this command can read, which is the normal answer for
// a text page, a parking chart or an aerodrome diagram, together with the
// stage that gave up: a corpus of a thousand pages is only improvable if a
// failure says which of the five steps it failed at.
func fitPanel(c pageContent, hemi hemisphere) (*panelFit, string) {
	labels := parseLabels(c.runs)
	// The graticule prints no hemisphere: Brest's western meridians are
	// labelled "004° 20'" exactly as Lyon's eastern ones are. The plate
	// states its own in the header ARP, so that is where the sign comes
	// from. Without it a Breton chart lands in Champagne, fitting
	// perfectly, which is precisely the failure the gate exists to catch
	// and precisely the one worth not making.
	for i := range labels {
		if labels[i].lon {
			labels[i].min *= hemi.lon
		} else {
			labels[i].min *= hemi.lat
		}
	}
	lats := pickAxis(labels, false)
	lons := pickAxis(labels, true)
	// Both axes must be named, and at least one of them twice: a single
	// label fixes an offset, never a scale, so one axis has to carry the
	// scale for the projection to hand it to the other.
	if len(lats) == 0 || len(lons) == 0 || (len(lats) < 2 && len(lons) < 2) {
		return nil, "labels"
	}
	seedLat := spanRatio(lats, func(l label) float64 { return l.y })
	seedLon := spanRatio(lons, func(l label) float64 { return l.x })

	// The latitude the projection ratio is taken at. The labels give it
	// directly and to the arcminute, which is four decimal places more
	// than sec(phi) needs.
	midLat := 0.0
	for _, l := range lats {
		midLat += l.min
	}
	midLat /= float64(len(lats)) * 60
	want := axisRatio(midLat)

	// An axis named once has no scale of its own; the projection lends it
	// the other's, which is all fitComb needs to bound its search.
	if seedLat == 0 && seedLon > 0 {
		seedLat = seedLon * want
	}
	if seedLon == 0 && seedLat > 0 {
		seedLon = seedLat / want
	}

	latFam := tickFamilies(c.segs, true)
	lonFam := tickFamilies(c.segs, false)
	latFit, latAnchor := bestFamily(latFam, seedLat)
	lonFit, lonAnchor := bestFamily(lonFam, seedLon)
	latAsg := tryAssign(latFit, lats, false)
	lonAsg := tryAssign(lonFit, lons, true)
	forced := ""

	// The conformal constraint. An axis with no comb of its own, or one
	// that disagrees with the other by more than the drafting tolerance,
	// is re-fitted at the step the projection demands: the panel is
	// conformal, so the two scales are one number, not two.
	switch {
	case latAsg != nil && lonAsg == nil:
		ppm := math.Abs(latFit.step/latAsg.perTick) / want
		lonFit, lonAsg, lonAnchor = deriveAxis(lonFam, ppm, seedLon, lons, true)
		forced = "lon"
	case lonAsg != nil && latAsg == nil:
		ppm := math.Abs(lonFit.step/lonAsg.perTick) * want
		latFit, latAsg, latAnchor = deriveAxis(latFam, ppm, seedLat, lats, false)
		forced = "lat"
	case latAsg != nil && lonAsg != nil:
		ppmLat := math.Abs(latFit.step / latAsg.perTick)
		ppmLon := math.Abs(lonFit.step / lonAsg.perTick)
		if math.Abs((ppmLat/ppmLon)/want-1) > 0.010 {
			if latFit.n >= lonFit.n {
				if f, a, anc := deriveAxis(lonFam, ppmLat/want, seedLon, lons, true); a != nil {
					lonFit, lonAsg, lonAnchor, forced = f, a, anc, "lon"
				}
			} else {
				if f, a, anc := deriveAxis(latFam, ppmLon*want, seedLat, lats, false); a != nil {
					latFit, latAsg, latAnchor, forced = f, a, anc, "lat"
				}
			}
		}
	}
	if latAsg == nil || lonAsg == nil {
		if latFit == nil && lonFit == nil {
			return nil, "ticks"
		}
		return nil, "assign"
	}

	// The frame is searched against the ticks THEMSELVES: on an APP sheet
	// they hang off the neatline, so a box grown even half a tick past
	// them contains no frame at all and the search falls through to the
	// page. Only when no drawn rectangle holds the graticule does the
	// grown box stand in for one.
	ticks := box{x0: lonFit.lo, x1: lonFit.hi, y0: latFit.lo, y1: latFit.hi}
	clip := graticuleBox(latFit, lonFit, c.media)
	frame := neatline(c, ticks)
	if frame == nil {
		frame = strokeFrame(c, ticks)
	}
	if frame != nil {
		clip = cutPanel(*frame, latFit, lonFit, latAnchor, lonAnchor)
	}

	geo := affineOf(latFit, latAsg, lonFit, lonAsg)
	ppmLat := math.Abs(latFit.step / latAsg.perTick)
	ppmLon := math.Abs(lonFit.step / lonAsg.perTick)
	dev := (ppmLat/ppmLon)/want - 1

	return &panelFit{
		Clip: clip, Geo: geo,
		LatN: latFit.n, LonN: lonFit.n,
		LatRMS: latFit.rms, LonRMS: lonFit.rms,
		DevPct: dev * 100, Forced: forced,
		PtPerNM: ppmLat,
	}, ""
}

// bestFamily picks the tick family that yields the best comb, and returns
// the family's anchor so the panel cut can tell an edge from an internal
// graticule line.
func bestFamily(fams []tickSet, seed float64) (*combFit, float64) {
	var best *combFit
	anchor := 0.0
	for _, f := range fams {
		fit := fitComb(f.pos, seed)
		if fit == nil {
			continue
		}
		if best == nil || fit.n > best.n || (fit.n == best.n && fit.rms < best.rms) {
			best, anchor = fit, f.anchor
		}
	}
	if best != nil {
		best.anchor = anchor
	}
	return best, anchor
}

func tryAssign(f *combFit, labels []label, lon bool) *assignment {
	if f == nil {
		return nil
	}
	return assign(f, labels, lon, 0)
}

// deriveAxis re-fits one axis at the scale the conformal constraint gives,
// ppm being the points per arcminute the OTHER axis implies. Only the tick
// interval is still unknown, so each interval the SIA prints is tried and
// the one that catches the most marks wins; the label-derived seed bounds
// the search so a half-scale comb cannot pass for a full one.
func deriveAxis(fams []tickSet, ppm, seed float64, labels []label, lon bool) (*combFit, *assignment, float64) {
	var bestFit *combFit
	var bestAsg *assignment
	bestAnchor := 0.0
	for _, iv := range niceSteps {
		step := ppm * iv
		if step < seed*0.42 || step > seed*1.15 {
			continue
		}
		for _, fam := range fams {
			f := fitPhase(fam.pos, step)
			if f == nil {
				continue
			}
			a := assign(f, labels, lon, ppm)
			if a == nil {
				continue
			}
			if bestFit == nil || f.n > bestFit.n || (f.n == bestFit.n && f.rms < bestFit.rms) {
				bestFit, bestAsg, bestAnchor = f, a, fam.anchor
			}
		}
	}
	if bestFit != nil {
		bestFit.anchor = bestAnchor
	}
	return bestFit, bestAsg, bestAnchor
}

func affineOf(latFit *combFit, latAsg *assignment, lonFit *combFit, lonAsg *assignment) geoAffine {
	return northUp(
		latFit.p0, latAsg.at0/60, latAsg.perTick/latFit.step/60,
		lonFit.p0, lonAsg.at0/60, lonAsg.perTick/lonFit.step/60,
	)
}

// neatline is the panel frame: the TIGHTEST drawn rectangle that still
// contains the whole graticule.
//
// Not the largest, and not "the largest that is not the page": every plate
// opens with a page-sized clip rectangle a point or two inside the trim,
// and any size threshold that excludes it also excludes the sheets whose
// map really does bleed to the edge. Tightest-containing needs no threshold
// at all, and says what a frame IS: the box drawn around the graticule.
func neatline(c pageContent, want box) *box {
	var best *box
	sheet := c.media.width() * c.media.height()
	for i := range c.rects {
		b := c.rects[i]
		if b.x0 > want.x0+1 || b.y0 > want.y0+1 || b.x1 < want.x1-1 || b.y1 < want.y1-1 {
			continue
		}
		// The page-sized clip every plate opens with is not a frame. No
		// map panel fills the sheet: there is always a title band.
		if sheet > 0 && b.width()*b.height() > sheet*0.95 {
			continue
		}
		if best == nil || b.width()*b.height() < best.width()*best.height() {
			b := b
			best = &b
		}
	}
	return best
}

// strokeFrame builds a frame out of the long strokes that bracket the
// graticule, for the sheets that draw their neatline as four lines rather
// than one rectangle. Each side is the innermost long stroke lying outside
// the ticks; all four must be found, or the caller falls back again.
func strokeFrame(c pageContent, ticks box) *box {
	const tol = 2.0
	spanX := (ticks.x1 - ticks.x0) * 0.6
	spanY := (ticks.y1 - ticks.y0) * 0.6
	out := box{x0: -math.MaxFloat64, y0: -math.MaxFloat64, x1: math.MaxFloat64, y1: math.MaxFloat64}
	for _, sg := range c.segs {
		dx, dy := math.Abs(sg.x2-sg.x1), math.Abs(sg.y2-sg.y1)
		switch {
		case dy < 0.4 && dx >= spanX:
			y := (sg.y1 + sg.y2) / 2
			if y <= ticks.y0+tol && y > out.y0 {
				out.y0 = y
			}
			if y >= ticks.y1-tol && y < out.y1 {
				out.y1 = y
			}
		case dx < 0.4 && dy >= spanY:
			x := (sg.x1 + sg.x2) / 2
			if x <= ticks.x0+tol && x > out.x0 {
				out.x0 = x
			}
			if x >= ticks.x1-tol && x < out.x1 {
				out.x1 = x
			}
		}
	}
	if out.x0 == -math.MaxFloat64 || out.y0 == -math.MaxFloat64 ||
		out.x1 == math.MaxFloat64 || out.y1 == math.MaxFloat64 {
		return nil
	}
	return &out
}

// graticuleBox is the fallback frame: the rectangle the graticule itself
// spans, grown half a tick each way. Around a third of the corpus draws no
// frame this reader can find, either because the map bleeds to the trim or
// because the border is built from dashes rather than a rectangle. The
// ticks are the map's own statement of where it runs, so they are a better
// answer than dropping the panel.
func graticuleBox(latFit, lonFit *combFit, media box) box {
	b := box{
		x0: lonFit.lo - lonFit.step/2,
		x1: lonFit.hi + lonFit.step/2,
		y0: latFit.lo - latFit.step/2,
		y1: latFit.hi + latFit.step/2,
	}
	return box{
		x0: math.Max(b.x0, media.x0), y0: math.Max(b.y0, media.y0),
		x1: math.Min(b.x1, media.x1), y1: math.Min(b.y1, media.y1),
	}
}

// cutPanel narrows the frame to the part of it that is actually a map.
//
// An ATT sheet is composite: a geographic panel on top, an aerodrome
// diagram below it at its own scale, then the runway table. The two are
// divided by the graticule line the longitude ticks straddle, and the
// latitude ticks say which side of it the map is on. Clipping to the frame
// instead would drag the diagram and the table onto the map, stretched to
// the panel's own scale.
func cutPanel(frame box, latFit, lonFit *combFit, latAnchor, lonAnchor float64) box {
	out := frame
	const edge = 6.0
	// Longitude ticks anchored inside the frame sit on an internal
	// parallel: cut there, keeping the side the latitude ticks are on.
	if lonAnchor > frame.y0+edge && lonAnchor < frame.y1-edge {
		if (latFit.lo+latFit.hi)/2 > lonAnchor {
			out.y0 = math.Max(out.y0, lonAnchor)
		} else {
			out.y1 = math.Min(out.y1, lonAnchor)
		}
	}
	// The mirror case: latitude ticks on an internal meridian.
	if latAnchor > frame.x0+edge && latAnchor < frame.x1-edge {
		if (lonFit.lo+lonFit.hi)/2 > latAnchor {
			out.x0 = math.Max(out.x0, latAnchor)
		} else {
			out.x1 = math.Min(out.x1, latAnchor)
		}
	}
	return out
}
