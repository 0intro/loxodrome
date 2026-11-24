package eaip

import "testing"

// A span is bounded by the table: a rowspan past the last row covers
// nothing, and HTML takes a colspan over 1000 as 1000. Expanded position
// by position, a publisher's colspan="1000000" widened every row of the
// table to a million cells, and rowspan="9999999" filled ten million
// positions below it.
func TestExpandCellsBoundsSpans(t *testing.T) {
	doc, err := ParseHTML([]byte(`<table><tr><td colspan="1000000">x</td></tr>` +
		`<tr><td rowspan="9999999">y</td><td>z</td></tr></table>`))
	if err != nil {
		t.Fatal(err)
	}
	grid := ExpandCells(Elems(doc, "table")[0])
	if len(grid) != 2 {
		t.Fatalf("ExpandCells: %d rows, want 2", len(grid))
	}
	for i, row := range grid {
		if len(row) > 1000 {
			t.Errorf("ExpandCells: row %d has %d cells, want at most 1000", i, len(row))
		}
	}
	if got := NodeText(grid[1][1]); got != "z" {
		t.Errorf("ExpandCells: row 1 cell 1 = %q, want %q", got, "z")
	}
}
