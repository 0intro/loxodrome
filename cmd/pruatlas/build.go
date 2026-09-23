// build.go: parses pruatlas GeoJSON into the per-source artefact + meta.

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/0intro/loxodrome/internal/firarcs"
	"github.com/0intro/loxodrome/internal/overlay"
)

const (
	// Sanity window on the emitted row count (~270 in mid-2026). A
	// pruatlas naming drift skips every feature without error (and an
	// empty payload parses to zero rows), so refuse to write rather
	// than commit a silently empty pruatlas-firs.json.
	defaultMinAirspaces = 200
	defaultMaxAirspaces = 2000
)

// Meta is the pruatlas-firs.meta.json document. One upstream, one cycle
// number, no per-type counts (pruatlas is FIR/UIR only).
type Meta struct {
	GeneratedAt   string             `json:"generatedAt"`
	AirspaceCount int                `json:"airspaceCount"`
	Source        overlay.SourceMeta `json:"source"`
}

// Options configures Build. Now and the sanity-window bounds are
// overridable for tests (0 uses the defaults).
type Options struct {
	URL          string
	Now          func() time.Time
	MinAirspaces int
	MaxAirspaces int
}

// Build parses pruatlas GeoJSON into an artefact + meta. Pure function;
// main.go does the network fetching.
func Build(data []byte, opts Options) (overlay.Artifact, Meta, error) {
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
	rows, cycle, err := parsePruatlas(data)
	if err != nil {
		return overlay.Artifact{}, Meta{}, err
	}
	art, _ := overlay.RowsToArtifact(rows)
	// Same-state same-type FIR siblings get their foreign-facing arcs
	// (the German EDGG / EDMM / EDWW trio, the US centre lattice, the
	// Canadian and Australian FIRs...), computed on the FINAL simplified
	// rows so the app's exact segment matching holds. cmd/faa skips
	// this: its FIR-family rows are all merge-shadowed by pruatlas.
	firarcs.Apply(art.Rows)
	if n := len(art.Rows); n < minA || n > maxA {
		return overlay.Artifact{}, Meta{}, fmt.Errorf(
			"pruatlas FIR count %d outside sanity window [%d, %d] - source format may have changed",
			n, minA, maxA)
	}
	sum := sha256.Sum256(data)
	meta := Meta{
		GeneratedAt:   now().UTC().Format("2006-01-02T15:04:05.000Z"),
		AirspaceCount: len(art.Rows),
		Source: overlay.SourceMeta{
			URL:    opts.URL,
			Sha256: hex.EncodeToString(sum[:]),
			Count:  len(rows),
			Cycle:  cycle,
		},
	}
	return art, meta, nil
}
