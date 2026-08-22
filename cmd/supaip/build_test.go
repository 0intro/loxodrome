package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// prevRow builds a decoded previous-artefact row: the shape json.Unmarshal
// hands back, not the typed one buildRow emits.
func prevRow(t *testing.T, id, region, geomSource, validFrom, validTo string) []any {
	t.Helper()
	row := make([]any, len(outputFields))
	for i := range row {
		row[i] = ""
	}
	row[0] = id
	row[2] = region
	row[7] = validFrom
	row[8] = validTo
	row[14] = []any{}
	row[16] = geomSource
	row[20] = []any{}
	row[21] = nil
	return row
}

func TestSplitID(t *testing.T) {
	cases := []struct {
		id     string
		region string
		year   int
		number int
		ok     bool
	}{
		{"metropole-2026-142", "metropole", 2026, 142, true},
		// The region itself carries hyphens, so the numeric tails decide.
		{"car-sam-nam-2026-001", "car-sam-nam", 2026, 1, true},
		{"pac-p-2025-002", "pac-p", 2025, 2, true},
		{"nonsense", "", 0, 0, false},
		{"metropole-notayear-142", "", 0, 0, false},
	}
	for _, c := range cases {
		region, year, number, ok := splitID(c.id)
		if ok != c.ok || region != c.region || year != c.year || number != c.number {
			t.Errorf("splitID(%q) = %q/%d/%d/%v, want %q/%d/%d/%v",
				c.id, region, year, number, ok, c.region, c.year, c.number, c.ok)
		}
	}
}

func TestMergeRetainsDelisted(t *testing.T) {
	fresh := []any{
		[]any{"metropole-2026-150", "150/2026", "metropole"},
	}
	prev := &prevArtifact{
		Fields: outputFields,
		Rows: [][]any{
			// Still listed: the fresh rebuild of it must win.
			prevRow(t, "metropole-2026-150", "metropole", "none", "2026-07-20", "2026-07-31"),
			// Delisted and recent: retained.
			prevRow(t, "metropole-2026-142", "metropole", "pdf-polygon", "2026-07-09", "2026-07-14"),
			// Delisted but older than the floor: pruned.
			prevRow(t, "metropole-2024-233", "metropole", "pdf-polygon", "2024-01-01", "2024-02-01"),
		},
	}

	merged, retained, err := mergeRetained(fresh, prev, mergeOpts{retainFrom: 2026})
	if err != nil {
		t.Fatalf("mergeRetained: %v", err)
	}
	if len(retained) != 1 || rowID(retained[0]) != "metropole-2026-142" {
		t.Fatalf("retained = %v, want just metropole-2026-142", ids(merged))
	}
	if got := ids(merged); len(got) != 2 {
		t.Fatalf("merged = %v, want 2 rows", got)
	}
	// Sorted by (region, year, number), so 142 precedes 150.
	if got := ids(merged); got[0] != "metropole-2026-142" || got[1] != "metropole-2026-150" {
		t.Errorf("merged order = %v", got)
	}
	// The fresh row won: it is the short one built above, not the previous
	// full-width row.
	for _, r := range merged {
		row := r.([]any)
		if rowID(row) == "metropole-2026-150" && len(row) != 3 {
			t.Errorf("row 150 has %d fields, want the fresh row's 3", len(row))
		}
	}
}

func TestMergeSkipsOnFieldDrift(t *testing.T) {
	fresh := []any{[]any{"metropole-2026-150"}}
	prev := &prevArtifact{
		Fields: []string{"id", "title"}, // an older, narrower artefact
		Rows:   [][]any{{"metropole-2026-142", "142/2026"}},
	}
	merged, retained, err := mergeRetained(fresh, prev, mergeOpts{retainFrom: 2026})
	if err == nil {
		t.Fatal("want an error reporting the field drift")
	}
	if len(retained) != 0 || len(merged) != 1 {
		t.Errorf("merged = %v, retained = %d; want the fresh rows untouched", ids(merged), len(retained))
	}
}

func TestMergeDisabled(t *testing.T) {
	fresh := []any{[]any{"metropole-2026-150"}}
	prev := &prevArtifact{
		Fields: outputFields,
		Rows:   [][]any{prevRow(t, "metropole-2026-142", "metropole", "none", "2026-07-09", "2026-07-14")},
	}
	merged, retained, err := mergeRetained(fresh, prev, mergeOpts{retainFrom: 0})
	if err != nil {
		t.Fatalf("mergeRetained: %v", err)
	}
	if len(merged) != 1 || len(retained) != 0 {
		t.Errorf("retainFrom 0 should rebuild from scratch, got %v", ids(merged))
	}
}

// TestMergeKeepsRetainedBytes pins the property the weekly workflow's commit
// guard rests on: a retained row is re-emitted exactly as it was written. A
// decoded object comes back as a Go map, which marshals with its keys sorted,
// so passing the decoded form through would rewrite every retained row's key
// order and make an unchanged rebuild look like a change.
func TestMergeKeepsRetainedBytes(t *testing.T) {
	// Deliberately NOT alphabetical: this is the order buildRow's structs emit.
	const zones = `[{"name":"ZRT 1","geometry":null,"bbox":null}]`
	doc := `{"fields":` + mustJSON(t, outputFields) + `,"rows":[[` +
		`"metropole-2026-142","142/2026","metropole","","","","","2026-07-09","2026-07-14",` +
		`true,true,false,[],[],` + zones + `,null,"pdf-polygon","high",[],"",[],null,""` +
		`]]}`

	var prev prevArtifact
	if err := json.Unmarshal([]byte(doc), &prev); err != nil {
		t.Fatal(err)
	}
	var raw struct {
		Rows [][]json.RawMessage `json:"rows"`
	}
	if err := json.Unmarshal([]byte(doc), &raw); err != nil {
		t.Fatal(err)
	}
	prev.Raw = raw.Rows

	merged, retained, err := mergeRetained(nil, &prev, mergeOpts{retainFrom: 2026})
	if err != nil {
		t.Fatalf("mergeRetained: %v", err)
	}
	if len(retained) != 1 || len(merged) != 1 {
		t.Fatalf("merged %d, retained %d; want 1 and 1", len(merged), len(retained))
	}
	out, err := json.Marshal(merged[0])
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), zones) {
		t.Errorf("retained row was re-encoded, key order lost:\n got %s\n want it to contain %s", out, zones)
	}
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestCountRetained(t *testing.T) {
	meta := Meta{ByRegion: map[string]int{}}
	row := prevRow(t, "metropole-2026-142", "metropole", "pdf-polygon", "2026-07-09", "2026-07-14")
	row[4] = "Creation of a temporary prohibited area"
	row[14] = []any{map[string]any{"lower": []any{"HEI", "0", "FT"}, "upper": nil}}
	row[20] = []any{map[string]any{"unit": "PARIS APP"}}
	row[21] = map[string]any{"kind": "forbidden"}
	row[22] = "DSAC"

	countRetained(row, "2026-07-31", &meta)

	if meta.Total != 1 || meta.ByRegion["metropole"] != 1 {
		t.Errorf("total/byRegion = %d/%d", meta.Total, meta.ByRegion["metropole"])
	}
	if meta.WithGeometry != 1 || meta.Polygon != 1 {
		t.Errorf("geometry counters = %d/%d", meta.WithGeometry, meta.Polygon)
	}
	if meta.WithEnglish != 1 || meta.WithVertical != 1 || meta.WithContacts != 1 ||
		meta.WithPenetration != 1 || meta.WithManager != 1 {
		t.Errorf("coverage counters = en %d vert %d contacts %d pen %d mgr %d",
			meta.WithEnglish, meta.WithVertical, meta.WithContacts,
			meta.WithPenetration, meta.WithManager)
	}
	// Ended before today: neither active nor upcoming, which is the whole
	// reason it is retained rather than listed.
	if meta.Active != 0 || meta.Upcoming != 0 {
		t.Errorf("active/upcoming = %d/%d, want 0/0", meta.Active, meta.Upcoming)
	}
}

// TestReadPreviousRoundTrip pins that a written artefact decodes back into the
// shape the merge reads, which is what makes retention survive a real run.
func TestReadPreviousRoundTrip(t *testing.T) {
	art := map[string]any{
		"fields": outputFields,
		"rows":   []any{prevRow(t, "metropole-2026-142", "metropole", "pdf-polygon", "2026-07-09", "2026-07-14")},
	}
	data, err := json.Marshal(art)
	if err != nil {
		t.Fatal(err)
	}
	var got prevArtifact
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	if !sameFields(got.Fields, outputFields) {
		t.Fatalf("fields drifted: %v", got.Fields)
	}
	if len(got.Rows) != 1 || rowID(got.Rows[0]) != "metropole-2026-142" {
		t.Fatalf("rows = %v", got.Rows)
	}
}

func ids(rows []any) []string {
	out := make([]string, 0, len(rows))
	for _, r := range rows {
		row, ok := r.([]any)
		if !ok {
			continue
		}
		out = append(out, rowID(row))
	}
	return out
}

// The media store shards on the filename's first two characters. Assuming the
// metropole bucket for every region is what left every overseas supplement
// with a urlPdf that 404s, in the dataset and so in the panel that links it.
func TestPdfURLShardsOnTheFilename(t *testing.T) {
	for _, c := range []struct{ file, want string }{
		{"lf_sup_2026_183_fr.pdf", pdfStore + "l/f/lf_sup_2026_183_fr.pdf"},
		{"run_sup_2026_002_fr.pdf", pdfStore + "r/u/run_sup_2026_002_fr.pdf"},
		{"pacp_sup_2026_004_fr.pdf", pdfStore + "p/a/pacp_sup_2026_004_fr.pdf"},
		{"carsamnam_sup_2026_001_fr.pdf", pdfStore + "c/a/carsamnam_sup_2026_001_fr.pdf"},
		{"pacn_sup_a_2026_001_en.pdf", pdfStore + "p/a/pacn_sup_a_2026_001_en.pdf"},
	} {
		if got := pdfURL(c.file); got != c.want {
			t.Errorf("pdfURL(%q) = %q, want %q", c.file, got, c.want)
		}
	}
	// A name too short to shard must not slice out of range.
	if got := pdfURL("a"); got != pdfStore+"a" {
		t.Errorf("pdfURL(%q) = %q", "a", got)
	}
}
