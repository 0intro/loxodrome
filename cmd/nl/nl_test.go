package main

import (
	"encoding/json"
	"testing"
)

func props(kv map[string]any) map[string]any { return kv }

// TestVerticalTriple pins the LVNL limit vocabulary. References are STD,
// MSL or SFC and units FL or FT, which reduce to the same three-way split
// every publisher's limits do.
func TestVerticalTriple(t *testing.T) {
	cases := []struct {
		name string
		p    map[string]any
		want []string
	}{
		{"flight level", props(map[string]any{
			"UpperLimit": 95.0, "UpperLimitUnit": "FL", "UpperLimitReference": "STD",
		}), []string{"STD", "95", "FL"}},
		{"altitude", props(map[string]any{
			"UpperLimit": 1500.0, "UpperLimitUnit": "FT", "UpperLimitReference": "MSL",
		}), []string{"ALT", "1500", "FT"}},
		{"surface", props(map[string]any{
			"UpperLimit": 0.0, "UpperLimitUnit": "FT", "UpperLimitReference": "SFC",
		}), []string{"HEI", "0", "FT"}},
		// LVNL files the Amsterdam FIR top as FL999, which is a sentinel
		// for unlimited rather than a level anyone flies.
		{"unlimited sentinel", props(map[string]any{
			"UpperLimit": 999.0, "UpperLimitUnit": "FL", "UpperLimitReference": "STD",
		}), []string{"UNL", "", ""}},
		// A flight level filed against MSL is still a flight level.
		{"FL against MSL", props(map[string]any{
			"UpperLimit": 65.0, "UpperLimitUnit": "FL", "UpperLimitReference": "MSL",
		}), []string{"STD", "65", "FL"}},
		{"nothing published", props(map[string]any{}), nil},
	}
	for _, c := range cases {
		got := verticalTriple(c.p, "UpperLimit", "UpperLimitUnit", "UpperLimitReference")
		if len(got) != len(c.want) {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
			continue
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Errorf("%s: got %v, want %v", c.name, got, c.want)
				break
			}
		}
	}
}

func polyFeature(props map[string]any) feature {
	geom := json.RawMessage(`{"type":"Polygon","coordinates":[[[4.0,52.0],[4.1,52.0],[4.1,52.1],[4.0,52.1],[4.0,52.0]]]}`)
	return feature{Geometry: geom, Properties: props}
}

// TestAirspaceRowsTypeOverrides covers the two places where a layer
// carries more than one thing: the FIR layer, which also holds the North
// Sea flight-information area, and the TMZ layer, which also holds the
// zones demanding both radio and transponder.
func TestAirspaceRowsTypeOverrides(t *testing.T) {
	var stats buildStats
	firLayer := airspaceLayers[0]
	rows := airspaceRows(firLayer, []feature{
		polyFeature(map[string]any{"Designator": "EHAA", "Name": "AMSTERDAM FIR", "Type": "FIR", "LocalType": "FIR"}),
		polyFeature(map[string]any{"Designator": "EHNSAV", "Name": "NORTH SEA AREA V", "Type": "RAS", "LocalType": "FIR"}),
	}, &stats)
	if len(rows) != 2 {
		t.Fatalf("got %d rows, want 2", len(rows))
	}
	if rows[0].Type != "FIR" {
		t.Errorf("the Amsterdam FIR should stay a FIR, got %q", rows[0].Type)
	}
	// Typing this one FIR would put it in the category whose panels carry
	// the Item A) NOTAM briefing.
	if rows[1].Type != "SIV" {
		t.Errorf("the North Sea information area should not be a FIR, got %q", rows[1].Type)
	}

	var tmz buildStats
	tmzLayer := airspaceLayers[11]
	if tmzLayer.label != "TMZ / RTMZ" {
		t.Fatalf("layer table moved: %q", tmzLayer.label)
	}
	rows = airspaceRows(tmzLayer, []feature{
		polyFeature(map[string]any{"Designator": "A", "Type": "RAS", "LocalType": "TMZ"}),
		polyFeature(map[string]any{"Designator": "B", "Type": "RAS", "LocalType": "RTMZ"}),
	}, &tmz)
	if rows[0].Type != "TMZ" || rows[1].Type != "TMZ-RMZ" {
		t.Errorf("TMZ / RTMZ split wrong: %q, %q", rows[0].Type, rows[1].Type)
	}
}

// TestAirspaceRowsSkips covers the ACC sector layers, which are an ATC
// working division rather than an airspace a pilot flies in.
func TestAirspaceRowsSkips(t *testing.T) {
	var stats buildStats
	var sector airspaceLayer
	for _, l := range airspaceLayers {
		if l.label == "ACC sector" {
			sector = l
		}
	}
	rows := airspaceRows(sector, []feature{
		polyFeature(map[string]any{"Designator": "S1", "Type": "SECTOR", "LocalType": "SECTOR"}),
	}, &stats)
	if len(rows) != 0 || stats.skippedType != 1 {
		t.Errorf("ACC sectors should be skipped and counted, got %d rows / %d skipped", len(rows), stats.skippedType)
	}
}

// TestLatestEffective reads the cycle stamp off the newest feature.
func TestLatestEffective(t *testing.T) {
	feats := []feature{
		{Properties: map[string]any{"EffectiveDate": 1650499200000.0}}, // 2022-04-21
		{Properties: map[string]any{"EffectiveDate": 1785974400000.0}}, // 2026-08-06
	}
	if got := latestEffective(feats); got != "2026-08-06T00:00:00.000Z" {
		t.Errorf("latestEffective = %q", got)
	}
	if got := latestEffective(nil); got != "" {
		t.Errorf("no features should give no stamp, got %q", got)
	}
}

func TestNlCountryFromIcao(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"EHAM", "NL"},
		{"EHLE", "NL"},
		{"", "NL"},
	} {
		if got := nlCountryFromIcao(c.in); got != c.want {
			t.Errorf("nlCountryFromIcao(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// TestParseWaypointsVisualOnly covers the reporting-point filter: the
// layer also carries aerodrome reference points, which the airport symbol
// already draws.
func TestParseWaypointsVisualOnly(t *testing.T) {
	pt := func(p map[string]any) feature {
		return feature{
			Geometry:   json.RawMessage(`{"type":"Point","coordinates":[5.0,52.0]}`),
			Properties: p,
		}
	}
	var stats buildStats
	var visual waypointLayer
	for _, l := range waypointLayers {
		if l.visualOnly {
			visual = l
		}
	}
	out := parseWaypoints(visual, []feature{
		pt(map[string]any{"Designator": "EHEHT", "Name": "TANGO", "type_nl": "VISREP_C"}),
		pt(map[string]any{"Designator": "EHLW", "Name": "LEEUWARDEN ARP"}),
	}, &stats)
	if len(out) != 1 || out[0].Designator != "EHEHT" {
		t.Fatalf("got %d points, want only the reporting point", len(out))
	}
	if out[0].Type != "VFR_REPORTING_POINT" {
		t.Errorf("type = %q", out[0].Type)
	}
	if stats.skippedType != 1 {
		t.Errorf("the aerodrome reference point should be counted as skipped")
	}
}

// TestParseNavaidsIlsDme covers the localizer rule: the localizer is the
// ILS row, and it becomes ILS-DME when a DME shares its designator.
func TestParseNavaidsIlsDme(t *testing.T) {
	pt := func(p map[string]any) feature {
		return feature{
			Geometry:   json.RawMessage(`{"type":"Point","coordinates":[4.76,52.3]}`),
			Properties: p,
		}
	}
	var loc navaidLayer
	for _, l := range navaidLayers {
		if l.label == "LOC" {
			loc = l
		}
	}
	var stats buildStats
	out := parseNavaids(loc, []feature{
		pt(map[string]any{"Designator": "ABA", "Frequency": 111.95, "FrequencyUnit": "MHZ"}),
		pt(map[string]any{"Designator": "ZZZ", "Frequency": 110.1, "FrequencyUnit": "MHZ"}),
	}, map[string]bool{"ABA": true}, &stats)
	if len(out) != 2 {
		t.Fatalf("got %d navaids", len(out))
	}
	if out[0].Type != "ILS-DME" {
		t.Errorf("a localizer with a paired DME is ILS-DME, got %q", out[0].Type)
	}
	if out[1].Type != "ILS" {
		t.Errorf("a localizer without one stays ILS, got %q", out[1].Type)
	}
	if out[0].FreqMHz == nil || *out[0].FreqMHz != 111.95 {
		t.Errorf("frequency lost")
	}
}
