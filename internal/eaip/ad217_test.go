package eaip

import (
	"fmt"
	"math"
	"strings"
	"testing"

	"github.com/0intro/loxodrome/internal/aixm5"
	"github.com/0intro/loxodrome/internal/geodesy"
)

// zoneLine prints what a pilot reads of a zone.
func zoneLine(a aixm5.Airspace) string {
	lim := func(v *aixm5.VerticalLimit) string {
		if v == nil {
			return "-"
		}
		return strings.TrimSpace(v.Value + " " + v.Unit + " " + v.Ref)
	}
	var radio []string
	for _, r := range a.Radio {
		radio = append(radio, r.Freq)
	}
	return fmt.Sprintf("%s %q class=%s %s / %s hrs=%q rmk=%q radio=%v",
		a.Type, a.Name, a.ClassCode, lim(a.UpperLimit), lim(a.LowerLimit), a.WorkHr, a.Rmk, radio)
}

// allOnCircle reports every vertex of a ring one radius from a centre.
func allOnCircle(ring [][2]float64, lat, lon, radiusM float64) bool {
	for _, p := range ring {
		if d := geodesy.DistanceM(lat, lon, p[0], p[1]); math.Abs(d-radiusM) > 0.02*radiusM {
			return false
		}
	}
	return len(ring) > 20
}

// AirNav prints Dublin's control zone with no designation at all, its
// arcs as "arc 15NM radius centre X", and a single figure for its
// limits: a class C zone from the surface, which is the control zone, and
// only the tower of the page's radios answers on it.
func TestATSAirspaceUntypedControlZone(t *testing.T) {
	doc := adDoc(t, `<h4><span>EIDW AD 2.17</span> ATS airspace</h4>
		<table><tr><td>1</td><td>Designation and lateral limits</td><td>533445N 0055420W, arc 15NM radius centre 532621N 0061508W, 531152N 0062130W, 531439N 0062130W, 531437N 0063707W, 532202N 0064237W, 532127N 0063758W, arc 5NM radius centre 532110N 0062938W, 532403N 0063626W, 532347N 0063117W, arc 10NM radius centre 532621N 0061508W, 533445N 0062411W.</td></tr>
		<tr><td>2</td><td>Vertical limits</td><td>5000 ft</td></tr>
		<tr><td>3</td><td>Airspace classification</td><td>C</td></tr>
		<tr><td>4</td><td>ATS unit call sign Language(s)</td><td>Dublin Tower English</td></tr>
		<tr><td>6</td><td>Hours of applicability</td><td>Nil</td></tr></table>`)
	ap := aixm5.Airport{Designator: "EIDW", Name: "DUBLIN INTERNATIONAL", Lat: 53.42139, Lon: -6.27,
		Radio: []aixm5.RadioChannel{{Freq: "118.600", Unit: "TWR", CallSign: "Dublin Tower"}, {Freq: "121.800", Unit: "GND", CallSign: "Dublin Ground"}}}
	st := NewZoneStats()
	got := ATSAirspace(doc, ap, ZoneSpec{IDPrefix: "IE"}, st)
	if len(got) != 1 {
		t.Fatalf("zones = %d, want 1", len(got))
	}
	if line, want := zoneLine(got[0]), `CTR "DUBLIN CTR" class=C 5000 FT / GND hrs="" rmk="" radio=[118.600]`; line != want {
		t.Errorf("got  %s\nwant %s", line, want)
	}
	if st.Boundary.Arcs != 3 || st.ADInferredCTR != 1 {
		t.Errorf("arcs=%d inferred=%d, want 3 and 1", st.Boundary.Arcs, st.ADInferredCTR)
	}
}

// SMATSA describes two zones in one item, the second a circle "centered at
// ARP ." with no coordinate, which is the page's own; the limits are one
// pair per zone, the classes one statement per zone, and two units answer,
// so neither zone is given the other's radio.
func TestATSAirspaceTwoZonesOneItem(t *testing.T) {
	doc := adDoc(t, `<h4><span>LYVR AD 2.17</span> ATS airspace</h4>
		<table><tr><td>1</td><td>Designation and COORD of lateral limits</td><td>VRŠAC CTR 451256N 0211030E 451235N 0212016E 450055N 0212052E 450126N 0211442E 450418N 0211204E 450930N 0211027E 451256N 0211030E VRŠAC ATZ /RMZ A circle radius 8 KM centered at ARP .</td></tr>
		<tr><td>2</td><td>Vertical limits</td><td>CTR : ATZ /RMZ:</td><td>3300 FT AMSL / GND 3300 FT AMSL / GND</td></tr>
		<tr><td>3</td><td>Airspace classification</td><td>CTR : ATZ /RMZ:</td><td>Class D Class G, when ATZ /RMZ is active</td></tr>
		<tr><td>4</td><td>ATS unit call sign Languages</td><td>VRŠAC TORANJ / VRŠAC TOWER Serbian, English</td><td>VRŠAC RADIO Serbian, English</td></tr></table>`)
	ap := aixm5.Airport{Designator: "LYVR", Name: "VRŠAC", Lat: 45.14694, Lon: 21.30944,
		Radio: []aixm5.RadioChannel{{Freq: "119.575", CallSign: "VRŠAC TOWER"}, {Freq: "123.500", CallSign: "VRŠAC RADIO"}}}
	got := ATSAirspace(doc, ap, ZoneSpec{IDPrefix: "RS"}, NewZoneStats())
	if len(got) != 2 {
		t.Fatalf("zones = %d, want 2", len(got))
	}
	for i, want := range []string{
		`CTR "VRŠAC CTR" class=D 3300 FT MSL / GND hrs="" rmk="" radio=[]`,
		`ATZ "VRŠAC ATZ /RMZ" class=G 3300 FT MSL / GND hrs="" rmk="" radio=[]`,
	} {
		if line := zoneLine(got[i]); line != want {
			t.Errorf("zone %d: got  %s\n        want %s", i, line, want)
		}
	}
	if !allOnCircle(got[1].Ring, ap.Lat, ap.Lon, 8000) {
		t.Errorf("the ATZ is not the 8 km circle round the ARP")
	}
}

// IDS sets the items as columns under a numbering row, one zone a row:
// Fintraffic's information zone, its limits upper first with no
// separator, the hours and remarks read off their own columns.
func TestATSAirspaceColumns(t *testing.T) {
	doc := adDoc(t, `<h4>EFET AD 2.17 ATS AIRSPACE</h4>
		<table><tr><td>Designation and lateral limits</td><td>Vertical limits</td><td>Airspace classification</td><td>ATS unit call sign Language(s)</td><td>Transition altitude</td><td>Hours of applicability</td><td>RMK</td></tr>
		<tr><td>1</td><td>2</td><td>3</td><td>4</td><td>5</td><td>6</td><td>7</td></tr>
		<tr><td>EFET FIZ LOWER Area bounded by lines joining points 683549N 0232713E - 682714N 0240037E - 680712N 0232248E - 681200N 0231335E - 682009N 0230125E - 682050N 0225911E to point of origin.</td><td>3300 FT MSL SFC</td><td>G</td><td>ENONTEKIÖN TIEDOTUS ENONTEKIÖ INFORMATION FI, EN</td><td>5000 FT MSL</td><td>NOTAM</td><td>RMZ H24</td></tr></table>`)
	ap := aixm5.Airport{Designator: "EFET", Name: "ENONTEKIÖ", Lat: 68.3625, Lon: 23.42444,
		Radio: []aixm5.RadioChannel{{Freq: "122.450", CallSign: "ENONTEKIÖ INFORMATION"}}}
	got := ATSAirspace(doc, ap, ZoneSpec{IDPrefix: "FI"}, NewZoneStats())
	if len(got) != 1 {
		t.Fatalf("zones = %d, want 1", len(got))
	}
	if line, want := zoneLine(got[0]), `FIZ "EFET FIZ LOWER" class=G 3300 FT MSL / SFC hrs="NOTAM" rmk="RMZ H24" radio=[122.450]`; line != want {
		t.Errorf("got  %s\nwant %s", line, want)
	}
}

// Avians numbers every item twice, Icelandic first, and prints the
// designation in both languages: the English row and half are read, the
// limits by their labels.
func TestATSAirspaceBilingual(t *testing.T) {
	const lateral = `Egilsstaðir vallarsvið / Egilsstadir Aerodrome Traffic Zone (ATZ) Hringur með 10 NM radius með miðju á 651700N 0142405W (ARP BIEG) / Circle with 10 NM radius centered on 651700N 0142405W (ARP BIEG).`
	const vertical = `Efri mörk / Upper Limit: 3000 FT AMSL Neðri mörk: Jörð / Lower Limit: SFC`
	doc := adDoc(t, `<h4>BIEG AD 2.17 ATS AIRSPACE</h4>
		<table><tr><td>1</td><td>Heiti og útlínur</td><td>`+lateral+`</td></tr>
		<tr><td>1</td><td>Designation and lateral limits</td><td>`+lateral+`</td></tr>
		<tr><td>2</td><td>Hæðarmörk</td><td>`+vertical+`</td></tr>
		<tr><td>2</td><td>Vertical limits</td><td>`+vertical+`</td></tr>
		<tr><td>3</td><td>Flokkun loftrýmis</td><td>Flokkur / Class G</td></tr>
		<tr><td>3</td><td>Airspace classification</td><td>Flokkur / Class G</td></tr></table>`)
	ap := aixm5.Airport{Designator: "BIEG", Name: "EGILSSTAÐIR", Lat: 65.28333, Lon: -14.40139}
	got := ATSAirspace(doc, ap, ZoneSpec{IDPrefix: "IS", Bilingual: true}, NewZoneStats())
	if len(got) != 1 {
		t.Fatalf("zones = %d, want 1", len(got))
	}
	if line, want := zoneLine(got[0]), `ATZ "Egilsstadir Aerodrome Traffic Zone (ATZ)" class=G 3000 FT MSL / SFC hrs="" rmk="" radio=[]`; line != want {
		t.Errorf("got  %s\nwant %s", line, want)
	}
	if !allOnCircle(got[0].Ring, 65.28333, -14.40139, 10*1852) {
		t.Errorf("the ATZ is not the 10 NM circle")
	}
}

// HungaroControl names each zone before its limits, its geometry and its
// class alike, in one item each.
func TestATSAirspaceNamedParts(t *testing.T) {
	doc := adDoc(t, `<h4><span>LHDC AD 2.17</span> ATS airspace</h4>
		<table><tr><td>1</td><td>Designation and lateral limits</td><td>DEBRECEN TIZ1: 473908N 0214744E - 473338N 0215503E - 471843N 0213038E - 472433N 0212252E - 473908N 0214744E DEBRECEN TIZ2: 474127N 0215009E - 473102N 0220059E - 471020N 0214329E - 471154N 0212611E - 472402N 0211743E - 473243N 0213243E - 474127N 0215009E DEBRECEN TIZ3: 474718N 0213722E - 474127N 0215009E - 473243N 0213243E - 474559N 0213339E - 474718N 0213722E</td></tr>
		<tr><td>2</td><td>Vertical limits</td><td>DEBRECEN TIZ1: 2 000 FT ALT / GND DEBRECEN TIZ2: 9 500 FT ALT / 2 000 FT ALT DEBRECEN TIZ3: 9 500 FT ALT / 5 000 FT ALT</td></tr>
		<tr><td>3</td><td>Airspace classification</td><td>DEBRECEN TIZ1, DEBRECEN TIZ2 and DEBRECEN TIZ3: Class G</td></tr></table>`)
	ap := aixm5.Airport{Designator: "LHDC", Name: "DEBRECEN", Lat: 47.48889, Lon: 21.61528}
	got := ATSAirspace(doc, ap, ZoneSpec{IDPrefix: "HU"}, NewZoneStats())
	var lines []string
	for _, a := range got {
		lines = append(lines, zoneLine(a))
	}
	want := []string{
		`TIZ "DEBRECEN TIZ1" class=G 2000 FT MSL / GND hrs="" rmk="" radio=[]`,
		`TIZ "DEBRECEN TIZ2" class=G 9500 FT MSL / 2000 FT MSL hrs="" rmk="" radio=[]`,
		`TIZ "DEBRECEN TIZ3" class=G 9500 FT MSL / 5000 FT MSL hrs="" rmk="" radio=[]`,
	}
	if strings.Join(lines, "\n") != strings.Join(want, "\n") {
		t.Errorf("got\n%s\nwant\n%s", strings.Join(lines, "\n"), strings.Join(want, "\n"))
	}
}

// ROMATSA names Brașov's control zone as a whole made of three parts, then
// sets each part's limits under a bare "CTR 1", "CTR 2", "CTR 3"; its
// ATS unit is "Brașov Tower" with a comma below, AD 2.18's "Braşov Tower"
// with a cedilla. Timişoara's unit is the "Timişoara TWR" of a tower its
// AD 2.18 calls "Timişoara Tower".
func TestATSAirspaceROMATSAParts(t *testing.T) {
	doc := adDoc(t, `<h4><span>LRBV AD 2.17</span> ATS airspace</h4>
		<table><tr><td>1</td><td>Designation and lateral limits</td><td>BRAȘOV CTR (CTR1+CTR2+CTR3) CTR 1 460129N 0254357E - 455156N 0260636E - 452648N 0254246E - 453151N 0253235E - 460129N 0254357E CTR 2 453151N 0253235E - 452648N 0254246E - 452036N 0253658E - 452737N 0252226E - 453151N 0253235E CTR 3 453500N 0251407E - 453500N 0251630E - 453100N 0252240E - 452913N 0251905E - 453500N 0251407E</td></tr>
		<tr><td>2</td><td>Vertical limits</td><td>CTR 1 - GND to FL105 CTR 2 - 6500 FT AMSL to FL105 CTR 3 - 6500 FT AMSL to FL105</td></tr>
		<tr><td>3</td><td>Airspace classification</td><td>C</td></tr>
		<tr><td>4</td><td>ATS unit call sign Language(s)</td><td>Brașov Tower English, Romanian</td></tr></table>`)
	ap := aixm5.Airport{Designator: "LRBV", Name: "BRAŞOV / Braşov-Ghimbav", Lat: 45.70361, Lon: 25.52278,
		Radio: []aixm5.RadioChannel{{Freq: "118.630", Unit: "TWR", CallSign: "Braşov Tower"}, {Freq: "124.530", Unit: "ATIS", CallSign: "Brașov ATIS"}}}
	got := ATSAirspace(doc, ap, ZoneSpec{IDPrefix: "RO"}, NewZoneStats())
	var lines []string
	for _, a := range got {
		lines = append(lines, zoneLine(a))
	}
	want := []string{
		`CTR "BRAȘOV CTR 1" class=C 105 FL STD / GND hrs="" rmk="" radio=[118.630]`,
		`CTR "BRAȘOV CTR 2" class=C 105 FL STD / 6500 FT MSL hrs="" rmk="" radio=[118.630]`,
		`CTR "BRAȘOV CTR 3" class=C 105 FL STD / 6500 FT MSL hrs="" rmk="" radio=[118.630]`,
	}
	if strings.Join(lines, "\n") != strings.Join(want, "\n") {
		t.Errorf("got\n%s\nwant\n%s", strings.Join(lines, "\n"), strings.Join(want, "\n"))
	}

	radio := []aixm5.RadioChannel{{Freq: "123.530", Unit: "APP", CallSign: "Arad Approach"}, {Freq: "120.105", Unit: "TWR", CallSign: "Timişoara Tower"}}
	if got := atsRadio(radio, "Timişoara TWR English, Romanian", 1); len(got) != 1 || got[0].Freq != "120.105" {
		t.Errorf("Timişoara TWR answers on %v, want the tower's 120.105", got)
	}
}

// NAV Portugal sets the zone's name on a row of its own above the items,
// and item 1 is the lateral limits alone; its ceiling carries its metric
// twin, and ALT is an altitude.
func TestATSAirspaceHeadRow(t *testing.T) {
	doc := adDoc(t, `<h4><span>LPAZ AD 2.17</span> ATS airspace</h4>
		<table><tr><td>Santa Maria CTR</td><td>Santa Maria CTR</td><td>Santa Maria CTR</td></tr>
		<tr><td>1</td><td>Lateral limits</td><td>A circle with 5 NM radius centred at ARP (365826N 0251016W)</td></tr>
		<tr><td>2</td><td>Vertical limits</td><td>2000 FT ALT (600 M)</td></tr>
		<tr><td>3</td><td>Airspace classification</td><td>C</td></tr></table>`)
	ap := aixm5.Airport{Designator: "LPAZ", Name: "SANTA MARIA", Lat: 36.97389, Lon: -25.17111}
	got := ATSAirspace(doc, ap, ZoneSpec{IDPrefix: "PT"}, NewZoneStats())
	if len(got) != 1 {
		t.Fatalf("zones = %d, want 1", len(got))
	}
	if line, want := zoneLine(got[0]), `CTR "Santa Maria CTR" class=C 2000 FT MSL / GND hrs="" rmk="" radio=[]`; line != want {
		t.Errorf("got  %s\nwant %s", line, want)
	}
}

// LPS SR prints its remarks as item 6 and no hours at all: an item is
// read by its label, never as the item another State numbers alike, and
// a remark saying NIL is none.
func TestATSAirspaceItemsByLabel(t *testing.T) {
	doc := adDoc(t, `<h4><span>LZZI AD 2.17</span> ATS airspace</h4>
		<table><tr><td>1</td><td>Designation and lateral limits</td><td>ŽILINA CTR 492317N 0184502E 492239N 0184738E 491701N 0185141E 491506N 0185014E 491348N 0184558E circular arc CW 6 NM around 491400N 0183649E to 490831N 0183308E 490444N 0182103E 491346N 0181427E 492317N 0184502E</td></tr>
		<tr><td>2</td><td>Vertical limits</td><td>5 000 ft AMSL / GND</td></tr>
		<tr><td>3</td><td>Airspace classification</td><td>D The classification is changed to class G outside OPR HR of ŽILINA TWR .</td></tr>
		<tr><td>4</td><td>ATS unit call sign/language(s)</td><td>ŽILINA TOWER/SK, EN</td></tr>
		<tr><td>5</td><td>Transition altitude</td><td>10 000 ft AMSL</td></tr>
		<tr><td>6</td><td>Remarks</td><td>NIL</td></tr></table>`)
	ap := aixm5.Airport{Designator: "LZZI", Name: "ŽILINA", Lat: 49.23167, Lon: 18.61361,
		Radio: []aixm5.RadioChannel{{Freq: "124.155", CallSign: "ŽILINA TOWER"}, {Freq: "124.155", CallSign: "ŽILINA TOWER"}}}
	st := NewZoneStats()
	got := ATSAirspace(doc, ap, ZoneSpec{IDPrefix: "SK"}, st)
	if len(got) != 1 {
		t.Fatalf("zones = %d, want 1", len(got))
	}
	if line, want := zoneLine(got[0]), `CTR "ŽILINA CTR" class=D 5000 FT MSL / GND hrs="" rmk="" radio=[124.155]`; line != want {
		t.Errorf("got  %s\nwant %s", line, want)
	}
	if st.Boundary.Arcs != 1 {
		t.Errorf("arcs = %d, want 1", st.Boundary.Arcs)
	}
}

// A zone an ENR section already publishes is left out, laterally and
// vertically the same; the same lateral limits under other vertical ones
// are another volume.
func TestDropRepublished(t *testing.T) {
	ring := [][2]float64{{42.7, 20.9}, {42.75, 21.1}, {42.6, 21.15}, {42.55, 20.95}}
	nudged := [][2]float64{{42.7001, 20.9}, {42.75, 21.1001}, {42.6, 21.15}, {42.55, 20.9499}}
	gnd := &aixm5.VerticalLimit{Value: "GND"}
	sfc := &aixm5.VerticalLimit{Value: "0", Unit: "FT", Ref: "SFC"}
	ft := func(v string) *aixm5.VerticalLimit { return &aixm5.VerticalLimit{Value: v, Unit: "FT", Ref: "MSL"} }
	enr := []aixm5.Airspace{{ID: "XK-PRISTINA-CTR", Ring: ring, UpperLimit: ft("3500"), LowerLimit: sfc}}
	ad := []aixm5.Airspace{
		{ID: "XK-PRISTINA-CTR-AD", Ring: nudged, UpperLimit: ft("3500"), LowerLimit: gnd},
		{ID: "XK-OTHER", Ring: nudged, UpperLimit: ft("9500"), LowerLimit: ft("3500")},
	}
	kept, dropped := DropRepublished(enr, ad)
	if dropped != 1 || len(kept) != 1 || kept[0].ID != "XK-OTHER" {
		t.Errorf("kept %v, dropped %d; want XK-OTHER kept and one dropped", kept, dropped)
	}
}

// A position written back reads as itself.
func TestFormatCoord(t *testing.T) {
	for _, p := range [][2]float64{{48.17, 17.21278}, {-33.94611, 151.17722}, {65.28333, -14.40139}} {
		lat, lon, ok := FirstCoord(FormatCoord(p[0], p[1]))
		if !ok || math.Abs(lat-p[0]) > 1e-5 || math.Abs(lon-p[1]) > 1e-5 {
			t.Errorf("%v -> %q -> %g,%g", p, FormatCoord(p[0], p[1]), lat, lon)
		}
	}
}

// LPS SR centres its small aerodromes' zones on their ARPs by indicator,
// with no coordinate: the package's own AD pages place them, and a
// reference they do not place is left as it is.
func TestZoneRingReferences(t *testing.T) {
	spec := ZoneSpec{Refs: Refs{ARP: map[string][2]float64{"LZPP": {48.625, 17.82833}}}}
	st := NewZoneStats()
	ring := ZoneRing("A circle of radius 5 NM with the centre point at: ARP LZPP", spec, st)
	if st.RefsResolved != 1 || !allOnCircle(ring, 48.625, 17.82833, 5*1852) {
		t.Errorf("resolved=%d, ring %d points: want LZPP's 5 NM circle", st.RefsResolved, len(ring))
	}
	st = NewZoneStats()
	if ring := ZoneRing("A circle of radius 3 NM with the centre point at: ARP LZDB", spec, st); ring != nil || st.RefsResolved != 0 {
		t.Errorf("an unplaced reference drew %d points", len(ring))
	}
}
