// obstacles.go emits faa-obstacles.json from the FAA Digital Obstacle
// File, filtered to the tall obstacles worth committing.
//
// The DOF holds 652 525 rows, which is two orders of magnitude past what
// any national obstacle set in this repo carries. The filter is a height
// floor applied server-side, so the fetch is small too: at 500 ft AGL the
// set is ~23 000 rows, right beside es-obstacles.json's 21 333. Lower
// floors are not viable to commit (400 ft is 87 766 rows, 300 ft is
// 139 618), and 500 ft is also where an obstacle starts to matter to an
// en-route VFR aircraft rather than only on an approach.

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/aixm5build"
)

const (
	dofURL = "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/Digital_Obstacle_File/FeatureServer/0/query"

	// usObstacleFloorFt is the AGL height floor. See the file comment.
	usObstacleFloorFt = 500

	defaultMinUsObstacles = 10000
	defaultMaxUsObstacles = 60000
)

// usObstacleTypes maps the FAA's own obstacle vocabulary onto the SPA's.
// It is a different codelist from AIXM's (the shared table in
// internal/aixm5build), so it lives here; the values are the same
// vocabulary the glyph resolver draws.
//
// Keys are the normalised form, so the padded and spaced spellings the
// layer publishes ("COOL TWR", "T-L TWR  ") all land.
var usObstacleTypes = map[string]string{
	"ARCH":     "building",
	"BALLOON":  "other", // moored balloon
	"BLDG":     "building",
	"BLDG-TWR": "tower",
	"BRIDGE":   "bridge",
	"CATENARY": "cable",
	"COOL_TWR": "tower",
	"CRANE":    "crane",
	"DAM":      "building",
	"ELEVATOR": "silo", // grain elevator
	"LANDFILL": "other",
	"MET":      "mast", // meteorological tower
	"MONUMENT": "building",
	"PLANT":    "powerplant",
	"POLE":     "pylon",
	"STACK":    "chimney",
	"T-L_TWR":  "pylon", // transmission-line tower
	"TOWER":    "tower",
	"TRAMWAY":  "cable",
	"WINDMILL": "windturbine",
}

// ObstaclesMeta is the faa-obstacles.meta.json document.
type ObstaclesMeta struct {
	GeneratedAt  string `json:"generatedAt"`
	Source       string `json:"source"`
	SourceSha256 string `json:"sourceSha256"`
	Effective    string `json:"effective"`
	// FloorFt records the height filter the dataset was built with, so a
	// reader can tell an empty region from a filtered one.
	FloorFt       int            `json:"floorFt"`
	ObstacleCount int            `json:"obstacleCount"`
	LitCount      int            `json:"litCount"`
	SkippedNoGeo  int            `json:"skippedNoGeo"`
	UnknownTypes  []string       `json:"unknownTypes"`
	Counts        map[string]int `json:"counts"`
	BBox          aip.BBox       `json:"bbox,omitempty"`
	// BBoxes splits that envelope into the pieces the rows really
	// occupy, for a publisher whose territory is not connected;
	// absent when the rows form one group.
	BBoxes []aip.BBox `json:"bboxes,omitempty"`
}

var obstaclesOutputFields = []string{
	"id", "type", "name", "lat", "lon", "elev", "hgt", "lit", "group",
}

// ObstaclesOptions configures BuildObstacles.
type ObstaclesOptions struct {
	Now          func() time.Time
	Source       string
	Effective    string
	MinObstacles int
	MaxObstacles int
}

// BuildObstacles turns the filtered DOF into the shared obstacle row
// schema.
func BuildObstacles(raw []byte, opts ObstaclesOptions) (overlayArtifact, ObstaclesMeta, error) {
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	minN, maxN := opts.MinObstacles, opts.MaxObstacles
	if minN == 0 {
		minN = defaultMinUsObstacles
	}
	if maxN == 0 {
		maxN = defaultMaxUsObstacles
	}

	var fc geoCollection
	if err := json.Unmarshal(raw, &fc); err != nil {
		return overlayArtifact{}, ObstaclesMeta{}, fmt.Errorf("decode Digital_Obstacle_File: %w", err)
	}

	rows := make([]any, 0, len(fc.Features))
	counts := map[string]int{}
	unknown := map[string]bool{}
	litCount, skippedNoGeo := 0, 0

	for i := range fc.Features {
		f := &fc.Features[i]
		p := f.Properties
		lat, lon, ok := f.point()
		if !ok {
			la, laOK := propFloat(p, "Lat_DD")
			lo, loOK := propFloat(p, "Long_DD")
			if !laOK || !loOK {
				skippedNoGeo++
				continue
			}
			lat, lon = la, lo
		}
		rawType := propString(p, "Type_Code")
		typeCode := usObstacleTypes[aixm5build.NormaliseObstacleType(rawType)]
		if typeCode == "" {
			typeCode = "other"
			if t := strings.TrimSpace(rawType); t != "" {
				unknown[t] = true
			}
		}
		// Lighting is a single code letter; anything other than "N" (none)
		// and "U" (unknown) is a lit obstacle.
		lighting := strings.ToUpper(propString(p, "Lighting"))
		lit := lighting != "" && lighting != "N" && lighting != "U"
		if lit {
			litCount++
		}
		var elev, hgt any
		if v, ok := propFloat(p, "AMSL"); ok {
			elev = int(math.Round(v))
		}
		if v, ok := propFloat(p, "AGL"); ok {
			hgt = int(math.Round(v))
		}
		// Quantity > 1 is the DOF's own way of saying "a cluster filed as
		// one record", which is exactly the shared schema's group flag.
		group := false
		if q, ok := propFloat(p, "Quantity"); ok && q > 1 {
			group = true
		}
		id := propString(p, "OAS_Number")
		if id == "" {
			continue
		}
		counts[typeCode]++
		rows = append(rows, []any{
			"faa:" + id,
			typeCode,
			propString(p, "City"),
			aip.Round5(lat),
			aip.Round5(lon),
			elev,
			hgt,
			lit,
			group,
		})
	}

	if n := len(rows); n < minN || n > maxN {
		return overlayArtifact{}, ObstaclesMeta{}, fmt.Errorf(
			"US obstacle count %d outside sanity window [%d, %d] - source format may have changed",
			n, minN, maxN)
	}

	sort.SliceStable(rows, func(i, j int) bool {
		return rows[i].([]any)[0].(string) < rows[j].([]any)[0].(string)
	})

	unknownList := make([]string, 0, len(unknown))
	for k := range unknown {
		unknownList = append(unknownList, k)
	}
	sort.Strings(unknownList)

	sum := sha256.Sum256(raw)
	meta := ObstaclesMeta{
		GeneratedAt:   now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Source:        opts.Source,
		SourceSha256:  hex.EncodeToString(sum[:]),
		Effective:     opts.Effective,
		FloorFt:       usObstacleFloorFt,
		ObstacleCount: len(rows),
		LitCount:      litCount,
		SkippedNoGeo:  skippedNoGeo,
		UnknownTypes:  unknownList,
		Counts:        counts,
		BBox:          aip.BBoxOfRows(obstaclesOutputFields, rows),
		BBoxes:        aip.BBoxClustersOfRows(obstaclesOutputFields, rows),
	}
	return overlayArtifact{Fields: obstaclesOutputFields, Rows: rows}, meta, nil
}
