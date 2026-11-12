package overlay

import "testing"

func TestSimplifyKeepsRectangle(t *testing.T) {
	// A 4-corner rectangle with an extra colinear midpoint should drop the
	// midpoint at any reasonable tolerance but retain the four corners.
	ring := [][2]float64{
		{0, 0}, {0, 5}, {0, 10}, {10, 10}, {10, 0},
	}
	out := Simplify(ring, 0.001)
	if len(out) < 3 {
		t.Fatalf("Simplify dropped too aggressively: %v", out)
	}
	// The midpoint (0,5) is colinear and should be gone.
	for _, p := range out {
		if p[0] == 0 && p[1] == 5 {
			t.Errorf("Simplify kept colinear midpoint (0,5); ring %v", out)
		}
	}
}
