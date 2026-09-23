// build.go: parses three FAA FeatureServer blobs into the per-source
// artefact + meta.

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/overlay"
)

const (
	// Sanity window on the emitted row count (~7700 in mid-2026 across
	// boundary + SUA + class). A FeatureServer schema drift parses to
	// zero rows without error, so refuse to write rather than commit a
	// silently empty faa-airspaces.json.
	defaultMinAirspaces = 1000
	defaultMaxAirspaces = 20000
)

// Meta is the faa-airspaces.meta.json document. Three upstreams, no AIRAC,
// per-type counts so the About modal can break down boundary vs SUA vs
// class without re-counting rows.
type Meta struct {
	GeneratedAt   string             `json:"generatedAt"`
	AirspaceCount int                `json:"airspaceCount"`
	Boundary      overlay.SourceMeta `json:"boundary"`
	SpecialUse    overlay.SourceMeta `json:"specialUse"`
	Class         overlay.SourceMeta `json:"class"`
	// ScheduledRows counts the rows carrying published hours of activity,
	// whether from the special-use TIMESOFUSE prose or the rendered
	// Airspace_Schedule timesheets.
	ScheduledRows int            `json:"scheduledRows"`
	Counts        map[string]int `json:"counts"`
	BBox          aip.BBox       `json:"bbox,omitempty"`
	// BBoxes splits that envelope into the pieces the rows really
	// occupy, for a publisher whose territory is not connected;
	// absent when the rows form one group.
	BBoxes []aip.BBox `json:"bboxes,omitempty"`
}

// Options configures Build. Now and the sanity-window bounds are
// overridable for tests (0 uses the defaults).
type Options struct {
	BndURL       string
	SuaURL       string
	ClassURL     string
	Now          func() time.Time
	MinAirspaces int
	MaxAirspaces int
	// Schedules maps a class airspace's GLOBAL_ID to its rendered hours.
	// Empty is fine: the hours column simply stays empty.
	Schedules map[string]string
}

// Build parses the three FAA FeatureServer blobs into an artefact + meta.
// Build itself tolerates an empty cls slice (the offline-test path), but
// main.go aborts the run on any Class_Airspace fetch error, so a partial
// artefact is never committed.
func Build(bnd, sua, cls []byte, opts Options) (overlay.Artifact, Meta, error) {
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	minA, maxA := opts.MinAirspaces, opts.MaxAirspaces
	if minA == 0 {
		minA = defaultMinAirspaces
	}
	if maxA == 0 {
		maxA = defaultMaxAirspaces
	}
	bndRows, err := parseFAA(bnd)
	if err != nil {
		return overlay.Artifact{}, Meta{}, err
	}
	suaRows, err := parseFAA(sua)
	if err != nil {
		return overlay.Artifact{}, Meta{}, err
	}
	clsRows, clsIDs, err := parseFAAWithIDs(cls)
	if err != nil {
		return overlay.Artifact{}, Meta{}, err
	}
	// Class airspace publishes no TIMESOFUSE; its tower hours come from
	// the separate Airspace_Schedule layer. Enrichment only: a schedule
	// that fails to load must not cost us the airspace, so the caller
	// passes an empty map and the column simply stays empty.
	scheduled := applySchedules(clsRows, opts.Schedules, clsIDs)
	all := make([]overlay.Row, 0, len(bndRows)+len(suaRows)+len(clsRows))
	all = append(all, bndRows...)
	all = append(all, suaRows...)
	all = append(all, clsRows...)
	art, counts := overlay.RowsToArtifact(all)

	if n := len(art.Rows); n < minA || n > maxA {
		return overlay.Artifact{}, Meta{}, fmt.Errorf(
			"FAA airspace count %d outside sanity window [%d, %d] - source format may have changed",
			n, minA, maxA)
	}

	bndSum := sha256.Sum256(bnd)
	suaSum := sha256.Sum256(sua)
	clsSum := sha256.Sum256(cls)
	meta := Meta{
		GeneratedAt:   now().UTC().Format("2006-01-02T15:04:05.000Z"),
		AirspaceCount: len(art.Rows),
		Boundary:      overlay.SourceMeta{URL: opts.BndURL, Sha256: hex.EncodeToString(bndSum[:]), Count: len(bndRows)},
		SpecialUse:    overlay.SourceMeta{URL: opts.SuaURL, Sha256: hex.EncodeToString(suaSum[:]), Count: len(suaRows)},
		Class:         overlay.SourceMeta{URL: opts.ClassURL, Sha256: hex.EncodeToString(clsSum[:]), Count: len(clsRows)},
		ScheduledRows: scheduled,
		Counts:        counts,
	}
	meta.BBox = aip.BBoxOfRows(art.Fields, art.Rows)
	meta.BBoxes = aip.BBoxClustersOfRows(art.Fields, art.Rows)
	return art, meta, nil
}
