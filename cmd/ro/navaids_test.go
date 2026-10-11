package main

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/0intro/loxodrome/internal/eaip"
	"github.com/0intro/loxodrome/internal/pdftext"
)

// roStationRe is an ENR 4.1 row's first line in poppler's layout: the
// station's name, then its three-letter ident, then its frequency.
var roStationRe = regexp.MustCompile(`(?m)^\s*(\p{Lu}.*?)\s{2,}([A-Z]{3})\s{2,}\d`)

// roPointRe is an ENR 4.4 row's first line: the five-letter name-code
// and its coordinates.
var roPointRe = regexp.MustCompile(`(?m)^\s*([A-Z]{5})\s+\d{6}[NS]`)

// ENR 4.1 and 4.4 read against poppler's own layout of them, over an
// edition a -keep run saved:
//
//	RO_ENR=$PWD/local/ro-enr/2026-09-03 go test ./cmd/ro -run NavaidsCensus -v
//
// Every station ident and every point name the text states is read, each
// station once, each point once, no id twice.
func TestRoNavaidsCensus(t *testing.T) {
	dir := os.Getenv("RO_ENR")
	if dir == "" {
		t.Skip("RO_ENR names no saved edition")
	}
	for _, s := range []roSection{roNavaidSection, roPointSection} {
		data, err := os.ReadFile(filepath.Join(dir, s.file))
		if err != nil {
			t.Fatal(err)
		}
		doc, err := rebuildRoSection(data, s.name)
		if err != nil {
			t.Fatal(err)
		}
		layout, err := pdftext.Run(data, "-layout", "-", "-")
		if err != nil {
			t.Fatal(err)
		}
		st := eaip.NewNavaidStats()
		stated := map[string]int{}
		read := map[string]int{}
		ids := map[string]int{}
		if s == roNavaidSection {
			for _, m := range roStationRe.FindAllStringSubmatch(string(layout), -1) {
				stated[m[2]+" "+strings.Fields(m[1])[0]]++
			}
			for _, n := range eaip.ParseNavaidTables(doc, "RO", st) {
				read[n.Designator+" "+strings.Fields(n.Name)[0]]++
				ids[n.ID]++
			}
		} else {
			for _, m := range roPointRe.FindAllStringSubmatch(string(layout), -1) {
				stated[m[1]]++
			}
			for _, n := range eaip.ParsePointTables(doc, st) {
				read[n.Designator]++
				ids[n.ID]++
			}
		}
		var missing, extra, twice []string
		for k := range stated {
			if read[k] == 0 {
				missing = append(missing, k)
			}
		}
		for k, n := range read {
			if stated[k] == 0 {
				extra = append(extra, k)
			}
			if n > stated[k] && stated[k] > 0 {
				twice = append(twice, k)
			}
		}
		for id, n := range ids {
			if n > 1 {
				twice = append(twice, "id "+id)
			}
		}
		sort.Strings(missing)
		sort.Strings(extra)
		sort.Strings(twice)
		if len(missing)+len(extra)+len(twice) > 0 {
			t.Errorf("%s: %d stated, %d read; unread %v, not stated %v, read twice %v",
				s.name, len(stated), len(read), missing, extra, twice)
		}
		t.Logf("%s: %d stated, %d read", s.name, len(stated), len(read))
	}
}
