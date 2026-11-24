package aixm5build

import (
	"testing"

	"github.com/0intro/loxodrome/internal/aixm5"
)

// TestDeriveAirportType pins the AIXM type + longest runway mapping onto
// the OurAirports size vocabulary. These cases moved here from cmd/de
// when the per-command airport builders were merged.
func TestDeriveAirportType(t *testing.T) {
	metres := func(m float64) *float64 { return &m }
	cases := []struct {
		name string
		a    aixm5.Airport
		want string
	}{
		// aixm:abandoned outranks the shape: the DFS rows for EDOP /
		// EDHP / EDCK still publish runways and opening hours.
		{"abandoned landing site", aixm5.Airport{Type: "LS", Abandoned: true}, "closed"},
		{"abandoned aerodrome with a long runway", aixm5.Airport{
			Type:      "AD",
			Abandoned: true,
			Runways:   []aixm5.Runway{{LengthM: metres(2500)}},
		}, "closed"},
		{"heliport", aixm5.Airport{Type: "HP"}, "heliport"},
		{"landing site", aixm5.Airport{Type: "LS"}, "small_airport"},
		{"aerodrome, no runway length", aixm5.Airport{Type: "AD"}, "small_airport"},
		{"aerodrome, 1500 m", aixm5.Airport{
			Type:    "AD",
			Runways: []aixm5.Runway{{LengthM: metres(1500)}},
		}, "medium_airport"},
		{"aerodrome, 3000 m", aixm5.Airport{
			Type:    "AD",
			Runways: []aixm5.Runway{{LengthM: metres(3000)}},
		}, "large_airport"},
	}
	for _, c := range cases {
		if got := deriveAirportType(&c.a); got != c.want {
			t.Errorf("%s: deriveAirportType = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestIcaoCountry(t *testing.T) {
	uk := IcaoCountry(map[string]string{"EG": "GB", "EI": "IE"}, "GB")
	cases := []struct{ in, want string }{
		{"EGLL", "GB"},
		{"EINN", "IE"},
		{"LFPG", "GB"}, // outside the table: the AIP's own State
		{"E", "GB"},    // too short to carry a prefix
		{"", "GB"},
	}
	for _, c := range cases {
		if got := uk(c.in); got != c.want {
			t.Errorf("IcaoCountry(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// TestBuildAirportsPrefersRicherDuplicate covers the rule that lets one
// designator appear in two documents: ENAIRE files an aerodrome both in
// its own per-aerodrome document, with runways, and in the bundled
// ADHP_Restricted / ADHP_Temp lists, header only. The header-only copy
// must not win, whichever order they decode in.
func TestBuildAirportsPrefersRicherDuplicate(t *testing.T) {
	metres := func(m float64) *float64 { return &m }
	rich := aixm5.Airport{
		Designator: "LEMD", Type: "AD", Name: "MADRID",
		Runways: []aixm5.Runway{{Le: "14L", He: "32R", LengthM: metres(3500)}},
	}
	sparse := aixm5.Airport{Designator: "LEMD", Type: "AD", Name: "MADRID"}

	for _, order := range []struct {
		name string
		list []aixm5.Airport
	}{
		{"sparse first", []aixm5.Airport{sparse, rich}},
		{"rich first", []aixm5.Airport{rich, sparse}},
	} {
		msg := &aixm5.Message{Airports: order.list}
		art, meta, err := BuildAirports(msg, "test", nil, "", AirportsOptions{
			Country:         "ES",
			CountryFromIcao: IcaoCountry(map[string]string{"LE": "ES"}, "ES"),
			Now:             testNow,
			MinAirports:     1,
			MaxAirports:     10,
		})
		if err != nil {
			t.Fatalf("%s: %v", order.name, err)
		}
		if len(art.Rows) != 1 {
			t.Fatalf("%s: %d rows, want the duplicate collapsed to 1", order.name, len(art.Rows))
		}
		if meta.RunwayCount != 1 {
			t.Errorf("%s: RunwayCount = %d, want the richer record's 1", order.name, meta.RunwayCount)
		}
	}
}

// TestBuildAirportsMilitary covers the effective military flag: the
// decoder sets Airport.Military from a controlType of MILITARY or JOINT,
// and the builder additionally accepts the abbreviated MIL some
// publishers file. The meta counts what the row says.
func TestBuildAirportsMilitary(t *testing.T) {
	msg := &aixm5.Message{Airports: []aixm5.Airport{
		{Designator: "ETNS", Type: "AD", ControlType: "MIL"},
		{Designator: "EDDF", Type: "AD"},
		{Designator: "EDXX", Type: "AD", Military: true},
	}}
	art, meta, err := BuildAirports(msg, "test", nil, "", AirportsOptions{
		Country:         "DE",
		CountryFromIcao: IcaoCountry(map[string]string{"ED": "DE", "ET": "DE"}, "DE"),
		Now:             testNow,
		MinAirports:     1,
		MaxAirports:     10,
	})
	if err != nil {
		t.Fatal(err)
	}
	if meta.MilitaryCount != 2 {
		t.Errorf("MilitaryCount = %d, want 2 (the MIL controlType and the decoder-set flag)", meta.MilitaryCount)
	}
	// Column 11 is "military"; rows are sorted by ICAO, so EDDF is first.
	if got := art.Rows[0].([]any)[11].(bool); got {
		t.Error("EDDF should not be military")
	}
}

// TestBuildAirportsChartColumn covers the optional trailing column a
// publisher with aerodrome charts appends. Without it neither the column
// nor the chartFields key appears, which is what keeps the other
// publishers' documents unchanged.
func TestBuildAirportsChartColumn(t *testing.T) {
	msg := &aixm5.Message{Airports: []aixm5.Airport{{Designator: "EBAW", Type: "AD"}}}
	opts := AirportsOptions{
		Country:         "BE",
		CountryFromIcao: IcaoCountry(map[string]string{"EB": "BE"}, "BE"),
		Now:             testNow,
		MinAirports:     1,
		MaxAirports:     10,
	}

	plain, plainMeta, err := BuildAirports(msg, "test", nil, "", opts)
	if err != nil {
		t.Fatal(err)
	}
	if plain.ChartFields != nil {
		t.Error("chartFields should be absent without a chart map")
	}
	if n := len(plain.Rows[0].([]any)); n != len(airportsOutputFields) {
		t.Errorf("row width = %d, want %d", n, len(airportsOutputFields))
	}
	if plainMeta.ChartCount != 0 {
		t.Error("chartCount should stay zero without a chart map")
	}

	opts.Charts = map[string][]any{"EBAW": {[]string{"ADC", "Aerodrome chart", "https://example.test/adc.pdf"}}}
	opts.ChartFields = []string{"code", "title", "url"}
	withCharts, chartMeta, err := BuildAirports(msg, "test", nil, "", opts)
	if err != nil {
		t.Fatal(err)
	}
	if len(withCharts.ChartFields) != 3 {
		t.Errorf("chartFields = %v, want the three-column shape", withCharts.ChartFields)
	}
	row := withCharts.Rows[0].([]any)
	if n := len(row); n != len(airportsOutputFields)+1 {
		t.Fatalf("row width = %d, want one more than the base shape", n)
	}
	if got := len(row[len(row)-1].([]any)); got != 1 {
		t.Errorf("trailing charts cell holds %d entries, want 1", got)
	}
	if chartMeta.ChartCount != 1 {
		t.Errorf("ChartCount = %d, want 1", chartMeta.ChartCount)
	}
	if withCharts.Fields[len(withCharts.Fields)-1] != "charts" {
		t.Error("the charts column should be named in Fields")
	}
}
