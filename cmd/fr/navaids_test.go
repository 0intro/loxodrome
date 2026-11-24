package main

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

// TestBuildNavaidsILS pins the landing-aid decoding added to cmd/fr: an
// ILS-DME (glidepath + co-located DME), a LOC (localizer only), and a
// middle marker, alongside the folded VOR-DME.
func TestBuildNavaidsILS(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("testdata", "navaids", "sample.aixm.xml"))
	if err != nil {
		t.Fatal(err)
	}
	fixedNow := func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) }
	art, meta, err := BuildNavaids(src, NavaidsOptions{
		Source: "sample.aixm.xml", Now: fixedNow, MinNavaids: 1, MaxNavaids: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	if meta.Counts["ILS-DME"] != 1 || meta.Counts["LOC"] != 1 || meta.Counts["MKR"] != 1 {
		t.Fatalf("counts = %v, want one each of ILS-DME / LOC / MKR", meta.Counts)
	}
	// The VOR folds its DME; no standalone DME row.
	if meta.Counts["VOR-DME"] != 1 || meta.Counts["DME"] != 0 {
		t.Errorf("VOR-DME=%d DME=%d, want 1 / 0", meta.Counts["VOR-DME"], meta.Counts["DME"])
	}

	byType := map[string][]any{}
	for _, r := range art.Rows {
		row := r.([]any)
		byType[row[1].(string)] = row
	}
	// ILS-DME: keyed on the localizer ident, named by the served runway,
	// with the localizer frequency and position (not the glidepath).
	ils := byType["ILS-DME"]
	if ils[2] != "CN" {
		t.Errorf("ILS-DME ident = %v, want CN (localizer)", ils[2])
	}
	if ils[3] != "LFRK RWY 31" {
		t.Errorf("ILS-DME name = %v, want 'LFRK RWY 31'", ils[3])
	}
	if ils[6] != "109.90" {
		t.Errorf("ILS-DME freq = %v, want the localizer 109.90", ils[6])
	}
	// LOC: a localizer with no glidepath.
	if loc := byType["LOC"]; loc[2] != "DND" || loc[3] != "LFRD RWY 11" {
		t.Errorf("LOC = %v", loc)
	}
	// Marker: synthesized ident + descriptive name (its codeId is Morse).
	mkr := byType["MKR"]
	if mkr[2] != "LFRK-31-M" {
		t.Errorf("MKR ident = %v, want LFRK-31-M", mkr[2])
	}
	if mkr[3] != "LFRK RWY 31 middle marker" {
		t.Errorf("MKR name = %v", mkr[3])
	}
}

// TestBuildNavaidsVRP pins the designated points' two columns: a VFR
// reporting point carries its remark as published and its aerodrome, an
// ICAO waypoint carries neither, a point on an aerodrome is not emitted,
// and every row is as wide as the layout.
func TestBuildNavaidsVRP(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("testdata", "navaids", "sample.aixm.xml"))
	if err != nil {
		t.Fatal(err)
	}
	fixedNow := func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) }
	art, meta, err := BuildNavaids(src, NavaidsOptions{
		Source: "sample.aixm.xml", Now: fixedNow, MinNavaids: 1, MaxNavaids: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	byIdent := map[string][]any{}
	for _, r := range art.Rows {
		row := r.([]any)
		if len(row) != len(art.Fields) {
			t.Errorf("row %v: %d cells, want %d (the layout)", row[0], len(row), len(art.Fields))
		}
		byIdent[row[2].(string)] = row
	}
	if got := art.Fields[9:]; len(got) != 2 || got[0] != "rmk" || got[1] != "ad" {
		t.Errorf("fields[9:] = %v, want [rmk ad]", got)
	}
	vrp := byIdent["BIN"]
	if vrp == nil {
		t.Fatal("BIN: no row")
	}
	if vrp[1] != "VFR_REPORTING_POINT" || vrp[3] != "BI-N" {
		t.Errorf("BIN type, name = %v, %v; want VFR_REPORTING_POINT, BI-N", vrp[1], vrp[3])
	}
	if want := "VRP-Neuville de Poitou#\r\nMax ALT 2000 ft AMSL when IFR present."; vrp[9] != want {
		t.Errorf("BIN rmk = %q, want %q", vrp[9], want)
	}
	if vrp[10] != "LFBI" {
		t.Errorf("BIN ad = %v, want LFBI", vrp[10])
	}
	wpt := byIdent["ETAMP"]
	if wpt == nil {
		t.Fatal("ETAMP: no row")
	}
	if wpt[1] != "WAYPOINT" || wpt[3] != "" || wpt[9] != "" || wpt[10] != "" {
		t.Errorf("ETAMP = %v, want a WAYPOINT, no name, no rmk, no ad", wpt)
	}
	if byIdent["BI01"] != nil {
		t.Errorf("BI01: a point on an aerodrome was emitted: %v", byIdent["BI01"])
	}
	if cgn := byIdent["CGN"]; cgn[9] != "" || cgn[10] != "" {
		t.Errorf("CGN rmk, ad = %q, %q; want empty", cgn[9], cgn[10])
	}
	if meta.WithRemark != 1 || meta.WithAerodrome != 1 {
		t.Errorf("withRemark, withAerodrome = %d, %d; want 1, 1", meta.WithRemark, meta.WithAerodrome)
	}
}

// TestBuildNavaidsDmePairedByVorMid: the export files two VORs coded BNE,
// BOULOGNE on 113.8 with no DME and the Antilles one on 112.4, whose DME
// (channel 71X) names it by mid in its VorUid. Paired by codeId, BOULOGNE
// shipped as a VOR-DME on 71X. A DME whose VorUid names no VOR in the
// export ships as a DME of its own.
func TestBuildNavaidsDmePairedByVorMid(t *testing.T) {
	const src = `<?xml version="1.0" encoding="UTF-8"?>
<AIXM-Snapshot version="4.5" effective="2026-10-29T00:00:00.000+01:00">
  <Vor><VorUid mid="1526877"><codeId>BNE</codeId><geoLat>503729.24N</geoLat><geoLong>0015425.56E</geoLong></VorUid>
    <txtName>BOULOGNE</txtName><valFreq>113.8</valFreq><uomFreq>MHZ</uomFreq></Vor>
  <Vor><VorUid mid="1526934"><codeId>BNE</codeId><geoLat>134400.10N</geoLat><geoLong>0605837.40W</geoLong></VorUid>
    <valFreq>112.4</valFreq><uomFreq>MHZ</uomFreq></Vor>
  <Dme><DmeUid mid="1527453"><codeId>BNE</codeId><geoLat>134400.10N</geoLat><geoLong>0605837.40W</geoLong></DmeUid>
    <VorUid mid="1526934"><codeId>BNE</codeId><geoLat>134400.10N</geoLat><geoLong>0605837.40W</geoLong></VorUid>
    <codeChannel>71X</codeChannel><valGhostFreq>112.4</valGhostFreq><uomGhostFreq>MHZ</uomGhostFreq></Dme>
  <Dme><DmeUid mid="3"><codeId>XYZ</codeId><geoLat>480000.00N</geoLat><geoLong>0020000.00E</geoLong></DmeUid>
    <VorUid mid="4"><codeId>XYZ</codeId></VorUid>
    <codeChannel>100X</codeChannel><valGhostFreq>115.3</valGhostFreq><uomGhostFreq>MHZ</uomGhostFreq></Dme>
</AIXM-Snapshot>`
	art, meta, err := BuildNavaids([]byte(src), NavaidsOptions{
		Source: "bne.aixm.xml", MinNavaids: 1, MaxNavaids: 10,
		Now: func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) },
	})
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string][]any{}
	for _, r := range art.Rows {
		row := r.([]any)
		byID[row[0].(string)] = row
	}
	if row := byID["VOR:1526877"]; row == nil || row[1] != "VOR" || row[6] != "113.8" || row[7] != "" {
		t.Errorf("BOULOGNE = %v, want a VOR on 113.8 with no channel", row)
	}
	if row := byID["VOR-DME:1526934"]; row == nil || row[6] != "112.4" || row[7] != "71X" {
		t.Errorf("BNE 112.4 = %v, want a VOR-DME on 71X", row)
	}
	if row := byID["DME:3"]; row == nil || row[7] != "100X" {
		t.Errorf("XYZ = %v, want a DME of its own on 100X", row)
	}
	if want := map[string]int{"VOR": 1, "VOR-DME": 1, "DME": 1}; !reflect.DeepEqual(meta.Counts, want) {
		t.Errorf("Counts = %v, want %v", meta.Counts, want)
	}
}

// TestBuildNavaidsZeroFrequency: the SIA files 0 as the frequency of
// eight foreign stations, among them NDB SLU GEORGE F. CHARLES and VOR VLI
// PORT VILA. Shipped as "0", the app printed it as 0 kHz or 0.000 MHz. A
// zero ships as the empty frequency, and a real one as filed.
func TestBuildNavaidsZeroFrequency(t *testing.T) {
	const src = `<?xml version="1.0" encoding="UTF-8"?>
<AIXM-Snapshot version="4.5" effective="2026-10-29T00:00:00.000+01:00">
  <Ndb><NdbUid mid="1524031"><codeId>SLU</codeId><geoLat>140050.90N</geoLat><geoLong>0610021.80W</geoLong></NdbUid>
    <txtName>GEORGE F. CHARLES</txtName><valFreq>0</valFreq><uomFreq>MHZ</uomFreq></Ndb>
  <Vor><VorUid mid="1526949"><codeId>VLI</codeId><geoLat>173943.74S</geoLat><geoLong>1681438.15E</geoLong></VorUid>
    <txtName>PORT VILA</txtName><codeType>VOR</codeType><valFreq>0</valFreq><uomFreq>MHZ</uomFreq></Vor>
  <Vor><VorUid mid="1526877"><codeId>BNE</codeId><geoLat>503729.24N</geoLat><geoLong>0015425.56E</geoLong></VorUid>
    <txtName>BOULOGNE</txtName><valFreq>113.8</valFreq><uomFreq>MHZ</uomFreq></Vor>
</AIXM-Snapshot>`
	art, _, err := BuildNavaids([]byte(src), NavaidsOptions{
		Source: "zero.aixm.xml", MinNavaids: 1, MaxNavaids: 10,
		Now: func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) },
	})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"NDB:1524031": "", "VOR:1526949": "", "VOR:1526877": "113.8"}
	for _, r := range art.Rows {
		row := r.([]any)
		id := row[0].(string)
		if f, ok := want[id]; !ok {
			t.Errorf("unexpected row %v", row)
		} else if row[6] != f {
			t.Errorf("%s freq = %q, want %q", id, row[6], f)
		}
		delete(want, id)
	}
	for id := range want {
		t.Errorf("no row %s", id)
	}
}

// TestBuildNavaidsDecimalDegrees: since its BMJ 02/2026 the SIA files some
// VOR, DME and ICAO point coordinates in decimal degrees, PASSEIRY VOR PAS
// among them, which a parser of DMS alone dropped from fr-navaids with its
// DME. They ship, PAS as the VOR-DME it is.
func TestBuildNavaidsDecimalDegrees(t *testing.T) {
	const src = `<?xml version="1.0" encoding="UTF-8"?>
<AIXM-Snapshot version="4.5" effective="2026-10-29T00:00:00.000+01:00">
  <Vor><VorUid mid="1527099"><codeId>PAS</codeId><geoLat>46.16371667N</geoLat><geoLong>005.99990561E</geoLong></VorUid>
    <txtName>PASSEIRY</txtName><codeType>VOR</codeType><valFreq>116.6</valFreq><uomFreq>MHZ</uomFreq></Vor>
  <Dme><DmeUid mid="1527390"><codeId>PAS</codeId><geoLat>46.16371667N</geoLat><geoLong>005.99990562E</geoLong></DmeUid>
    <VorUid mid="1527099"><codeId>PAS</codeId><geoLat>46.16371667N</geoLat><geoLong>005.99990561E</geoLong></VorUid>
    <codeChannel>113X</codeChannel><valGhostFreq>116.6</valGhostFreq><uomGhostFreq>MHZ</uomGhostFreq></Dme>
  <Dpn><DpnUid mid="1538353"><codeId>LUPEN</codeId><geoLat>48.43505278N</geoLat><geoLong>007.73362222E</geoLong></DpnUid>
    <codeType>ICAO</codeType><txtName>LUPEN</txtName></Dpn>
</AIXM-Snapshot>`
	art, _, err := BuildNavaids([]byte(src), NavaidsOptions{
		Source: "decimal.aixm.xml", MinNavaids: 1, MaxNavaids: 10,
		Now: func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) },
	})
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string][]any{}
	for _, r := range art.Rows {
		row := r.([]any)
		byID[row[0].(string)] = row
	}
	if row := byID["VOR-DME:1527099"]; row == nil || row[4] != 46.16372 || row[5] != 5.99991 || row[7] != "113X" {
		t.Errorf("PAS = %v, want a VOR-DME at 46.16372 5.99991 on 113X", row)
	}
	if row := byID["WPT:1538353"]; row == nil || row[4] != 48.43505 || row[5] != 7.73362 {
		t.Errorf("LUPEN = %v, want a waypoint at 48.43505 7.73362", row)
	}
	if len(art.Rows) != 2 {
		t.Errorf("rows = %v, want PAS and LUPEN", art.Rows)
	}
}
