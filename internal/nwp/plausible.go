package nwp

import (
	"fmt"
	"sort"
	"strings"
)

// bounds are the physical limits a stored value must keep: a field outside
// them is a unit or a decoding gone wrong, and the block is refused (the
// previous run keeps serving and the stale alert says so).
var bounds = map[string][2]float64{
	VarU: {-250, 250}, VarV: {-250, 250}, VarU10: {-250, 250}, VarV10: {-250, 250}, VarGust: {0, 250},
	// A level's temperature is the producer's extrapolation below a hot
	// plateau's ground: IFS's 1000 hPa read 52.4 °C over the Lut desert on
	// 2025-07-04 (44.3 °C over Oman on 2026-10-06), where a 50 °C ceiling
	// refused every IFS run of a heat wave, truncated ones included. The
	// gates catch a unit gone wrong (273 off), which these still do.
	VarT: {-100, 70}, VarT2: {-95, 65},
	VarZ:     {-1500, 12500},
	VarCloud: {0, 100},
	// A model reduces its surface pressure to the sea through its own
	// temperatures: 1094 hPa was observed under the Siberian high of
	// December 2020, and ARPEGE's Dead Sea point (-502 m) reads 1067 hPa on
	// an ordinary day, about 1100 under a strong Levant high.
	VarMSLP: {850, 1100}, VarPS: {300, 1120},
	VarElevation: {-1000, 9000}, // the Dead Sea lies inside ARPEGE's Europe
}

// mustVary are the variables a whole block's step cannot hold constant.
var mustVary = map[string]bool{VarU: true, VarV: true, VarT: true, VarZ: true, VarMSLP: true, VarU10: true, VarV10: true}

// CheckPlausible applies the gates to every stored field over the covered
// points: values within bounds, no frozen field where the variable must
// vary, and geopotential heights rising up every column.
func (c *Cube) CheckPlausible() error {
	g := c.Model.Grid
	n := g.Ni * g.Nj
	var problems []string
	for s := Segment(0); s < NumSegments; s++ {
		ns := max(1, len(c.Steps[s]))
		if s == SegStatic {
			ns = 1
		}
		for vi, v := range c.Layout[s] {
			lim, ok := bounds[v.Name]
			if !ok {
				problems = append(problems, fmt.Sprintf("%s has no bounds", v.Key()))
				continue
			}
			for si := 0; si < ns; si++ {
				field := c.data[s][c.slot(s, vi, si)]
				if field == nil {
					continue
				}
				lo, hi := 1e300, -1e300
				for k := 0; k < n; k++ {
					q := field[k]
					if q == Missing || !c.Covered(k) {
						continue
					}
					x := v.Value(q)
					lo, hi = min(lo, x), max(hi, x)
				}
				if lo > hi {
					problems = append(problems, fmt.Sprintf("%s step %d has no value", v.Key(), si))
					continue
				}
				if lo < lim[0] || hi > lim[1] {
					problems = append(problems, fmt.Sprintf("%s step %d spans %g..%g outside %g..%g", v.Key(), si, lo, hi, lim[0], lim[1]))
				}
				if mustVary[v.Name] && lo == hi {
					problems = append(problems, fmt.Sprintf("%s step %d is constant (%g)", v.Key(), si, lo))
				}
			}
		}
	}
	// Heights rise with the level: from 1000 hPa up the ladder.
	levels := append([]int(nil), c.Model.Levels...)
	sort.Sort(sort.Reverse(sort.IntSlice(levels)))
	for si := range c.Steps[SegZ] {
		var prev []int16
		for _, lv := range levels {
			_, vi, ok := c.Layout.Find(Var{Name: VarZ, Level: lv}.Key())
			if !ok {
				continue
			}
			field := c.data[SegZ][c.slot(SegZ, vi, si)]
			if field == nil {
				continue
			}
			if prev != nil {
				bad := 0
				for k := 0; k < n; k++ {
					if c.Covered(k) && field[k] != Missing && prev[k] != Missing && field[k] <= prev[k] {
						bad++
					}
				}
				if bad > 0 {
					problems = append(problems, fmt.Sprintf("heights fall to %d hPa at %d points, step %d", lv, bad, si))
				}
			}
			prev = field
		}
	}
	if len(problems) > 0 {
		if len(problems) > 6 {
			problems = append(problems[:6], fmt.Sprintf("and %d more", len(problems)-6))
		}
		return fmt.Errorf("nwp: %s %s %s implausible: %s", c.Model.ID, RunKey(c.Run), c.Block.Name(), strings.Join(problems, "; "))
	}
	return nil
}
