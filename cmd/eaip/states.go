// states.go is the cohort: one entry per State whose AIP is published
// only as a generated eAIP package.
//
// Everything a State needs is here. The parsing lives in internal/eaip,
// so adding the eighth State is a table row plus whatever its own
// wording demands, not another scraper. What genuinely differs between
// them, and therefore appears below, is: where the package lives, which
// generator made it, the language suffix on the section filenames, and
// how the State types a zone from its designator.

package main

import (
	_ "embed"
	"strings"

	"github.com/0intro/loxodrome/internal/eaip"
)

// rapidSSLG1 is the intermediate Slovenia Control's server fails to
// send. Its own leaf names this CA as the issuer while the server
// presents a different RapidSSL intermediate, so no strict client can
// build a path; a browser recovers by fetching this certificate from the
// leaf's Authority Information Access extension
// (http://cacerts.rapidssl.com/RapidSSLTLSRSACAG1.crt), and supplying it
// here is the same repair. It chains to DigiCert Global Root G2, which
// the system already trusts, so nothing is weakened. Valid to
// 2 November 2027; the site will need a fresh copy after that, or none
// at all if they fix their chain.
//
//go:embed certs/rapidssl-tls-rsa-ca-g1.pem
var rapidSSLG1 []byte

// State is one publisher in the cohort.
type State struct {
	// CC is the dataset prefix and the SPA publisher id.
	CC string
	// Label names the publisher in logs.
	Label string
	Site  eaip.Site
	// Sections are the AIP sections read for airspace, in order.
	Sections []string
	// NavaidSection is the section carrying the en-route radio
	// navigation aids, ICAO's ENR 4.1. Empty where a State publishes
	// none in a table.
	NavaidSection string
	// Layout says which reader the State's zone tables need.
	Layout Layout
	// Spec configures the zone reader.
	Spec eaip.ZoneSpec
	// FirIdent is the State's own FIR in pruatlas-firs.json, whose ring is
	// the path an "along the border" segment is stitched along.
	FirIdent string
	// Min / Max bound the emitted airspace count.
	MinAirspaces, MaxAirspaces int
	// Consent names the permission the State's terms require before its
	// data may be redistributed. A State that carries one is BUILT on
	// request and never by "all", so a scheduled run cannot commit data
	// this repo has no right to publish; see docs/eaip-states.md.
	Consent string
	// Note records anything a reader of the data should know.
	Note string
}

// Layout picks the zone reader.
type Layout int

const (
	// IcaoTables is the ICAO Annex 15 three-column layout: one table per
	// family, one row per zone, identification and geometry sharing a
	// cell. Most States publish this way.
	IcaoTables Layout = iota
	// ZoneTables is one table per zone, with labelled or columnar rows
	// inside it. Belgium publishes this way; cmd/be reads it.
	ZoneTables
)

// enrSections are the AIP sections that describe airspace. 2.1 and 2.2
// carry the FIR, the control areas and the terminal areas; 5.1 the
// prohibited, restricted and danger areas; 5.2 the military and other
// activity areas; 5.5 the sporting and recreational ones.
var enrSections = []string{"ENR 2.1", "ENR 2.2", "ENR 5.1", "ENR 5.2", "ENR 5.5"}

// navaidSection is where ICAO puts the en-route radio navigation aids,
// and every State in the cohort publishes it in the same seven columns.
const navaidSection = "ENR 4.1"

// plSections: PANSA splits each ENR 5 family into numbered sub-sections
// and keeps the definitions in the parent, so the parent carries no
// zones at all.
var plSections = []string{
	"ENR 2.1", "ENR 2.2",
	"ENR 5.1.1", "ENR 5.1.2", "ENR 5.1.3",
	"ENR 5.2.1", "ENR 5.2.2", "ENR 5.2.3",
	"ENR 5.5",
}

// suaType reads the family letter out of an ICAO area designator:
// "LHP1" is prohibited, "LPR24C" restricted, "LKD4" danger. The letter
// sits after the State's two-letter prefix, which is why the caller
// passes the prefix length rather than guessing.
func suaType(designator string) string {
	d := strings.ToUpper(strings.TrimSpace(designator))
	if len(d) < 3 {
		return ""
	}
	switch d[2] {
	case 'P':
		return "P"
	case 'R':
		return "R"
	case 'D':
		return "D"
	case 'T':
		// TSA / TRA both begin TS / TR after the prefix.
		if strings.HasPrefix(d[2:], "TS") {
			return "TSA"
		}
		return "TRA"
	}
	return ""
}

// sectionType is the type resolver every State in the cohort shares.
// The section says what family a table belongs to and the designator
// refines it, which is exactly how ICAO lays the AIP out.
func sectionType(section, designator, name string) string {
	switch {
	case strings.HasPrefix(section, "ENR 2"):
		// The control-area sections; the name says which kind.
		up := strings.ToUpper(name)
		// An ATC sector is a working division of a control area, not a
		// volume with its own entry conditions: the CTA above it is what a
		// pilot is cleared into, and drawing both would double every
		// boundary. cmd/nl drops the Dutch ACC sectors for the same reason.
		if isATCSector(up) || strings.Contains(up, "FREE ROUTE") {
			// A Free Route Airspace is an IFR flight-planning construct
			// over several States, not a volume with its own entry
			// conditions: Hungary's SEE FRA alone spans from Austria to
			// the Black Sea, and drawing it as a control area would put a
			// false wall across half of south-east Europe.
			return ""
		}
		switch {
		case strings.Contains(up, "FIR"), strings.Contains(up, "UIR"):
			return "FIR"
		case strings.Contains(up, "CTR"):
			return "CTR"
		case strings.Contains(up, "TMA"):
			return "TMA"
		case strings.Contains(up, "ATZ"):
			return "ATZ"
		case strings.Contains(up, "RMZ"):
			return "RMZ"
		case strings.Contains(up, "TMZ"):
			return "TMZ"
		}
		return "CTA"
	case strings.HasPrefix(section, "ENR 5.1"):
		if t := suaType(designator); t != "" {
			return t
		}
		return ""
	case strings.HasPrefix(section, "ENR 5.2"):
		if t := suaType(designator); t == "TSA" || t == "TRA" {
			return t
		}
		// Military exercise and training areas that carry no TSA / TRA
		// designator are danger to a civil aircraft, which is what the
		// D symbol says.
		return "D"
	case strings.HasPrefix(section, "ENR 5.3"):
		// Other activities of a dangerous nature: the warning family.
		return "W"
	case strings.HasPrefix(section, "ENR 5.5"):
		// Sporting and recreational: the activity family's pictograms,
		// not the restricted hatch.
		return "ACTIVITY"
	}
	return ""
}

// isATCSector recognises the ACC / APP working sectors States publish
// beside their control areas ("3 NORTH LOWER SECTOR 3.1", "9 WEST
// SECTOR"). A volume that names a terminal area or a control zone as
// well keeps its own family, since there the word qualifies a part of a
// published airspace rather than a controller position.
func isATCSector(up string) bool {
	return strings.Contains(up, "SECTOR") &&
		!strings.Contains(up, "TMA") && !strings.Contains(up, "CTR") &&
		!strings.Contains(up, "ATZ")
}

// states is the cohort. Every base URL and language suffix here was
// verified against the live site; the ones that are not reachable say so
// in Note rather than being quietly dropped.
var states = []State{
	{
		CC:    "hu",
		Label: "HungaroControl Hungary",
		Site: eaip.Site{
			Country: "LH",
			Family:  eaip.Eurocontrol,
			Base:    "https://ais.hungarocontrol.hu/aip",
			// The cycle directory repeats the effective date one level
			// down; the outer level's frameset is the only place that is
			// written, and dirVariants reads it, so both are probed.
			Templates: []string{"{ISO}/{ISO}-AIRAC", "{ISO}"},
			Index:     "https://ais.hungarocontrol.hu/aip/",
			Lang:      "en-HU",
			Header:    eaip.BrowserHeaders,
		},
		Sections:      enrSections,
		NavaidSection: navaidSection,
		Layout:        IcaoTables,
		Spec:          eaip.ZoneSpec{Type: sectionType, IDPrefix: "HU", IcaoPrefix: "LH"},
		FirIdent:      "LHCC",
		MinAirspaces:  20,
		MaxAirspaces:  2000,
		Consent: "GEN 0.1 makes any usage of the AIP, in full or in part, in any form " +
			"or by any means, subject to HungaroControl's prior written consent",
	},
	{
		CC:    "pt",
		Label: "NAV Portugal",
		Site: eaip.Site{
			Country: "LP",
			Family:  eaip.Eurocontrol,
			// NAV publishes one "current" package rather than a directory
			// per cycle, so there is no cycle level to discover.
			Base:   "https://ais.nav.pt/wp-content/uploads/AIS_Files/eAIP_Current/eAIP_Online/eAIP",
			Lang:   "en-GB",
			Header: eaip.BrowserHeaders,
		},
		Sections:      enrSections,
		NavaidSection: navaidSection,
		Layout:        IcaoTables,
		Spec:          eaip.ZoneSpec{Type: sectionType, IDPrefix: "PT", IcaoPrefix: "LP"},
		FirIdent:      "LPPC",
		MinAirspaces:  20,
		MaxAirspaces:  2000,
		Consent: "GEN 0.1 allows redistribution and copying of the publication's " +
			"contents only by prior agreement with NAV Portugal",
		Note: "one current package, no cycle directories; covers mainland, Azores and Madeira",
	},
	{
		CC:    "cz",
		Label: "ANS CR Czechia",
		Site: eaip.Site{
			Country: "LK",
			Family:  eaip.Eurocontrol,
			// ANS CR publishes the cycle in force at one fixed path.
			Base:   "https://aim.rlp.cz/eaip",
			Lang:   "en-GB",
			Header: eaip.BrowserHeaders,
		},
		Sections:      enrSections,
		NavaidSection: navaidSection,
		Layout:        IcaoTables,
		Spec:          eaip.ZoneSpec{Type: sectionType, IDPrefix: "CZ", IcaoPrefix: "LK"},
		FirIdent:      "LKAA",
		MinAirspaces:  20,
		MaxAirspaces:  2000,
		Consent: "ANS CR's terms of use forbid providing the site's contents as part of " +
			"another product or service without prior consent; a request is pending",
	},
	{
		CC:    "sk",
		Label: "LPS SR Slovakia",
		Site: eaip.Site{
			Country: "LZ",
			// Slovakia's package has no eAIP/ level under html/.
			Family:    eaip.EurocontrolFlat,
			Base:      "https://aim.lps.sk/web/eAIP_SR",
			Templates: []string{"AIP_SR_EFF_{DD}{MON}{YYYY}"},
			Lang:      "en-SK",
			Header:    eaip.BrowserHeaders,
		},
		Sections:      enrSections,
		NavaidSection: navaidSection,
		Layout:        IcaoTables,
		Spec:          eaip.ZoneSpec{Type: sectionType, IDPrefix: "SK", IcaoPrefix: "LZ"},
		FirIdent:      "LZBB",
		MinAirspaces:  20,
		MaxAirspaces:  2000,
		Note:          "cycle directories are named AIP_SR_EFF_<DDMONYYYY>",
	},
	{
		CC:    "ie",
		Label: "AirNav Ireland",
		Site: eaip.Site{
			Country: "EI",
			Family:  eaip.Eurocontrol,
			Base:    "https://www.airnav.ie",
			// AirNav writes the inner directory with a two- or four-digit
			// year depending on the cycle, so both are probed.
			Templates: []string{
				"AIRAC_{MONTH}_{YYYY}/{YY}-{MM}-{DD}-AIRAC",
				"AIRAC_{MONTH}_{YYYY}/{ISO}-AIRAC",
			},
			Lang:   "en-IE",
			Header: eaip.BrowserHeaders,
		},
		Sections:      enrSections,
		NavaidSection: navaidSection,
		Layout:        IcaoTables,
		Spec:          eaip.ZoneSpec{Type: sectionType, IDPrefix: "IE", IcaoPrefix: "EI"},
		FirIdent:      "EISN",
		MinAirspaces:  10,
		MaxAirspaces:  2000,
		Note:          "cycle directories sit under an AIRAC_<MONTH>_<YEAR> parent",
	},
	{
		CC:    "pl",
		Label: "PANSA Poland",
		Site: eaip.Site{
			Country: "",
			// IDS AIRNAV: a space before the section number, no State
			// prefix on the filename, and no html/ level.
			Family: eaip.IDS,
			Base:   "https://docs.pansa.pl/ais/eaipifr",
			// The index filename carries the cycle's own effective date.
			Index:  "https://docs.pansa.pl/ais/eaipifr/default_offline_{ISO}.html",
			Lang:   "en-GB",
			Header: eaip.BrowserHeaders,
		},
		Sections:      plSections,
		NavaidSection: navaidSection,
		Layout:        IcaoTables,
		Spec:          eaip.ZoneSpec{Type: sectionType, IDPrefix: "PL", IcaoPrefix: "EP"},
		FirIdent:      "EPWW",
		MinAirspaces:  20,
		MaxAirspaces:  2000,
		Consent: "PANSA's copyright rules allow AIS products only in unchanged form for " +
			"operational use by ICAO Annex 15 entities; anything else needs PANSA consent, " +
			"which is being asked",
	},
	{
		CC:    "rs",
		Label: "SMATSA Serbia and Montenegro",
		Site: eaip.Site{
			Country: "LY",
			Family:  eaip.Eurocontrol,
			Base:    "https://smatsa.rs/upload/aip/published",
			// SMATSA wraps the AIRAC directory in a dated amendment
			// folder, and spells the month either way up. -A is the AIRAC
			// amendment; -NA the non-AIRAC one, which also carries a
			// complete package.
			Templates: []string{
				"{DD}-{Mon}-{YYYY}-A/{ISO}-AIRAC",
				"{DD}-{MON}-{YYYY}-A/{ISO}-AIRAC",
				"{DD}-{Mon}-{YYYY}-NA/{ISO}-AIRAC",
			},
			Lang:   "en-GB",
			Header: eaip.BrowserHeaders,
		},
		Sections:      enrSections,
		NavaidSection: navaidSection,
		Layout:        IcaoTables,
		Spec:          eaip.ZoneSpec{Type: sectionType, IDPrefix: "RS", IcaoPrefix: "LY"},
		FirIdent:      "LYBA",
		MinAirspaces:  10,
		MaxAirspaces:  2000,
		Note:          "one package covers Serbia AND Montenegro, which share the Beograd FIR",
	},
	{
		CC:    "al",
		Label: "ALBCONTROL Albania",
		Site: eaip.Site{
			Country: "LA",
			Family:  eaip.Eurocontrol,
			Base:    "https://www.albcontrol.al/al/aip",
			// Same dated-amendment wrapper as SMATSA, month upper-case.
			Templates: []string{
				"{DD}-{MON}-{YYYY}-A/{ISO}-AIRAC",
				"{DD}-{Mon}-{YYYY}-A/{ISO}-AIRAC",
				"{DD}-{MON}-{YYYY}-NA/{ISO}-AIRAC",
			},
			Lang:   "en-GB",
			Header: eaip.BrowserHeaders,
		},
		Sections:      enrSections,
		NavaidSection: navaidSection,
		Layout:        IcaoTables,
		Spec:          eaip.ZoneSpec{Type: sectionType, IDPrefix: "AL", IcaoPrefix: "LA"},
		FirIdent:      "LAAA",
		MinAirspaces:  5,
		MaxAirspaces:  2000,
		Consent: "GEN 0.1 reserves all rights and forbids reproducing, storing or " +
			"transmitting any part of the publication without ALBCONTROL's prior " +
			"written permission",
	},
	{
		CC:    "xk",
		Label: "KANS Kosovo",
		Site: eaip.Site{
			Country: "BK",
			// IDS AIRNAV, the family Poland runs: a space before the
			// section number, and the package under eAIP/.
			Family: eaip.IDS,
			Base:   "https://kans-ks.org/eAIP",
			// The cycle directories are amendment labels, so they are
			// read from the State's own index rather than derived.
			Index:  "https://kans-ks.org/eAIP/default.html",
			Lang:   "en-GB",
			Header: eaip.BrowserHeaders,
		},
		Sections:      enrSections,
		NavaidSection: navaidSection,
		Layout:        IcaoTables,
		Spec:          eaip.ZoneSpec{Type: sectionType, IDPrefix: "XK", IcaoPrefix: "BK"},
		// Kosovo's airspace sits inside the Beograd FIR ring pruatlas
		// carries; KANS publishes no FIR of its own.
		FirIdent:     "LYBA",
		MinAirspaces: 5,
		MaxAirspaces: 2000,
		Note:         "XK is the ISO 3166 user-assigned code for Kosovo, which has no ICAO country prefix of its own",
	},
	{
		CC:    "ba",
		Label: "BHANSA Bosnia and Herzegovina",
		Site: eaip.Site{
			Country: "LQ",
			Family:  eaip.Eurocontrol,
			Base:    "https://eaip.bhansa.gov.ba",
			// BHANSA is the best-behaved publisher in the region: its own
			// updates.json lists every issue with its effective and
			// publication dates, and the package sits under the effective
			// date. The template is enough, so the JSON is not read.
			Templates: []string{"{ISO}-AIRAC"},
			Lang:      "en-GB",
			Header:    eaip.BrowserHeaders,
		},
		Sections:      enrSections,
		NavaidSection: navaidSection,
		Layout:        IcaoTables,
		Spec:          eaip.ZoneSpec{Type: sectionType, IDPrefix: "BA", IcaoPrefix: "LQ"},
		FirIdent:      "LQSB",
		MinAirspaces:  10,
		MaxAirspaces:  2000,
		Consent: "GEN 0.1 reserves all rights and forbids reproducing any part of the " +
			"AIP, or storing it in a database of any kind, without BHANSA's prior " +
			"written permission",
		Note: "publishes its issue list as updates.json, the only machine-readable cycle index in the cohort",
	},
	{
		CC:    "si",
		Label: "Slovenia Control",
		Site: eaip.Site{
			Country:   "LJ",
			Family:    eaip.Eurocontrol,
			Base:      "https://aim.sloveniacontrol.si/aim/eAIP/Operations",
			Templates: []string{"{ISO}-AIRAC"},
			Lang:      "en-GB",
			Header:    eaip.BrowserHeaders,
			ExtraCA:   rapidSSLG1,
		},
		Sections:      enrSections,
		NavaidSection: navaidSection,
		Layout:        IcaoTables,
		Spec:          eaip.ZoneSpec{Type: sectionType, IDPrefix: "SI", IcaoPrefix: "LJ"},
		FirIdent:      "LJLA",
		MinAirspaces:  10,
		MaxAirspaces:  2000,
		Consent: "GEN 0.1 does not allow change, reproduction or distribution without " +
			"Slovenia Control's permission",
		Note: "the server presents the wrong TLS intermediate; the real one is " +
			"embedded (see rapidSSLG1) exactly as a browser would fetch it",
	},
}

// stateByCC finds a cohort entry.
func stateByCC(cc string) *State {
	for i := range states {
		if states[i].CC == cc {
			return &states[i]
		}
	}
	return nil
}
