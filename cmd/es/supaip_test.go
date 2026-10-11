package main

import (
	"math"
	"strings"
	"testing"
	"time"

	"github.com/0intro/loxodrome/internal/eaip"
)

const supTestdata = "testdata/supaip"

func loadSupFixture(t *testing.T) (*esCorpus, []esListingRow) {
	t.Helper()
	c, rows, err := acquireEsSupOffline(supTestdata)
	if err != nil {
		t.Fatalf("acquireEsSupOffline: %v", err)
	}
	return c, rows
}

func buildFixture(t *testing.T) (EsSupArtifact, EsSupMeta) {
	t.Helper()
	c, rows := loadSupFixture(t)
	art, meta, err := buildEsSupaip(c, rows, func() time.Time { return time.Unix(0, 0).UTC() }, 1, 1000)
	if err != nil {
		t.Fatalf("buildEsSupaip: %v", err)
	}
	return art, meta
}

// rowByTitle returns one built row as a field-name map.
func rowByTitle(t *testing.T, art EsSupArtifact, title string) map[string]any {
	t.Helper()
	for _, r := range art.Rows {
		cells, ok := r.([]any)
		if !ok || len(cells) != len(art.Fields) {
			t.Fatalf("row is not %d cells", len(art.Fields))
		}
		if cells[1] == title {
			m := map[string]any{}
			for i, f := range art.Fields {
				m[f] = cells[i]
			}
			return m
		}
	}
	t.Fatalf("no row titled %q", title)
	return nil
}

func zonesOf(t *testing.T, row map[string]any) []map[string]any {
	t.Helper()
	raw, _ := row["zones"].([]any)
	out := make([]map[string]any, 0, len(raw))
	for _, z := range raw {
		m, ok := z.(map[string]any)
		if !ok {
			t.Fatalf("zone is not an object")
		}
		out = append(out, m)
	}
	return out
}

func ringOf(t *testing.T, z map[string]any) [][2]float64 {
	t.Helper()
	g, _ := z["geometry"].(map[string]any)
	raw, ok := g["ring"].([]any)
	if !ok {
		t.Fatalf("zone %v has no ring", z["name"])
	}
	out := make([][2]float64, 0, len(raw))
	for _, p := range raw {
		pt, ok := p.([2]float64)
		if !ok {
			t.Fatalf("ring point is not a pair")
		}
		out = append(out, pt)
	}
	return out
}

// TestSupOutputFields pins the shared row schema: the SPA decodes fr, be
// and es with one positional decoder, so a reordering here is a silent
// corruption there.
func TestSupOutputFields(t *testing.T) {
	want := []string{
		"id", "title", "region", "descriptionFr", "descriptionEn", "lieu",
		"urlPdf", "validFrom", "validTo", "ifr", "vfr", "airac", "fir", "adhp",
		"zones", "bbox", "geometrySource", "parseConfidence", "warnings",
		"urlPdfEn", "contacts", "penetration", "manager",
	}
	if len(esSupOutputFields) != len(want) {
		t.Fatalf("field count %d, want %d", len(esSupOutputFields), len(want))
	}
	for i := range want {
		if esSupOutputFields[i] != want[i] {
			t.Errorf("field %d = %q, want %q", i, esSupOutputFields[i], want[i])
		}
	}
}

// TestListingRows pins the listing contract: ids, verbatim hrefs (the
// AIRAC infix, the inconsistent zero-padding, the English-only rows), the
// in-force / upcoming split and the EN join.
func TestListingRows(t *testing.T) {
	_, rows := loadSupFixture(t)
	byTitle := map[string]esListingRow{}
	for _, r := range rows {
		byTitle[r.title()] = r
	}

	r182, ok := byTitle["182/2026"]
	if !ok {
		t.Fatal("182/2026 missing from the listing")
	}
	if got := r182.id(); got != "es-2026-182" {
		t.Errorf("id = %q, want es-2026-182", got)
	}
	if want := esAipBase + "contenido_SUP/LE_SUP_2026_182_es.html"; r182.urlEs != want {
		t.Errorf("urlEs = %q, want %q", r182.urlEs, want)
	}
	if want := esAipBase + "contenido_SUP/LE_SUP_2026_182_es.pdf"; r182.pdfEs != want {
		t.Errorf("pdfEs = %q, want %q", r182.pdfEs, want)
	}
	if r182.subjectEs == "" || r182.subjectEn == "" {
		t.Errorf("182/2026 lost a subject: es=%q en=%q", r182.subjectEs, r182.subjectEn)
	}

	// The AIRAC infix is part of the file name and cannot be derived.
	r149 := byTitle["149/2026"]
	if want := esAipBase + "contenido_SUP/LE_SUP_A_2026_149_es.html"; r149.urlEs != want {
		t.Errorf("149 urlEs = %q, want %q", r149.urlEs, want)
	}
	if !r149.airac {
		t.Error("149/2026 should be flagged AIRAC")
	}
	if r149.inForce {
		t.Error("149/2026 is listed FUTURO, should not be in force")
	}
	if r149.wef != "2026-10-01" {
		t.Errorf("149 wef = %q, want 2026-10-01", r149.wef)
	}

	// Zero-padding is inconsistent in the source: 03 here, 095 there.
	r03 := byTitle["003/2026"]
	if want := esAipBase + "contenido_SUP/LE_SUP_2026_03_es.html"; r03.urlEs != want {
		t.Errorf("003 urlEs = %q, want %q", r03.urlEs, want)
	}
	if !r03.inForce {
		t.Error("003/2026 is listed EN VIGOR")
	}

	// A supplement published in English only still ships, with no
	// Spanish edition to link.
	r135 := byTitle["135/2026"]
	if r135.urlEs != "" {
		t.Errorf("135/2026 has no Spanish edition, got urlEs %q", r135.urlEs)
	}
	if want := esAipBase + "contenido_SUP/LE_SUP_A_2026_135_en.html"; r135.urlEn != want {
		t.Errorf("135 urlEn = %q, want %q", r135.urlEn, want)
	}
	if r135.bodyURL() != r135.urlEn {
		t.Errorf("135 bodyURL = %q, want the English edition", r135.bodyURL())
	}

	// The oldest supplements have no HTML edition at all: the body comes
	// from the PDF.
	r152 := byTitle["152/2020"]
	if r152.urlEs != "" || r152.urlEn != "" {
		t.Errorf("152/2020 should have no HTML edition")
	}
	if want := esAipBase + "contenido_SUP/LE_SUP_2020_152_en.pdf"; r152.bodyURL() != want {
		t.Errorf("152 bodyURL = %q, want %q", r152.bodyURL(), want)
	}
}

// TestZonesFromOrderedList covers the 182 shape: an <h4> naming the zone
// and stating its vertical limits, then an ordered vertex list.
func TestZonesFromOrderedList(t *testing.T) {
	art, _ := buildFixture(t)
	row := rowByTitle(t, art, "182/2026")
	zones := zonesOf(t, row)
	if len(zones) != 3 {
		t.Fatalf("182/2026: %d zones, want 3", len(zones))
	}
	names := []string{"ZONA 1", "ZONA 2", "CAJA DE ESPERA"}
	for i, want := range names {
		if zones[i]["name"] != want {
			t.Errorf("zone %d name = %v, want %q", i, zones[i]["name"], want)
		}
	}
	// The heading carries the vertical spec: "ZONA 1: SFC - 4000 ft AMSL MAX:".
	assertTriple(t, zones[0]["lower"], "HEI", "0", "FT")
	assertTriple(t, zones[0]["upper"], "ALT", "4000", "FT")
	assertTriple(t, zones[2]["upper"], "ALT", "3000", "FT")

	if got := row["validFrom"]; got != "2026-09-03" {
		t.Errorf("validFrom = %v, want 2026-09-03", got)
	}
	if got := row["validTo"]; got != "2026-09-21" {
		t.Errorf("validTo = %v, want 2026-09-21", got)
	}
}

// TestSemicirclePolygonized pins the arc reconstruction: ENAIRE states a
// semicircle as a centre, the two ends of its diameter and a third point
// naming the half meant. Every vertex must land on the stated radius and
// on the correct side.
func TestSemicirclePolygonized(t *testing.T) {
	art, _ := buildFixture(t)
	for _, title := range []string{"182/2026", "135/2026"} {
		row := rowByTitle(t, art, title)
		zones := zonesOf(t, row)
		if len(zones) != 3 {
			t.Fatalf("%s: %d zones, want 3", title, len(zones))
		}
		ring := ringOf(t, zones[1])
		if len(ring) < 20 {
			t.Fatalf("%s: semicircle has %d points, want a resolved arc", title, len(ring))
		}
		centre := [2]float64{41.07166, 1.13223} // 410417.97N 0010756.02E
		for _, p := range ring {
			nm := distanceM(centre, p) / 1852
			if math.Abs(nm-6) > 0.05 {
				t.Errorf("%s: vertex %v at %.3f NM, want 6 NM", title, p, nm)
			}
			if p[0] > centre[0]+1e-4 {
				t.Errorf("%s: vertex %v lies north of the centre; the published half is the southern one", title, p)
			}
		}
		if ring[0] != ring[len(ring)-1] {
			t.Errorf("%s: semicircle ring is not closed", title)
		}
	}
}

// TestProcedureAnnexNotHarvested is the load-bearing one. An AIRAC
// supplement carries instrument-procedure annexes whose tables print
// waypoint and navaid coordinates; turning any of them into airspace
// would put an invented zone on a navigation map.
func TestProcedureAnnexNotHarvested(t *testing.T) {
	art, _ := buildFixture(t)
	row := rowByTitle(t, art, "149/2026")
	zones := zonesOf(t, row)
	if len(zones) != 4 {
		t.Fatalf("149/2026: %d zones, want exactly the 4 reserved areas", len(zones))
	}
	wantNames := []string{"DFN-26 ZONA E", "DFN-26 ZONA C", "DFN-26 ZONA W", "DFN-26 ZONA N"}
	for i, want := range wantNames {
		if zones[i]["name"] != want {
			t.Errorf("zone %d = %v, want %q", i, zones[i]["name"], want)
		}
	}
	// Points that appear ONLY in the annexes.
	annex := map[string][2]float64{
		"LULER":        {40.91397, -3.37833}, // 405450.3N 0032242.0W
		"DVOR/DME SIE": {41.15169, -3.60467}, // 410906.1N 0033616.8W
		"MD730":        {40.97233, -3.66739}, // 405820.4N 0034002.6W
	}
	for _, z := range zones {
		for _, p := range ringOf(t, z) {
			for name, bad := range annex {
				if math.Abs(p[0]-bad[0]) < 1e-3 && math.Abs(p[1]-bad[1]) < 1e-3 {
					t.Errorf("zone %v contains the procedure-annex point %s (%v)", z["name"], name, p)
				}
			}
		}
	}
	assertTriple(t, zones[0]["upper"], "STD", "100", "FL")
	assertTriple(t, zones[1]["upper"], "STD", "120", "FL")
	assertTriple(t, zones[2]["upper"], "STD", "080", "FL")

	warns := warningsOf(t, row)
	if !warns["exclusion-not-modeled"] {
		t.Error("the Observaciones exclusion circles must be reported, not silently dropped")
	}
	// The body states 28SEP26 while the listing announces WEF 01-OCT-26.
	if !warns["wef-mismatch"] {
		t.Error("the body/listing date disagreement must be recorded")
	}
	if row["validFrom"] != "2026-09-28" {
		t.Errorf("validFrom = %v, want the body's own 2026-09-28", row["validFrom"])
	}
	if got, _ := row["fir"].([]string); len(got) != 1 || got[0] != "LECM" {
		t.Errorf("fir = %v, want [LECM] from \"en FIR/UIR Madrid\"", row["fir"])
	}
}

// TestLateralMarkerAndMetreHeights covers the 095 shape: bold "Limites
// laterales:" / "Limites verticales:" markers with the values in the
// following paragraphs, and an upper limit published in metres.
func TestLateralMarkerAndMetreHeights(t *testing.T) {
	art, _ := buildFixture(t)
	row := rowByTitle(t, art, "095/2026")
	zones := zonesOf(t, row)
	if len(zones) != 1 {
		t.Fatalf("095/2026: %d zones, want 1", len(zones))
	}
	ring := ringOf(t, zones[0])
	if len(ring) != 6 {
		t.Fatalf("ring has %d points, want the 6 published vertices (closed)", len(ring))
	}
	assertTriple(t, zones[0]["lower"], "HEI", "0", "FT")
	assertTriple(t, zones[0]["upper"], "HEI", "120", "M")
	if got, _ := row["adhp"].([]string); len(got) != 1 || got[0] != "LEAS" {
		t.Errorf("adhp = %v, want [LEAS]", row["adhp"])
	}
	// "14MAY26/14MAY27EST" on a supplement the listing carries IN FORCE:
	// the estimate is no end date (ENAIRE keeps such a supplement listed
	// past it and delisting is the kill signal), so the row reads
	// open-ended; the marker itself is counted in the meta, never a row
	// warning.
	if row["validTo"] != nil {
		t.Errorf("validTo = %v, want nil (open until delisted)", row["validTo"])
	}
}

// TestEstimatedEndStaysOnUpcoming: the same EST marker on a row the
// listing announces as FUTURE keeps its date (nothing is in force yet;
// the next build, once it is, opens it).
func TestEstimatedEndStaysOnUpcoming(t *testing.T) {
	c, rows := loadSupFixture(t)
	for i := range rows {
		if rows[i].title() == "095/2026" {
			rows[i].inForce = false
		}
	}
	art, _, err := buildEsSupaip(c, rows, func() time.Time { return time.Unix(0, 0).UTC() }, 1, 1000)
	if err != nil {
		t.Fatalf("buildEsSupaip: %v", err)
	}
	if got := rowByTitle(t, art, "095/2026")["validTo"]; got != "2027-05-14" {
		t.Errorf("validTo = %v, want 2027-05-14 on an upcoming supplement", got)
	}
}

// TestDocsMissingGate: a listing whose documents could not be fetched
// must not publish (the listing count alone would pass the window while
// every reservation vanished from the overlay).
func TestDocsMissingGate(t *testing.T) {
	c, rows := loadSupFixture(t)
	dropped := 0
	for _, r := range rows {
		if dropped < 2 {
			delete(c.docs, pathBase(r.bodyURL()))
			dropped++
		}
	}
	if _, _, err := buildEsSupaip(c, rows, nil, 1, 1000); err == nil {
		t.Fatal("two of seven documents missing must refuse the build")
	}
}

func pathBase(u string) string {
	if i := strings.LastIndex(u, "/"); i >= 0 {
		return u[i+1:]
	}
	return u
}

// supDoc parses one synthetic supplement page through the same path the
// HTML editions take.
func supDoc(t *testing.T, body, subject string) esBody {
	t.Helper()
	doc, err := eaip.ParseHTML([]byte("<html><body><main>" + body + "</main></body></html>"))
	if err != nil {
		t.Fatalf("ParseHTML: %v", err)
	}
	return parseSupDocument(blocksFromHTML(doc), docText(doc), subject)
}

func hasWarning(ws []string, w string) bool {
	for _, x := range ws {
		if x == w {
			return true
		}
	}
	return false
}

// TestCorridorBuffered: "N NM a cada lado de la linea" makes the
// vertices that follow a CENTRELINE, buffered on both sides, never a
// ring (147/2026's TC ETAP SAN GREGORIO used to draw as a triangle whose
// interior lay outside the real band).
func TestCorridorBuffered(t *testing.T) {
	b := supDoc(t, `<h4>TC ETAP SAN GREGORIO (LETAPSGT)</h4>
<p>2 NM a cada lado de la l&iacute;nea que une las siguientes coordenadas:</p>
<p>414500N 0010000W</p><p>414500N 0005000W</p><p>413500N 0004500W</p>
<p>L&iacute;mites verticales: SFC - 3000 ft AMSL</p>`, "TC")
	if len(b.zones) != 1 {
		t.Fatalf("zones = %d, want 1; warnings %v", len(b.zones), b.warnings)
	}
	z := b.zones[0]
	if z.source != "html-corridor" {
		t.Errorf("source = %s, want html-corridor", z.source)
	}
	ring, _ := z.geom["ring"].([]any)
	if len(ring) < 12 {
		t.Fatalf("ring has %d points, want the offset lines, mitre, arc and caps", len(ring))
	}
	// Every ring point sits about one half-width from the centreline, no
	// further: the buffer, not a hull over the vertices.
	line := [][2]float64{{41.75, -1}, {41.75, -0.8333333}, {41.5833333, -0.75}}
	half := 2 * 1852.0
	for _, p := range ring {
		pt := p.([2]float64)
		d := math.Inf(1)
		for i := 0; i+1 < len(line); i++ {
			d = math.Min(d, distToSegmentM(pt, line[i], line[i+1]))
		}
		if d > half*1.05 || d < half*0.5 {
			t.Errorf("ring point %v is %.0f m off the centreline, want about %.0f", pt, d, half)
		}
	}
	// The centreline's own vertices lie inside the buffer's bbox.
	for _, v := range line {
		if v[0] < z.bbox[0] || v[0] > z.bbox[2] || v[1] < z.bbox[1] || v[1] > z.bbox[3] {
			t.Errorf("centreline vertex %v outside the corridor bbox %v", v, z.bbox)
		}
	}
	if hasWarning(b.warnings, "ring-self-intersecting") {
		t.Error("the corridor ring must be simple")
	}
}

// distToSegmentM is the planar distance from p to the segment a-b, in
// metres, good enough at this scale for a test.
func distToSegmentM(p, a, b [2]float64) float64 {
	cosLat := math.Cos(a[0] * math.Pi / 180)
	ax, ay := 0.0, 0.0
	bx, by := (b[1]-a[1])*cosLat, b[0]-a[0]
	px, py := (p[1]-a[1])*cosLat, p[0]-a[0]
	l2 := (bx-ax)*(bx-ax) + (by-ay)*(by-ay)
	tt := 0.0
	if l2 > 0 {
		tt = math.Max(0, math.Min(1, ((px-ax)*(bx-ax)+(py-ay)*(by-ay))/l2))
	}
	cx, cy := ax+tt*(bx-ax), ay+tt*(by-ay)
	return math.Hypot(px-cx, py-cy) * 111320
}

// TestCorridorTooShort: a corridor sentence followed by one vertex has
// no centreline; refused with its own warning, never a point.
func TestCorridorTooShort(t *testing.T) {
	b := supDoc(t, `<h4>AEROV&Iacute;A</h4><p>5 NM a cada lado de la l&iacute;nea:</p><p>414500N 0010000W</p>
<p>L&iacute;mites verticales: SFC - FL100</p>`, "TC")
	if len(b.zones) != 0 || !hasWarning(b.warnings, "corridor-too-short") {
		t.Errorf("zones %d, warnings %v; want none and corridor-too-short", len(b.zones), b.warnings)
	}
}

// TestRadiusReadsBesideTheWord: the figure next to "radio" wins over the
// first number-and-unit in the paragraph, and an implausible radius is
// refused.
func TestRadiusReadsBesideTheWord(t *testing.T) {
	cases := []struct {
		in   string
		want float64
		ok   bool
	}{
		{"hasta 120 m agl, en un circulo de 1 km de radio", 1000, true},
		{"circle with a radius of 6 nm centred on", 6 * 1852, true},
		{"circulo de 500 m de radio", 500, true},
		{"1.852 km", 0, false},
		{"circulo de 80 km de radio", 0, false},
	}
	for _, c := range cases {
		got, ok := parseRadiusM(fold(c.in))
		if ok != c.ok || (ok && math.Abs(got-c.want) > 0.5) {
			t.Errorf("parseRadiusM(%q) = %v, %v; want %v, %v", c.in, got, ok, c.want, c.ok)
		}
	}
}

// TestCircleUnreadableNotHarvested: a circle phrase the grammar cannot
// read is warned and skipped; its centre never joins a ring.
func TestCircleUnreadableNotHarvested(t *testing.T) {
	b := supDoc(t, `<h4>ZONA X: SFC - 1000 ft AMSL:</h4>
<p>C&iacute;rculo de 999 KM de radio centrado en 402637N 0034414W</p>
<p>402700N 0034400W</p><p>402600N 0034300W</p>`, "ZONA")
	if !hasWarning(b.warnings, "circle-unreadable") {
		t.Errorf("warnings %v, want circle-unreadable", b.warnings)
	}
	for _, z := range b.zones {
		if ring, ok := z.geom["ring"].([]any); ok && len(ring) > 3 {
			t.Errorf("the unreadable circle's centre joined a ring: %v", ring)
		}
	}
}

// TestBulletsRingOnlyWithLateralMarker: a <ul> is a set of positions,
// never a boundary, even under a scope stating vertical limits; only an
// explicit lateral-limits marker makes its items vertices.
func TestBulletsRingOnlyWithLateralMarker(t *testing.T) {
	list := `<ul><li>414500N 0010000W</li><li>414500N 0005000W</li><li>413500N 0004500W</li></ul>`
	bare := supDoc(t, `<h4>ZONA: SFC - 3000 ft AMSL:</h4>`+list, "ZONA")
	if len(bare.zones) != 0 {
		t.Errorf("bulleted positions under a vertical extent became %d zone(s)", len(bare.zones))
	}
	marked := supDoc(t, `<h4>ZONA: SFC - 3000 ft AMSL:</h4><p><strong>L&iacute;mites laterales:</strong></p>`+list, "ZONA")
	if len(marked.zones) != 1 {
		t.Errorf("bulleted vertices under a lateral marker gave %d zone(s), want 1", len(marked.zones))
	}
}

// TestExclusionClosesTheRun: a vertex paragraph after an exclusion must
// not extend the ring across it.
func TestExclusionClosesTheRun(t *testing.T) {
	b := supDoc(t, `<h4>ZONA: SFC - 3000 ft AMSL:</h4><p>L&iacute;mites laterales:</p>
<p>414500N 0010000W</p><p>414500N 0005000W</p><p>413500N 0004500W</p>
<p>Excepto un c&iacute;rculo de 1 KM de radio centrado en 414000N 0005500W</p>
<p>413000N 0010000W</p>`, "ZONA")
	if len(b.zones) != 1 {
		t.Fatalf("zones = %d, want 1; warnings %v", len(b.zones), b.warnings)
	}
	ring, _ := b.zones[0].geom["ring"].([]any)
	if len(ring) != 4 {
		t.Errorf("ring has %d points, want the 3 published vertices (closed)", len(ring))
	}
	if !hasWarning(b.warnings, "exclusion-not-modeled") {
		t.Errorf("warnings %v, want exclusion-not-modeled", b.warnings)
	}
}

// TestBoldVertexLineIsNoHeading: a vertex paragraph set in bold is a
// vertex, not a zone heading that would cut the ring in two.
func TestBoldVertexLineIsNoHeading(t *testing.T) {
	b := supDoc(t, `<h4>ZONA: SFC - 3000 ft AMSL:</h4><p>L&iacute;mites laterales:</p>
<p>414500N 0010000W</p><p><strong>414500N 0005000W</strong></p><p>413500N 0004500W</p>`, "ZONA")
	if len(b.zones) != 1 {
		t.Fatalf("zones = %d, want 1; warnings %v", len(b.zones), b.warnings)
	}
	if ring, _ := b.zones[0].geom["ring"].([]any); len(ring) != 4 {
		t.Errorf("ring has %d points, want 3 vertices (closed)", len(ring))
	}
}

// TestObstacleTableTolerance: the source's own HTG typo, decimal-comma
// seconds and a space before the hemisphere letter all read; the name
// column skips time / date / elevation columns; a table whose rows read
// nothing is warned.
func TestObstacleTableTolerance(t *testing.T) {
	b := supDoc(t, `<h4>PARQUE E&Oacute;LICO</h4><table>
<tr><th>ID</th><th>COORDENADAS</th><th>ELEV (m)</th><th>HTG (m)</th></tr>
<tr><td>AG1</td><td>413435,08N 0005327,98W</td><td>500</td><td>150</td></tr>
<tr><td>AG2</td><td>413436.10N 0005328.20 W</td><td>510</td><td>180</td></tr>
</table>`, "PARQUE")
	if len(b.zones) != 2 {
		t.Fatalf("zones = %d, want 2; warnings %v", len(b.zones), b.warnings)
	}
	if b.zones[0].name != "AG1" {
		t.Errorf("name = %q, want AG1", b.zones[0].name)
	}
	assertTriple(t, b.zones[0].upper, "HEI", "150", "M")
	if hasWarning(b.warnings, "obstacle-table-unread") {
		t.Error("a read table must not be reported unread")
	}

	timed := supDoc(t, `<h4>GR&Uacute;A</h4><table>
<tr><th>HORA</th><th>COORD</th><th>HGT (m)</th></tr>
<tr><td>0730-2100 HL</td><td>413435N 0005327W</td><td>40</td></tr>
</table>`, "GRUA")
	if len(timed.zones) != 1 || timed.zones[0].name != "SUP AIP" {
		t.Errorf("a time column must not name the zone: %+v", timed.zones)
	}

	// A pair split over two columns, under one repeated COORD header
	// (178/2024: three 186 m turbines and a tower read this way) or under
	// LAT | LONG.
	split := supDoc(t, `<h4>PARQUE</h4><table>
<tr><th>ID</th><th>COORD</th><th>COORD</th><th>ELEV (M AMSL)</th><th>HGT (M)</th></tr>
<tr><td>1 (LIN05)</td><td>423142.52 N</td><td>0015533.68W</td><td>682</td><td>186</td></tr>
<tr><td>Gr&uacute;a m&oacute;vil</td><td>-</td><td>-</td><td>-</td><td>125</td></tr>
</table>`, "PARQUE")
	if len(split.zones) != 1 || split.zones[0].name != "1 (LIN05)" {
		t.Errorf("split coordinate columns: zones %+v, want the one positioned turbine", split.zones)
	}
	if len(split.zones) == 1 {
		assertTriple(t, split.zones[0].upper, "HEI", "186", "M")
	}
	latlong := supDoc(t, `<h4>PARQUE</h4><table>
<tr><th>ID</th><th>LAT</th><th>LONG</th><th>HGT (m)</th></tr>
<tr><td>T1</td><td>423142N</td><td>0015533W</td><td>100</td></tr>
</table>`, "PARQUE")
	if len(latlong.zones) != 1 {
		t.Errorf("LAT | LONG columns: zones %d, want 1; warnings %v", len(latlong.zones), latlong.warnings)
	}

	unread := supDoc(t, `<h4>OBST</h4><table>
<tr><th>ID</th><th>COORD</th><th>HGT (m)</th></tr>
<tr><td>X</td><td>somewhere</td><td>40</td></tr>
</table>`, "OBST")
	if len(unread.zones) != 0 || !hasWarning(unread.warnings, "obstacle-table-unread") {
		t.Errorf("zones %d, warnings %v; want none and obstacle-table-unread", len(unread.zones), unread.warnings)
	}
}

// TestFirsAndAerodromes: FIR indicators never enter the aerodrome list,
// and the aerodromes place a supplement that names no FIR.
func TestFirsAndAerodromes(t *testing.T) {
	if got := esAdhpFor("CANARIAS FIR (GCCC).- Parque eolico GCLP"); len(got) != 1 || got[0] != "GCLP" {
		t.Errorf("adhp = %v, want [GCLP]", got)
	}
	if got := esFirsFor("Parque eolico", "", []string{"GCLP"}); len(got) != 1 || got[0] != "GCCC" {
		t.Errorf("firs = %v, want [GCCC]", got)
	}
	if got := esFirsFor("Grua", "", []string{"LEAS"}); len(got) != 2 {
		t.Errorf("firs = %v, want the two peninsular FIRs", got)
	}
	if got := esFirsFor("Grua", "", nil); len(got) != 3 {
		t.Errorf("firs = %v, want all three", got)
	}
}

// TestObstacleTable covers the 050 shape: an ID / COORD / ELEV / HGT
// table, one circle per positioned row.
func TestObstacleTable(t *testing.T) {
	art, _ := buildFixture(t)
	row := rowByTitle(t, art, "050/2026")
	zones := zonesOf(t, row)
	if len(zones) != 1 {
		t.Fatalf("050/2026: %d zones, want 1 (the second row states no position)", len(zones))
	}
	g, _ := zones[0]["geometry"].(map[string]any)
	if g["type"] != "circle" {
		t.Errorf("geometry type = %v, want circle", g["type"])
	}
	if r, _ := g["radiusM"].(float64); r != supCircleFloorM {
		t.Errorf("radius = %v, want the %v m floor", g["radiusM"], supCircleFloorM)
	}
	// HGT, not ELEV: the height above ground is the zone's upper limit.
	assertTriple(t, zones[0]["upper"], "HEI", "142", "M")
	if !warningsOf(t, row)["obstacle-row-without-position"] {
		t.Error("the position-less mobile-crane row must be reported")
	}
	if row["geometrySource"] != "html-position" {
		t.Errorf("geometrySource = %v, want html-position", row["geometrySource"])
	}
}

// TestBulletedPositionsAreNotAZone: a supplement naming the power-line
// beacons whose lights are out of service prints twelve positions as an
// unordered list. Joining them into a polygon would draw an airspace the
// AIP never created.
func TestBulletedPositionsAreNotAZone(t *testing.T) {
	art, _ := buildFixture(t)
	row := rowByTitle(t, art, "003/2026")
	if zones := zonesOf(t, row); len(zones) != 0 {
		t.Fatalf("003/2026: %d zones, want none (a set of beacon positions is not a boundary)", len(zones))
	}
	if row["geometrySource"] != "none" {
		t.Errorf("geometrySource = %v, want none", row["geometrySource"])
	}
}

// TestPdfOnlySupplement covers the supplements published with no HTML
// edition, read through `pdftotext -layout`. The fixture is a committed
// capture of that output, so the test needs no poppler binary.
func TestPdfOnlySupplement(t *testing.T) {
	art, _ := buildFixture(t)
	row := rowByTitle(t, art, "152/2020")
	zones := zonesOf(t, row)
	if len(zones) != 1 {
		t.Fatalf("152/2020: %d zones, want the transit corridor", len(zones))
	}
	ring := ringOf(t, zones[0])
	if len(ring) != 5 {
		t.Fatalf("corridor has %d points, want the 4 published vertices (closed)", len(ring))
	}
	// The bilingual PDF prints each vertex twice on one line, once per
	// language column; the ring must still be the published quadrilateral.
	want := [][2]float64{
		{40.69167, -4.61528}, // 404130N 0043655W
		{40.55750, -4.48472}, // 403327N 0042905W
		{39.45861, -6.36861}, // 392731N 0062207W
		{39.59056, -6.50083}, // 393526N 0063003W
	}
	for i, w := range want {
		if math.Abs(ring[i][0]-w[0]) > 1e-4 || math.Abs(ring[i][1]-w[1]) > 1e-4 {
			t.Errorf("vertex %d = %v, want %v", i, ring[i], w)
		}
	}
	assertTriple(t, zones[0]["lower"], "STD", "145", "FL")
	assertTriple(t, zones[0]["upper"], "STD", "245", "FL")
	if !warningsOf(t, row)["pdf-fallback"] {
		t.Error("a PDF-sourced row must say so")
	}
}

// TestEnglishOnlyEdition pins the bilingual grammar: an English edition
// must yield the same zones as its Spanish twin, including the phrase
// ENAIRE sets as a preformatted block.
func TestEnglishOnlyEdition(t *testing.T) {
	art, _ := buildFixture(t)
	row := rowByTitle(t, art, "135/2026")
	zones := zonesOf(t, row)
	if len(zones) != 3 {
		t.Fatalf("135/2026: %d zones, want 3", len(zones))
	}
	if zones[0]["name"] != "ZONE 1" || zones[2]["name"] != "HOLDING CIRCUIT" {
		t.Errorf("names = %v / %v, want the English headings", zones[0]["name"], zones[2]["name"])
	}
	assertTriple(t, zones[0]["upper"], "ALT", "4000", "FT")
	// No Spanish edition exists, so urlPdf is empty and only the English
	// one is linked.
	if row["urlPdf"] != "" {
		t.Errorf("urlPdf = %v, want empty (no Spanish edition)", row["urlPdf"])
	}
	if row["urlPdfEn"] == "" {
		t.Error("urlPdfEn must carry the English PDF")
	}
}

// TestVerticalPairs pins the level vocabulary the SPA decodes, including
// the thousands separators the two languages disagree about: read "3.000
// ft" as three feet and a 3000 ft ceiling becomes a 3 ft one.
func TestVerticalPairs(t *testing.T) {
	cases := []struct {
		in    string
		lower []string
		upper []string
	}{
		{"SFC-FL100", []string{"HEI", "0", "FT"}, []string{"STD", "100", "FL"}},
		{"GND-120 m AGL.", []string{"HEI", "0", "FT"}, []string{"HEI", "120", "M"}},
		{"SFC - 4000 ft AMSL MÁX", []string{"HEI", "0", "FT"}, []string{"ALT", "4000", "FT"}},
		{"SFC - 3.000 ft AMSL", []string{"HEI", "0", "FT"}, []string{"ALT", "3000", "FT"}},
		{"SFC - 3,000 ft AMSL", []string{"HEI", "0", "FT"}, []string{"ALT", "3000", "FT"}},
		{"FL145 - FL245.", []string{"STD", "145", "FL"}, []string{"STD", "245", "FL"}},
		{"FL130 - UNL", []string{"STD", "130", "FL"}, []string{"UNL", "", ""}},
		// The bilingual PDFs print both columns on one line.
		{"FL145 - FL245. Vertical limits: FL145 - FL245.", []string{"STD", "145", "FL"}, []string{"STD", "245", "FL"}},
	}
	for _, c := range cases {
		lo, up, ok := parseVerticalPair(c.in)
		if !ok {
			t.Errorf("%q did not parse", c.in)
			continue
		}
		assertTripleSlice(t, c.in+" lower", lo, c.lower)
		assertTripleSlice(t, c.in+" upper", up, c.upper)
	}
	for _, bad := range []string{"", "see the chart", "Observaciones"} {
		if _, _, ok := parseVerticalPair(bad); ok {
			t.Errorf("%q should not parse as a vertical pair", bad)
		}
	}
}

// TestRingSanity pins the refusals: a ring that crosses itself or leaves
// Spanish territory is a misread column, and a NOTAM viewer must draw
// nothing rather than the wrong airspace.
func TestRingSanity(t *testing.T) {
	bowtie := [][2]float64{{40, -4}, {41, -3}, {40, -3}, {41, -4}}
	if r, w := cleanRing(bowtie); r != nil || w != "ring-self-intersecting" {
		t.Errorf("bow tie: got %v / %q, want a refusal", r, w)
	}
	swapped := [][2]float64{{40, -4}, {41, -3}, {-3, 41}}
	if r, w := cleanRing(swapped); r != nil || w != "vertex-outside-spain" {
		t.Errorf("swapped lat/lon: got %v / %q, want a refusal", r, w)
	}
	short := [][2]float64{{40, -4}, {41, -3}}
	if r, w := cleanRing(short); r != nil || w != "ring-too-short" {
		t.Errorf("two points: got %v / %q, want a refusal", r, w)
	}
	square := [][2]float64{{40, -4}, {41, -4}, {41, -3}, {40, -3}}
	got, w := cleanRing(square)
	if w != "" || len(got) != 5 || got[0] != got[4] {
		t.Errorf("square: got %v / %q, want a closed 5-point ring", got, w)
	}
}

// TestSanityWindow: a listing that stops parsing must fail the build
// rather than publish an empty overlay.
func TestSanityWindow(t *testing.T) {
	c, rows := loadSupFixture(t)
	if _, _, err := buildEsSupaip(c, rows, time.Now, 500, 900); err == nil {
		t.Fatal("a count below the floor must be an error")
	}
}

// TestMetaCounters pins what the About card and the workflow read.
func TestMetaCounters(t *testing.T) {
	_, meta := buildFixture(t)
	if meta.Total != 7 {
		t.Errorf("total = %d, want 7", meta.Total)
	}
	if meta.Active+meta.Upcoming != meta.Total {
		t.Errorf("active %d + upcoming %d != total %d", meta.Active, meta.Upcoming, meta.Total)
	}
	if meta.PdfFallbacks != 1 {
		t.Errorf("pdfFallbacks = %d, want 1", meta.PdfFallbacks)
	}
	if meta.ByRegion["es"] != meta.Total {
		t.Errorf("byRegion[es] = %d, want %d", meta.ByRegion["es"], meta.Total)
	}
	if meta.ParserVersion != esSupParserVersion {
		t.Errorf("parserVersion = %d, want %d", meta.ParserVersion, esSupParserVersion)
	}
	// An estimated end date is source semantics, counted but never a row
	// warning: the panel prints warnings as parse notes.
	if meta.EstimatedEnd == 0 {
		t.Error("estimatedEnd should count the EST spans in the fixture")
	}
	if _, ok := meta.Warnings["est-end"]; ok {
		t.Error("est-end must not be a row warning")
	}
}

// TestBboxContainsRings: every zone's bbox must contain its own geometry,
// and the row bbox every zone's.
func TestBboxContainsRings(t *testing.T) {
	art, _ := buildFixture(t)
	for _, r := range art.Rows {
		cells := r.([]any)
		zones, _ := cells[14].([]any)
		rowBox, _ := cells[15].([]float64)
		for _, z := range zones {
			zm := z.(map[string]any)
			box, _ := zm["bbox"].([]float64)
			if len(box) != 4 {
				t.Errorf("%v: zone %v has no bbox", cells[1], zm["name"])
				continue
			}
			g, _ := zm["geometry"].(map[string]any)
			if ring, ok := g["ring"].([]any); ok {
				for _, p := range ring {
					pt := p.([2]float64)
					if pt[0] < box[0]-1e-6 || pt[0] > box[2]+1e-6 || pt[1] < box[1]-1e-6 || pt[1] > box[3]+1e-6 {
						t.Errorf("%v: vertex %v outside zone bbox %v", cells[1], pt, box)
					}
				}
			}
			if len(rowBox) == 4 {
				if box[0] < rowBox[0]-1e-6 || box[2] > rowBox[2]+1e-6 || box[1] < rowBox[1]-1e-6 || box[3] > rowBox[3]+1e-6 {
					t.Errorf("%v: zone bbox %v outside row bbox %v", cells[1], box, rowBox)
				}
			}
		}
	}
}

func warningsOf(t *testing.T, row map[string]any) map[string]bool {
	t.Helper()
	out := map[string]bool{}
	ws, _ := row["warnings"].([]string)
	for _, w := range ws {
		out[w] = true
	}
	return out
}

func assertTriple(t *testing.T, got any, code, val, uom string) {
	t.Helper()
	assertTripleSlice(t, "triple", got, []string{code, val, uom})
}

func assertTripleSlice(t *testing.T, what string, got any, want []string) {
	t.Helper()
	g, ok := got.([]string)
	if !ok {
		t.Errorf("%s: %v is not a [code value uom] triple", what, got)
		return
	}
	if len(g) != 3 || g[0] != want[0] || g[1] != want[1] || g[2] != want[2] {
		t.Errorf("%s = %v, want %v", what, g, want)
	}
}
