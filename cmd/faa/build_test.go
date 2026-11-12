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

func TestParseFAABoundary(t *testing.T) {
	data := readTestdata(t, "faa-boundary-sample.json")
	rows, err := parseFAA(data)
	if err != nil {
		t.Fatalf("parseFAA: %v", err)
	}
	// 5 known TYPE_CODEs kept (FIR, OCA, ARTCC, CLASS, ADIZ); the "WEIRD"
	// row is dropped because faaEmitType returns "" for unknown codes.
	// ZAB ARTCC -> KZAB via the K-prefix rule.
	wantIDs := []string{"PAZN", "RPHI", "KZAB", "ATLANTIC HIGH", "GUAM ADIZ INNER"}
	wantTypes := []string{"FIR", "OCA", "ARTCC", "CLASS", "ADIZ"}
	if len(rows) != len(wantIDs) {
		t.Fatalf("rows: got %d %v, want %d (%v)", len(rows), rowIDs(rows), len(wantIDs), wantIDs)
	}
	for i, w := range wantIDs {
		if rows[i].ID != w {
			t.Errorf("rows[%d].ID = %q, want %q", i, rows[i].ID, w)
		}
		if rows[i].Type != wantTypes[i] {
			t.Errorf("rows[%d].Type = %q, want %q", i, rows[i].Type, wantTypes[i])
		}
	}
	// PAZN: UNLIMITED + SFC -> upper = [UNL "" ""], lower = [SFC "" ""]
	p := rows[0]
	if p.Upper[0] != "UNL" {
		t.Errorf("PAZN upper = %v, want UNL head", p.Upper)
	}
	if p.Lower[0] != "SFC" {
		t.Errorf("PAZN lower = %v, want SFC head", p.Lower)
	}
	// ATLANTIC HIGH: lower 18000 FT MSL -> [ALT 18000 FT]
	atl := rows[3]
	if atl.Lower[0] != "ALT" || atl.Lower[1] != "18000" || atl.Lower[2] != "FT" {
		t.Errorf("ATLANTIC HIGH lower = %v, want [ALT 18000 FT]", atl.Lower)
	}
}

func TestParseFAASua(t *testing.T) {
	data := readTestdata(t, "faa-sua-sample.json")
	rows, err := parseFAA(data)
	if err != nil {
		t.Fatalf("parseFAA: %v", err)
	}
	wantTypes := []string{"R", "MOA", "W"}
	if len(rows) != len(wantTypes) {
		t.Fatalf("rows: got %d %v, want %d", len(rows), rowIDs(rows), len(wantTypes))
	}
	for i, w := range wantTypes {
		if rows[i].Type != w {
			t.Errorf("rows[%d].Type = %q, want %q", i, rows[i].Type, w)
		}
	}
	// DESERT MOA: lower 300 FT AGL -> [HEI 300 FT]
	moa := rows[1]
	if moa.Lower[0] != "HEI" || moa.Lower[1] != "300" || moa.Lower[2] != "FT" {
		t.Errorf("DESERT MOA lower = %v, want [HEI 300 FT]", moa.Lower)
	}
}

func TestParseFAAClass(t *testing.T) {
	data := readTestdata(t, "faa-class-sample.json")
	rows, err := parseFAA(data)
	if err != nil {
		t.Fatalf("parseFAA: %v", err)
	}
	// Boston B + Abilene C + Lynden D + Aberdeen E. The MODE-C row is
	// filtered by faaEmitType so it never reaches the row list.
	wantTypes := []string{"CLASS", "CLASS", "CLASS", "CLASS"}
	wantClasses := []string{"B", "C", "D", "E"}
	wantIDs := []string{"BOS", "ABI", "CYXX", "ABR"}
	if len(rows) != len(wantTypes) {
		t.Fatalf("rows: got %d %v, want %d", len(rows), rowIDs(rows), len(wantTypes))
	}
	for i, w := range wantTypes {
		if rows[i].Type != w {
			t.Errorf("rows[%d].Type = %q, want %q", i, rows[i].Type, w)
		}
		if rows[i].Class != wantClasses[i] {
			t.Errorf("rows[%d].Class = %q, want %q", i, rows[i].Class, wantClasses[i])
		}
		if rows[i].ID != wantIDs[i] {
			t.Errorf("rows[%d].ID = %q, want %q", i, rows[i].ID, wantIDs[i])
		}
	}
	// Boston B: 7000 FT MSL -> [ALT 7000 FT]
	bos := rows[0]
	if bos.Upper[0] != "ALT" || bos.Upper[1] != "7000" || bos.Upper[2] != "FT" {
		t.Errorf("BOS upper = %v, want [ALT 7000 FT]", bos.Upper)
	}
	if bos.Lower[0] != "SFC" {
		t.Errorf("BOS lower = %v, want SFC", bos.Lower)
	}
	// Aberdeen E5: UPPER_VAL=-9998 sentinel -> nil triple -> blank upper.
	abr := rows[3]
	if abr.Upper != nil {
		t.Errorf("ABR upper = %v, want nil (sentinel filtered)", abr.Upper)
	}
	if abr.Lower[0] != "HEI" || abr.Lower[1] != "700" {
		t.Errorf("ABR lower = %v, want [HEI 700 FT]", abr.Lower)
	}
}

func TestBuild(t *testing.T) {
	bnd := readTestdata(t, "faa-boundary-sample.json")
	sua := readTestdata(t, "faa-sua-sample.json")
	cls := readTestdata(t, "faa-class-sample.json")

	art, meta, err := Build(bnd, sua, cls, Options{
		BndURL:       "https://example.com/bnd",
		SuaURL:       "https://example.com/sua",
		ClassURL:     "https://example.com/class",
		Now:          fixedNow,
		MinAirspaces: 1,
		MaxAirspaces: 100,
	})
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	// 5 boundary + 3 SUA + 4 class = 12.
	if got := len(art.Rows); got != 12 {
		t.Errorf("rows: got %d, want 12", got)
	}
	if len(art.Fields) != 15 || art.Fields[0] != "id" || art.Fields[12] != "ring" || art.Fields[14] != "arcs" {
		t.Errorf("fields shape mismatch: %v", art.Fields)
	}
	if meta.AirspaceCount != 12 {
		t.Errorf("meta.AirspaceCount = %d, want 12", meta.AirspaceCount)
	}
	if meta.Boundary.Count != 5 {
		t.Errorf("meta.Boundary.Count = %d, want 5", meta.Boundary.Count)
	}
	if meta.SpecialUse.Count != 3 {
		t.Errorf("meta.SpecialUse.Count = %d, want 3", meta.SpecialUse.Count)
	}
	if meta.Class.Count != 4 {
		t.Errorf("meta.Class.Count = %d, want 4", meta.Class.Count)
	}
	if meta.Boundary.Sha256 == "" || meta.SpecialUse.Sha256 == "" || meta.Class.Sha256 == "" {
		t.Errorf("missing source sha256: %+v", meta)
	}
	// FAA has no AIRAC; Cycle must stay zero on each per-source meta so
	// it drops out of the JSON via omitempty.
	if meta.Boundary.Cycle != 0 || meta.SpecialUse.Cycle != 0 || meta.Class.Cycle != 0 {
		t.Errorf("FAA SourceMeta carried a non-zero Cycle: %+v", meta)
	}
	if meta.GeneratedAt != "2026-05-21T04:00:00.000Z" {
		t.Errorf("meta.GeneratedAt = %q, want fixed", meta.GeneratedAt)
	}
	// Counts map covers what was emitted.
	// PAZN is the only FIR-typed FAA row; RPHI is OCA in the FAA feed.
	if meta.Counts["FIR"] != 1 {
		t.Errorf("counts FIR = %d, want 1 (PAZN)", meta.Counts["FIR"])
	}
	if meta.Counts["OCA"] != 1 {
		t.Errorf("counts OCA = %d, want 1 (RPHI)", meta.Counts["OCA"])
	}
	// 4 from Class_Airspace (Boston B / Abilene C / Lynden D / Aberdeen E)
	// + 1 from Boundary_Airspace ("ATLANTIC HIGH", a CLASS-typed offshore
	// Class A polygon already in the Boundary feed) = 5.
	if meta.Counts["CLASS"] != 5 {
		t.Errorf("counts CLASS = %d, want 5", meta.Counts["CLASS"])
	}
}

func TestFaaTriple(t *testing.T) {
	cases := []struct {
		name string
		code string
		uom  string
		val  float64
		desc string
		want []string
	}{
		{"SFC by code", "SFC", "", 0, "", []string{"SFC", "", ""}},
		{"SFC by desc", "", "", 0, "Surface", []string{"SFC", "", ""}},
		{"Unlimited by code", "UNLTD", "", 0, "", []string{"UNL", "", ""}},
		{"Unlimited by desc", "", "", 0, "TO UNLIMITED", []string{"UNL", "", ""}},
		{"FL band", "STD", "FL", 245, "FL245", []string{"STD", "245", "FL"}},
		{"MSL feet", "MSL", "FT", 18000, "18000 FT MSL", []string{"ALT", "18000", "FT"}},
		{"AGL feet", "AGL", "FT", 300, "300 FT AGL", []string{"HEI", "300", "FT"}},
		{"MSL FL collapses to STD", "MSL", "FL", 250, "FL250", []string{"STD", "250", "FL"}},
		// A blank / unrecognized code keeps an EMPTY datum (it used to claim
		// STD): live rows like R-4001B publish 10000 ft MSL with a null code.
		{"Blank code keeps unknown datum", "", "FT", 10000, "TI", []string{"", "10000", "FT"}},
		{"Blank code with FL unit is standard", "", "FL", 180, "", []string{"STD", "180", "FL"}},
		{"Zero value with no SFC/unlimited returns nil", "", "FT", 0, "", nil},
		{"FAA -9998 sentinel returns nil", "STD", "", -9998, "", nil},
		{"FAA -9999 sentinel returns nil", "STD", "", -9999, "", nil},
		// Sub-sea-level MSL (Bar Yehuda, Dead Sea: -1300 ft MSL) must
		// survive the sentinel guard.
		{"Negative MSL preserved", "MSL", "FT", -1300, "1300 FT BELOW MSL", []string{"ALT", "-1300", "FT"}},
	}
	for _, c := range cases {
		got := faaTriple(c.code, c.uom, c.val, c.desc)
		if c.want == nil {
			if got != nil {
				t.Errorf("%s: got %v, want nil", c.name, got)
			}
			continue
		}
		if len(got) != 3 || got[0] != c.want[0] || got[1] != c.want[1] || got[2] != c.want[2] {
			t.Errorf("%s: faaTriple(%q,%q,%v,%q) = %v, want %v",
				c.name, c.code, c.uom, c.val, c.desc, got, c.want)
		}
	}
}

func TestFaaIDPrefersIcaoForFIR(t *testing.T) {
	id := faaID("FIR", faaProperties{IDENT: "ZAP", IcaoID: "PAZN"})
	if id != "PAZN" {
		t.Errorf("faaID FIR with both: got %q, want PAZN", id)
	}
}

func TestFaaIDArtccKPrefix(t *testing.T) {
	cases := []struct {
		ident string
		want  string
	}{
		// CONUS ARTCCs: 3-letter Z-prefix becomes K-prefixed ICAO.
		{"ZAB", "KZAB"},
		{"ZNY", "KZNY"},
		{"ZBW", "KZBW"},
		// Non-CONUS exceptions mapped to their real ICAO regions.
		{"ZAN", "PAZA"},
		{"ZHN", "PHZH"},
		{"ZSU", "TJZS"},
		// Unrecognised ident: pass through unchanged.
		{"ANC", "ANC"},
		{"", ""},
	}
	for _, c := range cases {
		got := faaID("ARTCC", faaProperties{IDENT: c.ident})
		if got != c.want {
			t.Errorf("faaID ARTCC %q: got %q, want %q", c.ident, got, c.want)
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

// TestBuildRefusesEmpty: a schema drift that parses every feed to zero rows
// must fail the build (sanity window), never commit an empty artefact.
func TestBuildRefusesEmpty(t *testing.T) {
	empty := []byte(`{"features":[]}`)
	if _, _, err := Build(empty, empty, empty, Options{Now: fixedNow}); err == nil {
		t.Fatalf("Build accepted an empty dataset; want a sanity-window error")
	}
}
