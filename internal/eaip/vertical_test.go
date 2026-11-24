package eaip

import (
	"testing"

	"github.com/0intro/loxodrome/internal/aixm5"
)

func limitFull(v *aixm5.VerticalLimit) string {
	if v == nil {
		return "-"
	}
	return v.Value + " " + v.Unit + " " + v.Ref
}

// The pair forms the SD oracle found read wrong (cmd/eaip/sd_oracle_test.go),
// beside the positional ones they must not disturb.
func TestParseVerticalPairForms(t *testing.T) {
	for _, c := range []struct {
		in, upper, lower, why string
	}{
		{"FL 195 / GND", "195 FL STD", "GND  ", "a plain pair"},
		{"Upper limit: 1000 FT ALT Lower limit: SFC", "1000 FT MSL", "SFC  ",
			"labelled, NATS's ENR 5.1: the labels broke the positional reading"},
		{"Upper Limit: 1500FT AMSL Lower Limit: SFC", "1500 FT MSL", "SFC  ",
			"labelled, AirNav Ireland's ENR 5.5"},
		{"FL 195 / 4500 FT AMSL (1) (2) (2) Upper limit FL 095 in area 505000N 0053854E excluding EBR05F when active. Lower limit FL 145 in 505513N 0052827E",
			"195 FL STD", "4500 FT MSL",
			"skeyes: labels in a note on parts of the area are no pair"},
		{"By NOTAM (Within FL 330 / FL 125)", "330 FL STD", "125 FL STD",
			"SMATSA: the envelope a NOTAM activates the area within"},
		{"By NOTAM (Within FL 195 / GND)", "195 FL STD", "GND  ", "an envelope from the ground"},
		{"By NOTAM (Within FL 195 / 1500 FT AGL)", "195 FL STD", "1500 FT SFC", "a height floor"},
		{"By NOTAM (TSA 07 TANGO MNE: Within FL 380 / FL 200 TSA 07Z TANGO MNE: Within FL 395 / FL 200)",
			"380 FL STD", "200 FL STD", "the area's own envelope, before its buffer's"},
		{"By NOTAM (Within 2000 FT AMSL / GND and FL 195 / FL 120)", "-", "-",
			"two bands for one area are no pair, and nothing is guessed"},
		{"By NOTAM / GND", "-", "GND  ", "a ceiling set by NOTAM alone stays unknown"},
		{"(Within 11500 FT ALT/ GND)", "11500 FT MSL", "GND  ", "ALT is an altitude above mean sea level"},
		{"FL 175 / 2500 FT QNH", "175 FL STD", "2500 FT MSL",
			"ROMATSA: a level on the QNH is an altitude, above mean sea level"},
		{"Lower limit: GND", "-", "GND  ",
			"Avinor's ENR 5.1: a floor alone, the ceiling left to the NOTAM activating the area"},
		{"Upper limit: 4000 FT AMSL Lower limit: 3500 FT SFC", "4000 FT MSL", "3500 FT SFC",
			"Avinor: a surface word after a labelled height is its reference"},
		{"3500 FT SFC", "3500 FT ", "SFC  ",
			"unlabelled, where a line break may have stood between them, the two stay two limits"},
		{"FL 0 95 / FL  055", "095 FL STD", "055 FL STD",
			"skeyes's ENR 2.1: a thin space after a level's leading 0 (Brussels CTA South One)"},
		{"FL 0 55 / 2 500 FT AMSL", "055 FL STD", "2500 FT MSL",
			"skeyes's ENR 2.1: the split level above an altitude (Liège TMA Three)"},
		{"FL  095 / FL 0 55", "095 FL STD", "055 FL STD",
			"skeyes's ENR 2.1: the split level as the floor (Brussels TMA Seven)"},
		{"GND – FL205", "GND  ", "205 FL STD", "KANS: a dash between the two, read in print order"},
		{"Vertical limits: GND – FL205 (IFR flights permitted between 5700 FT AMSL and FL205)", "GND  ", "205 FL STD",
			"KANS's BKR13: the dash after a labelled floor"},
		{"SFC to 5000ft", "SFC  ", "5000 FT ", "AirNav's ENR 2.2: the word to between the two (Sligo RMZ/TMZ)"},
		{"SFC - 4500FT AMSL", "SFC  ", "4500 FT MSL", "AirNav's ENR 5.5 (Clonbullogue)"},
		{"4 500 AMSL / GND", "4500 FT MSL", "GND  ",
			"skeyes's ENR 5.2: a figure with no unit is in feet (TRA/TSA37A, Weelde)"},
		{"4 500 AMSL / 1 500 AMSL", "4500 FT MSL", "1500 FT MSL", "skeyes: both limits bare (TRA/TSA37B)"},
		{"FL 095 / 4 500 AMSL", "095 FL STD", "4500 FT MSL", "skeyes: a bare floor under a level (TRA/TSA37C)"},
	} {
		u, l := ParseVerticalPair(c.in)
		if got := limitFull(u); got != c.upper {
			t.Errorf("%s: upper = %q, want %q", c.why, got, c.upper)
		}
		if got := limitFull(l); got != c.lower {
			t.Errorf("%s: lower = %q, want %q", c.why, got, c.lower)
		}
	}
}

// SMATSA prints each TSA and TRA beside its flight-plan buffer zone, a
// second ring in the column the limits would be in; an area with no
// buffer reads NIL there. The buffer column is passed over for the whole
// table, and the limits and remarks read beyond it.
func TestColumnarBufferColumn(t *testing.T) {
	matrix := [][]string{
		{"Name Lateral limits", "TSA with FBZ Name Lateral limits", "Upper/lower limits", "Remarks Time of ACT"},
		{"1", "2", "3", "4"},
		{"TSA 02", "TSA 02Z", "", ""},
		{"450958N 0200407E - 451357N 0200541E - 451927N 0201926E - 450958N 0200407E",
			"450918N 0195631E - 451716N 0195938E - 452449N 0201830E - 450918N 0195631E",
			"By NOTAM (Within FL 330 / FL 125)", "By NOTAM"},
		{"TRA 00 Batajnica", "", "", ""},
		{"450750N 0200400E - 450810N 0201636E - 450312N 0202528E - 450750N 0200400E",
			"NIL", "By NOTAM (Within FL 195 / GND)", "By NOTAM"},
	}
	st := NewZoneStats()
	spec := ZoneSpec{
		Type:       func(section, designator, name string) string { return "TSA" },
		IDPrefix:   "RS",
		IcaoPrefix: "LY",
	}
	zones := parseColumnarTable(matrix, 0, 0, "ENR 5.2", spec, st)
	if len(zones) != 2 {
		t.Fatalf("zones = %d, want 2: the buffers are not areas of their own", len(zones))
	}
	for i, want := range []struct{ name, upper, lower string }{
		{"TSA 02", "330 FL STD", "125 FL STD"},
		{"TRA 00 Batajnica", "195 FL STD", "GND  "},
	} {
		z := zones[i]
		if z.Name != want.name || limitFull(z.UpperLimit) != want.upper || limitFull(z.LowerLimit) != want.lower {
			t.Errorf("zone %d = %q %s / %s, want %q %s / %s", i, z.Name,
				limitFull(z.UpperLimit), limitFull(z.LowerLimit), want.name, want.upper, want.lower)
		}
		if z.Rmk != "By NOTAM" {
			t.Errorf("%s: remarks = %q, want the remarks column's", z.Name, z.Rmk)
		}
		if len(z.Ring) == 0 || z.Ring[0] != [2]float64{45.16611, 20.06861} && i == 0 {
			t.Errorf("%s: ring starts %v, want the area's own", z.Name, z.Ring)
		}
	}
	if st.BufferColumns != 1 {
		t.Errorf("buffer rings passed over = %d, want 1", st.BufferColumns)
	}
}

// KANS prints a restricted area's floor first ("GND" then "9000ft AMSL"
// on the line below), and the columnar reader puts the pair the right way
// up, as the ENR 2.1 reader does.
func TestColumnarLowerFirst(t *testing.T) {
	matrix := [][]string{
		{"Identification, name and lateral limits", "Upper limit Lower limit", "Remarks"},
		{"1", "2", "3"},
		{"BKR14 VOLOIRE SHOOTING RANGE 423814N 0201640E 423813N 0201640E 423738N 0201458E 423759N 0201442E 423928N 0201459E 423814N 0201640E",
			"GND 9000ft AMSL", "RESTRICTED AIRSPACE FOR KFOR / NATO USE ONLY."},
		{"BKR13 NORTH MITROVICA 425257N 0203222E 425207N 0205253E 425707N 0205320E 425840N 0204942E 430417N 0205958E 430720N 0205808E 425257N 0203222E",
			"Vertical limits: GND – FL205 (IFR flights permitted between 5700 FT AMSL and FL205)", "Purpose: KFOR/NATO flight operations."},
	}
	st := NewZoneStats()
	spec := ZoneSpec{
		Type:       func(section, designator, name string) string { return "R" },
		IDPrefix:   "XK",
		IcaoPrefix: "BK",
	}
	zones := parseColumnarTable(matrix, 0, 0, "ENR 5.1", spec, st)
	if len(zones) != 2 {
		t.Fatalf("zones = %d, want 2", len(zones))
	}
	for i, want := range []string{"9000 FT MSL", "205 FL STD"} {
		if z := zones[i]; limitFull(z.UpperLimit) != want || limitFull(z.LowerLimit) != "GND  " {
			t.Errorf("%s = %s / %s, want %s / GND", z.Designator, limitFull(z.UpperLimit), limitFull(z.LowerLimit), want)
		}
	}
	if st.LimitsSwapped != 2 {
		t.Errorf("limits swapped = %d, want 2", st.LimitsSwapped)
	}
}

// The captioned zone tables put a pair printed floor first the right way
// up too, in the labelled layout and in the columnar one.
func TestZoneTablesLowerFirst(t *testing.T) {
	doc, err := ParseHTML([]byte(`<html><body>
<table><caption>LABELLED AREA</caption>
<tr><td>Lateral limits</td><td>505000N 0050000E - 505000N 0051000E - 504000N 0051000E - 505000N 0050000E</td></tr>
<tr><td>Vertical limits</td><td>GND / FL 095</td></tr>
</table>
<table><caption>COLUMNAR AREA</caption>
<thead><tr><th>Lateral limits</th><th>Vertical limits</th><th>Type of restriction</th></tr></thead>
<tbody><tr><td>505000N 0050000E - 505000N 0051000E - 504000N 0051000E - 505000N 0050000E</td><td>GND / 2 500 FT AMSL</td><td>Danger</td></tr></tbody>
</table>
</body></html>`))
	if err != nil {
		t.Fatal(err)
	}
	st := NewZoneStats()
	spec := ZoneSpec{
		Type:     func(section, designator, name string) string { return "D" },
		IDPrefix: "BE",
	}
	zones := ParseZoneTables(doc, "5.1", spec, st)
	if len(zones) != 2 {
		t.Fatalf("zones = %d, want 2", len(zones))
	}
	for i, want := range []string{"095 FL STD", "2500 FT MSL"} {
		if z := zones[i]; limitFull(z.UpperLimit) != want || limitFull(z.LowerLimit) != "GND  " {
			t.Errorf("%s = %s / %s, want %s / GND", z.Name, limitFull(z.UpperLimit), limitFull(z.LowerLimit), want)
		}
	}
	if st.LimitsSwapped != 2 {
		t.Errorf("limits swapped = %d, want 2", st.LimitsSwapped)
	}
}

// A note spanning a table's whole width repeats its text in every column
// position, coordinates included, and is no buffer column: ROMATSA closes
// ENR 5.1 with one, and read as a buffer it moved every zone's limits onto
// the remarks column.
func TestColumnarSpanningNoteIsNoBuffer(t *testing.T) {
	note := "NOTE: IN CASE OF EMERGENCY, AIRCRAFT MAY OVERFLY 443025N 0261400E"
	matrix := [][]string{
		{"Identification, name and lateral limits", "Upper limit Lower limit", "Remarks"},
		{"1", "2", "3"},
		{"LRR3 443025N 0261400E - 442720N 0261825E - 442400N 0261400E - 443025N 0261400E",
			"FL105 GND", "Active: H24"},
		{note, note, note},
	}
	st := NewZoneStats()
	spec := ZoneSpec{
		Type:       func(section, designator, name string) string { return "R" },
		IDPrefix:   "RO",
		IcaoPrefix: "LR",
	}
	zones := parseColumnarTable(matrix, 0, 0, "ENR 5.1", spec, st)
	if len(zones) == 0 {
		t.Fatal("no zone read")
	}
	if z := zones[0]; limitFull(z.UpperLimit) != "105 FL STD" || limitFull(z.LowerLimit) != "GND  " || z.Rmk != "Active: H24" {
		t.Errorf("LRR3 = %s / %s, remarks %q: want FL 105 / GND beside it and its own remarks",
			limitFull(z.UpperLimit), limitFull(z.LowerLimit), z.Rmk)
	}
	if st.BufferColumns != 0 {
		t.Errorf("buffer rings passed over = %d, want none", st.BufferColumns)
	}
}
