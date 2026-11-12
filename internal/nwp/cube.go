package nwp

import (
	"fmt"
	"math"
	"sort"
	"sync"
	"time"
)

// Cube is one time block decoded whole: every stored variable at every
// step, quantised, on the native grid.
type Cube struct {
	Model  *Model
	Run    time.Time
	Block  Block
	Layout Layout
	// Steps are the hours each segment holds (the static segment none).
	Steps [NumSegments][]int
	// GustPeriod is the gust's statistical period in hours, by sfc step
	// (0 where the step carries no gust).
	GustPeriod []int

	mu   sync.Mutex
	data [NumSegments][][]int16 // [seg][var*len(steps)+step] grid, nil = all missing
	// covered is the points every wanted field holds, at every step: the
	// domain, read off the bitmaps (AROME's corners are masked, a little
	// differently at its first step). Nil while every point is.
	covered []uint64
	seen    map[string]bool
}

// NewCube prepares a block's cube with its segments' step sets.
func NewCube(m *Model, run time.Time, b Block) *Cube {
	c := &Cube{Model: m, Run: run, Block: b, Layout: LayoutFor(m), seen: map[string]bool{}}
	levels := m.Steps(b, FamilyLevels)
	c.Steps[SegSfc] = m.Steps(b, FamilyHourlySurface)
	c.Steps[SegPS] = m.Steps(b, FamilySurface)
	c.Steps[SegUVT] = levels
	c.Steps[SegZ] = levels
	c.Steps[SegCloud] = levels
	for s := Segment(0); s < NumSegments; s++ {
		n := len(c.Layout[s]) * max(1, len(c.Steps[s]))
		if s == SegStatic {
			n = len(c.Layout[s])
		}
		c.data[s] = make([][]int16, n)
	}
	c.GustPeriod = make([]int, len(c.Steps[SegSfc]))
	return c
}

func (c *Cube) stepIndex(s Segment, hour int) (int, bool) {
	if s == SegStatic {
		return 0, true
	}
	steps := c.Steps[s]
	k := sort.SearchInts(steps, hour)
	return k, k < len(steps) && steps[k] == hour
}

func (c *Cube) slot(s Segment, vi, si int) int {
	if s == SegStatic {
		return vi
	}
	return vi*len(c.Steps[s]) + si
}

// Set stores one decoded field (canonical layout, NaN without a value)
// converted by conv, as variable key at the given hour. A field arriving
// twice, at a step its segment does not hold, or out of the int16 range
// is refused.
func (c *Cube) Set(key string, hour int, values []float32, conv func(float64) float64) error {
	s, vi, ok := c.Layout.Find(key)
	if !ok {
		return fmt.Errorf("nwp: no variable %s in the layout", key)
	}
	si, ok := c.stepIndex(s, hour)
	if !ok {
		return fmt.Errorf("nwp: %s at +%dh is not a step of segment %s", key, hour, s)
	}
	n := c.Model.Grid.Ni * c.Model.Grid.Nj
	if len(values) != n {
		return fmt.Errorf("nwp: %s has %d points, the grid %d", key, len(values), n)
	}
	v := c.Layout[s][vi]
	out := make([]int16, n)
	valid := make([]uint64, (n+63)/64)
	for k, x := range values {
		if x != x {
			out[k] = Missing
			continue
		}
		y := float64(x)
		if conv != nil {
			y = conv(y)
		}
		q, err := v.Quantize(y)
		if err != nil {
			return fmt.Errorf("%w at point %d, +%dh", err, k, hour)
		}
		out[k] = q
		valid[k>>6] |= 1 << (k & 63)
	}
	id := fmt.Sprintf("%s+%d", key, hour)
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.seen[id] {
		return fmt.Errorf("nwp: %s at +%dh arrived twice", key, hour)
	}
	c.seen[id] = true
	c.data[s][c.slot(s, vi, si)] = out
	if c.covered == nil {
		c.covered = valid
	} else {
		for w := range c.covered {
			c.covered[w] &= valid[w]
		}
	}
	return nil
}

// SetQuantized stores a field already quantised (the orography cached
// from an earlier block), Missing where it has no value.
func (c *Cube) SetQuantized(key string, hour int, q []int16) error {
	s, vi, ok := c.Layout.Find(key)
	if !ok {
		return fmt.Errorf("nwp: no variable %s in the layout", key)
	}
	si, ok := c.stepIndex(s, hour)
	if !ok {
		return fmt.Errorf("nwp: %s at +%dh is not a step of segment %s", key, hour, s)
	}
	n := c.Model.Grid.Ni * c.Model.Grid.Nj
	if len(q) != n {
		return fmt.Errorf("nwp: %s has %d points, the grid %d", key, len(q), n)
	}
	valid := make([]uint64, (n+63)/64)
	for k, x := range q {
		if x != Missing {
			valid[k>>6] |= 1 << (k & 63)
		}
	}
	id := fmt.Sprintf("%s+%d", key, hour)
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.seen[id] {
		return fmt.Errorf("nwp: %s at +%dh arrived twice", key, hour)
	}
	c.seen[id] = true
	c.data[s][c.slot(s, vi, si)] = append([]int16(nil), q...)
	if c.covered == nil {
		c.covered = valid
	} else {
		for w := range c.covered {
			c.covered[w] &= valid[w]
		}
	}
	return nil
}

// SetGustPeriod records a gust step's statistical period.
func (c *Cube) SetGustPeriod(hour int, period time.Duration) {
	if si, ok := c.stepIndex(SegSfc, hour); ok {
		c.mu.Lock()
		c.GustPeriod[si] = int(period / time.Hour)
		c.mu.Unlock()
	}
}

// Has reports whether a variable arrived at an hour.
func (c *Cube) Has(key string, hour int) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.seen[fmt.Sprintf("%s+%d", key, hour)]
}

// Covered reports whether point k is inside the block's domain.
func (c *Cube) Covered(k int) bool {
	return c.covered == nil || c.covered[k>>6]&(1<<(k&63)) != 0
}

// CoveredCount is the number of points inside the domain.
func (c *Cube) CoveredCount() int {
	n := c.Model.Grid.Ni * c.Model.Grid.Nj
	if c.covered == nil {
		return n
	}
	count := 0
	for k := 0; k < n; k++ {
		if c.Covered(k) {
			count++
		}
	}
	return count
}

// At returns a stored value (Missing when absent).
func (c *Cube) At(s Segment, vi, si, k int) int16 {
	g := c.data[s][c.slot(s, vi, si)]
	if g == nil || !c.Covered(k) {
		return Missing
	}
	return g[k]
}

// Grid returns a variable's whole field at one step (nil when absent).
func (c *Cube) Grid(s Segment, vi, si int) []int16 { return c.data[s][c.slot(s, vi, si)] }

// Value returns a stored value in physical units.
func (c *Cube) Value(s Segment, vi, si, k int) (float64, bool) {
	q := c.At(s, vi, si, k)
	if q == Missing {
		return math.NaN(), false
	}
	return c.Layout[s][vi].Value(q), true
}
