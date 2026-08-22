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
// with position, which no scatter of bearings does.

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
	labNum = regexp.MustCompile(`^(\d{1,2})\D{0,2}$`)
	// A seconds run, which must carry its mark: a bare number beside a
	// label could be anything on the map.
	labSec = regexp.MustCompile(`^(\d{1,2})\s*["”\x{2033}]$`)
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
		if m == nil {
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
			if dy < bestDy {
				best, bestDy = j, dy
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
		if len(grp) < 2 || !monotone(grp, pos) {
			continue
		}
		// The band is wide on purpose: an APP sheet runs about 10 pt to
		// the arcminute and a helipad plate, labelled every ten seconds,
		// runs past 400.
		if ptPerMin := spanRatio(grp, pos); ptPerMin < 5 || ptPerMin > 2000 {
			continue
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
