// airports.go turns the LVNL Aerodrome layers into nl-airports.json.
//
// Like cmd/at and cmd/be, this builds aixm5.Airport values by hand and
// hands them to the shared aixm5build.BuildAirports, so the row schema,
// the type derivation and the sanity window are the same code every
// publisher uses.
//
// LVNL splits aerodromes across layers by status and kind, so the layer
// number is the authoritative statement of civil / military / joint,
// which is exactly what the OurAirports baseline lacks (cmd/de has to
// carry a curated table for the same gap in Germany).
//
// It emits no runways. The separate Runways layer carries no reference
// to its aerodrome at all, only geometry, so attaching one would mean
// guessing from proximity; and mergeAixmOverlay keeps the baseline's
// runways when the overlay has none, so the OurAirports set survives
// intact rather than being replaced by a guess.

package main

import (
	"strings"

	"github.com/0intro/loxodrome/internal/aixm5"
	"github.com/0intro/loxodrome/internal/gis"
)

// aerodromeLayer is one LVNL Aerodrome layer and what its rows are.
type aerodromeLayer struct {
	id       int
	label    string
	military bool
	joint    bool
	// aixmType is the AIXM AirportHeliport type the shared builder reads:
	// AD for an aerodrome, HP for a heliport, LS for a landing site.
	aixmType string
}

var aerodromeLayers = []aerodromeLayer{
	{id: 0, label: "civil", aixmType: "AD"},
	{id: 1, label: "military", military: true, aixmType: "AD"},
	{id: 2, label: "joint", military: true, joint: true, aixmType: "AD"},
	{id: 5, label: "heliport", aixmType: "HP"},
	{id: 6, label: "heliport offshore", aixmType: "HP"},
	{id: 7, label: "heliport pilotage", aixmType: "HP"},
	{id: 8, label: "heliport hospital", aixmType: "HP"},
	// Microlight, glider and hang-glider sites are landing sites: the
	// shared deriveAirportType files LS as a small aerodrome, which is
	// what they are.
	{id: 9, label: "microlight", aixmType: "LS"},
	{id: 10, label: "glider", aixmType: "LS"},
	{id: 11, label: "hangglider", aixmType: "LS"},
}

// The aerodrome rows also carry chart links (HyperlinkAdc, HyperlinkVac,
// HyperlinkVac1..3), which are deliberately not read: every one names the
// eAIP edition of 2022-01-13 on www.lvnl.nl, a tree LVNL no longer serves
// (all 55 answered 404 on 2026-09-24). The current charts come from LVNL's
// own eAIP package instead, cmd/eaip's chart index (nl-adcharts.json),
// whose links are checked on every build.

// parseAerodromes turns one layer's features into aixm5.Airport values.
func parseAerodromes(l aerodromeLayer, feats []gis.Feature, stats *buildStats) []aixm5.Airport {
	out := make([]aixm5.Airport, 0, len(feats))
	for i := range feats {
		p := feats[i].Properties
		icao := strings.ToUpper(gis.Prop(p, "Designator"))
		if icao == "" {
			stats.skippedNoID++
			continue
		}
		lat, lon, ok := gis.Point(feats[i].Geometry)
		if !ok {
			stats.skippedNoGeo++
			continue
		}
		a := aixm5.Airport{
			ID:         icao,
			Designator: icao,
			Type:       l.aixmType,
			Name:       gis.Prop(p, "Name"),
			Lat:        lat,
			Lon:        lon,
			Military:   l.military,
			Joint:      l.joint,
			// Every published Dutch aerodrome is usable VFR; the AIP does
			// not file a separate access restriction on these layers, so
			// the field stays open rather than asserting one.
			VFR: true,
		}
		if l.military {
			a.ControlType = "MILITARY"
			a.Access = "restricted"
		} else {
			a.ControlType = "CIVIL"
			a.Access = "cap"
		}
		if l.joint {
			a.ControlType = "JOINT"
		}
		if v, ok := gis.PropNum(p, "FieldElevation"); ok {
			m := v
			if strings.EqualFold(gis.Prop(p, "FieldElevationUnit"), "FT") {
				m = v * 0.3048
			}
			a.ElevM = &m
		}
		out = append(out, a)
	}
	return out
}
