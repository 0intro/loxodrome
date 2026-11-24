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
//
// A row holds for the drawing it was measured on and for no other. It
// names that drawing by the page's sum (pageContent.sum), and a page the
// SIA has since redrawn, renumbered or dropped refuses it: the clip and the
// corners were read off a picture the page no longer holds.

package main

import (
	"bufio"
	"encoding/hex"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
)

// overrideKey addresses one panel of one plate.
type overrideKey struct {
	ident   string
	section int
	page    int
}

// override is one hand-placed panel, the drawing it was measured on and
// where the table states it, as path:line.
type override struct {
	fit *panelFit
	sum string
	at  string
}

type overrides map[overrideKey]override

// lookup returns a hand-placed panel, if there is one.
func (o overrides) lookup(ident string, section, page int) (override, bool) {
	r, ok := o[overrideKey{ident: strings.ToUpper(ident), section: section, page: page}]
	return r, ok
}

// unread returns, sorted, the rows of the idents the filter keeps that no
// page of this run reached: a page the plate no longer has, or a plate gone
// from the atlas.
func (o overrides) unread(seen map[overrideKey]bool, filter func(string) bool) []overrideKey {
	var out []overrideKey
	for k := range o {
		if filter(k.ident) && !seen[k] {
			out = append(out, k)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.ident != b.ident {
			return a.ident < b.ident
		}
		if a.section != b.section {
			return a.section < b.section
		}
		return a.page < b.page
	})
	return out
}

// loadOverrides reads the tab-separated override table. Blank lines and
// lines opening with # are ignored, so every entry can carry the reason it
// exists. One line is one panel:
//
//	ident  section  page  drawing  x0 y0 x1 y1  latSW lonSW  latNE lonNE
//
// The drawing is the page's sum, as -dump and -report print it. The four
// clip values are PDF points with the origin at the bottom left, which is
// what a `pdftoppm -x -y -W -H` crop and this command's own -dump output
// both speak. The two corner positions are decimal degrees.
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
		if len(fields) != 12 {
			return nil, fmt.Errorf("%s:%d: want 12 fields, got %d", path, line, len(fields))
		}
		sum := fields[3]
		if _, err := hex.DecodeString(sum); err != nil || len(sum) != sumDigits || sum != strings.ToLower(sum) {
			return nil, fmt.Errorf("%s:%d: drawing %q: want %d lowercase hex digits", path, line, sum, sumDigits)
		}
		nums := make([]float64, 0, 10)
		for i, f := range fields {
			if i == 0 || i == 3 {
				continue
			}
			v, err := strconv.ParseFloat(f, 64)
			if err != nil {
				return nil, fmt.Errorf("%s:%d: field %d: %w", path, line, i+1, err)
			}
			nums = append(nums, v)
		}
		key := overrideKey{ident: strings.ToUpper(fields[0]), section: int(nums[0]), page: int(nums[1])}
		x0, y0, x1, y1 := nums[2], nums[3], nums[4], nums[5]
		latSW, lonSW, latNE, lonNE := nums[6], nums[7], nums[8], nums[9]
		if x1 <= x0 || y1 <= y0 {
			return nil, fmt.Errorf("%s:%d: empty clip rectangle", path, line)
		}
		out[key] = override{
			fit: &panelFit{
				Clip:    box{x0: x0, y0: y0, x1: x1, y1: y1},
				Geo:     northUp(y0, latSW, (latNE-latSW)/(y1-y0), x0, lonSW, (lonNE-lonSW)/(x1-x0)),
				PtPerNM: (y1 - y0) / ((latNE - latSW) * 60),
				Method:  "override",
			},
			sum: sum,
			at:  fmt.Sprintf("%s:%d", path, line),
		}
	}
	return out, sc.Err()
}
