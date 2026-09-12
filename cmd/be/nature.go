// nature.go emits be-nature.json: the ENR 5.6 bird concentration areas as
// point rows mirroring fr-nature.json (cmd/fr/nature.go's
// natureOutputFields), under the new type BIRD. The Belgian section
// publishes GEOREF one-degree squares ("510000N to 515959N" x "0020000E to
// 0025959E"), so each area is emitted as its centroid point; the blanket
// recommendation the section states ("pilots ... should, whenever
// possible, avoid flying at less than 1 000 FT above surface level") maps
// to minAlt 1000 AGL.

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"github.com/0intro/loxodrome/internal/eaip"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
)

const (
	defaultMinBeNature = 3
	defaultMaxBeNature = 500

	// The ENR 5.6 blanket recommendation.
	birdMinAltFt = 1000
)

var natureOutputFields = []string{
	"id", "type", "name", "lat", "lon", "minAlt", "minAltRef",
}

// NatureArtifact is the be-nature.json document.
type NatureArtifact struct {
	Fields []string `json:"fields"`
	Rows   []any    `json:"rows"`
}

// NatureMeta is the be-nature.meta.json document.
type NatureMeta struct {
	GeneratedAt  string         `json:"generatedAt"`
	Source       string         `json:"source"`
	SourceSha256 string         `json:"sourceSha256"`
	Effective    string         `json:"effective"`
	ZoneCount    int            `json:"zoneCount"`
	Counts       map[string]int `json:"counts"`
	// BBox is the emitted rows' lat/lon envelope, which the SPA uses to
	// skip fetching a publisher the current view cannot reach (aip/bbox.go).
	BBox aip.BBox `json:"bbox,omitempty"`
	// BBoxes splits that envelope into the pieces the rows really
	// occupy, for a publisher whose territory is not connected;
	// absent when the rows form one group.
	BBoxes []aip.BBox `json:"bboxes,omitempty"`
}

var (
	parallelsRe = regexp.MustCompile(`(\d{6})([NS])\s+to\s+(\d{6})([NS])`)
	meridiansRe = regexp.MustCompile(`(\d{7})([EW])\s+to\s+(\d{7})([EW])`)
)

// natureRow is one emitted bird area.
type natureRow struct {
	id, name string
	lat, lon float64
}

// parseBirdAreas reads the ENR 5.6 tables: rows carrying a GEOREF square
// (parallels + meridians ranges) or a plain coordinate pair.
func parseBirdAreas(t *tree) []natureRow {
	doc := t.doc("eAIP/EB-ENR-5.6-en-GB.html")
	if doc == nil {
		return nil
	}
	var out []natureRow
	seen := map[string]bool{}
	for _, table := range eaip.Elems(doc, "table") {
		for _, row := range eaip.ExpandTable(table) {
			joined := eaip.NormSpace(strings.Join(row, " | "))
			pm := parallelsRe.FindStringSubmatch(joined)
			mm := meridiansRe.FindStringSubmatch(joined)
			var lat, lon float64
			var ok bool
			switch {
			case pm != nil && mm != nil:
				lat1, ok1 := degMinSec(pm[1], pm[2], 2)
				lat2, ok2 := degMinSec(pm[3], pm[4], 2)
				lon1, ok3 := degMinSec(mm[1], mm[2], 3)
				lon2, ok4 := degMinSec(mm[3], mm[4], 3)
				lat, lon = eaip.Round5((lat1+lat2)/2), eaip.Round5((lon1+lon2)/2)
				ok = ok1 && ok2 && ok3 && ok4
			default:
				lat, lon, ok = eaip.FirstCoord(joined)
			}
			if !ok {
				continue
			}
			name := birdName(row)
			if name == "" {
				continue
			}
			id := "BE-BIRD-" + slug(name)
			if seen[id] {
				continue
			}
			seen[id] = true
			out = append(out, natureRow{id: id, name: name, lat: lat, lon: lon})
		}
	}
	return out
}

// degMinSec decodes a compact DDMMSS / DDDMMSS figure with hemisphere.
func degMinSec(s, hemi string, degDigits int) (float64, bool) {
	if degDigits == 2 {
		return aip.ParseLat(s + hemi)
	}
	return aip.ParseLon(s + hemi)
}

var georefCellRe = regexp.MustCompile(`^[A-Z]{4}$`)

// birdName picks the area label: the first cell that is neither a GEOREF
// token nor a coordinate range.
func birdName(row []string) string {
	for _, c := range row {
		c = strings.TrimSpace(c)
		if c == "" || len(c) < 3 {
			continue
		}
		up := strings.ToUpper(eaip.NormSpace(c))
		if parallelsRe.MatchString(up) || meridiansRe.MatchString(up) || eaip.CoordRe.MatchString(up) {
			continue
		}
		if georefCellRe.MatchString(up) { // GEOREF cell id
			return up
		}
		return strings.Join(strings.Fields(c), " ")
	}
	return ""
}

// BuildNature emits the be-nature artefact + meta.
func BuildNature(rows []natureRow, source string, raw []byte, effective string, now func() time.Time, minN, maxN int) (NatureArtifact, NatureMeta, error) {
	if now == nil {
		now = time.Now
	}
	if minN == 0 {
		minN = defaultMinBeNature
	}
	if maxN == 0 {
		maxN = defaultMaxBeNature
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].id < rows[j].id })
	out := make([]any, 0, len(rows))
	for _, r := range rows {
		out = append(out, []any{r.id, "BIRD", r.name, r.lat, r.lon, birdMinAltFt, "AGL"})
	}
	if n := len(out); n < minN || n > maxN {
		return NatureArtifact{}, NatureMeta{}, fmt.Errorf(
			"BE bird-area count %d outside sanity window [%d, %d] - source format may have changed",
			n, minN, maxN)
	}
	sum := sha256.Sum256(raw)
	meta := NatureMeta{
		GeneratedAt:  now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Source:       source,
		SourceSha256: hex.EncodeToString(sum[:]),
		Effective:    effective,
		ZoneCount:    len(out),
		Counts:       map[string]int{"BIRD": len(out)},
	}
	meta.BBox = aip.BBoxOfRows(natureOutputFields, out)
	meta.BBoxes = aip.BBoxClustersOfRows(natureOutputFields, out)
	return NatureArtifact{Fields: natureOutputFields, Rows: out}, meta, nil
}
