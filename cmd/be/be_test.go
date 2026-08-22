// be_test.go pins the eAIP parsers against trimmed real excerpts of the
// July 2026 cycle (testdata/README.md). The border-stitch pins ride the
// simplified 12-point EBBU ring in testdata/pruatlas-firs.json.

package main

import (
	"github.com/0intro/loxodrome/internal/eaip"
	"math"
	"strings"
	"testing"

	"github.com/0intro/loxodrome/internal/aixm5"
	"github.com/0intro/loxodrome/internal/aixm5build"
)

func loadSnapshot(t *testing.T) (*tree, *eaip.BorderRing) {
	t.Helper()
	tr, err := acquireOffline("testdata/snapshot")
	if err != nil {
		t.Fatal(err)
	}
	border, err := eaip.LoadBorderRing("testdata/pruatlas-firs.json", "EBBU")
	if err != nil || border == nil {
		t.Fatalf("border ring: %v", err)
	}
	return tr, border
}

func findAirspace(t *testing.T, list []aixm5.Airspace, id string) *aixm5.Airspace {
	t.Helper()
	for i := range list {
		if list[i].Designator == id {
			return &list[i]
		}
	}
	t.Fatalf("airspace %s not parsed", id)
	return nil
}

func TestEffectiveFromTitles(t *testing.T) {
	tr, _ := loadSnapshot(t)
	if got := tr.effective; got != "2026-07-09T00:00:00.000Z" {
		t.Fatalf("effective = %q", got)
	}
}

func TestEnrAirspaces(t *testing.T) {
	tr, border := loadSnapshot(t)
	st := newEnrStats()
	out := parseEnrAirspaces(tr, border, st)

	for _, a := range out {
		if a.Type == "FIR" || a.Type == "UIR" {
			t.Errorf("FIR/UIR must be skipped (pruatlas ships EBBU): %s", a.Designator)
		}
	}
	if st.skippedTypes["BRUSSELS-FIR"] != 1 || st.skippedTypes["BRUSSELS-UIR"] != 1 {
		t.Errorf("skippedTypes = %v", st.skippedTypes)
	}

	tma := findAirspace(t, out, "BE-BRUSSELS-TMA-ONE")
	if tma.Type != "TMA" || tma.ClassCode != "C" {
		t.Errorf("TMA ONE type/class = %s/%s", tma.Type, tma.ClassCode)
	}
	if *tma.UpperLimit != (aixm5.VerticalLimit{Value: "195", Unit: "FL", Ref: "STD"}) {
		t.Errorf("TMA ONE upper = %+v", tma.UpperLimit)
	}
	if *tma.LowerLimit != (aixm5.VerticalLimit{Value: "1500", Unit: "FT", Ref: "MSL"}) {
		t.Errorf("TMA ONE lower = %+v", tma.LowerLimit)
	}
	if len(tma.Ring) != 27 || tma.Ring[0] != [2]float64{50.67667, 4.07083} {
		t.Errorf("TMA ONE ring len %d first %v (arc tessellation changed?)", len(tma.Ring), tma.Ring[0])
	}

	lca := findAirspace(t, out, "BE-BRUSSELS-LOWER-CONTROL-AREA")
	if len(lca.Ring) != 12 || st.firRings != 1 {
		t.Errorf(`"The FIR boundary." must borrow the EBBU ring: len %d, firRings %d`, len(lca.Ring), st.firRings)
	}

	ebr04 := findAirspace(t, out, "EBR04")
	if ebr04.Type != "R" || ebr04.Name != "ELSENBORN 01" {
		t.Errorf("EBR04 = %s %q", ebr04.Type, ebr04.Name)
	}
	if ebr04.WorkHr != "HX" || !strings.Contains(ebr04.Rmk, "Gunnery") {
		t.Errorf("EBR04 workHr %q rmk %q", ebr04.WorkHr, ebr04.Rmk)
	}
	wantStitch := [2]float64{50.55, 6.21}
	found := false
	for _, p := range ebr04.Ring {
		if p == wantStitch {
			found = true
		}
	}
	if !found || st.boundary.BorderStitched == 0 {
		t.Errorf("EBR04 border segment not stitched along the EBBU ring: %v", ebr04.Ring)
	}

	if ebr03 := findAirspace(t, out, "EBR03"); len(ebr03.Ring) != 64 {
		t.Errorf("EBR03 circle ring len %d", len(ebr03.Ring))
	}
	if ebd := findAirspace(t, out, "EBD26"); ebd.Type != "D" {
		t.Errorf("EBD26 type %s", ebd.Type)
	}

	eijsden := findAirspace(t, out, "BE-EIJSDEN-AREA")
	if eijsden.Type != "W" || eijsden.ClassCode != "C" || len(eijsden.Ring) != 3 {
		t.Errorf("EIJSDEN = %s/%s ring %d", eijsden.Type, eijsden.ClassCode, len(eijsden.Ring))
	}
	if kb := findAirspace(t, out, "BE-KLEINE-BROGEL-CTR-TWO"); kb.Type != "CTR" {
		t.Errorf("KLEINE-BROGEL CTR TWO type %s", kb.Type)
	}
	if r18 := findAirspace(t, out, "EBR18A"); r18.Type != "R" {
		t.Errorf("EBR18A (ENR 2.2 republication) type %s", r18.Type)
	}

	if tra := findAirspace(t, out, "TRA NA"); tra.Type != "TRA" {
		t.Errorf("TRA NA type %s", tra.Type)
	}
	if tsa := findAirspace(t, out, "TRA/TSA N1"); tsa.Type != "TSA" {
		t.Errorf("TRA/TSA N1 type %s", tsa.Type)
	}

	// Cross Border Areas override the section defaults: ENR 5.2 would
	// type CBA1L TRA, ENR 2.2 would let LFCBA16B fall to the W default.
	// The TRA NA and EIJSDEN pins above double as the negatives.
	cba := findAirspace(t, out, "BE-CBA1L-CROSS-BORDER-AREA-LOW")
	if cba.Type != "CBA" || cba.Name != "CBA1L - CROSS BORDER AREA LOW" {
		t.Errorf("CBA1L = %s %q", cba.Type, cba.Name)
	}
	if cba := findAirspace(t, out, "BE-LFCBA16B-CROSS-BORDER-AREA-16-BRAVO"); cba.Type != "CBA" {
		t.Errorf("LFCBA16B (ENR 2.2 republication) type %s", cba.Type)
	}

	uccle := findAirspace(t, out, "BE-UCCLE-WEATHER-BALLOONS")
	if uccle.Type != "W" || len(uccle.Ring) != 64 || st.pointCircles == 0 {
		t.Errorf("UCCLE point site must draw a 1 NM circle: ring %d", len(uccle.Ring))
	}
	if balen := findAirspace(t, out, "BE-BALEN"); balen.Type != "ACTIVITY" {
		t.Errorf("BALEN (ENR 5.5) type %s", balen.Type)
	}
}

func TestAirportPages(t *testing.T) {
	tr, border := loadSnapshot(t)
	st := newEnrStats()
	ad := parseAirportPages(tr, border, st)
	if len(ad.airports) != 3 {
		t.Fatalf("airports = %d", len(ad.airports))
	}
	byIcao := map[string]*aixm5.Airport{}
	for i := range ad.airports {
		byIcao[ad.airports[i].Designator] = &ad.airports[i]
	}

	aw := byIcao["EBAW"]
	if aw == nil {
		t.Fatal("EBAW missing")
	}
	if math.Round(*aw.TransitionAltM/eaip.FtPerM) != 4500 {
		t.Errorf("EBAW TA = %v m", *aw.TransitionAltM)
	}
	if !aw.VFR || !aw.IFR || aw.Military {
		t.Errorf("EBAW traffic VFR %v IFR %v mil %v", aw.VFR, aw.IFR, aw.Military)
	}
	if len(aw.Runways) != 1 || aw.Runways[0].Designator != "11/29" {
		t.Fatalf("EBAW runways = %+v", aw.Runways)
	}
	r := aw.Runways[0]
	if math.Round(*r.LengthM) != 1510 || math.Round(*r.LeToraM) != 1510 || math.Round(*r.LeLdaM) != 1366 {
		t.Errorf("EBAW 11/29 length %v tora %v lda %v (grouped-digit parsing?)", *r.LengthM, *r.LeToraM, *r.LeLdaM)
	}
	radios := aixm5.CurateAirportRadios(aw.Radio)
	joined := ""
	for _, row := range radios {
		cells := row.([]any)
		joined += cells[0].(string) + ":" + cells[1].(string) + " "
	}
	for _, want := range []string{"135.205:TWR", "121.905:GND", "124.205:ATIS"} {
		if !strings.Contains(joined, want) {
			t.Errorf("EBAW radios missing %s in %s", want, joined)
		}
	}
	if strings.Contains(joined, "362.") {
		t.Errorf("UHF must be filtered out: %s", joined)
	}

	sp := byIcao["EBSP"]
	if sp == nil || math.Round(*sp.ElevM/eaip.FtPerM) != 1534 || sp.TransitionAltM != nil {
		t.Errorf("EBSP elev/TA = %+v", sp)
	}
	spCharts := ad.charts["EBSP"]
	if len(spCharts) != 1 || spCharts[0].Code != "VAC" ||
		spCharts[0].URL != "https://ops.skeyes.be/html/belgocontrol_static/eaip/eAIP_Main/graphics/eAIP/EBSP_VAC01_v14.pdf" {
		t.Errorf("EBSP charts = %+v", spCharts)
	}
	if len(spCharts) == 1 && spCharts[0].Title != "Visual Approach Chart - ICAO" {
		t.Errorf("EBSP chart title = %q (two-row title carry broken?)", spCharts[0].Title)
	}

	hp := byIcao["EBAD"]
	if hp == nil || hp.Type != "HP" || math.Round(*hp.ElevM/eaip.FtPerM) != 80 || hp.Lat == 0 {
		t.Errorf("EBAD heliport = %+v", hp)
	}

	var ctr *aixm5.Airspace
	for i := range ad.ctrs {
		if ad.ctrs[i].Designator == "BE-ANTWERPEN-CTR" {
			ctr = &ad.ctrs[i]
		}
	}
	if ctr == nil {
		t.Fatal("Antwerpen CTR not parsed from AD 2.17")
	}
	if ctr.Type != "CTR" || ctr.ClassCode != "D" {
		t.Errorf("CTR type/class = %s/%s", ctr.Type, ctr.ClassCode)
	}
	if *ctr.UpperLimit != (aixm5.VerticalLimit{Value: "2500", Unit: "FT", Ref: "MSL"}) ||
		*ctr.LowerLimit != (aixm5.VerticalLimit{Value: "GND"}) {
		t.Errorf("CTR limits = %+v / %+v (single-value cell must imply GND)", ctr.UpperLimit, ctr.LowerLimit)
	}
	if len(ctr.Ring) < 20 {
		t.Errorf("CTR ring len %d (arc missing?)", len(ctr.Ring))
	}
}

func TestBuildAirportsChartsColumn(t *testing.T) {
	tr, border := loadSnapshot(t)
	st := newEnrStats()
	ad := parseAirportPages(tr, border, st)
	msg := &aixm5.Message{Airports: ad.airports}
	artifact, meta, err := aixm5build.BuildAirports(msg, "test", nil, "", aixm5build.AirportsOptions{
		Country:         "BE",
		CountryFromIcao: beCountryFromIcao,
		MinAirports:     1,
		MaxAirports:     10,
		Charts:          beChartColumn(ad.charts),
		ChartFields:     beChartFields,
	})
	if err != nil {
		t.Fatal(err)
	}
	if artifact.Fields[len(artifact.Fields)-1] != "charts" {
		t.Fatalf("charts must be the trailing column: %v", artifact.Fields)
	}
	if len(artifact.ChartFields) != 3 || meta.ChartCount == 0 {
		t.Fatalf("chartFields %v count %d", artifact.ChartFields, meta.ChartCount)
	}
}

func TestNavaids(t *testing.T) {
	tr, _ := loadSnapshot(t)
	out := parseNavaids(tr)
	var ant, onw *aixm5.Navaid
	waypoints := 0
	for i := range out {
		switch {
		case out[i].Designator == "ANT":
			ant = &out[i]
		case out[i].Designator == "ONW":
			onw = &out[i]
		case out[i].Type == "WAYPOINT":
			waypoints++
		}
	}
	if ant == nil || ant.Type != "VOR-DME" || ant.FreqMHz == nil || *ant.FreqMHz != 113.5 || ant.Channel != "82X" {
		t.Errorf("ANT = %+v", ant)
	}
	if ant != nil && (ant.Name != "Antwerpen" || ant.ElevM == nil) {
		t.Errorf("ANT name/elev = %+v", ant)
	}
	if onw == nil || onw.Type != "NDB" || onw.FreqKHz == nil {
		t.Errorf("ONW = %+v", onw)
	}
	if waypoints != 3 {
		t.Errorf("waypoints = %d", waypoints)
	}
	for _, n := range out {
		if n.Type == "WAYPOINT" && (n.Lat == 0 || n.Lon == 0) {
			t.Errorf("waypoint %s without coordinates", n.Designator)
		}
	}
}

func TestObstacles(t *testing.T) {
	tr, _ := loadSnapshot(t)
	out := parseObstacles(tr)
	if len(out) < 3 {
		t.Fatalf("obstacles = %d", len(out))
	}
	o := out[0]
	if o.Type != "WIND_TURBINE" || o.Name != "Ciney-Pessoux" || !o.Group {
		t.Errorf("obstacle 0 = %+v", o)
	}
	if o.ElevM == nil || math.Round(*o.ElevM/eaip.FtPerM) != 1518 || o.HeightM == nil || math.Round(*o.HeightM/eaip.FtPerM) != 489 {
		t.Errorf("obstacle 0 elev/hgt = %+v", o)
	}
}

func TestBirdAreas(t *testing.T) {
	tr, _ := loadSnapshot(t)
	rows := parseBirdAreas(tr)
	byID := map[string]natureRow{}
	for _, r := range rows {
		byID[r.id] = r
	}
	damme, ok := byID["BE-BIRD-DAMME"]
	if !ok || damme.lat != 51.25556 || damme.lon != 3.2775 {
		t.Errorf("Damme = %+v", damme)
	}
	sq, ok := byID["BE-BIRD-NKCG"]
	if !ok || math.Abs(sq.lat-51.5) > 0.01 || math.Abs(sq.lon-2.5) > 0.01 {
		t.Errorf("GEOREF square centroid = %+v", sq)
	}
}

func TestSupplements(t *testing.T) {
	tr, _ := loadSnapshot(t)
	rows := parseSupplements(tr)
	if len(rows) != 2 {
		t.Fatalf("supplements = %d", len(rows))
	}
	byID := map[string]supRow{}
	for _, r := range rows {
		byID[r.id] = r
	}
	mast := byID["be-2025-046"]
	if mast.subject != "Wind Measurement Mast - Givry" ||
		mast.validFrom != "2025-07-10" || mast.validTo != "2027-05-18" {
		t.Errorf("046/2025 = %+v", mast)
	}
	if mast.pageURL != "https://ops.skeyes.be/html/belgocontrol_static/eaip/eAIP_Main/html/eSUP/EB-eSUP-2025-046-en-GB.html" {
		t.Errorf("046/2025 pageURL = %s", mast.pageURL)
	}
	if mast.geometrySource != "html-position" || len(mast.zones) != 1 {
		t.Fatalf("046/2025 zones = %+v", mast.zones)
	}
	z := mast.zones[0]
	if z.geom["radiusM"] != supCircleFloorM || z.geom["type"] != "circle" {
		t.Errorf("046/2025 circle = %+v", z.geom)
	}
	airshow := byID["be-2026-045"]
	if airshow.geometrySource != "html-polygon" || len(airshow.zones) == 0 {
		t.Errorf("045/2026 (airshow polygon) = %+v", airshow.geometrySource)
	}
}

func TestHelpers(t *testing.T) {
	if v := eaip.ParseVLimit("FL 195"); *v != (aixm5.VerticalLimit{Value: "195", Unit: "FL", Ref: "STD"}) {
		t.Errorf("FL 195 = %+v", v)
	}
	if v := eaip.ParseVLimit(" 1 500 FT AMSL"); *v != (aixm5.VerticalLimit{Value: "1500", Unit: "FT", Ref: "MSL"}) {
		t.Errorf("1 500 FT AMSL = %+v", v)
	}
	if v := eaip.ParseVLimit("UNL"); v.Value != "UNL" {
		t.Errorf("UNL = %+v", v)
	}
	if v := eaip.ParseVLimit("450 FT AGL"); *v != (aixm5.VerticalLimit{Value: "450", Unit: "FT", Ref: "SFC"}) {
		t.Errorf("450 FT AGL = %+v", v)
	}
	if pt, ok := eaip.ShortCoord("5048N 00421E"); !ok || pt != [2]float64{50.8, 4.35} {
		t.Errorf("eaip.ShortCoord = %v %v", pt, ok)
	}
	if c := chartCode("EBAW_VAC01_v30.pdf"); c != "VAC" {
		t.Errorf("civil chart code = %s", c)
	}
	if c := chartCode("EB_AD_2_EBBE_ADC_01_en_v19.pdf"); c != "ADC" {
		t.Errorf("military chart code = %s", c)
	}
	if got := reciprocal("08"); got != "26" {
		t.Errorf(`reciprocal("08") = %s`, got)
	}
	if got := reciprocal("07L"); got != "25R" {
		t.Errorf(`reciprocal("07L") = %s`, got)
	}
	if got := serviceCode("Approach control"); got != "APP" {
		t.Errorf("serviceCode = %s", got)
	}
	if !isCrossBorderArea("CBA1MZ - CROSS BORDER AREA MEDIUM FBZ") ||
		!isCrossBorderArea("LFCBA16B - CROSS BORDER AREA 16 BRAVO") {
		t.Error("isCrossBorderArea must match the CBA captions")
	}
	if isCrossBorderArea("TRA NA - TRA NORTH ALPHA") || isCrossBorderArea("EBR04 - ELSENBORN 01") {
		t.Error("isCrossBorderArea must not match ordinary zone captions")
	}
}
