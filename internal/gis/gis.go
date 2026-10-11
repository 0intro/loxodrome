// Package gis reads the GIS services some publishers serve their AIP
// through, an ArcGIS FeatureServer (LVNL) or an OGC WFS (LFV), as GeoJSON
// features, and the property helpers every such builder needs.
//
// What a feature MEANS stays with its publisher's command: a layer or a
// typename is one publisher's vocabulary, and the mapping onto
// aixm5.Message is the command's own table. Only the reading is shared.
package gis

import (
	"encoding/json"
	"strconv"
	"strings"
)

// Feature is the slice of a GeoJSON feature the builders need.
type Feature struct {
	Geometry   json.RawMessage `json:"geometry"`
	Properties map[string]any  `json:"properties"`
}

// Prop reads a string property, trimmed. JSON nulls decode to nil and read
// as "", and a number reads in its shortest form.
func Prop(p map[string]any, key string) string {
	switch v := p[key].(type) {
	case string:
		return strings.TrimSpace(v)
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	}
	return ""
}

// PropNum reads a numeric property, from a JSON number or a numeric
// string.
func PropNum(p map[string]any, key string) (float64, bool) {
	switch v := p[key].(type) {
	case float64:
		return v, true
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
		return f, err == nil
	}
	return 0, false
}

// Point reads a GeoJSON point geometry as (lat, lon).
func Point(raw json.RawMessage) (lat, lon float64, ok bool) {
	if len(raw) == 0 {
		return 0, 0, false
	}
	var g struct {
		Type        string    `json:"type"`
		Coordinates []float64 `json:"coordinates"`
	}
	if err := json.Unmarshal(raw, &g); err != nil {
		return 0, 0, false
	}
	if g.Type != "Point" || len(g.Coordinates) < 2 {
		return 0, 0, false
	}
	return g.Coordinates[1], g.Coordinates[0], true
}
