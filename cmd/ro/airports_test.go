package main

import (
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/0intro/loxodrome/internal/eaip"
	"github.com/0intro/loxodrome/internal/pdftext"
)

// roSectionText is one section of a field's page in poppler's layout,
// from its heading to the next ("LRAR AD 2.12 RUNWAY PHYSICAL
// CHARACTERISTICS").
func roSectionText(layout, icao string, part, n int) string {
	head := regexp.MustCompile(`(?m)^\s*` + icao + `\s+AD\s*` + strconv.Itoa(part) + `\.` + strconv.Itoa(n) + `\s`)
	loc := head.FindStringIndex(layout)
	if loc == nil {
		return ""
	}
	rest := layout[loc[1]:]
	next := regexp.MustCompile(`(?m)^\s*` + icao + `\s+AD\s*[23]\.\d+\s`)
	if m := next.FindStringIndex(rest); m != nil {
		rest = rest[:m[0]]
	}
	return rest
}

var (
	// roRunwayEndRe is an AD 2.12 row's first line: the end's designator,
	// then its true bearing, its degree sign a letter o at Cisnădie.
	roRunwayEndRe = regexp.MustCompile(`(?m)^\s*(\d{2}[LRC]?)\s{2,}\d{2,3}(?:[.,]\d+)?\s*[°o]`)
	// roChannelRe is a VHF channel as AD 2.18 prints it.
	roChannelRe = regexp.MustCompile(`\b(1[1-3]\d\.\d{1,3})\b`)
	// roCoordRe is a packed coordinate pair, a space before a hemisphere
	// letter at Iaşi-Sud and Mureşeni ("470929 N 0273815E").
	roCoordRe = regexp.MustCompile(`(\d{6}(?:\.\d+)?)\s?([NS])\s+(\d{7}(?:\.\d+)?)\s?([EW])`)
	// roElevRe is the elevation item's first figure.
	roElevRe = regexp.MustCompile(`(?i)Elevation[^\n]*?(\d+(?:[.,]\d+)?)\s*FT`)
)

// The aerodrome pages read against poppler's own layout of them, over an
// edition a -keep run saved:
//
//	RO_ENR=$PWD/local/ro-enr/2026-09-03 go test ./cmd/ro -run AerodromesCensus -v
//
// Every field gives an aerodrome, at the reference point and elevation its
// item 2.2 states, with the runway ends its AD 2.12 lists and the VHF
// channels its AD 2.18 (AD 3.17) prints, none missing and none more.
func TestRoAerodromesCensus(t *testing.T) {
	dir := os.Getenv("RO_ENR")
	if dir == "" {
		t.Skip("RO_ENR names no saved edition")
	}
	spec, err := roZoneSpec("../../public/data/pruatlas-firs.json")
	if err != nil {
		t.Fatal(err)
	}
	ents, err := os.ReadDir(filepath.Join(dir, "AD"))
	if err != nil {
		t.Fatal(err)
	}
	fields, runways, channels := 0, 0, 0
	for _, ent := range ents {
		m := roADFileRe.FindStringSubmatch(ent.Name())
		if m == nil {
			continue
		}
		f := roADFile{icao: m[2], part: int(m[1][0] - '0'), name: ent.Name()}
		data, err := os.ReadFile(filepath.Join(dir, "AD", f.name))
		if err != nil {
			t.Fatal(err)
		}
		p := roADPage{f: f}
		if err := readRoAerodrome(data, &p, spec); err != nil {
			t.Errorf("%s: %v", f.icao, err)
			continue
		}
		layout, err := pdftext.Run(data, "-layout", "-", "-")
		if err != nil {
			t.Fatal(err)
		}
		text := string(layout)
		ap := p.airport
		fields++

		geo := roSectionText(text, f.icao, f.part, 2)
		if c := roCoordRe.FindStringSubmatch(geo); c == nil {
			t.Errorf("%s: the layout states no reference point", f.icao)
		} else if lat, lon, ok := eaip.ParsePair(c[1]+c[2], c[3]+c[4]); !ok || math.Abs(lat-ap.Lat) > 1e-4 || math.Abs(lon-ap.Lon) > 1e-4 {
			t.Errorf("%s: reference point read %.5f %.5f, stated %s", f.icao, ap.Lat, ap.Lon, c[0])
		}
		if e := roElevRe.FindStringSubmatch(geo); e != nil {
			ft, _ := strconv.ParseFloat(strings.Replace(e[1], ",", ".", 1), 64)
			if ap.ElevM == nil || math.Abs(*ap.ElevM/0.3048-ft) > 1 {
				t.Errorf("%s: elevation read %v m, stated %s FT", f.icao, ap.ElevM, e[1])
			}
		}

		if f.part == 2 {
			stated := map[string]bool{}
			for _, e := range roRunwayEndRe.FindAllStringSubmatch(roSectionText(text, f.icao, 2, 12), -1) {
				stated[e[1]] = true
			}
			read := map[string]bool{}
			for _, r := range ap.Runways {
				for _, end := range []string{r.Le, r.He} {
					if end != "" {
						read[end] = true
					}
				}
			}
			if d := setDiff(stated, read); d != "" {
				t.Errorf("%s: runway ends %s", f.icao, d)
			}
			runways += len(read)
		}

		com := 18
		if f.part == 3 {
			com = 17
		}
		stated := map[string]bool{}
		for _, c := range roChannelRe.FindAllStringSubmatch(roSectionText(text, f.icao, f.part, com), -1) {
			stated[threeDecimals(c[1])] = true
		}
		read := map[string]bool{}
		for _, r := range ap.Radio {
			read[threeDecimals(r.Freq)] = true
		}
		if d := setDiff(stated, read); d != "" {
			t.Errorf("%s: channels %s", f.icao, d)
		}
		channels += len(read)
	}
	if fields < defaultMinRoFieldsRead {
		t.Errorf("%d fields, fewer than %d", fields, defaultMinRoFieldsRead)
	}
	t.Logf("%d fields, %d runway ends, %d channels", fields, runways, channels)
}

// threeDecimals writes a channel to the kHz: "121.5" is "121.500".
func threeDecimals(s string) string {
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return s
	}
	return strconv.FormatFloat(v, 'f', 3, 64)
}

// setDiff says what one set holds and the other does not, or "".
func setDiff(stated, read map[string]bool) string {
	var missing, extra []string
	for k := range stated {
		if !read[k] {
			missing = append(missing, k)
		}
	}
	for k := range read {
		if !stated[k] {
			extra = append(extra, k)
		}
	}
	if len(missing)+len(extra) == 0 {
		return ""
	}
	sort.Strings(missing)
	sort.Strings(extra)
	return fmt.Sprintf("stated and unread %v, read and not stated %v", missing, extra)
}
