// navaids.go writes the <cc>-navaids.json dataset from ICAO's ENR 4.1
// table. The reading is internal/eaip's; what belongs here is the meta
// the SPA's slot picker and the About card read, and the sanity window
// that stops a changed table committing an empty file.

package main

import (
	"fmt"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/aixm5"
	"github.com/0intro/loxodrome/internal/aixm5build"
	"github.com/0intro/loxodrome/internal/eaip"
)

// navaidsMeta is the <cc>-navaids.meta.json document. It carries the
// parse counters beside the shared fields for the same reason the
// airspace meta does: a State that reworded its ENR 4.1 shows up as a
// number rather than as missing navaids.
type navaidsMeta struct {
	GeneratedAt  string         `json:"generatedAt"`
	Source       string         `json:"source"`
	Effective    string         `json:"effective"`
	NavaidCount  int            `json:"navaidCount"`
	Counts       map[string]int `json:"counts"`
	Tables       int            `json:"tables"`
	SkippedKinds map[string]int `json:"skippedKinds,omitempty"`
	// SkippedNoPosition counts the rows whose coordinate cell did not
	// parse, which is the counter that says a State changed its
	// coordinate format.
	SkippedNoPosition int      `json:"skippedNoPosition"`
	BBox              aip.BBox `json:"bbox,omitempty"`
	// BBoxes splits that envelope into the pieces the rows really
	// occupy, for a publisher whose territory is not connected;
	// absent when the rows form one group.
	BBoxes []aip.BBox `json:"bboxes,omitempty"`
}

// defaultMinNavaids is deliberately low: Slovenia publishes three
// en-route stations for the whole country, and a window that assumed a
// larger State would fail the build every cycle.
const defaultMinNavaids = 2

func writeNavaids(
	s *State, outDir, target, dir, effective string,
	navaids []aixm5.Navaid, st *eaip.NavaidStats, win aip.SanityWindows,
) error {
	msg := aixm5.Message{Navaids: navaids}
	artifact, shared, err := aixm5build.BuildNavaids(&msg, s.Label, nil, effective,
		aixm5build.NavaidsOptions{
			IDPrefix:   strings.ToUpper(s.CC),
			Country:    strings.ToUpper(s.CC),
			Now:        time.Now,
			MinNavaids: orDefault(win.MinNavaids, defaultMinNavaids),
			MaxNavaids: orDefault(win.MaxNavaids, 500),
		})
	if err != nil {
		return err
	}
	meta := navaidsMeta{
		GeneratedAt:       shared.GeneratedAt,
		Source:            s.Label + " eAIP " + dir + " " + s.NavaidSection,
		Effective:         effective,
		NavaidCount:       shared.NavaidCount,
		Counts:            shared.Counts,
		Tables:            st.Tables,
		SkippedNoPosition: st.SkippedNoPosition,
		BBox:              shared.BBox,
		BBoxes:            shared.BBoxes,
	}
	if len(st.SkippedKinds) > 0 {
		meta.SkippedKinds = st.SkippedKinds
	}
	slot, err := aip.WriteDataset(outDir, s.CC+"-navaids", target, effective, artifact, meta)
	if err != nil {
		return err
	}
	fmt.Printf("%s: wrote %d navaids (%s); slot=%s\n", s.CC, meta.NavaidCount, countSummary(meta.Counts), slot)
	return nil
}

func countSummary(counts map[string]int) string {
	parts := make([]string, 0, len(counts))
	for _, k := range sortedIntKeys(counts) {
		parts = append(parts, fmt.Sprintf("%s:%d", k, counts[k]))
	}
	return strings.Join(parts, " ")
}
