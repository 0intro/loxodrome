package main

import (
	"bufio"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func readFixture(t *testing.T, name string) []string {
	t.Helper()
	f, err := os.Open(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var lines []string
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		lines = append(lines, sc.Text())
	}
	// A fixture that stops short (a line past the buffer) would otherwise
	// read as a shorter table, and the case would pass against evidence it
	// never saw.
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	return lines
}

// rowsFromLines wraps each fixture line as a single-cell row (one column),
// with descending Y so the first line is the top of the table.
func rowsFromLines(lines []string) []prow {
	rows := make([]prow, len(lines))
	for i, ln := range lines {
		rows[i] = prow{y: float64(-i), cells: []cell{{x: 0, text: ln}}}
	}
	return rows
}

func fixtureRows(t *testing.T, name string) []prow {
	return rowsFromLines(readFixture(t, name))
}

func assertBbox(t *testing.T, got, want []float64) {
	t.Helper()
	if len(got) != 4 {
		t.Fatalf("bbox = %v, want 4 values", got)
	}
	for i := range want {
		if math.Abs(got[i]-want[i]) > 1e-4 {
			t.Errorf("bbox[%d] = %v, want %v", i, got[i], want[i])
		}
	}
}

func firstZone(t *testing.T, res geomResult) zone {
	t.Helper()
	if len(res.zones) == 0 {
		t.Fatalf("no zones parsed")
	}
	return res.zones[0]
}

func TestParseGeometryPolygon(t *testing.T) {
	res := parseGeometry(fixtureRows(t, "polygon.txt"), nil)
	if res.source != "pdf-polygon" {
		t.Errorf("source=%q, want pdf-polygon", res.source)
	}
	assertBbox(t, res.bbox, []float64{43.89917, 1.85639, 43.98167, 2.13306})
	if !reflect.DeepEqual(res.fir, []string{"LFBB"}) {
		t.Errorf("fir = %v, want [LFBB]", res.fir)
	}
	z := firstZone(t, res)
	if !reflect.DeepEqual(z.lower, []string{"HEI", "0", "FT"}) {
		t.Errorf("lower = %v, want [HEI 0 FT]", z.lower)
	}
	if !reflect.DeepEqual(z.upper, []string{"HEI", "400", "FT"}) {
		t.Errorf("upper = %v, want [HEI 400 FT]", z.upper)
	}
	if z.geom == nil || z.geom.kind != "polygon" || len(z.geom.ring) < 3 {
		t.Errorf("geom = %+v", z.geom)
	}
}

func TestParseGeometryMixed(t *testing.T) {
	res := parseGeometry(fixtureRows(t, "mixed.txt"), nil)
	if res.source != "pdf-mixed" {
		t.Errorf("source = %q, want pdf-mixed", res.source)
	}
	if len(res.fir) == 0 || res.fir[0] != "LFMM" {
		t.Errorf("fir = %v, want [LFMM ...]", res.fir)
	}
	z := firstZone(t, res)
	if z.geom == nil || z.geom.kind != "polygon" || len(z.geom.ring) < 3 {
		t.Errorf("geom = %+v (arc should be tessellated into the ring)", z.geom)
	}
}

func TestParseGeometryCircle(t *testing.T) {
	res := parseGeometry(fixtureRows(t, "circle.txt"), nil)
	if res.source != "pdf-circle" {
		t.Fatalf("source = %q, want pdf-circle", res.source)
	}
	z := firstZone(t, res)
	if z.geom == nil || z.geom.kind != "circle" {
		t.Fatalf("geom = %+v, want circle", z.geom)
	}
	if math.Abs(z.geom.center[0]-48.84306) > 1e-3 || math.Abs(z.geom.center[1]-3.00278) > 1e-3 {
		t.Errorf("center = %v, want ~[48.84306 3.00278]", z.geom.center)
	}
	if math.Abs(z.geom.radiusM-1482) > 5 {
		t.Errorf("radiusM = %v, want ~1482", z.geom.radiusM)
	}
}

func TestParseGeometryNone(t *testing.T) {
	res := parseGeometry(rowsFromLines([]string{"Modification de la fréquence TWR.", "121.500 MHz"}), nil)
	if res.source != "none" || len(res.zones) != 0 {
		t.Errorf("source=%q zones=%d, want none/0", res.source, len(res.zones))
	}
}

// TestParseGeometryColumns checks the named, column-aware split: a two-column
// table under side-by-side LIMITES LATÉRALES markers becomes two named zones,
// each with its own geometry and per-column vertical limits, not one ring
// zig-zagging between the columns.
func TestParseGeometryColumns(t *testing.T) {
	colA := []string{`44°00'00"N,002°00'00"E`, `44°10'00"N,002°00'00"E`, `44°10'00"N,002°10'00"E`}
	colB := []string{`46°00'00"N,004°00'00"E`, `46°10'00"N,004°00'00"E`, `46°10'00"N,004°10'00"E`}
	rows := []prow{
		{y: 2, cells: []cell{{x: 0, text: "TMA1 X Temporaire"}, {x: 200, text: "TMA2 X Temporaire"}}},
		{y: 1, cells: []cell{{x: 0, text: "LIMITES LATERALES"}, {x: 200, text: "LIMITES LATERALES"}}},
	}
	for i := range colA {
		rows = append(rows, prow{
			y:     float64(-i),
			cells: []cell{{x: 0, text: colA[i]}, {x: 200, text: colB[i]}},
		})
	}
	rows = append(rows,
		prow{y: -10, cells: []cell{{x: 0, text: "LIMITES VERTICALES"}, {x: 200, text: "LIMITES VERTICALES"}}},
		prow{y: -11, cells: []cell{{x: 0, text: "SFC / 2000ft AMSL"}, {x: 200, text: "FL 65"}}},
	)
	res := parseGeometry(rows, nil)
	if len(res.zones) != 2 {
		t.Fatalf("zones = %d, want 2", len(res.zones))
	}
	for i, z := range res.zones {
		if z.geom == nil || z.geom.kind != "polygon" || len(z.geom.ring) != 3 {
			t.Errorf("zone %d geom = %+v, want a 3-vertex polygon", i, z.geom)
		}
	}
	if !reflect.DeepEqual(res.zones[0].upper, []string{"ALT", "2000", "FT"}) {
		t.Errorf("zone 0 upper = %v, want [ALT 2000 FT]", res.zones[0].upper)
	}
	if !reflect.DeepEqual(res.zones[1].upper, []string{"STD", "65", "FL"}) {
		t.Errorf("zone 1 upper = %v, want [STD 65 FL]", res.zones[1].upper)
	}
}

// TestSectionHeadingNotAName checks that the French SUP section headings which
// sit just above the LIMITES marker are not taken as zone names, while a real
// name and a reversed title run (as some SIA PDFs store it) still read.
func TestSectionHeadingNotAName(t *testing.T) {
	for _, h := range []string{"SERVICES RENDUS", "CONDITIONS DE PÉNÉTRATION", "STATUT"} {
		if !isSectionHeading(h) || plausibleName(h) {
			t.Errorf("%q: isSectionHeading/plausibleName = %v/%v, want true/false", h, isSectionHeading(h), plausibleName(h))
		}
	}
	if isSectionHeading("ZRT VILLACOUBLAY") || !plausibleName("ZRT VILLACOUBLAY") {
		t.Errorf("a real name was rejected")
	}
	// A reversed title run -> the un-reversed name; an altitude row -> no title.
	if got := titleCandidate(")48(EGNAROTIZ"); got != "ZITORANGE(84)" {
		t.Errorf("titleCandidate(reversed) = %q, want ZITORANGE(84)", got)
	}
	if got := titleCandidate("ZRT 'Low' X : 1400ft AMSL"); got != "" {
		t.Errorf("titleCandidate(altitude row) = %q, want empty", got)
	}
}

// TestParseGeometryNamesFromTitle covers a single-zone supplement whose only
// near-the-LIMITES name row is the "SERVICES RENDUS" heading: it is rejected and
// the zone takes the document title from the top instead, far above the row
// scan. A document with no usable title leaves the name blank ("Zone 1").
func TestParseGeometryNamesFromTitle(t *testing.T) {
	build := func(titleRow string) []prow {
		rows := []prow{
			{y: 30, cells: []cell{{x: 0, text: "SUP AIP 192/25"}}},
			{y: 29, cells: []cell{{x: 0, text: "Objet : creation d'une zrt."}}},
			{y: 28, cells: []cell{{x: 0, text: titleRow}}},
		}
		for i := 0; i < 8; i++ { // filler prose, so the title is outside the scan
			rows = append(rows, prow{y: float64(20 - i), cells: []cell{{x: 0, text: "ligne de texte descriptif."}}})
		}
		rows = append(rows,
			prow{y: 2, cells: []cell{{x: 0, text: "SERVICES RENDUS"}}},
			prow{y: 1, cells: []cell{{x: 0, text: "LIMITES LATERALES"}}},
		)
		for i, c := range []string{`44°00'00"N,002°00'00"E`, `44°10'00"N,002°00'00"E`, `44°10'00"N,002°10'00"E`} {
			rows = append(rows, prow{y: float64(-i), cells: []cell{{x: 0, text: c}}})
		}
		return append(rows,
			prow{y: -10, cells: []cell{{x: 0, text: "LIMITES VERTICALES"}}},
			prow{y: -11, cells: []cell{{x: 0, text: "SFC / 500ft AMSL"}}},
		)
	}
	if z := firstZone(t, parseGeometry(build("ZRTVILLACOUBLAY"), nil)); z.name != "ZRT VILLACOUBLAY" {
		t.Errorf("name = %q, want %q (from title, not SERVICES RENDUS)", z.name, "ZRT VILLACOUBLAY")
	}
	if z := firstZone(t, parseGeometry(build("plain prose."), nil)); z.name != "" {
		t.Errorf("name = %q, want empty when no title found", z.name)
	}
}

// TestParseGeometryVerticalBandSplit covers a single lateral area whose vertical
// section names two stacked bands ("ZRT 'Low' ..." / "ZRT 'High' ..."): it
// becomes two zones sharing the geometry, each with its own name and band.
func TestParseGeometryVerticalBandSplit(t *testing.T) {
	ring := []string{`44°00'00"N,002°00'00"E`, `44°10'00"N,002°00'00"E`, `44°10'00"N,002°10'00"E`}
	rows := []prow{{y: 2, cells: []cell{{x: 0, text: "LIMITES LATERALES"}}}}
	for i, c := range ring {
		rows = append(rows, prow{y: float64(1 - i), cells: []cell{{x: 0, text: c}}})
	}
	rows = append(rows,
		prow{y: -10, cells: []cell{{x: 0, text: "LIMITES VERTICALES"}}},
		prow{y: -11, cells: []cell{{x: 0, text: "ZRT 'Low' Coulommiers : SFC / 1400ft AMSL"}}},
		prow{y: -12, cells: []cell{{x: 0, text: "ZRT 'High' Coulommiers : 1400ft AMSL / 1700ft AMSL"}}},
	)
	res := parseGeometry(rows, nil)
	if len(res.zones) != 2 {
		t.Fatalf("zones = %d, want 2 (Low + High)", len(res.zones))
	}
	lo, hi := res.zones[0], res.zones[1]
	if lo.name != "ZRT 'Low' Coulommiers" || hi.name != "ZRT 'High' Coulommiers" {
		t.Errorf("names = %q / %q", lo.name, hi.name)
	}
	if !reflect.DeepEqual(lo.lower, []string{"HEI", "0", "FT"}) || !reflect.DeepEqual(lo.upper, []string{"ALT", "1400", "FT"}) {
		t.Errorf("Low band = %v..%v, want [HEI 0 FT]..[ALT 1400 FT]", lo.lower, lo.upper)
	}
	if !reflect.DeepEqual(hi.lower, []string{"ALT", "1400", "FT"}) || !reflect.DeepEqual(hi.upper, []string{"ALT", "1700", "FT"}) {
		t.Errorf("High band = %v..%v, want [ALT 1400 FT]..[ALT 1700 FT]", hi.lower, hi.upper)
	}
	if lo.geom != hi.geom {
		t.Errorf("the two zones should share one lateral geometry")
	}
}

func TestConvertDMS(t *testing.T) {
	cases := []struct {
		deg, min, sec, hemi string
		want                float64
		isLat               bool
	}{
		{"48", "42", "14", "N", 48.703889, true},
		{"001", "52", "39", "E", 1.8775, false},
		{"44", "05", "31.79", "N", 44.092164, true},
		{"043", "53", "57", "N", 43.899167, true},
		{"006", "30", "29", "W", -6.508056, false},
	}
	for _, c := range cases {
		v, isLat, ok := convertDMS(c.deg, c.min, c.sec, c.hemi)
		if !ok {
			t.Errorf("convertDMS(%v) not ok", c)
			continue
		}
		if isLat != c.isLat {
			t.Errorf("convertDMS(%v) isLat=%v, want %v", c, isLat, c.isLat)
		}
		if math.Abs(v-c.want) > 1e-4 {
			t.Errorf("convertDMS(%v) = %v, want %v", c, v, c.want)
		}
	}
}

// A VAC-amending supplement lists reporting points and creates no zone, so the
// whole-document fallback must leave its point table alone (158/2026, 165/2026).
func TestReportingPointDocHasNoZone(t *testing.T) {
	lines := []string{
		"POINTS DE REPORT",
		"Points de compte-rendu:",
		"Points Coordonnées Noms",
		"W 45°29'05\"N-006°31'43\"E Moutiers",
		"N 45°26'35\"N-006°38'50\"E Bozel",
		"NE 45°26'34\"N-006°40'47\"E LeVillard",
		"E 45°24'35\"N-006°41'03\"E ColdelaChal",
	}
	if res := parseGeometry(rowsFromLines(lines), nil); len(res.zones) != 0 {
		t.Errorf("got %d zones, want 0: %+v", len(res.zones), res.zones)
	}
	// The same points under a lateral-limits marker are a boundary, not a table.
	withMarker := append([]string{"ZRT COURCHEVEL", "LIMITES LATÉRALES"}, lines[3:]...)
	if res := parseGeometry(rowsFromLines(withMarker), nil); len(res.zones) != 1 {
		t.Errorf("marker path: got %d zones, want 1", len(res.zones))
	}
}

// A line's prime marks read as ' from one font run and as a raw C0 byte from
// another; 142/2026 prints both forms, its polygon vertices with ' and its
// circle centres with \x19, and both must scan.
func TestScanCoordsPrimeMarks(t *testing.T) {
	cases := map[string]string{
		"ascii": "49�11'26''N-000�51'03''E",
		"c0":    "Cerclede8,1NM(15km)derayoncentr�sur49�11\x1926\x19\x19N-000�51\x1903\x19\x19E",
	}
	for kind, line := range cases {
		toks := scanCoords(line)
		if len(toks) != 2 {
			t.Fatalf("%s: got %d coordinates, want 2", kind, len(toks))
		}
		if !toks[0].isLat || toks[1].isLat {
			t.Errorf("%s: got isLat %v/%v, want true/false", kind, toks[0].isLat, toks[1].isLat)
		}
		if math.Abs(toks[0].val-49.190556) > 1e-4 || math.Abs(toks[1].val-0.850833) > 1e-4 {
			t.Errorf("%s: got [%v %v], want [49.190556 0.850833]", kind, toks[0].val, toks[1].val)
		}
	}
}

func TestPrettifyName(t *testing.T) {
	cases := map[string]string{
		"ZRTYONNE":             "ZRT YONNE",
		"ZRTARMANCONALPHA":     "ZRT ARMANCON ALPHA",
		"ZRTAUBEBRAVO":         "ZRT AUBE BRAVO",
		"ZRTAISNEALPHA":        "ZRT AISNE ALPHA",
		"TMA1LEMANSTemporaire": "TMA 1 LEMANS Temporaire",
		"CTRLEMANSTemporaire":  "CTR LEMANS Temporaire",
		"ZRT SEINE":            "ZRT SEINE",
	}
	for in, want := range cases {
		if got := prettifyName(in); got != want {
			t.Errorf("prettifyName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestResolveRadials(t *testing.T) {
	nav := navaidTable{"TNO": {48.0, 2.0}}
	pts := resolveRadials([]string{"point A RDL090°/10NM DME TNO end"}, nav)
	if len(pts) != 1 {
		t.Fatalf("got %d points, want 1", len(pts))
	}
	// 10 NM due east of (48,2): latitude ~unchanged, longitude increases.
	if math.Abs(pts[0][0]-48.0) > 0.05 || pts[0][1] <= 2.0 {
		t.Errorf("resolved point = %v, want ~east of [48 2]", pts[0])
	}
}

func TestInheritSoleVertical(t *testing.T) {
	// Exactly one zone has a vertical: the others inherit it (048/2025).
	block := []zone{
		{name: "A"},
		{name: "B", lower: []string{"HEI", "0", "FT"}, upper: []string{"ALT", "2000", "FT"}},
		{name: "C"},
	}
	if !inheritSoleVertical(block) {
		t.Fatal("expected inheritance with one stated vertical")
	}
	for _, z := range block {
		if !reflect.DeepEqual(z.upper, []string{"ALT", "2000", "FT"}) || !reflect.DeepEqual(z.lower, []string{"HEI", "0", "FT"}) {
			t.Errorf("%s = %v/%v, want HEI 0 / ALT 2000", z.name, z.lower, z.upper)
		}
	}
	// Two distinct verticals: ambiguous, so no inheritance.
	block2 := []zone{
		{name: "A", upper: []string{"STD", "115", "FL"}},
		{name: "B"},
		{name: "C", upper: []string{"STD", "125", "FL"}},
	}
	if inheritSoleVertical(block2) || block2[1].upper != nil {
		t.Error("expected no inheritance when several verticals are present")
	}
}

// TestParseVerticalsOrder checks the fallback (no-marker) vertical parse orders
// its lower/upper pair by altitude, so a line that prints the ceiling before the
// floor still comes back lower-then-upper (matching the marker path).
func TestParseVerticalsOrder(t *testing.T) {
	for _, line := range []string{"FL115 / SFC", "SFC / FL115"} {
		lower, upper := parseVerticals([]string{line})
		if !reflect.DeepEqual(lower, []string{"HEI", "0", "FT"}) {
			t.Errorf("%q: lower = %v, want [HEI 0 FT] (SFC)", line, lower)
		}
		if !reflect.DeepEqual(upper, []string{"STD", "115", "FL"}) {
			t.Errorf("%q: upper = %v, want [STD 115 FL]", line, upper)
		}
	}
}

func TestAltTokens(t *testing.T) {
	cases := []struct {
		name string
		line string
		want [][]string
	}{
		{"UNL is the explicit unlimited triple, not FL660",
			"FL395 / UNL", [][]string{{"STD", "395", "FL"}, {"UNL", "", ""}}},
		{"uppercase FT accepted (Word PDFs)",
			"800 FT ASFC / 6500 FT AMSL", [][]string{{"HEI", "800", "FT"}, {"ALT", "6500", "FT"}}},
		{"one and two digit values accepted",
			"50 ft ASFC", [][]string{{"HEI", "50", "FT"}}},
		{"bare feet default to AMSL",
			"2500 ft", [][]string{{"ALT", "2500", "FT"}}},
		{"French prose surface reference normalizes to ASFC",
			"1000 ft au-dessus de la surface", [][]string{{"HEI", "1000", "FT"}}},
		{"the /sol shorthand too",
			"500 ft/sol", [][]string{{"HEI", "500", "FT"}}},
		{"a lone SFC stays the surface sentinel",
			"SFC", [][]string{{"HEI", "0", "FT"}}},
	}
	for _, c := range cases {
		if got := altTokens(c.line); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: altTokens(%q) = %v, want %v", c.name, c.line, got, c.want)
		}
	}
}

func TestSingleVerticalTokenRole(t *testing.T) {
	// A lone SFC can only be a floor (ZRT BUCK ALPHA 1 used to get upper =
	// 0 ft with no lower); any other lone token stays the ceiling.
	lower, upper := parseVerticals([]string{"SFC"})
	if !reflect.DeepEqual(lower, []string{"HEI", "0", "FT"}) || upper != nil {
		t.Errorf("lone SFC: got lower=%v upper=%v, want the surface floor only", lower, upper)
	}
	lower, upper = parseVerticals([]string{"2000 ft AMSL"})
	if lower != nil || !reflect.DeepEqual(upper, []string{"ALT", "2000", "FT"}) {
		t.Errorf("lone ceiling: got lower=%v upper=%v, want upper only", lower, upper)
	}
}

func TestMinMaxVerticalUNL(t *testing.T) {
	// UNL must order as +Inf whatever the print order.
	lower, upper := minMaxVertical([][]string{{"UNL", "", ""}, {"STD", "395", "FL"}})
	if !reflect.DeepEqual(lower, []string{"STD", "395", "FL"}) {
		t.Errorf("lower = %v, want [STD 395 FL]", lower)
	}
	if !reflect.DeepEqual(upper, []string{"UNL", "", ""}) {
		t.Errorf("upper = %v, want [UNL  ]", upper)
	}
}

func TestParseLieuMultibyte(t *testing.T) {
	// Runes whose uppercase form is longer in UTF-8 (U+0250 2 bytes ->
	// U+2C6F 3 bytes) used to shift the FIR offset past the end of the
	// original line and panic; the ASCII-only fold keeps offsets aligned.
	fir, adhp := parseLieu([]string{"ɐɐɐɐɐɐɐɐɐɐ FIR LFBB - AD LFBD"})
	if !reflect.DeepEqual(fir, []string{"LFBB"}) {
		t.Errorf("fir = %v, want [LFBB]", fir)
	}
	if !reflect.DeepEqual(adhp, []string{"LFBD"}) {
		t.Errorf("adhp = %v, want [LFBD]", adhp)
	}
}

// TestArcCellCentreAndLeadVertex mirrors SUP AIP 170/2026, whose two columns
// each wrap an arc differently: the left column's circle centre breaks between
// its latitude and its longitude, and the right column prints the zone's first
// vertex ahead of "arc horaire ... de rayon", with "centré sur <DMS>" on the
// next row. Taking the first coordinate on an arc line as the centre lost that
// vertex and pulled the boundary in to the centre of the arc.
func TestArcCellCentreAndLeadVertex(t *testing.T) {
	rows := []prow{
		{y: 6, cells: []cell{{x: 0, text: "ZRT CABOURG 1"}, {x: 300, text: "ZRT CABOURG 2"}}},
		{y: 5, cells: []cell{{x: 0, text: "LIMITES LATERALES"}, {x: 300, text: "LIMITES LATERALES"}}},
		{y: 4, cells: []cell{
			{x: 0, text: `Cercle de 4 Nm de Rayon centré sur 49°17'40N-`},
			{x: 300, text: `49°15'55"N,000°15'46"W arc horaire de 6 Nm de rayon`},
		}},
		{y: 3, cells: []cell{
			{x: 0, text: `000°07'00W`},
			{x: 300, text: `centré sur 49°17'40"N,000°07'00"W`},
		}},
		{y: 2, cells: []cell{{x: 300, text: `49°19'25"N,000°01'46"E`}}},
		{y: 1, cells: []cell{{x: 300, text: `49°15'36"N,000°03'35"E`}}},
		{y: 0, cells: []cell{{x: 300, text: `49°12'05"N,000°13'59"W`}}},
		{y: -1, cells: []cell{{x: 300, text: `49°15'55"N,000°15'46"W`}}},
		{y: -2, cells: []cell{{x: 0, text: "LIMITES VERTICALES"}, {x: 300, text: "LIMITES VERTICALES"}}},
		{y: -3, cells: []cell{{x: 0, text: "SFC / 3500ft AMSL"}, {x: 300, text: "SFC / FL060"}}},
	}
	res := parseGeometry(rows, nil)
	if len(res.zones) != 2 {
		t.Fatalf("zones = %d, want 2 (the circle column was dropped)", len(res.zones))
	}

	// The circle: its centre survives the row break between lat and lon.
	c := res.zones[0]
	if c.geom == nil || c.geom.kind != "circle" {
		t.Fatalf("zone 0 geom = %+v, want circle", c.geom)
	}
	if math.Abs(c.geom.center[0]-49.29444) > 1e-4 || math.Abs(c.geom.center[1]+0.11667) > 1e-4 {
		t.Errorf("circle centre = %v, want ~[49.29444 -0.11667]", c.geom.center)
	}
	if math.Abs(c.geom.radiusM-7408) > 5 {
		t.Errorf("circle radiusM = %v, want ~7408 (4 NM)", c.geom.radiusM)
	}

	// The polygon: the arc is tessellated between the two vertices that sit on
	// it, and its centre is never a boundary point.
	p := res.zones[1]
	if p.geom == nil || p.geom.kind != "polygon" {
		t.Fatalf("zone 1 geom = %+v, want polygon", p.geom)
	}
	if len(p.geom.ring) < 20 {
		t.Errorf("ring = %d points, want the 6 NM arc tessellated in", len(p.geom.ring))
	}
	for _, v := range p.geom.ring {
		if math.Abs(v[0]-49.29444) < 1e-3 && math.Abs(v[1]+0.11667) < 1e-3 {
			t.Errorf("ring passes through the arc centre %v", v)
			break
		}
	}
	// The arc bulges 6 NM north of its centre, well past every listed vertex.
	assertBbox(t, p.bbox, []float64{49.20139, -0.2698, 49.39431, 0.05972})
}

// TestSpliceArcClosingEdge: an arc that joins the ring's last vertex back to
// its first belongs at the end of the ring. Splicing it as if it were an
// interior edge appended the whole ring a second time; the doubled ring
// self-intersects, so 002/2026 (ZRT MEUCON) was dropped outright and
// 055/2026 (ZRT SOFIA 2 HIGH) drew its boundary traced twice.
func TestSpliceArcClosingEdge(t *testing.T) {
	center := latlon{43.775556, 7.081389}
	verts := []latlon{
		{43.789061, 6.966978}, // 5 NM from the centre
		{43.824297, 6.492339},
		{43.728056, 6.669722},
		{43.698728, 7.040944}, // 5 NM from the centre
	}
	ring := append([]latlon(nil), verts...)
	if n := spliceArcs(&ring, []arcSpec{{center: center, radiusM: 9260, clockwise: true}}); n != 1 {
		t.Fatalf("spliced %d arcs, want 1", n)
	}
	if len(ring) <= len(verts) {
		t.Fatalf("ring = %d points, want the arc tessellated in", len(ring))
	}
	for i, v := range verts {
		n := 0
		for _, p := range ring {
			if p == v {
				n++
			}
		}
		if n != 1 {
			t.Errorf("vertex %d appears %d times, want once (the ring was doubled)", i, n)
		}
	}
	for i, v := range verts {
		if ring[i] != v {
			t.Errorf("ring[%d] = %v, want %v (the listed vertices lead)", i, ring[i], v)
		}
	}
}
