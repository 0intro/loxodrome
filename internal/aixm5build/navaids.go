// navaids.go emits a <cc>-navaids.json document from the AIXM 5.1
// decoded equipment + composite navaid features. Same row schema as
// cmd/fr/navaids.go.

package aixm5build

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math"
	"sort"
	"strconv"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/aixm5"
)

const (
	defaultMinNavaids = 0
	defaultMaxNavaids = 50000
)

var navaidsOutputFields = []string{
	"id", "type", "ident", "name", "lat", "lon", "freq", "channel", "elev",
}

// NavaidsMeta is the <cc>-navaids.meta.json document.
type NavaidsMeta struct {
	GeneratedAt        string         `json:"generatedAt"`
	Source             string         `json:"source"`
	SourceSha256       string         `json:"sourceSha256"`
	Effective          string         `json:"effective"`
	NavaidCount        int            `json:"navaidCount"`
	SkippedNonBaseline int            `json:"skippedNonBaseline"`
	UnresolvedXlinks   int            `json:"unresolvedXlinks"`
	Counts             map[string]int `json:"counts"`
	// BBox is the emitted rows' lat/lon envelope (bbox.go).
	BBox aip.BBox `json:"bbox,omitempty"`
	// BBoxes splits that envelope into the pieces the rows really
	// occupy, for a publisher whose territory is not connected; absent
	// when the rows form one group.
	BBoxes []aip.BBox `json:"bboxes,omitempty"`
}

// NavaidsOptions configures BuildNavaids. IDPrefix namespaces each row id
// ("uk" -> "uk:<id>"); Country labels the sanity-window error ("UK").
type NavaidsOptions struct {
	IDPrefix   string
	Country    string
	Now        func() time.Time
	MinNavaids int
	MaxNavaids int
}

// BuildNavaids emits one row per resolved navaid. Composite navaids
// (VOR-DME, VORTAC) already have their component equipment folded
// in by internal/aixm5's resolveNavaids pass; standalone equipment
// (orphan VORs without a Navaid wrapper, NDBs, waypoints) emit
// separately.
func BuildNavaids(msg *aixm5.Message, source string, raw []byte, effective string, opts NavaidsOptions) (Artifact, NavaidsMeta, error) {
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	minN, maxN := opts.MinNavaids, opts.MaxNavaids
	if minN == 0 {
		minN = defaultMinNavaids
	}
	if maxN == 0 {
		maxN = defaultMaxNavaids
	}

	type row struct {
		t, ident string
		payload  []any
	}
	rows := make([]row, 0, len(msg.Navaids))
	counts := map[string]int{}
	for i := range msg.Navaids {
		n := &msg.Navaids[i]
		if n.Lat == 0 && n.Lon == 0 {
			continue
		}
		freq := formatFreq(n)
		var elev any
		if n.ElevM != nil {
			elev = int(math.Round(*n.ElevM / 0.3048))
		}
		name := n.Name
		if name == n.Designator {
			name = ""
		}
		rows = append(rows, row{
			t:     n.Type,
			ident: n.Designator,
			payload: []any{
				opts.IDPrefix + ":" + n.ID,
				n.Type,
				n.Designator,
				name,
				n.Lat,
				n.Lon,
				freq,
				n.Channel,
				elev,
			},
		})
		counts[n.Type]++
	}

	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i].t != rows[j].t {
			return rows[i].t < rows[j].t
		}
		return rows[i].ident < rows[j].ident
	})

	out := make([]any, len(rows))
	for i := range rows {
		out[i] = rows[i].payload
	}

	if n := len(out); n < minN || n > maxN {
		return Artifact{}, NavaidsMeta{}, fmt.Errorf(
			"%s navaid count %d outside sanity window [%d, %d] - source format may have changed",
			opts.Country, n, minN, maxN)
	}

	sum := sha256.Sum256(raw)
	meta := NavaidsMeta{
		GeneratedAt:        now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Source:             source,
		SourceSha256:       hex.EncodeToString(sum[:]),
		Effective:          effective,
		NavaidCount:        len(out),
		SkippedNonBaseline: msg.SkippedNonBaseline,
		UnresolvedXlinks:   msg.UnresolvedXlinks,
		Counts:             counts,
	}
	meta.BBox = aip.BBoxOfRows(navaidsOutputFields, out)
	meta.BBoxes = aip.BBoxClustersOfRows(navaidsOutputFields, out)
	return Artifact{Fields: navaidsOutputFields, Rows: out}, meta, nil
}

// formatFreq picks the right frequency for the navaid type. VOR /
// VOR-DME / VORTAC carry FreqMHz; NDB carries FreqKHz; other types
// have no published frequency.
func formatFreq(n *aixm5.Navaid) string {
	if n.FreqMHz != nil {
		return strconv.FormatFloat(*n.FreqMHz, 'f', 3, 64)
	}
	if n.FreqKHz != nil {
		return strconv.FormatFloat(*n.FreqKHz, 'f', 0, 64)
	}
	return ""
}
