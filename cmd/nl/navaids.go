// navaids.go turns the LVNL Navaid and Waypoints layers into
// nl-navaids.json, through the shared aixm5build.BuildNavaids.
//
// LVNL files one navaid kind per layer. The ILS is filed as three
// separate installations sharing a designator (LOC, GP, DME_ILS); the
// repo's convention, set by cmd/fr, is that the LOCALIZER is the ILS
// row, so the glide path is folded away and a localizer that has a
// paired DME becomes ILS-DME.

package main

import (
	"fmt"
	"strings"

	"github.com/0intro/loxodrome/internal/aixm5"
	"github.com/0intro/loxodrome/internal/gis"
)

// navaidLayer is one LVNL Navaid layer and the type its rows emit.
type navaidLayer struct {
	id    int
	emit  string
	label string
}

var navaidLayers = []navaidLayer{
	{id: 0, emit: "DME", label: "DME"},
	{id: 1, emit: "VOR", label: "VOR"},
	{id: 2, emit: "NDB", label: "NDB"},
	{id: 3, emit: "TACAN", label: "TACAN"},
	{id: 4, emit: "VOR-DME", label: "VOR-DME"},
	// The localizer carries the ILS; whether it becomes ILS or ILS-DME is
	// settled below by whether a DME shares its designator.
	{id: 7, emit: "ILS", label: "LOC"},
}

// ilsDmeLayer is read for its designators alone, to decide ILS vs
// ILS-DME. The glide path (layer 8) is deliberately not read: it is the
// same installation as its localizer and would double every ILS.
const ilsDmeLayer = 6

// waypointLayer is one LVNL Waypoints_data layer.
type waypointLayer struct {
	id    int
	emit  string
	label string
	// visualOnly keeps only the rows the AIP marks as visual reporting
	// points. The layer also carries aerodrome reference points, which
	// the airport symbol already draws.
	visualOnly bool
}

var waypointLayers = []waypointLayer{
	{id: 0, emit: "WAYPOINT", label: "ICAO 5-letter"},
	{id: 1, emit: "WAYPOINT", label: "IFR terminal"},
	{id: 2, emit: "VFR_REPORTING_POINT", label: "Visual reporting", visualOnly: true},
}

// parseNavaids turns one navaid layer's features into aixm5.Navaid
// values. ilsDmeIdents names the localizers that have a paired DME.
func parseNavaids(l navaidLayer, feats []gis.Feature, ilsDmeIdents map[string]bool, stats *buildStats) []aixm5.Navaid {
	out := make([]aixm5.Navaid, 0, len(feats))
	for i := range feats {
		p := feats[i].Properties
		ident := strings.ToUpper(gis.Prop(p, "Designator"))
		if ident == "" {
			stats.skippedNoID++
			continue
		}
		lat, lon, ok := gis.Point(feats[i].Geometry)
		if !ok {
			stats.skippedNoGeo++
			continue
		}
		emit := l.emit
		if emit == "ILS" && ilsDmeIdents[ident] {
			emit = "ILS-DME"
		}
		n := aixm5.Navaid{
			ID:         fmt.Sprintf("%s:%s", emit, ident),
			Designator: ident,
			Type:       emit,
			Name:       gis.Prop(p, "Name"),
			Lat:        lat,
			Lon:        lon,
			Channel:    gis.Prop(p, "Channel"),
		}
		if v, ok := gis.PropNum(p, "Frequency"); ok && v > 0 {
			unit := strings.ToUpper(gis.Prop(p, "FrequencyUnit"))
			switch unit {
			case "MHZ", "":
				f := v
				n.FreqMHz = &f
			case "KHZ":
				// The shared builder formats an NDB carrier in kHz off the
				// type, so hand it the kHz value the way the AIXM path does.
				f := v / 1000
				n.FreqMHz = &f
			}
		}
		out = append(out, n)
	}
	return out
}

// parseWaypoints turns one waypoint layer's features into aixm5.Navaid
// values of the point types.
func parseWaypoints(l waypointLayer, feats []gis.Feature, stats *buildStats) []aixm5.Navaid {
	out := make([]aixm5.Navaid, 0, len(feats))
	for i := range feats {
		p := feats[i].Properties
		ident := strings.ToUpper(gis.Prop(p, "Designator"))
		if ident == "" {
			stats.skippedNoID++
			continue
		}
		if l.visualOnly && !strings.HasPrefix(strings.ToUpper(gis.Prop(p, "type_nl")), "VISREP") {
			// An aerodrome reference point, not a reporting point: the
			// airport symbol already marks the field, which is the same
			// reason the AIXM path drops designated points typed ADHP.
			stats.skippedType++
			continue
		}
		lat, lon, ok := gis.Point(feats[i].Geometry)
		if !ok {
			stats.skippedNoGeo++
			continue
		}
		out = append(out, aixm5.Navaid{
			ID:         fmt.Sprintf("%s:%s", l.emit, ident),
			Designator: ident,
			Type:       l.emit,
			Name:       gis.Prop(p, "Name"),
			Lat:        lat,
			Lon:        lon,
		})
	}
	return out
}
