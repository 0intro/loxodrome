package aip

import (
	"reflect"
	"testing"
)

func TestDropRepeatedRows(t *testing.T) {
	pylon := []any{"es:1", "pylon", 40.4, -3.8, 700}
	mast := []any{"es:2", "mast", 41.0, -3.0, 650}
	antenna := []any{"18293531", "antenna", 45.1, 1.1, 300}
	turbine := []any{"18293531", "windturbine", 46.2, 2.2, 400}
	rows := []any{
		pylon,
		antenna,
		[]any{"es:1", "pylon", 40.4, -3.8, 700}, // the same record filed again
		mast,
		turbine, // another record under a used id
		[]any{"18293531", "antenna", 45.1, 1.1, 300}, // and the first one again
	}
	kept, dropped, conflicts := DropRepeatedRows(rows, 0)
	if want := []any{pylon, antenna, mast, turbine}; !reflect.DeepEqual(kept, want) {
		t.Errorf("kept = %v, want %v", kept, want)
	}
	if dropped != 2 {
		t.Errorf("dropped = %d, want 2", dropped)
	}
	if want := []string{"18293531"}; !reflect.DeepEqual(conflicts, want) {
		t.Errorf("conflicts = %v, want %v", conflicts, want)
	}
}

func TestDropRepeatedRowsLeavesUniqueRowsAlone(t *testing.T) {
	rows := []any{[]any{"a", 1}, []any{"b", 1}, []any{"c", 2}}
	kept, dropped, conflicts := DropRepeatedRows(rows, 0)
	if !reflect.DeepEqual(kept, rows) || dropped != 0 || conflicts != nil {
		t.Errorf("DropRepeatedRows(unique) = %v, %d, %v; want the rows untouched", kept, dropped, conflicts)
	}
	// The input is not reused as the output's backing array.
	kept[0] = nil
	if rows[0] == nil {
		t.Error("DropRepeatedRows aliased its input")
	}
}

// TestSeparateConflictingRows: the rows of an id two records carry each keep
// their own id, ordered by their content so the file order decides nothing:
// the first keeps the bare id, the others take #2, #3. None is dropped, the
// chart drawing both where it cannot tell which one is right.
func TestSeparateConflictingRows(t *testing.T) {
	a := []any{"es:wt1", "windturbine", 40.1, -3.1, 120}
	b := []any{"es:wt1", "windturbine", 40.1, -3.1, 150}
	other := []any{"es:2", "mast", 41.0, -3.0, 650}
	for _, order := range [][]any{{a, b, other}, {b, other, a}} {
		rows := make([]any, len(order))
		for i, r := range order {
			rows[i] = append([]any(nil), r.([]any)...)
		}
		_, _, conflicts := DropRepeatedRows(rows, 0)
		if n := SeparateConflictingRows(rows, 0, conflicts); n != 1 {
			t.Errorf("renamed = %d, want 1", n)
		}
		ids := map[float64]string{}
		for _, r := range rows {
			row := r.([]any)
			if row[1] == "windturbine" {
				ids[float64(row[4].(int))] = row[0].(string)
			}
		}
		if ids[120] != "es:wt1" || ids[150] != "es:wt1#2" {
			t.Errorf("order %v: ids = %v, want 120 -> es:wt1 and 150 -> es:wt1#2 whatever the file order", order, ids)
		}
	}
}
