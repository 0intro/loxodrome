package main

import (
	"strings"
	"testing"
	"time"

	"github.com/0intro/loxodrome/internal/aixm5"
	"github.com/0intro/loxodrome/internal/eaip"
)

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
		if s.Label == "" || s.Site.Base == "" {
			t.Errorf("%s: label and base URL are required", s.CC)
		}
		if len(s.Sections) == 0 {
			t.Errorf("%s: no sections to read", s.CC)
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
		{"ENR 2.1", "", "LISBOA FIR (LPPC FIR)", "FIR"},
		{"ENR 2.1", "", "SHANNON UIR", "FIR"},
		{"ENR 2.2", "", "LJUBLJANA CTR", "CTR"},
		{"ENR 2.1", "", "LISBOA TMA (LPPT TMA)", "TMA"},
		{"ENR 2.1", "", "BRATISLAVA ATZ", "ATZ"},
		{"ENR 2.2", "", "MARIBOR RMZ", "RMZ"},
		{"ENR 2.1", "", "PRAHA CTA", "CTA"},
		// ATC working sectors are not volumes a pilot is cleared into.
		{"ENR 2.1", "", "3 NORTH LOWER SECTOR 3.1", ""},
		{"ENR 2.1", "", "9 WEST SECTOR", ""},
		{"ENR 2.1", "", "SEE FRA (South-East Europe Free Route Airspace)", ""},
		// ... but a sector OF a published airspace keeps its family.
		{"ENR 2.1", "", "LISBOA TMA SECTOR WEST", "TMA"},
		{"ENR 5.1", "LHP1", "PAKS", "P"},
		{"ENR 5.1", "LPR24C", "PENEDA-GERES", "R"},
		{"ENR 5.1", "LKD4", "BOLETICE", "D"},
		{"ENR 5.1", "", "an area with no designator", ""},
		{"ENR 5.2", "LZTSA01", "MIL TRAINING", "TSA"},
		{"ENR 5.2", "LKTRA71", "LOW FLYING", "TRA"},
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
// AIRAC grid, so the expansion has to reproduce each publisher's naming
// exactly. These are the live paths as of AIRAC 2026-08-06.
func TestCyclePathsMatchPublishers(t *testing.T) {
	eff := time.Date(2026, time.August, 6, 0, 0, 0, 0, time.UTC)
	cases := []struct{ cc, want string }{
		{"hu", "2026-08-06/2026-08-06-AIRAC"},
		{"sk", "AIP_SR_EFF_06AUG2026"},
		{"ie", "AIRAC_AUGUST_2026/26-08-06-AIRAC"},
		{"si", "2026-08-06-AIRAC"},
		{"ba", "2026-08-06-AIRAC"},
		{"rs", "06-Aug-2026-A/2026-08-06-AIRAC"},
		{"al", "06-AUG-2026-A/2026-08-06-AIRAC"},
	}
	for _, c := range cases {
		s := stateByCC(c.cc)
		if s == nil {
			t.Fatalf("%s: not in the cohort", c.cc)
		}
		if len(s.Site.Templates) == 0 {
			t.Fatalf("%s: no templates", c.cc)
		}
		if got := eaip.CyclePath(s.Site.Templates[0], eff); got != c.want {
			t.Errorf("%s: %q, want %q", c.cc, got, c.want)
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
		{"pt", "",
			"https://ais.nav.pt/wp-content/uploads/AIS_Files/eAIP_Current/eAIP_Online/eAIP/html/eAIP/LP-ENR-5.1-en-GB.html"},
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
	}
	for _, s := range states {
		if held[s.CC] != (s.Consent != "") {
			t.Errorf("%s: Consent = %q, held = %v", s.CC, s.Consent, held[s.CC])
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
