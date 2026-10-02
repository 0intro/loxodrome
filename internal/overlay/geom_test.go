package overlay

import "testing"

func TestSplitAntimeridianNoCrossing(t *testing.T) {
	// A polygon entirely in the Atlantic should pass through unchanged.
	ring := [][2]float64{
		{40, -50}, {40, -30}, {50, -30}, {50, -50},
	}
	out := SplitAntimeridian(ring)
	if len(out) != 1 || len(out[0]) != 4 {
		t.Fatalf("non-crossing ring should pass through: got %d piece(s)", len(out))
	}
}

func TestSplitAntimeridianPacific(t *testing.T) {
	// A rectangular polygon centred on 180 deg lon (Pacific FIR shape).
	// Vertex order: NW, NE (crosses into +180), SE, SW (crosses back into
	// -180).
	ring := [][2]float64{
		{20, 170},  // a
		{20, -170}, // b; crossing a->b (dlon=-340)
		{10, -170}, // c
		{10, 170},  // d; crossing c->d (dlon=+340)
	}
	out := SplitAntimeridian(ring)
	if len(out) != 2 {
		t.Fatalf("Pacific ring should split into 2 pieces, got %d", len(out))
	}
	// Each piece must have >= 3 vertices and lie entirely on one side.
	for i, p := range out {
		if len(p) < 3 {
			t.Errorf("piece %d has %d vertices", i, len(p))
		}
		neg, pos := false, false
		for _, v := range p {
			if v[1] < 0 {
				neg = true
			} else if v[1] > 0 {
				pos = true
			}
		}
		if neg && pos {
			t.Errorf("piece %d straddles the meridian: %v", i, p)
		}
	}
	// Each piece must include a +/-180 boundary vertex at the interpolated
	// latitude (which sits between 10 and 20; the symmetric case is 15).
	foundEast, foundWest := false, false
	for _, p := range out {
		for _, v := range p {
			if v[1] == 180 {
				foundEast = true
			}
			if v[1] == -180 {
				foundWest = true
			}
		}
	}
	if !foundEast || !foundWest {
		t.Errorf("missing boundary vertices: east=%v west=%v", foundEast, foundWest)
	}
}
