package nwp

import (
	"fmt"
	"math"
	"sort"
)

// isaExponent is R L / g, the power of the pressure the ICAO standard
// atmosphere's height is linear in: z = T0 / L (1 - (p / p0)^(R L / g)).
const isaExponent = 287.05287 * 0.0065 / standardGravity

// GroundInColumn is where a surface pressure (hPa) stands in an isobaric
// column, levels (hPa) paired with their heights (m): the height
// interpolated between the two levels around it linearly in p^(R L / g),
// exact over a layer at the standard lapse rate and a few metres from the
// truth over an isothermal one (8 m at the middle of IFS's 850-700 hPa
// layer), extrapolated from the nearest two levels past the column's ends
// (a surface above 1000 hPa). The levels below the ground are the
// producer's own extrapolation down from its surface, so the height found
// is the model's ground. False with fewer than two finite levels or a
// column whose heights do not rise as the pressure falls.
func GroundInColumn(surfaceHpa float64, levels []int, heights []float64) (float64, bool) {
	type lv struct{ p, z float64 }
	col := make([]lv, 0, len(levels))
	for i, p := range levels {
		if i < len(heights) && !math.IsNaN(heights[i]) && p > 0 {
			col = append(col, lv{float64(p), heights[i]})
		}
	}
	if len(col) < 2 || !(surfaceHpa > 0) {
		return 0, false
	}
	sort.Slice(col, func(a, b int) bool { return col[a].p > col[b].p })
	for k := 1; k < len(col); k++ {
		if col[k].z <= col[k-1].z {
			return 0, false
		}
	}
	k := sort.Search(len(col), func(i int) bool { return col[i].p <= surfaceHpa })
	switch k {
	case 0:
		// Above the first level's pressure: the first pair carries down.
		k = 1
	case len(col):
		// Past the last: the last pair carries up.
		k = len(col) - 1
	}
	lo, hi := col[k-1], col[k]
	x := func(p float64) float64 { return math.Pow(p, isaExponent) }
	f := (x(lo.p) - x(surfaceHpa)) / (x(lo.p) - x(hi.p))
	return lo.z + f*(hi.z-lo.z), true
}

// GroundFromColumn derives the static segment's ground from the block's
// first step holding both the surface pressure and the isobaric heights
// (Model.GroundFromColumn), quantised as the orography is stored, Missing
// where the step has no value.
func (c *Cube) GroundFromColumn() ([]int16, error) {
	psSeg, psVar, ok := c.Layout.Find(VarPS)
	if !ok {
		return nil, fmt.Errorf("nwp: %s has no surface pressure to find its ground with", c.Model.ID)
	}
	hour := -1
	for _, h := range c.Steps[SegZ] {
		if _, in := c.stepIndex(psSeg, h); in {
			hour = h
			break
		}
	}
	if hour < 0 {
		return nil, fmt.Errorf("nwp: %s %s holds no step with both the surface pressure and the heights", c.Model.ID, c.Block.Name())
	}
	psStep, _ := c.stepIndex(psSeg, hour)
	zStep, _ := c.stepIndex(SegZ, hour)
	levels := c.Model.Levels
	zVars := make([]int, len(levels))
	for i, lv := range levels {
		s, vi, ok := c.Layout.Find(Var{Name: VarZ, Level: lv}.Key())
		if !ok || s != SegZ {
			return nil, fmt.Errorf("nwp: no height at %d hPa in the layout", lv)
		}
		zVars[i] = vi
	}
	_, elevVar, ok := c.Layout.Find(VarElevation)
	if !ok {
		return nil, fmt.Errorf("nwp: no elevation in the layout")
	}
	elev := c.Layout[SegStatic][elevVar]
	g := c.Model.Grid
	n := g.Ni * g.Nj
	out := make([]int16, n)
	heights := make([]float64, len(levels))
	for k := 0; k < n; k++ {
		out[k] = Missing
		ps, ok := c.Value(psSeg, psVar, psStep, k)
		if !ok {
			continue
		}
		for i, vi := range zVars {
			heights[i], _ = c.Value(SegZ, vi, zStep, k)
		}
		z, ok := GroundInColumn(ps, levels, heights)
		if !ok {
			continue
		}
		q, err := elev.Quantize(z)
		if err != nil {
			return nil, fmt.Errorf("%w: the ground at point %d", err, k)
		}
		out[k] = q
	}
	return out, nil
}
