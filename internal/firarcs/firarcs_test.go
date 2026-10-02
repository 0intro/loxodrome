package firarcs

import (
	"reflect"
	"testing"
)

func TestStateKey(t *testing.T) {
	cases := []struct{ ident, want string }{
		{"EGTT", "EG"}, {"EGTT001", "EG"}, {"EGPX001", "EG"},
		{"LFFF", "LF"}, {"LECM", "LE"},
		{"GCCC", "LE"}, // the Canaries are Spain
		{"KZLA", "K"}, {"KZNY", "K"},
		{"PAZA", "K"}, // Alaska rides the USA group
		{"CZQX", "C"}, {"CZUL", "C"},
		{"YBBB", "Y"}, {"YMMM", "Y"},
		{"UUWV", "UU"}, {"UKBV", "UK"}, // Russia / Ukraine stay separate
		{"ZBPE", "ZB"}, {"ZKKP", "ZK"}, // China / DPRK stay separate
		{"OCA4521", ""}, // no four-letter head: never grouped
		{"LF1", ""},
	}
	for _, c := range cases {
		if got := StateKey(c.ident); got != c.want {
			t.Errorf("StateKey(%q) = %q, want %q", c.ident, got, c.want)
		}
	}
}

func TestFIRFamily(t *testing.T) {
	for _, typ := range []string{"FIR", "UIR", "OCA", "ARTCC", "ACC"} {
		if !FIRFamily(typ) {
			t.Errorf("FIRFamily(%q) = false, want true", typ)
		}
	}
	for _, typ := range []string{"TMA", "CTR", "R", "SIV", "FIC", ""} {
		if FIRFamily(typ) {
			t.Errorf("FIRFamily(%q) = true, want false", typ)
		}
	}
}

// Two adjacent 1-degree squares (lat, lon; open rings). A's eastern edge
// (1,1)->(0,1) coincides with B's western edge; every other edge is over
// 100 km from the neighbour, far beyond the 2 km tolerance.
var (
	sqA = [][2]float64{{1, 0}, {1, 1}, {0, 1}, {0, 0}}
	sqB = [][2]float64{{1, 1}, {1, 2}, {0, 2}, {0, 1}}
)

func TestExternalArcsSharedEdge(t *testing.T) {
	arcs := ExternalArcs(sqA, [][][2]float64{sqB})
	// One arc spanning the seam: edges 2, 3, 0 chained from (0,1) back
	// around to (1,1); the shared edge 1 is dropped.
	want := [][][2]float64{{{0, 1}, {0, 0}, {1, 0}, {1, 1}}}
	if !reflect.DeepEqual(arcs, want) {
		t.Errorf("ExternalArcs = %v, want %v", arcs, want)
	}
}

func TestExternalArcsMiddleRing(t *testing.T) {
	// B sits between A and C: internal edges on BOTH sides -> two arcs
	// (its north rim and its south rim), neither crossing the seam.
	sqC := [][2]float64{{1, 2}, {1, 3}, {0, 3}, {0, 2}}
	arcs := ExternalArcs(sqB, [][][2]float64{sqA, sqC})
	want := [][][2]float64{
		{{1, 1}, {1, 2}},
		{{0, 2}, {0, 1}},
	}
	if !reflect.DeepEqual(arcs, want) {
		t.Errorf("ExternalArcs = %v, want %v", arcs, want)
	}
}

func TestExternalArcsNoNeighbour(t *testing.T) {
	if arcs := ExternalArcs(sqA, nil); arcs != nil {
		t.Errorf("no neighbours: arcs = %v, want nil", arcs)
	}
	far := [][2]float64{{40, 20}, {40, 21}, {39, 21}, {39, 20}}
	if arcs := ExternalArcs(sqA, [][][2]float64{far}); arcs != nil {
		t.Errorf("distant neighbour: arcs = %v, want nil", arcs)
	}
}

func TestExternalArcsToleratesOffsetVertices(t *testing.T) {
	// The neighbour traces the shared boundary with DIFFERENT vertices
	// (one interior point, ~0.5 km lateral offset): still internal.
	off := 0.005 // ~0.5 km in longitude at these latitudes
	b := [][2]float64{{1, 1 + off}, {0.5, 1 + off}, {0, 1 + off}, {0, 2}, {1, 2}}
	arcs := ExternalArcs(sqA, [][][2]float64{b})
	if len(arcs) != 1 || len(arcs[0]) != 4 {
		t.Fatalf("offset neighbour: arcs = %v, want one 4-point arc", arcs)
	}
}

func TestExternalArcsSplitNeighbourEdge(t *testing.T) {
	// One coarse edge of the west ring spans TWO stacked neighbours (the
	// LFRR meridian case): it must classify internal even though no single
	// neighbour covers all of it.
	west := [][2]float64{{2, 0}, {2, 1}, {0, 1}, {0, 0}}
	northEast := [][2]float64{{2, 1}, {2, 2}, {1, 2}, {1, 1}}
	southEast := [][2]float64{{1, 1}, {1, 2}, {0, 2}, {0, 1}}
	arcs := ExternalArcs(west, [][][2]float64{northEast, southEast})
	// The whole eastern edge (2,1)->(0,1) is internal; one seam-merged
	// external arc remains.
	want := [][][2]float64{{{0, 1}, {0, 0}, {2, 0}, {2, 1}}}
	if !reflect.DeepEqual(arcs, want) {
		t.Errorf("ExternalArcs = %v, want %v", arcs, want)
	}
}

// TestApply covers the positional-row plumbing shared by cmd/fr,
// aixm5build and the overlay pipeline: which rows the grouped
// post-pass patches.
func TestApply(t *testing.T) {
	mkRow := func(id, typ string, ring [][2]float64) []any {
		row := make([]any, 15)
		row[0], row[1], row[12] = id, typ, ring
		return row
	}
	rows := []any{
		mkRow("LFFF", "FIR", sqA),
		mkRow("LFRR", "FIR", sqB),
		mkRow("LFFF", "UIR", sqA),    // typed groups: lone UIR stays nil
		mkRow("SOOO", "FIR", sqA),    // no same-state sibling
		mkRow("OCA4521", "OCA", sqA), // no four-letter head: never grouped
		mkRow("LFPG", "TMA", sqA),    // not FIR-family
	}
	Apply(rows)
	if rows[0].([]any)[14] == nil || rows[1].([]any)[14] == nil {
		t.Error("adjacent same-state FIR rows should carry arcs")
	}
	for i, what := range map[int]string{2: "the lone UIR", 3: "the overseas FIR", 4: "the headless OCA", 5: "the TMA"} {
		if rows[i].([]any)[14] != nil {
			t.Errorf("%s must keep nil arcs", what)
		}
	}
}

func TestExternalArcsFullyInternal(t *testing.T) {
	// A ring whose every edge rides a sibling (a Denver-like interior
	// centre, its whole perimeter surrounded): EMPTY non-nil arcs, the
	// signal for the all-internal rendering.
	ringed := [][2]float64{{1, 1}, {1, 2}, {0, 2}, {0, 1}}
	neighbours := [][][2]float64{
		{{1, 0}, {1, 1}, {0, 1}, {0, 0}},   // west
		{{1, 2}, {1, 3}, {0, 3}, {0, 2}},   // east
		{{2, 0}, {2, 3}, {1, 3}, {1, 0}},   // north strip
		{{0, 0}, {0, 3}, {-1, 3}, {-1, 0}}, // south strip
	}
	arcs := ExternalArcs(ringed, neighbours)
	if arcs == nil || len(arcs) != 0 {
		t.Errorf("fully internal ring: arcs = %v, want empty non-nil", arcs)
	}
}
