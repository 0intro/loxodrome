package aixm5build

import (
	"reflect"
	"testing"
	"time"

	"github.com/0intro/loxodrome/internal/aixm5"
)

// TestBuildNavaids checks the row schema: the IDPrefix namespacing, the
// type/ident sort, the MHz frequency formatting, and the drop of a navaid
// with no published position (0,0).
func TestBuildNavaids(t *testing.T) {
	mhz := 113.6
	msg := &aixm5.Message{
		Navaids: []aixm5.Navaid{
			{ID: "n2", Type: "VOR", Designator: "BBB", Name: "Bravo", Lat: 52, Lon: 1, FreqMHz: &mhz},
			{ID: "n1", Type: "VOR", Designator: "AAA", Name: "Alpha", Lat: 51, Lon: -1, FreqMHz: &mhz},
			{ID: "n0", Type: "DME", Designator: "ZZZ", Name: "Zulu"}, // Lat/Lon 0,0 -> dropped
		},
		SkippedNonBaseline: 1,
		UnresolvedXlinks:   2,
	}

	fixedNow := func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) }
	art, meta, err := BuildNavaids(msg, "uk-test.xml", []byte("<raw/>"), "2026-05-14T00:00:00Z",
		NavaidsOptions{IDPrefix: "uk", Country: "UK", Now: fixedNow, MinNavaids: 1, MaxNavaids: 100})
	if err != nil {
		t.Fatal(err)
	}

	if meta.NavaidCount != 2 {
		t.Errorf("NavaidCount = %d, want 2 (the 0,0 navaid dropped)", meta.NavaidCount)
	}
	if meta.Counts["VOR"] != 2 {
		t.Errorf("Counts[VOR] = %d, want 2", meta.Counts["VOR"])
	}
	if meta.SkippedNonBaseline != 1 || meta.UnresolvedXlinks != 2 {
		t.Errorf("passthrough counters = %d/%d, want 1/2", meta.SkippedNonBaseline, meta.UnresolvedXlinks)
	}

	if len(art.Rows) != 2 {
		t.Fatalf("rows = %d, want 2", len(art.Rows))
	}
	// Sorted by type then ident: AAA before BBB; ids carry the uk: prefix.
	want := []any{"uk:n1", "VOR", "AAA", "Alpha", 51.0, -1.0, "113.600", "", any(nil)}
	if !reflect.DeepEqual(art.Rows[0], want) {
		t.Errorf("row[0] mismatch:\n got %#v\nwant %#v", art.Rows[0], want)
	}
	if got := art.Rows[1].([]any)[0]; got != "uk:n2" {
		t.Errorf("row[1] id = %v, want uk:n2", got)
	}
}
