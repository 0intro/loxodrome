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
	"bytes"
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

// goDaddyChain is what Avians' eaip.avians.is fails to send: the server
// presents its *.avians.is leaf alone, which a browser completes from
// the leaf's Authority Information Access extension. The leaf changed
// issuer on 2026-09-24, so both of GoDaddy's paths are carried:
//
//   - "Go Daddy Secure Certificate Authority - G2", the older leaf's
//     issuer, under Go Daddy Root Certificate Authority - G2;
//   - "GoDaddy TLS Intermediate CA DV - R1v1", the current leaf's issuer,
//     and "GoDaddy TLS Root CA - R1" as cross-signed by that same G2 root,
//     since the R1 root itself is too new for the system's trust store.
//
// Each is offered as an intermediate only (Site.ExtraCA), so the path
// still ends at G2, a root the system trusts. Fingerprints as GoDaddy's
// repository (certs.godaddy.com/repository) lists them, SHA-256: R1v1
// 7A43BC77...8DBE2E, the cross certificate 7BCB0F2F...81298C.
//
//go:embed certs/godaddy-secure-ca-g2.pem
var goDaddyG2 []byte

//go:embed certs/godaddy-tls-dv-r1v1.pem
var goDaddyR1v1 []byte

//go:embed certs/godaddy-tls-root-r1-cross-g2.pem
var goDaddyR1CrossG2 []byte

var goDaddyChain = bytes.Join([][]byte{goDaddyG2, goDaddyR1v1, goDaddyR1CrossG2}, []byte("\n"))

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
	// ObstacleSection is ENR 5.4 where this command owns the State's
	// obstacles: empty where another source does (Finland's Area 1
	// register, cmd/fi) or the section holds no table (AirNav Ireland
	// publishes a spreadsheet, KANS "To be developed").
	ObstacleSection string
	// Register is the Area 1 obstacle data set published beside the eAIP,
	// which stands in for ENR 5.4 where there is one (registers.go).
	Register *obstacleRegister
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
	// ChartsOnly marks a State whose airspace this repo reads elsewhere
	// (Sweden's WFS in cmd/se, LVNL's ArcGIS in cmd/nl): its package gives
	// the chart index alone, Sections naming the section it is confirmed
	// by.
	ChartsOnly bool
	// MinAirports is the airports dataset's sanity floor.
	MinAirports int
	// AirportCountry names the aerodromes whose ISO country is not the
	// State's own: SMATSA publishes Montenegro's with Serbia's.
	AirportCountry map[string]string
	// ChartSites are further packages whose aerodrome pages join the
	// State's chart index (packages.go): PANSA files its small aerodromes
	// in a VFR eAIP of their own, as AD 4, and ANS CR in its VFR Manual.
	ChartSites []chartPackage
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

// pointSection is ICAO's list of the significant points, the five-letter
// name-codes, which every State in the cohort publishes, Kosovo included.
const pointSection = "ENR 4.4"

// obstacleSection is ICAO's list of the air navigation obstacles.
const obstacleSection = "ENR 5.4"

// plSections: PANSA splits each ENR 5 family into numbered sub-sections
// and keeps the definitions in the parent, so the parent carries no
// zones at all.
var plSections = []string{
	"ENR 2.1", "ENR 2.2",
	"ENR 5.1.1", "ENR 5.1.2", "ENR 5.1.3",
	"ENR 5.2.1", "ENR 5.2.2", "ENR 5.2.3",
	"ENR 5.5",
}

// sectionType is the cohort's type resolver, internal/eaip's: cmd/ro reads
// Romania's PDF sections with it too.
var sectionType = eaip.SectionType

// finlandDrop leaves out what Finland publishes beside its airspace that
// is no airspace to draw. Beside each AMC-manageable TRA and TSA, ENR 5.2
// gives a wider ring under the same designator and a Z ("EFTRA00Z", "Only
// for FPL validation"): a filing construct for IFR flight plans, and 181
// rings drawn over the areas they surround. ENR 2.2's ALAND RAS states no
// class, no unit and no frequency (all NIL): nothing a pilot is
// controlled or informed in, and a CTA from the surface up is the wrong
// thing to draw.
func finlandDrop(section, designator, name string) string {
	switch {
	case strings.HasPrefix(section, "ENR 5.2") && strings.HasSuffix(strings.ToUpper(designator), "Z"):
		return "FLIGHT PLAN BUFFER ZONE"
	case strings.EqualFold(strings.TrimSpace(name), "ALAND RAS"):
		return "ALAND RAS"
	}
	return ""
}

// icelandType types Iceland's zones. Its ENR 2.2 is nothing but the areas
// where ATS is delegated across a border (North Sea Area IV to Sumburgh,
// the RATSU Triangle and the upper Nuuk FIR to Reykjavik, the Vagar FIZ),
// which the chart's delegation comb draws.
func icelandType(section, designator, name string) string {
	if section == "ENR 2.2" {
		return "DLG-ATS"
	}
	return sectionType(section, designator, name)
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
		Sections:        enrSections,
		NavaidSection:   navaidSection,
		ObstacleSection: obstacleSection,
		Layout:          IcaoTables,
		Spec:            eaip.ZoneSpec{Type: sectionType, IDPrefix: "HU", IcaoPrefix: "LH"},
		FirIdent:        "LHCC",
		MinAirspaces:    20,
		MaxAirspaces:    2000,
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
			// per cycle, so there is no cycle level to discover, and the
			// pre-release as one "forthcoming" package beside it.
			Base:     "https://ais.nav.pt/wp-content/uploads/AIS_Files/eAIP_Current/eAIP_Online/eAIP",
			NextBase: "https://ais.nav.pt/wp-content/uploads/AIS_Files/eAIP_Forthcoming_1/eAIP_Online/eAIP",
			// The frameset loads -en-PT since mid-2026; the June -en-GB
			// files are still online beside it and must never be read.
			Lang:   "en-PT",
			Header: eaip.BrowserHeaders,
		},
		Sections:        enrSections,
		NavaidSection:   navaidSection,
		ObstacleSection: obstacleSection,
		Layout:          IcaoTables,
		Spec:            eaip.ZoneSpec{Type: sectionType, IDPrefix: "PT", IcaoPrefix: "LP"},
		FirIdent:        "LPPC",
		MinAirspaces:    20,
		MaxAirspaces:    2000,
		Consent: "GEN 0.1 allows redistribution and copying of the publication's " +
			"contents only by prior agreement with NAV Portugal",
		Note: "one current and one forthcoming package, no cycle directories; covers mainland, Azores and Madeira",
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
		Sections:        enrSections,
		NavaidSection:   navaidSection,
		ObstacleSection: obstacleSection,
		Layout:          IcaoTables,
		Spec:            eaip.ZoneSpec{Type: sectionType, IDPrefix: "CZ", IcaoPrefix: "LK"},
		FirIdent:        "LKAA",
		MinAirspaces:    20,
		MaxAirspaces:    2000,
		Consent: "ANS CR's terms of use forbid providing the site's contents as part of " +
			"another product or service without prior consent; a request is pending",
		// The eAIP carries the eleven AD 2 aerodromes; the rest, and
		// their visual operation charts, are the VFR Manual's.
		ChartSites: []chartPackage{&vfrManual{
			label: "ANS CR VFR Manual",
			s:     &eaip.Site{Base: "https://aim.rlp.cz/vfrmanual", Header: eaip.BrowserHeaders},
			lang:  "en",
		}},
	},
	{
		CC:          "sk",
		Label:       "LPS SR Slovakia",
		MinAirports: 4,
		Site: eaip.Site{
			Country: "LZ",
			// Slovakia's package has no eAIP/ level under html/.
			Family:    eaip.EurocontrolFlat,
			Base:      "https://aim.lps.sk/web/eAIP_SR",
			Templates: []string{"AIP_SR_EFF_{DD}{MON}{YYYY}"},
			// The portal's eAIP page links the package in force and the
			// next one ("AIP_SR_EFF_01OCT2026_amdt").
			Pointer: eaip.PagePointer("https://aim.lps.sk/web/index.php?fn=200&lng=en"),
			Lang:    "en-SK",
			Header:  eaip.BrowserHeaders,
		},
		Sections:        enrSections,
		NavaidSection:   navaidSection,
		ObstacleSection: obstacleSection,
		Layout:          IcaoTables,
		Spec:            eaip.ZoneSpec{Type: sectionType, IDPrefix: "SK", IcaoPrefix: "LZ"},
		FirIdent:        "LZBB",
		MinAirspaces:    20,
		MaxAirspaces:    2000,
		Note:            "cycle directories are named AIP_SR_EFF_<DDMONYYYY>",
	},
	{
		CC:          "ie",
		Label:       "AirNav Ireland",
		MinAirports: 15,
		Site: eaip.Site{
			Country: "EI",
			Family:  eaip.Eurocontrol,
			Base:    "https://www.airnav.ie",
			// AirNav files each package under a folder whose name no
			// template predicts: AIRAC_<MONTH>_<YEAR>/<ISO>-AIRAC in May and
			// June, AIRAC_<MONTH>_<YEAR>/<YY-MM-DD>-AIRAC in July and
			// August, and the newest one under a flat AIRAC/<ISO>-AIRAC,
			// from where it is MOVED once its successor arrives: September
			// sat there until October took the slot on 2026-09-24, then
			// reappeared as AIRAC_SEPT_2026/2026-09-03-AIRAC, the month in
			// no spelling it had used before. Templates chased that twice,
			// the first time shipping August as current for three weeks.
			// The AIM page links every package by its path, and is both
			// where to find them and the statement of which is in force.
			Index:  "https://www.airnav.ie/air-traffic-management/aeronautical-information-management",
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
		Note:          "packages are found from the links on AirNav's AIM page, their folders following no template",
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
		Sections:        plSections,
		NavaidSection:   navaidSection,
		ObstacleSection: obstacleSection,
		Register:        pansaRegister,
		Layout:          IcaoTables,
		Spec:            eaip.ZoneSpec{Type: sectionType, IDPrefix: "PL", IcaoPrefix: "EP"},
		FirIdent:        "EPWW",
		MinAirspaces:    20,
		MaxAirspaces:    2000,
		Consent: "PANSA's copyright rules allow AIS products only in unchanged form for " +
			"operational use by ICAO Annex 15 entities; anything else needs PANSA consent, " +
			"which is being asked",
		// The IFR eAIP carries the fifteen AD 2 aerodromes; the other 69,
		// and their visual operation charts, are AIP VFR's AD 4.
		ChartSites: []chartPackage{&eaipPackage{
			label: "PANSA AIP VFR",
			s: &eaip.Site{
				Family: eaip.IDS,
				Base:   "https://docs.pansa.pl/ais/eaipvfr",
				Index:  "https://docs.pansa.pl/ais/eaipvfr/default_offline_{ISO}.html",
				Lang:   "en-GB",
				Header: eaip.BrowserHeaders,
			},
			// Its GEN 0.1 is a contents page with no table; AD 1.1, the
			// aerodromes' grouping, is a section like any other.
			probe: "AD 1.1",
		}},
	},
	{
		CC:          "rs",
		Label:       "SMATSA Serbia and Montenegro",
		MinAirports: 6,
		// SMATSA's AIP carries Montenegro's two aerodromes beside Serbia's.
		AirportCountry: map[string]string{"LYPG": "ME", "LYTV": "ME"},
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
			// The start page SMATSA's own AIP page loads links exactly
			// the package in force.
			Pointer: eaip.PagePointer("https://smatsa.rs/upload/aip/published/start_page.html"),
			Lang:    "en-GB",
			Header:  eaip.BrowserHeaders,
		},
		Sections:        enrSections,
		NavaidSection:   navaidSection,
		ObstacleSection: obstacleSection,
		Layout:          IcaoTables,
		Spec:            eaip.ZoneSpec{Type: sectionType, IDPrefix: "RS", IcaoPrefix: "LY"},
		FirIdent:        "LYBA",
		MinAirspaces:    10,
		MaxAirspaces:    2000,
		Note:            "one package covers Serbia AND Montenegro, which share the Beograd FIR",
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
			// The AIP page lists every amendment folder by its date.
			Pointer: eaip.PagePointer("https://www.albcontrol.al/aip/"),
			Lang:    "en-GB",
			Header:  eaip.BrowserHeaders,
		},
		Sections:        enrSections,
		NavaidSection:   navaidSection,
		ObstacleSection: obstacleSection,
		Register:        albcontrolRegister,
		Layout:          IcaoTables,
		Spec:            eaip.ZoneSpec{Type: sectionType, IDPrefix: "AL", IcaoPrefix: "LA"},
		FirIdent:        "LAAA",
		MinAirspaces:    5,
		MaxAirspaces:    2000,
		Consent: "GEN 0.1 reserves all rights and forbids reproducing, storing or " +
			"transmitting any part of the publication without ALBCONTROL's prior " +
			"written permission",
	},
	{
		CC:          "xk",
		Label:       "KANS Kosovo",
		MinAirports: 1,
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
		Sections: enrSections,
		// No NavaidSection: Kosovo's ENR 4.1 is published and reads NIL.
		// KANS states no en-route radio navigation aid at all, so asking
		// for the section every cycle only earns a sanity-window failure
		// on a count of zero, and an artefact that can never be written.
		Layout: IcaoTables,
		Spec:   eaip.ZoneSpec{Type: sectionType, IDPrefix: "XK", IcaoPrefix: "BK"},
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
			// date. The template finds the package; the JSON says which one
			// is in force, which is what tells a cycle BHANSA did not amend
			// (2026-09-03) from a package that moved.
			Templates: []string{"{ISO}-AIRAC"},
			Pointer:   eaip.IssueListPointer("https://eaip.bhansa.gov.ba/updates.json"),
			Lang:      "en-GB",
			Header:    eaip.BrowserHeaders,
		},
		Sections:        enrSections,
		NavaidSection:   navaidSection,
		ObstacleSection: obstacleSection,
		Layout:          IcaoTables,
		Spec:            eaip.ZoneSpec{Type: sectionType, IDPrefix: "BA", IcaoPrefix: "LQ"},
		FirIdent:        "LQSB",
		MinAirspaces:    10,
		MaxAirspaces:    2000,
		Consent: "GEN 0.1 reserves all rights and forbids reproducing any part of the " +
			"AIP, or storing it in a database of any kind, without BHANSA's prior " +
			"written permission",
		Note: "publishes its issue list as updates.json, the only machine-readable issue list in the cohort",
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
		Sections:        enrSections,
		NavaidSection:   navaidSection,
		ObstacleSection: obstacleSection,
		Layout:          IcaoTables,
		Spec:            eaip.ZoneSpec{Type: sectionType, IDPrefix: "SI", IcaoPrefix: "LJ"},
		FirIdent:        "LJLA",
		MinAirspaces:    10,
		MaxAirspaces:    2000,
		Consent: "GEN 0.1 does not allow change, reproduction or distribution without " +
			"Slovenia Control's permission",
		Note: "the server presents the wrong TLS intermediate; the real one is " +
			"embedded (see rapidSSLG1) exactly as a browser would fetch it",
	},
	// The States the survey of 2026-09-24 added (docs/aip-sources.md):
	// Finland and Iceland ship, Estonia, Latvia and Norway are held.
	{
		CC:          "fi",
		Label:       "Fintraffic ANS Finland",
		MinAirports: 30,
		Site: eaip.Site{
			Country: "EF",
			// IDS AIRNAV. The history page names each package by its date
			// ("06 AUG 2026_2026_08_06"), and Fintraffic issues one only
			// when the AIP changes, so a package a cycle old is often the
			// one in force, which the index confirms.
			Family: eaip.IDS,
			Base:   "https://www.ais.fi/eaip",
			Index:  "https://www.ais.fi/eaip/default_offline.html",
			Lang:   "en-GB",
			Header: eaip.BrowserHeaders,
		},
		Sections:      enrSections,
		NavaidSection: navaidSection,
		Layout:        IcaoTables,
		Spec:          eaip.ZoneSpec{Type: sectionType, Drop: finlandDrop, IDPrefix: "FI", IcaoPrefix: "EF"},
		FirIdent:      "EFIN",
		MinAirspaces:  20,
		MaxAirspaces:  2000,
		Note:          "GEN 0.1 allows further refining without a fee or agreement; the obstacles are cmd/fi's",
	},
	{
		CC:          "is",
		Label:       "Avians Iceland",
		MinAirports: 40,
		Site: eaip.Site{
			Country: "BI",
			// IDS AIRNAV, moved from eaip.isavia.is to eaip.avians.is in
			// September 2026. The history page still links the packages
			// on the old host ("A_08-2026_2026_09_03"), which redirects.
			Family:  eaip.IDS,
			Base:    "https://eaip.avians.is",
			Index:   "https://eaip.avians.is/",
			Lang:    "en-GB",
			Header:  eaip.BrowserHeaders,
			ExtraCA: goDaddyChain,
		},
		Sections:        enrSections,
		NavaidSection:   navaidSection,
		ObstacleSection: obstacleSection,
		Layout:          IcaoTables,
		Spec: eaip.ZoneSpec{Type: icelandType, IDPrefix: "IS", IcaoPrefix: "BI",
			// Every statement is printed in Icelandic, bold, then in
			// English.
			Bilingual: true},
		FirIdent:     "BIRD",
		MinAirspaces: 5,
		MaxAirspaces: 2000,
		Note:         "GEN 0.1.5: non-commercial use only, which Loxodrome's use is",
	},
	{
		CC:    "ee",
		Label: "EANS Estonia",
		Site: eaip.Site{
			Country:   "EE",
			Family:    eaip.Eurocontrol,
			Base:      "https://eaip.eans.ee",
			Templates: []string{"{ISO}"},
			// The root redirects to the package in force, which is what
			// confirms a cycle EANS did not amend (2026-09-03).
			Pointer: eaip.RedirectPointer("https://eaip.eans.ee/"),
			Lang:    "en-GB",
			Header:  eaip.BrowserHeaders,
		},
		Sections:        enrSections,
		NavaidSection:   navaidSection,
		ObstacleSection: obstacleSection,
		Register:        eansRegister,
		Layout:          IcaoTables,
		Spec:            eaip.ZoneSpec{Type: sectionType, IDPrefix: "EE", IcaoPrefix: "EE"},
		FirIdent:        "EETT",
		MinAirspaces:    5,
		MaxAirspaces:    2000,
		Consent: "GEN 0.1 forbids reproducing, storing or transmitting any part of the " +
			"publication without EANS's prior written permission",
	},
	{
		CC:    "lv",
		Label: "LGS Latvia",
		Site: eaip.Site{
			Country: "EV",
			Family:  eaip.Eurocontrol,
			Base:    "https://ais.lgs.lv",
			// The index links each issue by its path, the effective date
			// its last segment ("eAIPfiles/2026_006_03-SEP-2026/data/
			// 2026-09-03"); the issue number is not derivable.
			Index:  "https://ais.lgs.lv/aiseaip",
			Lang:   "en-GB",
			Header: eaip.BrowserHeaders,
		},
		Sections:        enrSections,
		NavaidSection:   navaidSection,
		ObstacleSection: obstacleSection,
		Layout:          IcaoTables,
		Spec:            eaip.ZoneSpec{Type: sectionType, IDPrefix: "LV", IcaoPrefix: "EV"},
		FirIdent:        "EVRR",
		MinAirspaces:    5,
		MaxAirspaces:    2000,
		Consent: "GEN 0.1 states no copyright policy, but GEN 3.1 calls the public eAIP " +
			"view-only; held until LGS says whether that restricts re-use",
	},
	{
		CC:    "no",
		Label: "Avinor Norway",
		Site: eaip.Site{
			Country: "EN",
			Family:  eaip.Eurocontrol,
			// The base carries an edition number (/View/Index/155) the
			// root's redirect names.
			BaseFrom: "https://aim-prod.avinor.no/no/AIP/",
			Lang:     "en-GB",
			Header:   eaip.BrowserHeaders,
		},
		Sections:        enrSections,
		NavaidSection:   navaidSection,
		ObstacleSection: obstacleSection,
		Register:        avinorRegister,
		Layout:          IcaoTables,
		Spec:            eaip.ZoneSpec{Type: sectionType, IDPrefix: "NO", IcaoPrefix: "EN"},
		FirIdent:        "ENOR",
		MinAirspaces:    20,
		MaxAirspaces:    3000,
		Consent: "GEN 0.1 makes any use outside copyright law inadmissible without " +
			"Avinor's permission",
		Note: "the only package with the structured-data tags beside the UK's and Czechia's; " +
			"future editions are sold by subscription",
	},
	// Charts only: the package's aerodrome pages, the airspace being
	// cmd/se's and cmd/nl's.
	{
		CC:    "se",
		Label: "LFV Sweden",
		Site: eaip.Site{
			Country: "ES",
			Family:  eaip.IDS,
			Base:    "https://aro.lfv.se/content/eaip",
			Index:   "https://aro.lfv.se/content/eaip/default_offline.html",
			Lang:    "en-GB",
			Header:  eaip.BrowserHeaders,
		},
		Sections:   []string{"ENR 2.1"},
		ChartsOnly: true,
		Note:       "chart links only; Sweden's airspace is cmd/se's, from LFV's CC BY WFS",
	},
	{
		CC:    "nl",
		Label: "LVNL Netherlands",
		Site: eaip.Site{
			Country: "EH",
			Family:  eaip.IDS,
			Base:    "https://eaip.lvnl.nl/web/eaip",
			Index:   "https://eaip.lvnl.nl/web/eaip/default_offline.html",
			Lang:    "en-GB",
			Header:  eaip.BrowserHeaders,
		},
		Sections:   []string{"ENR 2.1"},
		ChartsOnly: true,
		Note:       "chart links only; the Netherlands' airspace is cmd/nl's, from LVNL's CC BY ArcGIS",
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
