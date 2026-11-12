package main

import (
	"encoding/json"
	"testing"

	"github.com/0intro/loxodrome/internal/gis"
)

func feat(t *testing.T, geometry string, props map[string]any) gis.Feature {
	t.Helper()
	return gis.Feature{Geometry: json.RawMessage(geometry), Properties: props}
}

const square = `{"type":"Polygon","coordinates":[[[13.8,62.2],[13.9,62.2],[13.9,62.3],[13.8,62.3],[13.8,62.2]]]}`

// The limits LFV writes: GND, UNL, a flight level, and bare feet, which
// are ft AMSL unless the AIP's own row says otherwise.
func TestParseLimit(t *testing.T) {
	hints := &datumHints{rows: []string{
		"HEMAVAN TIA/RMZ 655820N 0143459E - 660513N 0143341E TO POINT OF ORIGIN. FL 095 / 1000 FT GND CLASS G",
		"ESR129 HELSINGBORG 560526N 0124108E TO POINT OF ORIGIN. 1200 FT AMSL 400 FT SFC",
	}}
	cases := []struct {
		in, name   string
		value, ref string
	}{
		{"GND", "X", "GND", ""},
		{"UNL", "X", "UNL", ""},
		{"FL 95", "X", "95", "STD"},
		{"1500", "ROENNE CTR", "1500", "MSL"},
		{"1000", "HEMAVAN TIA/RMZ", "1000", "SFC"},
		{"400", "ES R129", "400", "SFC"},
		{"1200", "ES R129", "1200", "MSL"}, // the same row's AMSL ceiling
		// ES R12 is not ES R129: a name matches as whole words only.
		{"400", "ES R12", "400", "MSL"},
	}
	for _, c := range cases {
		st := &airspaceStats{}
		got := parseLimit(c.in, c.name, hints, st)
		if got == nil || got.Value != c.value || got.Ref != c.ref {
			t.Errorf("parseLimit(%q, %q) = %+v, want %s %s", c.in, c.name, got, c.value, c.ref)
		}
	}
}

// The typename is the type, the designator refines it, and a designated
// area is addressed by its designator so a NOTAM's "ES R104C" links it.
func TestParseAirspaces(t *testing.T) {
	st := &airspaceStats{}
	got := parseAirspaces("RSTA", []gis.Feature{
		feat(t, square, map[string]any{"NAMEOFAREA": "ES R104C", "LOCATION": "ES R104C KÄNSÖ", "UPPER": "9000", "LOWER": "GND"}),
		feat(t, square, map[string]any{"NAMEOFAREA": "ES P1", "UPPER": "1000", "LOWER": "GND"}),
	}, nil, st)
	if len(got) != 2 || got[0].ID != "ESR104C" || got[0].Type != "R" || got[0].Name != "ES R104C KÄNSÖ" || got[1].Type != "P" {
		t.Fatalf("restricted areas: %+v", got)
	}
	got = parseAirspaces("TIA", []gis.Feature{
		feat(t, square, map[string]any{"NAMEOFAREA": "SVEG  TIA/RMZ", "UPPER": "6000", "LOWER": "3500", "COMMENT_1": "G"}),
	}, nil, st)
	if len(got) != 1 || got[0].Type != "TIA" || got[0].ClassCode != "G" || got[0].Name != "SVEG TIA/RMZ" || got[0].ID != "SE-SVEG-TIA-RMZ" {
		t.Fatalf("TIA: %+v", got)
	}
	if len(got[0].Ring) != 4 || got[0].Ring[0] != [2]float64{62.2, 13.8} {
		t.Errorf("ring in [lat, lon] without its closing vertex: %v", got[0].Ring)
	}
	got = parseAirspaces("TRA", []gis.Feature{
		feat(t, square, map[string]any{"NAMEOFAREA": "ESTRA80 med ", "UPPER": "FL 660", "LOWER": "FL 95"}),
	}, nil, st)
	if len(got) != 1 || got[0].ID != "ESTRA80" {
		t.Errorf("TRA designator: %+v", got)
	}
	if parseAirspaces("AOR", nil, nil, st) != nil {
		t.Error("an area of responsibility is not an airspace a pilot enters")
	}
}

func TestParseNavaids(t *testing.T) {
	pt := `{"type":"Point","coordinates":[18.99355975,63.40606097]}`
	st := &navaidStats{}
	got := parseNavaids("DMEV", []gis.Feature{feat(t, pt, map[string]any{
		"NAMEOFPOINT": "OSK", "LOCATION": "ESNO DMEV OSK", "FREQ": "115.00MHZ",
		"COMMENT_1": "Channel: 97X", "MSL": 109.0, "POSITIONINDICATOR": "ESNO",
	})}, st)
	if len(got) != 1 || got[0].Type != "VOR-DME" || got[0].Name != "OSK" || got[0].Channel != "97X" ||
		got[0].FreqMHz == nil || *got[0].FreqMHz != 115 || got[0].ElevM == nil {
		t.Fatalf("VOR-DME: %+v", got)
	}
	// A DME's FREQ is its paired VHF channel, which nobody tunes.
	got = parseNavaids("DME", []gis.Feature{feat(t, pt, map[string]any{
		"NAMEOFPOINT": "FRL", "FREQ": "116.50MHZ", "COMMENT_1": "Channel 112X",
	})}, st)
	if len(got) != 1 || got[0].FreqMHz != nil || got[0].Channel != "112X" {
		t.Fatalf("DME: %+v", got)
	}
	got = parseNavaids("NDB", []gis.Feature{feat(t, pt, map[string]any{"NAMEOFPOINT": "TG", "FREQ": "346.00 KHZ"})}, st)
	if len(got) != 1 || got[0].FreqKHz == nil || *got[0].FreqKHz != 346 {
		t.Fatalf("NDB: %+v", got)
	}
	// A CTR entry point is named by its place; NAMEOFPOINT is its number.
	got = parseNavaids("ECTR", []gis.Feature{feat(t, pt, map[string]any{"NAMEOFPOINT": "3", "LOCATION": "VASSUNDA"})}, st)
	if len(got) != 1 || got[0].Type != "VFR_REPORTING_POINT" || got[0].Designator != "VASSUNDA" {
		t.Fatalf("ECTR: %+v", got)
	}
}

func TestParseObstaclesAndAerodromes(t *testing.T) {
	pt := `{"type":"Point","coordinates":[15.27765972,57.18371778]}`
	st := &navaidStats{}
	obs := parseObstacles([]gis.Feature{
		feat(t, pt, map[string]any{"NAME": "NORRHULT", "TYPE_DESC": "Wind turbine", "LIGHTING_DESC": "FR",
			"HEIGHT_VALUE": 200.0, "HEIGHT_UNIT": "M", "MSL_VALUE": 489.0, "MSL_UNIT": "M", "POSITIONID": 564718.0}),
		feat(t, pt, map[string]any{"TYPE_DESC": "Tower, Chimney", "LIGHTING_DESC": "unknown"}),
		feat(t, pt, map[string]any{"TYPE_DESC": "Church"}),
	}, st)
	if len(obs) != 3 || obs[0].Type != "Wind turbine" || !obs[0].Lighted || *obs[0].HeightM != 200 || obs[0].ID != "OBSE:564718" {
		t.Fatalf("obstacle: %+v", obs[0])
	}
	if obs[1].Type != "Tower" || obs[1].Lighted || obs[2].Type != "SPIRE" {
		t.Errorf("compound and aliased kinds: %q %v %q", obs[1].Type, obs[1].Lighted, obs[2].Type)
	}
	ads := parseAerodromes("ARP", []gis.Feature{
		feat(t, pt, map[string]any{"POSITIONINDICATOR": "ESNV", "LOCATION": "VILHELMINA", "COMMENT_2": "Traffic permitted: IV"}),
		feat(t, pt, map[string]any{"POSITIONINDICATOR": "ESKK", "LOCATION": "KARLSKOGA", "COMMENT_2": "Traffic permitted: V"}),
	}, st)
	if len(ads) != 2 || !ads[0].IFR || !ads[0].VFR || ads[1].IFR || !ads[1].VFR {
		t.Errorf("traffic permitted: %+v", ads)
	}
}
