package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/0intro/loxodrome/internal/overlay"
)

// fixedNow gives Build a deterministic GeneratedAt timestamp so we can
// assert on Meta without time-pinning.
func fixedNow() time.Time {
	return time.Date(2026, 5, 21, 4, 0, 0, 0, time.UTC)
}

func readTestdata(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("readTestdata %s: %v", name, err)
	}
	return b
}

func TestParsePruatlas(t *testing.T) {
	data := readTestdata(t, "pruatlas-sample.geojson")
	rows, cycle, err := parsePruatlas(data)
	if err != nil {
		t.Fatalf("parsePruatlas: %v", err)
	}
	if cycle != 524 {
		t.Errorf("cycle: got %d, want 524", cycle)
	}
	// Expect 5 rows kept: LFFF, EGGX (MultiPolygon, 2 rows), EDUU, ZZZZ.
	// LFFA (ANSP type) and XX-1 (non-ICAO) are filtered.
	want := []string{"LFFF", "EGGX", "EGGX", "EDUU", "ZZZZ"}
	if len(rows) != len(want) {
		t.Fatalf("rows: got %d, want %d (%v)", len(rows), len(want), rowIDs(rows))
	}
	for i, id := range want {
		if rows[i].ID != id {
			t.Errorf("rows[%d].ID = %q, want %q", i, rows[i].ID, id)
		}
	}
	// LFFF: 0..195 -> SFC..FL195
	lf := rows[0]
	if got := lf.Lower; got[0] != "SFC" {
		t.Errorf("LFFF lower code = %v, want SFC", got)
	}
	if got := lf.Upper; got[0] != "STD" || got[1] != "195" || got[2] != "FL" {
		t.Errorf("LFFF upper = %v, want [STD 195 FL]", got)
	}
	if len(lf.Ring) < 3 {
		t.Errorf("LFFF ring degenerate: %v", lf.Ring)
	}
	// Multi-polygon EGGX is emitted as two rows sharing the id.
	if rows[1].ID != "EGGX" || rows[2].ID != "EGGX" {
		t.Errorf("EGGX MultiPolygon not split into two rows: %v %v", rows[1].ID, rows[2].ID)
	}
	// UIR type preserved.
	if rows[3].Type != "UIR" {
		t.Errorf("EDUU type = %q, want UIR", rows[3].Type)
	}
}

func TestPruatlasICAOFilter(t *testing.T) {
	// XX-1 (non-letters) and the ANSP-type row must be filtered.
	data := readTestdata(t, "pruatlas-sample.geojson")
	rows, _, err := parsePruatlas(data)
	if err != nil {
		t.Fatalf("parsePruatlas: %v", err)
	}
	for _, r := range rows {
		if r.ID == "LFFA" {
			t.Errorf("ANSP-type row LFFA was not filtered")
		}
		if r.ID == "XX-1" || r.ID == "XX1" {
			t.Errorf("non-ICAO row %q was not filtered", r.ID)
		}
	}
}

func TestBuild(t *testing.T) {
	data := readTestdata(t, "pruatlas-sample.geojson")

	art, meta, err := Build(data, Options{
		URL:          "https://example.com/pru",
		Now:          fixedNow,
		MinAirspaces: 1,
		MaxAirspaces: 100,
	})
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	// 5 pruatlas rows: LFFF, EGGX x2, EDUU, ZZZZ.
	if got := len(art.Rows); got != 5 {
		t.Errorf("rows: got %d, want 5", got)
	}
	// Schema matches the cmd/fr row prefix and the FAA artefact.
	if len(art.Fields) != 15 || art.Fields[0] != "id" || art.Fields[12] != "ring" || art.Fields[14] != "arcs" {
		t.Errorf("fields shape mismatch: %v", art.Fields)
	}
	if meta.AirspaceCount != 5 {
		t.Errorf("meta.AirspaceCount = %d, want 5", meta.AirspaceCount)
	}
	if meta.Source.Count != 5 {
		t.Errorf("meta.Source.Count = %d, want 5", meta.Source.Count)
	}
	if meta.Source.Cycle != 524 {
		t.Errorf("meta.Source.Cycle = %d, want 524", meta.Source.Cycle)
	}
	if meta.Source.URL != "https://example.com/pru" {
		t.Errorf("meta.Source.URL = %q, want example.com/pru", meta.Source.URL)
	}
	if meta.Source.Sha256 == "" {
		t.Errorf("meta.Source.Sha256 missing: %+v", meta)
	}
	if meta.GeneratedAt != "2026-05-21T04:00:00.000Z" {
		t.Errorf("meta.GeneratedAt = %q, want fixed", meta.GeneratedAt)
	}
}

func TestFltriple(t *testing.T) {
	cases := []struct {
		fl   int
		want []string
	}{
		{0, []string{"SFC", "", ""}},
		{-1, []string{"SFC", "", ""}},
		{100, []string{"STD", "100", "FL"}},
		{999, []string{"UNL", "", ""}},
	}
	for _, c := range cases {
		got := flTriple(c.fl)
		if len(got) != 3 || got[0] != c.want[0] || got[1] != c.want[1] || got[2] != c.want[2] {
			t.Errorf("flTriple(%d) = %v, want %v", c.fl, got, c.want)
		}
	}
}

// rowIDs is a quick diagnostic for test failures.
func rowIDs(rows []overlay.Row) []string {
	out := make([]string, 0, len(rows))
	for _, r := range rows {
		out = append(out, r.ID)
	}
	return out
}

// TestBuildRefusesEmpty: a naming drift (or empty payload) that parses to
// zero FIRs must fail the build (sanity window), never commit an empty
// artefact.
func TestBuildRefusesEmpty(t *testing.T) {
	if _, _, err := Build(nil, Options{Now: fixedNow}); err == nil {
		t.Fatalf("Build accepted an empty dataset; want a sanity-window error")
	}
}
