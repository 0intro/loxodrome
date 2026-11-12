package aixm5

import (
	"reflect"
	"testing"
)

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

// TestCurateJoinedCallSigns covers a channel several call signs answer on
// (the decoder joins them with " / "): each position keeps its own row under
// its own label and call sign, a part curated out (the fire service) goes
// alone, parts sharing a label stay one row, and a slash inside a call sign
// ("KOELN/BONN") is no join.
func TestCurateJoinedCallSigns(t *testing.T) {
	cases := []struct {
		name string
		in   RadioChannel
		want []any
	}{
		{"ground and delivery", RadioChannel{Freq: "121.955", Unit: "TWR", CallSign: "GATWICK DELIVERY / GATWICK GROUND"},
			[]any{[]any{"121.955", "DEL", "GATWICK DELIVERY"}, []any{"121.955", "GND", "GATWICK GROUND"}}},
		{"tower and radar", RadioChannel{Freq: "118.300", Unit: "TWR", CallSign: "FOO TOWER / FOO RADAR"},
			[]any{[]any{"118.300", "TWR", "FOO TOWER / FOO RADAR"}}},
		{"radio and fire", RadioChannel{Freq: "120.710", Unit: "OTHER", CallSign: "FENTON RADIO / FENTON FIRE"},
			[]any{[]any{"120.710", "A/A", "FENTON RADIO"}}},
		{"fire alone", RadioChannel{Freq: "121.600", Unit: "OTHER", CallSign: "FENTON FIRE"},
			[]any{}},
		{"bare slash", RadioChannel{Freq: "124.975", Unit: "TWR", CallSign: "KOELN/BONN TOWER"},
			[]any{[]any{"124.975", "TWR", "KOELN/BONN TOWER"}}},
		{"no call sign", RadioChannel{Freq: "118.100", Unit: "TWR", CallSign: ""},
			[]any{[]any{"118.100", "TWR", ""}}},
	}
	for _, c := range cases {
		got := CurateAirportRadios([]RadioChannel{c.in})
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: CurateAirportRadios(%v) = %v, want %v", c.name, c.in, got, c.want)
		}
	}
}

// TestCurateSurfacePositions: a tower service's channel in the surface band
// is answered by its surface call signs (channelCallSign), and the ground
// and delivery ones were the only ones known, so an apron or fire channel
// read as TWR, which the curation says it never is. An apron (the DFS's
// VORFELD) is a surface position, GND beside its own call sign; the fire
// service is curated out, as it is under an OTHER service.
func TestCurateSurfacePositions(t *testing.T) {
	got := CurateAirportRadios([]RadioChannel{
		{Freq: "121.800", Unit: "TWR", CallSign: "FOO APRON / FOO FIRE"},
		{Freq: "121.855", Unit: "TWR", CallSign: "DUESSELDORF VORFELD"},
		{Freq: "121.600", Unit: "TWR", CallSign: "FOO FIRE"},
		{Freq: "118.100", Unit: "TWR", CallSign: "FOO TOWER"},
	})
	want := []any{
		[]any{"121.800", "GND", "FOO APRON"},
		[]any{"121.855", "GND", "DUESSELDORF VORFELD"},
		[]any{"118.100", "TWR", "FOO TOWER"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("curated =\n  %v\nwant\n  %v", got, want)
	}
}

// TestCurateApronServices: the DFS files its apron control as a ground
// traffic control service (type SMGCS), a surface position: GND beside its
// own call sign, a numbered apron ("MUENCHEN APRON 1") as much as a bare
// one, and a tower-typed one the same. Its de-icing coordination channel is
// no ground-movement channel and is curated out, as the fire vehicle's is.
func TestCurateApronServices(t *testing.T) {
	got := CurateAirportRadios([]RadioChannel{
		{Freq: "121.705", Unit: "SMGCS", CallSign: "MUENCHEN APRON 1"},
		{Freq: "121.700", Unit: "SMGCS", CallSign: "FRANKFURT APRON"},
		{Freq: "121.955", Unit: "SMGCS", CallSign: "MEMMINGEN DE-ICING"},
		{Freq: "121.780", Unit: "TWR", CallSign: "MUENCHEN APRON 2"},
	})
	want := []any{
		[]any{"121.705", "GND", "MUENCHEN APRON 1"},
		[]any{"121.700", "GND", "FRANKFURT APRON"},
		[]any{"121.780", "GND", "MUENCHEN APRON 2"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("curated =\n  %v\nwant\n  %v", got, want)
	}
}
