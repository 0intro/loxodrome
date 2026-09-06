package aixm5build

import (
	"reflect"
	"testing"
	"time"

	"github.com/0intro/loxodrome/internal/aixm5"
)

// TestBuildAirspaces drives the decode->build path: an emitted airspace, one
// dropped for an unrenderable type, and one dropped for an empty boundary.
// It asserts the exact positional row. (BuildAirspaces consumes a decoded
// *aixm5.Message, so the test builds one directly rather than parsing XML.)
func TestBuildAirspaces(t *testing.T) {
	ring := [][2]float64{{51, -1}, {51, 0}, {52, 0}, {52, -1}, {51, -1}}
	msg := &aixm5.Message{
		Airspaces: []aixm5.Airspace{
			{
				ID:         "uuid-1",
				Designator: "LONDON TMA",
				Name:       "London TMA",
				Type:       "TMA",
				ClassCode:  "A",
				UpperLimit: &aixm5.VerticalLimit{Value: "245", Unit: "FL", Ref: "STD"},
				LowerLimit: &aixm5.VerticalLimit{Value: "3500", Unit: "FT", Ref: "MSL"},
				Ring:       ring,
				Rmk:        "test remark",
				Radio:      []aixm5.RadioChannel{{Freq: "120.025", Unit: "MHz", CallSign: "LONDON CONTROL"}},
			},
			{ID: "uuid-2", Type: "AWY", Ring: ring},          // AWY maps to "" -> no-type skip
			{ID: "uuid-3", Designator: "X CTR", Type: "CTR"}, // empty ring -> no-boundary skip
		},
		SkippedNonBaseline: 2,
		UnresolvedXlinks:   1,
	}

	fixedNow := func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) }
	art, meta, err := BuildAirspaces(msg, "uk-test.xml", []byte("<raw/>"), "2026-05-14T00:00:00Z",
		AirspacesOptions{Country: "UK", Now: fixedNow, MinAirspaces: 1, MaxAirspaces: 100})
	if err != nil {
		t.Fatal(err)
	}

	if meta.AirspaceCount != 1 || meta.SkippedNoType != 1 || meta.SkippedNoBoundary != 1 {
		t.Errorf("meta counts = %d emitted / %d no-type / %d no-boundary, want 1/1/1",
			meta.AirspaceCount, meta.SkippedNoType, meta.SkippedNoBoundary)
	}
	if meta.SkippedNonBaseline != 2 || meta.UnresolvedXlinks != 1 {
		t.Errorf("passthrough counters = %d/%d, want 2/1", meta.SkippedNonBaseline, meta.UnresolvedXlinks)
	}
	if meta.Counts["TMA"] != 1 {
		t.Errorf("Counts[TMA] = %d, want 1", meta.Counts["TMA"])
	}
	if meta.Effective != "2026-05-14T00:00:00Z" {
		t.Errorf("Effective = %q, want the passed value", meta.Effective)
	}

	if len(art.Rows) != 1 {
		t.Fatalf("rows = %d, want 1", len(art.Rows))
	}
	want := []any{
		"LONDON TMA",
		"TMA",
		"London TMA",
		"A",
		[]string{"STD", "245", "FL"},
		[]string{"ALT", "3500", "FT"},
		nil, // max
		nil, // mnm
		"",  // workHr
		"",  // rmkWorkHr
		"test remark",
		[]any{[]string{"120.025", "MHz", "LONDON CONTROL"}},
		ring,
		"TMA", // subtype
		nil,   // arcs
	}
	if !reflect.DeepEqual(art.Rows[0], want) {
		t.Errorf("row mismatch:\n got %#v\nwant %#v", art.Rows[0], want)
	}
}

// TestBuildAirspacesFIRArcs: FIR-family rows with same-state same-type
// siblings get the external-arcs cell (the EGTT001 / EGPX001 case); a
// lone UIR and a different-state neighbour keep nil.
func TestBuildAirspacesFIRArcs(t *testing.T) {
	south := [][2]float64{{50, -2}, {50, 0}, {52, 0}, {52, -2}}
	north := [][2]float64{{52, -2}, {52, 0}, {54, 0}, {54, -2}}
	far := [][2]float64{{40, 20}, {40, 21}, {41, 21}, {41, 20}}
	msg := &aixm5.Message{
		Airspaces: []aixm5.Airspace{
			{ID: "u1", Designator: "EGTT001", Name: "LONDON FIR", Type: "FIR", Ring: south},
			{ID: "u2", Designator: "EGPX001", Name: "SCOTTISH FIR", Type: "FIR", Ring: north},
			{ID: "u3", Designator: "EGTT002", Name: "LONE UIR", Type: "UIR", Ring: south},
			{ID: "u4", Designator: "LGGG", Name: "OTHER STATE", Type: "FIR", Ring: far},
		},
	}
	art, _, err := BuildAirspaces(msg, "uk-test.xml", []byte("<raw/>"), "",
		AirspacesOptions{Country: "UK", MinAirspaces: 1, MaxAirspaces: 100})
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]any{}
	for _, r := range art.Rows {
		row := r.([]any)
		byID[row[0].(string)] = row[14]
	}
	if byID["EGTT001"] == nil || byID["EGPX001"] == nil {
		t.Error("adjacent same-state FIR rows should carry arcs")
	}
	if byID["EGTT002"] != nil {
		t.Error("the lone UIR must keep nil arcs (typed groups)")
	}
	if byID["LGGG"] != nil {
		t.Error("a different-state FIR must keep nil arcs")
	}
}

func TestMapAirspaceType(t *testing.T) {
	cases := []struct {
		in, localType, want string
	}{
		{"FIR", "", "FIR"},
		{"UIR", "", "UIR"},
		{"TMA", "", "TMA"},
		{"CTR", "", "CTR"},
		{"D", "", "D"},
		{"R", "", "R"},
		{"P", "", "P"},
		{"TRA", "", "TRA"},
		{"TSA", "", "TSA"},
		{"CBA", "", "CBA"},
		{"ACTIVITY", "", "ACTIVITY"},
		{"TMZ", "", "TMZ"},
		{"RMZ", "", "RMZ"},
		{"UIR-P", "", "UIR"},
		{"ATZ", "", "ATZ"},
		{"MOA", "", "MOA"},
		{"A", "", "A"},
		{"W", "", "W"},
		{"AWY", "", ""},
		{"RCA", "", ""},
		{"SECTOR", "", ""},
		{"", "", ""},
		{"  CTR  ", "", "CTR"}, // trimmed
		{"ctr", "", "CTR"},     // case-insensitive
		// DFS Germany: generic type + localType refinement.
		{"CLASS", "", "CTA"},                        // class-defined control area
		{"CTR_P", "", "CTR"},                        // CTR part
		{"OTHER:R_AMC", "", "R"},                    // AMC-managed restricted
		{"OTHER:D_AMC", "", "D"},                    // AMC-managed danger
		{"D_OTHER", "", "D"},                        // danger (other)
		{"RAS", "RMZ", "RMZ"},                       // regulated -> RMZ
		{"RAS", "TMZ", "TMZ"},                       // regulated -> TMZ
		{"RAS", "ATZ", "ATZ"},                       // regulated -> ATZ
		{"RAS", "DLG-ATS", "DLG-ATS"},               // delegated ATS
		{"RAS", "FBZ", "D"},                         // danger sub-zone (not the SPA balloon FBZ)
		{"RAS", "FLIGHT INFORMATION SECTOR", "SIV"}, // FIS sector
		{"RAS", "FRA", ""},                          // free-route: dropped
		{"RAS", "", ""},                             // bare RAS: dropped
		{"PART", "", ""},                            // sector part: dropped
		{"ENTRY_EXIT", "", ""},                      // corridor: dropped
		// Austro Control: military volumes draw as their charted civil
		// equivalent, sporting areas ride the activity family.
		{"MTMA", "", "TMA"},              // military terminal control area
		{"MCTR", "", "CTR"},              // military control zone
		{"MATZ", "", "ATZ"},              // military aerodrome traffic zone
		{"MTRA", "", "TRA"},              // military temporary reserved area
		{"MTA", "", "TSA"},               // military training area
		{"PARACHUTE", "", "PARACHUTE"},   // parachute jumping area
		{"GLIDER", "", "GLIDER"},         // gliding area
		{"PARAGLIDER", "", "PARAGLIDER"}, // hang / para gliding area
	}
	for _, c := range cases {
		if got := mapAirspaceType(c.in, c.localType); got != c.want {
			t.Errorf("mapAirspaceType(%q, %q) = %q, want %q", c.in, c.localType, got, c.want)
		}
	}
}

func TestVerticalTriple(t *testing.T) {
	cases := []struct {
		name string
		in   *aixm5.VerticalLimit
		want any
	}{
		{"nil", nil, nil},
		{"FL standard", &aixm5.VerticalLimit{Value: "350", Unit: "FL", Ref: "STD"},
			[]string{"STD", "350", "FL"}},
		{"MSL feet", &aixm5.VerticalLimit{Value: "3000", Unit: "FT", Ref: "MSL"},
			[]string{"ALT", "3000", "FT"}},
		{"GND sentinel", &aixm5.VerticalLimit{Value: "GND", Unit: "FT", Ref: "SFC"},
			[]string{"HEI", "0", "FT"}},
		{"UNL sentinel", &aixm5.VerticalLimit{Value: "UNL", Unit: "FT", Ref: ""},
			[]string{"UNL", "", ""}},
		{"SFC sentinel", &aixm5.VerticalLimit{Value: "SFC", Unit: "", Ref: ""},
			[]string{"SFC", "", ""}},
		{"SFC-ref height", &aixm5.VerticalLimit{Value: "150", Unit: "M", Ref: "SFC"},
			[]string{"HEI", "150", "M"}},
		{"STD numeric", &aixm5.VerticalLimit{Value: "1500", Unit: "FT", Ref: "STD"},
			[]string{"STD", "1500", "FT"}},
		{"unknown ref", &aixm5.VerticalLimit{Value: "1500", Unit: "FT", Ref: ""},
			[]string{"", "1500", "FT"}},
		// ENAIRE hides the datum behind OTHER: prefixes (LED65, LELC).
		{"ENAIRE OTHER:ALT is AMSL", &aixm5.VerticalLimit{Value: "12500", Unit: "FT", Ref: "OTHER:ALT"},
			[]string{"ALT", "12500", "FT"}},
		{"ENAIRE OTHER:HEI is a height", &aixm5.VerticalLimit{Value: "1000", Unit: "M", Ref: "OTHER:HEI"},
			[]string{"HEI", "1000", "M"}},
		{"ENAIRE OTHER:HEISG is a height", &aixm5.VerticalLimit{Value: "300", Unit: "M", Ref: "OTHER:HEISG"},
			[]string{"HEI", "300", "M"}},
		{"empty everything", &aixm5.VerticalLimit{}, nil},
	}
	for _, c := range cases {
		got := verticalTriple(c.in)
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: verticalTriple(%+v) = %v, want %v", c.name, c.in, got, c.want)
		}
	}
}
