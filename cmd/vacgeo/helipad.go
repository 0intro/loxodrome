// helipad.go places a helistation LANDING sheet, the one page in the Atlas
// that carries no graticule, no runway and, until this file, nothing else a
// placement could stand on.
//
// 211 of them yield nothing to panels.go, and they are the hospitals: a
// site plan of the block, the pad on its roof or its lawn, the streets
// around it and the approach and departure sectors. What such a sheet DOES
// carry is three separate statements, and between them they are a
// placement:
//
//   - WHERE. The pad is drawn with its marking, the H or the hospital
//     cross, and the AIP publishes the touchdown area's own position (the
//     AIXM <Tla>, in fr-airports.json's pads column). One point.
//   - WHICH WAY. A north arrow, per panel, because these sheets are not
//     north-up: Lyon Edouard Herriot's pad detail is turned fifteen
//     degrees and says so with its own arrow.
//   - HOW BIG. The printed scale bar.
//
// A point, a direction and a scale are a similarity, which is what
// runway.go already fits from two point pairs; so the second pair is
// synthesised a fixed distance up the north arrow and the whole of the
// existing machinery is reused, geoAffine construction included.
//
// The check is the pad's own SIZE. Every one of these sheets draws the
// touchdown area as a square around its marking, and both the AIP and the
// sheet's own notes state how many metres that square is: "FATO : 20.6 x
// 20.6 m", "TLOF : 10 x 10 m". Measured at the scale the BAR gives, the
// drawn square has to come out as one of them. That is two independent
// readings of the same panel, the bar and the pad, and a marking that is
// really a building fails it.

package main

import (
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Plausible scales for a helistation sheet, in points of paper per metre of
// ground. These panels run from a block plan at 1:2500 to a pad detail at
// 1:200, so the aerodrome-diagram window (minPtPerM..maxPtPerM, 1:2000 to
// 1:25000) does not reach them at either end.
const (
	minPadPtPerM = 0.10
	maxPadPtPerM = 12.00
)

// How far the drawn pad may sit from the size the AIP or the sheet states,
// measured at the scale the bar gives. It is the reading that confirms the
// marking IS the pad, so it decides what ships.
//
// A fifth, and not the tenth it reads like it should be, because the pad is
// a SYMBOL on these sheets and not a survey: over the corpus the drawn
// square misses the published size by 7.7 % at the median, and the panels
// that miss by 13 % to 18 % are placed correctly (Nancy Brabois, Castres
// Hauterive, Issoudun, Poitiers and Marne-la-Vallee all sit on their own
// pad, tree line and car parks over the imagery). The corpus then breaks:
// nothing lands between 17.9 % and 20.7 %, and everything past the gap is a
// square that is not the pad.
const maxPadSizeDev = 0.20

// And how far the two drawn squares may sit from the ratio the published
// sizes stand in, which is the same check on a sheet that prints no bar.
// It is tighter because it is scale-free: two squares that are really the
// touchdown and safety areas are in that ratio by construction.
const maxPadRatioDev = 0.08

// A pad square is the marking's own square and not the next thing out. The
// marking (an H or a cross) fills a good half of the touchdown area and
// never all of it, so the square is looked for between these multiples of
// the marking's own width.
//
// The ceiling is 6.00 because that is where the corpus stops answering. A
// census over all 193 pages this reader touches placed 65 at 3.20, 67 at
// 4.00 and 70 at 6.00, and then 70 again at 8.00 and at 12.00: nothing is
// lost at any ceiling up to 12, and nothing further is gained past 6.
// Toulon Sainte-Anne is why, and it is the plain case rather than the
// awkward one: its pad detail draws the 30x30 FATO at 3.18 times the
// marking and the 40x40 safety area at 4.34, and the sheet prints both
// figures.
//
// Past 6 the next thing out is a roof. Saintes' pad detail carries two more
// concentric squares at 8.62 and 10.01 times the marking, the roof deck and
// its parapet, and three other sheets carry the same between 8.7 and 9.0;
// every one of them is concentric AND square, so neither the centre test
// nor the proportion test sees it. A 6.00 ceiling excludes all four by
// construction, which is the argument for stopping there rather than at the
// first number that has not broken anything yet.
const (
	minPadSquareRatio = 1.05
	maxPadSquareRatio = 6.00
)

// How far apart two squares, or two published sizes, have to be to be two
// of anything rather than one measured twice.
//
// ONE constant, used by the dedup in padSquares and by the pair test in
// padScale alike, because they are the same question asked twice and two
// numbers left a band. The dedup folded anything closer than 1.12 into one
// reading and the pair test then wanted 1.15, so a genuine pair between
// twelve and fifteen per cent apart survived the fold and was refused as
// a single square immediately afterwards.
const minPadPairRatio = 1.12

// padRef is one published helipad: where its touchdown area is and the two
// squares the AIP states around it, in metres.
type padRef struct {
	pos    latLon
	sizesM []float64
}

// panelEdges is every straight edge the page draws, whether it was stroked
// on its own or as one side of a longer path.
//
// The frame these sheets print around their panel stack is ONE path: the
// four sides of a box with the rules between the panels inside it. A reader
// that looks only at standalone segments finds the stack from whatever
// shorter rails happen to be stroked beside it, which on Creteil Henri
// Mondor is fourteen points short at each end, and cuts a twenty-four metre
// strip off the top of the sheet it then places.
func panelEdges(c pageContent) []seg {
	out := make([]seg, 0, len(c.segs)+64)
	out = append(out, c.segs...)
	for _, p := range c.polys {
		for i := 0; i+3 < len(p.pts); i += 2 {
			out = append(out, seg{p.pts[i], p.pts[i+1], p.pts[i+2], p.pts[i+3]})
		}
	}
	return out
}

// A frame fills its own bounding box. A rounded rectangle misses its box by
// a tenth of a per cent and a chamfered one by a third; an L-shaped block, a
// road or a diamond misses it by tens.
const minFrameFill = 0.90

// shoelaceArea is the area a point list encloses, closing it if the path did
// not. A path painted with `f` never records its closing edge, and the area
// of a frame cannot depend on whether the draughtsman typed `h`.
func shoelaceArea(pts []float64) float64 {
	if len(pts) < 6 {
		return 0
	}
	a := 0.0
	for i := 0; i+1 < len(pts); i += 2 {
		j := i + 2
		if j+1 >= len(pts) {
			j = 0
		}
		a += pts[i]*pts[j+1] - pts[j]*pts[i+1]
	}
	return math.Abs(a) / 2
}

// panelFrames are the boxes a sheet draws its panels inside, largest first.
//
// The frame is ONE closed path and its corners are WORKED: chamfered on
// Creteil Henri Mondor, rounded on Abbeville, and a rounded corner reaches
// this reader as a chord, the walk keeping one straight edge per curve
// operator. Either way the straight sides stop short of the frame's own
// extent, by a different amount at each corner, and they are drawn a
// fraction of a point out of plumb: 0.68 points over 285 at Abbeville, 0.78
// at Poitiers Nord. A reader that pairs two vertical rails is defeated by
// all three, and by two more besides. A frame painted with `f` and no
// explicit `h` never records its closing edge, and a side broken by a vertex
// is measured in pieces, none of them long enough to be a rail.
//
// So the frame is not read as rails. It is read as what it is: a closed path
// that fills its own bounding box, and the box is the answer. Bounds owe
// nothing to plumb, to corner radii, to a missing closing edge, or to a side
// drawn in pieces.
func panelFrames(c pageContent) []box {
	var out []box
	keep := func(b box, fill float64) {
		if b.width() < c.media.width()*0.4 || b.height() < c.media.height()*0.25 {
			return
		}
		if b.x0 < c.media.x0+3 && b.x1 > c.media.x1-3 {
			return // the page trim, not a panel
		}
		if fill < minFrameFill {
			return
		}
		for _, o := range out {
			if math.Abs(o.x0-b.x0) < 0.5 && math.Abs(o.y0-b.y0) < 0.5 &&
				math.Abs(o.x1-b.x1) < 0.5 && math.Abs(o.y1-b.y1) < 0.5 {
				return // a clip path is recorded once per painting operator
			}
		}
		out = append(out, b)
	}
	for _, p := range c.polys {
		b := p.bounds()
		if b.width() <= 0 || b.height() <= 0 {
			continue
		}
		keep(b, shoelaceArea(p.pts)/(b.width()*b.height()))
	}
	for _, b := range c.rects {
		keep(b, 1)
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].width()*out[i].height() > out[j].width()*out[j].height()
	})
	return out
}

// railStack is the older reading, kept for a sheet that strokes two bare
// rails and draws no closed frame around them: the pair that share a y range
// and stand furthest apart, grown out to any rule standing just beyond them.
func railStack(c pageContent, edges []seg) *box {
	type rail struct{ x, lo, hi float64 }
	var rails []rail
	for _, s := range edges {
		if math.Abs(s.x2-s.x1) > 0.5 {
			continue
		}
		lo, hi := math.Min(s.y1, s.y2), math.Max(s.y1, s.y2)
		if hi-lo < c.media.height()*0.25 {
			continue
		}
		rails = append(rails, rail{x: (s.x1 + s.x2) / 2, lo: lo, hi: hi})
	}
	var best *box
	for i := range rails {
		for j := range rails {
			a, b := rails[i], rails[j]
			if b.x-a.x < c.media.width()*0.4 {
				continue
			}
			if math.Abs(a.lo-b.lo) > 2 || math.Abs(a.hi-b.hi) > 2 {
				continue
			}
			if a.x < c.media.x0+3 && b.x > c.media.x1-3 {
				continue // the page trim, not a panel
			}
			cand := box{x0: a.x, y0: math.Max(a.lo, b.lo), x1: b.x, y1: math.Min(a.hi, b.hi)}
			if cand.height() < minPanelPt {
				continue
			}
			if best == nil || cand.width()*cand.height() > best.width()*best.height() {
				cand := cand
				best = &cand
			}
		}
	}
	if best == nil {
		return nil
	}
	const chamferPt = 30
	for _, s := range edges {
		if math.Abs(s.y2-s.y1) > 0.5 {
			continue
		}
		lo, hi := math.Min(s.x1, s.x2), math.Max(s.x1, s.x2)
		if hi-lo < best.width()*0.85 || lo < best.x0-3 || hi > best.x1+3 {
			continue
		}
		y := (s.y1 + s.y2) / 2
		if y > best.y1 && y-best.y1 <= chamferPt {
			best.y1 = y
		}
		if y < best.y0 && best.y0-y <= chamferPt {
			best.y0 = y
		}
	}
	return best
}

// A band shorter than this holds no map.
const minPanelPt = 60

// stackedPanels returns the map panels a helistation sheet draws, top to
// bottom.
//
// These pages draw no rectangle frameOnly can find: the panels sit in a
// stack inside one drawn frame, with horizontal rules across it. The frame
// gives the width and the extent, the rules cut the stack, and a band too
// short to hold a map is not a panel.
func stackedPanels(c pageContent) []box {
	edges := panelEdges(c)
	var stack *box
	if frames := panelFrames(c); len(frames) > 0 {
		stack = &frames[0]
	} else if stack = railStack(c, edges); stack == nil {
		return nil
	}
	// The rules that cross the stack cut it into panels. A rule spans the
	// frame's WIDTH and not its box: the corner work takes a dozen points
	// off each end of the top and bottom rules, so a full-width test would
	// refuse the very rules that bound the panels.
	cuts := []float64{stack.y0, stack.y1}
	for _, s := range edges {
		if math.Abs(s.y2-s.y1) > 0.5 {
			continue
		}
		lo, hi := math.Min(s.x1, s.x2), math.Max(s.x1, s.x2)
		y := (s.y1 + s.y2) / 2
		if y < stack.y0+minPanelPt || y > stack.y1-minPanelPt {
			continue
		}
		if hi-lo < stack.width()*0.85 || lo < stack.x0-3 || hi > stack.x1+3 {
			continue
		}
		cuts = append(cuts, y)
	}
	sort.Float64s(cuts)
	var out []box
	for i := 0; i+1 < len(cuts); i++ {
		if cuts[i+1]-cuts[i] < minPanelPt {
			continue
		}
		out = append(out, box{x0: stack.x0, y0: cuts[i], x1: stack.x1, y1: cuts[i+1]})
	}
	// Top to bottom: the site plan leads on every sheet in the corpus, and
	// a caller that stops at the first one placed should try it first.
	sort.Slice(out, func(i, j int) bool { return out[i].y0 > out[j].y0 })
	return out
}

// drawnArrow is one arrow the sheet draws: where its point is, which way it
// points and how long its shaft is.
//
// The three marks together are what makes an arrow findable at all. These
// pages are full of straight strokes and full of small filled shapes, and
// neither on its own says anything; a stroke with a filled head at one end
// is an arrow, and the head says which end is the point.
type drawnArrow struct {
	hx, hy float64 // the point
	angle  float64 // tail to point, radians, 0 towards the right of the page
	length float64 // the shaft, points
}

// drawnArrows finds them within a panel, with the shaft bounded by the
// caller: a north arrow is a fixed little thing and a departure sector runs
// the width of the sheet.
func drawnArrows(c pageContent, panel box, minShaft, maxShaft float64) []drawnArrow {
	var heads []box
	for _, p := range c.polys {
		n := len(corners(p.pts))
		if !p.filled || n < 3 || n > 5 {
			continue
		}
		b := p.bounds()
		if b.width() > 16 || b.height() > 16 || b.width() < 1.5 || b.height() < 1.5 {
			continue
		}
		if !panel.holds([2]float64{(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2}) {
			continue
		}
		heads = append(heads, b)
	}
	var out []drawnArrow
	for _, h := range heads {
		hx, hy := (h.x0+h.x1)/2, (h.y0+h.y1)/2
		reach := math.Max(h.width(), h.height())
		best := drawnArrow{hx: hx, hy: hy}
		for _, s := range c.segs {
			l := s.length()
			if l < minShaft || l > maxShaft || l <= best.length {
				continue
			}
			for _, e := range [2][2]float64{{s.x1, s.y1}, {s.x2, s.y2}} {
				if math.Hypot(e[0]-hx, e[1]-hy) > reach {
					continue
				}
				o := [2]float64{s.x2, s.y2}
				if e[0] == s.x2 && e[1] == s.y2 {
					o = [2]float64{s.x1, s.y1}
				}
				best.angle, best.length = math.Atan2(e[1]-o[1], e[0]-o[0]), l
			}
		}
		if best.length > 0 {
			out = append(out, best)
		}
	}
	return out
}

// northArrow reads the direction of true north on a panel, in radians
// measured the ordinary way (0 = towards the right of the page, pi/2 = up).
//
// The letter is the third mark: an arrow with an N just past its point is a
// north arrow, and one without is a departure sector.
func northArrow(c pageContent, panel box) (float64, float64, bool) {
	arrows := drawnArrows(c, panel, 6, 90)
	var got []float64
	var shaft float64
	for _, r := range dedupeRuns(c.runs) {
		if strings.TrimSpace(r.text) != "N" || r.size < 4 || r.size > 16 {
			continue
		}
		if !panel.holds([2]float64{r.x, r.y}) {
			continue
		}
		for _, a := range arrows {
			// The letter sits just past the head, within a glyph or two.
			if math.Hypot(r.x-a.hx, r.y-a.hy) > 3*r.size {
				continue
			}
			// And AHEAD of the point, not beside it: a filled blob near an
			// N with a stroke through it is otherwise an arrow in any
			// direction you please.
			if (r.x-a.hx)*math.Cos(a.angle)+(r.y-a.hy)*math.Sin(a.angle) < 0 {
				continue
			}
			got = append(got, a.angle)
			shaft = math.Max(shaft, a.length)
		}
	}
	if len(got) == 0 {
		return 0, 0, false
	}
	// Two arrows on one panel that disagree are not evidence.
	for _, a := range got[1:] {
		if math.Abs(math.Remainder(a-got[0], 2*math.Pi)) > 2*math.Pi/180 {
			return 0, 0, false
		}
	}
	return got[0], shaft, true
}

// bearingRe reads a printed bearing, three digits and a degree sign. Three
// digits and not two: an obstacle height is a bare number and these sheets
// are covered in them, so the degree sign is the whole of what tells a
// direction from an elevation.
var bearingRe = regexp.MustCompile(`^(\d{3})\s*(?:°|º)$`)

// bearingLabel is one printed sector bearing and where it is printed.
type bearingLabel struct {
	deg  float64
	x, y float64
}

// bearingLabels reads the approach and departure sectors a panel prints.
// The degree sign arrives as ° or º, as it does in the graticule labels,
// and it may be its own run: the plates set "087" and "°" separately as
// often as together.
func bearingLabels(c pageContent, panel box) []bearingLabel {
	runs := dedupeRuns(c.runs)
	sort.Slice(runs, func(i, j int) bool {
		if math.Abs(runs[i].y-runs[j].y) > 1.5 {
			return runs[i].y > runs[j].y
		}
		return runs[i].x < runs[j].x
	})
	var out []bearingLabel
	seen := map[string]bool{}
	for i, r := range runs {
		text := strings.TrimSpace(r.text)
		width := r.adv
		if regexp.MustCompile(`^\d{3}$`).MatchString(text) && i+1 < len(runs) {
			// The degree sign as its own run, abutting the digits.
			n := runs[i+1]
			if math.Abs(n.y-r.y) < 1.5 && n.x-(r.x+r.adv) < 2 && strings.TrimSpace(n.text) == "°" {
				text += "°"
				width = n.x + n.adv - r.x
			}
		}
		m := bearingRe.FindStringSubmatch(text)
		if m == nil {
			continue
		}
		cx, cy := r.x+width/2, r.y
		if !panel.holds([2]float64{cx, cy}) {
			continue
		}
		key := fmt.Sprintf("%s|%.1f|%.1f", m[1], cx, cy)
		if seen[key] {
			continue
		}
		seen[key] = true
		v, err := strconv.ParseFloat(m[1], 64)
		if err != nil || v > 360 {
			continue
		}
		out = append(out, bearingLabel{deg: v, x: cx, y: cy})
	}
	return out
}

// How near a sector label has to be to the point of the arrow it belongs
// to, and how nearly two of them must agree before either is believed.
const (
	bearingReachPt  = 35.0
	bearingAgreeDeg = 6.0
)

// bearingNorth reads which way north is from the approach and departure
// sectors, for a panel that draws no north arrow. 38 of the 246 helistation
// landing sheets are in that position and nearly all of them print these.
//
// The convention is the corpus's own answer, not a reading of the AIP. Over
// the 844 readings where a panel prints BOTH a north arrow and a labelled
// sector, the label sits at the arrow's POINT and names the direction
// leading AWAY from itself: read that way 301 land within five degrees of
// the north arrow, and read the other way 29 do. A double-headed sector is
// therefore self-consistent, its two reciprocal labels giving one answer.
//
// It is worth about three degrees, where a north arrow is worth a tenth of
// one. The bearings are printed to the degree and they are MAGNETIC, which
// the same measurement shows: the median reading sits a degree short of the
// north arrow, and France's declination is about a degree east. A degree is
// left uncorrected here. Nothing in this command carries a magnetic model,
// the plates that state their own variation are the aerodrome ones rather
// than these, and a degree over a panel this size is a metre.
func bearingNorth(c pageContent, panel box) (float64, bool) {
	labels := bearingLabels(c, panel)
	if len(labels) < 2 {
		return 0, false
	}
	axes := sectorAxes(c, panel)
	if len(axes) == 0 {
		return 0, false
	}
	var got []float64
	for _, l := range labels {
		for _, a := range axes {
			// The label belongs to the END it is printed at, and it names
			// the direction leading AWAY from that end: 087 at the western
			// point of an east-west axis is the eastward leg of it.
			for _, e := range [2]drawnArrow{a.a, a.b} {
				if math.Hypot(e.hx-l.x, e.hy-l.y) > bearingReachPt {
					continue
				}
				got = append(got, normAngle(e.angle+math.Pi+l.deg*math.Pi/180))
			}
		}
	}
	if len(got) < 2 {
		return 0, false
	}
	// Two readings have to agree, and on a two-headed axis the two
	// reciprocal labels are exactly that: 087 read at one point and 267 at
	// the other give one answer or the pairing is wrong.
	best, bestN := 0.0, 0
	for _, a := range got {
		n := 0
		var sx, sy float64
		for _, b := range got {
			if math.Abs(angleDiff(a, b)) <= bearingAgreeDeg*math.Pi/180 {
				n++
				sx += math.Cos(b)
				sy += math.Sin(b)
			}
		}
		if n > bestN {
			best, bestN = math.Atan2(sy, sx), n
		}
	}
	if bestN < 2 || bestN*2 <= len(got) {
		return 0, false
	}
	return best, true
}

// sectorAxis is one approach-and-departure axis: a long shaft with a point
// at BOTH ends, which is how these sheets draw a sector that is flown both
// ways.
type sectorAxis struct{ a, b drawnArrow }

// sectorAxes finds them. Two-headed is the whole of what makes a sector
// readable: a label at one point of such an axis names the leg leading away
// from it, and the label at the other point says the same thing in reverse,
// so the two check each other. A sheet's single-headed departure arrow is
// labelled the other way round (the bearing it points AT, written past its
// point), and with one head there is nothing to tell the two conventions
// apart, so those are left alone.
func sectorAxes(c pageContent, panel box) []sectorAxis {
	arrows := drawnArrows(c, panel, minSectorShaftPt, 400)
	var out []sectorAxis
	for i := range arrows {
		for j := i + 1; j < len(arrows); j++ {
			a, b := arrows[i], arrows[j]
			// Opposite directions, and each point is where the other's
			// shaft ends: one shaft, two heads.
			if math.Abs(math.Abs(angleDiff(a.angle, b.angle))-math.Pi) > 4*math.Pi/180 {
				continue
			}
			span := math.Hypot(a.hx-b.hx, a.hy-b.hy)
			if math.Abs(span-a.length) > 0.2*a.length || math.Abs(span-b.length) > 0.2*b.length {
				continue
			}
			out = append(out, sectorAxis{a: a, b: b})
		}
	}
	return out
}

// The shortest shaft that can be a sector. An obstacle leader is twenty or
// thirty points and there are dozens of them on a hospital plan; a sector
// runs across the panel.
const minSectorShaftPt = 60.0

// normAngle folds an angle into (-pi, pi].
func normAngle(a float64) float64 {
	for a > math.Pi {
		a -= 2 * math.Pi
	}
	for a <= -math.Pi {
		a += 2 * math.Pi
	}
	return a
}

// angleDiff is the signed difference between two angles, folded the same way.
func angleDiff(a, b float64) float64 { return normAngle(a - b) }

// panelNorth is which way north is on a panel: the north arrow where one is
// drawn, the printed sectors where none is, and neither where the two
// disagree by more than a sector reading is worth.
func panelNorth(c pageContent, panel box) (northRead, bool) {
	arrow, shaft, okArrow := northArrow(c, panel)
	sectors, okSectors := bearingNorth(c, panel)
	// What the two readers said, kept whatever is chosen. The arrow wins
	// where both answer, and the gap between them is the ONLY self-check
	// the rotation has: it used to be computed and discarded.
	got := northRead{ShaftPt: round2(shaft)}
	if okArrow && okSectors {
		got.DisagreeDeg = round2(math.Abs(angleDiff(arrow, sectors)) * 180 / math.Pi)
	}
	switch {
	case okArrow:
		// The arrow outranks the sectors wherever both are drawn, and a
		// disagreement between them is not a reason to refuse the panel:
		// over the 77 panels that carry both, 76 agree within ten degrees
		// and the one that does not is the sector convention flipping, not
		// a misread arrow. An arrow is three marks drawn to say one thing;
		// a sector is an inference from a label's position.
		got.From, got.Angle = "arrow", arrow
		return got, true
	case okSectors:
		// A sector reading has one failure mode a single panel cannot
		// argue itself out of: the plates label an APPROACH sector with
		// the direction it is flown FROM and a departure with the one it
		// is flown TO, and where the words are absent the two read 180
		// degrees apart. It happens on one panel of the 77 that carry
		// both readings, and there the north arrow says so.
		//
		// With no arrow to say so, what is left is what the corpus does:
		// of the 234 panels whose arrow can be read, 227 stand within
		// sixty degrees of straight up and the seven that do not all draw
		// one. A sector reading past a right angle from up is therefore
		// far more likely to be that flip than a sheet nobody drew.
		if math.Abs(angleDiff(sectors, math.Pi/2)) > maxSectorTiltDeg*math.Pi/180 {
			return northRead{}, false
		}
		got.From, got.Angle = "sectors", sectors
		return got, true
	}
	return northRead{}, false
}

// northRead is which way up a pad sheet is, and what said so.
//
// WHICH reader answered was not recorded, and the two are worth very
// different amounts: the median arrow shaft is 47.7 pt, so one point of
// drafting error in it is 1.2 degrees, and the shortest are under 10 pt,
// where the same point is 6 degrees or worse. A sector reading is worth
// about 3. Without the provenance a rotation error cannot be attributed to
// either, and over the pad class the rotation runs four times the graticule
// class's.
type northRead struct {
	Angle       float64
	From        string  // "arrow" or "sectors"
	ShaftPt     float64 // the arrow's own shaft, 0 on a sector reading
	DisagreeDeg float64 // where both answered, by how much they differ
}

// How far from straight up a panel placed on its SECTORS alone may stand.
const maxSectorTiltDeg = 100.0

// padMark is one pad marking: where its centre is and how big it is,
// measured in ITS OWN frame rather than the page's.
// The two shapes the AIP paints. The hospital cross is SQUARE and the test
// was written for it; an H is not, and seven landing sheets draw theirs as a
// filled outline that satisfies every other clause of padMarks, twelve
// corners and all, and fails on proportion alone at ratios of 1.46 to 1.69.
// A shape at 1.3 is neither, and admitting everything up to 1.9 would let in
// the long thin blocks these sheets are covered in.

type padMarkShape struct {
	cx, cy float64
	side   float64 // the larger of its two extents, points
}

// padMarks are the pad markings drawn on a panel: the H and the hospital
// cross, which are the same shape to this test, a filled outline of about a
// dozen SQUARE CORNERS in a square box. Nothing else on these sheets is
// drawn that way; a building is a rectangle and a symbol is not square.
//
// Square corners, not axis-aligned edges. Half these panels are turned (100
// of the 222 with a readable north arrow are more than ten degrees off), and
// the marking turns with the panel, so a test against the page's own axes
// finds the markings on the upright sheets and none of the others. What the
// shape really is is rectilinear IN SOME FRAME, and the frame is the
// marking's own.
func padMarks(c pageContent, panel box) []padMarkShape {
	// The SQUARE shapes first, which is the hospital cross the test was
	// written for, and the H's own proportions only where those found
	// nothing. Widening the band instead was measured and is worse: it
	// admits a second candidate on pages that already had a good one, and
	// cost seven panels to `two-marks` and `no-north` for the two it
	// gained. A page that already reads needs no help.
	if out := padMarksShaped(c, panel, func(r float64) bool { return r <= 1.25 }); len(out) > 0 {
		return out
	}
	// The H's band is not a shape test, it is a proportion, and a hospital
	// draws plenty of rectilinear blocks that fall in it: Blois and
	// Oloron-Sainte-Marie both print a grey building outline of about
	// twelve square corners at an aspect between 1.35 and 1.85, and this
	// band admitted them on 14 of the 354 panels it runs on. Neither cost
	// a placement, both sheets being refused at no-square anyway, but a
	// false marking is the one thing this reader must not have: the
	// position it would anchor on is the position.
	//
	// So the weaker shape test is paid for with positive evidence a
	// building does not have. An H is painted INSIDE its touchdown area,
	// which the sheet draws around it; a building is not inside anything.
	// padSquares already looks for exactly that and is bounded to the
	// band a pad's own squares sit in, so the answer is free.
	var out []padMarkShape
	for _, m := range padMarksShaped(c, panel, func(r float64) bool { return r >= 1.35 && r <= 1.85 }) {
		if len(padSquares(c, m)) > 0 {
			out = append(out, m)
		}
	}
	return out
}

func padMarksShaped(c pageContent, panel box, want func(float64) bool) []padMarkShape {
	var out []padMarkShape
	for _, p := range c.polys {
		n := len(p.pts) / 2
		if !p.filled || n < 11 || n > 15 {
			continue
		}
		b := p.bounds()
		if b.width() < 3 || b.height() < 3 || b.width() > 90 || b.height() > 90 {
			continue
		}
		if !panel.holds([2]float64{b.x0, b.y0}) || !panel.holds([2]float64{b.x1, b.y1}) {
			continue
		}
		th, ok := rectilinearAngle(p.pts)
		if !ok || len(corners(p.pts)) < 10 {
			continue
		}
		w, h := extentIn(p.pts, th)
		if w < 3 || h < 3 || !want(math.Max(w, h)/math.Min(w, h)) {
			continue
		}
		m := padMarkShape{cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, side: math.Max(w, h)}
		// These plates draw a marking twice, stroke then fill, exactly as
		// they draw their labels twice (dedupeRuns). Two outlines at one
		// place are one marking, and counting them as two refused the
		// sheet for having a pad it could not choose between.
		//
		// CONCENTRIC counts too, at any size. Blaye and Blois paint a
		// hospital cross on the roof and a small H inside it, one centre
		// and sides five times apart, and a helistation states one pad: two
		// markings at one point are one marking however big each is. The
		// LARGER stands, because it is the painted marking and the square
		// search is bounded by its side; a nine point H would put the
		// touchdown area outside the band it looks in.
		dup := -1
		for i, o := range out {
			if math.Hypot(o.cx-m.cx, o.cy-m.cy) < 1.5 {
				dup = i
				break
			}
		}
		switch {
		case dup < 0:
			out = append(out, m)
		case m.side > out[dup].side:
			out[dup] = m
		}
	}
	return out
}

// corners are the distinct vertices of a closed outline: the repeated
// closing point and any step too short to be a side dropped.
//
// These plates emit both, and it is not cosmetic. Alencon draws its final
// approach area as six points where four are corners, and a rectangle test
// that counts points instead of corners called it something else and left
// the sheet unplaced.
func corners(pts []float64) [][2]float64 {
	var out [][2]float64
	for i := 0; i+1 < len(pts); i += 2 {
		p := [2]float64{pts[i], pts[i+1]}
		if n := len(out); n > 0 && math.Hypot(p[0]-out[n-1][0], p[1]-out[n-1][1]) < 0.05 {
			continue
		}
		out = append(out, p)
	}
	if n := len(out); n > 1 && math.Hypot(out[0][0]-out[n-1][0], out[0][1]-out[n-1][1]) < 0.05 {
		out = out[:n-1]
	}
	return out
}

// rectilinearAngle reports the frame a closed outline is drawn square to,
// as an angle in [0, pi/2), and whether every edge of it really is square
// to that frame. Ten edges have to answer, so a shape with a stray diagonal
// is not one.
func rectilinearAngle(pts []float64) (float64, bool) {
	const tol = 3 * math.Pi / 180
	quarter := math.Pi / 2
	cs := corners(pts)
	if len(cs) < 4 {
		return 0, false
	}
	var th float64
	first := true
	for i := range cs {
		j := (i + 1) % len(cs)
		dx, dy := cs[j][0]-cs[i][0], cs[j][1]-cs[i][1]
		a := math.Mod(math.Atan2(dy, dx)+2*math.Pi, quarter)
		if first {
			th, first = a, false
			continue
		}
		d := math.Mod(math.Abs(a-th), quarter)
		if d > quarter/2 {
			d = quarter - d
		}
		if d > tol {
			return 0, false
		}
	}
	return th, true
}

// extentIn measures an outline along a frame's own two axes.
func extentIn(pts []float64, th float64) (float64, float64) {
	cs, sn := math.Cos(-th), math.Sin(-th)
	lo0, hi0 := math.MaxFloat64, -math.MaxFloat64
	lo1, hi1 := math.MaxFloat64, -math.MaxFloat64
	for i := 0; i+1 < len(pts); i += 2 {
		u := pts[i]*cs - pts[i+1]*sn
		v := pts[i]*sn + pts[i+1]*cs
		lo0, hi0 = math.Min(lo0, u), math.Max(hi0, u)
		lo1, hi1 = math.Min(lo1, v), math.Max(hi1, v)
	}
	return hi0 - lo0, hi1 - lo1
}

// padGlyphMarks are the markings a plate SETS rather than draws: a bare `H`
// typed into the middle of the square it names, which six landing sheets do
// and `padMarks` cannot see, because there is no outline to measure.
//
// This is the reader that has to be most careful, because an `H` is a
// letter and the plates are covered in them. Three gates, and every one of
// them came off a census of every bare-`H` run in the corpus:
//
// It is ISOLATED. Every bare `H` that is really a word fragment (the first
// letter of a run the walk broke, a legend row reading `H` beside `P`) has
// a neighbour on its own baseline within an em; no marking H has one.
//
// It is ENCLOSED, by a square concentric with it, which is the same
// evidence the H-proportion fallback wants and for the same reason: a
// marking is painted inside its touchdown area, and a letter in a caption
// is not inside anything.
//
// And the panel DREW no marking. 22 of the 30 pages carrying a bare `H`
// already have one, and claiming the glyph as well would make them
// `two-marks` and cost placements that read today.
//
// The size the shape is given is the glyph's own advance, which is the one
// measure that survives rotation: `size` is the text matrix's a
// coefficient, so a marking set at 90 degrees, which five of these sheets
// do, reads 0.00.
func padGlyphMarks(c pageContent, panel box) []padMarkShape {
	var out []padMarkShape
	for i, r := range c.runs {
		if strings.TrimSpace(r.text) != "H" || r.adv <= 0 {
			continue
		}
		if !panel.holds([2]float64{r.x, r.y}) {
			continue
		}
		if !isolatedRun(c.runs, i) {
			continue
		}
		// The glyph's own box, walked in the run's OWN frame: half an
		// advance along the baseline and half a cap height up from it. An
		// `H` is as wide as it is tall in every face these plates set, so
		// one number does for both, and it has to be walked rather than
		// added to x because five of these markings are set at 90 degrees.
		ux, uy := r.ax/r.adv, r.ay/r.adv
		m := padMarkShape{
			cx:   r.x + ux*r.adv/2 - uy*r.adv/2,
			cy:   r.y + uy*r.adv/2 + ux*r.adv/2,
			side: r.adv,
		}
		if len(padSquares(c, m)) == 0 {
			continue
		}
		// One marking drawn twice is one marking. These plates set every
		// label twice, stroke then fill, and they set a marking the same
		// way: sixteen bare `H` runs in the corpus are a pair a
		// hundredth of a point apart or less. Counted as two, a page that
		// should place is refused `two-marks` instead, which is the
		// mirror of the fold `padMarksShaped` already does for outlines.
		dup := false
		for _, o := range out {
			if math.Hypot(o.cx-m.cx, o.cy-m.cy) < 1.5 {
				dup = true
				break
			}
		}
		if !dup {
			out = append(out, m)
		}
	}
	return out
}

// isolatedRun reports whether a run has no neighbour on its own baseline
// within an em, which is what separates a marking from a letter of a word.
func isolatedRun(runs []textRun, i int) bool {
	r := runs[i]
	if r.adv <= 0 {
		return false
	}
	ux, uy := r.ax/r.adv, r.ay/r.adv
	for j, o := range runs {
		// The same text drawn on top of itself is this run again, not a
		// neighbour. The test is a DISTANCE and not an equality, because
		// the second draw misses the first by a hundredth of a point as
		// often as it lands on it: Pau's landing sheet sets its two bare
		// `H` runs 0.021 apart, which read as a neighbour at zero gap and
		// refused the marking outright.
		same := strings.TrimSpace(o.text) == strings.TrimSpace(r.text) &&
			math.Hypot(o.x-r.x, o.y-r.y) < r.adv*0.25
		if j == i || same {
			continue
		}
		// The neighbour's offset in the RUN's frame: along its baseline
		// and across it. A run set beside this one at any angle is still
		// beside it.
		dx, dy := o.x-r.x, o.y-r.y
		along := dx*ux + dy*uy
		across := -dx*uy + dy*ux
		if math.Abs(across) > r.adv*0.5 {
			continue
		}
		gap := -along - o.adv
		if along > 0 {
			gap = along - r.adv
		}
		if gap < r.adv*2 {
			return false
		}
	}
	return true
}

// padSquares are the squares drawn concentrically around a marking: the
// touchdown area, the final approach area and the safety area, smallest
// first. A sheet draws one, two or three of them and prints how many metres
// each is, so they are the scale AND the check that the marking is a pad:
// two squares in the ratio the notes state are not two courtyards.
//
// The search is bounded above as well as below. The marking fills a good
// half of the touchdown area and never all of it, and a hospital courtyard
// contains the pad too.
func padSquares(c pageContent, mark padMarkShape) []float64 {
	lo, hi := mark.side*minPadSquareRatio, mark.side*maxPadSquareRatio
	var out []float64
	// A square drawn at an angle has a square BOUNDING BOX too, and a
	// bounding box a good third bigger than the square, so the side is
	// measured between the corners the outline states and never off the
	// box. The `re` rectangles are the exception: the walk keeps their
	// extent and not their corners, so those answer for upright squares
	// alone, which is what they are on an upright panel.
	try := func(side, w, h, cx, cy float64) {
		if side < lo || side > hi || math.Abs(w/h-1) > 0.20 {
			return
		}
		// Concentric with the marking, within a quarter of it: the H sits
		// in the middle of the pad and the pad is what is being measured.
		if math.Hypot(cx-mark.cx, cy-mark.cy) > mark.side*0.25 {
			return
		}
		out = append(out, side)
	}
	for _, b := range c.rects {
		try(math.Max(b.width(), b.height()), b.width(), b.height(),
			(b.x0+b.x1)/2, (b.y0+b.y1)/2)
	}
	for _, p := range c.polys {
		if !isRectangle(p.pts) {
			continue
		}
		// A drawn CIRCLE arrives here as a four-point diamond, one chord
		// per bezier, and a diamond is square to a frame at 45 degrees, so
		// every clause below accepts it and measures the chord: 44.08
		// points where Antibes Port Vauban draws a 62.34 point circle,
		// which is its 16 m pad to the centimetre. The `curve` flags are
		// the telling, and what a circle is as wide as is its BOX.
		if allCurved(p) {
			b := p.bounds()
			try(math.Max(b.width(), b.height()), b.width(), b.height(),
				(b.x0+b.x1)/2, (b.y0+b.y1)/2)
			continue
		}
		th, ok := rectilinearAngle(p.pts)
		if !ok {
			// Four corners square to each other but not to one frame is
			// impossible; a rectangle whose edges this cannot agree on is
			// one the outline states twice over. Fall back to its extent.
			b := p.bounds()
			try(math.Max(b.width(), b.height()), b.width(), b.height(),
				(b.x0+b.x1)/2, (b.y0+b.y1)/2)
			continue
		}
		w, h := extentIn(p.pts, th)
		b := p.bounds()
		try(math.Max(w, h), w, h, (b.x0+b.x1)/2, (b.y0+b.y1)/2)
	}
	sort.Float64s(out)
	// A stroked square is drawn twice, once per edge of the stroke, and a
	// painted one is drawn twice again for its outline. They are one
	// square, and the gap between the two readings is a share of the
	// square rather than a fixed distance: the pad detail of Le Havre
	// draws its outline three and a half points outside its fill, which
	// on a 36 pt square is the same drawing as a point would be on a 10 pt
	// one. The concentric squares a pad really has are a quarter apart at
	// the least (a touchdown area inside a final approach area), so
	// nothing real is folded away here.
	var uniq []float64
	for _, v := range out {
		if n := len(uniq); n > 0 && v/uniq[n-1] < minPadPairRatio {
			continue
		}
		uniq = append(uniq, v)
	}
	return uniq
}

// allCurved reports whether every side of a closed outline is the chord of
// a bend, which is what a circle drawn as four beziers looks like by the
// time it reaches here.
//
// Two things about the flags decide how this is written. They are per
// POINT and mark the one a curve operator REACHED, so the side arriving at
// point k is a chord exactly when `curve[k]` is set; `curved` is the
// neighbouring question, ORing the flag on either end, and a shape wants
// the strict one. And they are indexed by the OUTLINE's own points, not by
// `corners()`, which drops the repeated closing point and any step too
// short to be a side: walking corner indices into a per-point slice reads
// the wrong flags as soon as an outline carries either, and the OR then
// biases the answer towards yes, which is a rotated square measured across
// its box and read 41 % too wide.
//
// Measured over the corpus, that is not hypothetical: 86 shapes pass the
// corner-indexed test and are not circles, among them the 9.26 by 9.29
// point lozenge on Clermont-Ferrand Auvergne's ground chart, two straight
// sides and two arcs, sitting square and concentric in exactly the band
// the pad reader searches.
func allCurved(p poly) bool {
	n := len(p.pts) / 2
	if len(p.curve) < n || n < 4 {
		return false
	}
	sides := 0
	for k := 1; k < n; k++ {
		if math.Hypot(p.pts[2*k]-p.pts[2*k-2], p.pts[2*k+1]-p.pts[2*k-1]) < 0.05 {
			// The step corners() itself drops: a closing point repeated,
			// or a vertex a producer emitted twice.
			continue
		}
		if !p.curve[k] {
			return false
		}
		sides++
	}
	return sides >= 3
}

// The forms a pad dimension is written in, wherever it is written: a pair
// with a loose separator and a French decimal comma ("20.6 x 20.6 m",
// "25x30", "11,4 X 11,4"), or, for a round pad, a diameter ("Diametre 20",
// "\u00d8 25"). The diameter is kept because it is the extent of the same
// square the sheet draws around the pad.
var (
	padPairRe = regexp.MustCompile(
		`(\d+(?:[.,]\d+)?)\s*(?:m\s*)?[xX\x{00d7}]\s*(\d+(?:[.,]\d+)?)`)
	padDiaRe = regexp.MustCompile(`(?i)(?:diam\S*|\x{00d8})\s*(\d+(?:[.,]\d+)?)`)
)

// And how big a pad can be. Three metres is under any touchdown area and
// two hundred is over any safety area, so a figure outside them was never a
// pad dimension.
const (
	minPadSizeM = 3.0
	maxPadSizeM = 200.0
)

// padDimRe reads the pad dimensions a sheet prints in its own notes, the
// three squares it draws concentrically: "FATO : 20.6 x 20.6 m", "TLOF :
// 10 x 10 m", "Aire de securite : 27 x 27 m".
//
// On a PLATE the keyword is what makes a pair of numbers a pad dimension,
// since the page is covered in numbers; the trailing unit stays mandatory
// for the same reason. In the facilities dataset the keyword is the cell's
// own category, so statedSizes (build.go) needs neither.
var padDimRe = regexp.MustCompile(
	`(?i)(?:FATO|TLOF|aire de s\S*curit|safety area)[^0-9]{0,30}` +
		`(\d+(?:[.,]\d+)?)\s*(?:m\s*)?[xX\x{00d7}]\s*(\d+(?:[.,]\d+)?)\s*m\b`)

// printedPadSizes are the pad dimensions the page states about itself, in
// metres, smallest side first. 177 of the 246 landing sheets print at least
// one, and a sheet's own statement about its own drawing is the best
// evidence there is for what the square around the marking IS.
func printedPadSizes(lines []string) []float64 {
	var out []float64
	for _, l := range lines {
		for _, m := range padDimRe.FindAllStringSubmatch(l, -1) {
			for _, s := range m[1:] {
				v, err := strconv.ParseFloat(strings.Replace(s, ",", ".", 1), 64)
				if err == nil && v >= minPadSizeM && v <= maxPadSizeM {
					out = append(out, v)
				}
			}
		}
	}
	return out
}

// fitHelipad places the panels of a helistation landing sheet.
//
// Every panel is tried, because the three readings are not on the same one:
// the site plan carries the scale bar and draws its pad too small to read,
// and the pad detail below it draws the pad large, with its own north
// arrow, and prints no bar at all. What the sheet does print, on 176 of the
// 246, is how many metres across its own squares are.
func fitHelipad(c pageContent, pads []padRef) (*panelFit, string) {
	if len(pads) == 0 {
		return nil, "no-pad"
	}
	panels := stackedPanels(c)
	if len(panels) == 0 {
		return nil, "no-panel"
	}
	runs := dedupeRuns(c.runs)
	sizes := append(printedPadSizes(pageLines(c.runs)), pads[0].sizesM...)
	worst := padWhy{}
	for _, panel := range panels {
		marks := padMarks(c, panel)
		if len(marks) == 0 {
			marks = padGlyphMarks(c, panel)
		}
		if len(marks) == 0 {
			worst.see("no-mark")
			continue
		}
		// One pad per panel. Two markings mean the reader cannot say which
		// is the pad, and the position it would be anchored on is one.
		if len(marks) > 1 {
			worst.see("two-marks")
			continue
		}
		mark := marks[0]
		north, ok := panelNorth(c, panel)
		if !ok {
			worst.see("no-north")
			continue
		}
		squares := padSquares(c, mark)
		if len(squares) == 0 {
			worst.see("no-square")
			continue
		}
		if len(sizes) == 0 {
			worst.see("no-size")
			continue
		}
		bar, hasBar := scaleBarWithin(c, runs, panel, minPadPtPerM, maxPadPtPerM)
		scale, dev, from, ok := padScale(squares, sizes, bar, hasBar)
		if !ok {
			worst.see(from)
			continue
		}
		pad := pads[0]
		fr := newLocal(pad.pos)
		cx, cy := mark.cx, mark.cy
		// The second point pair: a fixed arm up the north arrow, which is
		// the same distance north on the ground. Two pairs are a
		// similarity, and runway.go already fits one.
		const armPt = 100
		page := [][2]float64{
			{cx, cy},
			{cx + armPt*math.Cos(north.Angle), cy + armPt*math.Sin(north.Angle)},
		}
		metric := [][2]float64{{0, 0}, {0, armPt / scale}}
		sim := fitSimilarity(page, metric)
		if sim == nil {
			worst.see("degenerate")
			continue
		}
		geo := geoAffine{
			A: sim.scos / fr.mPerLon, C: -sim.ssin / fr.mPerLon,
			E: pad.pos.lon + sim.tx/fr.mPerLon,
			B: sim.ssin / fr.mPerLat, D: sim.scos / fr.mPerLat,
			F: pad.pos.lat + sim.ty/fr.mPerLat,
		}
		return &panelFit{
			Clip:      panel,
			Frame:     panel,
			Geo:       geo,
			Method:    "helipad",
			North:     north,
			PadGridM:  padGridM(pad.pos.lat, pad.pos.lon),
			ScaleFrom: from,
			ScaleDev:  dev * 100,
			PtPerNM:   scale * 1852,
		}, ""
	}
	return nil, worst.reason()
}

// padScale reads the panel's scale off the pad, in points per metre, and is
// where the placement is refused or allowed.
//
// TWO READINGS HAVE TO AGREE, always. Where the panel prints a scale bar,
// the bar and the drawn pad are the two: the pad measured at the bar's
// scale has to be a size the AIP or the sheet states. Where it prints none,
// the two are the pad's own squares: their RATIO owes the scale nothing, so
// a pair of squares standing in the ratio the notes state IS the pad, and
// their sizes then give the scale. One square and no bar is one reading,
// and one reading is not evidence: the marking would be taken on trust and
// a courtyard would place the panel as readily as a helipad.
func padScale(squares []float64, sizes []float64, bar float64, hasBar bool) (scale, dev float64, why string, ok bool) {
	if hasBar {
		best, ok := 0.0, false
		for _, sq := range squares {
			if d, got := nearestSize(sq/bar, sizes); got && (!ok || math.Abs(d) < math.Abs(best)) {
				best, ok = d, true
			}
		}
		if !ok || math.Abs(best) > maxPadSizeDev {
			// The bar and the pad disagree. The two readings are both
			// there and they are not the same answer, which is the one
			// refusal here that is about the SHEET.
			return 0, 0, "pad-bar", false
		}
		return bar, best, "bar", true
	}
	if len(squares) < 2 {
		return 0, 0, "pad-one-square", false
	}
	// Every pair of drawn squares against every pair of published sizes.
	// Not just the extremes: a sheet draws the touchdown area, the final
	// approach area and the safety area around them, and states the sizes
	// of only two of the three as often as not.
	bestDev, bestScale, ok := 0.0, 0.0, false
	drawnPair, statedPair := false, false
	for i := range squares {
		for j := i + 1; j < len(squares); j++ {
			small, large := squares[i], squares[j]
			if small <= 0 || large/small < minPadPairRatio {
				continue
			}
			drawnPair = true
			drawn := large / small
			for _, a := range sizes {
				for _, b := range sizes {
					if a <= 0 || b <= a*minPadPairRatio {
						continue
					}
					statedPair = true
					dev := drawn/(b/a) - 1
					if math.Abs(dev) > maxPadRatioDev {
						continue
					}
					sc := (small/a + large/b) / 2
					if sc < minPadPtPerM || sc > maxPadPtPerM {
						continue
					}
					if !ok || math.Abs(dev) < math.Abs(bestDev) {
						bestDev, bestScale, ok = dev, sc, true
					}
				}
			}
		}
	}
	// Three different things end here and they are not one refusal. The
	// sheet may have drawn no two squares far enough apart to be a pair;
	// the AIP may state no two sizes far enough apart, which is a gap in
	// OUR data and not on the plate at all; or both had a pair and no two
	// agreed. Only the last is the sheet saying something we disbelieve.
	switch {
	case ok:
		return bestScale, bestDev, "ratio", true
	case !drawnPair:
		return 0, 0, "pad-alike", false
	case !statedPair:
		return 0, 0, "pad-one-size", false
	}
	return 0, 0, "pad-ratio", false
}

// padWhy keeps the furthest a sheet got, so the report says what stood in
// the way rather than what the last panel happened to lack.
type padWhy struct {
	rank int
	why  string
}

var padWhyRank = map[string]int{
	"no-mark": 1, "two-marks": 2, "no-north": 3, "no-square": 4,
	"no-size": 5, "pad-one-square": 6, "pad-alike": 7, "pad-one-size": 8,
	"pad-ratio": 9, "pad-bar": 10, "degenerate": 11,
}

func (p *padWhy) see(why string) {
	if r := padWhyRank[why]; r > p.rank {
		p.rank, p.why = r, why
	}
}

func (p *padWhy) reason() string {
	if p.why == "" {
		return "no-mark"
	}
	return p.why
}

// nearestSize returns the smallest relative difference between a measured
// length and any published one.
func nearestSize(m float64, sizes []float64) (float64, bool) {
	best, ok := 0.0, false
	for _, s := range sizes {
		if s <= 0 {
			continue
		}
		d := m/s - 1
		if !ok || math.Abs(d) < math.Abs(best) {
			best, ok = d, true
		}
	}
	return best, ok
}
