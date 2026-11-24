// The guard.
//
// The witness measures a placed panel against the ground. The reader places
// a panel from what its own plate states, and those two things must never
// meet. A plate is not a survey (docs/fr-vacgeo.md): Creteil Henri Mondor
// draws its objects at true size and nine per cent too far apart at 170 m,
// so a reader that fitted to the ground would place that panel somewhere
// the plate never said, and would do it while agreeing beautifully with
// imagery.
//
// Six things keep them apart. The first is the only one that cannot be
// argued with: every line of the witness lives in a _test.go file, and Go
// does not link test files into a binary, so cmd/vacgeo CANNOT call it. The
// rest are belt: no function here returns a corrected affine or the
// coefficients to build one, the names say what they are, no measurement
// has a floor to be tuned towards, every emitted row carries `witness:
// true`, and this test fails the day any of the witness's vocabulary
// appears in the reader.
package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWitnessIsNeverAGate(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	banned := []string{"witness", "bdtopo", "geopf", "BDTOPO"}
	checked := 0
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		body, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		checked++
		low := strings.ToLower(string(body))
		for _, b := range banned {
			if strings.Contains(low, strings.ToLower(b)) {
				t.Errorf("%s names %q: the witness observes, it never places. "+
					"A finding is a bug report against the reader, or a hand-typed "+
					"overrides.tsv row a human justified by looking. It is never a "+
					"number this command reads.", f, b)
			}
		}
	}
	if checked < 8 {
		t.Errorf("only %d reader files scanned; the guard is not looking at the reader", checked)
	}
}
