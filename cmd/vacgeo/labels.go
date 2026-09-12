// labels.go reads a panel's graticule labels: the "48° 53'" and "002° 40'"
// marks the SIA prints along a neatline or an internal parallel.
//
// The labels do NOT carry the geometry. Their anchors wander a couple of
// points against the tick they name (the SIA sets them by eye, and a label
// drawn as one string sits where its first glyph starts, not where the tick
// is), which over a 34 pt tick spacing is a 7 % scale error if you fit to
// them. Their job is to say which arcminute each tick IS; panels.go takes
// the geometry from the ticks themselves.
//
// Four printed forms appear across the corpus and all four have to read:
//
//	"002°  40'"       one run, degrees and minutes together
//	"48°" / "53'"     two runs stacked, the minutes on the next line
//	"50°" / "40"      the same, with NO prime mark at all
//	"43°"/"55'"/"20\"" three lines, degrees-minutes-seconds (helistations)
//
// The separator between the numbers is deliberately matched as "any run of
// non-digits". The prime is a real quotesingle on some plates, a U+2019 on
// others (text.go explains why), and the degree sign can arrive as ° or º.
// Pinning the exact characters is what the cmd/supaip prime-mark bug taught
// this repo not to do.
//
// The cost of a loose separator is that magnetic bearings ("051° 10 NM",
// "264° 12 NM CLM") parse as plausible longitudes. They are rejected twice:
// a run carrying a unit token is not a coordinate, and pickAxis keeps only
// the largest family of labels that share an axis line AND run monotonically
// with position, which no scatter of bearings does. A family may shed ONE
// member to run monotonically, and only where that reading is unique
// (withoutTheOdd), because a plate can print a label that belongs to no
// axis at all.

package main

import (
	"math"
	"regexp"
	"strconv"
	"strings"
)

var (
	// One run holding degrees, minutes and optionally seconds.
	labDMS = regexp.MustCompile(`^(\d{1,3})\D{1,4}(\d{1,2})\D{1,4}(\d{1,2}(?:[.,]\d+)?)\D{0,4}$`)
	labDM  = regexp.MustCompile(`^(\d{1,3})\D{1,4}(\d{1,2})\D{0,4}$`)
	// One run holding a single number: degrees (with a mark) or minutes
	// (with or without one).
	labDeg = regexp.MustCompile(`^(\d{1,3})\D{1,2}$`)
	// A minutes or seconds fragment: digits, then at most a mark. \D was
	// too kind, and let "36 A" stand in for the minutes of a label whose
	// head was a stray seconds run. The mark itself stays unpinned, for
	// the reason the file header gives: it is a quotesingle on some plates
	// and a U+2019 on others. What it may not be is a LETTER.
	labNum = regexp.MustCompile(`^(\d{1,2})[^[:alnum:]]{0,2}$`)
	// A seconds run, which must carry its mark: a bare number beside a
	// label could be anything on the map.
	//
	// The mark is a double prime, and a plate sets one of two ways: as a
	// double-quote character, or as its own MINUTE mark written twice. The
	// second form is what the helistation approach sheets use, XEP encoding
	// it as MT146 twice, and refusing it cost those sheets their seconds and
	// then their axis: labelled at 30 second intervals over two to four
	// arcminutes, a sheet whose seconds are dropped has two labels claiming
	// one value, and pickAxis wants its labels strictly monotone.
	labSec = regexp.MustCompile(`^(\d{1,2})\s*(?:["”\x{2033}]|['’]{2})$`)
)

// secondsAfter finds the seconds run abutting label i on its own baseline,
// or -1. The seconds are set tight against the minutes, so the search is a
// few points either side of where the label ends.
func secondsAfter(runs []textRun, used []bool, i int) int {
	head := runs[i]
	end := head.x + head.adv
	for j, r := range runs {
		if j == i || used[j] {
			continue
		}
		if math.Abs(r.y-head.y) > 1.5 || r.x < end-3 || r.x > end+8 {
			continue
		}
		if labSec.MatchString(strings.TrimSpace(r.text)) {
			return j
		}
	}
	return -1
}

// unitTokens mark a run as something other than a coordinate. Bearings,
// distances, levels and altitudes all share the degree sign or the digits.
var unitTokens = []string{"NM", "FL", "KM", "FT", "HPA", "MHZ"}

// label is one graticule mark: where it sits in page space and which
// arcminute it names. lon distinguishes the two axes by the width of the
// degrees field, which the SIA prints as three digits for longitude
// everywhere, metropole and overseas alike.
type label struct {
	x, y float64
	min  float64
	lon  bool
}

// dedupeRuns drops the doubled show strings these plates emit (each label
// is drawn twice, stroke then fill).
func dedupeRuns(runs []textRun) []textRun {
	out := make([]textRun, 0, len(runs))
	seen := make(map[string]bool, len(runs))
	for _, r := range runs {
		k := strconv.FormatFloat(math.Round(r.x*100), 'f', 0, 64) + "|" +
			strconv.FormatFloat(math.Round(r.y*100), 'f', 0, 64) + "|" + r.text
		if seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, r)
	}
	return out
}

func hasUnit(s string) bool {
	up := strings.ToUpper(s)
	for _, t := range unitTokens {
		if strings.Contains(up, t) {
			return true
		}
	}
	return false
}

// minutesOf turns degrees, minutes and seconds into arcminutes.
func minutesOf(d, m, s float64) float64 { return d*60 + m + s/60 }

func atof(s string) float64 {
	v, _ := strconv.ParseFloat(strings.Replace(s, ",", ".", 1), 64)
	return v
}

// parseLabels reads every graticule label on a page. Runs are considered
// first whole (a one-run label), then as the head of a stacked group.
func parseLabels(runs []textRun) []label {
	runs = dedupeRuns(runs)
	var out []label
	used := make([]bool, len(runs))
	for i, r := range runs {
		if used[i] || hasUnit(r.text) {
			continue
		}
		t := strings.Join(strings.Fields(r.text), " ")
		if m := labDMS.FindStringSubmatch(t); m != nil {
			out = append(out, mkLabel(r.x+r.adv/2, r.y, m[1], m[2], m[3]))
			used[i] = true
			continue
		}
		if m := labDM.FindStringSubmatch(t); m != nil {
			// Helistation plates print the seconds as their own run,
			// sometimes stacked under the label and sometimes abutting
			// it on the same baseline. Without them "004° 47' 30"" and
			// "004° 48'" both read as whole minutes, two labels claim
			// one value, and the axis is thrown away as non-monotone.
			sec := ""
			if j := secondsAfter(runs, used, i); j >= 0 {
				sec = labSec.FindStringSubmatch(strings.TrimSpace(runs[j].text))[1]
				used[j] = true
			}
			out = append(out, mkLabel(r.x+r.adv/2, r.y, m[1], m[2], sec))
			used[i] = true
			continue
		}
		m := labDeg.FindStringSubmatch(t)
		if m == nil || labSec.MatchString(t) {
			// A seconds run heads nothing. Lesparre prints its 30" as its
			// own run, and letting it stand as a degrees head collected
			// whatever number sat below it.
			continue
		}
		// A degrees run on its own: the minutes (and maybe the seconds)
		// are stacked under it, left-aligned on the same x.
		parts, idx := stackedUnder(runs, used, i)
		if len(parts) == 0 {
			continue
		}
		sec := ""
		if len(parts) > 1 {
			sec = parts[1]
		}
		lo, hi := r.y, r.y
		for _, j := range idx {
			lo = math.Min(lo, runs[j].y)
			hi = math.Max(hi, runs[j].y)
			used[j] = true
		}
		used[i] = true
		out = append(out, mkLabel(r.x+r.adv/2, (lo+hi)/2, m[1], parts[0], sec))
	}
	return out
}

// stackedUnder collects the one or two number runs sitting directly below
// run i on the same left edge, which is how the SIA stacks a side label.
func stackedUnder(runs []textRun, used []bool, i int) ([]string, []int) {
	head := runs[i]
	var texts []string
	var idx []int
	y := head.y
	for pass := 0; pass < 2; pass++ {
		best := -1
		bestDy := math.MaxFloat64
		bestNum := ""
		for j, r := range runs {
			if j == i || used[j] || hasUnit(r.text) {
				continue
			}
			dy := y - r.y
			if dy <= 0.5 || dy > head.size*2.2 || math.Abs(r.x-head.x) > 3.5 {
				continue
			}
			if !labNum.MatchString(strings.TrimSpace(r.text)) {
				continue
			}
			// The plates draw each label TWICE, stroke then fill, and the
			// two passes do not always break the string the same way:
			// Compiegne's 49 26' 30" comes out as one run "26'" and, at the
			// SAME point, as "2" followed by "6'". dedupeRuns cannot see it,
			// since it matches on the text as well as the place.
			//
			// Taking the first in stream order took the fragment, and the
			// label became 49 02' 30". Nothing downstream could recover:
			// pickAxis threw the family away as off its own line, and the
			// coverage doc wrote the three survivors up as numbers belonging
			// to no grid. They were the plate's own labels.
			//
			// What identifies the pair is not that one is longer: it is that
			// the fragment is a PREFIX of the whole, drawn at the same point.
			// Two different numbers at one place are two different marks and
			// the reader must not choose between them on length, which put
			// LF330 sixty-nine kilometres out when it did.
			num := labNum.FindStringSubmatch(strings.TrimSpace(r.text))[1]
			if best >= 0 && math.Abs(dy-bestDy) <= 0.6 &&
				strings.HasPrefix(num, bestNum) && len(num) > len(bestNum) {
				best, bestDy, bestNum = j, dy, num
				continue
			}
			if dy < bestDy {
				best, bestDy, bestNum = j, dy, num
			}
		}
		if best < 0 {
			break
		}
		texts = append(texts, labNum.FindStringSubmatch(strings.TrimSpace(runs[best].text))[1])
		idx = append(idx, best)
		y = runs[best].y
	}
	return texts, idx
}

func mkLabel(x, y float64, d, m, s string) label {
	return label{x: x, y: y, min: minutesOf(atof(d), atof(m), atof(s)), lon: len(d) == 3}
}

// pickAxis keeps the largest family of same-axis labels that share a line
// and run monotonically with position: latitude labels stack down one side
// at a common x, longitude labels sit along one baseline at a common y.
// This is the whole defence against magnetic bearings, which scatter.
func pickAxis(labels []label, lon bool) []label {
	var cands []label
	for _, l := range labels {
		if l.lon == lon {
			cands = append(cands, l)
		}
	}
	// key: the coordinate the family shares. pos: the one it varies along.
	key := func(l label) float64 { return l.x }
	pos := func(l label) float64 { return l.y }
	if lon {
		key, pos = pos, key
	}
	// What a graticule family IS: values that run in order with position,
	// lying on one straight relation with it, at a plausible scale.
	//
	// The line test used to be asked only of a family that had already
	// shed a member, which left the case where the intruder happens to run
	// in order with the rest: the Villeneuve d'Ascq approach sheet labels
	// its meridians 003 00 and 003 05 on one baseline and prints a bearing
	// three points below it that parses as 109 00, the three ascend
	// together, and the family reads 0.03 points to the arcminute and is
	// thrown away whole.
	//
	// The scale band is part of the test and not a step after it. It is
	// wide on purpose, an APP sheet running about 10 points to the
	// arcminute and a helipad plate labelled every ten seconds running
	// past 400, and it is what makes a rescue UNIQUE: any two labels run
	// in order and lie on a line, so dropping one of three says nothing
	// until something else says which pair is a grid.
	graticule := func(g []label) bool {
		r := spanRatio(g, pos)
		return monotone(g, pos) && onOneLine(g, pos) && r >= 5 && r <= 2000
	}
	var best []label
	for _, anchor := range cands {
		var grp []label
		for _, l := range cands {
			if math.Abs(key(l)-key(anchor)) < 4 {
				grp = append(grp, l)
			}
		}
		if len(grp) < 2 {
			continue
		}
		sortByPos(grp, pos)
		grp = dropCollisions(grp, pos)
		if len(grp) < 2 {
			continue
		}
		if !graticule(grp) {
			// One intruder is a reading of the family; two is a rewrite of
			// it, and a scatter of bearings that parses as coordinates must
			// not become an axis by losing members. withoutTheOdd refuses
			// where more than one drop answers, which is the other half.
			grp = withoutTheOdd(grp, pos, graticule)
			if len(grp) < 2 {
				continue
			}
			// A rescue may leave a PAIR, which the monotonicity-only rule
			// could not allow: dropping one of three left two labels that
			// fix a scale between them and nothing to say which of the
			// three had gone. The scale band says it. Val Thorens labels
			// its meridians 006 33 and 006 35 on one baseline with a
			// bearing between them that parses as 003 34, and the three
			// candidate pairs read 92.2, 0.51 and 0.51 points to the
			// arcminute: one is a graticule and the other two are not, by
			// a factor of a hundred and eighty.
			//
			// Requiring three survivors anyway was measured and costs Val
			// Thorens and Perpignan, both of them confirmed over
			// orthophotos, and prevents nothing the corpus shows.
		}
		if len(grp) > len(best) {
			best = grp
		}
	}
	// A panel may print one label on an axis and rely on the reader to
	// carry the other (LFDF names 44°51' once, down the left edge). One
	// label fixes the offset; the projection fixes the scale. It is only
	// safe when nothing else on the page could be mistaken for it, so it
	// applies when the axis has exactly one candidate in the first place.
	if len(best) == 0 && len(cands) == 1 {
		best = cands
	}
	return best
}

// maxLabelOffLine is how far a rescued family's label may sit from the line
// the family itself draws, as a fraction of the gap to its neighbour. At a
// fifth of a gap there is no question which tick a label names, and the
// corpus separates cleanly: the families worth rescuing sit 0.18, 0.34 and
// 4.6 points off their line, a twentieth of a gap at worst, while the ones
// that merely run in order sit 81 and 91 points off it, half a gap and
// eight gaps.
const maxLabelOffLine = 0.2

// onOneLine reports whether the labels sit on ONE line of position against
// value, which is what a graticule IS: a panel is linear over its own
// extent to far better than its drafting accuracy, so the arcminute a label
// names and the point it sits at are one straight relation. Two labels lie
// on a line by construction, so the caller's floor of three is what makes
// this a test at all.
//
// Monotonicity alone does not say that, and after a family has been allowed
// to shed a member it is not enough: LFAK and LFAD each keep three numbers
// that ascend down the edge and stand 81 and 91 points off their own line,
// having nothing to do with any grid. Both fitted, and both were left to the
// ARP gate to catch, which resolves a panel to about half its own width. A
// misfit that lands inside that is exactly the chart this command must not
// draw.
func onOneLine(g []label, pos func(label) float64) bool {
	n := float64(len(g))
	if n < 3 {
		return true
	}
	var sv, sp, svv, svp float64
	for _, l := range g {
		sv += l.min
		sp += pos(l)
		svv += l.min * l.min
		svp += l.min * pos(l)
	}
	den := n*svv - sv*sv
	if den == 0 {
		return false
	}
	slope := (n*svp - sv*sp) / den
	at0 := (sp - slope*sv) / n
	// g is sorted by position, so this is the mean gap between neighbours.
	gap := math.Abs(pos(g[len(g)-1])-pos(g[0])) / (n - 1)
	for _, l := range g {
		if math.Abs(pos(l)-(slope*l.min+at0)) > maxLabelOffLine*gap {
			return false
		}
	}
	return true
}

// withoutTheOdd returns g without the single label that stops it answering
// `ok`, or nil when no one label explains it, or more than one does.
//
// A plate can carry a label that is not on the axis at all. LFPT's landing
// chart prints a second "49° 03'" in its header band, above its own
// neatline and clipped out of the printed sheet, so the left edge reads 03
// 04 05 06 07 08 and then 03 again; the whole-family test threw six good
// labels away with it and the sheet was left unplaceable. Dropping the one
// intruder is a reading of the family; dropping any more is a rewrite of
// it, and a scatter of bearings that parses as coordinates must not become
// an axis by losing a member.
//
// The uniqueness is the other half of that: 1 3 2 4 can be read two ways,
// so it is read neither way.
func withoutTheOdd(g []label, pos func(label) float64, ok func([]label) bool) []label {
	var keep []label
	for i := range g {
		cand := make([]label, 0, len(g)-1)
		cand = append(cand, g[:i]...)
		cand = append(cand, g[i+1:]...)
		if len(cand) < 2 || !ok(cand) {
			continue
		}
		if keep != nil {
			return nil
		}
		keep = cand
	}
	return keep
}

func sortByPos(g []label, pos func(label) float64) {
	for i := 1; i < len(g); i++ {
		for j := i; j > 0 && pos(g[j]) < pos(g[j-1]); j-- {
			g[j], g[j-1] = g[j-1], g[j]
		}
	}
}

// dropCollisions removes labels sitting on top of one another, which a
// doubled draw or a repeated edge label produces.
func dropCollisions(g []label, pos func(label) float64) []label {
	out := g[:1]
	for _, l := range g[1:] {
		if math.Abs(pos(l)-pos(out[len(out)-1])) < 3 {
			continue
		}
		out = append(out, l)
	}
	return out
}

// monotone reports whether the values move consistently with position.
// A graticule always does; a handful of bearings that happen to share a
// baseline does not.
func monotone(g []label, pos func(label) float64) bool {
	up := g[len(g)-1].min > g[0].min
	for i := 1; i < len(g); i++ {
		if (g[i].min > g[i-1].min) != up || g[i].min == g[i-1].min {
			return false
		}
	}
	return true
}

// spanRatio is the labels' implied points per arcminute, used only as a
// plausibility band: the real scale comes from the ticks.
func spanRatio(g []label, pos func(label) float64) float64 {
	dv := g[len(g)-1].min - g[0].min
	if dv == 0 {
		return 0
	}
	return math.Abs((pos(g[len(g)-1]) - pos(g[0])) / dv)
}
