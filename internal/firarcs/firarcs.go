// Package firarcs classifies FIR-family boundary rings into their
// foreign-facing runs (the `arcs` dataset cell). The 1:500 000 chart
// convention the app follows prints the boundary BETWEEN two FIRs of
// the SAME state as a de-emphasized grey form and keeps the bold
// ink + stubs for international limits; `arcs` is the
// convention-NEUTRAL data both renditions key off (a future theme,
// e.g. FAA-convention, would restyle the two run kinds without
// touching this classification).
//
// Grouping is same state AND same type: a state's UIR outline (the
// LFFF UIR "FRANCE" ring) traces the union of its FIR rings, so
// classifying across types would mark a whole national outline
// internal. Typed groups keep such rows singletons (nil arcs, full
// ink).
package firarcs

import "math"

// StateKey returns the same-state grouping key of a 4-letter ICAO
// location indicator: "" when the ident has no four-letter head
// (never grouped), else the 2-letter prefix with the known
// larger-state overrides (USA incl. Alaska, Canada, Australia, Spain
// incl. the Canaries). Multi-prefix states beyond those (Russia's
// UE/UH/UI/UL/UN/UO/UR/US/UU/UW, China's ZB/ZG/...) are deliberately
// NOT merged: under-grouping keeps an internal boundary in ink (the
// safe direction), while a wrong merge would grey a real
// international limit (U covers Ukraine and Kazakhstan too, Z covers
// the DPRK and Mongolia).
func StateKey(ident string) string {
	if len(ident) < 4 {
		return ""
	}
	for i := 0; i < 4; i++ {
		if ident[i] < 'A' || ident[i] > 'Z' {
			return ""
		}
	}
	switch ident[0] {
	case 'K':
		return "K" // USA
	case 'C':
		return "C" // Canada
	case 'Y':
		return "Y" // Australia
	}
	switch p := ident[:2]; p {
	case "PA":
		return "K" // Alaska rides the USA group
	case "GC":
		return "LE" // the Canary Islands are Spain
	default:
		return p
	}
}

// FIRFamily reports whether an emitted airspace type is a FIR-family
// row (the rows the app renders with the FIR-limit form and files
// NOTAM Item A) briefings under).
func FIRFamily(typ string) bool {
	switch typ {
	case "FIR", "UIR", "OCA", "ARTCC", "ACC":
		return true
	}
	return false
}

// Apply patches the arcs cell of the FIR-family rows that have
// same-state same-type siblings, once every ring is built; every other
// row keeps its nil cell. Rows follow the shared positional dataset
// schema: id at 0, type at 1, ring ([][2]float64) at 12, arcs at 14
// (cmd/fr, internal/aixm5build and the overlay pipeline all emit it).
// A row with no siblings, a headless ident (OCA4521) or a fully
// external ring stays nil; a fully INTERNAL ring gets the empty
// non-nil slice (the app then draws the whole ring de-emphasized).
func Apply(rows []any) {
	type gkey struct{ state, typ string }
	groups := make(map[gkey][]int)
	for i, r := range rows {
		row := r.([]any)
		typ, _ := row[1].(string)
		if !FIRFamily(typ) {
			continue
		}
		id, _ := row[0].(string)
		state := StateKey(id)
		if state == "" {
			continue
		}
		k := gkey{state, typ}
		groups[k] = append(groups[k], i)
	}
	for _, idxs := range groups {
		if len(idxs) < 2 {
			continue
		}
		for _, i := range idxs {
			ring, _ := rows[i].([]any)[12].([][2]float64)
			others := make([][][2]float64, 0, len(idxs)-1)
			for _, j := range idxs {
				if j == i {
					continue
				}
				if oring, ok := rows[j].([]any)[12].([][2]float64); ok {
					others = append(others, oring)
				}
			}
			if arcs := ExternalArcs(ring, others); arcs != nil {
				rows[i].([]any)[14] = arcs
			}
		}
	}
}

// arcTolKm: a point counts as on a neighbouring ring within this
// distance. Adjacent rings trace the same AIP boundary but keep
// independent intermediate vertices, so exact vertex equality would
// miss most shared segments.
const arcTolKm = 2.0

// arcSampleKm: sampling step along an edge for the internal test. A
// coarse ring's single edge can face TWO different neighbours in turn
// (LFRR's 0d15'W meridian edge borders LFFF down to 47.17 N, then
// LFBB): the edge is internal when EVERY sample lies near the UNION
// of the other rings, not near one single ring.
const arcSampleKm = 5.0

// pointSegKm is the equirectangular point-to-segment distance in km,
// adequate at mid latitudes for a 2 km tolerance test.
func pointSegKm(p, a, b [2]float64) float64 {
	kx := 111.32 * math.Cos(p[0]*math.Pi/180)
	ax, ay := (a[1]-p[1])*kx, (a[0]-p[0])*111.32
	bx, by := (b[1]-p[1])*kx, (b[0]-p[0])*111.32
	dx, dy := bx-ax, by-ay
	l2 := dx*dx + dy*dy
	t := 0.0
	if l2 > 0 {
		t = math.Max(0, math.Min(1, -(ax*dx+ay*dy)/l2))
	}
	return math.Hypot(ax+t*dx, ay+t*dy)
}

func pointNearRing(p [2]float64, ring [][2]float64, tolKm float64) bool {
	n := len(ring)
	for i := 0; i < n; i++ {
		if pointSegKm(p, ring[i], ring[(i+1)%n]) <= tolKm {
			return true
		}
	}
	return false
}

// ExternalArcs splits an open ring (closing vertex omitted, edge
// n-1 -> 0 implied) into the maximal runs of edges not shared with any
// ring in `others`, merging runs across the ring seam. Returns nil
// when every edge is external (the caller keeps the default full-ring
// rendering) and an EMPTY slice when every edge is internal (the app
// then draws the whole ring in the de-emphasized form).
func ExternalArcs(ring [][2]float64, others [][][2]float64) [][][2]float64 {
	n := len(ring)
	if n < 3 || len(others) == 0 {
		return nil
	}
	nearAny := func(p [2]float64) bool {
		for _, o := range others {
			if pointNearRing(p, o, arcTolKm) {
				return true
			}
		}
		return false
	}
	internal := make([]bool, n)
	anyInternal := false
	for i := 0; i < n; i++ {
		a, b := ring[i], ring[(i+1)%n]
		kx := 111.32 * math.Cos((a[0]+b[0])/2*math.Pi/180)
		lenKm := math.Hypot((b[0]-a[0])*111.32, (b[1]-a[1])*kx)
		steps := int(lenKm/arcSampleKm) + 1
		if steps < 2 {
			steps = 2
		}
		inside := true
		for k := 0; k <= steps; k++ {
			t := float64(k) / float64(steps)
			p := [2]float64{a[0] + (b[0]-a[0])*t, a[1] + (b[1]-a[1])*t}
			if !nearAny(p) {
				inside = false
				break
			}
		}
		if inside {
			internal[i] = true
			anyInternal = true
		}
	}
	if !anyInternal {
		return nil
	}
	// Start each arc at an external edge whose predecessor is internal so
	// a run spanning the seam comes out as ONE arc.
	start := -1
	for i := 0; i < n; i++ {
		if !internal[i] && internal[(i+n-1)%n] {
			start = i
			break
		}
	}
	if start == -1 {
		return [][][2]float64{}
	}
	var arcs [][][2]float64
	i := start
	for consumed := 0; consumed < n; {
		arc := [][2]float64{ring[i]}
		for consumed < n && !internal[i] {
			arc = append(arc, ring[(i+1)%n])
			i = (i + 1) % n
			consumed++
		}
		arcs = append(arcs, arc)
		for consumed < n && internal[i] {
			i = (i + 1) % n
			consumed++
		}
	}
	return arcs
}
