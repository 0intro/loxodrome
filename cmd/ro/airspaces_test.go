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

// roStatedRe is a designator a section's layout text opens a line with.
var roStatedRe = regexp.MustCompile(`(?m)^\s*(LR(?:TSA|TRA|[PRD])\s?\d+[A-Z0-9]*)\b`)

// The ENR sections read against poppler's own layout of them, over an
// edition a -keep run saved:
//
//	RO_ENR=$PWD/local/ro-enr/2026-09-03 go test ./cmd/ro -run Census -v
//
// Every designator ENR 5.1 and 5.2 state is read exactly once, ENR 2.1's
// names are each a zone's own (no whole, no heading, no list of parts left
// in one), and no arc goes unread. A count agreeing is not a reading
// agreeing, so the designators are compared, not the totals.
func TestRoAirspacesCensus(t *testing.T) {
	dir := os.Getenv("RO_ENR")
	if dir == "" {
		t.Skip("RO_ENR names no saved edition")
	}
	border, err := eaip.LoadBorderRing(filepath.Join("..", "..", "public", "data", "pruatlas-firs.json"), "LRBB")
	if err != nil || border == nil {
		t.Fatalf("LRBB ring: %v", err)
	}
	spec := eaip.ZoneSpec{Type: eaip.SectionType, IDPrefix: "RO", IcaoPrefix: "LR", Border: border}
	for _, s := range roAirspaceSections {
		data, err := os.ReadFile(filepath.Join(dir, s.file))
		if err != nil {
			t.Fatal(err)
		}
		st := eaip.NewZoneStats()
		zones, err := readRoSection(data, s.name, spec, st)
		if err != nil {
			t.Fatalf("%s: %v", s.name, err)
		}
		if st.Boundary.ArcsUnread != 0 {
			t.Errorf("%s: %d arcs unread: %v", s.name, st.Boundary.ArcsUnread, st.UnreadArcs)
		}
		if s.name == "ENR 2.1" {
			seen := map[string]bool{}
			for _, z := range zones {
				if strings.ContainsAny(z.Name, "()") || strings.Contains(strings.ToLower(z.Name), "consists") ||
					strings.Contains(z.Name, "SECTOR") {
					t.Errorf("%s: %q still carries its whole or a heading", s.name, z.Name)
				}
				if seen[z.Name] {
					t.Errorf("%s: %q read twice", s.name, z.Name)
				}
				seen[z.Name] = true
			}
			continue
		}
		layout, err := pdftext.Run(data, "-layout", "-", "-")
		if err != nil {
			t.Fatal(err)
		}
		stated := map[string]int{}
		for _, m := range roStatedRe.FindAllStringSubmatch(string(layout), -1) {
			stated[strings.ReplaceAll(m[1], " ", "")]++
		}
		read := map[string]int{}
		for _, z := range zones {
			read[z.ID]++
		}
		var missing, extra, twice []string
		for id := range stated {
			if read[id] == 0 {
				missing = append(missing, id)
			}
		}
		for id, n := range read {
			if stated[id] == 0 {
				extra = append(extra, id)
			}
			if n > 1 {
				twice = append(twice, id)
			}
		}
		sort.Strings(missing)
		sort.Strings(extra)
		sort.Strings(twice)
		if len(missing)+len(extra)+len(twice) > 0 {
			t.Errorf("%s: %d stated, %d read; unread %v, not stated %v, read twice %v",
				s.name, len(stated), len(zones), missing, extra, twice)
		}
		t.Logf("%s: %d designators stated, %d zones read", s.name, len(stated), len(zones))
	}
}
