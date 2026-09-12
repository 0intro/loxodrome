package main

import (
	"strings"
	"testing"
)

const sampleOFMX = `<?xml version="1.0" encoding="utf-8"?>
<OFMX-Snapshot version="0.1" effective="2026-08-13T12:33:32Z">
  <Ase>
    <AseUid mid="m-fir" region="LI"><codeType>FIR</codeType><codeId>LI6C8E8</codeId></AseUid>
    <txtName>MILANO</txtName><codeClass>G</codeClass>
    <codeDistVerUpper>STD</codeDistVerUpper><valDistVerUpper>195</valDistVerUpper><uomDistVerUpper>FL</uomDistVerUpper>
    <codeDistVerLower>HEI</codeDistVerLower><valDistVerLower>0</valDistVerLower><uomDistVerLower>FT</uomDistVerLower>
  </Ase>
  <Ase>
    <AseUid mid="m-p" region="LI"><codeType>P</codeType><codeId>LIP215</codeId></AseUid>
    <txtName>LI P215 - SALUZZO</txtName>
  </Ase>
  <Ase>
    <AseUid mid="m-park" region="LI"><codeType>P</codeType><codeId>LIPARK</codeId></AseUid>
    <txtName>PARCO NAZIONALE GRAN PARADISO</txtName>
    <codeDistVerUpper>HEI</codeDistVerUpper><valDistVerUpper>1600</valDistVerUpper><uomDistVerUpper>FT</uomDistVerUpper>
  </Ase>
  <Ase>
    <AseUid mid="m-nra" region="LI"><codeType>NRA</codeType><codeId>LINRA</codeId></AseUid>
    <txtName>SACRA DI SAN MICHELE</txtName>
  </Ase>
  <Ase>
    <AseUid mid="m-vas" region="LI"><codeType>VAS</codeType><codeId>LIVAS</codeId></AseUid>
    <txtName>VOLCANIC ASH CLOUD SECTOR C2</txtName>
  </Ase>
  <Ase>
    <AseUid mid="m-circle" region="LI"><codeType>D</codeType><codeId>LICIRC</codeId></AseUid>
    <txtName>ROUND DANGER</txtName>
  </Ase>
  <Abd>
    <AbdUid mid="b1"><AseUid mid="m-fir" region="LI"><codeType>FIR</codeType><codeId>LI6C8E8</codeId></AseUid></AbdUid>
    <Avx><codeType>GRC</codeType><geoLat>45.00000000N</geoLat><geoLong>007.00000000E</geoLong></Avx>
    <Avx><codeType>GRC</codeType><geoLat>45.10000000N</geoLat><geoLong>007.10000000E</geoLong></Avx>
    <Avx><codeType>FNT</codeType><GbrUid><txtName>FRANCE_ITALY</txtName></GbrUid><geoLat>45.20000000N</geoLat><geoLong>006.90000000E</geoLong></Avx>
  </Abd>
  <Abd>
    <AbdUid mid="b2"><AseUid mid="m-p" region="LI"><codeType>P</codeType><codeId>LIP215</codeId></AseUid></AbdUid>
    <Avx><codeType>GRC</codeType><geoLat>44.60000000N</geoLat><geoLong>007.40000000E</geoLong></Avx>
    <Avx><codeType>GRC</codeType><geoLat>44.70000000N</geoLat><geoLong>007.50000000E</geoLong></Avx>
    <Avx><codeType>GRC</codeType><geoLat>44.60000000N</geoLat><geoLong>007.60000000E</geoLong></Avx>
  </Abd>
  <Abd>
    <AbdUid mid="b3"><AseUid mid="m-park" region="LI"><codeType>P</codeType><codeId>LIPARK</codeId></AseUid></AbdUid>
    <Avx><codeType>GRC</codeType><geoLat>45.50000000N</geoLat><geoLong>007.20000000E</geoLong></Avx>
    <Avx><codeType>GRC</codeType><geoLat>45.60000000N</geoLat><geoLong>007.30000000E</geoLong></Avx>
    <Avx><codeType>GRC</codeType><geoLat>45.50000000N</geoLat><geoLong>007.40000000E</geoLong></Avx>
  </Abd>
  <Abd>
    <AbdUid mid="b4"><AseUid mid="m-nra" region="LI"><codeType>NRA</codeType><codeId>LINRA</codeId></AseUid></AbdUid>
    <Avx><codeType>GRC</codeType><geoLat>45.10000000N</geoLat><geoLong>007.30000000E</geoLong></Avx>
    <Avx><codeType>GRC</codeType><geoLat>45.20000000N</geoLat><geoLong>007.40000000E</geoLong></Avx>
    <Avx><codeType>GRC</codeType><geoLat>45.10000000N</geoLat><geoLong>007.50000000E</geoLong></Avx>
  </Abd>
  <Abd>
    <AbdUid mid="b5"><AseUid mid="m-circle" region="LI"><codeType>D</codeType><codeId>LICIRC</codeId></AseUid></AbdUid>
    <Avx><codeType>CWA</codeType><geoLat>45.76659938N</geoLat><geoLong>006.90000000E</geoLong>
      <geoLatArc>45.71666667N</geoLatArc><geoLongArc>006.90000000E</geoLongArc></Avx>
  </Abd>
  <Gbr>
    <GbrUid><txtName>FRANCE_ITALY</txtName></GbrUid>
    <Gbv><geoLat>45.20000000N</geoLat><geoLong>006.90000000E</geoLong></Gbv>
    <Gbv><geoLat>45.15000000N</geoLat><geoLong>006.95000000E</geoLong></Gbv>
    <Gbv><geoLat>45.00000000N</geoLat><geoLong>007.00000000E</geoLong></Gbv>
  </Gbr>
  <Ahp>
    <AhpUid mid="a1" region="LI"><codeId>LIMW</codeId></AhpUid>
    <txtName>AOSTA</txtName><codeType>AD</codeType>
    <geoLat>45.73833333N</geoLat><geoLong>007.36861111E</geoLong>
    <valElev>1791</valElev><uomDistVer>FT</uomDistVer>
  </Ahp>
  <Rwy>
    <RwyUid mid="r1"><AhpUid mid="a1" region="LI"><codeId>LIMW</codeId></AhpUid><txtDesig>09/27</txtDesig></RwyUid>
    <valLen>1500</valLen><valWid>30</valWid><uomDimRwy>M</uomDimRwy><codeComposition>ASPH</codeComposition>
  </Rwy>
  <Vor>
    <VorUid mid="v1" region="LI"><codeId>CSL</codeId><geoLat>45.21972222N</geoLat><geoLong>007.64955556E</geoLong></VorUid>
    <txtName>CASELLE</txtName><valFreq>116.75</valFreq><uomFreq>MHZ</uomFreq>
  </Vor>
  <Dme>
    <DmeUid mid="d1" region="LI"><codeId>CSL</codeId><geoLat>45.21972222N</geoLat><geoLong>007.64955556E</geoLong></DmeUid>
    <VorUid mid="v1" region="LI"><codeId>CSL</codeId></VorUid>
    <txtName>CASELLE</txtName>
  </Dme>
  <Ndb>
    <NdbUid mid="n1" region="LI"><codeId>SVC</codeId><geoLat>45.74527778N</geoLat><geoLong>007.71527778E</geoLong></NdbUid>
    <txtName>SAINT-VINCENT</txtName><valFreq>418</valFreq><uomFreq>KHZ</uomFreq>
  </Ndb>
  <Dpn>
    <DpnUid mid="p1" region="LI"><codeId>MMNW1=LA SALLE</codeId><geoLat>45.74555556N</geoLat><geoLong>007.07111111E</geoLong></DpnUid>
    <codeType>VFR-MRP</codeType><txtName>LA SALLE</txtName>
  </Dpn>
</OFMX-Snapshot>`

func decodeSample(t *testing.T) *Snapshot {
	t.Helper()
	snap, err := DecodeOFMX(strings.NewReader(sampleOFMX))
	if err != nil {
		t.Fatal(err)
	}
	return snap
}

func TestDecodeOFMXCoordinates(t *testing.T) {
	snap := decodeSample(t)
	if snap.Effective != "2026-08-13T12:33:32Z" {
		t.Errorf("effective = %q", snap.Effective)
	}
	if len(snap.Airspaces) != 6 {
		t.Fatalf("got %d airspaces", len(snap.Airspaces))
	}
	// OFMX writes decimal degrees with a hemisphere suffix.
	if len(snap.Airports) != 1 || snap.Airports[0].Lat < 45.73 || snap.Airports[0].Lat > 45.74 {
		t.Errorf("aerodrome position wrong: %+v", snap.Airports)
	}
	if len(snap.Airports[0].Runways) != 1 || snap.Airports[0].Runways[0].Designator != "09/27" {
		t.Errorf("runway not joined to its aerodrome: %+v", snap.Airports[0].Runways)
	}
}

// TestProhibitedVersusPark is the split that keeps 200 national parks
// from being drawn as prohibited airspace.
func TestProhibitedVersusPark(t *testing.T) {
	snap := decodeSample(t)
	var stats buildStats
	rows, nature := airspaceRows(snap, &stats)

	byID := map[string]string{}
	for _, r := range rows {
		byID[r.ID] = r.Type
	}
	if byID["LIP215"] != "P" {
		t.Errorf("a designated prohibited area must stay P, got %q", byID["LIP215"])
	}
	if _, drawn := byID["LIPARK"]; drawn {
		t.Error("a national park must not be drawn as airspace")
	}
	if _, drawn := byID["LINRA"]; drawn {
		t.Error("a nature reserve must not be drawn as airspace")
	}
	if len(nature) != 2 {
		t.Fatalf("got %d nature zones, want the park and the reserve", len(nature))
	}
	// The volcanic-ash contingency sector is not drawn either.
	if _, drawn := byID["LIVAS"]; drawn {
		t.Error("a volcanic-ash contingency sector must not be drawn")
	}
	if stats.skippedType != 1 {
		t.Errorf("skippedType = %d, want the ash sector counted", stats.skippedType)
	}
}

// TestCircleBoundary covers the AIXM full-circle idiom: one arc vertex
// about a centre. A quarter of Italy's boundaries are filed that way.
func TestCircleBoundary(t *testing.T) {
	snap := decodeSample(t)
	var stats buildStats
	rows, _ := airspaceRows(snap, &stats)
	var circle *int
	for i := range rows {
		if rows[i].ID == "LICIRC" {
			circle = &i
		}
	}
	if circle == nil {
		t.Fatal("the one-vertex circle produced no airspace")
	}
	ring := rows[*circle].Ring
	if len(ring) < 16 {
		t.Errorf("circle ring has %d points, want it tessellated", len(ring))
	}
	if stats.skippedNoGeo != 0 {
		t.Errorf("skippedNoGeo = %d, want 0", stats.skippedNoGeo)
	}
}

// TestBorderStitching covers the FNT leg: the Milano FIR follows the
// French frontier rather than cutting across the Alps.
func TestBorderStitching(t *testing.T) {
	snap := decodeSample(t)
	var stats buildStats
	rows, _ := airspaceRows(snap, &stats)
	if stats.borderStitched != 1 || stats.borderChords != 0 {
		t.Errorf("stitched %d / chords %d, want 1 / 0", stats.borderStitched, stats.borderChords)
	}
	for _, r := range rows {
		if r.ID != "LI6C8E8" {
			continue
		}
		// The border's intermediate vertex must appear in the ring.
		found := false
		for _, p := range r.Ring {
			if p[0] > 45.14 && p[0] < 45.16 {
				found = true
			}
		}
		if !found {
			t.Error("the FIR ring does not follow the border's intermediate vertex")
		}
		return
	}
	t.Fatal("no FIR row")
}

// TestNavaidComposites covers the co-located pair fold: a DME filed
// under a VOR's ident is that VOR's distance half, so one VOR-DME row
// comes out rather than two.
func TestNavaidComposites(t *testing.T) {
	snap := decodeSample(t)
	navs := navaidValues(snap)
	byIdent := map[string]string{}
	for _, n := range navs {
		byIdent[n.Designator] = n.Type
	}
	if byIdent["CSL"] != "VOR-DME" {
		t.Errorf("CSL = %q, want VOR-DME", byIdent["CSL"])
	}
	if n := len(navs); n != 3 {
		t.Errorf("got %d navaids, want the VOR-DME, the NDB and the reporting point", n)
	}
	if byIdent["SVC"] != "NDB" {
		t.Errorf("SVC = %q", byIdent["SVC"])
	}
	// Every Italian designated point is a VFR reporting point.
	if byIdent["MMNW1=LA SALLE"] != "VFR_REPORTING_POINT" {
		t.Errorf("designated point = %q", byIdent["MMNW1=LA SALLE"])
	}
	for _, n := range navs {
		if n.Designator == "SVC" {
			if n.FreqMHz == nil || *n.FreqMHz < 0.417 || *n.FreqMHz > 0.419 {
				t.Errorf("an NDB carrier filed in kHz should land as MHz: %v", n.FreqMHz)
			}
		}
	}
}

func TestVerticalTriple(t *testing.T) {
	cases := []struct {
		ref, val, uom string
		want          []string
	}{
		{"STD", "195", "FL", []string{"STD", "195", "FL"}},
		{"ALT", "5000", "FT", []string{"ALT", "5000", "FT"}},
		{"HEI", "0", "FT", []string{"HEI", "0", "FT"}},
		{"SFC", "", "", []string{"HEI", "0", "FT"}},
		{"UNL", "", "", []string{"UNL", "", ""}},
		{"", "", "", nil},
	}
	for _, c := range cases {
		got := verticalTriple(c.ref, c.val, c.uom)
		if len(got) != len(c.want) {
			t.Errorf("verticalTriple(%q,%q,%q) = %v, want %v", c.ref, c.val, c.uom, got, c.want)
			continue
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Errorf("verticalTriple(%q,%q,%q) = %v, want %v", c.ref, c.val, c.uom, got, c.want)
				break
			}
		}
	}
}
