// The witness's arithmetic: how a window's displacement is found, how the
// windows are folded into one reading for the panel, and how much of that
// reading is evidence.
//
// THE SEARCH IS DECOMPOSED ON PURPOSE. Each window is searched for a
// TRANSLATION and nothing else; the scale and the rotation come afterwards,
// from how the windows disagree with each other. Searching a window over
// scale as well biases it, because shrinking moves the samples into wherever
// the reference happens to be densest and the score rises for a reason that
// has nothing to do with alignment. With the search decomposed, a window's
// sample set never changes while that window is being searched, so the bias
// cannot arise. It also buys a lever arm of half the panel: a per-window
// position good to a couple of metres resolves the panel's scale to a
// fraction of a per cent.
//
// Test file on purpose: cmd/vacgeo cannot link any of this.
package main

import (
	"math"
	"testing"
)

// How close a sample has to sit to the reference to count as agreeing. It
// is a soft edge and not a threshold: a Lorentzian falls away gently, so
// the score has a slope to climb from a long way out, and it is bounded, so
// one sample landing exactly on a wall cannot outvote a hundred near ones.
func rho(d, d0 float64) float64 {
	if math.IsInf(d, 1) {
		return 0
	}
	t := d / d0
	return 1 / (1 + t*t)
}

// scoreGrid is S over a square of translations, and the two radii of
// background it was levelled against.
type scoreGrid struct {
	val      []float64
	n        int // the grid is (2n+1) square
	step, d0 float64
}

func (s *scoreGrid) at(i, j int) float64 {
	if i < -s.n || i > s.n || j < -s.n || j > s.n {
		return math.Inf(-1)
	}
	return s.val[(j+s.n)*(2*s.n+1)+(i+s.n)]
}

// scoreAt is the agreement of one displacement, measured BOTH WAYS.
//
// One way alone does not work, and the way it fails is instructive. "How
// near is the chart's ink to the nearest reference" rewards DENSITY: slide
// the ink of a hospital site plan a hundred and forty metres into the middle
// of the town and it scores better than sitting on its own buildings,
// because in a town displaced ink is still near something. Over Creteil that
// bias took every window to the edge of the search.
//
// The cure is the symmetric measure. The second term asks the opposite
// question, how near is the REFERENCE to the nearest chart ink, and it falls
// exactly where the first rises: ink dragged into the town leaves the
// buildings it came from with nothing on them. A displacement has to answer
// both, and only the right one does.
func scoreAt(ink []inkSample, fRef *field, ref []inkSample, fInk *field, u, v, d0 float64) float64 {
	a, wa := 0.0, 0.0
	for _, s := range ink {
		a += s.w * rho(fRef.at(s.x+u, s.y+v), d0)
		wa += s.w
	}
	b, wb := 0.0, 0.0
	for _, s := range ref {
		b += s.w * rho(fInk.at(s.x-u, s.y-v), d0)
		wb += s.w
	}
	if wa == 0 || wb == 0 {
		return 0
	}
	return 0.5*(a/wa) + 0.5*(b/wb)
}

// scoreMap computes S over the search box AND levels it, which is what makes
// one window's peak comparable with another's.
//
// The level is a RING well outside the search: eight offsets at a couple of
// times the range. That is what a displacement of this ink over this ground
// scores by being in the right sort of place and the wrong one, and taking
// it off leaves the score of being in the right place.
//
// Two radii and not one, because a single radius can land in step with a
// periodic structure, and orchard rows, car park bays and a taxiway comb are
// all periodic at the scale this searches.
//
// The grid's own median was the first attempt and it is wrong whenever the
// peak is a large part of the grid, which over a dense town it is: the peak
// there is forty metres wide, and a search only twice that levels the answer
// away to nothing. A ring costs sixteen more evaluations and a little more
// reference around the window, and it does not have that failure.
func scoreMap(ink []inkSample, fRef *field, ref []inkSample, fInk *field, rangeM, step, d0 float64) *scoreGrid {
	n := int(math.Round(rangeM / step))
	g := &scoreGrid{val: make([]float64, (2*n+1)*(2*n+1)), n: n, step: step, d0: d0}
	for j := -n; j <= n; j++ {
		for i := -n; i <= n; i++ {
			g.val[(j+n)*(2*n+1)+(i+n)] =
				scoreAt(ink, fRef, ref, fInk, float64(i)*step, float64(j)*step, d0)
		}
	}
	bg, nb := 0.0, 0
	for _, r := range []float64{2.2 * rangeM, 3.0 * rangeM} {
		for k := 0; k < 8; k++ {
			th := float64(k) * math.Pi / 4
			bg += scoreAt(ink, fRef, ref, fInk, r*math.Cos(th), r*math.Sin(th), d0)
			nb++
		}
	}
	bg /= float64(nb)
	for i := range g.val {
		g.val[i] -= bg
	}
	return g
}

// pointField is a distance field of a set of samples, which is what the
// second half of the symmetric score reads.
func pointField(pts []inkSample, x0, y0, cell float64, nx, ny int) *field {
	segs := make([]refSeg, len(pts))
	for i, p := range pts {
		segs[i] = refSeg{p.x, p.y, p.x, p.y}
	}
	return newField(segs, x0, y0, cell, nx, ny)
}

// refPoints samples the reference edges NEAR THE INK, so the second half of
// the score has something to ask about that the answer can change.
//
// Near the ink and not over the whole field: reference a long way from any
// chart line work is far from it at every displacement, and a term that
// answers the same at every displacement is not a term, it is a constant.
// Over Creteil, sampling the whole field left the second half flat and the
// density bias exactly where it was.
func refPoints(segs []refSeg, cx, cy, reach, stepM float64, capN int) []inkSample {
	var out []inkSample
	for _, s := range segs {
		if math.Abs((s.x1+s.x2)/2-cx) > reach || math.Abs((s.y1+s.y2)/2-cy) > reach {
			continue
		}
		l := math.Hypot(s.x2-s.x1, s.y2-s.y1)
		n := int(l/stepM) + 1
		if n > 8 {
			n = 8
		}
		for k := 0; k <= n; k++ {
			t := float64(k) / float64(n)
			out = append(out, inkSample{s.x1 + (s.x2-s.x1)*t, s.y1 + (s.y2-s.y1)*t, 1})
		}
	}
	return decimate(out, capN)
}

// windowFix is what one window has to say.
type windowFix struct {
	dxM, dyM float64 // metres the chart's ink must move to sit on the ground
	peak     float64
	margin   float64 // the next best peak more than a few cells away
	sigmaM   float64
	aniso    float64 // 0 is one direction only, 1 is equally held both ways
	n        int
	clipped  bool // the peak sits on the edge of the search, so it is a bound
	verdict  string
}

// peakOf finds the best translation, its margin, its sharpness and how much
// of it is direction.
//
// The margin is the false-lock test and the single most important number
// here. A runway's edges are forty-five metres apart and a car park's bays
// five; a search over such a place has many peaks and picking the tallest
// with confidence is exactly how a witness reports something wrong with
// conviction. A peak that is not clear of its rivals is not a measurement.
func peakOf(g *scoreGrid) windowFix {
	var f windowFix
	bi, bj := 0, 0
	best := math.Inf(-1)
	for j := -g.n; j <= g.n; j++ {
		for i := -g.n; i <= g.n; i++ {
			if v := g.at(i, j); v > best {
				best, bi, bj = v, i, j
			}
		}
	}
	f.peak = best
	// Sub-cell, by a quadratic through the three values on each axis. A
	// stationary point outside one cell is not a refinement, it is a sign
	// the peak is on a slope, and the integer winner stands.
	sub := func(m, c, p float64) float64 {
		den := m - 2*c + p
		if den >= 0 {
			return 0
		}
		d := 0.5 * (m - p) / den
		if math.Abs(d) > 1 {
			return 0
		}
		return d
	}
	f.clipped = bi <= -g.n || bi >= g.n || bj <= -g.n || bj >= g.n
	di, dj := 0.0, 0.0
	if !f.clipped {
		di = sub(g.at(bi-1, bj), best, g.at(bi+1, bj))
		dj = sub(g.at(bi, bj-1), best, g.at(bi, bj+1))
	}
	f.dxM = (float64(bi) + di) * g.step
	f.dyM = (float64(bj) + dj) * g.step
	// Sharpness, and how much of it lies in each direction: the half width
	// at half the peak, along each axis. A score flat along one axis is a
	// reading that says nothing about that axis, which is what a lone
	// runway with no other line work gives.
	half := func(dir int) float64 {
		for k := 1; k <= g.n; k++ {
			i, j := bi, bj
			if dir == 0 {
				i += k
			} else {
				j += k
			}
			if i < -g.n || i > g.n || j < -g.n || j > g.n {
				break
			}
			if g.at(i, j) < best/2 {
				return float64(k) * g.step
			}
		}
		return float64(g.n) * g.step
	}
	hx, hy := half(0), half(1)
	f.sigmaM = math.Min(hx, hy)
	// The margin is the best rival OUTSIDE the peak's own support, and the
	// support is measured, not assumed: over a town the peak is forty
	// metres wide and over a pad detail it is three, so a fixed exclusion
	// would call the first a tie with itself. This is the false-lock test,
	// and the thing it is looking for is a SECOND summit: a runway's edges
	// are forty-five metres apart, a car park's bays five.
	excl := math.Max(hx, hy) / g.step
	second := math.Inf(-1)
	for j := -g.n; j <= g.n; j++ {
		for i := -g.n; i <= g.n; i++ {
			if math.Hypot(float64(i-bi), float64(j-bj)) <= excl {
				continue
			}
			if v := g.at(i, j); v > second {
				second = v
			}
		}
	}
	if math.IsInf(second, -1) {
		second = 0
	}
	f.margin = best - second
	// How much of the answer is direction, read off the CURVATURE at the
	// peak and not off its width. A width saturates at the edge of the
	// search, which would make the number depend on how far the search was
	// told to look; a curvature does not. Flat along one axis means that
	// axis was never measured.
	curv := func(dir int) float64 {
		c := 0.0
		for k := 1; k <= 2; k++ {
			a, b := bi-k, bi+k
			if dir == 1 {
				a, b = bj-k, bj+k
			}
			var lo, hi float64
			if dir == 0 {
				lo, hi = g.at(a, bj), g.at(b, bj)
			} else {
				lo, hi = g.at(bi, a), g.at(bi, b)
			}
			if math.IsInf(lo, -1) || math.IsInf(hi, -1) {
				continue
			}
			c += (2*best - lo - hi) / float64(k*k)
		}
		return math.Max(c, 0)
	}
	cx, cy := curv(0), curv(1)
	if m := math.Max(cx, cy); m > 0 {
		f.aniso = math.Min(cx, cy) / m
	}
	return f
}

// witnessVerdict names what a window is worth, and never says "aligned".
// The strongest thing this instrument can honestly report is that it looked
// and found no disagreement it could resolve.
func witnessVerdict(f windowFix, nSamples int, refSegs int) string {
	switch {
	case refSegs < 40:
		return "sparse"
	case nSamples < 120:
		return "thin"
	// A peak this low is no agreement anywhere, and where the argmax
	// happened to fall on a flat score says nothing at all, so this is
	// asked before the edge test.
	case f.peak < 0.02:
		return "weak"
	case f.clipped:
		return "clipped"
	// Direction is tested BEFORE the margin, because a score flat along one
	// axis has rivals all along it by construction: calling that weak would
	// throw away the across-track reading, which is real.
	case f.aniso < 0.10:
		return "single-axis"
	// A loose margin ON PURPOSE. Over a town the surface is shallow and a
	// strict margin refuses windows whose answers plainly agree with their
	// neighbours', which throws away the very evidence that matters: one
	// window is noisy, and what makes a panel's reading believable is that
	// the others land on it. That agreement is measured at the panel, as
	// the residual about the fitted similarity, and it is the confidence.
	case f.margin < 0.15*f.peak:
		return "weak"
	}
	return "measured"
}

// panelFix is the whole panel's reading, folded from its windows.
type panelFix struct {
	shiftM, brgDeg   float64
	scalePct, rotDeg float64
	residM           float64
	nWindows         int
	full             bool // the scale and rotation were resolved at all
}

// fitWindows folds the windows into a similarity: a translation, one scale
// and one rotation about the panel's own centre.
//
// NEVER an affine. A shear is a reading no plate states, and a witness that
// offers six coefficients is offering a correction; this one offers four
// numbers that cannot be turned back into a placement without someone doing
// the arithmetic themselves, in the open.
//
// Three windows to resolve a scale. Two would fit four unknowns with four
// equations, exactly, leaving no residual to doubt it by, and a reading with
// no way of being wrong is not a measurement.
func fitWindows(cx, cy, dx, dy, w []float64) panelFix {
	var p panelFix
	p.nWindows = len(cx)
	if len(cx) == 0 {
		return p
	}
	if len(cx) < 3 {
		sw, sx, sy := 0.0, 0.0, 0.0
		for i := range cx {
			sw += w[i]
			sx += w[i] * dx[i]
			sy += w[i] * dy[i]
		}
		mx, my := sx/sw, sy/sw
		p.shiftM = math.Hypot(mx, my)
		p.brgDeg = bearingOf(mx, my)
		// Two windows have no similarity to be residual about, but they can
		// still disagree, and a mean of two answers a hundred and eighty
		// metres apart is not a reading. The spread is carried so the
		// verdict can say so.
		sse := 0.0
		for i := range cx {
			sse += w[i] * ((dx[i]-mx)*(dx[i]-mx) + (dy[i]-my)*(dy[i]-my))
		}
		p.residM = math.Sqrt(sse / sw)
		return p
	}
	// dx = a*cx - b*cy + tx
	// dy = b*cx + a*cy + ty
	var m [4][5]float64
	add := func(r [4]float64, v, wt float64) {
		for i := 0; i < 4; i++ {
			for j := 0; j < 4; j++ {
				m[i][j] += wt * r[i] * r[j]
			}
			m[i][4] += wt * r[i] * v
		}
	}
	for i := range cx {
		add([4]float64{cx[i], -cy[i], 1, 0}, dx[i], w[i])
		add([4]float64{cy[i], cx[i], 0, 1}, dy[i], w[i])
	}
	sol, ok := solve4(m)
	if !ok {
		return p
	}
	a, b, tx, ty := sol[0], sol[1], sol[2], sol[3]
	s := math.Hypot(1+a, b)
	p.scalePct = (s - 1) * 100
	p.rotDeg = math.Atan2(b, 1+a) * 180 / math.Pi
	p.shiftM = math.Hypot(tx, ty)
	p.brgDeg = bearingOf(tx, ty)
	p.full = true
	sse, sw := 0.0, 0.0
	for i := range cx {
		rx := a*cx[i] - b*cy[i] + tx - dx[i]
		ry := b*cx[i] + a*cy[i] + ty - dy[i]
		sse += w[i] * (rx*rx + ry*ry)
		sw += w[i]
	}
	// Divided by the DEGREES OF FREEDOM, not by the number of readings.
	// Each window contributes two observations and the similarity spends
	// four of them, so three windows leave two: dividing by six instead
	// understates the scatter by 42 per cent, and three windows is the
	// commonest case there is. Measured over the corpus before the
	// correction, panels read on three windows disagreed among themselves
	// by 64 m at the median against 31 m for five, and reported almost the
	// same residual for it.
	if dof := 2*float64(len(cx)) - 4; sw > 0 && dof > 0 {
		p.residM = math.Sqrt(sse / sw * 2 * float64(len(cx)) / dof)
	}
	return p
}

// bearingOf names a local east/north displacement the way a chart does.
func bearingOf(e, n float64) float64 {
	return math.Mod(math.Atan2(e, n)*180/math.Pi+360, 360)
}

// solve4 is Gaussian elimination with partial pivoting on a 4x5 augmented
// matrix. Four unknowns is small enough that a library would be a bigger
// liability than the twenty lines.
func solve4(m [4][5]float64) ([4]float64, bool) {
	var out [4]float64
	for c := 0; c < 4; c++ {
		p := c
		for r := c + 1; r < 4; r++ {
			if math.Abs(m[r][c]) > math.Abs(m[p][c]) {
				p = r
			}
		}
		if math.Abs(m[p][c]) < 1e-12 {
			return out, false
		}
		m[c], m[p] = m[p], m[c]
		for r := 0; r < 4; r++ {
			if r == c {
				continue
			}
			f := m[r][c] / m[c][c]
			for k := c; k < 5; k++ {
				m[r][k] -= f * m[c][k]
			}
		}
	}
	for i := 0; i < 4; i++ {
		out[i] = m[i][4] / m[i][i]
	}
	return out, true
}

// A synthesised town: a grid of building outlines, as reference edges.
func syntheticTown(seed int) []refSeg {
	var out []refSeg
	r := seed
	next := func(n int) int { r = (r*1103515245 + 12345) & 0x7fffffff; return r % n }
	for gx := 0; gx < 7; gx++ {
		for gy := 0; gy < 7; gy++ {
			x := float64(gx*60-180) + float64(next(20))
			y := float64(gy*60-180) + float64(next(20))
			w := 18 + float64(next(16))
			h := 14 + float64(next(20))
			out = append(out,
				refSeg{x, y, x + w, y}, refSeg{x + w, y, x + w, y + h},
				refSeg{x + w, y + h, x, y + h}, refSeg{x, y + h, x, y})
		}
	}
	return out
}

// and the same town as chart ink, displaced and scaled by a known amount.
func townAsInk(segs []refSeg, scale, dxM, dyM float64) []inkSample {
	var out []inkSample
	for _, s := range segs {
		n := 6
		for i := 0; i <= n; i++ {
			t := float64(i) / float64(n)
			x := (s.x1 + (s.x2-s.x1)*t) * scale
			y := (s.y1 + (s.y2-s.y1)*t) * scale
			out = append(out, inkSample{x + dxM, y + dyM, 1})
		}
	}
	return out
}

func TestWitnessRecoversAKnownShift(t *testing.T) {
	// The test that decides whether the report can be believed at all: put
	// the ink somewhere known to be wrong and require the number back.
	town := syntheticTown(7)
	f := newField(town, -400, -400, 1, 800, 800)
	rp := refPoints(town, 0, 0, 1e9, 3, 1500)
	for _, want := range [][2]float64{{0, 0}, {12, 0}, {0, -9}, {-17, 23}, {31, -28}} {
		ink := townAsInk(town, 1, want[0], want[1])
		g := scoreMap(ink, f, rp, pointField(ink, -400, -400, 1, 800, 800), 45, 1.5, 3)
		fix := peakOf(g)
		// The score says how far the ink must MOVE to sit on the ground,
		// so it is the negative of the displacement it was given.
		if math.Abs(fix.dxM+want[0]) > 2 || math.Abs(fix.dyM+want[1]) > 2 {
			t.Errorf("ink displaced (%.0f, %.0f) recovered as (%.2f, %.2f)",
				want[0], want[1], -fix.dxM, -fix.dyM)
		}
		if fix.margin < 0.35*fix.peak {
			t.Errorf("displaced (%.0f, %.0f): peak %.3f margin %.3f, no clear lock",
				want[0], want[1], fix.peak, fix.margin)
		}
	}
}

func TestWitnessScoreHasNoScaleBias(t *testing.T) {
	// A joint search over scale prefers shrinking, because shrinking pulls
	// the samples into wherever the reference is densest. The witness never
	// searches scale, and this is the demonstration: the score at the true
	// placement must beat the score of the same ink shrunk onto the same
	// reference, at its own best translation.
	town := syntheticTown(11)
	f := newField(town, -400, -400, 1, 800, 800)
	rp := refPoints(town, 0, 0, 1e9, 3, 1500)
	score := func(sc float64) float64 {
		ink := townAsInk(town, sc, 0, 0)
		fi := pointField(ink, -400, -400, 1, 800, 800)
		return peakOf(scoreMap(ink, f, rp, fi, 40, 2, 3)).peak
	}
	truth := score(1)
	for _, sc := range []float64{0.84, 0.90, 0.96, 1.04, 1.10} {
		got := score(sc)
		if got >= truth {
			t.Errorf("ink at scale %.2f scores %.4f, at least as well as the truth's %.4f",
				sc, got, truth)
		}
	}
}

func TestWitnessReportsAFlatScoreAsNoEvidence(t *testing.T) {
	// Ink over ground that holds nothing: the verdict must be an admission,
	// never a displacement.
	town := syntheticTown(3)
	f := newField(nil, -400, -400, 1, 800, 800)
	ink := townAsInk(town, 1, 0, 0)
	fi := pointField(ink, -400, -400, 1, 800, 800)
	fix := peakOf(scoreMap(ink, f, nil, fi, 40, 2, 3))
	if v := witnessVerdict(fix, len(ink), 0); v != "sparse" {
		t.Errorf("verdict %q over empty ground, want sparse", v)
	}
	if v := witnessVerdict(fix, len(ink), 500); v != "weak" {
		t.Errorf("verdict %q on a flat score, want weak", v)
	}
}

func TestWitnessSingleAxisIsNotAMeasurement(t *testing.T) {
	// One runway and nothing else. The score is flat ALONG it, so the
	// displacement in that direction is arbitrary and must be said to be.
	var runway []refSeg
	for _, y := range []float64{-22, 22} {
		runway = append(runway, refSeg{-600, y, 600, y})
	}
	f := newField(runway, -700, -300, 2, 700, 300)
	var ink []inkSample
	for _, y := range []float64{-22, 22} {
		for x := -600.0; x <= 600; x += 8 {
			ink = append(ink, inkSample{x, y, 1})
		}
	}
	fix := peakOf(scoreMap(ink, f, refPoints(runway, 0, 0, 1e9, 6, 1500),
		pointField(ink, -700, -300, 2, 700, 300), 60, 3, 6))
	if fix.aniso >= 0.10 {
		t.Errorf("anisotropy %.3f on a lone runway, want it read as one direction", fix.aniso)
	}
	if v := witnessVerdict(fix, len(ink), len(runway)*50); v != "single-axis" {
		t.Errorf("verdict %q, want single-axis", v)
	}
}

func TestFitWindowsResolvesScaleAndRefusesToBeAnAffine(t *testing.T) {
	// Four windows on a panel drawn 3 % large and turned half a degree.
	const s, rot = 1.03, 0.5 * math.Pi / 180
	cx := []float64{-300, 300, -300, 300}
	cy := []float64{-200, -200, 200, 200}
	dx := make([]float64, 4)
	dy := make([]float64, 4)
	w := []float64{1, 1, 1, 1}
	for i := range cx {
		dx[i] = s*math.Cos(rot)*cx[i] - s*math.Sin(rot)*cy[i] - cx[i] + 4
		dy[i] = s*math.Sin(rot)*cx[i] + s*math.Cos(rot)*cy[i] - cy[i] - 7
	}
	got := fitWindows(cx, cy, dx, dy, w)
	if !got.full {
		t.Fatal("four windows and no scale resolved")
	}
	if math.Abs(got.scalePct-3) > 0.05 {
		t.Errorf("scale %.3f %%, want 3", got.scalePct)
	}
	if math.Abs(got.rotDeg-0.5) > 0.02 {
		t.Errorf("rotation %.3f deg, want 0.5", got.rotDeg)
	}
	if math.Abs(got.shiftM-math.Hypot(4, 7)) > 0.05 {
		t.Errorf("shift %.2f m, want %.2f", got.shiftM, math.Hypot(4, 7))
	}
	if got.residM > 0.01 {
		t.Errorf("residual %.3f m on an exact similarity", got.residM)
	}
	// Two windows resolve a translation and nothing more: the fit would be
	// exact and unfalsifiable.
	if two := fitWindows(cx[:2], cy[:2], dx[:2], dy[:2], w[:2]); two.full {
		t.Error("two windows claimed a scale")
	}
}
