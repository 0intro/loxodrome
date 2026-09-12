// obstacles.go classifies each Obs into a language-neutral type code (the
// SPA labels them in English) and produces the compact fr-obstacles.json
// artefact plus its meta sibling. Moved from cmd/obstacles in the cmd/fr
// consolidation.

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
)

const (
	defaultMinObstacles = 8000
	defaultMaxObstacles = 20000
)

// obstacleTypes maps the French txtDescrType values SIA emits to language-
// neutral codes the SPA can label in English. Unknown / blank French types
// fall through to "other".
var obstacleTypes = map[string]string{
	"Eolienne(s)":         "windturbine",
	"Pylône":              "pylon",
	"Mât":                 "mast",
	"Château d'eau":       "watertower",
	"Tour":                "tower",
	"Bâtiment":            "building",
	"Cheminée":            "chimney",
	"Silo":                "silo",
	"Antenne":             "antenna",
	"Câble":               "cable",
	"Phare marin":         "lighthouse",
	"Torchère":            "flarestack",
	"Terril":              "mine",
	"Pile de pont":        "bridge",
	"Centrale thermique":  "powerplant",
	"Grue":                "crane",
	"Eglise":              "church",
	"Treillis métallique": "lattice",
	"Portique":            "portal",
	"Derrick":             "derrick",
	"Autre":               "other",
}

// obstaclesOutputFields is the positional row layout of fr-obstacles.json. The
// SPA's rowToObstacle helper indexes by these positions.
//
//	id:    ObsUid mid
//	type:  language-neutral classification (windturbine, pylon, ...)
//	name:  txtName (numeric ID or alphanumeric tag)
//	lat:   decimal degrees
//	lon:   decimal degrees
//	elev:  feet AMSL, null when missing
//	hgt:   feet AGL, null when missing
//	lit:   boolean (codeLgt=Y)
//	group: boolean (codeGroup=Y)
//	rmk:   txtRmk verbatim; bilingual "French\\English" on new / updated rows
var obstaclesOutputFields = []string{
	"id", "type", "name", "lat", "lon", "elev", "hgt", "lit", "group", "rmk",
}

// ObstaclesArtifact is the fr-obstacles.json document.
type ObstaclesArtifact struct {
	Fields []string `json:"fields"`
	Rows   []any    `json:"rows"`
}

// ObstaclesMeta is the fr-obstacles.meta.json document.
type ObstaclesMeta struct {
	GeneratedAt   string         `json:"generatedAt"`
	Source        string         `json:"source"`
	SourceSha256  string         `json:"sourceSha256"`
	Effective     string         `json:"effective"`
	ObstacleCount int            `json:"obstacleCount"`
	LitCount      int            `json:"litCount"`
	GroupCount    int            `json:"groupCount"`
	SkippedNoGeo  int            `json:"skippedNoGeo"`
	UnknownTypes  []string       `json:"unknownTypes"`
	Counts        map[string]int `json:"counts"`
	// BBox is the emitted rows' lat/lon envelope, which the SPA uses to
	// skip fetching a publisher the current view cannot reach (aip/bbox.go).
	BBox aip.BBox `json:"bbox,omitempty"`
	// BBoxes splits that envelope into the pieces the rows really
	// occupy, for a publisher whose territory is not connected;
	// absent when the rows form one group.
	BBoxes []aip.BBox `json:"bboxes,omitempty"`
}

// ObstaclesOptions configures BuildObstacles.
type ObstaclesOptions struct {
	Source       string
	Now          func() time.Time // overridable for tests
	MinObstacles int              // sanity window; 0 uses the default
	MaxObstacles int
}

// BuildObstacles decodes the AIXM source and produces the obstacles artefact
// + meta.
func BuildObstacles(src []byte, opts ObstaclesOptions) (ObstaclesArtifact, ObstaclesMeta, error) {
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	minN, maxN := opts.MinObstacles, opts.MaxObstacles
	if minN == 0 {
		minN = defaultMinObstacles
	}
	if maxN == 0 {
		maxN = defaultMaxObstacles
	}

	snap, err := decodeObstaclesSnapshot(src)
	if err != nil {
		return ObstaclesArtifact{}, ObstaclesMeta{}, err
	}

	rows := make([]any, 0, len(snap.obs))
	counts := make(map[string]int)
	unknownSet := map[string]bool{}
	litCount, groupCount, skippedGeo := 0, 0, 0

	for i := range snap.obs {
		o := &snap.obs[i]
		lat, ok := aip.ParseLat(o.Uid.GeoLat)
		if !ok {
			skippedGeo++
			continue
		}
		lon, ok := aip.ParseLon(o.Uid.GeoLong)
		if !ok {
			skippedGeo++
			continue
		}
		typeCode := obstacleTypes[strings.TrimSpace(o.TxtDescrType)]
		if typeCode == "" {
			typeCode = "other"
			if t := strings.TrimSpace(o.TxtDescrType); t != "" && t != "Autre" {
				unknownSet[t] = true
			}
		}
		counts[typeCode]++
		lit := strings.EqualFold(strings.TrimSpace(o.CodeLgt), "Y")
		group := strings.EqualFold(strings.TrimSpace(o.CodeGroup), "Y")
		if lit {
			litCount++
		}
		if group {
			groupCount++
		}
		rows = append(rows, []any{
			strconv.FormatInt(o.Uid.Mid, 10),
			typeCode,
			o.TxtName,
			aip.Round5(lat),
			aip.Round5(lon),
			intOrNull(o.ValElev),
			intOrNull(o.ValHgt),
			lit,
			group,
			o.TxtRmk,
		})
	}

	if n := len(rows); n < minN || n > maxN {
		return ObstaclesArtifact{}, ObstaclesMeta{}, fmt.Errorf(
			"obstacle count %d outside sanity window [%d, %d] - source format may have changed",
			n, minN, maxN)
	}

	unknownList := make([]string, 0, len(unknownSet))
	for k := range unknownSet {
		unknownList = append(unknownList, k)
	}
	// Sorted for stable meta output (golden-file friendly).
	sort.Strings(unknownList)

	sum := sha256.Sum256(src)
	meta := ObstaclesMeta{
		GeneratedAt:   now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Source:        opts.Source,
		SourceSha256:  hex.EncodeToString(sum[:]),
		Effective:     snap.effective,
		ObstacleCount: len(rows),
		LitCount:      litCount,
		GroupCount:    groupCount,
		SkippedNoGeo:  skippedGeo,
		UnknownTypes:  unknownList,
		Counts:        counts,
	}
	if skippedGeo > 0 {
		fmt.Fprintf(os.Stderr, "skipped %d obstacles with invalid coordinates\n", skippedGeo)
	}
	meta.BBox = aip.BBoxOfRows(obstaclesOutputFields, rows)
	meta.BBoxes = aip.BBoxClustersOfRows(obstaclesOutputFields, rows)
	return ObstaclesArtifact{Fields: obstaclesOutputFields, Rows: rows}, meta, nil
}

// intOrNull returns the integer value as any, or nil if blank / unparseable.
// Heights/elevations are typically whole feet; preserve them as numbers so
// the SPA can compare and sort.
func intOrNull(s string) any {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		// Fall back to float when the value carries a fractional part
		// (rare; SIA usually emits whole feet).
		f, err2 := strconv.ParseFloat(s, 64)
		if err2 != nil {
			return nil
		}
		return f
	}
	return n
}
