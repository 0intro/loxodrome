package main

import (
	"testing"
	"time"
)

// A minimal XML_SIA fixture: a Situation wrapper (for effDate), one PRN polygon,
// one SUR circle, a TMA Espace that must be ignored, and a PRN Partie whose
// Contour does not parse (counted into skippedNoGeo, not emitted).
const sampleNatureSIA = `<?xml version="1.0" encoding="UTF-8"?>
<SiaExport Date="2026-03-23T19:16:46.480+01:00" Origine="Sia-France" Version="5">
 <Situation pubDate="2026-04-02" effDate="2026-05-14">
  <Espace pk="1" lk="[LF][PRN 9]"><TypeEspace>PRN</TypeEspace></Espace>
  <Espace pk="2" lk="[LF][SUR 5]"><TypeEspace>SUR</TypeEspace></Espace>
  <Espace pk="3" lk="[LF][TMA TEST]"><TypeEspace>TMA</TypeEspace></Espace>
  <Partie pk="10" lk="[LF][PRN 9][.]"><Espace/><NomUsuel>PARC NATIONAL TEST</NomUsuel><Contour>1000010,Cloture=1,48.0 2.0,grc(48.0 2.0:0m:=)
1000020,Cloture=2,48.0 2.1,grc(48.0 2.1:0m:=)
1000030,Cloture=3,48.1 2.1,grc(48.1 2.1:0m:=)
1000040,Cloture=4,48.1 2.0,grc(48.1 2.0:0m:=)</Contour><Geometrie/></Partie>
  <Partie pk="11" lk="[LF][SUR 5][.]"><Espace/><NomUsuel>CENTRALE TEST</NomUsuel><Contour>1000010,Cloture=9,45.0 1.0,cir(45.0 1.0:1.0:NM:0m:=)</Contour><Geometrie/></Partie>
  <Partie pk="12" lk="[LF][PRN 9][2]"><Espace/><NomUsuel>PARC SANS CONTOUR</NomUsuel><Contour>illisible</Contour><Geometrie/></Partie>
  <Volume pk="20" lk="[LF][PRN 9][.][1]"><Partie/><PlafondRefUnite>ft ASFC</PlafondRefUnite><Plafond>1000</Plafond><PlancherRefUnite>SFC</PlancherRefUnite><Plancher>0</Plancher></Volume>
  <Volume pk="21" lk="[LF][SUR 5][.][1]"><Partie/><PlafondRefUnite>ft ASFC</PlafondRefUnite><Plafond>3300</Plafond><PlancherRefUnite>SFC</PlancherRefUnite><Plancher>0</Plancher></Volume>
 </Situation>
</SiaExport>`

func TestBuildNature(t *testing.T) {
	art, meta, err := BuildNature([]byte(sampleNatureSIA), NatureOptions{
		Source:   "sample.sia.xml",
		Now:      func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) },
		MinZones: 1,
		MaxZones: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	if meta.Effective != "2026-05-14" {
		t.Errorf("effective = %q, want 2026-05-14", meta.Effective)
	}
	if meta.ZoneCount != 2 {
		t.Fatalf("zoneCount = %d, want 2 (PRN + SUR; TMA ignored)", meta.ZoneCount)
	}
	if meta.Counts["NATURE"] != 1 || meta.Counts["SENSITIVE"] != 1 {
		t.Errorf("counts = %v, want NATURE:1 SENSITIVE:1", meta.Counts)
	}
	if meta.SkippedNoGeo != 1 {
		t.Errorf("skippedNoGeo = %d, want 1 (the unparseable Contour)", meta.SkippedNoGeo)
	}

	rowByType := map[string][]any{}
	for _, r := range art.Rows {
		row := r.([]any)
		rowByType[row[1].(string)] = row
	}

	// Fields: id, type, name, lat, lon, minAlt, minAltRef.
	nat := rowByType["NATURE"]
	if nat == nil {
		t.Fatal("no NATURE row")
	}
	if nat[0] != "LF-PRN-9" {
		t.Errorf("NATURE id = %v, want LF-PRN-9", nat[0])
	}
	if nat[2] != "PARC NATIONAL TEST" {
		t.Errorf("NATURE name = %v", nat[2])
	}
	if lat := nat[3].(float64); lat < 48.0499 || lat > 48.0501 {
		t.Errorf("NATURE lat = %v, want ~48.05 (polygon centroid)", lat)
	}
	if lon := nat[4].(float64); lon < 2.0499 || lon > 2.0501 {
		t.Errorf("NATURE lon = %v, want ~2.05", lon)
	}
	if nat[5] != 1000 || nat[6] != "AGL" {
		t.Errorf("NATURE minAlt/ref = %v/%v, want 1000/AGL", nat[5], nat[6])
	}

	sen := rowByType["SENSITIVE"]
	if sen == nil {
		t.Fatal("no SENSITIVE row")
	}
	if sen[0] != "LF-SUR-5" || sen[2] != "CENTRALE TEST" {
		t.Errorf("SENSITIVE id/name = %v/%v", sen[0], sen[2])
	}
	if lat := sen[3].(float64); lat < 44.9999 || lat > 45.0001 {
		t.Errorf("SENSITIVE lat = %v, want 45.0 (single point)", lat)
	}
	if sen[5] != 3300 || sen[6] != "AGL" {
		t.Errorf("SENSITIVE minAlt/ref = %v/%v, want 3300/AGL", sen[5], sen[6])
	}
}

func TestContourCentroid(t *testing.T) {
	lat, lon, ok := contourCentroid("1,C,48 2,grc(48 2:0m:=)\n2,C,48 4,grc(48 4:0m:=)")
	if !ok || lat != 48 || lon != 3 {
		t.Errorf("centroid = (%v, %v) ok=%v, want (48, 3)", lat, lon, ok)
	}
	if _, _, ok := contourCentroid(""); ok {
		t.Error("empty contour should yield ok=false")
	}
}

func TestMinAltFromSIA(t *testing.T) {
	cases := []struct {
		ref, val string
		alt      int
		code     string
	}{
		{"ft ASFC", "1000", 1000, "AGL"},
		{"ft AGL", "500", 500, "AGL"},
		{"ft AMSL", "2500", 2500, "AMSL"},
		{"FL", "115", 115, "FL"},
		{"SFC", "0", 0, "SFC"},
		// An unlimited plafond is an explicit marker, not a silent 0.
		{"UNL", "", 0, "UNL"},
		{"", "UNL", 0, "UNL"},
	}
	for _, c := range cases {
		alt, code := minAltFromSIA(c.ref, c.val)
		if alt != c.alt || code != c.code {
			t.Errorf("minAltFromSIA(%q, %q) = (%d, %q), want (%d, %q)", c.ref, c.val, alt, code, c.alt, c.code)
		}
	}
}

func TestNatureID(t *testing.T) {
	if got := natureID("[LF][PRN 020][.]"); got != "LF-PRN-020" {
		t.Errorf("natureID = %q, want LF-PRN-020", got)
	}
}

func TestStripLastBracket(t *testing.T) {
	cases := []struct{ in, want string }{
		{"[LF][PRN 22][.]", "[LF][PRN 22]"},
		{"[LF][PRN 22]", "[LF]"},
		{"no-brackets", "no-brackets"},
	}
	for _, c := range cases {
		if got := stripLastBracket(c.in); got != c.want {
			t.Errorf("stripLastBracket(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
