package eaip

import (
	"fmt"
	"strconv"
	"strings"
	"testing"
)

func adDoc(t *testing.T, page string) *Node {
	t.Helper()
	doc, err := ParseHTML([]byte(page))
	if err != nil {
		t.Fatal(err)
	}
	return doc
}

// The item layouts the cohort sets AD 2.2 and AD 2.17 in, each from a live
// page, 2026-09-24.
func TestADItems(t *testing.T) {
	cases := []struct {
		name, page string
		n          int
		label      string
		values     string
	}{
		// AirNav Ireland: number, label, value.
		{"Ireland", `<table><tr><td>5</td><td>Transition altitude</td><td>5000 ft</td></tr></table>`,
			5, "Transition altitude", "5000 ft"},
		// LFV: the number in the second cell, an empty one around the label.
		{"Sweden", `<table><tr><td></td><td>1.</td><td>ARP coordinates and site at AD</td><td></td><td>593907N 0175507E 010.5° GEO</td></tr></table>`,
			1, "ARP coordinates and site at AD", "593907N 0175507E 010.5° GEO"},
		// SMATSA: the label spanned twice, then the coordinates and the site.
		{"Serbia", `<table><tr><td>1</td><td colspan="2">ARP coordinates and site at AD</td><td>444910N 0201825E</td><td>122° GEO / 1500 M from THR 12L</td></tr></table>`,
			1, "ARP coordinates and site at AD", "444910N 0201825E|122° GEO / 1500 M from THR 12L"},
		// Fintraffic: the Finnish row, numbered, before its English twin.
		{"Finland", `<table><tr><td>7</td><td>Sallitut liikennetyypit (IFR/VFR)</td><td>IFR/VFR</td></tr>
			<tr><td></td><td>Types of traffic permitted (IFR/VFR)</td><td>IFR/VFR</td></tr></table>`,
			7, "Sallitut liikennetyypit (IFR/VFR)", "IFR/VFR"},
		// IDS AD 2.17: labels, a row numbering the columns, the data under it.
		{"IDS columns", `<table><tr><td>Designation and lateral limits</td><td>Vertical limits</td><td>Class</td><td>Call sign</td><td>Transition altitude</td></tr>
			<tr><td>1</td><td>2</td><td>3</td><td>4</td><td>5</td></tr>
			<tr><td>EFJY CTR</td><td>2000 FT MSL SFC</td><td>D</td><td>JYVÄSKYLÄ TOWER</td><td>5000 FT MSL</td></tr></table>`,
			5, "", "5000 FT MSL"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			doc := adDoc(t, c.page)
			it := ADItems(Elems(doc, "table"))[c.n]
			if it.Label != c.label || strings.Join(it.Values, "|") != c.values {
				t.Errorf("item %d = %q %q, want %q %q", c.n, it.Label, strings.Join(it.Values, "|"), c.label, c.values)
			}
		})
	}
}

// ANS CR numbers AD 2.2 without the geoid undulation, so the types of
// traffic are its item 6: the label is checked, and the item whose label
// fits is taken.
func TestPickItem(t *testing.T) {
	doc := adDoc(t, `<table>
		<tr><td>6</td><td>Types of traffic permitted (IFR/VFR)</td><td>VFR</td></tr>
		<tr><td>7</td><td>Remarks</td><td>Cross-country flights only IFR/VFR by arrangement</td></tr></table>`)
	if got := pickItem(ADItems(Elems(doc, "table")), 7, trafficLabelRe).Text(); got != "VFR" {
		t.Errorf("traffic = %q", got)
	}
}

func TestAnyCoordAndFeet(t *testing.T) {
	for s, want := range map[string]string{
		"511122N 0042737E":                                 "51.18944,4.46028",
		"53 38 15N 006 52 50W Midpoint RWY 10R/28L":        "53.6375,-6.88056",
		"49 01 46 N 017 26 23 E RWY 02C/20C":               "49.02944,17.43972",
		"LAT : 411408 N LONG : 0084041 W Intersection RWY": "41.23556,-8.67806",
		// AirNav's Sligo, October 2026: a stray space inside the latitude.
		"54164 9 N 0083557 W": "54.28028,-8.59917",
		// The SIA writes the marks.
		`49°00'35"N 002°32'52"E`: "49.00972,2.54778",
	} {
		lat, lon, ok := AnyCoord(s)
		if got := fmt.Sprintf("%g,%g", lat, lon); !ok || got != want {
			t.Errorf("AnyCoord(%q) = %s %v, want %s", s, got, ok, want)
		}
	}
	for s, want := range map[string]int{
		"69M / 227 FT 21º C ( AUG )":            227,
		"581 ft / 177 m / 21 °C":                581,
		"793.5 ft / 241,9 m 24.7 °C (JUL)":      794,
		"520 M":                                 1706,
		"460 FT / 22° C / NIL":                  460,
		"156 ft /22.3°C (Max Temp) 1.3°C (MNM)": 156,
	} {
		if got, ok := ADFeet(s); !ok || got != want {
			t.Errorf("ADFeet(%q) = %d %v, want %d", s, got, ok, want)
		}
	}
}

// NAV Portugal gives each runway direction a table of its own, the items
// in rows; the item numbered 10 is no runway.
func TestParseRunwaysByDirection(t *testing.T) {
	doc := adDoc(t, `<table><tr><td>RWY 18</td><td>RWY 18</td></tr>
		<tr><td>1</td><td>True bearing</td><td>171.07</td></tr>
		<tr><td>2</td><td>Dimensions of RWY</td><td>3048 x 60 M</td></tr>
		<tr><td>3</td><td>Strength and surface of RWY</td><td>PCN 87 / R / C / W / T, CONC</td></tr>
		<tr><td>10</td><td>Strip dimensions</td><td>3168 x 300 M</td></tr></table>
		<table><tr><td>RWY 36</td></tr>
		<tr><td>2</td><td>Dimensions of RWY</td><td>3048 x 60 M</td></tr></table>`)
	rwys := ParseRunways(Elems(doc, "table"), nil)
	if len(rwys) != 1 {
		t.Fatalf("%d runways, want 1", len(rwys))
	}
	r := rwys[0]
	if r.Designator != "18/36" || *r.LengthM != 3048 || *r.WidthM != 60 || r.Surface != "CONC" {
		t.Errorf("runway %s %v x %v %s", r.Designator, *r.LengthM, *r.WidthM, r.Surface)
	}
}

// A page marking its sections by heading alone (SMATSA), read whole.
func TestReadAerodromeByHeadings(t *testing.T) {
	doc := adDoc(t, `<h3 class="TitleAD">LYBE — BEOGRAD/Nikola Tesla</h3>
		<p class="ADName">LYBE — BEOGRAD/Nikola Tesla</p>
		<h4><span>LYBE AD 2.2</span> Aerodrome geographical and administrative data</h4>
		<table><tr><td>1</td><td colspan="2">ARP coordinates and site at AD</td><td>444910N 0201825E</td><td>122° GEO / 1500 M from THR 12L</td></tr>
		<tr><td>3</td><td>ELEV / Reference temperature</td><td>336 FT / 29.4°C</td></tr>
		<tr><td>7</td><td>Types of traffic permitted (IFR/VFR)</td><td>IFR-VFR</td></tr></table>
		<h4><span>LYBE AD 2.12</span> Runway physical characteristics</h4>
		<table><tr><td>12L</td><td>122°</td><td>3400 x 45</td><td>ASPH</td></tr><tr><td>30R</td><td>302°</td><td>3400 x 45</td><td>ASPH</td></tr></table>
		<h4><span>LYBE AD 2.17</span> ATS airspace</h4>
		<table><tr><td>5</td><td>Transition altitude</td><td>10000 FT</td></tr></table>
		<h4><span>LYBE AD 2.18</span> ATS communication facilities</h4>
		<table><tr><td>TWR</td><td>Beograd Tower</td><td>118.100 MHz</td></tr></table>`)
	ap, ok := ReadAerodrome(doc, "LYBE", false)
	if !ok {
		t.Fatal("not read")
	}
	got := fmt.Sprintf("%s %g,%g elev=%.0f ta=%.0f vfr=%v ifr=%v rwys=%d radios=%d",
		ap.Name, ap.Lat, ap.Lon, *ap.ElevM/FtPerM, *ap.TransitionAltM/FtPerM, ap.VFR, ap.IFR, len(ap.Runways), len(ap.Radio))
	if want := "BEOGRAD/Nikola Tesla 44.81944,20.30694 elev=336 ta=10000 vfr=true ifr=true rwys=1 radios=1"; got != want {
		t.Errorf("got  %s\nwant %s", got, want)
	}
}

func TestEnglishCallSign(t *testing.T) {
	for in, want := range map[string]string{
		"JYVÄSKYLÄN TULO JYVÄSKYLÄ ARRIVAL":                 "JYVÄSKYLÄ ARRIVAL",
		"JYVÄSKYLÄN TORNI JYVÄSKYLÄ TOWER":                  "JYVÄSKYLÄ TOWER",
		"BEOGRAD TORANJ / BEOGRAD TOWER":                    "BEOGRAD TOWER",
		"Hornafjörður flugradíó / Hornafjordur information": "Hornafjordur information",
		"Reykjavík flugradíó/ Reykjavík Information":        "Reykjavík Information",
		"Dublin Flight Information Service":                 "Dublin Flight Information Service",
		"(Dublin Information Departure)":                    "(Dublin Information Departure)",
		"Reykjavik turn/tower":                              "Reykjavik turn/tower",
		"ŠTEFÁNIK RADAR":                                    "ŠTEFÁNIK RADAR",
		"-":                                                 "",
	} {
		if got := EnglishCallSign(in); got != want {
			t.Errorf("EnglishCallSign(%q) = %q, want %q", in, got, want)
		}
	}
}

// NATS's AD 2.18: a service's further call signs and channels on rows of
// their own, the service cell blank, the call sign too for a second
// channel, and Ground under the TWR designation.
func TestParseComTableContinuedRows(t *testing.T) {
	doc := adDoc(t, `<table>
		<tr><td>Service Designation</td><td>Callsign</td><td>Channel/Frequency(MHz)</td></tr>
		<tr><td>1</td><td>2</td><td>3</td></tr>
		<tr><td>APP</td><td>MANCHESTER DIRECTOR</td><td>121.355 DOC 25 NM/10,000 FT.</td></tr>
		<tr><td></td><td>MANCHESTER RADAR</td><td>118.580 DOC 40 NM/15,000 FT.</td></tr>
		<tr><td></td><td></td><td>135.005 DOC 40 NM/15,000 FT.</td></tr>
		<tr><td>TWR</td><td>MANCHESTER GROUND</td><td>121.855 DOC 5 NM/GND.</td></tr>
		<tr><td></td><td>MANCHESTER TOWER</td><td>118.630 DOC 25 NM/10,000 FT.</td></tr>
		<tr><td>ATIS ARR</td><td>MANCHESTER ARRIVAL INFORMATION</td><td>128.180</td></tr></table>`)
	var got []string
	for _, c := range ParseComTable(Elems(doc, "table")) {
		got = append(got, c.Unit+" "+c.Freq+" "+c.CallSign)
	}
	want := strings.Join([]string{
		"APP 121.355 MANCHESTER DIRECTOR",
		"APP 118.580 MANCHESTER RADAR",
		"APP 135.005 MANCHESTER RADAR",
		"GND 121.855 MANCHESTER GROUND",
		"TWR 118.630 MANCHESTER TOWER",
		"ATIS 128.180 MANCHESTER ARRIVAL INFORMATION",
	}, "\n")
	if strings.Join(got, "\n") != want {
		t.Errorf("got\n%s\nwant\n%s", strings.Join(got, "\n"), want)
	}
}

// NATS's AD 2.13 marks each distance in metres ("3047 M").
func TestParseRunwaysMetresMarked(t *testing.T) {
	doc := adDoc(t, `<table><tr><td>05R</td><td>050°</td><td>3048 x 45</td><td>ASPH</td></tr>
		<tr><td>23L</td><td>230°</td><td>3048 x 45</td><td>ASPH</td></tr></table>
		<table><tr><td>Runway designator</td><td>TORA</td><td>TODA</td><td>ASDA</td><td>LDA</td></tr>
		<tr><td>05R</td><td>3047 M</td><td>3347 M</td><td>3047 M</td><td>2864 M</td></tr>
		<tr><td>23L</td><td>3200 M</td><td>3500 M</td><td>3200 M</td><td>2864 M</td></tr>
		<tr><td>23L</td><td>2202 M</td><td>2502 M</td><td>2202 M</td><td></td></tr></table>`)
	tables := Elems(doc, "table")
	rwys := ParseRunways(tables[:1], tables[1:])
	if len(rwys) != 1 {
		t.Fatalf("%d runways", len(rwys))
	}
	r := rwys[0]
	if *r.LeToraM != 3047 || *r.LeLdaM != 2864 || *r.HeToraM != 3200 || *r.HeTodaM != 3500 {
		t.Errorf("distances %v %v %v %v", *r.LeToraM, *r.LeLdaM, *r.HeToraM, *r.HeTodaM)
	}
}

// NATS gives a grass runway beside the paved one its own ends, lettered G
// (Kemble's 08G/26G), and prints a width it does not know as a dash
// (Stapleford's "799 x - M"). The structured-data tags of the UK pages
// showed both unread.
func TestParseRunwaysGrassAndDashedWidth(t *testing.T) {
	doc := adDoc(t, `<table><tr><td>08</td><td>080.41°</td><td>1972 x 43 M</td><td>RWY surface: Asphalt</td></tr>
		<tr><td>26</td><td>260.43°</td><td>1972 x 43 M</td><td>RWY surface: Asphalt</td></tr>
		<tr><td>08G</td><td>080.37°</td><td>561 x 18 M</td><td>RWY surface: Grass</td></tr>
		<tr><td>26G</td><td>260.37°</td><td>561 x 18 M</td><td>RWY surface: Grass</td></tr>
		<tr><td>09L</td><td>085.11°</td><td>799 x - M</td><td>RWY surface: Grass</td></tr>
		<tr><td>27R</td><td>265.12°</td><td>799 x - M</td><td>RWY surface: Grass</td></tr></table>`)
	var got []string
	for _, r := range ParseRunways(Elems(doc, "table"), nil) {
		w := "-"
		if r.WidthM != nil {
			w = strconv.FormatFloat(*r.WidthM, 'f', 0, 64)
		}
		got = append(got, fmt.Sprintf("%s %.0f x %s %s", r.Designator, *r.LengthM, w, r.Surface))
	}
	want := "08/26 1972 x 43 ASPH | 08G/26G 561 x 18 GRASS | 09L/27R 799 x - GRASS"
	if strings.Join(got, " | ") != want {
		t.Errorf("runways\n %s\nwant\n %s", strings.Join(got, " | "), want)
	}
}

// The operator's block in the three layouts the cohort sets it: one cell
// (AirNav Ireland), labelled continuation rows (SMATSA, office hours beside
// its numbers and a spaced "+ 381"), and a row per field numbered alike
// (skeyes).
func TestParseOperator(t *testing.T) {
	cases := []struct {
		name, page, want string
	}{
		{"one cell", `<table><tr><td>6</td><td>AD Operator, address, telephone, email, website</td>
			<td>Post: Weston Aviation Academy Ltd, Weston Airport, Lucan. Tel: +353 1 621 73 00 Email: ops@weston.ie Web: http://www.westonairport.com</td></tr></table>`,
			"Weston Aviation Academy Ltd, Weston Airport, Lucan | +353 1 621 73 00 |  | ops@weston.ie | http://www.westonairport.com"},
		{"continuation rows", `<table><tr><td>6</td><td>AD Operator</td><td>address:</td><td>BELGRADE AIRPORT d.o.o. 11180 Beograd</td></tr>
			<tr><td></td><td></td><td>TEL :</td><td>Operational center (H24): + 381 11 209 7405</td></tr>
			<tr><td></td><td></td><td></td><td>Flight coordination office (0600-1800): + 381 11 209 7345</td></tr>
			<tr><td></td><td></td><td>e-mail:</td><td>operational.center@beg.aero</td></tr></table>`,
			"BELGRADE AIRPORT d.o.o. 11180 Beograd | +381 11 209 7405,+381 11 209 7345 |  | operational.center@beg.aero | "},
		{"numbered rows", `<table><tr><td>6</td><td>Name of AD operator</td><td>LEM Antwerpen</td></tr>
			<tr><td>6</td><td>Address</td><td>Luchthavengebouw 2100 Deurne BELGIUM</td></tr>
			<tr><td>6</td><td>TEL</td><td>+32 (0) 3 285 65 20 ( H24 )</td></tr>
			<tr><td>6</td><td>FAX</td><td>+32 (0) 3 285 65 01</td></tr>
			<tr><td>6</td><td>Email</td><td>info@antwerpairport.aero</td></tr></table>`,
			"LEM Antwerpen | +32 (0) 3 285 65 20 | +32 (0) 3 285 65 01 | info@antwerpairport.aero | "},
		// KANS words the item as the older "AD operating authority", and its
		// AFS address, on a row of its own, is no part of the operator.
		{"operating authority", `<table><tr><td>6</td><td>AD operating authority Postal address</td><td>LIMAK Kosovo International Airport J.S.C. 10070 Vrellë, Lipjan</td></tr>
			<tr><td></td><td>AFTN-ARO</td><td>BKPRZPZX</td></tr></table>`,
			"LIMAK Kosovo International Airport J.S.C. 10070 Vrellë, Lipjan |  |  |  | "},
		// ROMATSA: an abbreviation's full stop for the colon, groups parted by
		// dots, two numbers side by side, one number for both, a mobile with
		// its country code bracketed.
		{"full stop", `<table><tr><td>6</td><td>AD Administration, address, telephone</td><td>Aeroclubul Teritorial Clinceni, Jud. Ilfov Tel. 0736.663.797 / 0732.015.037 e-mail: bucuresti@aeroclubulromaniei.ro</td></tr></table>`,
			"Aeroclubul Teritorial Clinceni, Jud. Ilfov | 0736.663.797,0732.015.037 |  | bucuresti@aeroclubulromaniei.ro | "},
		{"side by side", `<table><tr><td>6</td><td>Heliport Administration, address, telephone</td><td>Oradea County Emergency Hospital Tel: 0259-321935 0770-605706 (Administrator) Fax: 0259-321273</td></tr></table>`,
			"Oradea County Emergency Hospital | 0259-321935,0770-605706 | 0259-321273 |  | "},
		{"tel/fax and mobile", `<table><tr><td>6</td><td>AD Administration, address, telephone</td><td>SC EUROCOMPOZITE SRL Tel/Fax: +40-(0)263-234206, +40-(0)263-234659 Mobil: (+4) 0722.361251</td></tr></table>`,
			"SC EUROCOMPOZITE SRL | +40-(0)263-234206,+40-(0)263-234659,(+4) 0722.361251 | +40-(0)263-234206,+40-(0)263-234659 |  | "},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			it := pickItem(ADItems(Elems(adDoc(t, c.page), "table")), 6, operatorLabelRe)
			k, ok := ParseOperator(it)
			if !ok {
				t.Fatal("no operator")
			}
			got := strings.Join([]string{k.Name, strings.Join(k.Phone, ","), strings.Join(k.Fax, ","), strings.Join(k.Email, ","), strings.Join(k.Web, ",")}, " | ")
			if got != c.want {
				t.Errorf("got  %s\nwant %s", got, c.want)
			}
		})
	}
}

// A surface stated as not paved is never read as the paved word inside
// it, in English or in French, and bitumen reads in both.
func TestSurfaceToken(t *testing.T) {
	for in, want := range map[string]string{
		"non revêtue / not paved":            "UNPAVED",
		"Unpaved":                            "UNPAVED",
		"revêtue / paved":                    "ASPH",
		"enrobé bitumineux / bituminous mix": "ASPH",
		"Bitumen/Macadam":                    "ASPH",
		"Grass":                              "GRASS",
		"64 F/C/W/T enrobé bitumineux / bituminous mix": "ASPH",
	} {
		if got := SurfaceToken(in); got != want {
			t.Errorf("SurfaceToken(%q) = %q, want %q", in, got, want)
		}
	}
}

// AD 2.22's own tables of points, headed by the point's name and its
// coordinates: LGS's Riga ("Entry/Exit point", its use in brackets after
// the name) and ANS CR's Kunovice ("Designation"). A runway table's
// designations elsewhere on the page are no points.
func TestReadVisualPointsTables(t *testing.T) {
	doc := adDoc(t, `<h4><span>EVRS AD 2.12</span> Runway physical characteristics</h4>
		<table><tr><td>Designations</td><td>Coordinates</td></tr><tr><td>14</td><td>565931N 0240428E</td></tr></table>
		<h4><span>EVRS AD 2.22</span> Flight procedures</h4>
		<table><tr><td>Entry/Exit point</td><td>Visual reference</td><td>Coordinates</td><td>Surrounding airspace</td></tr>
		<tr><td>CLUB</td><td>Jaunciems Yacht Club Harbour</td><td>570231N 0241020E</td><td>G</td></tr>
		<tr><td>RIVER (exit point only)</td><td>Confluence of the Daugava</td><td>570127N 0240519E</td><td>C</td></tr></table>`)
	var got []string
	for _, p := range ReadVisualPoints(doc, "EVRS") {
		got = append(got, fmt.Sprintf("%s %s %.4f %.4f", p.ID, p.Designator, p.Lat, p.Lon))
	}
	want := "VRP:EVRS:CLUB CLUB 57.0419 24.1722 | VRP:EVRS:RIVER RIVER 57.0242 24.0886"
	if strings.Join(got, " | ") != want {
		t.Errorf("Riga's points\n %s\nwant\n %s", strings.Join(got, " | "), want)
	}
	doc = adDoc(t, `<h4><span>LKKU AD 2.22</span> Flight procedures</h4>
		<table><tr><td>Designation</td><td>Location</td><td>Coordinates</td><td></td></tr>
		<tr><td>NOVEMBER</td><td>Halenkovice</td><td>491013N 0172821E</td><td>entry/exit</td></tr></table>`)
	if pts := ReadVisualPoints(doc, "LKKU"); len(pts) != 1 || pts[0].Designator != "NOVEMBER" {
		t.Errorf("Kunovice's points %+v", pts)
	}
	// The procedures' waypoint list names no landmark: RNAV fixes, not
	// visual points (České Budějovice's AD 2.22.5).
	doc = adDoc(t, `<h4><span>LKCS AD 2.22</span> Flight procedures</h4>
		<table><tr><td>Designation</td><td>Coordinates</td></tr>
		<tr><td>YOYOY</td><td>485646.94N 0142656.77E</td></tr></table>`)
	if pts := ReadVisualPoints(doc, "LKCS"); len(pts) != 0 {
		t.Errorf("a waypoint list read as visual points: %+v", pts)
	}
}
