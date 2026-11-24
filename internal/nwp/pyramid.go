package nwp

import (
	"fmt"
	"math/bits"
)

// TileSize is a tile's side in points.
const TileSize = 16

// Level is one level of an archive's pyramid: the native points
// (I0 + Factor*a, J0 + Factor*b). The coarse levels keep the native points
// that fall EXACTLY on a lattice step the map asks for (1/8, 1/4, 1/2, 1,
// 2 degrees), so a barb drawn from a coarse level is the very value a route
// column at that point reads; a power-of-two subsampling of the native grid
// would put them off the lattice.
type Level struct {
	Z      int `json:"z"`
	Factor int `json:"factor"`
	I0     int `json:"i0"`
	J0     int `json:"j0"`
	Ni     int `json:"ni"` // points
	Nj     int `json:"nj"`
	Tx     int `json:"tx"` // tiles
	Ty     int `json:"ty"`
}

func posMod(a, m int64) int64 { return ((a % m) + m) % m }

// Pyramid lays out a model's levels, native first. Each level's z is the
// smallest that addresses its tiles and lies below the finer level's, so
// PMTiles' (z, x, y) names every tile of every level once.
func Pyramid(m *Model) ([]Level, error) {
	g := m.Grid
	var out []Level
	add := func(f, i0, j0 int) error {
		ni := (g.Ni-1-i0)/f + 1
		nj := (g.Nj-1-j0)/f + 1
		if g.Wraps && f > 1 {
			if g.Ni%f != 0 {
				return fmt.Errorf("nwp: %s factor %d does not divide its %d columns", m.ID, f, g.Ni)
			}
			ni = g.Ni / f
		}
		tx := (ni + TileSize - 1) / TileSize
		ty := (nj + TileSize - 1) / TileSize
		z := bits.Len(uint(max(tx, ty) - 1))
		if len(out) > 0 {
			z = min(z, out[len(out)-1].Z-1)
		}
		if z < 0 || 1<<z < max(tx, ty) {
			return fmt.Errorf("nwp: %s factor %d needs a zoom the finer levels took", m.ID, f)
		}
		out = append(out, Level{Z: z, Factor: f, I0: i0, J0: j0, Ni: ni, Nj: nj, Tx: tx, Ty: ty})
		return nil
	}
	if err := add(1, 0, 0); err != nil {
		return nil, err
	}
	for _, f := range m.Pyramid {
		step := int64(f) * g.Di
		if int64(f)*g.Dj != step {
			return nil, fmt.Errorf("nwp: %s factor %d is not square", m.ID, f)
		}
		i0, j0 := -1, -1
		for i := 0; i < f; i++ {
			if posMod(g.West+int64(i)*g.Di, step) == 0 {
				i0 = i
				break
			}
		}
		for j := 0; j < f; j++ {
			if posMod(g.North-int64(j)*g.Dj, step) == 0 {
				j0 = j
				break
			}
		}
		if i0 < 0 || j0 < 0 {
			return nil, fmt.Errorf("nwp: %s factor %d puts no native point on the lattice", m.ID, f)
		}
		if err := add(f, i0, j0); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// Native maps a level's point (a, b) to the native grid.
func (l Level) Native(a, b int, g Grid) (i, j int, ok bool) {
	i = l.I0 + l.Factor*a
	j = l.J0 + l.Factor*b
	if a < 0 || b < 0 || a >= l.Ni || b >= l.Nj {
		return 0, 0, false
	}
	if i >= g.Ni {
		if !g.Wraps {
			return 0, 0, false
		}
		i -= g.Ni
	}
	return i, j, j < g.Nj
}
