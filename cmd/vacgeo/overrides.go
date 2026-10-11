// overrides.go reads the hand-placed panels.
//
// The graticule reader will always leave a residue: a plate whose labels
// are set in a way nobody anticipated, a panel whose ticks were dropped
// from the artwork. Improving the reader is the right answer for a class of
// plates; for a single stubborn one it is not, and a pilot who flies from
// that aerodrome should not have to wait for it.
//
// So one plate can be placed by hand, in a committed file, as two control
// points: a page position and the coordinates that point really has. Nothing
// else about the pipeline changes, and in particular an override is gated
// against the ARP exactly like a fit, because a typed control point is at
// least as easy to get wrong as a misread label.

package main

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
)

// overrideKey addresses one panel of one plate.
type overrideKey struct {
	ident   string
	section int
	page    int
}

type overrides map[overrideKey]*panelFit

// lookup returns a hand-placed panel, if there is one.
func (o overrides) lookup(ident string, section, page int) (*panelFit, bool) {
	f, ok := o[overrideKey{ident: strings.ToUpper(ident), section: section, page: page}]
	return f, ok
}

// loadOverrides reads the tab-separated override table. Blank lines and
// lines opening with # are ignored, so every entry can carry the reason it
// exists. One line is one panel:
//
//	ident  section  page  x0 y0 x1 y1  latSW lonSW  latNE lonNE
//
// The four clip values are PDF points with the origin at the bottom left,
// which is what a `pdftoppm -x -y -W -H` crop and this command's own
// -dump output both speak. The two corner positions are decimal degrees.
func loadOverrides(path string) (overrides, error) {
	out := overrides{}
	f, err := os.Open(path)
	if os.IsNotExist(err) {
		return out, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	for line := 1; sc.Scan(); line++ {
		t := strings.TrimSpace(sc.Text())
		if t == "" || strings.HasPrefix(t, "#") {
			continue
		}
		fields := strings.Fields(t)
		if len(fields) != 11 {
			return nil, fmt.Errorf("%s:%d: want 11 fields, got %d", path, line, len(fields))
		}
		nums := make([]float64, 10)
		for i := 1; i < 11; i++ {
			v, err := strconv.ParseFloat(fields[i], 64)
			if err != nil {
				return nil, fmt.Errorf("%s:%d: field %d: %w", path, line, i+1, err)
			}
			nums[i-1] = v
		}
		key := overrideKey{ident: strings.ToUpper(fields[0]), section: int(nums[0]), page: int(nums[1])}
		x0, y0, x1, y1 := nums[2], nums[3], nums[4], nums[5]
		latSW, lonSW, latNE, lonNE := nums[6], nums[7], nums[8], nums[9]
		if x1 <= x0 || y1 <= y0 {
			return nil, fmt.Errorf("%s:%d: empty clip rectangle", path, line)
		}
		out[key] = &panelFit{
			Clip:    box{x0: x0, y0: y0, x1: x1, y1: y1},
			Geo:     northUp(y0, latSW, (latNE-latSW)/(y1-y0), x0, lonSW, (lonNE-lonSW)/(x1-x0)),
			PtPerNM: (y1 - y0) / ((latNE - latSW) * 60),
			Method:  "override",
		}
	}
	return out, sc.Err()
}
