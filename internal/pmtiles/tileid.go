// Package pmtiles writes and reads PMTiles version 3 archives: one file
// holding a whole tile pyramid behind a directory a client can range-read
// (https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md).
//
// It exists for cmd/planign, whose archive the app downloads whole and
// reads with the JavaScript pmtiles library (src/lib/offline/filePmtiles.ts),
// so the reader that matters is that one: tests/planignPack.spec.ts reads a
// fixture this package wrote. The writer is deliberately small and strict:
// tiles arrive in TileID order, identical tiles are stored once, and the
// same input gives the same bytes for a given Go toolchain (gzip's output
// has changed between Go releases, which is why cmd/planign decides an
// upload on the tiles' pixels and never on these bytes). The reader and
// Verify exist to check what the writer made, a stricter second opinion
// than go-pmtiles' own verify.
package pmtiles

import "math/bits"

// rotate is one step of the Hilbert curve's quadrant rotation.
func rotate(n, x, y, rx, ry uint32) (uint32, uint32) {
	if ry == 0 {
		if rx != 0 {
			x = n - 1 - x
			y = n - 1 - y
		}
		return y, x
	}
	return x, y
}

// ZxyToID is the TileID of tile z/x/y: the tiles of every lower zoom
// counted first, then the tile's position on that zoom's Hilbert curve.
func ZxyToID(z uint8, x, y uint32) uint64 {
	acc := (uint64(1)<<(2*uint(z)) - 1) / 3
	if z == 0 {
		return acc
	}
	n := uint32(z - 1)
	for s := uint32(1) << n; s > 0; s >>= 1 {
		rx := s & x
		ry := s & y
		acc += uint64((3*rx)^ry) << n
		x, y = rotate(s, x, y, rx, ry)
		n--
	}
	return acc
}

// IDToZxy is ZxyToID's inverse.
func IDToZxy(id uint64) (uint8, uint32, uint32) {
	z := uint8(bits.Len64(3*id+1)-1) / 2
	acc := (uint64(1)<<(2*uint(z)) - 1) / 3
	t := id - acc
	var tx, ty uint32
	for a := uint8(0); a < z; a++ {
		s := uint32(1) << a
		rx := 1 & (uint32(t) >> 1)
		ry := 1 & (uint32(t) ^ rx)
		tx, ty = rotate(s, tx, ty, rx, ry)
		tx += rx << a
		ty += ry << a
		t >>= 2
	}
	return z, tx, ty
}
