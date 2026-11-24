package nwp

import (
	"errors"
	"fmt"
	"math"
	"os"

	"github.com/0intro/loxodrome/internal/pmtiles"
)

// Archive reads one block archive: the reference the Worker's reader and
// the differential harness are held to.
type Archive struct {
	D  Descriptor
	f  *os.File
	rd *pmtiles.Reader
}

// OpenArchive opens a block archive file.
func OpenArchive(path string) (*Archive, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	rd, err := pmtiles.Open(f, st.Size())
	if err != nil {
		f.Close()
		return nil, err
	}
	a := &Archive{f: f, rd: rd}
	if err := rd.Metadata(&a.D); err != nil {
		f.Close()
		return nil, err
	}
	if a.D.Format != Format || a.D.Version != FormatVersion {
		f.Close()
		return nil, fmt.Errorf("nwp: %s is %s v%d", path, a.D.Format, a.D.Version)
	}
	return a, nil
}

// Close releases the file.
func (a *Archive) Close() error { return a.f.Close() }

func floorDiv(a, b int64) int64 {
	q := a / b
	if (a%b != 0) && ((a < 0) != (b < 0)) {
		q--
	}
	return q
}

// Nearest is the native grid point nearest (lat, lon), rounding half up
// in microdegrees (the Worker's rule, so both pick the same point).
func (g GridDesc) Nearest(lat, lon float64) (i, j int, ok bool) {
	latE6 := int64(math.Round(lat * 1e6))
	lonE6 := int64(math.Round(lon * 1e6))
	y := g.North - latE6
	jj := floorDiv(y+g.Dj/2, g.Dj)
	x := lonE6 - g.West
	if g.Wraps {
		x = ((x % 360_000_000) + 360_000_000) % 360_000_000
	} else if x < -g.Di/2 {
		x += 360_000_000 // a longitude given past the antimeridian
	}
	ii := floorDiv(x+g.Di/2, g.Di)
	if g.Wraps {
		ii %= int64(g.Ni)
	}
	if ii < 0 || jj < 0 || ii >= int64(g.Ni) || jj >= int64(g.Nj) {
		return 0, 0, false
	}
	return int(ii), int(jj), true
}

// segmentIndex finds a variable's segment and index.
func (d Descriptor) segmentIndex(key string) (int, int, error) {
	for s, seg := range d.Segments {
		for vi, v := range seg.Vars {
			if v.Key() == key {
				return s, vi, nil
			}
		}
	}
	return 0, 0, fmt.Errorf("nwp: no variable %s", key)
}

// Series reads a variable at a native point: its values by the segment's
// steps (NaN where missing) and the steps, or ok=false where the archive
// holds no tile for the point (outside the model's domain).
func (a *Archive) Series(i, j int, key string) (vals []float64, steps []int, ok bool, err error) {
	s, vi, err := a.D.segmentIndex(key)
	if err != nil {
		return nil, nil, false, err
	}
	l := a.D.Levels[0]
	p := a.D.Tile
	payload, err := a.rd.Get(uint8(l.Z), uint32(i/p), uint32(j/p))
	if err != nil {
		return nil, nil, false, err
	}
	if payload == nil {
		return nil, nil, false, nil
	}
	data, err := DecodeSegment(payload, Segment(s))
	if err != nil {
		return nil, nil, false, err
	}
	seg := a.D.Segments[s]
	ns := len(seg.Steps)
	if Segment(s) == SegStatic {
		ns = 1
	}
	if len(data) != len(seg.Vars)*ns*p*p {
		return nil, nil, false, errors.New("nwp: segment size disagrees with the descriptor")
	}
	pt := (j%p)*p + (i % p)
	v := seg.Vars[vi]
	vals = make([]float64, ns)
	for si := 0; si < ns; si++ {
		q := data[(vi*ns+si)*p*p+pt]
		if q == Missing {
			vals[si] = math.NaN()
		} else {
			vals[si] = v.Value(q)
		}
	}
	return vals, seg.Steps, true, nil
}
