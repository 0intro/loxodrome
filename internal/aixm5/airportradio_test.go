package aixm5

import "testing"

// TestAirportServiceLabel covers the curation policy: explicit ATC/info types
// map to canonical labels, an "OTHER" service is kept only when its call sign
// is air-ground radio (ends in RADIO), and everything else is dropped.
func TestAirportServiceLabel(t *testing.T) {
	cases := []struct {
		serviceType, callSign string
		wantLabel             string
		wantKeep              bool
	}{
		{"TWR", "BIGGIN TOWER", "TWR", true},
		{"TWR", "ALDERGROVE GROUND", "GND", true}, // ground published under a tower type
		{"TWR", "LUTON DELIVERY", "DEL", true},    // delivery published under a tower type
		{"APP", "LONDON APPROACH", "APP", true},
		{"ATIS", "HEATHROW ATIS", "ATIS", true},
		{"AFIS", "FOO INFORMATION", "AFIS", true},
		{"OTHER", "POPHAM RADIO", "A/A", true},
		{"OTHER:RADIO", "FENLAND RADIO", "A/A", true},
		{"OTHER", "RONALDSWAY FIRE", "", false},
		{"OTHER", "FOO RESCUE", "", false},
		{"OTHER", "", "", false},
		{"OTHER:MET", "LONDON VOLMET", "", false},
		{"BRIEFING", "FOO BRIEFING", "", false},
	}
	for _, c := range cases {
		gotLabel, gotKeep := airportServiceLabel(c.serviceType, c.callSign)
		if gotLabel != c.wantLabel || gotKeep != c.wantKeep {
			t.Errorf("airportServiceLabel(%q, %q) = (%q, %v), want (%q, %v)",
				c.serviceType, c.callSign, gotLabel, gotKeep, c.wantLabel, c.wantKeep)
		}
	}
}

// TestCurateAirportRadios checks the raw radios are curated to [freq, label,
// call] triples, blanks are dropped, and (freq, label) pairs are de-duplicated.
func TestCurateAirportRadios(t *testing.T) {
	radios := []RadioChannel{
		{Freq: "119.300", Unit: "TWR", CallSign: "BIGGIN TOWER"},
		{Freq: "", Unit: "APP", CallSign: "DROP ME"},           // blank freq dropped
		{Freq: "121.500", Unit: "OTHER", CallSign: "FOO FIRE"}, // fire dropped
		{Freq: "120.800", Unit: "OTHER", CallSign: "POPHAM RADIO"},
		{Freq: "119.300", Unit: "TWR", CallSign: "BIGGIN TOWER"}, // duplicate collapsed
	}
	got := CurateAirportRadios(radios)
	if len(got) != 2 {
		t.Fatalf("CurateAirportRadios kept %d, want 2: %v", len(got), got)
	}
	if first := got[0].([]any); first[0] != "119.300" || first[1] != "TWR" || first[2] != "BIGGIN TOWER" {
		t.Errorf("first = %v, want [119.300 TWR BIGGIN TOWER]", first)
	}
	if second := got[1].([]any); second[0] != "120.800" || second[1] != "A/A" || second[2] != "POPHAM RADIO" {
		t.Errorf("second = %v, want [120.800 A/A POPHAM RADIO]", second)
	}
}
