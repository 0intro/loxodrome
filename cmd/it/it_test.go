package main

import (
	"reflect"
	"sort"
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
	navs, _ := navaidValues(snap)
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

// TestDpnFarFromAerodrome covers a reporting point filed twice under one
// id: open flightmaps carries LNNE1=BINAGO at Varese and again at 16.51E,
// in the Balkans, both copies associated with LILN. A point more than
// dpnMaxFromAerodromeNM from the aerodrome it is filed under is dropped and
// counted; of two copies of one id both near their aerodrome, the nearer
// stays; a point filed under no aerodrome is kept as it is.
func TestDpnFarFromAerodrome(t *testing.T) {
	const src = `<?xml version="1.0" encoding="utf-8"?>
<OFMX-Snapshot version="0.1" effective="2026-09-05T20:46:26Z">
  <Ahp>
    <AhpUid mid="a-liln" region="LI"><codeId>LILN</codeId></AhpUid>
    <txtName>VARESE VENEGONO</txtName><codeType>AD</codeType>
    <geoLat>45.74222222N</geoLat><geoLong>008.88861111E</geoLong>
  </Ahp>
  <Dpn>
    <DpnUid mid="p1" region="LI"><codeId>LNNE1=BINAGO</codeId><geoLat>45.78000000N</geoLat><geoLong>008.92333333E</geoLong></DpnUid>
    <AhpUidAssoc mid="a-liln" region="LI"><codeId>LILN</codeId></AhpUidAssoc>
    <codeType>VFR-MRP</codeType><txtName>BINAGO</txtName>
  </Dpn>
  <Dpn>
    <DpnUid mid="p2" region="LI"><codeId>LNNE1=BINAGO</codeId><geoLat>45.78000000N</geoLat><geoLong>016.50666667E</geoLong></DpnUid>
    <AhpUidAssoc mid="a-liln" region="LI"><codeId>LILN</codeId></AhpUidAssoc>
    <codeType>VFR-MRP</codeType><txtName>BINAGO</txtName>
  </Dpn>
  <Dpn>
    <DpnUid mid="p3" region="LI"><codeId>LNNE2=TWICE</codeId><geoLat>45.90000000N</geoLat><geoLong>008.90000000E</geoLong></DpnUid>
    <AhpUidAssoc mid="a-liln" region="LI"><codeId>LILN</codeId></AhpUidAssoc>
    <codeType>VFR-RP</codeType><txtName>TWICE</txtName>
  </Dpn>
  <Dpn>
    <DpnUid mid="p4" region="LI"><codeId>LNNE2=TWICE</codeId><geoLat>45.80000000N</geoLat><geoLong>008.90000000E</geoLong></DpnUid>
    <AhpUidAssoc mid="a-liln" region="LI"><codeId>LILN</codeId></AhpUidAssoc>
    <codeType>VFR-RP</codeType><txtName>TWICE</txtName>
  </Dpn>
  <Dpn>
    <DpnUid mid="p5" region="LI"><codeId>ENR=LONER</codeId><geoLat>44.00000000N</geoLat><geoLong>012.00000000E</geoLong></DpnUid>
    <codeType>VFR-ENR</codeType><txtName>LONER</txtName>
  </Dpn>
</OFMX-Snapshot>`
	snap, err := DecodeOFMX(strings.NewReader(src))
	if err != nil {
		t.Fatal(err)
	}
	navs, drops := navaidValues(snap)
	if drops.far != 1 || drops.farther != 1 {
		t.Errorf("skipped far = %d, farther = %d; want 1 (BINAGO's Balkan copy) and 1 (TWICE's farther copy)", drops.far, drops.farther)
	}
	got := map[string][2]float64{}
	count := map[string]int{}
	for _, n := range navs {
		got[n.Designator] = [2]float64{n.Lat, n.Lon}
		count[n.Designator]++
	}
	for ident, want := range map[string][2]float64{
		"LNNE1=BINAGO": {45.78, 8.92333333},
		"LNNE2=TWICE":  {45.8, 8.9},
		"ENR=LONER":    {44, 12},
	} {
		if count[ident] != 1 || got[ident] != want {
			t.Errorf("%s: %d rows at %v, want one at %v", ident, count[ident], got[ident], want)
		}
	}
}

// TestDpnTieAndMidless: of two copies of one id at exactly the same
// distance from their aerodrome, the southernmost then westernmost stays,
// whatever the file order (the nearer-stays rule kept the first met). And
// an aerodrome filed with no mid is nobody's: indexed under "", every
// en-route point, filed under no aerodrome, was measured against it and
// dropped as far from it.
func TestDpnTieAndMidless(t *testing.T) {
	east := `<Dpn>
    <DpnUid mid="e" region="LI"><codeId>LNNE3=EVEN</codeId><geoLat>45.75000000N</geoLat><geoLong>009.50000000E</geoLong></DpnUid>
    <AhpUidAssoc mid="a-lixx" region="LI"><codeId>LIXX</codeId></AhpUidAssoc>
    <codeType>VFR-RP</codeType><txtName>EVEN</txtName>
  </Dpn>`
	west := strings.Replace(strings.Replace(east, `mid="e"`, `mid="w"`, 1), "009.50000000E", "008.50000000E", 1)
	for _, order := range [][2]string{{east, west}, {west, east}} {
		src := `<?xml version="1.0" encoding="utf-8"?>
<OFMX-Snapshot version="0.1" effective="2026-09-05T20:46:26Z">
  <Ahp>
    <AhpUid mid="a-lixx" region="LI"><codeId>LIXX</codeId></AhpUid>
    <txtName>SOMEWHERE</txtName><codeType>AD</codeType>
    <geoLat>45.75000000N</geoLat><geoLong>009.00000000E</geoLong>
  </Ahp>
  <Ahp>
    <AhpUid region="LI"><codeId>LINO</codeId></AhpUid>
    <txtName>NO MID</txtName><codeType>AD</codeType>
    <geoLat>38.00000000N</geoLat><geoLong>015.00000000E</geoLong>
  </Ahp>
  ` + order[0] + `
  ` + order[1] + `
  <Dpn>
    <DpnUid mid="p5" region="LI"><codeId>ENR=LONER</codeId><geoLat>45.00000000N</geoLat><geoLong>007.00000000E</geoLong></DpnUid>
    <codeType>VFR-ENR</codeType><txtName>LONER</txtName>
  </Dpn>
</OFMX-Snapshot>`
		snap, err := DecodeOFMX(strings.NewReader(src))
		if err != nil {
			t.Fatal(err)
		}
		navs, _ := navaidValues(snap)
		got := map[string][][2]float64{}
		for _, n := range navs {
			got[n.Designator] = append(got[n.Designator], [2]float64{n.Lat, n.Lon})
		}
		if want := [][2]float64{{45.75, 8.5}}; !reflect.DeepEqual(got["LNNE3=EVEN"], want) {
			t.Errorf("EVEN = %v, want the western copy alone, %v", got["LNNE3=EVEN"], want)
		}
		if want := [][2]float64{{45, 7}}; !reflect.DeepEqual(got["ENR=LONER"], want) {
			t.Errorf("LONER = %v, want it kept, %v", got["ENR=LONER"], want)
		}
	}
}

// TestDpnFarFromAWrongAerodrome: a point far from the aerodrome it is
// filed under is dropped when that aerodrome has a point near it (the far
// copy of BINAGO, a longitude typed wrong). One whose own position is wrong
// has none, and dropping by distance lost every correct point filed under
// it: its points stay when they agree among themselves. A lone far point,
// or scattered ones, cannot say which position is wrong, and go.
func TestDpnFarFromAWrongAerodrome(t *testing.T) {
	src := `<?xml version="1.0" encoding="utf-8"?>
<OFMX-Snapshot version="0.1" effective="2026-09-05T20:46:26Z">
  <Ahp>
    <AhpUid mid="a-wrong" region="LI"><codeId>LIWR</codeId></AhpUid>
    <txtName>WRONG POSITION</txtName><codeType>AD</codeType>
    <geoLat>38.00000000N</geoLat><geoLong>015.00000000E</geoLong>
  </Ahp>
  <Ahp>
    <AhpUid mid="a-ok" region="LI"><codeId>LIOK</codeId></AhpUid>
    <txtName>RIGHT POSITION</txtName><codeType>AD</codeType>
    <geoLat>45.50000000N</geoLat><geoLong>009.00000000E</geoLong>
  </Ahp>
  <Dpn>
    <DpnUid mid="w1" region="LI"><codeId>LIWR1=ALFA</codeId><geoLat>45.60000000N</geoLat><geoLong>009.10000000E</geoLong></DpnUid>
    <AhpUidAssoc mid="a-wrong" region="LI"><codeId>LIWR</codeId></AhpUidAssoc>
    <codeType>VFR-RP</codeType><txtName>ALFA</txtName>
  </Dpn>
  <Dpn>
    <DpnUid mid="w2" region="LI"><codeId>LIWR2=BRAVO</codeId><geoLat>45.40000000N</geoLat><geoLong>008.90000000E</geoLong></DpnUid>
    <AhpUidAssoc mid="a-wrong" region="LI"><codeId>LIWR</codeId></AhpUidAssoc>
    <codeType>VFR-RP</codeType><txtName>BRAVO</txtName>
  </Dpn>
  <Dpn>
    <DpnUid mid="o1" region="LI"><codeId>LIOK1=NEAR</codeId><geoLat>45.60000000N</geoLat><geoLong>009.10000000E</geoLong></DpnUid>
    <AhpUidAssoc mid="a-ok" region="LI"><codeId>LIOK</codeId></AhpUidAssoc>
    <codeType>VFR-RP</codeType><txtName>NEAR</txtName>
  </Dpn>
  <Dpn>
    <DpnUid mid="o2" region="LI"><codeId>LIOK2=STRAY</codeId><geoLat>45.60000000N</geoLat><geoLong>016.50000000E</geoLong></DpnUid>
    <AhpUidAssoc mid="a-ok" region="LI"><codeId>LIOK</codeId></AhpUidAssoc>
    <codeType>VFR-RP</codeType><txtName>STRAY</txtName>
  </Dpn>
  <Ahp>
    <AhpUid mid="a-lone" region="LI"><codeId>LILN</codeId></AhpUid>
    <txtName>LONE POINT</txtName><codeType>AD</codeType>
    <geoLat>44.00000000N</geoLat><geoLong>011.00000000E</geoLong>
  </Ahp>
  <Dpn>
    <DpnUid mid="l1" region="LI"><codeId>LILN1=TYPO</codeId><geoLat>44.00000000N</geoLat><geoLong>017.00000000E</geoLong></DpnUid>
    <AhpUidAssoc mid="a-lone" region="LI"><codeId>LILN</codeId></AhpUidAssoc>
    <codeType>VFR-RP</codeType><txtName>TYPO</txtName>
  </Dpn>
  <Ahp>
    <AhpUid mid="a-spread" region="LI"><codeId>LISP</codeId></AhpUid>
    <txtName>SCATTERED POINTS</txtName><codeType>AD</codeType>
    <geoLat>41.00000000N</geoLat><geoLong>013.00000000E</geoLong>
  </Ahp>
  <Dpn>
    <DpnUid mid="s1" region="LI"><codeId>LISP1=EAST</codeId><geoLat>44.00000000N</geoLat><geoLong>017.50000000E</geoLong></DpnUid>
    <AhpUidAssoc mid="a-spread" region="LI"><codeId>LISP</codeId></AhpUidAssoc>
    <codeType>VFR-RP</codeType><txtName>EAST</txtName>
  </Dpn>
  <Dpn>
    <DpnUid mid="s2" region="LI"><codeId>LISP2=WEST</codeId><geoLat>44.00000000N</geoLat><geoLong>007.50000000E</geoLong></DpnUid>
    <AhpUidAssoc mid="a-spread" region="LI"><codeId>LISP</codeId></AhpUidAssoc>
    <codeType>VFR-RP</codeType><txtName>WEST</txtName>
  </Dpn>
</OFMX-Snapshot>`
	snap, err := DecodeOFMX(strings.NewReader(src))
	if err != nil {
		t.Fatal(err)
	}
	navs, drops := navaidValues(snap)
	var got []string
	for _, n := range navs {
		got = append(got, n.Designator)
	}
	sort.Strings(got)
	if want := []string{"LIOK1=NEAR", "LIWR1=ALFA", "LIWR2=BRAVO"}; !reflect.DeepEqual(got, want) {
		t.Errorf("points = %v, want %v", got, want)
	}
	if drops.far != 4 {
		t.Errorf("far = %d, want 4 (LIOK's stray copy, LILN's lone point, LISP's two scattered ones)", drops.far)
	}
}

// TestDpnSamePositionByContent: two copies of one point at one position
// are told apart by their content, never by the file's order.
func TestDpnSamePositionByContent(t *testing.T) {
	a := `<Dpn>
    <DpnUid mid="x1" region="LI"><codeId>LNNE3=TWIN</codeId><geoLat>45.75000000N</geoLat><geoLong>009.50000000E</geoLong></DpnUid>
    <AhpUidAssoc mid="a-lixx" region="LI"><codeId>LIXX</codeId></AhpUidAssoc>
    <codeType>VFR-RP</codeType><txtName>TWIN A</txtName>
  </Dpn>`
	b := strings.Replace(strings.Replace(a, `mid="x1"`, `mid="x2"`, 1), "TWIN A", "TWIN B", 1)
	var picked []string
	for _, order := range [][2]string{{a, b}, {b, a}} {
		src := `<?xml version="1.0" encoding="utf-8"?>
<OFMX-Snapshot version="0.1" effective="2026-09-05T20:46:26Z">
  <Ahp>
    <AhpUid mid="a-lixx" region="LI"><codeId>LIXX</codeId></AhpUid>
    <txtName>SOMEWHERE</txtName><codeType>AD</codeType>
    <geoLat>45.75000000N</geoLat><geoLong>009.00000000E</geoLong>
  </Ahp>
  ` + order[0] + `
  ` + order[1] + `
</OFMX-Snapshot>`
		snap, err := DecodeOFMX(strings.NewReader(src))
		if err != nil {
			t.Fatal(err)
		}
		navs, _ := navaidValues(snap)
		for _, n := range navs {
			if n.Designator == "LNNE3=TWIN" {
				picked = append(picked, n.Name)
			}
		}
	}
	if len(picked) != 2 || picked[0] != picked[1] {
		t.Errorf("picked %v: the file's order chose", picked)
	}
}
