// navaids.go writes ro-navaids.json from AIP Romania's ENR 4.1 (the radio
// navigation aids) and ENR 4.4 (the significant points), their PDF tables
// rebuilt as airspaces.go rebuilds its sections and read by the eAIP
// readers (eaip.ParseNavaidTables, eaip.ParsePointTables).
//
// ENR 4.1 draws no column separator and rules no row: each horizontal rule
// comes in one piece per column, and a blank line stands between two
// navaids. internal/pdftable takes the columns from the joints and the rows
// from the blank lines. It prints a DME's own UHF frequency beside its
// channel ("1077.000MHz (53X)"), which is no VHF value to tune: a DME keeps
// its channel alone.

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/aixm5"
	"github.com/0intro/loxodrome/internal/aixm5build"
	"github.com/0intro/loxodrome/internal/eaip"
)

// roNavaidSections are ENR 4.1 and ENR 4.4, each with its floor. The
// 2026-09-03 edition reads 44 navaids and 411 points.
var (
	roNavaidSection = roSection{"ENR 4.1", "ENR4", "LR_ENR_4_1_en.pdf", 20}
	roPointSection  = roSection{"ENR 4.4", "ENR4", "LR_ENR_4_4_en.pdf", 200}
)

const (
	defaultMinRoNavaids = 250
	defaultMaxRoNavaids = 2000
)

type roNavaidsMeta struct {
	GeneratedAt   string         `json:"generatedAt"`
	Source        string         `json:"source"`
	SourceSha256  string         `json:"sourceSha256"`
	Effective     string         `json:"effective"`
	Edition       string         `json:"edition"`
	NavaidCount   int            `json:"navaidCount"`
	SectionCounts map[string]int `json:"sectionCounts"`
	Counts        map[string]int `json:"counts"`
	Tables        int            `json:"tables"`
	SkippedKinds  map[string]int `json:"skippedKinds,omitempty"`
	// SkippedNoPosition counts the rows whose coordinate cell did not
	// parse: the counter that says the layout changed under the reader.
	// RepeatedRows and SeparatedRows are the shared builder's: a navaid
	// filed twice kept once, and two under one id each kept under its own
	// (aixm5build.BuildNavaids).
	RepeatedRows      int        `json:"repeatedRows,omitempty"`
	SeparatedRows     int        `json:"separatedRows,omitempty"`
	SkippedNoPosition int        `json:"skippedNoPosition"`
	BBox              aip.BBox   `json:"bbox,omitempty"`
	BBoxes            []aip.BBox `json:"bboxes,omitempty"`
}

// buildRoNavaids reads an edition's ENR 4.1 and 4.4 and writes
// ro-navaids.json.
func buildRoNavaids(outDir, target string, enr *roENR, win aip.SanityWindows, now func() time.Time) error {
	st := eaip.NewNavaidStats()
	h := sha256.New()
	counts := map[string]int{}
	var navaids []aixm5.Navaid
	for _, s := range []roSection{roNavaidSection, roPointSection} {
		data, err := enr.read(s)
		if err != nil {
			return err
		}
		h.Write(data)
		doc, err := rebuildRoSection(data, s.name)
		if err != nil {
			return fmt.Errorf("%s: %w", s.name, err)
		}
		var got []aixm5.Navaid
		if s == roNavaidSection {
			got = eaip.ParseNavaidTables(doc, "RO", st)
		} else {
			got = eaip.ParsePointTables(doc, st)
		}
		if len(got) < s.min {
			return fmt.Errorf("%s: %d rows, fewer than %d; the layout may have changed", s.name, len(got), s.min)
		}
		counts[s.name] = len(got)
		navaids = append(navaids, got...)
	}
	effective := enr.edition + "T00:00:00.000Z"
	source := "ROMATSA AIP Romania " + enr.edition + " ENR 4.1, ENR 4.4"
	msg := aixm5.Message{Navaids: navaids}
	artifact, shared, err := aixm5build.BuildNavaids(&msg, source, nil, effective,
		aixm5build.NavaidsOptions{
			IDPrefix:   "RO",
			Country:    "RO",
			Now:        now,
			MinNavaids: orDefault(win.MinNavaids, defaultMinRoNavaids),
			MaxNavaids: orDefault(win.MaxNavaids, defaultMaxRoNavaids),
		})
	if err != nil {
		return err
	}
	meta := roNavaidsMeta{
		GeneratedAt:       shared.GeneratedAt,
		Source:            source,
		SourceSha256:      hex.EncodeToString(h.Sum(nil)),
		Effective:         effective,
		Edition:           enr.edition,
		NavaidCount:       shared.NavaidCount,
		SectionCounts:     counts,
		Counts:            shared.Counts,
		Tables:            st.Tables,
		SkippedNoPosition: st.SkippedNoPosition,
		RepeatedRows:      shared.RepeatedRows,
		SeparatedRows:     shared.SeparatedRows,
		BBox:              shared.BBox,
		BBoxes:            shared.BBoxes,
	}
	if len(st.SkippedKinds) > 0 {
		meta.SkippedKinds = st.SkippedKinds
	}
	slot, err := aip.WriteDataset(outDir, "ro-navaids", target, effective, artifact, meta)
	if err != nil {
		return err
	}
	fmt.Printf("ro: wrote %d navaids (%d from ENR 4.1, %d from ENR 4.4); effective %s; slot=%s\n",
		meta.NavaidCount, counts["ENR 4.1"], counts["ENR 4.4"], enr.edition, slot)
	return nil
}
