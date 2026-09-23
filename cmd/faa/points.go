// points.go emits faa-navaids.json from two FAA AIS layers: the radio
// navaids (NAVAIDSystem for the kind and position, NavaidComponent for
// the frequency and channel, joined on the ident) and the designated
// points (RNAV waypoints and reporting points).
//
// The row schema is the shared <cc>-navaids.json one, so the SPA reads
// this file with the same loader as every AIXM publisher's; the "faa:"
// id prefix is what navaidSourceFromId keys the publisher off.

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
)

const (
	navaidSystemURL    = "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/NAVAIDSystem/FeatureServer/0/query"
	navaidComponentURL = "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/NAVAIDComponent/FeatureServer/0/query"
	designatedPointURL = "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/DesignatedPoints/FeatureServer/0/query"

	// Pre-release twins, published during the FAA's own pre-release
	// window and stale outside it (see edition.go).
	navaidSystemNextURL    = "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/Pending_NAVAID/FeatureServer/0/query"
	designatedPointNextURL = "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/Pending_Designated_Point/FeatureServer/0/query"

	defaultMinUsNavaids = 5000
	defaultMaxUsNavaids = 60000
)

// navaidTypeByCode maps the NASR navaid type code onto the SPA's navaid
// vocabulary (NAVAID_LABELS in src/lib/data/navaids.ts).
//
// The FAA publishes the kind as an integer, with the human-readable
// class alongside in CLASS_TXT. The mapping below was read off the data:
// every distinct (TYPE_CODE, CLASS_TXT) pair in the live layer agrees
// with the NASR ordering, e.g. 3 is only ever an NDB class (H, HH, HW,
// HW/LOM, MHW, LOMW ...), 6 only ever a VOR/DME class, 9 only ever
// TACAN.
//
// 4 is NDB/DME. There is no combined symbol for it, and the NDB is what
// a VFR pilot tunes, so it draws as an NDB.
var navaidTypeByCode = map[int]string{
	3: "NDB",
	4: "NDB",
	5: "DME",
	6: "VOR-DME",
	7: "VOR",
	8: "VORTAC",
	9: "TACAN",
}

// designatedPointType maps the FAA designated-point kind onto the two
// point types the SPA draws: the ICAO four-pointed star for an RNAV
// waypoint, the hollow triangle for a reporting point.
//
// CNF (Computer Navigation Fix) is deliberately absent: the FAA
// publishes those for flight-management systems and states they are not
// to be used for ATC clearances or position reports, so charting them as
// waypoints would assert something false. They are counted, not drawn.
var designatedPointType = map[string]string{
	"WPT":   "WAYPOINT",
	"RNAV":  "WAYPOINT",
	"NRS":   "WAYPOINT", // Navigation Reference System grid waypoints
	"RPT":   "VFR_REPORTING_POINT",
	"MRPT":  "VFR_REPORTING_POINT",
	"GND":   "VFR_REPORTING_POINT",
	"ORI":   "VFR_REPORTING_POINT",
	"OTHER": "WAYPOINT",
}

// NavaidsMeta is the faa-navaids.meta.json document.
type NavaidsMeta struct {
	GeneratedAt  string         `json:"generatedAt"`
	Source       string         `json:"source"`
	SourceSha256 string         `json:"sourceSha256"`
	Effective    string         `json:"effective"`
	NavaidCount  int            `json:"navaidCount"`
	RadioCount   int            `json:"radioCount"`
	PointCount   int            `json:"pointCount"`
	SkippedNoGeo int            `json:"skippedNoGeo"`
	SkippedCnf   int            `json:"skippedCnf"`
	UnknownTypes []string       `json:"unknownTypes"`
	Counts       map[string]int `json:"counts"`
	BBox         aip.BBox       `json:"bbox,omitempty"`
	// BBoxes splits that envelope into the pieces the rows really
	// occupy, for a publisher whose territory is not connected;
	// absent when the rows form one group.
	BBoxes []aip.BBox `json:"bboxes,omitempty"`
}

var navaidsOutputFields = []string{
	"id", "type", "ident", "name", "lat", "lon", "freq", "channel", "elev",
}

// geoFeature is the slice of a GeoJSON feature these layers need: a
// point geometry and a flat attribute bag.
type geoFeature struct {
	Geometry struct {
		Type        string          `json:"type"`
		Coordinates json.RawMessage `json:"coordinates"`
	} `json:"geometry"`
	Properties map[string]any `json:"properties"`
}

type geoCollection struct {
	Features []geoFeature `json:"features"`
}

// point reads a GeoJSON point as (lat, lon).
func (f *geoFeature) point() (lat, lon float64, ok bool) {
	if f.Geometry.Type != "Point" {
		return 0, 0, false
	}
	var c []float64
	if err := json.Unmarshal(f.Geometry.Coordinates, &c); err != nil || len(c) < 2 {
		return 0, 0, false
	}
	return c[1], c[0], true
}

func propString(p map[string]any, key string) string {
	if v, ok := p[key].(string); ok {
		return strings.TrimSpace(v)
	}
	return ""
}

// propFloat reads a numeric property. The FAA publishes several numeric
// columns as STRINGS (the Digital Obstacle File's Quantity, Lat_DD and
// Long_DD all come back quoted), so a string that parses as a number
// counts: reading only the JSON number type silently loses them.
func propFloat(p map[string]any, key string) (float64, bool) {
	switch v := p[key].(type) {
	case float64:
		return v, true
	case json.Number:
		f, err := v.Float64()
		return f, err == nil
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
		return f, err == nil
	}
	return 0, false
}

func propInt(p map[string]any, key string) (int, bool) {
	f, ok := propFloat(p, key)
	if !ok {
		return 0, false
	}
	return int(math.Round(f)), true
}

// NavaidsOptions configures BuildNavaids.
type NavaidsOptions struct {
	Now        func() time.Time
	Source     string
	Effective  string
	MinNavaids int
	MaxNavaids int
}

// BuildNavaids folds the three layers into one faa-navaids.json.
func BuildNavaids(systems, components, points []byte, opts NavaidsOptions) (overlayArtifact, NavaidsMeta, error) {
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	minN, maxN := opts.MinNavaids, opts.MaxNavaids
	if minN == 0 {
		minN = defaultMinUsNavaids
	}
	if maxN == 0 {
		maxN = defaultMaxUsNavaids
	}

	var sys, comp, pts geoCollection
	if err := json.Unmarshal(systems, &sys); err != nil {
		return overlayArtifact{}, NavaidsMeta{}, fmt.Errorf("decode NAVAIDSystem: %w", err)
	}
	if err := json.Unmarshal(components, &comp); err != nil {
		return overlayArtifact{}, NavaidsMeta{}, fmt.Errorf("decode NavaidComponent: %w", err)
	}
	if err := json.Unmarshal(points, &pts); err != nil {
		return overlayArtifact{}, NavaidsMeta{}, fmt.Errorf("decode DesignatedPoints: %w", err)
	}

	// The frequency lives on the component, not on the system. Index the
	// components by ident and keep the one carrying the highest-value
	// signal: a VHF/UHF frequency beats a bare channel beats nothing.
	// NASR publishes the VHF nav frequency and the NDB carrier in the same
	// column, in MHz and kHz respectively, and the ranges overlap at the
	// bottom (an NDB may sit at 190 kHz). The magnitude therefore cannot
	// separate them; the navaid's own type can, so the raw value is kept
	// here and formatted at row build.
	type radio struct {
		freqVal float64
		hasFreq bool
		channel string
		elevFt  any
	}
	byIdent := map[string]radio{}
	for i := range comp.Features {
		p := comp.Features[i].Properties
		ident := propString(p, "IDENT_TXT")
		if ident == "" {
			continue
		}
		var r radio
		if v, ok := propFloat(p, "FREQUENCY_VAL"); ok && v > 0 {
			r.freqVal, r.hasFreq = v, true
		}
		r.channel = propString(p, "CHANNEL_TXT")
		if v, ok := propFloat(p, "ELEV_VAL"); ok {
			r.elevFt = int(math.Round(v))
		}
		prev, seen := byIdent[ident]
		if !seen || (!prev.hasFreq && r.hasFreq) {
			byIdent[ident] = r
		}
	}

	// formatFreq mirrors aixm5build.BuildNavaids: MHz to three decimals
	// for the VHF/UHF navaids, whole kHz for an NDB carrier.
	formatFreq := func(typ string, r radio) string {
		if !r.hasFreq {
			return ""
		}
		if typ == "NDB" {
			return fmt.Sprintf("%.0f", r.freqVal)
		}
		return fmt.Sprintf("%.3f", r.freqVal)
	}

	rows := make([]any, 0, len(sys.Features)+len(pts.Features))
	counts := map[string]int{}
	unknown := map[string]bool{}
	skippedNoGeo, skippedCnf, radioCount, pointCount := 0, 0, 0, 0

	for i := range sys.Features {
		f := &sys.Features[i]
		lat, lon, ok := f.point()
		if !ok {
			skippedNoGeo++
			continue
		}
		p := f.Properties
		code, _ := propInt(p, "TYPE_CODE")
		typ, known := navaidTypeByCode[code]
		if !known {
			unknown[fmt.Sprintf("NAVAID:%d", code)] = true
			continue
		}
		ident := propString(p, "IDENT")
		if ident == "" {
			continue
		}
		name := propString(p, "NAME_TXT")
		if strings.EqualFold(name, ident) {
			name = ""
		}
		r := byIdent[ident]
		channel := r.channel
		if channel == "" {
			channel = propString(p, "CHANNEL")
		}
		rows = append(rows, []any{
			"faa:" + typ + ":" + ident,
			typ, ident, name,
			aip.Round5(lat), aip.Round5(lon),
			formatFreq(typ, r), channel, r.elevFt,
		})
		counts[typ]++
		radioCount++
	}

	for i := range pts.Features {
		f := &pts.Features[i]
		p := f.Properties
		kind := strings.ToUpper(propString(p, "TYPE_CODE"))
		if kind == "CNF" {
			skippedCnf++
			continue
		}
		typ, known := designatedPointType[kind]
		if !known {
			unknown["POINT:"+kind] = true
			continue
		}
		ident := propString(p, "IDENT")
		if ident == "" {
			continue
		}
		// The layer carries the position both as geometry and as
		// LATITUDE / LONGITUDE columns; prefer the geometry and fall
		// back, since a handful of rows publish only the columns.
		lat, lon, ok := f.point()
		if !ok {
			la, laOK := propFloat(p, "LATITUDE")
			lo, loOK := propFloat(p, "LONGITUDE")
			if !laOK || !loOK {
				skippedNoGeo++
				continue
			}
			lat, lon = la, lo
		}
		rows = append(rows, []any{
			"faa:" + typ + ":" + ident,
			typ, ident, "",
			aip.Round5(lat), aip.Round5(lon),
			"", "", nil,
		})
		counts[typ]++
		pointCount++
	}

	if n := len(rows); n < minN || n > maxN {
		return overlayArtifact{}, NavaidsMeta{}, fmt.Errorf(
			"US navaid count %d outside sanity window [%d, %d] - source format may have changed",
			n, minN, maxN)
	}

	// Sort by (type, ident) like the shared builder, so a refresh diff
	// stays readable.
	sort.SliceStable(rows, func(i, j int) bool {
		a, b := rows[i].([]any), rows[j].([]any)
		if a[1] != b[1] {
			return a[1].(string) < b[1].(string)
		}
		return a[2].(string) < b[2].(string)
	})

	unknownList := make([]string, 0, len(unknown))
	for k := range unknown {
		unknownList = append(unknownList, k)
	}
	sort.Strings(unknownList)

	sum := sha256.Sum256(append(append(append([]byte{}, systems...), components...), points...))
	meta := NavaidsMeta{
		GeneratedAt:  now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Source:       opts.Source,
		SourceSha256: hex.EncodeToString(sum[:]),
		Effective:    opts.Effective,
		NavaidCount:  len(rows),
		RadioCount:   radioCount,
		PointCount:   pointCount,
		SkippedNoGeo: skippedNoGeo,
		SkippedCnf:   skippedCnf,
		UnknownTypes: unknownList,
		Counts:       counts,
		BBox:         aip.BBoxOfRows(navaidsOutputFields, rows),
		BBoxes:       aip.BBoxClustersOfRows(navaidsOutputFields, rows),
	}
	return overlayArtifact{Fields: navaidsOutputFields, Rows: rows}, meta, nil
}

// overlayArtifact is the rows + fields document shape the SPA reads.
type overlayArtifact struct {
	Fields []string `json:"fields"`
	Rows   []any    `json:"rows"`
}

// fetchPointLayers pulls the three navaid layers for one slot.
func fetchPointLayers(ctx context.Context, systemURL, pointURL string) (systems, components, points []byte, err error) {
	if systems, err = fetchFAAPaginated(ctx, systemURL); err != nil {
		return nil, nil, nil, fmt.Errorf("NAVAIDSystem: %w", err)
	}
	if components, err = fetchFAAPaginated(ctx, navaidComponentURL); err != nil {
		return nil, nil, nil, fmt.Errorf("NavaidComponent: %w", err)
	}
	if points, err = fetchFAAPaginated(ctx, pointURL); err != nil {
		return nil, nil, nil, fmt.Errorf("DesignatedPoints: %w", err)
	}
	return systems, components, points, nil
}
