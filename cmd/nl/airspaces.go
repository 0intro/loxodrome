// airspaces.go turns the LVNL airspace layers into nl-airspaces.json.
//
// LVNL files one feature kind per layer, so the layer number is the
// authoritative statement of what a volume is; the `LocalType` column
// refines it. The table below is therefore the whole type mapping, and
// every entry is grounded in the layer's own contents rather than in a
// guess at what a Dutch abbreviation stands for. The notes name the
// evidence where the mapping is not self-evident.

package main

import (
	"fmt"
	"strings"

	"github.com/0intro/loxodrome/internal/overlay"
)

// airspaceLayer is one LVNL layer and the type its rows emit.
type airspaceLayer struct {
	id int
	// emit is the type string the SPA reads (AIRSPACE_CATEGORY in
	// src/lib/data/airspaces.ts). Empty means the layer is deliberately
	// not drawn.
	emit string
	// byLocalType overrides emit for a specific LocalType value.
	byLocalType map[string]string
	// byType overrides emit for a specific Type value, which is what
	// separates two different things filed in one layer.
	byType map[string]string
	label  string
}

var airspaceLayers = []airspaceLayer{
	// The FIR layer holds the Amsterdam FIR and, filed as a RAS, the North
	// Sea area over which the Netherlands provides a flight information
	// service. Only the first is a FIR: typing the second one FIR would
	// give it the FIR comb and, worse, put it in the category whose panels
	// carry the Item A) NOTAM briefing.
	{id: 0, emit: "FIR", byType: map[string]string{"RAS": "SIV"}, label: "FIR"},
	{id: 13, emit: "CTA", label: "CTA"},
	{id: 14, emit: "TMA", label: "TMA"},
	{id: 15, emit: "CTR", label: "CTR"},
	{id: 7, emit: "ATZ", label: "ATZ"},
	{id: 17, emit: "D", byLocalType: map[string]string{"DLG-ATS": "DLG-ATS"}, label: "Danger"},
	{id: 18, emit: "R", label: "Restricted"},
	{id: 19, emit: "P", label: "Prohibited"},
	{id: 3, emit: "TSA", label: "TSA"},
	{id: 5, emit: "TRA", label: "TRA"},
	{id: 10, emit: "RMZ", label: "RMZ"},
	// RTMZ is a zone demanding BOTH radio and transponder, which is the
	// SPA's own TMZ-RMZ token.
	{id: 8, emit: "TMZ", byLocalType: map[string]string{"RTMZ": "TMZ-RMZ"}, label: "TMZ / RTMZ"},
	// Helicopter Traffic Zones and Helicopter Protected Zones ring
	// offshore installations and helidecks (the rows are named after North
	// Sea platforms and wind farms: RIFFGAT, BKR02-Z02, PENTACON D). A
	// traffic zone around a landing site is what the ATZ symbol says.
	{id: 9, emit: "ATZ", label: "HPZ / HTZ"},
	// Parachute jumping areas, and the climb areas that feed them: the
	// CLIMB rows carry the same site names as the PJA rows (SCHIJF,
	// 'S HEER ARENDSKERKE), so they are the climb-to-altitude leg of the
	// same activity and take the same pictogram.
	{id: 6, emit: "PARACHUTE", label: "Parachute"},
	{id: 16, emit: "PARACHUTE", label: "Climb area"},
	{id: 11, emit: "GLIDER", label: "Glider"},
	// Military low-flying areas (LFA, named after rivers and regions) and
	// the 100-500 ft SFLA areas. Both are areas where a low-level activity
	// takes place rather than a controlled or restricted volume.
	{id: 1, emit: "ACTIVITY", label: "Low flying"},
	// VFR sectors of the Schiphol and Maastricht terminal areas, one of
	// them published class D: controlled airspace, banded by class where
	// LVNL states one.
	{id: 12, emit: "CTA", label: "VFR sector"},
	// The runway-referenced IFR areas at Schiphol ("IFR AREA RWY 18R").
	{id: 20, emit: "CTA", label: "IFR area"},
	// Delegated ATS, plus the vectoring areas filed in the same layer.
	{id: 21, emit: "DLG-ATS", byLocalType: map[string]string{"VECTOR": "CTA"}, label: "Delegated"},
	// ACC sectors are an ATC working division, not an airspace a pilot
	// flies in; the shared type map drops SECTOR for every publisher and
	// this follows it.
	{id: 22, emit: "", label: "ACC sector"},
	{id: 23, emit: "", label: "ACC sector excl."},
}

// unlimitedFL is the flight level at or above which a filed upper limit
// means "unlimited" rather than a level. LVNL files the Amsterdam FIR top
// as FL999.
const unlimitedFL = 990

// verticalTriple builds the [code, value, uom] triple the row schema
// carries, from LVNL's value / unit / reference columns.
//
// The vocabulary is small and complete: references are STD, MSL or SFC,
// units are FL or FT. STD means a flight level, MSL an altitude, and SFC
// the ground, which is the same three-way split every other publisher's
// limits reduce to.
func verticalTriple(p map[string]any, valueKey, unitKey, refKey string) []string {
	ref := strings.ToUpper(prop(p, refKey))
	unit := strings.ToUpper(prop(p, unitKey))
	v, hasV := propNum(p, valueKey)

	// A flight level at or above unlimitedFL is the sentinel for "no
	// upper limit", which is what LVNL files on the FIR top; the schema
	// says that with UNL, not with a level nobody flies.
	if hasV && strings.EqualFold(unit, "FL") && v >= unlimitedFL {
		return []string{"UNL", "", ""}
	}

	switch ref {
	case "SFC":
		return []string{"HEI", "0", "FT"}
	case "STD":
		if !hasV {
			return nil
		}
		return []string{"STD", trimNum(v), "FL"}
	case "MSL":
		if !hasV {
			return nil
		}
		if unit == "FL" {
			// A flight level filed against MSL is still a flight level.
			return []string{"STD", trimNum(v), "FL"}
		}
		return []string{"ALT", trimNum(v), "FT"}
	}
	if !hasV {
		return nil
	}
	if unit == "FL" {
		return []string{"STD", trimNum(v), "FL"}
	}
	if unit == "FT" {
		return []string{"ALT", trimNum(v), "FT"}
	}
	return nil
}

func trimNum(v float64) string {
	if v == float64(int64(v)) {
		return fmt.Sprintf("%d", int64(v))
	}
	return strings.TrimRight(strings.TrimRight(fmt.Sprintf("%.3f", v), "0"), ".")
}

// airspaceRows turns one layer's features into artifact rows.
func airspaceRows(l airspaceLayer, feats []feature, stats *buildStats) []overlay.Row {
	var out []overlay.Row
	for i := range feats {
		p := feats[i].Properties
		emit := l.emit
		if l.byType != nil {
			if over, ok := l.byType[strings.ToUpper(prop(p, "Type"))]; ok {
				emit = over
			}
		}
		local := strings.ToUpper(prop(p, "LocalType"))
		if l.byLocalType != nil {
			if over, ok := l.byLocalType[local]; ok {
				emit = over
			}
		}
		if emit == "" {
			stats.skippedType++
			continue
		}
		id := prop(p, "Designator")
		if id == "" {
			id = prop(p, "Id")
		}
		if id == "" {
			stats.skippedNoID++
			continue
		}
		name := prop(p, "Name")
		if name == "" {
			name = id
		}
		rings, err := overlay.GeomToRings(feats[i].Geometry)
		if err != nil || len(rings) == 0 {
			stats.skippedNoGeo++
			continue
		}
		upper := verticalTriple(p, "UpperLimit", "UpperLimitUnit", "UpperLimitReference")
		lower := verticalTriple(p, "LowerLimit", "LowerLimitUnit", "LowerLimitReference")
		class := strings.ToUpper(prop(p, "Class"))
		for _, r := range rings {
			out = append(out, overlay.Row{
				ID: id, Type: emit, Name: name, Class: class,
				Upper: upper, Lower: lower, Ring: r,
			})
		}
	}
	return out
}

// buildStats counts what a run dropped, so a source change shows up as a
// number rather than as silently missing airspace.
type buildStats struct {
	skippedType  int
	skippedNoID  int
	skippedNoGeo int
}
