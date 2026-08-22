package aip

import (
	"reflect"
	"testing"
)

func rows(pts ...[2]float64) (fields []string, out []any) {
	fields = []string{"ident", "lat", "lon"}
	for _, p := range pts {
		out = append(out, []any{"X", p[0], p[1]})
	}
	return fields, out
}

func TestBBoxOfRows(t *testing.T) {
	f, r := rows([2]float64{48.85, 2.35}, [2]float64{43.3, 5.4}, [2]float64{50.6, 3.1})
	got := BBoxOfRows(f, r)
	want := BBox{2.35, 43.3, 5.4, 50.6}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

// The envelope rounds OUTWARD, so it can never crop the rows it
// describes; a gate that cropped would hide airspace.
func TestBBoxRoundsOutward(t *testing.T) {
	f, r := rows([2]float64{48.8500049, 2.3500049}, [2]float64{48.8500051, 2.3500051})
	got := BBoxOfRows(f, r)
	if got[0] > 2.35 || got[1] > 48.85 || got[2] < 2.3501 || got[3] < 48.8501 {
		t.Fatalf("envelope %v crops its own points", got)
	}
}

// A row whose position failed to parse lands on null island, and one bad
// row would otherwise stretch the envelope across half the planet.
func TestBBoxIgnoresNullIsland(t *testing.T) {
	f, r := rows([2]float64{48.85, 2.35}, [2]float64{0, 0}, [2]float64{43.3, 5.4})
	got := BBoxOfRows(f, r)
	if got[1] < 40 {
		t.Fatalf("null island stretched the envelope: %v", got)
	}
}

func TestBBoxNoCoordinates(t *testing.T) {
	if got := BBoxOfRows([]string{"ident"}, []any{[]any{"X"}}); got != nil {
		t.Fatalf("got %v, want nil", got)
	}
}

// The clustering exists for exactly one reason: a publisher whose
// territory is not connected must not gate on an envelope that spans the
// gaps. France is the case that forced it.
func TestBBoxClusters(t *testing.T) {
	f, r := rows(
		// The metropole.
		[2]float64{48.85, 2.35}, [2]float64{43.3, 5.4}, [2]float64{50.6, 3.1},
		// Reunion, an ocean away.
		[2]float64{-20.89, 55.45}, [2]float64{-21.3, 55.5},
		// French Polynesia, a third of the planet further.
		[2]float64{-17.55, -149.6},
	)
	got := BBoxClustersOfRows(f, r)
	if len(got) != 3 {
		t.Fatalf("got %d clusters, want 3: %v", len(got), got)
	}
	// Every point falls in one of them, and no cluster spans the gaps.
	for _, p := range [][2]float64{{48.85, 2.35}, {-20.89, 55.45}, {-17.55, -149.6}} {
		in := false
		for _, b := range got {
			if b[0] <= p[1] && p[1] <= b[2] && b[1] <= p[0] && p[0] <= b[3] {
				in = true
			}
		}
		if !in {
			t.Errorf("point %v is in no cluster: %v", p, got)
		}
	}
	for _, b := range got {
		if b[2]-b[0] > 90 {
			t.Errorf("cluster %v spans a gap it should have split at", b)
		}
	}
}

// One connected group needs no split: the plain envelope already says
// everything, and an identical cluster list in the sidecar is noise.
func TestBBoxClustersSingleGroup(t *testing.T) {
	f, r := rows([2]float64{48.85, 2.35}, [2]float64{43.3, 5.4}, [2]float64{50.6, 3.1})
	if got := BBoxClustersOfRows(f, r); got != nil {
		t.Fatalf("got %v, want nil for one connected group", got)
	}
}

// The sidecar is bounded: a dataset with more pieces than maxClusters
// merges the nearest pairs rather than growing without limit.
func TestBBoxClustersBounded(t *testing.T) {
	var pts [][2]float64
	for i := range 40 {
		pts = append(pts, [2]float64{float64(i)*2 - 40, float64(i)*8 - 160})
	}
	f, r := rows(pts...)
	got := BBoxClustersOfRows(f, r)
	if len(got) > maxClusters {
		t.Fatalf("got %d clusters, want at most %d", len(got), maxClusters)
	}
}
