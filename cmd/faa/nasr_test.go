package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"reflect"
	"strings"
	"testing"
)

// navBase is a NAV_BASE.csv cut down to the columns the navaids read, with
// the quoting the FAA's own file carries, and a byte order mark, which the
// 2026-09-03 edition does not carry but an export may: the reader strips
// one.
const navBase = "\ufeff\"EFF_DATE\",\"NAV_ID\",\"NAV_TYPE\",\"NAV_STATUS\",\"LAT_DECIMAL\",\"LONG_DECIMAL\",\"ELEV\",\"CHAN\",\"FREQ\"\n" +
	"\"2026/09/03\",\"LIT\",\"VORTAC\",\"OPERATIONAL RESTRICTED\",34.8101,-92.15206666,276,\"98X\",115.1\n" +
	"\"2026/09/03\",\"ADK\",\"NDB/DME\",\"OPERATIONAL IFR\",51.87,-176.67,328.9,\"87X\",530\n" +
	"\"2026/09/03\",\"EWR\",\"DME\",\"SHUTDOWN\",40.67434444,-74.17796666,9,\"84Y\",113.75\n" +
	"\"2026/09/03\",\"RAL\",\"VOR\",\"OPERATIONAL RESTRICTED\",33.95518055,-117.44982777,778,\"\",108.6\n" +
	"\"2026/09/03\",\"EWR\",\"FAN MARKER\",\"OPERATIONAL IFR\",40.703384,-74.18742252,9.5,\"\",\n" +
	"\"2026/09/03\",\"YRK\",\"TACAN\",\"OPERATIONAL IFR\",38.64413333,-82.97833888,1040,\"75X\",\n"

func TestParseNASRNavBase(t *testing.T) {
	ix, err := parseNASRNavBase([]byte(navBase))
	if err != nil {
		t.Fatal(err)
	}
	want := map[string][]nasrNavaid{
		"LIT": {{ident: "LIT", kind: "VORTAC", lat: 34.8101, lon: -92.15206666, freq: 115.1, channel: "098X", elevFt: 276}},
		"ADK": {{ident: "ADK", kind: "NDB/DME", lat: 51.87, lon: -176.67, freq: 530, channel: "087X", elevFt: 329}},
		"EWR": {
			{ident: "EWR", kind: "DME", lat: 40.67434444, lon: -74.17796666, freq: 113.75, channel: "084Y", elevFt: 9, shutdown: true},
			{ident: "EWR", kind: "FAN MARKER", lat: 40.703384, lon: -74.18742252, elevFt: 10},
		},
		"RAL": {{ident: "RAL", kind: "VOR", lat: 33.95518055, lon: -117.44982777, freq: 108.6, elevFt: 778}},
		"YRK": {{ident: "YRK", kind: "TACAN", lat: 38.64413333, lon: -82.97833888, channel: "075X", elevFt: 1040}},
	}
	if !reflect.DeepEqual(map[string][]nasrNavaid(ix), want) {
		t.Errorf("index =\n  %+v\nwant\n  %+v", ix, want)
	}
}

func TestNASRFromZip(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, name := range []string{"APT_BASE.csv", "NAV_BASE.csv"} {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if name == "NAV_BASE.csv" {
			_, _ = w.Write([]byte(navBase))
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	ix, digest, err := nasrFromZip(buf.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if n, ok := ix.match("VORTAC", "LIT", 34.8101, -92.1521); !ok || n.freq != 115.1 {
		t.Errorf("LIT = %+v, %v; want NASR's 115.1", n, ok)
	}
	if want := sha256.Sum256([]byte(navBase)); !bytes.Equal(digest, want[:]) {
		t.Errorf("digest = %x, want NAV_BASE.csv's %x", digest, want)
	}
}

// TestParseNASRNavBaseRefusesUnplacedRows: a register whose positions no
// longer read as decimal degrees is refused, not read as one listing
// nothing, which would match no station and write the 2016 components'
// frequencies under NASR's name.
func TestParseNASRNavBaseRefusesUnplacedRows(t *testing.T) {
	dms := strings.NewReplacer("34.8101,-92.15206666", "34-48-36.36N,092-09-07.44W").Replace(navBase)
	if _, err := parseNASRNavBase([]byte(dms)); err == nil {
		t.Error("a row in six with no decimal position read, want the register refused")
	}
	if _, err := parseNASRNavBase([]byte(strings.SplitN(navBase, "\n", 2)[0] + "\n")); err == nil {
		t.Error("a register with no row read, want it refused")
	}
}

// TestNASRMatchSiteAndKind: NASR's record is the navaid's only at its own
// site and under a kind its type is filed under. Past sameSiteNM, a
// station under the ident is another one (AP, HY and LA would take far US
// NDBs' carriers); a VOT under a VOR/DME's ident at its field (BOS, PVD,
// GON) is a test transmitter.
func TestNASRMatchSiteAndKind(t *testing.T) {
	ix := nasrIndex{
		"AP":  {{ident: "AP", kind: "NDB", lat: 40.0, lon: -100.0, freq: 206}},
		"BOS": {{ident: "BOS", kind: "VOT", lat: 42.3656, lon: -71.0096, freq: 111.0}},
	}
	// 2 NM north of the NDB.
	if n, ok := ix.match("NDB", "AP", 40.0333, -100.0); ok {
		t.Errorf("AP matched %+v 2 NM off, want no match", n)
	}
	if _, ok := ix.match("NDB", "AP", 40.005, -100.0); !ok {
		t.Error("AP at 0.3 NM did not match")
	}
	if n, ok := ix.match("VOR-DME", "BOS", 42.3650, -71.0090); ok {
		t.Errorf("BOS matched the VOT %+v, want no match", n)
	}
}

// TestBuildNavaidsNASR: NASR's register gives a radio navaid its frequency,
// channel and elevation where it lists the station at its point. Read off
// the components, frozen since 2016, Little Rock printed 113.900 / 086X
// where NASR says 115.1 / 98X. A station no longer in service is dropped,
// by the layer's own status (Ripley's NDB, CLOSED) or NASR's (Newark's DME,
// SHUTDOWN), and one NASR does not list keeps the component path (Durango,
// a Mexican station). A channel NASR states alone names the frequency it
// pairs with (York's TACAN, 75X). A closed station takes its own OTHER point with it
// rather than leaving it drawn as a waypoint (Cozad), and another
// register's copy of it stays a copy (Ripley's, no NAS_USE and no status).
func TestBuildNavaidsNASR(t *testing.T) {
	systems := geojson(
		pointFeature("-92.1521", "34.8101", `"GLOBAL_ID":"L1","IDENT":"LIT","NAME_TXT":"LITTLE ROCK","TYPE_CODE":8,"NAS_USE":1,"STATUS":"RESTRICTED"`),
		pointFeature("-176.67", "51.87", `"GLOBAL_ID":"A1","IDENT":"ADK","NAME_TXT":"MOUNT MOFFETT","TYPE_CODE":4,"NAS_USE":1,"STATUS":"IFR"`),
		pointFeature("-74.17797", "40.67434", `"GLOBAL_ID":"E1","IDENT":"EWR","NAME_TXT":"NEWARK","TYPE_CODE":5,"NAS_USE":1,"STATUS":"IFR"`),
		pointFeature("-89.64", "35.01", `"GLOBAL_ID":"X1","IDENT":"XCR","NAME_TXT":"RIPLEY","TYPE_CODE":3,"NAS_USE":0,"STATUS":"CLOSED"`),
		pointFeature("-89.64", "35.01", `"GLOBAL_ID":"X2","IDENT":"XCR","NAME_TXT":"RIPLEY","TYPE_CODE":3`),
		pointFeature("-100.00377", "40.87035", `"GLOBAL_ID":"O1","IDENT":"OZB","NAME_TXT":"COZAD","TYPE_CODE":7,"NAS_USE":1,"STATUS":"DECOMM"`),
		pointFeature("-104.51642", "24.13801", `"GLOBAL_ID":"D1","IDENT":"DGO","NAME_TXT":"DURANGO","TYPE_CODE":6,"CHANNEL":"076","COUNTRY":"Mexico"`),
		pointFeature("-82.97834", "38.64413", `"GLOBAL_ID":"Y1","IDENT":"YRK","NAME_TXT":"YORK","TYPE_CODE":9,"NAS_USE":1,"STATUS":"IFR"`),
	)
	components := geojson(
		pointFeature("-92.1521", "34.8101", `"GFID":"l1","IDENT_TXT":"LIT","SUBTYPE_CODE":3,"DATASOURCE_TXT":"NASR","FREQUENCY_VAL":113.9,"CHANNEL_TXT":"086X","ELEV_VAL":240`),
		pointFeature("-104.51643", "24.13801", `"GFID":"d1","IDENT_TXT":"DGO","SUBTYPE_CODE":3,"DATASOURCE_TXT":"ADDE","FREQUENCY_VAL":112.9,"CHANNEL_TXT":"076"`),
	)
	ix, err := parseNASRNavBase([]byte(navBase))
	if err != nil {
		t.Fatal(err)
	}
	points := geojson(
		pointFeature("-100.00377", "40.87035", `"GLOBAL_ID":"P1","IDENT":"OZB","TYPE_CODE":"OTHER","STATE":"NEBRASKA","REFFAC":"O1"`),
	)
	art, meta, err := BuildNavaids(systems, components, points, NavaidsOptions{
		Now: fixedNow, MinNavaids: 1, MaxNavaids: 100, NASR: ix, NASRSource: "NASR 2026-09-03 NAV_BASE.csv",
	})
	if err != nil {
		t.Fatal(err)
	}
	rows := navaidRows(t, art)
	for id, want := range map[string][3]any{
		"faa:VORTAC:LIT":  {"115.100", "098X", 276},
		"faa:NDB:ADK":     {"530", "087X", 329},
		"faa:VOR-DME:DGO": {"112.900", "076", nil},
		"faa:TACAN:YRK":   {"112.800", "075X", 1040},
	} {
		r, ok := rows[id]
		if !ok {
			t.Errorf("no row %s", id)
			continue
		}
		if got := [3]any{r[6], r[7], r[8]}; !reflect.DeepEqual(got, want) {
			t.Errorf("%s freq, channel, elev = %v, want %v", id, got, want)
		}
	}
	for _, gone := range []string{"faa:DME:EWR", "faa:NDB:XCR", "faa:VOR:OZB", "faa:WAYPOINT:OZB"} {
		if _, ok := rows[gone]; ok {
			t.Errorf("%s is drawn, no longer in service", gone)
		}
	}
	if meta.NASRMatched != 3 || meta.SkippedClosed != 3 || meta.NoFrequency != 0 || meta.NASRSource == "" {
		t.Errorf("NASRMatched = %d, SkippedClosed = %d, NoFrequency = %d, NASRSource = %q; want 3, 3, 0 and the edition",
			meta.NASRMatched, meta.SkippedClosed, meta.NoFrequency, meta.NASRSource)
	}
}

// TestBuildNavaidsNASRElevationFallback: a frequency or a channel stays
// NASR's even blank, a stale one from the 2016 components being a wrong
// one, but an elevation NASR leaves blank is the components' (the Canadian
// NDBs YCD and YOC lost theirs, 115 and 904 ft).
func TestBuildNavaidsNASRElevationFallback(t *testing.T) {
	systems := geojson(
		pointFeature("-139.84", "67.57", `"GLOBAL_ID":"Y1","IDENT":"YOC","NAME_TXT":"OLD CROW","TYPE_CODE":3,"NAS_USE":0`),
		pointFeature("-92.1521", "34.8101", `"GLOBAL_ID":"L1","IDENT":"LIT","NAME_TXT":"LITTLE ROCK","TYPE_CODE":8,"NAS_USE":1`),
	)
	components := geojson(
		pointFeature("-139.84", "67.57", `"GFID":"y1","IDENT_TXT":"YOC","SUBTYPE_CODE":1,"DATASOURCE_TXT":"NASR","FREQUENCY_VAL":284,"ELEV_VAL":904`),
		pointFeature("-92.1521", "34.8101", `"GFID":"l1","IDENT_TXT":"LIT","SUBTYPE_CODE":3,"DATASOURCE_TXT":"NASR","FREQUENCY_VAL":113.9,"CHANNEL_TXT":"086X","ELEV_VAL":240`),
	)
	ix, err := parseNASRNavBase([]byte(navBase + "\"2026/09/03\",\"YOC\",\"NDB\",\"OPERATIONAL IFR\",67.57,-139.84,,\"\",\n"))
	if err != nil {
		t.Fatal(err)
	}
	art, _, err := BuildNavaids(systems, components, geojson(), NavaidsOptions{
		Now: fixedNow, MinNavaids: 1, MaxNavaids: 100, NASR: ix, NASRSource: "NASR 2026-09-03 NAV_BASE.csv",
	})
	if err != nil {
		t.Fatal(err)
	}
	rows := navaidRows(t, art)
	for id, want := range map[string][3]any{
		"faa:NDB:YOC":    {"", "", 904},
		"faa:VORTAC:LIT": {"115.100", "098X", 276},
	} {
		if got := [3]any{rows[id][6], rows[id][7], rows[id][8]}; !reflect.DeepEqual(got, want) {
			t.Errorf("%s freq, channel, elev = %v, want %v", id, got, want)
		}
	}
}
