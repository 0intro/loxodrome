// Pins for the 2026 corpus-audit fixes, each named for the supplement that
// exhibits its layout. Multi-column behaviours build prows inline (the
// testdata fixtures are single-cell rows, which cannot carry a column
// layout).
package main

import (
	"math"
	"strings"
	"testing"
)

func cellsRow(y float64, cells ...cell) prow {
	return prow{y: y, cells: cells}
}

// 030/2026: packed DDMMSS coordinates, jammed pair included.
func TestScanCoordsPacked(t *testing.T) {
	toks := scanCoords("490158N0025711W")
	if len(toks) != 2 || !toks[0].isLat || toks[1].isLat {
		t.Fatalf("packed pair: got %+v", toks)
	}
	if math.Abs(toks[0].val-(49+1.0/60+58.0/3600)) > 1e-6 {
		t.Errorf("lat = %v", toks[0].val)
	}
	if math.Abs(toks[1].val-(-(2 + 57.0/60 + 11.0/3600))) > 1e-6 {
		t.Errorf("lon = %v", toks[1].val)
	}
	// A digit-preceded run is not a coordinate.
	if got := scanCoords("31234567890N"); len(got) != 0 {
		t.Errorf("digit-preceded: got %+v", got)
	}
}

// 159/2026: poppler renders the minute mark as U+2019.
func TestScanCoordsTypographicMinuteMark(t *testing.T) {
	toks := scanCoords("48°37’44’’N–006°04’00’’E")
	if len(toks) != 2 {
		t.Fatalf("got %d tokens", len(toks))
	}
}

// 045/2026: the hemisphere letters open the row AFTER the bare latitude.
func TestCollectColumnsHemisphereNextRow(t *testing.T) {
	rows := []prow{
		cellsRow(-1, cell{x: 78, text: "43�31'30.00''"}),
		cellsRow(-2, cell{x: 67, text: "N,006�30'29.00''E"}),
		cellsRow(-3, cell{x: 78, text: "43�31'26.00''"}),
		cellsRow(-4, cell{x: 67, text: "N,006�30'25.00''E"}),
		cellsRow(-5, cell{x: 78, text: "43�31'30.00''"}),
		cellsRow(-6, cell{x: 67, text: "N,006�30'29.00''E"}),
	}
	cols := collectColumns(rows, []float64{60})
	if got := len(cols[60].verts); got != 3 {
		t.Fatalf("verts = %d, want 3", got)
	}
	if math.Abs(cols[60].verts[0][0]-43.525) > 1e-3 {
		t.Errorf("v0 lat = %v", cols[60].verts[0][0])
	}
}

// 160/2026: the arc phrase splits over rows ("arc horaire de 10.00nm de" /
// "rayon centré sur") and the centre's own latitude stands alone.
func TestCollectColumnsSplitArcPhrase(t *testing.T) {
	rows := []prow{
		cellsRow(-1, cell{x: 60, text: "45�40'45''N,000�01'14''W"}),
		cellsRow(-2, cell{x: 60, text: "archorairede10.00nmde"}),
		cellsRow(-3, cell{x: 60, text: "rayoncentr�sur"}),
		cellsRow(-4, cell{x: 60, text: "45�30'47''N,000�00'07''W"}),
		cellsRow(-5, cell{x: 60, text: "45�33'22''N,000�13'51''W"}),
	}
	cols := collectColumns(rows, []float64{60})
	if len(cols[60].arcs) != 1 {
		t.Fatalf("arcs = %d, want 1", len(cols[60].arcs))
	}
	a := cols[60].arcs[0]
	if !a.clockwise || math.Abs(a.radiusM-18520) > 1 {
		t.Errorf("arc = %+v", a)
	}
	if math.Abs(a.center[0]-(45+30.0/60+47.0/3600)) > 1e-6 {
		t.Errorf("centre lat = %v", a.center[0])
	}
	if got := len(cols[60].verts); got != 2 {
		t.Errorf("verts = %d, want 2 (the centre is not a vertex)", got)
	}
}

// 052/2026: a circle per column, the centres' latitudes and longitudes each
// jammed into ONE row-wide cell; they distribute in column order.
func TestCollectColumnsJammedCentreDistribution(t *testing.T) {
	rows := []prow{
		cellsRow(-1,
			cell{x: 47, text: "CERCLEDE2NMDERAYON"},
			cell{x: 175, text: "CERCLEDE2NMDERAYON"}),
		cellsRow(-2, cell{x: 49, text: "CENTRESUR42°15′36.6″NCENTRESUR42°30′57.9″N,"}),
		cellsRow(-3, cell{x: 75, text: "009°32′27.9″E003°07′59.4″E"}),
	}
	cols := collectColumns(rows, []float64{47, 175})
	if len(cols[47].circles) != 1 || len(cols[175].circles) != 1 {
		t.Fatalf("circles = %d/%d, want 1/1", len(cols[47].circles), len(cols[175].circles))
	}
	if math.Abs(cols[47].circles[0].center[1]-(9+32.0/60+27.9/3600)) > 1e-6 {
		t.Errorf("col1 centre lon = %v", cols[47].circles[0].center[1])
	}
	if math.Abs(cols[175].circles[0].center[0]-(42+30.0/60+57.9/3600)) > 1e-6 {
		t.Errorf("col2 centre lat = %v", cols[175].circles[0].center[0])
	}
}

// 001/2026: one vertex PER COLUMN jammed into a single cell distributes in
// column order.
func TestCollectColumnsJammedVertexDistribution(t *testing.T) {
	rows := []prow{
		cellsRow(-1, cell{x: 60, text: `47°06'45"N,006°34'04"W47°29'17"N,006°50'37"W47°44'48"N,004°31'34"W`}),
	}
	cols := collectColumns(rows, []float64{60, 250, 420})
	for _, cx := range []float64{60, 250, 420} {
		if len(cols[cx].verts) != 1 {
			t.Fatalf("col %v verts = %d, want 1", cx, len(cols[cx].verts))
		}
	}
	if math.Abs(cols[420].verts[0][0]-(47+44.0/60+48.0/3600)) > 1e-6 {
		t.Errorf("col3 lat = %v", cols[420].verts[0][0])
	}
}

// 047/2026: a trailing longitude missing its hemisphere letter recovers its
// sign from the column's other longitudes, and never without evidence.
func TestCollectColumnsTrailingBareLon(t *testing.T) {
	rows := []prow{
		cellsRow(-1, cell{x: 60, text: `44°31'20.00"N,006°02'09.00"E`}),
		cellsRow(-2, cell{x: 60, text: `44°23'20.00"N,006°02'09.00"`}),
	}
	cols := collectColumns(rows, []float64{60})
	if got := len(cols[60].verts); got != 2 {
		t.Fatalf("verts = %d, want 2", got)
	}
	if cols[60].verts[1][1] <= 0 {
		t.Errorf("recovered lon sign = %v, want positive (east)", cols[60].verts[1][1])
	}
	// No prior longitude: the bare value stays dropped.
	alone := collectColumns([]prow{
		cellsRow(-1, cell{x: 60, text: `44°23'20.00"N,006°02'09.00"`}),
	}, []float64{60})
	if got := len(alone[60].verts); got != 0 {
		t.Errorf("without evidence: verts = %d, want 0", got)
	}
}

// 099/2026: lateral limits published BY REFERENCE keep the zone, geometry-less.
func TestBuildZoneSameAs(t *testing.T) {
	z, _, ok := buildZone("ZRT/ZDT ALPHA", nil, nil, nil, "LF-D5", nil, nil, 0)
	if !ok || z.geom != nil || z.sameAs != "LF-D5" || z.source != "none" {
		t.Fatalf("sameAs zone = %+v ok=%v", z, ok)
	}
	if _, _, ok := buildZone("X", nil, nil, nil, "", nil, nil, 0); ok {
		t.Error("no geometry and no reference must not build")
	}
}

func TestExtractRefDesignators(t *testing.T) {
	cases := map[string]string{
		"Identiques�cellesdelazoneLF-D5(Cf.AIPFranceENR5.1)": "LF-D5",
		"Identiques�cellesdelazoneLF-" + "D12G":              "LF-D12G",
		"Identiques�cellesdeszonesLF-R" + "146A/B":           "LF-R146A/B",
		"IdentiquesàcellesdelazoneTRA6(Cf.AIPFranceENR5.2)":  "TRA6",
		"delazoneLF-D16BROZOUEST":                            "LF-D16B",
		"":                                                   "",
	}
	for in, want := range cases {
		if got := extractRefDesignators(in); got != want {
			t.Errorf("%q: got %q, want %q", in, got, want)
		}
	}
}

// 010/2026 prints its zone tables twice; identical rows collapse, differing
// verticals stay.
func TestDedupZones(t *testing.T) {
	g := &geometry{kind: "polygon", ring: []latlon{{1, 1}, {2, 2}, {3, 1}}}
	zs := []zone{
		{name: "A", geom: g, lower: []string{"STD", "195", "FL"}, source: "pdf-polygon"},
		{name: "A", geom: g, lower: []string{"STD", "195", "FL"}, source: "pdf-polygon"},
		{name: "A", geom: g, lower: []string{"STD", "305", "FL"}, source: "pdf-polygon"},
	}
	if !dedupZones(&zs) || len(zs) != 2 {
		t.Fatalf("dedup: %d zones", len(zs))
	}
}

// 045/2026's BERGEROL columns repeat a vertex mid-ring: the zero-length edge
// must not read as a self-intersection.
func TestDedupeRingConsecutiveDuplicates(t *testing.T) {
	r := dedupeRing([]latlon{{1, 1}, {2, 2}, {2, 2}, {3, 1}, {1, 1}})
	if len(r) != 3 {
		t.Fatalf("ring = %v", r)
	}
}

// 001/2026: a fused name row splits into one name per column; a surplus name
// (a displaced column's) never contaminates the last one.
func TestSplitFusedNames(t *testing.T) {
	got := splitFusedNames("ZRT/ZDTKRYPTONALPHA1.1ZDTKRYPTONALPHA1.2ZRTKRYPTONALPHA1.3", 3)
	want := []string{"ZRT/ZDTKRYPTONALPHA1.1", "ZDTKRYPTONALPHA1.2", "ZRTKRYPTONALPHA1.3"}
	if len(got) != 3 || got[0] != want[0] || got[1] != want[1] || got[2] != want[2] {
		t.Fatalf("got %q", got)
	}
	got = splitFusedNames("ZDTKRYPTONALPHA2ZRT/ZDTKRYPTONBRAVOZRTCORRIDOR34BLOW", 2)
	if len(got) != 2 || got[1] != "ZRT/ZDTKRYPTONBRAVO" {
		t.Fatalf("surplus name: got %q", got)
	}
	if splitFusedNames("ZRT SEULE", 2) != nil {
		t.Error("too few boundaries must refuse")
	}
}

// 052/2026: a fused marker row recovers its columns from the name row above.
func TestJammedMarkerColumns(t *testing.T) {
	rows := []prow{
		cellsRow(-1,
			cell{x: 77, text: "ZITALISTRO"}, cell{x: 212, text: "ZITBEAR"},
			cell{x: 329, text: "ZITCAMARAT"}, cell{x: 453, text: "ZITCAPCORSE"}),
		cellsRow(-2, cell{x: 59, text: "LIMITESLAT�RALESLIMITESLAT�RALESLIMITESLAT�RALESLIMITESLAT�RALES"}),
	}
	xs := jammedMarkerColumns(rows, 1)
	if len(xs) != 4 || xs[0] != 77 || xs[3] != 453 {
		t.Fatalf("columns = %v", xs)
	}
	// A normal marker row is not a fused one.
	if jammedMarkerColumns([]prow{
		cellsRow(-1, cell{x: 77, text: "ZRT A"}),
		cellsRow(-2, cell{x: 59, text: "LIMITESLAT�RALES"}),
	}, 1) != nil {
		t.Error("single marker must not trigger")
	}
}

// 053/2026: the interleaved one-column exercise layout, one axis per row,
// each zone's name + band on a row inside its own vertex run.
func TestInterleavedZones(t *testing.T) {
	rows := []prow{
		cellsRow(-1, cell{x: 80, text: "46�30'00''N-"}),
		cellsRow(-2, cell{x: 80, text: "000�11'33''W"}),
		cellsRow(-3, cell{x: 80, text: "46�30'00''N-"}),
		cellsRow(-4, cell{x: 80, text: "000�04'06''W"}),
		cellsRow(-5,
			cell{x: 20, text: "ZRTPARTHENAY"},
			cell{x: 80, text: "46�40'00''N-"},
			cell{x: 200, text: "FL125/FL135"}),
		cellsRow(-6, cell{x: 80, text: "000�03'46''W"}),
		cellsRow(-7, cell{x: 80, text: "46�40'00''N-"}),
		cellsRow(-8, cell{x: 80, text: "000�11'13''W"}),
		cellsRow(-9, cell{x: 80, text: "46�30'00''N-"}),
		cellsRow(-10, cell{x: 80, text: "000�11'33''W"}),
		cellsRow(-11, cell{x: 80, text: "47�10'00''N-"}),
		cellsRow(-12, cell{x: 80, text: "000�11'13''W"}),
		cellsRow(-13, cell{x: 80, text: "47�10'00''N-"}),
		cellsRow(-14, cell{x: 80, text: "000�03'46''W"}),
		cellsRow(-15,
			cell{x: 20, text: "ZRTTHOUARSAIS"},
			cell{x: 80, text: "46�40'00''N-"},
			cell{x: 200, text: "FL125/FL135"}),
		cellsRow(-16, cell{x: 80, text: "000�03'46''W"}),
		cellsRow(-17, cell{x: 80, text: "46�40'00''N-"}),
		cellsRow(-18, cell{x: 80, text: "000�11'13''W"}),
		cellsRow(-19, cell{x: 80, text: "47�10'00''N-"}),
		cellsRow(-20, cell{x: 80, text: "000�11'13''W"}),
	}
	if got := countInterleavedNames(rows); got != 2 {
		t.Fatalf("interleaved names = %d, want 2", got)
	}
	zones := interleavedZones(rows, 80)
	if len(zones) != 2 {
		t.Fatalf("zones = %d, want 2", len(zones))
	}
	if zones[0].name != "ZRT PARTHENAY" && !strings.Contains(zones[0].name, "PARTHENAY") {
		t.Errorf("zone 1 name = %q", zones[0].name)
	}
	if len(zones[0].geom.ring) != 4 || len(zones[1].geom.ring) != 4 {
		t.Errorf("rings = %d/%d, want 4/4", len(zones[0].geom.ring), len(zones[1].geom.ring))
	}
	if zones[1].lower == nil || zones[1].lower[1] != "125" {
		t.Errorf("zone 2 lower = %v", zones[1].lower)
	}
}

// 159/2026: the native prime marks vanish, so poppler reads richer and wins.
func TestRicherResult(t *testing.T) {
	mk := func(n int, verts int) geomResult {
		zs := make([]zone, n)
		for i := range zs {
			ring := make([]latlon, verts)
			for j := range ring {
				ring[j] = latlon{float64(j), float64(i)}
			}
			zs[i] = zone{geom: &geometry{kind: "polygon", ring: ring}}
		}
		return geomResult{zones: zs, source: "pdf-polygon"}
	}
	if !richerResult(mk(2, 8), mk(2, 3)) {
		t.Error("more vertices at equal zones must win")
	}
	if !richerResult(mk(3, 3), mk(2, 8)) {
		t.Error("more zones must win")
	}
	if richerResult(mk(2, 3), mk(2, 3)) {
		t.Error("a tie must keep the native pass")
	}
}

// 030/2026: a name whose typographic quotes decode to C0 bytes is judged
// with them stripped, not rejected as garbled.
func TestColumnNamesC0Quotes(t *testing.T) {
	row := cellsRow(-1,
		cell{x: 60, text: "ZRT\x18SAINT-BRIEUCMER\x19"},
		cell{x: 250, text: "ZRT\x18SAINT-BRIEUCCOULOIR\x19"})
	names := columnNames(row, []float64{60, 250})
	if names[60] != "ZRTSAINT-BRIEUCMER" || names[250] != "ZRTSAINT-BRIEUCCOULOIR" {
		t.Fatalf("names = %v", names)
	}
}

// 159/2025: ONE row of the three-column table fuses the first two columns'
// cells:
//
//	49°00'00''N,005°31'20''E48°24'30\"N,005°17'35\"E
//
// The second vertex belongs to the NEXT column (ZRT JOINVILLE), not to the
// cell's own (it used to land in ZRT SAINT-DIZIER as a southward spike).
func TestCollectColumnsPartialFusedRow(t *testing.T) {
	rows := []prow{
		cellsRow(-1,
			cell{x: 60, text: `49°13'48''N,005°49'57''E`},
			cell{x: 250, text: `48°25'05"N,005°23'55"E`}),
		cellsRow(-2, cell{x: 60, text: `49°00'00''N,005°31'20''E48°24'30"N,005°17'35"E`}),
		cellsRow(-3,
			cell{x: 60, text: `48°50'53''N,005°23'55''E`},
			cell{x: 250, text: `48°24'38"N,005°10'25"E`}),
	}
	cols := collectColumns(rows, []float64{60, 250})
	if got := len(cols[60].verts); got != 3 {
		t.Fatalf("col 1 verts = %d, want 3", got)
	}
	if got := len(cols[250].verts); got != 3 {
		t.Fatalf("col 2 verts = %d, want 3", got)
	}
	if math.Abs(cols[250].verts[1][0]-(48+24.0/60+30.0/3600)) > 1e-6 {
		t.Errorf("col 2 middle vertex lat = %v, want 48°24'30", cols[250].verts[1][0])
	}
	if math.Abs(cols[60].verts[1][0]-49.0) > 1e-6 {
		t.Errorf("col 1 middle vertex lat = %v, want 49°00'00", cols[60].verts[1][0])
	}
}

// 083/2026's poppler rows fuse a stray ':' fragment (at the FIRST column's x)
// in front of the SECOND and THIRD columns' vertices: the cell's left edge
// then lies about the first vertex's column, and ring continuity must anchor
// the window instead.
func TestCollectColumnsPrefixedFusedRow(t *testing.T) {
	rows := []prow{
		// Ring starters: ZRT 2 near 47.96N/0.21E, TMA near 48.24N/0.12E.
		cellsRow(-1,
			cell{x: 250, text: `47°57'25''N-000°12'25''E`},
			cell{x: 420, text: `48°14'42"N-000°07'06"E`}),
		// The fused row: leading ':' sits at column 1's x, but both vertices
		// continue columns 2 and 3.
		cellsRow(-2, cell{x: 60, text: `:47°57'35''N–000°12'42''E48°13'48"N-000°11'31"E`}),
	}
	cols := collectColumns(rows, []float64{60, 250, 420})
	if got := len(cols[60].verts); got != 0 {
		t.Fatalf("col 1 verts = %d, want 0", got)
	}
	if got := len(cols[250].verts); got != 2 {
		t.Fatalf("col 2 verts = %d, want 2", got)
	}
	if got := len(cols[420].verts); got != 2 {
		t.Fatalf("col 3 verts = %d, want 2", got)
	}
}

// 083/2026: at equal zone counts, a parse whose extra points come from a
// circle degraded into rings is junk, not richness.
func TestRicherResultCircleGuard(t *testing.T) {
	ring := func(n int) *geometry {
		r := make([]latlon, n)
		for i := range r {
			r[i] = latlon{float64(i), 0}
		}
		return &geometry{kind: "polygon", ring: r}
	}
	native := geomResult{source: "pdf-polygon", zones: []zone{
		{geom: &geometry{kind: "circle", center: latlon{48, 0}, radiusM: 8334}},
		{geom: ring(9)},
		{geom: ring(10)},
	}}
	junk := geomResult{source: "pdf-polygon", zones: []zone{
		{geom: &geometry{kind: "multipolygon", rings: [][]latlon{ring(4).ring, ring(4).ring}}},
		{geom: ring(7)},
		{geom: ring(7)},
	}}
	if richerResult(junk, native) {
		t.Error("a circle degraded into rings must not read as richer")
	}
	richer := geomResult{source: "pdf-polygon", zones: []zone{
		{geom: &geometry{kind: "circle", center: latlon{48, 0}, radiusM: 8334}},
		{geom: ring(12)},
		{geom: ring(10)},
	}}
	if !richerResult(richer, native) {
		t.Error("more points with the circle intact must still win")
	}
}
