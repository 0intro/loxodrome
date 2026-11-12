package eaip

import (
	"math"
	"strings"
	"testing"

	"github.com/0intro/loxodrome/internal/aixm5"
)

// blockSpec types an ENR 2 zone the way cmd/eaip's resolver does, as far
// as these fixtures need.
var blockSpec = ZoneSpec{
	Type: func(_, _, name string) string {
		if strings.Contains(strings.ToUpper(name), "TMA") {
			return "TMA"
		}
		return "CTA"
	},
}

func parseBlocks(t *testing.T, page string, spec ZoneSpec) ([]aixm5.Airspace, *ZoneStats) {
	t.Helper()
	doc, err := ParseHTML([]byte(page))
	if err != nil {
		t.Fatal(err)
	}
	st := NewZoneStats()
	return ParseIcaoZoneTables(doc, "ENR 2.1", spec, st), st
}

func freqsOf(a aixm5.Airspace) []string {
	var out []string
	for _, r := range a.Radio {
		out = append(out, r.Freq)
	}
	return out
}

const combinedHeader = `<tr><td>Name Lateral limits Vertical limits Class of airspace</td>` +
	`<td>Unit providing service</td>` +
	`<td>Call sign Languages Area and conditions of use Hours of service</td>` +
	`<td>Frequency / Purpose</td><td>Remarks</td></tr>` +
	`<tr><td>1</td><td>2</td><td>3</td><td>4</td><td>5</td></tr>`

// Avians, 2026-09-03: the FAXI TMA's parts are a table nested in the
// first cell, every statement in Icelandic (bold) then English, and the
// TMA's two approach units on the two rows its first cell spans.
func TestNestedBilingualParts(t *testing.T) {
	page := `<table>` + combinedHeader + `
<tr><td rowspan="2"><span class="bold"><strong>FAXI TMA</strong></span><br/><span>FAXI TMA</span>
<table>
<tr><td><span class="bold"><strong>BIKF Aðflug/</strong></span><span>BIKF Approach</span></td></tr>
<tr><td><span>643100N 0224400W 641900N 0222800W 640900N 0223000W 643100N 0224400W</span></td></tr>
<tr><td><span class="bold"><strong>Efri mörk: FL 245</strong></span><span>Upper Limit: FL 245</span></td></tr>
<tr><td><span class="bold"><strong>Neðri mörk / 3000 fet MSL eða 1000 fet yfir jörð, hvort heldur er hærra.</strong></span><span>Lower Limit: 3000 feet MSL or 1000 feet GND whichever is higher.</span></td></tr>
<tr><td><span class="bold"><strong>Flokkur A fyrir ofan FL 195. Flokkur C í eða fyrir neðan FL 195.</strong></span><span>Class A above FL 195. Class C at or below FL 195.</span></td></tr>
<tr><td><span class="bold"><strong>Kraginn 1000a/</strong></span><span>The Collar 1000a</span></td></tr>
<tr><td><span>641533N 0222842W 641811N 0220427W 640748N 0215558W 641533N 0222842W</span></td></tr>
<tr><td><span class="bold"><strong>Efri mörk: 3000 fet MSL</strong></span><span>Upper Limit: 3000 feet MSL</span></td></tr>
<tr><td><span class="bold"><strong>Neðri mörk: 1000 fet MSL</strong></span><span>Lower Limit: 1000 feet MSL</span></td></tr>
<tr><td><span class="bold"><strong>Flokkur D</strong></span><span>Class D</span></td></tr>
</table></td>
<td>ACC Reykjavík</td>
<td><table><tr><td>Keflavík aðflug / Keflavik approach</td></tr>
<tr><td><span class="bold"><strong>Enska/Íslenska /</strong></span><span>English/Icelandic</span></td></tr>
<tr><td><span class="bold"><strong>H24</strong></span></td></tr></table></td>
<td>119.300 MHZ Keflavik Initial</td><td>FAXI TMA is divided into elementary volumes</td></tr>
<tr><td>ACC Reykjavík</td><td>Reykjavík aðflug / Reykjavik approach English H24</td>
<td>VHF 119.000 MHZ Reykjavik Approach</td><td></td></tr>
</table>`
	spec := blockSpec
	spec.IcaoPrefix, spec.IDPrefix, spec.Bilingual = "BI", "IS", true
	got, st := parseBlocks(t, page, spec)
	if len(got) != 2 {
		t.Fatalf("zones = %+v (stats %+v)", got, st)
	}
	bikf, collar := got[0], got[1]
	if bikf.Name != "FAXI TMA BIKF Approach" || bikf.Type != "TMA" || collar.Name != "FAXI TMA The Collar 1000a" {
		t.Errorf("names and types: %q %s, %q", bikf.Name, bikf.Type, collar.Name)
	}
	// The floor is the higher of two; the MSL figure is the one a
	// single limit can state, and the zone is at least that high.
	if limitStr(bikf.UpperLimit) != "245FL" || limitStr(bikf.LowerLimit) != "3000FT" || bikf.LowerLimit.Ref != "MSL" {
		t.Errorf("BIKF limits %+v / %+v", bikf.UpperLimit, bikf.LowerLimit)
	}
	// Class A above FL 195 and C below it is a stack, not class A.
	if bikf.ClassCode != "" || collar.ClassCode != "D" {
		t.Errorf("classes %q %q", bikf.ClassCode, collar.ClassCode)
	}
	if f := freqsOf(bikf); strings.Join(f, " ") != "119.300 119.000" {
		t.Errorf("both approach units, once each: %v", f)
	}
	if bikf.Radio[0].CallSign != "Keflavik approach" || bikf.WorkHr != "H24" {
		t.Errorf("call sign %q, hours %q", bikf.Radio[0].CallSign, bikf.WorkHr)
	}
}

// SMATSA, 2026-09-03: the name, the lateral limits' label, the geometry,
// the vertical limits' label, the pair and the class each on a row of
// their own, the unit beside the geometry, and "and" opening a second
// volume of the same TMA whose class is printed once, after both.
func TestLabelledRowsAndParts(t *testing.T) {
	row := func(c0 string) string {
		return `<tr><td>` + c0 + `</td><td></td><td></td><td></td><td></td></tr>`
	}
	page := `<table>` + combinedHeader +
		row("BEOGRAD TMA") +
		row("BEOGRAD TMA is the airspace defined by:") +
		row("Lateral limits:") +
		`<tr><td>451356N 0192404E - 451412N 0193454E - 450800N 0193000E - 451356N 0192404E</td>` +
		`<td>BEOGRAD ATCC</td><td>BEOGRAD RADAR BEOGRAD PRILAZNA / BEOGRAD APPROACH English, Serbian - H24</td>` +
		`<td>133.100 119.100</td><td></td></tr>` +
		row("Vertical limits:") + row("FL 125 / 1500 FT AGL") +
		row("and") +
		row("Lateral limits:") +
		row("452912N 0190436E - 453421N 0193725E - 453000N 0192000E - 452912N 0190436E") +
		row("Vertical limits:") + row("FL 205 / FL 125") +
		row("Airspace class: C") +
		`</table>`
	got, st := parseBlocks(t, page, blockSpec)
	if len(got) != 2 {
		t.Fatalf("zones = %+v (stats %+v)", got, st)
	}
	for i, want := range [][2]string{{"125FL", "1500FT"}, {"205FL", "125FL"}} {
		a := got[i]
		if a.Name != "BEOGRAD TMA" || a.Type != "TMA" || a.ClassCode != "C" {
			t.Errorf("part %d: %q %s class %q", i, a.Name, a.Type, a.ClassCode)
		}
		if limitStr(a.UpperLimit) != want[0] || limitStr(a.LowerLimit) != want[1] {
			t.Errorf("part %d limits %+v / %+v", i, a.UpperLimit, a.LowerLimit)
		}
		if f := freqsOf(a); strings.Join(f, " ") != "133.100 119.100" || a.Radio[0].CallSign != "BEOGRAD RADAR" {
			t.Errorf("part %d radio %+v", i, a.Radio)
		}
	}
}

// LPS SR, 2026-09-03: the TMA's first cell spans its unit's three rows,
// the second and third of which are ATIS broadcasts.
func TestSpannedRowsAreOneZone(t *testing.T) {
	page := `<table>` + combinedHeader +
		`<tr><td rowspan="3">BRATISLAVA TMA 2 481933N 0165432E 481833N 0170053E 481457N 0170046E 481933N 0165432E ` +
		`5 000 ft AMSL / 2 500 ft AMSL Class of airspace:C</td><td rowspan="3">ŠTEFÁNIK APP</td>` +
		`<td>ŠTEFÁNIK RADAR SK, EN</td><td>134,930 118,980</td><td rowspan="3"></td></tr>` +
		`<tr><td>ATIS ŠTEFÁNIK ARRIVAL EN</td><td>133,880</td></tr>` +
		`<tr><td>ATIS ŠTEFÁNIK DEPARTURE EN H24</td><td>128,655</td></tr>` +
		`</table>`
	got, st := parseBlocks(t, page, blockSpec)
	if len(got) != 1 {
		t.Fatalf("zones = %+v (stats %+v)", got, st)
	}
	if f := freqsOf(got[0]); strings.Join(f, " ") != "134.930 118.980" || got[0].ClassCode != "C" {
		t.Errorf("radio %v, class %q", f, got[0].ClassCode)
	}
}

func TestClassStacks(t *testing.T) {
	cases := []struct{ in, want string }{
		// Each band states its own limits before its class: the first
		// class is the class of the limits the cut keeps.
		{"FL 055/ FL 660 - Class A FL 660/UNL - Class G", "A"},
		// A class bounded by a level is part of a stack.
		{"Class A above FL 195. Class C at or below FL 195.", "A/C"},
		{"Class A fyrir ofan FL 195. Class D at or below FL 195.", "A/D"},
		{"Class C between FL 660 and FL 195 Class G between FL 195 and SFC", "C/G"},
		// An enumeration is not class A.
		{"Airspace class: a) Serbia: - Class C : TMAs", "C"},
		{"Airspace class: C", "C"},
		// Fintraffic gives the class after its band.
		{"AIRSPACE CLASS BTN FL 95 - 2000 FT MSL D", "D"},
		{"AIRSPACE CLASS ABV FL 660 G BTN FL 660 - FL 95 C BLW FL 95 G", "G/C/G"},
	}
	for _, c := range cases {
		if _, got := splitClassPhrase(c.in); got != c.want {
			t.Errorf("splitClassPhrase(%q) letters = %q, want %q", c.in, got, c.want)
		}
	}
	if got := classFromLetters("C/C", NewZoneStats()); got != "C" {
		t.Errorf("one class stated twice = %q", got)
	}
}

// Fintraffic, 2026-08-06: the class closes the cell after the limits,
// which it would otherwise hide from the pair read off the end.
func TestFintrafficComposite(t *testing.T) {
	st := NewZoneStats()
	_, name, _, upper, lower, class := splitIcaoComposite("EFHA TMA (EFHA TMA) Area bounded by lines joining points "+
		"621002N 0250657E - 615152N 0254656E - 613731N 0253018E to point of origin. "+
		"FL 95/2000 FT MSL AIRSPACE CLASS BTN FL 95 - 2000 FT MSL D", "EF", st)
	if name != "EFHA TMA (EFHA TMA)" || limitStr(upper) != "95FL" || limitStr(lower) != "2000FT" || lower.Ref != "MSL" || class != "D" {
		t.Errorf("EFHA TMA: %q %+v / %+v class %q", name, upper, lower, class)
	}
	// "1300 FT MSL SFC": the MSL is the ceiling's reference, not a limit.
	up, lo := ParseVerticalPair("1300 FT MSL SFC")
	if limitStr(up) != "1300FT" || up.Ref != "MSL" || lo == nil || lo.Value != "SFC" {
		t.Errorf("1300 FT MSL SFC = %+v / %+v", up, lo)
	}
	// ... but a flight level takes none: FL 500 over sea level.
	up, lo = ParseVerticalPair("FL 500 MSL")
	if limitStr(up) != "500FL" || lo == nil || lo.Ref != "MSL" || lo.Value != "0" {
		t.Errorf("FL 500 MSL = %+v / %+v", up, lo)
	}
	// ... and a floor at sea level after it is still the floor.
	up, lo = ParseVerticalPair("1000 FT MSL MSL")
	if limitStr(up) != "1000FT" || lo == nil || lo.Ref != "MSL" || lo.Value != "0" {
		t.Errorf("1000 FT MSL MSL = %+v / %+v", up, lo)
	}
}

func TestLimitSpellings(t *testing.T) {
	cases := []struct{ in, want, ref string }{
		{"3000 feet MSL or 1000 feet GND whichever is higher", "3000FT", "MSL"},
		{"F660 (see ENR 2.2.3 RATSU TRIANGLE)", "660FL", "STD"},
		{"Unlimited", "UNL", ""},
	}
	for _, c := range cases {
		v := ParseVLimit(c.in)
		if limitStr(v) != c.want || v.Ref != c.ref {
			t.Errorf("ParseVLimit(%q) = %+v, want %s %s", c.in, v, c.want, c.ref)
		}
	}
	// Iceland's BID8NV1: digits after the letters after the number.
	if d, _, _ := splitIcaoHead("BID8NV1 6441N 02140W 6525N 02100W", "BI"); d != "BID8NV1" {
		t.Errorf("designator = %q", d)
	}
}

func TestEnglishText(t *testing.T) {
	cases := []struct{ html, want string }{
		{`<td><span class="bold"><strong>Efri mörk: FL 245</strong></span><span>Upper Limit: FL 245</span></td>`, "Upper Limit: FL 245"},
		// One language only: read whole.
		{`<td><strong>BID12 Mosfellsbær</strong></td>`, "BID12 Mosfellsbær"},
		{`<td><span class="bold"><strong>Hringur með 60 NM radius</strong></span><span>/ Circle with 60 NM radius</span></td>`, "Circle with 60 NM radius"},
		// A nested table's cells are decided one by one.
		{`<td><table><tr><td>Keflavík aðflug / Keflavik approach</td></tr><tr><td><strong>H24</strong></td></tr></table></td>`,
			"Keflavík aðflug / Keflavik approach H24"},
	}
	for _, c := range cases {
		doc, err := ParseHTML([]byte(`<table><tr>` + c.html + `</tr></table>`))
		if err != nil {
			t.Fatal(err)
		}
		td := FindAll(doc, func(n *Node) bool { return IsElem(n) && n.Data == "td" })[0]
		if got := EnglishText(td); got != c.want {
			t.Errorf("EnglishText(%s) = %q, want %q", c.html, got, c.want)
		}
	}
}

// Avians, 2026-09-03: the BIAR TMA continues the FAXI table in a table of
// its own with no header, both inside a layout table, its parts printed
// "Icelandic / English" in one run.
func TestHeaderlessContinuationTable(t *testing.T) {
	part := func(s string) string { return `<tr><td>` + s + `</td></tr>` }
	page := `<table><tr><td>` +
		`<table>` + combinedHeader +
		`<tr><td><table>` + part("FAXI TMA") +
		part("643100N 0224400W 641900N 0222800W 640900N 0223000W 643100N 0224400W") +
		part("Upper Limit: FL 245") + part("Lower Limit: 3000 feet MSL") + part("Class C") +
		`</table></td><td>ACC Reykjavík</td><td>Keflavik approach</td><td>119.300</td><td></td></tr></table>` +
		`<table><tr><td><table>` + part("BIAR TMA") + part("") +
		part("655152N 0183535W 655016N 0174705W 651845N 0175341W 655152N 0183535W") +
		part("Efri mörk / Upper Limit: 7000 fet MSL / 7000 feet MSL") +
		part("Neðri mörk / Lower Limit: 3 000 fet MSL eða 1 000 fet yfir jörð hvort sem er hærra. / 3 000 feet MSL or 1 000 feet GND whichever is higher.") +
		part("Flokkur D Flokkur E utan þjónustutíma flugstjórnarþjónustu á BIAR Class D Class E outside hours of service at BIAR") +
		`</table></td><td>Akureyri Tower</td><td>Akureyri turn / Akureyri Tower</td><td>VHF: 118.200 MHZ</td><td></td></tr></table>` +
		`</td></tr></table>`
	spec := blockSpec
	spec.IcaoPrefix, spec.IDPrefix, spec.Bilingual = "BI", "IS", true
	got, st := parseBlocks(t, page, spec)
	if len(got) != 2 || got[1].Name != "BIAR TMA" {
		t.Fatalf("zones = %+v (stats %+v)", got, st)
	}
	biar := got[1]
	if biar.Type != "TMA" || biar.ClassCode != "D" || limitStr(biar.UpperLimit) != "7000FT" || limitStr(biar.LowerLimit) != "3000FT" {
		t.Errorf("BIAR TMA: %s class %q %+v / %+v", biar.Type, biar.ClassCode, biar.UpperLimit, biar.LowerLimit)
	}
	if f := freqsOf(biar); len(f) != 1 || f[0] != "118.200" || biar.Radio[0].CallSign != "Akureyri Tower" {
		t.Errorf("BIAR radio %+v", biar.Radio)
	}
}

// Avinor, 2026-09-03: the Oslo TMA's first volume on the row naming it,
// its units on the rows that row's first cell spans, and each further
// volume on a row of its own, its ring, limits and class, nothing beside
// it. Appended to the first, the further volumes were never read.
func TestVolumesOneRowApiece(t *testing.T) {
	empty := `<td></td><td></td><td></td><td></td>`
	page := `<table>` + combinedHeader +
		`<tr><td rowspan="2">Oslo TMA 601909N 0105543E - 602227N 0110033E - 602513N 0110625E - ( 601909N 0105543E ) ` +
		`Upper limit: FL 215 Lower limit: 2500 FT AMSL Class C</td>` +
		`<td rowspan="2">Polaris ACC Oslo</td><td>Director English H24</td><td>136.405 MHZ</td><td></td></tr>` +
		`<tr><td>Oslo Approach English H24</td><td>118.480 MHZ</td><td>Oslo TMA sector E</td></tr>` +
		`<tr><td>601617N 0102144E - 601525N 0105207E - 600820N 0105006E - ( 601617N 0102144E ) ` +
		`Upper limit: FL 215 Lower limit: 3000 FT AMSL Class C</td>` + empty + `</tr>` +
		`<tr><td>594100N 0102830E - 593910N 0104227E - 593732N 0105446E - ( 594100N 0102830E ) ` +
		`Upper limit: FL 215 Lower limit: 5500 FT AMSL Class D</td>` + empty + `</tr>` +
		`<tr><td>Sola TMA 592904N 0043144E - 592500N 0044000E - 590900N 0051200E - ( 592904N 0043144E ) ` +
		`Upper limit: FL 175 Lower limit: 700 FT AMSL Class C</td>` +
		`<td>Sola TWR</td><td>Sola Approach English</td><td>119.605 MHZ</td><td></td></tr>` +
		`</table>`
	got, st := parseBlocks(t, page, blockSpec)
	if len(got) != 4 {
		t.Fatalf("zones = %+v (stats %+v)", got, st)
	}
	for i, want := range []struct {
		name, lower, class string
		lat                float64
		freqs              string
	}{
		{"Oslo TMA", "2500FT", "C", 60.31917, "136.405 118.480"},
		{"Oslo TMA", "3000FT", "C", 60.27139, "136.405 118.480"},
		{"Oslo TMA", "5500FT", "D", 59.68333, "136.405 118.480"},
		{"Sola TMA", "700FT", "C", 59.48444, "119.605"},
	} {
		a := got[i]
		if a.Name != want.name || limitStr(a.LowerLimit) != want.lower || a.ClassCode != want.class {
			t.Errorf("volume %d: %q %+v class %q", i, a.Name, a.LowerLimit, a.ClassCode)
		}
		if len(a.Ring) < 3 || !near(a.Ring[0][0], want.lat) {
			t.Errorf("volume %d ring %v, want it to start at %.5f", i, a.Ring, want.lat)
		}
		if f := strings.Join(freqsOf(a), " "); f != want.freqs {
			t.Errorf("volume %d radio %q, want %q", i, f, want.freqs)
		}
	}
}

// Avinor's ENR 2.2 leads a table with the unit providing service, its
// rows Polaris ACC Oslo's sectors from the ground up: working divisions
// of the controlled airspace, not drawn. As wide as the combined table
// before it, it is no headerless continuation of it either.
func TestUnitLedTableIsSectors(t *testing.T) {
	page := `<table>` + combinedHeader +
		`<tr><td>Finnmark TIA 712000N 0262100E - 712000N 0280000E - 710000N 0300000E - ( 712000N 0262100E ) ` +
		`Upper limit: FL 195 Lower limit: 3500 FT AMSL Class: G</td>` +
		`<td>Polaris ACC Bodø</td><td>Polaris Control English</td><td>126.705 MHZ</td><td></td></tr>` +
		`</table><table>` +
		`<tr><td>Tjenesteyter / Unit providing service</td>` +
		`<td>Lateral utstrekning, Vertikal utstrekning / Lateral limits, Vertical limits</td>` +
		`<td>Kallesignal, Språk / Callsign, Languages</td><td>FREQ</td><td>RMK</td></tr>` +
		`<tr><td>1</td><td>2</td><td>3</td><td>4</td><td>5</td></tr>` +
		`<tr><td>Polaris ACC Oslo</td><td>602247N 0123445E - 602213N 0111045E - 602150N 0105600E - ( 602247N 0123445E ) ` +
		`Upper limit: UNL Lower limit: GND</td><td>Polaris Control English</td><td>118.830 MHZ Sector 1</td>` +
		`<td>Polaris ACC Sector 1</td></tr>` +
		`</table>`
	got, st := parseBlocks(t, page, blockSpec)
	if len(got) != 1 || got[0].Name != "Finnmark TIA" {
		t.Fatalf("zones = %+v (stats %+v)", got, st)
	}
}

// near compares two coordinates to the five decimals the rings keep.
func near(a, b float64) bool { return math.Abs(a-b) < 1e-4 }

// ANS CR, 2026-09-03: CTA 2 PRAHA states its class band by band after the
// limits the bands divide, class E up to FL 95 and C above; MTMA I ČÁSLAV
// writes the military control zone it excepts between its limits and its
// class. Read as the first letter, the whole CTA was class E, and the
// exception hid the MTMA's limits.
func TestClassBandsAndExceptionAfterLimits(t *testing.T) {
	page := `<table>` + combinedHeader +
		`<tr><td>CTA 2 PRAHA 484617.8329N 0135022.4354E - 505214.0557N 0144924.1001E - 493101.7340N 0185103.2694E - ` +
		`484617.8329N 0135022.4354E FL 660 / 1000 ft AGL Class of airspace: E : FL 95 / 1000 ft AGL C : FL 660 / FL 95</td>` +
		`<td>PRAHA ACC</td><td>PRAHA RADAR H24 EN , CZ</td><td>132.890</td><td></td></tr>` +
		`<tr><td>MTMA I ČÁSLAV 501107.99N 0145839.41E - 501108.54N 0150324.04E - 494638.74N 0153113.60E - 501107.99N 0145839.41E ` +
		`FL 95 / 2000 ft AMSL Except MCTR . Class of airspace: D</td>` +
		`<td>ČÁSLAV MAPP</td><td>ČÁSLAV RADAR H24 EN , CZ</td><td>130.280</td><td>If MAPP is out of service, MTMA is deactivated</td></tr>` +
		`</table>`
	spec := blockSpec
	spec.IcaoPrefix = "LK"
	got, st := parseBlocks(t, page, spec)
	if len(got) != 3 {
		t.Fatalf("zones = %+v (stats %+v)", got, st)
	}
	for i, want := range []struct{ name, upper, lower, class string }{
		{"CTA 2 PRAHA", "95FL", "1000FT", "E"},
		{"CTA 2 PRAHA", "660FL", "95FL", "C"},
		{"MTMA I ČÁSLAV", "95FL", "2000FT", "D"},
	} {
		a := got[i]
		if a.Name != want.name || limitStr(a.UpperLimit) != want.upper || limitStr(a.LowerLimit) != want.lower || a.ClassCode != want.class {
			t.Errorf("zone %d: %q %+v / %+v class %q", i, a.Name, a.UpperLimit, a.LowerLimit, a.ClassCode)
		}
	}
	if got[0].LowerLimit.Ref != "SFC" || len(got[1].Radio) != 1 {
		t.Errorf("the E band from 1000 ft AGL, each band on the ACC's channel: %+v, %+v", got[0].LowerLimit, got[1].Radio)
	}
	if rmk := got[2].Rmk; !strings.HasPrefix(rmk, "Except MCTR. If MAPP") {
		t.Errorf("the exception goes to the remarks: %q", rmk)
	}
}

// A zone table with the ATS unit's columns beside the limits reads them
// as ENR 2.1 does, and its remarks from the column so headed: LPS SR's
// ENR 2.2 ATZs ("Name and lateral limits | Vertical limits | FREQ CTAF |
// Callsign | Time of activity | Remark"), whose frequency had been read as
// the remark. NAV Portugal's FIZs carry their limits and class in the
// lateral column ("Lateral Limits Vertical Limits Class of Airspace"),
// the unit's call sign in the next, and "Call-sign" is hyphenated.
func TestColumnarATSColumns(t *testing.T) {
	doc := func(page string) *Node {
		d, err := ParseHTML([]byte(page))
		if err != nil {
			t.Fatal(err)
		}
		return d
	}
	spec := ZoneSpec{Type: func(_, _, name string) string { return "ATZ" }, IDPrefix: "SK", IcaoPrefix: "LZ"}
	sk := doc(`<table><tr><td>Name and lateral limits</td><td>Vertical limits</td><td>FREQ CTAF</td><td>Callsign</td>` +
		`<td>Time of activity</td><td>Remark</td></tr>` +
		`<tr><td>ATZ DUBOVÁ 481859N 0171750E - 481751N 0172156E - 481905N 0171959E - 481859N 0171750E</td>` +
		`<td>4 000 ft AMSL 1) / GND</td><td>123,930</td><td>DUBOVÁ TRAFFIC</td><td>during day</td>` +
		`<td>1) inside lateral limits of BRATISLAVA TMA 1 the upper limit is 1 500 ft AMSL</td></tr></table>`)
	got := ParseIcaoZoneTables(sk, "ENR 2.2", spec, NewZoneStats())
	if len(got) != 1 || strings.Join(freqsOf(got[0]), " ") != "123.930" || got[0].Radio[0].CallSign != "DUBOVÁ TRAFFIC" ||
		!strings.HasPrefix(got[0].Rmk, "1) inside lateral limits") || limitStr(got[0].UpperLimit) != "4000FT" {
		t.Errorf("LPS SR ATZ: %+v", got)
	}
	spec.IDPrefix, spec.IcaoPrefix = "PT", "LP"
	pt := doc(`<table><tr><td>Name</td><td>Lateral Limits Vertical Limits Class of Airspace</td>` +
		`<td>Call-sign Languages Hours of Service</td><td>Frequency</td><td>Remarks</td></tr>` +
		`<tr><td>Castelo Branco FIZ</td><td>395545N 0072455W - 394822N 0072055W - 394603N 0072805W - 395326N 0073206W - ` +
		`395545N 0072455W GND / 2200FT AMSL Class: G</td><td>CASTELO BRANCO INFORMATION EN/PT Daily 0900-1230</td>` +
		`<td>122.555MHZ</td><td>- Radio Mandatory Zone</td></tr></table>`)
	got = ParseIcaoZoneTables(pt, "ENR 2.2", spec, NewZoneStats())
	if len(got) != 1 {
		t.Fatalf("NAV Portugal FIZ: %+v", got)
	}
	a := got[0]
	if limitStr(a.UpperLimit) != "2200FT" || limitStr(a.LowerLimit) != "GND" || a.ClassCode != "G" ||
		strings.Join(freqsOf(a), " ") != "122.555" || a.Radio[0].CallSign != "CASTELO BRANCO INFORMATION" || a.Rmk != "- Radio Mandatory Zone" {
		t.Errorf("NAV Portugal FIZ: %+v / %+v class %q radio %+v rmk %q", a.UpperLimit, a.LowerLimit, a.ClassCode, a.Radio, a.Rmk)
	}
}
