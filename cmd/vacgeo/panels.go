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

// wgs84A is the WGS84 semi-major axis.
const wgs84A = 6378137.0

// metrePerDeg is the ellipsoid's own metres per degree of latitude and of
// longitude at a latitude: the meridian radius M and the prime-vertical
// radius N that axisRatio already stands on, in the units a fit works in.
//
// A SPHERE IS NOT CLOSE ENOUGH here. The 111320 m/degree a sphere gives is
// 0.09 % short of the meridian and 0.19 % long of the parallel at French
// latitudes, so a panel built on one comes out 0.3 % out of square with
// neither axis at the scale its own sheet prints. That is the one thing
// this command must not get wrong: the graticule half reads the ellipsoid
// off the ticks and the two halves have to agree.
func metrePerDeg(latDeg float64) (mLat, mLon float64) {
	s := math.Sin(latDeg * math.Pi / 180)
	w := 1 - wgs84E2*s*s
	n := wgs84A / math.Sqrt(w)
	m := wgs84A * (1 - wgs84E2) / (w * math.Sqrt(w))
	const rad = math.Pi / 180
	return rad * m, rad * n * math.Cos(latDeg*math.Pi/180)
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

// tickBoxes are the closed rectangles no bigger than a tick is long, in
// BOTH directions. Their sides are not graticule ticks and must not be
// offered as any: a tick is a stroke hanging off the neatline with nothing
// drawn around it, while these are boxes, and a box that size has two sides
// the length of a tick and two more at right angles to them.
//
// The SIA sets its own logo in the page footer as a 13 pt square, well
// below any map, and its two horizontal sides join the latitude candidates
// at exactly the x the left neatline stands at. One of the pair then lands
// on the comb by luck, which stretches the tick extent down into the
// footer, and the frame search goes looking for the panel's bottom edge
// below THAT: Le Plessis-Belleville and Aulnay-sous-Bois both shipped their
// approach chart with the special-instructions block and the footer rule
// hanging under the map, stretched to the panel's own scale.
//
// A degenerate rectangle stays a candidate, since a plate is free to draw
// its ticks as zero-width boxes and some do; what is excluded is a real
// two-dimensional box.
func tickBoxes(rects []box) []box {
	var out []box
	for _, b := range rects {
		w, h := b.width(), b.height()
		if w >= tickMin && w <= tickMax && h >= tickMin && h <= tickMax {
			out = append(out, b)
		}
	}
	return out
}

// onTickBox reports whether a mark spanning lo..hi at pos is a whole side of
// one of those boxes.
func onTickBox(boxes []box, lo, hi, pos float64, horizontal bool) bool {
	const eps = 0.4
	for _, b := range boxes {
		var along0, along1, across0, across1 float64
		if horizontal {
			along0, along1, across0, across1 = b.x0, b.x1, b.y0, b.y1
		} else {
			along0, along1, across0, across1 = b.y0, b.y1, b.x0, b.x1
		}
		if math.Abs(along0-lo) > eps || math.Abs(along1-hi) > eps {
			continue
		}
		if math.Abs(across0-pos) < eps || math.Abs(across1-pos) < eps {
			return true
		}
	}
	return false
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
func tickFamilies(c pageContent, horizontal bool) []tickSet {
	boxes := tickBoxes(c.rects)
	type mark struct{ near, far, mid, pos float64 }
	var marks []mark
	for _, s := range c.segs {
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
			pos := (s.y1 + s.y2) / 2
			if onTickBox(boxes, lo, hi, pos, true) {
				continue
			}
			marks = append(marks, mark{near: lo, far: hi, mid: (lo + hi) / 2, pos: pos})
		} else {
			if dx > tickSkew {
				continue
			}
			lo, hi := math.Min(s.y1, s.y2), math.Max(s.y1, s.y2)
			pos := (s.x1 + s.x2) / 2
			if onTickBox(boxes, lo, hi, pos, false) {
				continue
			}
			marks = append(marks, mark{near: lo, far: hi, mid: (lo + hi) / 2, pos: pos})
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
	lo, hi float64 // the comb's own extent
	// The extent of its longest run of CONSECUTIVE ticks. A graticule is a
	// regular series, so a pick reachable only across a gap of missing
	// slots is not evidence of how far the graticule reaches: Etain's
	// approach sheet has a 1.8 pt mark in the page footer that lands on
	// the grid five slots below the lowest real tick, and Chalons-Vatry a
	// mark in its own footer at the page trim.
	coreLo, coreHi float64
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
	// picks arrive in index order and the step is positive, so the longest
	// consecutive run is a scan.
	bi, bj := 0, 0
	for i := 0; i < len(picks); {
		j := i
		for j+1 < len(picks) && picks[j+1].k == picks[j].k+1 {
			j++
		}
		if j-i > bj-bi {
			bi, bj = i, j
		}
		i = j + 1
	}
	return &combFit{
		step: step, p0: p0, n: len(picks), rms: math.Sqrt(sq / n),
		lo: lo, hi: hi, coreLo: picks[bi].v, coreHi: picks[bj].v,
	}
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
	Clip box
	// Frame is the drawn rectangle the clip was cut out of, kept so a
	// rejection can say whether the fit was wrong or only the cut was.
	Frame   box
	Geo     geoAffine
	LatN    int
	LonN    int
	LatRMS  float64
	LonRMS  float64
	DevPct  float64
	Forced  string // which axis the conformal constraint re-fitted, if any
	PtPerNM float64
	// What the conformal constraint overrode, where it overrode a comb that
	// had a scale of its own: the disagreement it removed and how many
	// ticks the displaced comb held. DevPct is zero BY CONSTRUCTION once an
	// axis is derived, since deriveAxis builds the step as ppm*iv and
	// assign hands back step/ppm, so the projection gate is vacuous on
	// exactly the panels that most needed checking and Forced is the only
	// surviving signal. These two say how much was assumed.
	ForcedDevPct float64
	ForcedN      int
	// Axes says how a panel whose two combs disagreed was settled:
	// "conformal" where the projection's correction stood, "stretched"
	// where the axis's own labels took it back. Empty where there was
	// nothing to settle.
	Axes string
	// LabelDevPct is how far the re-fitted axis ended from what its own
	// printed labels span. It owes nothing to the ticks: Saint-Cyr's
	// landing sheet names 48 48', 49' and 50' 104.4 points apart and the
	// re-fit built the axis at 96.1, an 8 per cent contradiction over 209
	// points of paper where a label anchor is good to about one and a half.
	// Where Axes is "stretched" the re-fit was rejected, and this is the
	// contradiction it carried, taken while it was still there to measure.
	LabelDevPct float64
	// Set by the runway fit instead of the graticule one.
	Method string
	// Which way up a pad sheet is, and what said so (helipad.go), and how
	// coarsely the AIP states the point it stands on. Empty on every other
	// method.
	North    northRead
	PadGridM float64
	// Which of the pad sheet's two scale readings produced ScaleDev, since
	// they are different quantities: "bar" is a drawn square against a
	// published size at the printed bar's scale, "ratio" is the squares'
	// own ratio against the published one.
	ScaleFrom string
	Runways   int
	ResidM    float64
	ScaleDev  float64
	// Set when the drawn runway moved a graticule fit onto its own ground:
	// that it was confirmed at all, how far it moved, and what the two
	// ends still missed by afterwards.
	Anchored     bool
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

	latFam := tickFamilies(c, true)
	lonFam := tickFamilies(c, false)
	latFit := bestFamily(latFam, seedLat)
	lonFit := bestFamily(lonFam, seedLon)
	// The phase belongs to the labels, not to whichever of a finer
	// graticule's phases caught the most marks.
	latFit = rephase(latFit, axisMarks(latFam), labelPositions(lats, false))
	lonFit = rephase(lonFit, axisMarks(lonFam), labelPositions(lons, true))
	// Both combs are kept as first read, because the panel cut is a
	// question about the ink and not about the projection. The conformal
	// re-fit below may replace either with a two-pick phase fit chosen to
	// satisfy the axis ratio: such a comb sits on a different grid, so the
	// graticule lines are no longer found on it, and its own extent
	// describes nothing. Aulnay-sous-Bois comes out on a 29 pt grid where
	// its graticule is drawn on a 58 pt one, and Auberive on a comb of two
	// whose core is a single point.
	latSpan, lonSpan := latFit, lonFit
	latAsg := tryAssign(latFit, lats, false)
	lonAsg := tryAssign(lonFit, lons, true)
	// The reading as the page gave it, kept because the labels may take the
	// projection's correction back below.
	latWas, latAsgWas := latFit, latAsg
	lonWas, lonAsgWas := lonFit, lonAsg
	forced := ""
	forcedDev := 0.0
	forcedN := 0

	// The conformal constraint. An axis with no comb of its own, or one
	// that disagrees with the other by more than the drafting tolerance,
	// is re-fitted at the step the projection demands: the panel is
	// conformal, so the two scales are one number, not two.
	switch {
	case latAsg != nil && lonAsg == nil:
		ppm := math.Abs(latFit.step/latAsg.perTick) / want
		lonFit, lonAsg = deriveAxis(lonFam, ppm, seedLon, lons, true)
		forced = "lon"
	case lonAsg != nil && latAsg == nil:
		ppm := math.Abs(lonFit.step/lonAsg.perTick) * want
		latFit, latAsg = deriveAxis(latFam, ppm, seedLat, lats, false)
		forced = "lat"
	case latAsg != nil && lonAsg != nil:
		ppmLat := math.Abs(latFit.step / latAsg.perTick)
		ppmLon := math.Abs(lonFit.step / lonAsg.perTick)
		if math.Abs((ppmLat/ppmLon)/want-1) > 0.010 {
			// Both axes were read off the page and they disagree. Whatever
			// the projection decides below, what they said is worth
			// keeping: it is the difference between a panel corrected by
			// half a per cent and one overruled by eight.
			forcedDev = (ppmLat/ppmLon)/want - 1
			latTicks, lonTicks := latFit.n, lonFit.n
			// Re-fit the worse-populated axis at the step the projection
			// demands, and if that finds nothing, re-fit the OTHER one.
			// Trying a single direction and giving up leaves the panel
			// carrying the disagreement it was supposed to lose, which
			// the projection gate then throws it out for: Ussel shipped a
			// 24 % axis disagreement that way, with three ticks on each
			// axis and so no honest tie-break between them.
			redoLon := func() bool {
				f, a := deriveAxis(lonFam, ppmLat/want, seedLon, lons, true)
				if a == nil {
					return false
				}
				lonFit, lonAsg, forced = f, a, "lon"
				return true
			}
			redoLat := func() bool {
				f, a := deriveAxis(latFam, ppmLon*want, seedLat, lats, false)
				if a == nil {
					return false
				}
				latFit, latAsg, forced = f, a, "lat"
				return true
			}
			// The fallback is for a panel that would otherwise be
			// dropped, and only that. The trigger above is 1 %, tighter
			// than the 2 % the gate actually refuses at, so a panel
			// disagreeing by something in between is already publishable
			// and re-fitting its better axis can only trade a full comb
			// for a thin one: Revel-Montgey lost a five-tick longitude
			// axis, and with it the runway confirmation it had.
			doomed := math.Abs(((ppmLat/ppmLon)/want-1)*100) > maxDevPct
			if latFit.n >= lonFit.n {
				if !redoLon() && doomed {
					redoLat()
				}
			} else {
				if !redoLat() && doomed {
					redoLon()
				}
			}
			switch forced {
			case "lat":
				forcedN = latTicks
			case "lon":
				forcedN = lonTicks
			default:
				// Neither direction found a comb at the demanded step, so
				// the panel keeps the disagreement it came with and the
				// gate judges it on DevPct as before. Nothing was
				// overridden, so there is nothing to report.
				forcedDev = 0
			}
		}
	}
	// THE LABELS ARE ALLOWED TO CONTRADICT THE PROJECTION.
	//
	// The conformal constraint is a prior and a strong one: 569 panels in
	// this corpus measure both axes and not one disagrees with it by 2 per
	// cent. But a prior is not a measurement, and where a re-fitted axis
	// ends up contradicting its OWN PRINTED LABELS by as much as it claimed
	// to correct, the ticks and the labels of that axis agree with each
	// other and the projection is the only dissenter. Then the sheet really
	// is drawn out of square and the correction is the error.
	//
	// The two readings separate the corpus cleanly. Of the 135 panels where
	// a comb with a scale of its own was displaced, 117 have the re-fitted
	// axis landing on its labels (the comb was a misread and the constraint
	// repaired it, which is what it is for) and 18 have it landing as far
	// from them as the correction was worth. Nothing sits between an
	// agreement of 0.48 and one of 0.76, so the threshold is not delicate.
	//
	// Saint-Cyr's landing sheet is the reason this is here: it draws 104.3
	// points to the minute of latitude and 63.4 to the minute of longitude,
	// a ratio of 1.644 where the ellipsoid demands 1.519, and it says so
	// twice over, in the aerodrome plate and the helistation one.
	axes := ""
	// How far the REJECTED re-fit ended from its own labels, taken while it
	// is still there to measure: once the comb is put back the axis agrees
	// with its labels by construction and the reading is gone. It is the
	// reason the panel is published out of square, so it is the one worth
	// keeping.
	rejectedDev := 0.0
	if forced != "" && forcedDev != 0 {
		axes = "conformal"
		switch forced {
		case "lat":
			refit := math.Abs(latFit.step / latAsg.perTick)
			if labelsOverrule(refit, seedLat, forcedDev) {
				rejectedDev = refit/seedLat - 1
				latFit, latAsg, axes, forced = latWas, latAsgWas, "stretched", ""
			}
		case "lon":
			refit := math.Abs(lonFit.step / lonAsg.perTick)
			if labelsOverrule(refit, seedLon, forcedDev) {
				rejectedDev = refit/seedLon - 1
				lonFit, lonAsg, axes, forced = lonWas, lonAsgWas, "stretched", ""
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
	whole := clip
	if frame != nil {
		whole = *frame
		if latSpan == nil {
			latSpan = latFit
		}
		if lonSpan == nil {
			lonSpan = lonFit
		}
		clip = cutPanel(*frame, latSpan, lonSpan, latFam, lonFam)
	}

	geo := affineOf(latFit, latAsg, lonFit, lonAsg)
	ppmLat := math.Abs(latFit.step / latAsg.perTick)
	ppmLon := math.Abs(lonFit.step / lonAsg.perTick)
	dev := (ppmLat/ppmLon)/want - 1

	// The re-fitted axis against the labels' own span, which is the one
	// reading of that axis the re-fit did not touch. A seed of zero is an
	// axis named once: it fixes an offset and never a scale, so it has
	// nothing to say here.
	labelDev := 0.0
	switch forced {
	case "lat":
		if seedLat > 0 {
			labelDev = ppmLat/seedLat - 1
		}
	case "lon":
		if seedLon > 0 {
			labelDev = ppmLon/seedLon - 1
		}
	}
	if axes == "stretched" {
		// The axis stands on its own comb again, so what the switch above
		// computed is an axis against labels it agrees with by
		// construction, and it says nothing. The contradiction the
		// rejected re-fit carried is the reading worth publishing, and it
		// was measured before the comb went back: negating forcedDev
		// instead made this field an exact mirror of devPct on every
		// stretched panel, which is a number the row already carries.
		labelDev = rejectedDev
		forcedDev, forcedN = 0, 0
	}

	return &panelFit{
		Clip: clip, Frame: whole, Geo: geo,
		LatN: latFit.n, LonN: lonFit.n,
		LatRMS: latFit.rms, LonRMS: lonFit.rms,
		DevPct: dev * 100, Forced: forced, Axes: axes,
		ForcedDevPct: forcedDev * 100, ForcedN: forcedN,
		LabelDevPct: labelDev * 100,
		PtPerNM:     ppmLat,
	}, ""
}

// How far a re-fitted axis may sit from its own printed labels before the
// labels are believed instead, and how nearly the two disagreements must
// match. An axis the projection corrected AWAY from its labels contradicts
// them by what the correction was worth; one it corrected TOWARDS them does
// not, which is the whole of the difference between a sheet drawn out of
// square and a comb read off the wrong marks.
const (
	minStretchDevPct = 3.0
	minStretchAgree  = 0.75
	// And a bound on what a sheet can plausibly be drawn out of square BY.
	// The agreement test asks whether the ticks and the labels of an axis
	// are on the same side, and they are on the same side when BOTH are
	// misread the same way: a plate whose labels come apart reads 94 per
	// cent out and agrees with itself perfectly. A minute of latitude is
	// longer than a minute of longitude everywhere in France, so a ratio
	// anywhere near a quarter off is not a drafting decision.
	maxStretchDevPct = 25.0
)

// labelsOverrule reports whether the labels of a re-fitted axis contradict
// it by as much as the conformal correction was worth. `refit` is the points
// per arcminute the correction produced, `seed` what the axis's own extreme
// labels span, and `forcedDev` the comb disagreement the correction removed.
//
// A seed of zero is an axis named once, which fixes an offset and never a
// scale: it has nothing to say and the correction stands.
func labelsOverrule(refit, seed, forcedDev float64) bool {
	if seed <= 0 || refit <= 0 {
		return false
	}
	labelDev := math.Abs(refit/seed - 1)
	if labelDev*100 < minStretchDevPct || labelDev*100 > maxStretchDevPct ||
		math.Abs(forcedDev)*100 > maxStretchDevPct {
		return false
	}
	a, b := labelDev, math.Abs(forcedDev)
	if a > b {
		a, b = b, a
	}
	return b > 0 && a/b >= minStretchAgree
}

// bestFamily picks the tick family that yields the best comb.
func bestFamily(fams []tickSet, seed float64) *combFit {
	var best *combFit
	for _, f := range fams {
		fit := fitComb(f.pos, seed)
		if fit == nil {
			continue
		}
		if best == nil || fit.n > best.n || (fit.n == best.n && fit.rms < best.rms) {
			best = fit
		}
	}
	return best
}

// labelPositions are the label anchors along one axis.
func labelPositions(labels []label, lon bool) []float64 {
	out := make([]float64, 0, len(labels))
	for _, l := range labels {
		if lon {
			out = append(out, l.x)
		} else {
			out = append(out, l.y)
		}
	}
	return out
}

// axisMarks is every tick candidate on one axis, whatever family caught it.
//
// The families are three clusterings of the same marks (by near end, far end
// and middle), so one of them is missing a tick another has, and a re-phase
// asks whether a mark exists at a position rather than which key found it:
// Creteil's middle parallel is in one clustering and not in the one whose
// comb won.
func axisMarks(fams []tickSet) []float64 {
	var out []float64
	for _, f := range fams {
		out = append(out, f.pos...)
	}
	sort.Float64s(out)
	var uniq []float64
	for _, v := range out {
		if n := len(uniq); n > 0 && v-uniq[n-1] < 0.05 {
			continue
		}
		uniq = append(uniq, v)
	}
	return uniq
}

// combTol is how near a mark must lie to a comb's tick to be one of its
// own, in points. fitComb's own inlier tolerance, shared so a re-phased
// comb is judged exactly as the first fit was.
const combTol = 0.8

// rephase puts a comb's ticks on the marks its LABELS name.
//
// A comb's STEP is the scale and its PHASE is where that scale starts, and
// the two rest on different evidence. The step is the ticks' own: fitComb
// searches around the interval the labels imply, so a plate that draws a
// finer graticule than it labels is fitted at the LABELLED interval, on
// whichever of the two or three phases available caught the most marks, and
// between those the fit has nothing to say. The labels do: each names one
// tick.
//
// Creteil's approach sheet draws a ten-second graticule and labels every
// thirty seconds. The comb came out at thirty seconds with a residual of
// ZERO, one ten-second tick south of the phase its labels name, and the
// panel shipped 309 m south-west of itself with the aerodrome still
// comfortably on it. Nothing else in the pipeline can see that: the comb is
// perfect, the projection check passes, and the ARP gate answers to within
// half a panel. It is the label-to-tick offset, in points of paper, that
// says it, and it said it on a good fifty panels.
//
// The shift is believed only where the shifted ticks are REAL MARKS. A
// sheet whose labels genuinely sit a third of a tick from the graticule has
// nothing drawn at the shifted positions, and keeps the comb it had.
func rephase(f *combFit, marks []float64, labels []float64) *combFit {
	if f == nil || f.step <= 0 || len(marks) == 0 || len(labels) < 2 {
		return f
	}
	sort.Float64s(labels)
	off := func(v float64) float64 {
		q := (v - f.p0) / f.step
		return (q - math.Round(q)) * f.step
	}
	// Each label names a mark, and the marks they name stand in the comb's
	// own step: the labels are a whole number of ticks apart BY VALUE, so
	// they are a whole number of steps apart on the page. That is the test.
	// A phase is a series or it is nothing.
	slots := make([]int, len(labels))
	for i, p := range labels {
		slots[i] = int(math.Round((p - labels[0]) / f.step))
	}
	best, bestScore := 0.0, math.MaxFloat64
	found := false
	for _, m := range marks {
		if math.Abs(m-labels[0]) > 0.5*f.step {
			continue
		}
		score, ok := 0.0, true
		for i := range labels {
			want := m + float64(slots[i])*f.step
			near, d := 0.0, math.MaxFloat64
			for _, v := range marks {
				if e := math.Abs(v - want); e < d {
					near, d = v, e
				}
			}
			if d >= combTol {
				ok = false
				break
			}
			score += math.Abs(near - labels[i])
		}
		if !ok || score >= bestScore {
			continue
		}
		best, bestScore, found = off(m), score, true
	}
	// The series the labels sit nearest is usually the one the comb already
	// has, which is the ordinary case and the whole point of scoring the
	// candidates against each other rather than filtering them: the phase
	// in hand competes on the same terms as the rest, and a label anchored
	// a few points off its tick leaves it standing.
	//
	// And a phase error is a whole tick of a FINER graticule, which divides
	// the comb's step by a small whole number: the SIA prints ten seconds
	// inside thirty and thirty inside a minute. A winner at some other
	// offset is a series of map marks that happened to line up, and moving
	// a panel onto it is how the first reading of this rule left Orleans-Saint-
	// Denis and Auxerre worse than it found them, three points out, which
	// their own
	// drawn runways said and this refuses.
	// And it has to be a shift a label could not have faked. An anchor
	// wanders a couple of points, so a phase nearer than that to the one in
	// hand is not evidence of anything: Auxerre draws a twenty-one point
	// comb whose sixth is three and a half points, and moved onto it by
	// its own labels' wander it ended a hundred metres from the runway it
	// draws.
	if !found || math.Abs(best) < minPhaseShiftPt || math.Abs(best) < 0.06*f.step ||
		!onFinerGraticule(best, f.step) {
		return f
	}
	picks := map[int]float64{}
	errs := map[int]float64{}
	for _, m := range marks {
		q := (m - f.p0 - best) / f.step
		k := int(math.Round(q))
		e := math.Abs(math.Round(q)-q) * f.step
		if e >= combTol {
			continue
		}
		if prev, ok := errs[k]; !ok || e < prev {
			picks[k], errs[k] = m, e
		}
	}
	if len(picks) < 2 {
		return f
	}
	// The STEP does not move. It is the scale, it came from the comb the
	// ticks themselves gave, and re-fitting it over the shifted picks would
	// let a phase correction rewrite the panel's size: measured over the
	// corpus that moved panels by kilometres, where a phase is worth half a
	// tick at the most.
	return atPhase(f, sortedPicks(picks), f.p0+best)
}

// minPhaseShiftPt is the smallest phase correction worth believing, in
// points of paper. Label anchors wander by about that much.
const minPhaseShiftPt = 4.0

// onFinerGraticule reports whether an offset is a whole tick of a graticule
// that divides the comb's step: a half of it, a third, a quarter, a fifth or
// a sixth. The tolerance is the comb's own, since the marks are on their
// grid to within it.
func onFinerGraticule(offset, step float64) bool {
	tol := math.Max(combTol, 0.02*step)
	for m := 2; m <= 6; m++ {
		for j := 1; j < m; j++ {
			d := float64(j) / float64(m) * step
			if math.Abs(math.Abs(offset)-d) <= tol {
				return true
			}
		}
	}
	return false
}

// atPhase rebuilds a comb at a stated phase, keeping the step it was fitted
// with and taking everything else from the marks that then fall on it.
func atPhase(f *combFit, picks []pick, p0 float64) *combFit {
	if len(picks) == 0 {
		return f
	}
	lo, hi := math.MaxFloat64, -math.MaxFloat64
	var sq float64
	for _, p := range picks {
		lo, hi = math.Min(lo, p.v), math.Max(hi, p.v)
		d := p0 + float64(p.k)*f.step - p.v
		sq += d * d
	}
	bi, bj := 0, 0
	for i := 0; i < len(picks); {
		j := i
		for j+1 < len(picks) && picks[j+1].k == picks[j].k+1 {
			j++
		}
		if j-i > bj-bi {
			bi, bj = i, j
		}
		i = j + 1
	}
	return &combFit{
		step: f.step, p0: p0, n: len(picks),
		rms: math.Sqrt(sq / float64(len(picks))),
		lo:  lo, hi: hi, coreLo: picks[bi].v, coreHi: picks[bj].v,
	}
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
func deriveAxis(fams []tickSet, ppm, seed float64, labels []label, lon bool) (*combFit, *assignment) {
	var bestFit *combFit
	var bestAsg *assignment
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
				bestFit, bestAsg = f, a
			}
		}
	}
	return bestFit, bestAsg
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
//
// A window a knockout left open counts as one of those rectangles. It is
// not drawn in ink, but painting out everything around a panel states where
// that panel ends exactly as a neatline does, and on Sainte-Leocadie's
// approach sheet it is the only statement of it the page makes: the frame
// there is turned a fifth of a degree, so it is neither an `re` rectangle
// nor a set of axis-aligned strokes, and nothing else on the page holds the
// graticule.
func neatline(c pageContent, want box) *box {
	var best *box
	sheet := c.media.width() * c.media.height()
	cands := make([]box, 0, len(c.rects)+len(c.masks))
	cands = append(cands, c.rects...)
	cands = append(cands, c.masks...)
	for i := range cands {
		b := cands[i]
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

// tickLine is one graticule line a family of ticks springs from, held as
// the outermost reach of its marks rather than as a single coordinate.
//
// A parallel appears up to three times among the families, once per
// clustering key, because a tick hanging off a neatline shares its near end
// with its family while one straddling an internal line shares its middle.
// The three anchors sit a tick length apart and none of them is the line;
// the OUTER reach is, since a tick hangs inward from the neatline it marks.
type tickLine struct{ lo, hi float64 }

// tickLines are the parallels carrying the SAME longitude graticule as the
// fitted comb. A panel's own top and bottom neatlines do, and so does every
// internal graticule line; a cluster of map clutter that happened to form a
// family does not, which is what makes this a usable statement about where
// the map ends and not just a list of anchors.
func tickLines(fams []tickSet, lonFit *combFit) []tickLine {
	const share = 0.8
	// A boundary parallel carries the graticule ALONG ITS WHOLE LENGTH, so
	// it hits a good half of the comb's own marks. Three was the first
	// threshold and it is far too low where the comb is fine: Orleans-Bricy
	// prints a meridian every 14 points, and clutter three of which happen
	// to land on that grid was enough to invent a parallel across the
	// middle of the chart and cut it in half there.
	need := lonFit.n / 2
	if need < 3 {
		need = 3
	}
	var anchors []float64
	for _, fam := range fams {
		on := map[int]bool{}
		for _, v := range fam.pos {
			q := (v - lonFit.p0) / lonFit.step
			if math.Abs(q-math.Round(q))*lonFit.step < share {
				on[int(math.Round(q))] = true
			}
		}
		if len(on) >= need {
			anchors = append(anchors, fam.anchor)
		}
	}
	sort.Float64s(anchors)
	var out []tickLine
	for i := 0; i < len(anchors); {
		j := i
		for j < len(anchors) && anchors[j]-anchors[i] <= tickMax+2 {
			j++
		}
		out = append(out, tickLine{lo: anchors[i], hi: anchors[j-1]})
		i = j
	}
	return out
}

// cutAxis narrows one axis of the frame to the band the graticule spans on
// it. lines are the graticule lines that cross the axis, and coreLo..coreHi
// the run of ticks ALONG it.
//
// A side is cut only where the outermost line lies clear of that run. Tick
// detection is not complete on every sheet, and ticks beyond the outermost
// line mean the lines ran out before the map did: Orleans-Bricy and
// Sainte-Leocadie both print a one-arcminute graticule of which this reader
// finds the bottom few parallels, and cutting at those would halve a
// continuous chart. The allowance is one tick length, because a line is read
// as the outer REACH of the marks on it and two marks within a tick of each
// other cannot be told apart as inside the neatline or outside it: Chambery
// draws a mark three points above its own top parallel, which was enough to
// keep the frequency block on the chart.
func cutAxis(lo0, hi0, coreLo, coreHi float64, lines []tickLine, bothSides bool) (float64, float64) {
	if len(lines) == 0 {
		return lo0, hi0
	}
	lo, hi := lines[0].lo, lines[0].hi
	for _, l := range lines[1:] {
		lo, hi = math.Min(lo, l.lo), math.Max(hi, l.hi)
	}
	cutLo, cutHi := lo <= coreLo+tickMax, hi >= coreHi-tickMax
	if bothSides && !(cutLo && cutHi) {
		return lo0, hi0
	}
	if cutLo {
		lo0 = math.Max(lo0, lo)
	}
	if cutHi {
		hi0 = math.Min(hi0, hi)
	}
	return lo0, hi0
}

// cutPanel narrows the frame to the part of it that is actually a map.
//
// An ATT sheet is composite: a title band with the pictograms and the
// frequencies, a geographic panel, an aerodrome diagram at its own scale,
// then the runway table. Only the second is a map, and clipping to the frame
// drags the rest onto the ground stretched to the panel's own scale.
//
// The map is bounded BY ITS OWN GRATICULE, on both axes. Every graticule
// line a map draws lies within it, its edges included, so the outermost
// lines are the edges and anything past them is furniture. Cutting at ONE
// line and working out which side to keep from where the ticks lay was the
// earlier rule, and it cannot serve a frame that overshoots both ways, which
// is the common shape: which half of the furniture came along was then
// settled by which end of the sheet a stray mark landed on.
//
// BOUNDING at a meridian is not the same as CUTTING at one, and the
// distinction is the whole of why the width is safe. A composite plate
// stacks its panels and never columns them, so an INTERNAL meridian is
// never a divider and cutting there amputates the map, which is how
// Bale-Mulhouse once shipped with two thirds of its landing chart gone.
// Taking the OUTERMOST meridians divides nothing: it trims the frame to the
// ground the graticule covers, exactly as the parallels do for the height,
// and it is what stops Chalons-Vatry drawing a blank strip of page margin
// down the left of its approach chart.
//
// The width is bounded only when BOTH sides answer, and that follows from
// the same fact. Because nothing is divided left from right, a meridian can
// only be a neatline or an internal graticule line, so a lone one is
// evidence of nothing and taking it amputates: Auberive draws a single
// readable meridian a third of the way across its approach chart. A lone
// PARALLEL is different, since it may be the divider of a composite sheet,
// which is the case the cut was written for.
func cutPanel(frame box, latFit, lonFit *combFit, latFam, lonFam []tickSet) box {
	out := frame
	out.y0, out.y1 = cutAxis(frame.y0, frame.y1, latFit.coreLo, latFit.coreHi,
		tickLines(lonFam, lonFit), false)
	out.x0, out.x1 = cutAxis(frame.x0, frame.x1, lonFit.coreLo, lonFit.coreHi,
		tickLines(latFam, latFit), true)
	return out
}
