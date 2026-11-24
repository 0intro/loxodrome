package main

import (
	"context"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/aixm5"
	"github.com/0intro/loxodrome/internal/eaip"
)

// A section that cannot be read fails the State rather than writing it
// without the section: Finland's ENR 5.1 alone is 259 of its 763 zones,
// and the rest clear its floor of 20.
func TestBuildFailsOnAnUnreadSection(t *testing.T) {
	snap := t.TempDir()
	s := State{
		CC:           "xx",
		Label:        "Test",
		Site:         eaip.Site{Country: "XX", Family: eaip.Eurocontrol, Base: "https://aip.example", Lang: "en-GB", Replay: snap},
		Sections:     []string{"ENR 2.1", "ENR 5.1"},
		Layout:       IcaoTables,
		Spec:         eaip.ZoneSpec{Type: sectionType, IDPrefix: "XX", IcaoPrefix: "XX"},
		MinAirspaces: 1,
		MaxAirspaces: 10,
	}
	cyc := eaip.Cycle{Dir: "2026-09-03-AIRAC"}
	put := func(section, rows string) {
		t.Helper()
		u, err := url.Parse(s.Site.PageURL(cyc, section))
		if err != nil {
			t.Fatal(err)
		}
		name := filepath.Join(snap, u.Host, filepath.FromSlash(u.Path))
		if err := os.MkdirAll(filepath.Dir(name), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(name, []byte(`<html><body><table>`+rows+`</table></body></html>`), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	put("ENR 2.1", `<tr><td>Name Lateral limits Vertical limits Class of airspace</td><td>Unit providing service</td>`+
		`<td>Call sign Languages Hours of service</td><td>Frequency / Purpose</td><td>Remarks</td></tr>`+
		`<tr><td>TEST CTA 480000N 0170000E - 490000N 0180000E - 480000N 0190000E - 480000N 0170000E `+
		`FL 245 / 2500 FT AMSL Class of airspace: C</td><td>TEST ACC</td><td>TEST RADAR EN H24</td><td>127.500</td><td></td></tr>`)
	out := t.TempDir()
	written := filepath.Join(out, "xx-airspaces.json")
	airspaces := aip.DatasetFilter("airspaces")
	if err := build(context.Background(), &s, out, "current", cyc.Dir, "", airspaces, aip.SanityWindows{}); err == nil {
		t.Errorf("build without ENR 5.1 succeeded, want an error naming the section")
	}
	if _, err := os.Stat(written); err == nil {
		t.Errorf("build without ENR 5.1 wrote %s", written)
	}
	put("ENR 5.1", `<tr><td>Identification, name and lateral limits</td><td>Upper limit Lower limit</td><td>Remarks</td></tr>`+
		`<tr><td>XXR1 TEST 481000N 0171000E - 482000N 0172000E - 481000N 0173000E - 481000N 0171000E</td>`+
		`<td>FL 095 GND</td><td>H24</td></tr>`)
	if err := build(context.Background(), &s, out, "current", cyc.Dir, "", airspaces, aip.SanityWindows{}); err != nil {
		t.Errorf("build with every section: %v", err)
	}
	if _, err := os.Stat(written); err != nil {
		t.Errorf("build with every section wrote nothing: %v", err)
	}
}

// Every cohort entry has to be complete enough to run: a State missing
// its section list or its ICAO prefix fails at fetch time in CI rather
// than here, which is the wrong place to find out.
func TestCohortWellFormed(t *testing.T) {
	seen := map[string]bool{}
	for _, s := range states {
		if len(s.CC) != 2 {
			t.Errorf("%q: dataset prefix must be two letters", s.CC)
		}
		if seen[s.CC] {
			t.Errorf("%s: duplicate entry", s.CC)
		}
		seen[s.CC] = true
		if s.Label == "" || (s.Site.Base == "" && s.Site.BaseFrom == "") {
			t.Errorf("%s: label and base URL are required", s.CC)
		}
		if len(s.Sections) == 0 {
			t.Errorf("%s: no sections to read", s.CC)
		}
		if s.ChartsOnly {
			// Read for its chart index alone: no zone reader to configure.
			continue
		}
		if s.Spec.Type == nil {
			t.Errorf("%s: no type resolver", s.CC)
		}
		if s.Spec.IDPrefix != strings.ToUpper(s.CC) {
			t.Errorf("%s: IDPrefix %q, want %q", s.CC, s.Spec.IDPrefix, strings.ToUpper(s.CC))
		}
		if len(s.Spec.IcaoPrefix) != 2 {
			t.Errorf("%s: IcaoPrefix %q, want the State's two-letter ICAO prefix", s.CC, s.Spec.IcaoPrefix)
		}
		if s.MinAirspaces <= 0 || s.MaxAirspaces <= s.MinAirspaces {
			t.Errorf("%s: sanity window [%d, %d] is not a window", s.CC, s.MinAirspaces, s.MaxAirspaces)
		}
		// A State with no cycle level (one "current" package) is fine;
		// one with both a template list and an index is not, since only
		// the templates would ever be used.
		if len(s.Site.Templates) > 0 && s.Site.Index != "" && s.CC != "hu" {
			t.Errorf("%s: templates and index are both set; the index is dead", s.CC)
		}
	}
}

// The section number decides the family and the designator refines it,
// which is exactly how ICAO lays the AIP out. The ATC-sector and
// free-route skips are the two deliberate holes.
func TestSectionType(t *testing.T) {
	cases := []struct{ section, designator, name, want string }{
		// A FIR is pruatlas's to draw, with its chart arcs.
		{"ENR 2.1", "", "LISBOA FIR (LPPC FIR)", ""},
		{"ENR 2.1", "", "SHANNON UIR", ""},
		{"ENR 2.1", "", "REYKJAVIK FLIGHT INFORMATION REGION (BIRD FIR)", ""},
		// ... but a FIR row that also names the CTA states the control
		// area, which is no FIR (SMATSA's), unlike an upper area beside a
		// UIR (AirNav's).
		{"ENR 2.1", "", "BEOGRAD FIR/UIR/CTA/UTA", "CTA"},
		{"ENR 2.1", "", "SHANNON UIR / UTA", ""},
		// ... and only an abbreviation standing as a word names one.
		{"ENR 2.1", "", "FIRING RANGE CTA", "CTA"},
		// A delegated area is drawn with the delegation comb, even where
		// it names the FIR it lies in.
		{"ENR 2.2", "", "HALTI (EFDLG1 CTA)", "DLG-ATS"},
		{"ENR 2.2", "", "DELEGATION OF RESPONSIBILITY FOR PROVIDING ATS WITHIN AIRSPACE OF VILNIUS FIR TO RIGA ACC", "DLG-ATS"},
		// Information zones and areas are entered on the radio: the
		// State's word is kept, which the builder draws as an RMZ.
		{"ENR 2.1", "", "EFET FIZ UPPER (EFSETFU FIZ)", "FIZ"},
		{"ENR 2.2", "", "Finnmark TIA", "TIA"},
		{"ENR 2.1", "", "CROATIA CTA", "CTA"},
		{"ENR 2.2", "", "LJUBLJANA CTR", "CTR"},
		{"ENR 2.1", "", "LISBOA TMA (LPPT TMA)", "TMA"},
		{"ENR 2.1", "", "BRATISLAVA ATZ", "ATZ"},
		{"ENR 2.2", "", "MARIBOR RMZ", "RMZ"},
		// A zone both radio and transponder mandatory is the app's
		// TMZ-RMZ, whose alert asks for both.
		{"ENR 2.2", "", "Sligo RMZ/TMZ", "TMZ-RMZ"},
		{"ENR 2.2", "", "Kjeller RMZ_TMZ", "TMZ-RMZ"},
		{"ENR 2.1", "", "PRAHA CTA", "CTA"},
		// ATC working sectors are not volumes a pilot is cleared into.
		{"ENR 2.1", "", "3 NORTH LOWER SECTOR 3.1", ""},
		{"ENR 2.1", "", "9 WEST SECTOR", ""},
		{"ENR 2.1", "", "SEE FRA (South-East Europe Free Route Airspace)", ""},
		// ... but a sector OF a published airspace keeps its family.
		{"ENR 2.1", "", "LISBOA TMA SECTOR WEST", "TMA"},
		// So does a sector of a control area in ENR 2.1, the section of
		// the control areas: LPS SR publishes the Bratislava CTA as its
		// three sectors alone.
		{"ENR 2.1", "", "BRATISLAVA CTA SECTOR WEST", "CTA"},
		// A controller's sector named after its CTA stays out in ENR 2.2
		// (EANS's, collapsed sectors among them), and the letters CTA
		// inside a word name no control area (Fintraffic's).
		{"ENR 2.2", "", "Tallinn CTA sector E1 (EETTE1)", ""},
		{"ENR 2.1", "", "EF ACC SECT A (EFACCSECTA SECTOR)", ""},
		{"ENR 5.1", "LHP1", "PAKS", "P"},
		{"ENR 5.1", "LPR24C", "PENEDA-GERES", "R"},
		{"ENR 5.1", "LKD4", "BOLETICE", "D"},
		{"ENR 5.1", "", "an area with no designator", ""},
		{"ENR 5.2", "LZTSA01", "MIL TRAINING", "TSA"},
		{"ENR 5.2", "LKTRA71", "LOW FLYING", "TRA"},
		// ... and one named by its kind and number, with no ICAO prefix
		// to split a designator off (SMATSA).
		{"ENR 5.2", "", "TSA 02", "TSA"},
		{"ENR 5.2", "", "TRA 01 Lok", "TRA"},
		{"ENR 5.2", "", "TRAINING AREA", "D"},
		// A military area with no TSA / TRA designator is danger to a
		// civil aircraft, which is what the D symbol says.
		{"ENR 5.2", "", "MILITARY EXERCISE AREA", "D"},
		{"ENR 5.3", "", "GAS VENTING", "W"},
		{"ENR 5.5", "", "GLIDING SITE", "ACTIVITY"},
		{"GEN 1.1", "", "anything", ""},
	}
	for _, c := range cases {
		if got := sectionType(c.section, c.designator, c.name); got != c.want {
			t.Errorf("sectionType(%q, %q, %q) = %q, want %q",
				c.section, c.designator, c.name, got, c.want)
		}
	}
}

// A State's package is located by expanding its templates against the
// AIRAC grid, in order, so each expansion has to reproduce one of the
// publisher's namings exactly. These are the live paths as of AIRAC
// 2026-08-06, and Slovakia's amended one as of 2026-10-29. Ireland left
// the table: AirNav's folders follow no template, and its AIM page's
// links are what find them.
func TestCyclePathsMatchPublishers(t *testing.T) {
	eff := time.Date(2026, time.August, 6, 0, 0, 0, 0, time.UTC)
	cases := []struct {
		cc   string
		want []string
	}{
		{"hu", []string{"2026-08-06/2026-08-06-AIRAC", "2026-08-06"}},
		{"sk", []string{"AIP_SR_EFF_06AUG2026_amdt", "AIP_SR_EFF_06AUG2026"}},
		{"si", []string{"2026-08-06-AIRAC"}},
		{"ba", []string{"2026-08-06-AIRAC"}},
		{"rs", []string{
			"06-Aug-2026-A/2026-08-06-AIRAC",
			"06-AUG-2026-A/2026-08-06-AIRAC",
			"06-Aug-2026-NA/2026-08-06-AIRAC",
		}},
		{"al", []string{
			"06-AUG-2026-A/2026-08-06-AIRAC",
			"06-Aug-2026-A/2026-08-06-AIRAC",
			"06-AUG-2026-NA/2026-08-06-AIRAC",
		}},
	}
	for _, c := range cases {
		s := stateByCC(c.cc)
		if s == nil {
			t.Fatalf("%s: not in the cohort", c.cc)
		}
		var got []string
		for _, tmpl := range s.Site.Templates {
			got = append(got, eaip.CyclePath(tmpl, eff))
		}
		if !slices.Equal(got, c.want) {
			t.Errorf("%s: templates expand to %q, want %q", c.cc, got, c.want)
		}
	}
}

// The section URL is where a wrong assumption produces an empty scrape
// rather than an error, so each family's spelling is pinned.
func TestSectionURLs(t *testing.T) {
	cases := []struct{ cc, dir, want string }{
		{"hu", "2026-08-06/2026-08-06-AIRAC",
			"https://ais.hungarocontrol.hu/aip/2026-08-06/2026-08-06-AIRAC/html/eAIP/LH-ENR-5.1-en-HU.html"},
		{"sk", "AIP_SR_EFF_06AUG2026",
			"https://aim.lps.sk/web/eAIP_SR/AIP_SR_EFF_06AUG2026/html/LZ-ENR-5.1-en-SK.html"},
		// Portugal's frameset loads -en-PT; the -en-GB files beside them
		// are June's, left online.
		{"pt", "",
			"https://ais.nav.pt/wp-content/uploads/AIS_Files/eAIP_Current/eAIP_Online/eAIP/html/eAIP/LP-ENR-5.1-en-PT.html"},
		{"cz", "",
			"https://aim.rlp.cz/eaip/html/eAIP/LK-ENR-5.1-en-GB.html"},
		{"ba", "2026-08-06-AIRAC",
			"https://eaip.bhansa.gov.ba/2026-08-06-AIRAC/html/eAIP/LQ-ENR-5.1-en-GB.html"},
		{"rs", "06-Aug-2026-A/2026-08-06-AIRAC",
			"https://smatsa.rs/upload/aip/published/06-Aug-2026-A/2026-08-06-AIRAC/html/eAIP/LY-ENR-5.1-en-GB.html"},
		// Kosovo runs the same IDS generator as Poland but DOES carry a
		// State prefix on the filename.
		{"xk", "AIRAC AMDT 08-2026_2026_08_06",
			"https://kans-ks.org/eAIP/AIRAC AMDT 08-2026_2026_08_06/eAIP/BK-ENR 5.1-en-GB.html"},
		// Poland's generator puts a space before the number and no State
		// prefix at all on the filename.
		{"pl", "AIRAC AMDT 08-26_2026_08_06",
			"https://docs.pansa.pl/ais/eaipifr/AIRAC AMDT 08-26_2026_08_06/eAIP/ENR 5.1-en-GB.html"},
	}
	for _, c := range cases {
		s := stateByCC(c.cc)
		if s == nil {
			t.Fatalf("%s: not in the cohort", c.cc)
		}
		if got := s.Site.SectionURL(c.dir, "ENR 5.1"); got != c.want {
			t.Errorf("%s:\n got %s\nwant %s", c.cc, got, c.want)
		}
	}
}

// A State whose terms require the publisher's consent must never be
// built by the scheduled `-state all` run; holding it is the whole point
// of the Consent field.
//
// Czechia and Poland say so on their AIS websites. The other four say so
// in their own eAIP, in the GEN 0.1 section ICAO Annex 15 gives them for
// it: Hungary makes any usage of the AIP subject to prior written
// consent, Portugal allows redistribution only by prior agreement,
// Bosnia forbids reproducing any part or storing it in a database,
// Slovenia forbids change, reproduction or distribution, and Albania
// forbids reproducing, storing or transmitting any part. Each was read
// at the publisher's own package; the quotes are in docs/eaip-states.md.
//
// The list is spelled out rather than derived so that dropping a
// Consent string fails here instead of quietly scheduling a State back
// into the weekly commit.
func TestConsentHeldStates(t *testing.T) {
	held := map[string]bool{
		"cz": true,
		"pl": true,
		"hu": true,
		"pt": true,
		"ba": true,
		"si": true,
		"al": true,
		// The 2026-09-24 survey's: Estonia and Norway on their GEN 0.1,
		// Latvia until LGS explains its "view-only".
		"ee": true,
		"lv": true,
		"no": true,
	}
	for _, s := range states {
		if held[s.CC] != (s.Consent != "") {
			t.Errorf("%s: Consent = %q, held = %v", s.CC, s.Consent, held[s.CC])
		}
	}
}

// A held State's data is built for local use and never committed: only
// its chart index, links to the publisher's own files, may be in
// public/data (docs/aip-sources.md, "Chart links are not copies").
func TestNoHeldDataCommitted(t *testing.T) {
	for _, s := range states {
		if s.Consent == "" {
			continue
		}
		files, err := filepath.Glob(filepath.Join("..", "..", "public", "data", s.CC+"-*.json"))
		if err != nil {
			t.Fatal(err)
		}
		for _, f := range files {
			if !strings.HasPrefix(filepath.Base(f), s.CC+"-adcharts.") {
				t.Errorf("%s is held, and %s is committed", s.CC, f)
			}
		}
	}
}

// A run naming one held State is refused public/data, unless it asks
// for the chart index alone: "-state cz" wrote Czechia's airspace,
// navaids and aerodromes there.
func TestHeldStateRefusesPublicData(t *testing.T) {
	local := t.TempDir()
	for _, c := range []struct {
		cc, out, only string
		refused       bool
	}{
		{"cz", defaultOutDir, "", true},
		{"cz", defaultOutDir, "airspaces", true},
		{"cz", defaultOutDir, "adcharts,navaids", true},
		{"cz", defaultOutDir, "adcharts", false},
		{"cz", local, "", false},
		{"sk", defaultOutDir, "", false},
	} {
		err := heldOut(stateByCC(c.cc), c.out, aip.DatasetFilter(c.only))
		if (err != nil) != c.refused {
			t.Errorf("heldOut(%s, %s, -only %q) = %v, want refused %v", c.cc, c.out, c.only, err, c.refused)
		}
	}
}

// Dedupe drops a republication, never a distinct volume: several rows
// commonly share one id (a CTA in parts) and the app addresses those by
// key rather than id.
func TestDedupeZones(t *testing.T) {
	ringA := [][2]float64{{50, 4}, {50, 5}, {51, 5}}
	ringB := [][2]float64{{40, 4}, {40, 5}, {41, 5}}
	in := []aixm5.Airspace{
		{ID: "X", Type: "CTA", Ring: ringA},
		{ID: "X", Type: "CTA", Ring: ringA}, // republished verbatim
		{ID: "X", Type: "CTA", Ring: ringB}, // a second part of the same CTA
		{ID: "X", Type: "TMA", Ring: ringA}, // a different family
	}
	got := dedupeZones(in)
	if len(got) != 3 {
		t.Fatalf("dedupeZones kept %d rows, want 3", len(got))
	}
}
