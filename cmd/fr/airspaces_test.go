package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

var updateWant = flag.Bool("update", false, "update *.want.json files in testdata/")

// TestBuildAirspaces runs the converter over the synthetic fixture and
// compares the artifact and meta byte-for-byte against golden files.
func TestBuildAirspaces(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("testdata", "airspaces", "sample.aixm.xml"))
	if err != nil {
		t.Fatal(err)
	}
	fixedNow := func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) }
	artifact, meta, err := BuildAirspaces(src, AirspacesOptions{
		Source:       "sample.aixm.xml",
		Now:          fixedNow,
		MinAirspaces: 1,
		MaxAirspaces: 100,
	})
	if err != nil {
		t.Fatal(err)
	}

	gotArtifact, err := json.Marshal(artifact)
	if err != nil {
		t.Fatal(err)
	}
	gotMeta, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	gotMeta = append(gotMeta, '\n')

	checkWant(t, filepath.Join("testdata", "airspaces", "airspaces.want.json"), gotArtifact)
	checkWant(t, filepath.Join("testdata", "airspaces", "airspaces.meta.want.json"), gotMeta)

	// Spot-check the decoded counts the golden file also pins.
	// 12 rows: 4 TMA/CTR/D/P + 1 FIR + 3 SIVs + 1 FBZ + 1 LTA + a
	// same-extent TMA pair (the base plus its borrowed class E twin).
	if meta.AirspaceCount != 12 {
		t.Errorf("AirspaceCount = %d, want 12", meta.AirspaceCount)
	}
	// 2 wanted rows (one R + one SIV) lack boundaries, the D-OTHER activity
	// row also has none, and the FIR twin is excluded from the same-extent
	// borrow (so it too lacks a boundary): SkippedNoBoundary is 4.
	if meta.SkippedNoBoundary != 4 {
		t.Errorf("SkippedNoBoundary = %d, want 4", meta.SkippedNoBoundary)
	}
	// Exactly one row (the class E TMA twin) borrows a same-extent base's
	// boundary; the FIR twin does not (FIR family excluded).
	if meta.SameExtentCount != 1 {
		t.Errorf("SameExtentCount = %d, want 1", meta.SameExtentCount)
	}
	// classifyAse now accepts FBZ / DLG-ATS / FRA / TMZ-RMZ alongside
	// SIV / TMZ / RMZ, so nothing in the fixture lands in
	// SkippedNoClassify any more.
	if meta.SkippedNoClassify != 0 {
		t.Errorf("SkippedNoClassify = %d, want 0", meta.SkippedNoClassify)
	}
	// LFFFFSN gets nothing from buildSIVRadio (no Sae on its stem) so it
	// stays without radio in the AIXM-only path. The SIA-fed test below
	// covers the inject case that gives it a frequency.
	if meta.WithRadio != 3 {
		t.Errorf("WithRadio = %d, want 3", meta.WithRadio)
	}
}

func checkWant(t *testing.T, path string, got []byte) {
	t.Helper()
	if *updateWant {
		if err := os.WriteFile(path, got, 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("updated %s", path)
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v (run `go test -update` to create it)", path, err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("%s mismatch (run `go test -update` to refresh)\n--- got ---\n%s\n--- want ---\n%s",
			path, got, want)
	}
}

// TestClassifyAse covers the codeType + txtLocalType + codeActivity
// dispatch that produces each row's emitted `type` and its wanted flag.
func TestClassifyAse(t *testing.T) {
	cases := []struct {
		name         string
		codeType     string
		txtLocalType string
		codeActivity string
		wantEmit     string
		wantWanted   bool
	}{
		// Pass-throughs (wanted, emit unchanged).
		{"TMA passes through", "TMA", "", "", "TMA", true},
		{"CTR passes through", "CTR", "", "", "CTR", true},
		{"R passes through", "R", "", "", "R", true},
		{"FIR passes through", "FIR", "", "", "FIR", true},
		{"UIR passes through", "UIR", "", "", "UIR", true},
		{"OCA passes through", "OCA", "", "", "OCA", true},
		{"UTA passes through", "UTA", "", "", "UTA", true},
		// UIR-P folds into UIR.
		{"UIR-P -> UIR", "UIR-P", "", "", "UIR", true},
		// RAS by txtLocalType (wanted; emit may be "" for unrecognised
		// subtype so the caller counts it in skippedNoClassify).
		{"RAS+FLIGHT INFORMATION SECTOR -> SIV", "RAS", "FLIGHT INFORMATION SECTOR", "", "SIV", true},
		{"RAS+TMZ -> TMZ", "RAS", "TMZ", "", "TMZ", true},
		{"RAS+RMZ -> RMZ", "RAS", "RMZ", "", "RMZ", true},
		{"RAS+RMZ-TMZ -> TMZ-RMZ", "RAS", "RMZ-TMZ", "", "TMZ-RMZ", true},
		{"RAS+FBZ -> FBZ", "RAS", "FBZ", "", "FBZ", true},
		{"RAS+DLG-ATS -> DLG-ATS", "RAS", "DLG-ATS", "", "DLG-ATS", true},
		{"RAS+FRA -> FRA", "RAS", "FRA", "", "FRA", true},
		{"RAS+ (blank) -> wanted-unclassified", "RAS", "", "", "", true},
		{"RAS+UNKNOWN -> wanted-unclassified", "RAS", "WEIRDSUBTYPE", "", "", true},
		// D-OTHER by codeActivity (always wanted; ACTIVITY is the default
		// bucket).
		{"D-OTHER+PARAGLIDER", "D-OTHER", "", "PARAGLIDER", "PARAGLIDER", true},
		{"D-OTHER+GLIDER", "D-OTHER", "", "GLIDER", "GLIDER", true},
		{"D-OTHER+BALLOON", "D-OTHER", "", "BALLOON", "BALLOON", true},
		{"D-OTHER+PARACHUTE", "D-OTHER", "", "PARACHUTE", "PARACHUTE", true},
		{"D-OTHER+TOWING", "D-OTHER", "", "TOWING", "TOWING", true},
		{"D-OTHER (no activity) -> ACTIVITY", "D-OTHER", "TRVL", "", "ACTIVITY", true},
		// D-OTHER + txtLocalType LTA is a control area, not an activity; it
		// routes ahead of codeActivity, so even a stray activity tag can't
		// pull it into the ACTIVITY bucket.
		{"D-OTHER+LTA -> LTA", "D-OTHER", "LTA", "", "LTA", true},
		{"D-OTHER+LTA wins over codeActivity", "D-OTHER", "LTA", "BALLOON", "LTA", true},
		// Lowercase / surrounding whitespace must still dispatch.
		{"RAS+ tmz (mixed case)", "RAS", " tmz ", "", "TMZ", true},
		{"D-OTHER+ paragliding (mixed case)", "D-OTHER", "", " Paraglider ", "PARAGLIDER", true},
		{"D-OTHER+ lta (mixed case)", "D-OTHER", " Lta ", "", "LTA", true},
		// Silent drops (unwanted codeType, never counted).
		{"SECTOR silently dropped", "SECTOR", "", "", "", false},
		{"SECTOR-C silently dropped", "SECTOR-C", "", "", "", false},
		{"Unknown codeType silently dropped", "WEIRDTYPE", "", "", "", false},
	}
	for _, c := range cases {
		var a Ase
		a.Uid.CodeType = c.codeType
		a.TxtLocalType = c.txtLocalType
		a.CodeActivity = c.codeActivity
		emit, wanted := classifyAse(&a)
		if emit != c.wantEmit || wanted != c.wantWanted {
			t.Errorf("%s: classifyAse = (%q, %v), want (%q, %v)",
				c.name, emit, wanted, c.wantEmit, c.wantWanted)
		}
	}
}

// TestClassifyAseFIC pins the FIR-level split of the Flight Information
// Sectors: a codeId of FIR-ident + "FS" emits FIC, an aerodrome-ident FS
// id stays SIV (TFFRFS Pointe-a-Pitre: TFFR is the aerodrome, the FIR is
// TFFF), and the rule never fires off a non-SIV row.
func TestClassifyAseFIC(t *testing.T) {
	cases := []struct {
		codeId   string
		wantEmit string
	}{
		{"LFFFFSO", "FIC"},  // PARIS OUEST
		{"LFMMFSN1", "FIC"}, // MARSEILLE NORD (numbered suffix)
		{"NWWWFS", "FIC"},   // NOUVELLE CALEDONIE (overseas FIR, bare)
		{"SOCAFS", "FIC"},   // CAYENNE
		{"TFFRFS", "SIV"},   // aerodrome ident, not the TFFF FIR
		{"LFBDFS1", "SIV"},  // AQUITAINE 1 (Bordeaux-Merignac APP)
		{"LFRNFSNORD", "SIV"},
	}
	for _, c := range cases {
		var a Ase
		a.Uid.CodeType = "RAS"
		a.Uid.CodeId = c.codeId
		a.TxtLocalType = "FLIGHT INFORMATION SECTOR"
		emit, wanted := classifyAse(&a)
		if emit != c.wantEmit || !wanted {
			t.Errorf("%s: classifyAse = (%q, %v), want (%q, true)",
				c.codeId, emit, wanted, c.wantEmit)
		}
	}
	// The id rule must not reclassify a non-SIV RAS row.
	var a Ase
	a.Uid.CodeType = "RAS"
	a.Uid.CodeId = "LFFFFSX"
	a.TxtLocalType = "TMZ"
	if emit, _ := classifyAse(&a); emit != "TMZ" {
		t.Errorf("TMZ with FIR-ident id: classifyAse emit = %q, want TMZ", emit)
	}
}

// TestClassifyAseForeignTwin pins the drop of the SIA's republished copy
// of a neighbouring state's FIR / UIR (LECB "BARCELONA"): emitting it
// would shadow every ENAIRE volume sharing the id in the app's merge.
// French rows and the overseas-serving foreign idents are unaffected.
func TestClassifyAseForeignTwin(t *testing.T) {
	cases := []struct {
		codeType   string
		codeId     string
		wantEmit   string
		wantWanted bool
	}{
		{"UIR", "LECB", "", false}, // the shipped SIA row
		{"FIR", "LECB", "", false}, // future-proof: same rule per type
		{"UIR", "LFFF", "UIR", true},
		{"FIR", "SOOO", "FIR", true}, // CAYENNE serves French Guiana
		{"FIR", "CZQX", "FIR", true}, // GANDER DOMESTIC serves St-Pierre
		{"OCA", "LECB", "OCA", true}, // rule is FIR / UIR only
	}
	for _, c := range cases {
		var a Ase
		a.Uid.CodeType = c.codeType
		a.Uid.CodeId = c.codeId
		emit, wanted := classifyAse(&a)
		if emit != c.wantEmit || wanted != c.wantWanted {
			t.Errorf("%s %s: classifyAse = (%q, %v), want (%q, %v)",
				c.codeType, c.codeId, emit, wanted, c.wantEmit, c.wantWanted)
		}
	}
}

// TestSlabSuffixStrip pins the vertical-slab name tail dropped from a
// borrowed same-extent twin: ".20" / ".30" / ".40", including the
// trailing-space "AZ4 .20" form and the "BIARRITZ 9.2.20" case where a real
// part number ".2" must survive while the slab ".20" goes. Names without the
// tail pass through untouched.
func TestSlabSuffixStrip(t *testing.T) {
	cases := []struct{ in, want string }{
		{"CLERMONT 2.20", "CLERMONT 2"},
		{"FRANCE 3 ALPES 5.20", "FRANCE 3 ALPES 5"},
		{"BIARRITZ 9.2.20", "BIARRITZ 9.2"},
		{"BALE DELEG.ZURICH-AZ4 .20", "BALE DELEG.ZURICH-AZ4"},
		{"LYON 06.30", "LYON 06"},
		{"AREA 2.40", "AREA 2"},
		{"BASE TMA", "BASE TMA"},
		{"NICE 9", "NICE 9"},
	}
	for _, c := range cases {
		if got := slabSuffixRe.ReplaceAllString(c.in, ""); got != c.want {
			t.Errorf("strip(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// TestAseRowBorrowedName pins that the slab-suffix strip fires only for a
// borrowed same-extent twin; a row with its own boundary keeps its name.
func TestAseRowBorrowedName(t *testing.T) {
	var a Ase
	a.Uid.CodeId = "LFXXB.20"
	a.TxtName = "BASE TMA.20"
	// airspacesOutputFields index 2 is the name.
	if got := aseRow(&a, "TMA", nil, nil, true)[2]; got != "BASE TMA" {
		t.Errorf("borrowed name = %q, want %q", got, "BASE TMA")
	}
	if got := aseRow(&a, "TMA", nil, nil, false)[2]; got != "BASE TMA.20" {
		t.Errorf("non-borrowed name = %q, want %q (unchanged)", got, "BASE TMA.20")
	}
}

// TestBuildSIVRadioNarrowedBySIA feeds both fixtures and asserts that the
// SIA proprietary remarks narrow each Lille-SIV-shaped row down to the
// frequencies actually assigned to that sub-sector; the LILLE 2 fix.
func TestBuildSIVRadioNarrowedBySIA(t *testing.T) {
	aixm, err := os.ReadFile(filepath.Join("testdata", "airspaces", "sample.aixm.xml"))
	if err != nil {
		t.Fatal(err)
	}
	sia, err := os.ReadFile(filepath.Join("testdata", "airspaces", "sample.sia.xml"))
	if err != nil {
		t.Fatal(err)
	}
	artifact, meta, err := BuildAirspaces(aixm, AirspacesOptions{
		Source:       "sample.aixm.xml",
		SIASource:    sia,
		Now:          func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) },
		MinAirspaces: 1,
		MaxAirspaces: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	if meta.SIASectorMappedCount != 2 {
		t.Errorf("SIASectorMappedCount = %d, want 2 (LFXXFS1 + LFXXFS2)", meta.SIASectorMappedCount)
	}
	if meta.SIASectorInjectCount != 1 {
		t.Errorf("SIASectorInjectCount = %d, want 1 (LFFFFSN)", meta.SIASectorInjectCount)
	}

	// Row layout: [id, type, name, class, upper, lower, max, mnm, workHr,
	// rmkWorkHr, rmk, radio, ring]. Find LFXXFS1 / LFXXFS2 by id.
	gotRadio := func(id string) []string {
		t.Helper()
		for _, r := range artifact.Rows {
			row := r.([]any)
			if row[0] != id {
				continue
			}
			entries := row[11].([]any)
			out := make([]string, 0, len(entries))
			for _, e := range entries {
				triple := e.([]string)
				out = append(out, triple[0])
			}
			return out
		}
		t.Fatalf("no row for id %q", id)
		return nil
	}

	got := gotRadio("LFXXFS1")
	wantFS1 := []string{"120.000", "122.000"}
	if !equalStrings(got, wantFS1) {
		t.Errorf("LFXXFS1 radio = %v, want %v", got, wantFS1)
	}

	got = gotRadio("LFXXFS2")
	wantFS2 := []string{"121.000", "122.000"}
	if !equalStrings(got, wantFS2) {
		t.Errorf("LFXXFS2 radio = %v, want %v", got, wantFS2)
	}

	// Inject path: LFFFFSN sits on a stem with no AIXM Sae, so
	// buildSIVRadio returns nothing for it. The SIA proprietary file
	// places 119.000 there via SecteurSituation=NORD on
	// "FIS AAA Information"; the inject path should synthesise the
	// triple from SIA alone.
	got = gotRadio("LFFFFSN")
	if !equalStrings(got, []string{"119.000"}) {
		t.Errorf("LFFFFSN radio = %v, want [119.000]", got)
	}
	for _, r := range artifact.Rows {
		row := r.([]any)
		if row[0] != "LFFFFSN" {
			continue
		}
		entries := row[11].([]any)
		if len(entries) != 1 {
			t.Fatalf("LFFFFSN should have 1 radio entry, got %d", len(entries))
		}
		triple := entries[0].([]string)
		if triple[1] != "FIS AAA Information" {
			t.Errorf("LFFFFSN unit = %q, want %q", triple[1], "FIS AAA Information")
		}
		if triple[2] != "AAA - INFORMATION" {
			t.Errorf("LFFFFSN callsign = %q, want %q", triple[2], "AAA - INFORMATION")
		}
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	// Compare as sets; buildSIVRadio's iteration order isn't a contract.
	am := make(map[string]int, len(a))
	for _, s := range a {
		am[s]++
	}
	for _, s := range b {
		am[s]--
	}
	for _, n := range am {
		if n != 0 {
			return false
		}
	}
	return true
}

// TestApplySectorEntries covers the narrow+augment core: a frequency the AIXM
// already linked keeps its real ICAO unit; a SIA-tagged frequency the AIXM
// never linked (the Iroise 119.575 orphan shape) is synthesised in.
func TestApplySectorEntries(t *testing.T) {
	// Iroise shape: AIXM stem union only has 135.825 (Iroise 1); the SIA
	// assigns this sub-sector 119.575, which the AIXM never Sae-linked.
	radio := []any{[]string{"135.825", "LFRB BRETAGNE", "IROISE - INFORMATION"}}
	entries := []InjectEntry{{Freq: "119.575", Unit: "FIS IROISE Information", Callsign: "IROISE - INFORMATION"}}
	got := applySectorEntries(radio, entries)
	if len(got) != 1 {
		t.Fatalf("len = %d, want 1 (135.825 narrowed out, 119.575 augmented): %v", len(got), got)
	}
	if e := got[0].([]string); e[0] != "119.575" || e[1] != "FIS IROISE Information" || e[2] != "IROISE - INFORMATION" {
		t.Errorf("entry = %v, want [119.575 FIS IROISE Information IROISE - INFORMATION]", e)
	}

	// Lille shape: the SIA freq is already in the AIXM union, so narrow keeps
	// the AIXM entry (real ICAO unit) and augment adds nothing. The second
	// AIXM freq, not tagged for this sub-sector, is dropped.
	radio = []any{
		[]string{"126.48", "LFQQ LILLE", "LILLE - INFORMATION"},
		[]string{"132.54", "LFQQ LILLE", "LILLE - INFORMATION"},
	}
	entries = []InjectEntry{{Freq: "126.480", Unit: "FIS LILLE Information", Callsign: "LILLE - INFORMATION"}}
	got = applySectorEntries(radio, entries)
	if len(got) != 1 {
		t.Fatalf("len = %d, want 1 (keep 126.48, drop 132.54): %v", len(got), got)
	}
	if e := got[0].([]string); e[0] != "126.48" || e[1] != "LFQQ LILLE" {
		t.Errorf("entry = %v, want AIXM-named [126.48 LFQQ LILLE ...]", e)
	}
}

// TestParseSIASectorEntries covers FIS-over-APP precedence, the APP fallback,
// and the hand override seeding.
func TestParseSIASectorEntries(t *testing.T) {
	const sia = `<?xml version="1.0" encoding="UTF-8"?>
<SiaExport><Situation><FrequenceS>
<Frequence lk="[LF][ZZ][FIS ZZZ Information][120.000]"><Service lk="[LF][ZZ][FIS ZZZ Information]"/><Frequence>120.000</Frequence><Remarque>Information/Radar SIV 1</Remarque></Frequence>
<Frequence lk="[LF][ZZ][APP ZZZ Approche][121.000]"><Service lk="[LF][ZZ][APP ZZZ Approche]"/><Frequence>121.000</Frequence><Remarque>Secteur/Sector ZW (SIV 1).</Remarque></Frequence>
<Frequence lk="[LF][ZZ][APP ZZZ Approche][122.000]"><Service lk="[LF][ZZ][APP ZZZ Approche]"/><Frequence>122.000</Frequence><Remarque>Secteur/Sector ZE (SIV 2).</Remarque></Frequence>
</FrequenceS></Situation></SiaExport>`
	plan, err := parseSIA([]byte(sia), AIXMSIVByName{}, AIXMTMAByName{})
	if err != nil {
		t.Fatal(err)
	}
	// SIV 1 is tagged by both FIS (120.000) and APP (121.000); FIS wins.
	if got := plan.SectorEntries["LFZZFS1"]; len(got) != 1 || got[0].Freq != "120.000" ||
		got[0].Unit != "FIS ZZZ Information" || got[0].Callsign != "ZZZ - INFORMATION" {
		t.Errorf("LFZZFS1 = %+v, want one FIS entry 120.000 (FIS wins over APP)", got)
	}
	// SIV 2 is tagged only by APP, so the approach frequency fills in.
	if got := plan.SectorEntries["LFZZFS2"]; len(got) != 1 || got[0].Freq != "122.000" ||
		got[0].Unit != "APP ZZZ Approche" || got[0].Callsign != "ZZZ - APPROCHE" {
		t.Errorf("LFZZFS2 = %+v, want APP fallback 122.000", got)
	}
	// The hand override seeds Beauvais 1 even though it is not in this file.
	if got := plan.SectorEntries["LFOBFS1"]; len(got) != 1 || got[0].Freq != "123.985" ||
		got[0].Callsign != "BEAUVAIS - APPROCHE" {
		t.Errorf("LFOBFS1 override = %+v, want 123.985 BEAUVAIS - APPROCHE", got)
	}
}

// TestExpandTMASectorList covers the "TMA <NAME> <list>" regex: the clean
// parenthesised SEINE form expands (decimals included), while prose mentions
// and the overseas "partie N NAME" form yield nothing.
func TestExpandTMASectorList(t *testing.T) {
	cases := []struct {
		name     string
		remarque string
		want     []tmaSector
	}{
		{"seine SJ", "Secteur/Sector SJ (TMA SEINE 1/5/6).",
			[]tmaSector{{"SEINE", "1"}, {"SEINE", "5"}, {"SEINE", "6"}}},
		{"seine SK decimals", "Secteur/Sector SK (TMA SEINE 7.1/7.2/8/9/10).",
			[]tmaSector{{"SEINE", "7.1"}, {"SEINE", "7.2"}, {"SEINE", "8"}, {"SEINE", "9"}, {"SEINE", "10"}}},
		{"prose contrôle en TMA", "Secteur QW-Contrôle en TMA.#Secteur/Sector QW (SIV 2).", nil},
		{"prose TMA de LORIENT", "Transit VFR dans CTR et TMA de LORIENT.", nil},
		{"overseas partie form", "TMA NOUMEA partie 1.1 TONTOUTA.", nil},
	}
	for _, c := range cases {
		got := expandTMASectorList(c.remarque)
		if !equalTMASectors(got, c.want) {
			t.Errorf("%s: expandTMASectorList(%q) = %v, want %v", c.name, c.remarque, got, c.want)
		}
	}
}

func equalTMASectors(a, b []tmaSector) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// TestParseSIATMASectorEntries covers the approach-controlled TMA-part path:
// an APP "(TMA <NAME> N/M)" Remarque keys each named part to the control
// frequency, parts resolve to codeIds by name (including the decimal-dot
// "LFPM7.1" case), and a part with no AIXM codeId resolves to nothing.
func TestParseSIATMASectorEntries(t *testing.T) {
	const sia = `<?xml version="1.0" encoding="UTF-8"?>
<SiaExport><Situation><FrequenceS>
<Frequence lk="[LF][PM][APP SEINE Approche][118.050]"><Service lk="[LF][PM][APP SEINE Approche]"/><Frequence>118.050</Frequence><Remarque>Secteur/Sector SJ (TMA SEINE 1/5/6).</Remarque></Frequence>
<Frequence lk="[LF][PM][APP SEINE Approche][134.875]"><Service lk="[LF][PM][APP SEINE Approche]"/><Frequence>134.875</Frequence><Remarque>Secteur/Sector SK (TMA SEINE 7.1/7.2/8/9/10).</Remarque></Frequence>
<Frequence lk="[LF][RH][APP LORIENT Approche][122.300]"><Service lk="[LF][RH][APP LORIENT Approche]"/><Frequence>122.300</Frequence><Remarque>Transit VFR dans CTR et TMA de LORIENT.</Remarque></Frequence>
</FrequenceS></Situation></SiaExport>`
	tmaByName := AIXMTMAByName{
		"SEINE 1":   {"LFPM1"},
		"SEINE 5":   {"LFPM5"},
		"SEINE 6":   {"LFPM6"},
		"SEINE 7.1": {"LFPM7.1"},
		"SEINE 8":   {"LFPM8"},
	}
	plan, err := parseSIA([]byte(sia), AIXMSIVByName{}, tmaByName)
	if err != nil {
		t.Fatal(err)
	}
	// 118.050 (sector SJ) serves parts 1/5/6, with the approach unit/call sign.
	for _, id := range []string{"LFPM1", "LFPM5", "LFPM6"} {
		got := plan.SectorEntries[id]
		if len(got) != 1 || got[0].Freq != "118.050" ||
			got[0].Unit != "APP SEINE Approche" || got[0].Callsign != "SEINE - APPROCHE" {
			t.Errorf("%s = %+v, want one entry 118.050 APP SEINE Approche", id, got)
		}
	}
	// 134.875 (sector SK) serves 7.1 (decimal-dot codeId) and 8.
	if got := plan.SectorEntries["LFPM7.1"]; len(got) != 1 || got[0].Freq != "134.875" {
		t.Errorf("LFPM7.1 = %+v, want one entry 134.875", got)
	}
	if got := plan.SectorEntries["LFPM8"]; len(got) != 1 || got[0].Freq != "134.875" {
		t.Errorf("LFPM8 = %+v, want one entry 134.875", got)
	}
	// Part 7.2 is named by the remark but absent from the index, so no entry is
	// fabricated; the LORIENT prose "TMA de LORIENT" contributes nothing either.
	if got := plan.SectorEntries["LFPM7.2"]; len(got) != 0 {
		t.Errorf("LFPM7.2 = %+v, want no entry (not in AIXM index)", got)
	}
}

// TestBuildAirspacesTMANarrowedBySIA is the end-to-end check: three TMA parts
// share one untagged approach service carrying both 118.05 and 134.875, and the
// SIA approach remarks narrow each part to its own sector frequency (keeping the
// AIXM unit/call sign, and tolerating the SIA "118.050" vs AIXM "118.05" form).
func TestBuildAirspacesTMANarrowedBySIA(t *testing.T) {
	const aixm = `<?xml version="1.0" encoding="UTF-8"?>
<AIXM-Snapshot version="4.5" effective="2026-05-14T00:00:00.000+02:00">
    <Ase><AseUid mid="1101"><codeType>TMA</codeType><codeId>LFPM5</codeId></AseUid><txtName>SEINE 5</txtName><codeClass>D</codeClass></Ase>
    <Ase><AseUid mid="1102"><codeType>TMA</codeType><codeId>LFPM6</codeId></AseUid><txtName>SEINE 6</txtName><codeClass>E</codeClass></Ase>
    <Ase><AseUid mid="1103"><codeType>TMA</codeType><codeId>LFPM7.1</codeId></AseUid><txtName>SEINE 7.1</txtName><codeClass>D</codeClass></Ase>
    <Abd><AbdUid mid="2101"><AseUid mid="1101"><codeType>TMA</codeType><codeId>LFPM5</codeId></AseUid></AbdUid>
        <Avx><codeType>GRC</codeType><geoLat>485000.00N</geoLat><geoLong>0023000.00E</geoLong></Avx>
        <Avx><codeType>GRC</codeType><geoLat>485000.00N</geoLat><geoLong>0024000.00E</geoLong></Avx>
        <Avx><codeType>GRC</codeType><geoLat>484000.00N</geoLat><geoLong>0024000.00E</geoLong></Avx>
        <Avx><codeType>GRC</codeType><geoLat>484000.00N</geoLat><geoLong>0023000.00E</geoLong></Avx></Abd>
    <Abd><AbdUid mid="2102"><AseUid mid="1102"><codeType>TMA</codeType><codeId>LFPM6</codeId></AseUid></AbdUid>
        <Avx><codeType>GRC</codeType><geoLat>484000.00N</geoLat><geoLong>0023000.00E</geoLong></Avx>
        <Avx><codeType>GRC</codeType><geoLat>484000.00N</geoLat><geoLong>0024000.00E</geoLong></Avx>
        <Avx><codeType>GRC</codeType><geoLat>483000.00N</geoLat><geoLong>0024000.00E</geoLong></Avx>
        <Avx><codeType>GRC</codeType><geoLat>483000.00N</geoLat><geoLong>0023000.00E</geoLong></Avx></Abd>
    <Abd><AbdUid mid="2103"><AseUid mid="1103"><codeType>TMA</codeType><codeId>LFPM7.1</codeId></AseUid></AbdUid>
        <Avx><codeType>GRC</codeType><geoLat>483000.00N</geoLat><geoLong>0023000.00E</geoLong></Avx>
        <Avx><codeType>GRC</codeType><geoLat>483000.00N</geoLat><geoLong>0024000.00E</geoLong></Avx>
        <Avx><codeType>GRC</codeType><geoLat>482000.00N</geoLat><geoLong>0024000.00E</geoLong></Avx>
        <Avx><codeType>GRC</codeType><geoLat>482000.00N</geoLat><geoLong>0023000.00E</geoLong></Avx></Abd>
    <Sae><SaeUid mid="4101"><SerUid mid="3101"><UniUid mid="3501"><txtName>LFPM MELUN SEINE</txtName></UniUid><codeType>APP</codeType></SerUid><AseUid mid="1101"><codeType>TMA</codeType><codeId>LFPM5</codeId></AseUid></SaeUid></Sae>
    <Sae><SaeUid mid="4102"><SerUid mid="3101"><UniUid mid="3501"><txtName>LFPM MELUN SEINE</txtName></UniUid><codeType>APP</codeType></SerUid><AseUid mid="1102"><codeType>TMA</codeType><codeId>LFPM6</codeId></AseUid></SaeUid></Sae>
    <Sae><SaeUid mid="4103"><SerUid mid="3101"><UniUid mid="3501"><txtName>LFPM MELUN SEINE</txtName></UniUid><codeType>APP</codeType></SerUid><AseUid mid="1103"><codeType>TMA</codeType><codeId>LFPM7.1</codeId></AseUid></SaeUid></Sae>
    <Fqy><FqyUid mid="5101"><SerUid mid="3101"/><valFreqTrans>118.05</valFreqTrans></FqyUid><uomFreq>MHZ</uomFreq>
        <Cdl><txtCallSign>SEINE - APPROCHE</txtCallSign><codeLang>FR</codeLang></Cdl></Fqy>
    <Fqy><FqyUid mid="5102"><SerUid mid="3101"/><valFreqTrans>134.875</valFreqTrans></FqyUid><uomFreq>MHZ</uomFreq>
        <Cdl><txtCallSign>SEINE - APPROCHE</txtCallSign><codeLang>FR</codeLang></Cdl></Fqy>
</AIXM-Snapshot>`
	const sia = `<?xml version="1.0" encoding="UTF-8"?>
<SiaExport><Situation><FrequenceS>
<Frequence lk="[LF][PM][APP SEINE Approche][118.050]"><Service lk="[LF][PM][APP SEINE Approche]"/><Frequence>118.050</Frequence><Remarque>Secteur/Sector SJ (TMA SEINE 1/5/6).</Remarque></Frequence>
<Frequence lk="[LF][PM][APP SEINE Approche][134.875]"><Service lk="[LF][PM][APP SEINE Approche]"/><Frequence>134.875</Frequence><Remarque>Secteur/Sector SK (TMA SEINE 7.1/7.2/8/9/10).</Remarque></Frequence>
</FrequenceS></Situation></SiaExport>`

	artifact, meta, err := BuildAirspaces([]byte(aixm), AirspacesOptions{
		Source:       "tma.aixm.xml",
		SIASource:    []byte(sia),
		Now:          func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) },
		MinAirspaces: 1,
		MaxAirspaces: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	if meta.SIASectorMappedCount != 3 {
		t.Errorf("SIASectorMappedCount = %d, want 3 (LFPM5 + LFPM6 + LFPM7.1)", meta.SIASectorMappedCount)
	}

	gotRadio := func(id string) [][3]string {
		t.Helper()
		for _, r := range artifact.Rows {
			row := r.([]any)
			if row[0] != id {
				continue
			}
			entries := row[11].([]any)
			out := make([][3]string, 0, len(entries))
			for _, e := range entries {
				tr := e.([]string)
				out = append(out, [3]string{tr[0], tr[1], tr[2]})
			}
			return out
		}
		t.Fatalf("no row for id %q", id)
		return nil
	}

	// Sector SJ (118.050) serves parts 5 and 6; the AIXM "118.05" form is kept
	// with the real ICAO unit, and 134.875 is dropped.
	wantSJ := [][3]string{{"118.05", "LFPM MELUN SEINE", "SEINE - APPROCHE"}}
	for _, id := range []string{"LFPM5", "LFPM6"} {
		if got := gotRadio(id); !equalTriples(got, wantSJ) {
			t.Errorf("%s radio = %v, want %v", id, got, wantSJ)
		}
	}
	// Sector SK (134.875) serves the decimal-dot part 7.1; 118.05 is dropped.
	wantSK := [][3]string{{"134.875", "LFPM MELUN SEINE", "SEINE - APPROCHE"}}
	if got := gotRadio("LFPM7.1"); !equalTriples(got, wantSK) {
		t.Errorf("LFPM7.1 radio = %v, want %v", got, wantSK)
	}
}

func equalTriples(a, b [][3]string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestExpandSectorList(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"Information/Radar SIV 1", []string{"1"}},
		{"Information/Radar SIV 2", []string{"2"}},
		{"Information/Radar SIV 3 et/and 5", []string{"3", "5"}},
		{"Information/Radar SIV 4.1 et/and 4.2", []string{"4.1", "4.2"}},
		{"Information/Radar SIV 6.1 à/to 6.4", []string{"6.1", "6.2", "6.3", "6.4"}},
		{"SIV 1 et/and 2", []string{"1", "2"}},
		// Parenthesised list with '/' separator (Seine, Nice, …).
		{"Secteur/Sector SJ (SIV 1/2/3).", []string{"1", "2", "3"}},
		{"Secteur SK (SIV 4/5).", []string{"4", "5"}},
		// Multi-line: SIA uses '#' as an in-line newline. Each line is its
		// own sector statement.
		{"SIV 2.1#SIV 4 (hors HOR)", []string{"2.1", "4"}},
		// Trailing dot from a sentence-ending period.
		{"SIV 4.1.", []string{"4.1"}},
		// Comma + et/and (Montpellier).
		{"SIV 1, 1.1 et/and 1.2", []string{"1", "1.1", "1.2"}},
		// A centre name embedded between SIV and the number is skipped
		// (Iroise), and a line with several SIV tokens yields every sector.
		{"SIV IROISE 2", []string{"2"}},
		{"SIV 1 et/and SIV 4.", []string{"1", "4"}},
		{"SIV IROISE 2#SIV IROISE 3 hors/out X#SIV IROISE 4.1 et/and 4.2", []string{"2", "3", "4.1", "4.2"}},
		{"no sector reference", nil},
	}
	for _, c := range cases {
		got := expandSectorList(c.in)
		if !equalStrings(got, c.want) {
			t.Errorf("expandSectorList(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

// TestExpandSectorNames covers the "Secteur(s)/Sector(s) <list>" forms the SIA
// actually publishes on its approach frequencies, one case per unit shape. The
// output is what the sectors are called in the AIXM, so the geometric join can
// look them up; duplicates stand (a remark naming its sector on both the French
// and the English line), the caller keys per frequency.
func TestExpandSectorNames(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		// Lille: the bare name, twice over the bilingual lines.
		{"Secteur QW-Contrôle en TMA.#Secteur/Sector QW (SIV 2).", []string{"QW", "QW"}},
		{"Secteur/Sector BL.", []string{"BL"}},
		// Bordeaux / Clermont / Nice: a family with an "et/and" pair.
		{"Secteurs/Sectors BE 1 et/and 2.", []string{"BE 1", "BE 2"}},
		{"Secteurs/Sectors ND 1 et/and 2.", []string{"ND 1", "ND 2"}},
		// Toulouse: an accented range, and the sector named alone elsewhere.
		{"Secteurs AW 1 à 4.", []string{"AW 1", "AW 2", "AW 3", "AW 4"}},
		{"Secteur EST - Contrôle en TMA.#Secteurs AE 1 à 5", []string{"EST", "AE 1", "AE 2", "AE 3", "AE 4", "AE 5"}},
		{"APP TOULOUSE (SFC/FL075 Secteur Albi).#Secteur/Sector EB.", []string{"EB"}},
		// Provence / Brest: the bilingual range form, several per remark.
		{"Secteurs/Sectors MAC 1 à/to 10.", []string{"MAC 1", "MAC 2", "MAC 3", "MAC 4", "MAC 5", "MAC 6", "MAC 7", "MAC 8", "MAC 9", "MAC 10"}},
		{"Secteurs/Sectors IQ 1 à/to 3.#Secteurs/Sectors IX 1 à/to 2.", []string{"IQ 1", "IQ 2", "IQ 3", "IX 1", "IX 2"}},
		// Beauvais: a list of two whole names. Lille's auxiliary channel names
		// its two sectors the same way, space-separated.
		{"Canal 8.33#Secteurs/Sectors WEST et/and EAST.", []string{"WEST", "EAST"}},
		{"Secteurs QW QE", []string{"QW", "QE"}},
		// Montpellier: a family cited without a number, which the join reads as
		// covering FA 1 / FA 2 / FA 3.
		{"Secteur d'approche FA (REF ENR 2.2).", []string{"FA"}},
		// Strasbourg: the lowercase prose around a name is not a name, and a
		// cardinal direction is a name the AIXM never publishes, so it resolves
		// to nothing rather than to the wrong sector.
		{"FL >115 ; secteur SU / sector SU", []string{"SU", "SU"}},
		{"Secteur EST / sector EAST", []string{"EST", "EAST"}},
		// Rennes: the SIA skips RN 2, so only the two it names are returned.
		{"Secteur SUD/South sector#Secteurs/Sectors RN 1 et/and 3", []string{"SUD", "RN 1", "RN 3"}},
		{"Canal 8.33. Appareils non-équipés : voir AD 2 LFSB.23", nil},
		{"", nil},
	}
	for _, c := range cases {
		if got := expandSectorNames(c.in); !equalStrings(got, c.want) {
			t.Errorf("expandSectorNames(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

// TestBuildAirspacesTMANarrowedByAPPSector is the end-to-end check of the
// geometric join: the unit publishes its approach sectors as SECTOR airspaces
// and the SIA names the frequency each is worked on, so every TMA part takes
// the frequency of the sector covering it. It pins all five gates at once.
func TestBuildAirspacesTMANarrowedByAPPSector(t *testing.T) {
	aixm := `<?xml version="1.0" encoding="UTF-8"?>
<AIXM-Snapshot version="4.5" effective="2026-05-14T00:00:00.000+02:00">
    <Ase><AseUid mid="1001"><codeType>SECTOR</codeType><codeId>LFXXQW</codeId></AseUid><txtName>QW</txtName><txtLocalType>APP</txtLocalType>
        <codeDistVerUpper>STD</codeDistVerUpper><valDistVerUpper>115</valDistVerUpper><uomDistVerUpper>FL</uomDistVerUpper>
        <codeDistVerLower>HEI</codeDistVerLower><valDistVerLower>0</valDistVerLower><uomDistVerLower>FT</uomDistVerLower></Ase>
    <Ase><AseUid mid="1002"><codeType>SECTOR</codeType><codeId>LFXXQE</codeId></AseUid><txtName>QE</txtName><txtLocalType>APP</txtLocalType>
        <codeDistVerUpper>STD</codeDistVerUpper><valDistVerUpper>115</valDistVerUpper><uomDistVerUpper>FL</uomDistVerUpper>
        <codeDistVerLower>HEI</codeDistVerLower><valDistVerLower>0</valDistVerLower><uomDistVerLower>FT</uomDistVerLower></Ase>
    <Ase><AseUid mid="1003"><codeType>SECTOR</codeType><codeId>LFXXQZ</codeId></AseUid><txtName>QZ</txtName><txtLocalType>APP</txtLocalType>
        <codeDistVerUpper>STD</codeDistVerUpper><valDistVerUpper>115</valDistVerUpper><uomDistVerUpper>FL</uomDistVerUpper>
        <codeDistVerLower>HEI</codeDistVerLower><valDistVerLower>0</valDistVerLower><uomDistVerLower>FT</uomDistVerLower></Ase>
    <Ase><AseUid mid="1004"><codeType>SECTOR</codeType><codeId>LFXXQU</codeId></AseUid><txtName>QU</txtName><txtLocalType>APP</txtLocalType>
        <codeDistVerUpper>STD</codeDistVerUpper><valDistVerUpper>195</valDistVerUpper><uomDistVerUpper>FL</uomDistVerUpper>
        <codeDistVerLower>STD</codeDistVerLower><valDistVerLower>115</valDistVerLower><uomDistVerLower>FL</uomDistVerLower></Ase>
    <Ase><AseUid mid="2001"><codeType>TMA</codeType><codeId>LFXX1</codeId></AseUid><txtName>TEST 1</txtName><codeClass>D</codeClass>
        <codeDistVerUpper>STD</codeDistVerUpper><valDistVerUpper>065</valDistVerUpper><uomDistVerUpper>FL</uomDistVerUpper>
        <codeDistVerLower>ALT</codeDistVerLower><valDistVerLower>1000</valDistVerLower><uomDistVerLower>FT</uomDistVerLower></Ase>
    <Ase><AseUid mid="2002"><codeType>TMA</codeType><codeId>LFXX2</codeId></AseUid><txtName>TEST 2</txtName><codeClass>D</codeClass>
        <codeDistVerUpper>STD</codeDistVerUpper><valDistVerUpper>065</valDistVerUpper><uomDistVerUpper>FL</uomDistVerUpper>
        <codeDistVerLower>ALT</codeDistVerLower><valDistVerLower>1000</valDistVerLower><uomDistVerLower>FT</uomDistVerLower></Ase>
    <Ase><AseUid mid="2003"><codeType>TMA</codeType><codeId>LFXX3</codeId></AseUid><txtName>TEST 3</txtName><codeClass>E</codeClass>
        <codeDistVerUpper>STD</codeDistVerUpper><valDistVerUpper>065</valDistVerUpper><uomDistVerUpper>FL</uomDistVerUpper>
        <codeDistVerLower>ALT</codeDistVerLower><valDistVerLower>1000</valDistVerLower><uomDistVerLower>FT</uomDistVerLower></Ase>
    <Ase><AseUid mid="2004"><codeType>TMA</codeType><codeId>LFXX4</codeId></AseUid><txtName>TEST 4</txtName><codeClass>E</codeClass>
        <codeDistVerUpper>STD</codeDistVerUpper><valDistVerUpper>065</valDistVerUpper><uomDistVerUpper>FL</uomDistVerUpper>
        <codeDistVerLower>ALT</codeDistVerLower><valDistVerLower>1000</valDistVerLower><uomDistVerLower>FT</uomDistVerLower></Ase>
    <Ase><AseUid mid="2005"><codeType>TMA</codeType><codeId>LFXX5</codeId></AseUid><txtName>TEST 5</txtName><codeClass>D</codeClass>
        <codeDistVerUpper>STD</codeDistVerUpper><valDistVerUpper>065</valDistVerUpper><uomDistVerUpper>FL</uomDistVerUpper>
        <codeDistVerLower>ALT</codeDistVerLower><valDistVerLower>1000</valDistVerLower><uomDistVerLower>FT</uomDistVerLower></Ase>
    <Ase><AseUid mid="2006"><codeType>CTR</codeType><codeId>LFXX</codeId></AseUid><txtName>TEST</txtName><codeClass>D</codeClass>
        <codeDistVerUpper>ALT</codeDistVerUpper><valDistVerUpper>2500</valDistVerUpper><uomDistVerUpper>FT</uomDistVerUpper>
        <codeDistVerLower>SFC</codeDistVerLower><valDistVerLower>0</valDistVerLower><uomDistVerLower>FT</uomDistVerLower></Ase>
    <Ase><AseUid mid="2007"><codeType>CTA</codeType><codeId>CTA75001</codeId></AseUid><txtName>TEST CTA</txtName><codeClass>D</codeClass>
        <codeDistVerUpper>STD</codeDistVerUpper><valDistVerUpper>065</valDistVerUpper><uomDistVerUpper>FL</uomDistVerUpper>
        <codeDistVerLower>ALT</codeDistVerLower><valDistVerLower>1000</valDistVerLower><uomDistVerLower>FT</uomDistVerLower></Ase>
` + sectorBox("3001", "1001", 49, 50, 2, 3) + // QW, west
		sectorBox("3002", "1002", 49, 50, 3, 4) + // QE, east
		sectorBox("3003", "1003", 48, 49, 2, 4) + // QZ, south, never named by the SIA
		sectorBox("3004", "1004", 49, 50, 2, 3) + // QU, above QW
		abdBox("4001", "2001", "TMA", "LFXX1", 49.2, 49.8, 2.2, 2.8) + // inside QW
		abdBox("4002", "2002", "TMA", "LFXX2", 49.2, 49.8, 3.2, 3.8) + // inside QE
		abdBox("4003", "2003", "TMA", "LFXX3", 49.2, 49.8, 2.2, 3.3) + // QW 73% / QE 27%
		abdBox("4004", "2004", "TMA", "LFXX4", 48.2, 48.8, 2.2, 2.8) + // inside QZ
		abdBox("4005", "2005", "TMA", "LFXX5", 49.2, 49.8, 2.2, 2.8) + // inside QW
		abdBox("4006", "2006", "CTR", "LFXX", 49.4, 49.6, 2.4, 2.6) + // inside QW
		abdBox("4007", "2007", "CTA", "CTA75001", 49.2, 49.8, 2.2, 2.8) + // inside QW
		saeRow("5001", "6001", "APP", "2001", "TMA", "LFXX1") +
		saeRow("5002", "6001", "APP", "2002", "TMA", "LFXX2") +
		saeRow("5003", "6001", "APP", "2003", "TMA", "LFXX3") +
		saeRow("5004", "6001", "APP", "2004", "TMA", "LFXX4") +
		saeRow("5005", "6001", "APP", "2005", "TMA", "LFXX5") +
		saeRow("5006", "6001", "APP", "2006", "CTR", "LFXX") +
		saeRow("5007", "6002", "TWR", "2006", "CTR", "LFXX") +
		saeRow("5008", "6001", "APP", "2007", "CTA", "CTA75001") +
		fqyRow("6001", "120.275") + fqyRow("6001", "126.48") +
		fqyRow("6001", "125.5") + fqyRow("6001", "122.06") +
		fqyRow("6002", "118.5") + `
</AIXM-Snapshot>`
	// The frequency remarks: one per sector, the auxiliary one marked as such,
	// and the sector above the parts (QU) carrying its own. 126.480 also states
	// the part it works itself, the Seine form, which must win over geometry.
	const sia = `<?xml version="1.0" encoding="UTF-8"?>
<SiaExport><Situation><FrequenceS>
<Frequence lk="[LF][XX][APP TEST Approche][120.275]"><Service lk="[LF][XX][APP TEST Approche]"/><Frequence>120.275</Frequence><Remarque>Secteur QW-Contrôle en TMA.#Secteur/Sector QW.</Remarque></Frequence>
<Frequence lk="[LF][XX][APP TEST Approche][126.480]"><Service lk="[LF][XX][APP TEST Approche]"/><Frequence>126.480</Frequence><Remarque>Secteur/Sector QE (TMA TEST 5).</Remarque></Frequence>
<Frequence lk="[LF][XX][APP TEST Approche][125.500]"><Service lk="[LF][XX][APP TEST Approche]"/><Frequence>125.500</Frequence><Remarque>Secteurs QW QE#Fréquence supplétive/auxiliary frequency</Remarque></Frequence>
<Frequence lk="[LF][XX][APP TEST Approche][122.060]"><Service lk="[LF][XX][APP TEST Approche]"/><Frequence>122.060</Frequence><Remarque>Secteur/Sector QU.</Remarque></Frequence>
</FrequenceS></Situation></SiaExport>`

	artifact, meta, err := BuildAirspaces([]byte(aixm), AirspacesOptions{
		Source:       "sectors.aixm.xml",
		SIASource:    []byte(sia),
		Now:          func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) },
		MinAirspaces: 1,
		MaxAirspaces: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	// Parts 1, 2, 3 and the CTA are keyed by geometry; part 5 by the SIA's own
	// statement, so it is not counted here; part 4 and the CTR are not keyed.
	if meta.SIATMASectorCount != 4 {
		t.Errorf("SIATMASectorCount = %d, want 4 (LFXX1 + LFXX2 + LFXX3 + CTA75001)", meta.SIATMASectorCount)
	}

	radioOf := func(id string) []string {
		t.Helper()
		for _, r := range artifact.Rows {
			row := r.([]any)
			if row[0] != id {
				continue
			}
			var out []string
			for _, e := range row[11].([]any) {
				out = append(out, e.([]string)[0])
			}
			return out
		}
		t.Fatalf("no row for id %q", id)
		return nil
	}

	// A part inside one sector takes that sector's frequency, and the auxiliary
	// 125.5 and the overlying QU's 122.06 are both gone: one is a backup, the
	// other belongs to a sector stacked above the part.
	if got := radioOf("LFXX1"); !equalStrings(got, []string{"120.275"}) {
		t.Errorf("LFXX1 (inside QW) radio = %v, want [120.275]", got)
	}
	if got := radioOf("LFXX2"); !equalStrings(got, []string{"126.48"}) {
		t.Errorf("LFXX2 (inside QE) radio = %v, want [126.48]", got)
	}
	// A part across two sectors is charged to the one covering most of it.
	if got := radioOf("LFXX3"); !equalStrings(got, []string{"120.275"}) {
		t.Errorf("LFXX3 (QW 73%% / QE 27%%) radio = %v, want [120.275]", got)
	}
	// The SIA names no frequency for QZ, so a part it decides keeps every
	// frequency of its service rather than being guessed at.
	if got := radioOf("LFXX4"); !equalStrings(got, []string{"120.275", "126.48", "125.5", "122.06"}) {
		t.Errorf("LFXX4 (inside the unnamed QZ) radio = %v, want the full union", got)
	}
	// The publisher's own per-part statement wins over the geometry: part 5 sits
	// in QW yet is worked by QE per the remark.
	if got := radioOf("LFXX5"); !equalStrings(got, []string{"126.48"}) {
		t.Errorf("LFXX5 (SIA states QE) radio = %v, want [126.48]", got)
	}
	// The CTR shares its Sae list with the tower, so narrowing must not touch
	// it: dropping to the approach sector would take the tower off the panel.
	if got := radioOf("LFXX"); !equalStrings(got, []string{"120.275", "126.48", "125.5", "122.06", "118.5"}) {
		t.Errorf("CTR LFXX radio = %v, want the full union incl. TWR 118.5", got)
	}
	// A CTA is filed under a serial, not under its unit's indicator, so its
	// codeId stems to nothing a sector is keyed by; the approach service that
	// works it names the unit and the join lands. Without that every published
	// CTA part kept its whole union.
	if got := radioOf("CTA75001"); !equalStrings(got, []string{"120.275"}) {
		t.Errorf("CTA75001 (inside QW) radio = %v, want [120.275]", got)
	}
}

// sectorBox / abdBox emit an Abd with a rectangular GRC boundary; saeRow and
// fqyRow the service link and one of its frequencies. Together they keep the
// sector-join fixture readable.
func sectorBox(abdMid, aseMid string, lat0, lat1, lon0, lon1 float64) string {
	return abdBox(abdMid, aseMid, "SECTOR", "", lat0, lat1, lon0, lon1)
}

func abdBox(abdMid, aseMid, codeType, codeId string, lat0, lat1, lon0, lon1 float64) string {
	dms := func(v float64, lon bool) string {
		deg := int(v)
		minutes := (v - float64(deg)) * 60
		if lon {
			return fmt.Sprintf("%03d%02d00.00E", deg, int(minutes+0.5))
		}
		return fmt.Sprintf("%02d%02d00.00N", deg, int(minutes+0.5))
	}
	corners := [][2]float64{{lat1, lon0}, {lat1, lon1}, {lat0, lon1}, {lat0, lon0}}
	out := fmt.Sprintf("    <Abd><AbdUid mid=%q><AseUid mid=%q><codeType>%s</codeType><codeId>%s</codeId></AseUid></AbdUid>\n",
		abdMid, aseMid, codeType, codeId)
	for _, c := range corners {
		out += fmt.Sprintf("        <Avx><codeType>GRC</codeType><geoLat>%s</geoLat><geoLong>%s</geoLong></Avx>\n",
			dms(c[0], false), dms(c[1], true))
	}
	return out + "        </Abd>\n"
}

func saeRow(saeMid, serMid, serType, aseMid, aseType, aseId string) string {
	return fmt.Sprintf(`    <Sae><SaeUid mid=%q><SerUid mid=%q><UniUid mid="9001"><txtName>LFXX TEST</txtName></UniUid><codeType>%s</codeType></SerUid>`+
		`<AseUid mid=%q><codeType>%s</codeType><codeId>%s</codeId></AseUid></SaeUid></Sae>`+"\n",
		saeMid, serMid, serType, aseMid, aseType, aseId)
}

func fqyRow(serMid, freq string) string {
	return fmt.Sprintf(`    <Fqy><FqyUid mid="7%s%s"><SerUid mid=%q/><valFreqTrans>%s</valFreqTrans></FqyUid><uomFreq>MHZ</uomFreq>`+
		`<Cdl><txtCallSign>TEST - APPROCHE</txtCallSign><codeLang>FR</codeLang></Cdl></Fqy>`+"\n",
		serMid, strings.ReplaceAll(freq, ".", ""), serMid, freq)
}

func TestSectorToSuffix(t *testing.T) {
	cases := []struct{ in, want string }{
		{"1", "1"},
		{"4.1", "4P1"},
		{"6.4", "6P4"},
		{"", ""},
		{".5", ""},
		{"5.", ""},
	}
	for _, c := range cases {
		if got := sectorToSuffix(c.in); got != c.want {
			t.Errorf("sectorToSuffix(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestStemFromLk(t *testing.T) {
	cases := []struct{ in, want string }{
		{"[LF][QQ][FIS LILLE Information]", "LFQQ"},
		{"[LF][XX][FIS XXX Information]", "LFXX"},
		{"only-one-bracket", ""},
		{"", ""},
	}
	for _, c := range cases {
		if got := stemFromLk(c.in); got != c.want {
			t.Errorf("stemFromLk(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestBoundaryRingDegenerateLine(t *testing.T) {
	// Two straight vertices form a line, not an area.
	abd := &Abd{Avx: []Avx{
		{CodeType: "GRC", GeoLat: "480000.00N", GeoLong: "0020000.00E"},
		{CodeType: "GRC", GeoLat: "480000.00N", GeoLong: "0021000.00E"},
	}}
	if _, err := boundaryRing(abd); err == nil {
		t.Error("boundaryRing accepted a 2-vertex straight boundary, want error")
	}
}

func TestBoundaryRingTwoVertexArc(t *testing.T) {
	// A two-vertex boundary with an arc edge is a valid area (an arc plus a
	// chord); the arc tessellates into many points. Real example: LFP32.
	abd := &Abd{Avx: []Avx{
		{
			CodeType: "CWA", GeoLat: "494915.00N", GeoLong: "0003602.00E",
			GeoLatArc: "495133.00N", GeoLongArc: "0003813.00E",
			ValRadiusArc: "5", UomRadiusArc: "KM",
		},
		{CodeType: "GRC", GeoLat: "495120.00N", GeoLong: "0004223.00E"},
	}}
	ring, err := boundaryRing(abd)
	if err != nil {
		t.Fatalf("boundaryRing: %v", err)
	}
	if len(ring) < 3 {
		t.Errorf("ring has %d points, want >= 3", len(ring))
	}
}

func TestVerTripleUnlimited(t *testing.T) {
	// The SIA encodes "unlimited" as FL999 (one FL9999 row exists); both
	// normalize to the explicit UNL triple. Real levels pass through.
	for _, val := range []string{"999", "9999"} {
		got := verTriple("STD", val, "FL")
		want := []string{"UNL", "", ""}
		if !reflect.DeepEqual(got, any(want)) {
			t.Errorf("verTriple(STD, %s, FL) = %v, want %v", val, got, want)
		}
	}
	got := verTriple("STD", "195", "FL")
	if !reflect.DeepEqual(got, any([]string{"STD", "195", "FL"})) {
		t.Errorf("verTriple(STD, 195, FL) = %v, want passthrough", got)
	}
	if verTriple("", "", "") != nil {
		t.Errorf("verTriple of an absent limit must stay nil")
	}
}

// TestSivStem pins the sector-stem boundary. The marker "FS" sits after the
// 4-character ICAO centre code, so centres whose indicator carries an "S" as
// its third letter (Bâle "LFSB", Strasbourg "LFST") must NOT collapse into a
// shared "LFS" stem, which used to cross-link their frequencies.
func TestSivStem(t *testing.T) {
	cases := []struct{ in, want string }{
		{"LFSBFS22", "LFSBFS"},   // Bâle sub-sector (the regression)
		{"LFSBFS", "LFSBFS"},     // Bâle parent
		{"LFSTFS1", "LFSTFS"},    // Strasbourg (previously mis-stemmed to "LFS")
		{"LFSTFS4.20", "LFSTFS"}, // decimal suffix
		{"LFFFFSN", "LFFFFS"},    // cardinal suffix
		{"LFMMFSN2", "LFMMFS"},   // Marseille vertical subdivision
		{"LFQQFS3", "LFQQFS"},    // Lille
		{"LFSB", "LFSB"},         // 4-char centre, no marker after it: unchanged
		{"", ""},                 // empty: unchanged
	}
	for _, c := range cases {
		if got := sivStem(c.in); got != c.want {
			t.Errorf("sivStem(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// TestParseSIAStemDropFreqs covers the "non-general" classification: a
// frequency the SIA marks as a backup role ("Supplétive"), a delegation
// ("espaces délégués") or as belonging to a numbered sector ("SIV N") is
// recorded against its stem so resolveRadio can keep an untagged sub-sector on
// the general Information frequencies only.
func TestParseSIAStemDropFreqs(t *testing.T) {
	const sia = `<?xml version="1.0" encoding="UTF-8"?>
<SiaExport><Situation><FrequenceS>
<Frequence lk="[LF][SB][FIS BALE Information][130.900]"><Service lk="[LF][SB][FIS BALE Information]"/><Frequence>130.900</Frequence><Remarque>Canal 25. Service : Information/Radar.</Remarque></Frequence>
<Frequence lk="[LF][SB][FIS BALE Information][135.850]"><Service lk="[LF][SB][FIS BALE Information]"/><Frequence>135.850</Frequence><Remarque>Canal 25</Remarque></Frequence>
<Frequence lk="[LF][SB][FIS BALE Information][129.250]"><Service lk="[LF][SB][FIS BALE Information]"/><Frequence>129.250</Frequence><Remarque>Canal 25. Supplétive sur instruction ATC</Remarque></Frequence>
<Frequence lk="[LF][SB][FIS BALE Information][134.680]"><Service lk="[LF][SB][FIS BALE Information]"/><Frequence>134.680</Frequence><Remarque>Canal 8.33. Secteurs T1/T2/T3 (espaces délégués Zürich)</Remarque></Frequence>
<Frequence lk="[LF][ST][FIS STRASBOURG Information][119.450]"><Service lk="[LF][ST][FIS STRASBOURG Information]"/><Frequence>119.450</Frequence><Remarque>SIV 3</Remarque></Frequence>
<Frequence lk="[LF][ST][FIS STRASBOURG Information][136.135]"><Service lk="[LF][ST][FIS STRASBOURG Information]"/><Frequence>136.135</Frequence><Remarque>Secteur OUEST / sector WEST</Remarque></Frequence>
<Frequence lk="[LF][SB][APP BALE Approche][121.300]"><Service lk="[LF][SB][APP BALE Approche]"/><Frequence>121.300</Frequence><Remarque>Fréquence supplétive TMA BALE partie 2.</Remarque></Frequence>
</FrequenceS></Situation></SiaExport>`
	plan, err := parseSIA([]byte(sia), AIXMSIVByName{}, AIXMTMAByName{})
	if err != nil {
		t.Fatal(err)
	}
	hasFreq := func(stem, freq string) bool {
		for _, f := range plan.StemDropFreqs[stem] {
			if f == freq {
				return true
			}
		}
		return false
	}
	// Bâle: the backup (129.250) and delegated (134.680) frequencies are
	// dropped from the general list; the two primaries are not.
	for _, f := range []string{"129.250", "134.680"} {
		if !hasFreq("LFSBFS", f) {
			t.Errorf("StemDropFreqs[LFSBFS] missing %s: %v", f, plan.StemDropFreqs["LFSBFS"])
		}
	}
	for _, f := range []string{"130.900", "135.850"} {
		if hasFreq("LFSBFS", f) {
			t.Errorf("StemDropFreqs[LFSBFS] must not carry the primary %s: %v", f, plan.StemDropFreqs["LFSBFS"])
		}
	}
	// Strasbourg: the SIV-3-tagged frequency is non-general; the "Secteur
	// OUEST" one stays general.
	if !hasFreq("LFSTFS", "119.450") {
		t.Errorf("StemDropFreqs[LFSTFS] missing sector-tagged 119.450: %v", plan.StemDropFreqs["LFSTFS"])
	}
	if hasFreq("LFSTFS", "136.135") {
		t.Errorf("StemDropFreqs[LFSTFS] must not carry general 136.135: %v", plan.StemDropFreqs["LFSTFS"])
	}
	// The sector tag still feeds SectorEntries for the tagged sub-sector.
	if got := plan.SectorEntries["LFSTFS3"]; len(got) != 1 || got[0].Freq != "119.450" {
		t.Errorf("LFSTFS3 SectorEntries = %+v, want one entry 119.450", got)
	}
	// An APP "supplétive" note describes an approach role, not the SIV's: only
	// the FIS service defines a SIV frequency's role, so the APP frequency must
	// NOT enter the drop set (the Nouméa 128.300 false-drop guard).
	if hasFreq("LFSBFS", "121.300") {
		t.Errorf("StemDropFreqs[LFSBFS] must ignore APP-side supplétive 121.300: %v", plan.StemDropFreqs["LFSBFS"])
	}
}

// TestSIVUntaggedGeneralTrim is the end-to-end regression: two adjacent "LFS?"
// centres (Bâle + Strasbourg) must not cross-link frequencies (the sivStem
// fix), an untagged sub-sector keeps only its general Information frequencies
// (backup / delegated / other-sector dropped), a tagged sub-sector still
// narrows, and a sub-sector whose whole union is non-general keeps the union
// rather than going empty.
func TestSIVUntaggedGeneralTrim(t *testing.T) {
	aixm := `<?xml version="1.0" encoding="UTF-8"?>
<AIXM-Snapshot version="4.5" effective="2026-07-09T00:00:00.000+02:00">
  <Ase><AseUid mid="6001"><codeType>RAS</codeType><codeId>LFSBFS</codeId></AseUid><txtName>BALE</txtName><txtLocalType>FLIGHT INFORMATION SECTOR</txtLocalType></Ase>
  <Ase><AseUid mid="6002"><codeType>RAS</codeType><codeId>LFSBFS2</codeId></AseUid><txtName>BALE 2</txtName><txtLocalType>FLIGHT INFORMATION SECTOR</txtLocalType></Ase>
  <Ase><AseUid mid="6101"><codeType>RAS</codeType><codeId>LFSTFS</codeId></AseUid><txtName>STRASBOURG</txtName><txtLocalType>FLIGHT INFORMATION SECTOR</txtLocalType></Ase>
  <Ase><AseUid mid="6102"><codeType>RAS</codeType><codeId>LFSTFS1</codeId></AseUid><txtName>STRASBOURG 1</txtName><txtLocalType>FLIGHT INFORMATION SECTOR</txtLocalType></Ase>
  <Ase><AseUid mid="6103"><codeType>RAS</codeType><codeId>LFSTFS3</codeId></AseUid><txtName>STRASBOURG 3</txtName><txtLocalType>FLIGHT INFORMATION SECTOR</txtLocalType></Ase>
  <Ase><AseUid mid="6201"><codeType>RAS</codeType><codeId>LFRSFS</codeId></AseUid><txtName>NANTES</txtName><txtLocalType>FLIGHT INFORMATION SECTOR</txtLocalType></Ase>
  <Ase><AseUid mid="6202"><codeType>RAS</codeType><codeId>LFRSFS5</codeId></AseUid><txtName>NANTES 5</txtName><txtLocalType>FLIGHT INFORMATION SECTOR</txtLocalType></Ase>
  <Abd><AbdUid mid="8002"><AseUid mid="6002"/></AbdUid>` + quadRing("480000.00N", "0073000.00E") + `</Abd>
  <Abd><AbdUid mid="8102"><AseUid mid="6102"/></AbdUid>` + quadRing("484000.00N", "0074000.00E") + `</Abd>
  <Abd><AbdUid mid="8103"><AseUid mid="6103"/></AbdUid>` + quadRing("483000.00N", "0074000.00E") + `</Abd>
  <Abd><AbdUid mid="8202"><AseUid mid="6202"/></AbdUid>` + quadRing("471000.00N", "0014000.00W") + `</Abd>
  <Sae><SaeUid mid="9001"><SerUid mid="7001"><UniUid><txtName>LFSB BALE</txtName></UniUid><codeType>FIS</codeType></SerUid><AseUid mid="6001"/></SaeUid></Sae>
  <Sae><SaeUid mid="9101"><SerUid mid="7101"><UniUid><txtName>LFST STRASBOURG</txtName></UniUid><codeType>FIS</codeType></SerUid><AseUid mid="6101"/></SaeUid></Sae>
  <Sae><SaeUid mid="9201"><SerUid mid="7201"><UniUid><txtName>LFRS NANTES</txtName></UniUid><codeType>FIS</codeType></SerUid><AseUid mid="6201"/></SaeUid></Sae>
  <Fqy><FqyUid mid="a001"><SerUid mid="7001"/><valFreqTrans>130.900</valFreqTrans></FqyUid><Cdl><txtCallSign>BALE - INFORMATION</txtCallSign><codeLang>FR</codeLang></Cdl></Fqy>
  <Fqy><FqyUid mid="a002"><SerUid mid="7001"/><valFreqTrans>135.850</valFreqTrans></FqyUid><Cdl><txtCallSign>BALE - INFORMATION</txtCallSign><codeLang>FR</codeLang></Cdl></Fqy>
  <Fqy><FqyUid mid="a003"><SerUid mid="7001"/><valFreqTrans>129.250</valFreqTrans></FqyUid><Cdl><txtCallSign>BALE - INFORMATION</txtCallSign><codeLang>FR</codeLang></Cdl></Fqy>
  <Fqy><FqyUid mid="a004"><SerUid mid="7001"/><valFreqTrans>134.680</valFreqTrans></FqyUid><Cdl><txtCallSign>BALE - INFORMATION</txtCallSign><codeLang>FR</codeLang></Cdl></Fqy>
  <Fqy><FqyUid mid="a101"><SerUid mid="7101"/><valFreqTrans>119.450</valFreqTrans></FqyUid><Cdl><txtCallSign>STRASBOURG - INFORMATION</txtCallSign><codeLang>FR</codeLang></Cdl></Fqy>
  <Fqy><FqyUid mid="a102"><SerUid mid="7101"/><valFreqTrans>119.580</valFreqTrans></FqyUid><Cdl><txtCallSign>STRASBOURG - INFORMATION</txtCallSign><codeLang>FR</codeLang></Cdl></Fqy>
  <Fqy><FqyUid mid="a103"><SerUid mid="7101"/><valFreqTrans>136.135</valFreqTrans></FqyUid><Cdl><txtCallSign>STRASBOURG - INFORMATION</txtCallSign><codeLang>FR</codeLang></Cdl></Fqy>
  <Fqy><FqyUid mid="a201"><SerUid mid="7201"/><valFreqTrans>122.800</valFreqTrans></FqyUid><Cdl><txtCallSign>NANTES - INFORMATION</txtCallSign><codeLang>FR</codeLang></Cdl></Fqy>
  <Fqy><FqyUid mid="a202"><SerUid mid="7201"/><valFreqTrans>130.275</valFreqTrans></FqyUid><Cdl><txtCallSign>NANTES - INFORMATION</txtCallSign><codeLang>FR</codeLang></Cdl></Fqy>
</AIXM-Snapshot>`
	const sia = `<?xml version="1.0" encoding="UTF-8"?>
<SiaExport><Situation><FrequenceS>
<Frequence lk="[LF][SB][FIS BALE Information][130.900]"><Service lk="[LF][SB][FIS BALE Information]"/><Frequence>130.900</Frequence><Remarque>Canal 25. Service : Information/Radar.</Remarque></Frequence>
<Frequence lk="[LF][SB][FIS BALE Information][135.850]"><Service lk="[LF][SB][FIS BALE Information]"/><Frequence>135.850</Frequence><Remarque>Canal 25</Remarque></Frequence>
<Frequence lk="[LF][SB][FIS BALE Information][129.250]"><Service lk="[LF][SB][FIS BALE Information]"/><Frequence>129.250</Frequence><Remarque>Canal 25. Supplétive sur instruction ATC</Remarque></Frequence>
<Frequence lk="[LF][SB][FIS BALE Information][134.680]"><Service lk="[LF][SB][FIS BALE Information]"/><Frequence>134.680</Frequence><Remarque>Canal 8.33. Secteurs T1/T2/T3 (espaces délégués Zürich)</Remarque></Frequence>
<Frequence lk="[LF][ST][FIS STRASBOURG Information][119.450]"><Service lk="[LF][ST][FIS STRASBOURG Information]"/><Frequence>119.450</Frequence><Remarque>SIV 3</Remarque></Frequence>
<Frequence lk="[LF][ST][FIS STRASBOURG Information][119.580]"><Service lk="[LF][ST][FIS STRASBOURG Information]"/><Frequence>119.580</Frequence><Remarque>Secteur EST</Remarque></Frequence>
<Frequence lk="[LF][ST][FIS STRASBOURG Information][136.135]"><Service lk="[LF][ST][FIS STRASBOURG Information]"/><Frequence>136.135</Frequence><Remarque>Secteur OUEST / sector WEST</Remarque></Frequence>
<Frequence lk="[LF][RS][FIS NANTES Information][122.800]"><Service lk="[LF][RS][FIS NANTES Information]"/><Frequence>122.800</Frequence><Remarque>SIV 1</Remarque></Frequence>
<Frequence lk="[LF][RS][FIS NANTES Information][130.275]"><Service lk="[LF][RS][FIS NANTES Information]"/><Frequence>130.275</Frequence><Remarque>SIV 2</Remarque></Frequence>
</FrequenceS></Situation></SiaExport>`
	artifact, _, err := BuildAirspaces([]byte(aixm), AirspacesOptions{
		Source:       "trim.aixm.xml",
		SIASource:    []byte(sia),
		Now:          func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) },
		MinAirspaces: 1,
		MaxAirspaces: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	radioOf := func(id string) []string {
		t.Helper()
		for _, r := range artifact.Rows {
			row := r.([]any)
			if row[0] != id {
				continue
			}
			entries := row[11].([]any)
			out := make([]string, 0, len(entries))
			for _, e := range entries {
				out = append(out, e.([]string)[0])
			}
			return out
		}
		t.Fatalf("no emitted row for %q", id)
		return nil
	}
	// Bâle untagged: general primaries only, and NO Strasbourg leakage.
	if got := radioOf("LFSBFS2"); !equalStrings(got, []string{"130.900", "135.850"}) {
		t.Errorf("LFSBFS2 radio = %v, want [130.900 135.850] (backup+delegated dropped, no Strasbourg)", got)
	}
	// Strasbourg untagged: OUEST/EST general, sector-3 tag dropped, NO Bâle leakage.
	if got := radioOf("LFSTFS1"); !equalStrings(got, []string{"119.580", "136.135"}) {
		t.Errorf("LFSTFS1 radio = %v, want [119.580 136.135]", got)
	}
	// Strasbourg tagged sub-sector still narrows to its SIV-3 frequency.
	if got := radioOf("LFSTFS3"); !equalStrings(got, []string{"119.450"}) {
		t.Errorf("LFSTFS3 radio = %v, want [119.450]", got)
	}
	// Never-empty guard: every Nantes frequency is sector-tagged, so trimming
	// the untagged NANTES 5 would empty it; keep the union instead.
	if got := radioOf("LFRSFS5"); !equalStrings(got, []string{"122.800", "130.275"}) {
		t.Errorf("LFRSFS5 radio = %v, want [122.800 130.275] (never trim to empty)", got)
	}
}

// quadRing renders a 4-vertex boundary box with one corner at (lat, lon) for
// the synthetic AIXM SIV fixtures; the shape is irrelevant, only that each
// emitted sub-sector has a valid ring. lat/lon are AIXM DMS strings.
func quadRing(lat, lon string) string {
	return `<Avx><codeType>GRC</codeType><geoLat>` + lat + `</geoLat><geoLong>` + lon + `</geoLong></Avx>` +
		`<Avx><codeType>GRC</codeType><geoLat>` + lat + `</geoLat><geoLong>0080000.00E</geoLong></Avx>` +
		`<Avx><codeType>GRC</codeType><geoLat>460000.00N</geoLat><geoLong>0080000.00E</geoLong></Avx>` +
		`<Avx><codeType>GRC</codeType><geoLat>460000.00N</geoLat><geoLong>` + lon + `</geoLong></Avx>`
}
