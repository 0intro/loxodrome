package eaip

import (
	"strconv"
	"testing"

	"github.com/0intro/loxodrome/internal/aixm5"
)

// Fintraffic's ENR 4.1, 2026-08-06, heads its columns with ICAO's
// abbreviations ("FREQ (CH)", "COORD"), so the header reader matches the
// stems rather than the words spelt out.
func TestParseNavaidTablesAbbreviatedHeaders(t *testing.T) {
	doc, err := ParseHTML([]byte(`<table>
<tr><td>Name of station (MAG VAR) (VOR DECL)</td><td>ID</td><td>FREQ (CH)</td><td>HR UTC</td><td>COORD</td><td>ELEV DME Antenna</td><td>RMK</td></tr>
<tr><td>1</td><td>2</td><td>3</td><td>4</td><td>5</td><td>6</td><td>7</td></tr>
<tr><td>ANTONI DME</td><td>ANT</td><td>113.700 MHZ (CH84X)</td><td>H24</td><td>605147N 0250737E</td><td>314 FT (96 M)</td><td>Service Volume Radius: 60 NM</td></tr>
</table>`))
	if err != nil {
		t.Fatal(err)
	}
	st := NewNavaidStats()
	got := ParseNavaidTables(doc, "FI", st)
	if len(got) != 1 || got[0].Designator != "ANT" || got[0].Type != "DME" {
		t.Fatalf("navaids = %+v (stats %+v)", got, st)
	}
	if got[0].Lat < 60.86 || got[0].Lat > 60.87 || got[0].Lon < 25.12 || got[0].Lon > 25.13 {
		t.Errorf("position = %v %v", got[0].Lat, got[0].Lon)
	}
	if got[0].Channel != "84X" {
		t.Errorf("channel = %q", got[0].Channel)
	}
}

// The call-sign cell runs the call sign into its languages and hours, and
// may give it twice, in either order.
func TestAtsCallSign(t *testing.T) {
	cases := []struct{ cell, unit, want string }{
		{"ŠTEFÁNIK RADAR SK, EN", "ŠTEFÁNIK APP", "ŠTEFÁNIK RADAR"},
		{"Dublin Control English H24", "ATS Dublin", "Dublin Control"},
		{"Pristina Approach ENG Mon -Sun: H24", "Pristina Approach", "Pristina Approach"},
		{"BUDAPEST CONTROL/RADAR EN H24", "BUDAPEST ACC", "BUDAPEST CONTROL"},
		{"BANJA LUKA APPROACH/ BANJA LUKA PRILAZNA KONTROLA BANJA LUKA TOWER/BANJA LUKA TORANJ English/ Bosnian",
			"BANJA LUKA APP", "BANJA LUKA APPROACH"},
		{"IVALON TORNI IVALO TOWER FI, EN H24", "IVALO ATS", "IVALO TOWER"},
		{"HELSINKI RADAR FI, EN H24", "HELSINKI-VANTAA ATS", "HELSINKI RADAR"},
		{"PIRKKALAN TUTKA PIRKKALA RADAR FI, EN", "TAMPERE-PIRKKALA ATS", "PIRKKALA RADAR"},
		{"KRUUNUN TORNI KRUUNU TOWER FI, EN", "KOKKOLA-PIETARSAARI ATS", "KRUUNU TOWER"},
		{"Reykjavík flugstjórn / Reykjavík Control English H24", "OAC Reykjavik", "Reykjavík Control"},
		{"Keflavík aðflug / Keflavik approach English/Icelandic H24", "ACC Reykjavík", "Keflavik approach"},
		{"Bodø Oceanic Control English", "Bodø OAC", "Bodø Oceanic Control"},
		{"PAPA APP EN", "PAPA APP", "PAPA APP"},
		// Nothing a pilot would call.
		{"English H24", "RIGA APP", ""},
		{"", "RIGA APP", ""},
		{"See AIP United Kingdom ENR 2.2 for the hours and the conditions of use of the radar", "Sumburgh", ""},
	}
	for _, c := range cases {
		if got := atsCallSign(c.cell, c.unit); got != c.want {
			t.Errorf("atsCallSign(%q, %q) = %q, want %q", c.cell, c.unit, got, c.want)
		}
	}
}

// ROMATSA prints a DME's own UHF frequency beside its channel
// ("1077.000MHz (53X)"). No VHF value is in it, and read from its middle
// it was "77.000 MHz"; the channel is what a pilot selects.
func TestNavaidFreqDMEUHF(t *testing.T) {
	for _, c := range []struct {
		cell, mhz, ch string
	}{
		{"1077.000MHz (53X)", "", "53X"},
		{"1145.000 MHz (CH 121X)", "", "121X"},
		{"109.000 MHz (CH 27X)", "109.000", "27X"},
		{"115.8MHZ 105X", "115.800", "105X"},
	} {
		var n aixm5.Navaid
		applyNavaidFreq(&n, c.cell)
		got := ""
		if n.FreqMHz != nil {
			got = strconv.FormatFloat(*n.FreqMHz, 'f', 3, 64)
		}
		if got != c.mhz || n.Channel != c.ch {
			t.Errorf("%q: %q MHz, channel %q; want %q, %q", c.cell, got, n.Channel, c.mhz, c.ch)
		}
	}
}

// ROMATSA's ENR 4.1 states the elevation unit in the header ("ELEV DME
// antenna (FT)") and a bare number in the cell, and files Iaşi's DME and
// NDB under one ident, which as the id alone made two rows one.
func TestParseNavaidTablesHeaderUnitAndSharedIdent(t *testing.T) {
	doc, err := ParseHTML([]byte(`<table>
<tr><td>Name of station (VOR/VAR)</td><td>ID</td><td>FREQ (CH)</td><td>Hours of operation</td><td>Coordinates</td><td>ELEV DME antenna (FT)</td><td>Remarks</td></tr>
<tr><td>1</td><td>2</td><td>3</td><td>4</td><td>5</td><td>6</td><td>7</td></tr>
<tr><td>IA&#350;I DME</td><td>ISI</td><td>1106.000MHz (82X)</td><td>H24</td><td>471404N 0273446E</td><td>1800</td><td>Coverage 100 NM</td></tr>
<tr><td>IA&#350;I NDB</td><td>ISI</td><td>351 kHz</td><td>H24</td><td>471403N 0273447E</td><td></td><td>Coverage 25 NM</td></tr>
<tr><td>ARAD DVOR/DME</td><td>ARD</td><td>109.000 MHz (CH 27X)</td><td>H24</td><td>461103N 0210837E</td><td>400</td><td>Coverage 175 NM</td></tr>
</table>`))
	if err != nil {
		t.Fatal(err)
	}
	got := ParseNavaidTables(doc, "RO", NewNavaidStats())
	if len(got) != 3 {
		t.Fatalf("navaids = %d, want 3", len(got))
	}
	for i, want := range []struct {
		id    string
		elevM float64
	}{{"ISI-DME", 1800 * 0.3048}, {"ISI-NDB", 0}, {"ARD", 400 * 0.3048}} {
		n := got[i]
		if n.ID != want.id {
			t.Errorf("%s: id %q, want %q: a shared ident takes its type, a lone one stays bare", n.Name, n.ID, want.id)
		}
		elev := 0.0
		if n.ElevM != nil {
			elev = *n.ElevM
		}
		if elev < want.elevM-0.01 || elev > want.elevM+0.01 {
			t.Errorf("%s: elevation %.2f m, want %.2f", n.Name, elev, want.elevM)
		}
	}
}

// A rule part-way down a tall remarks cell adds a grid row, and the name
// and position cells span it: one point, read once.
func TestParsePointTablesSpannedRow(t *testing.T) {
	doc, err := ParseHTML([]byte(`<table>
<tr><td>Name-code designator</td><td>Coordinates</td><td>ATS route or other route</td><td>Remarks</td></tr>
<tr><td rowspan="2">PELES</td><td rowspan="2">461302N 0270312E</td><td rowspan="2">T77</td><td>FRA (A): LRBC</td></tr>
<tr><td>FRA (D): LRBC</td></tr>
<tr><td>PILAT</td><td>444926N 0280552E</td><td>T4</td><td>NIL</td></tr>
</table>`))
	if err != nil {
		t.Fatal(err)
	}
	got := ParsePointTables(doc, NewNavaidStats())
	var ids []string
	for _, n := range got {
		ids = append(ids, n.ID)
	}
	if len(got) != 2 || ids[0] != "WPT:PELES" || ids[1] != "WPT:PILAT" {
		t.Errorf("points %v, want PELES and PILAT once each", ids)
	}
}
