// countries.go is the country table: one row per places-<iso>.json, and
// the one source each file is read from.
//
// France and its five overseas départements come from IGN's ADMIN
// EXPRESS COG, which lists every commune; everything else comes from
// GeoNames, which lists towns. The GeoNames rows are the countries the app covers (its
// AIP publishers, the held States), their neighbours and the microstates
// between them, the French overseas collectivities and the US
// territories (docs/places.md).

package main

import "fmt"

// The two sources a file can be read from.
const (
	srcIGN      = "ign"
	srcGeoNames = "geonames"
)

// defaultMinPop is the GeoNames floor: a place with fewer people, and
// no seat of a division down to the third level, is not kept.
const defaultMinPop = 1000

// A country is one output file and the rules its rows are built by.
type country struct {
	iso    string // the file's code, places-<iso>.json: ISO 3166-1, lower case
	source string // srcIGN or srcGeoNames

	// depts are the départements whose communes the file holds, and
	// envelope the box every one of them lies in, [minLon, minLat,
	// maxLon, maxLat]: a chef-lieu outside it fails the build, which
	// is what a WFS answering [lat, lon] would do (IGN only).
	depts    []string
	envelope [4]float64

	// cc is the GeoNames country code of the file's rows and minPop the
	// population floor (GeoNames only).
	cc     string
	minPop int

	// display is the language a place is shown in when GeoNames' own
	// name for it is a foreign one (localName), "" keeping GeoNames'
	// name. adminDisplay overrides it by first-level division, for a
	// country whose regions speak different languages, "" keeping the
	// name there too. foreign lists the languages whose names mark
	// GeoNames' name as foreign, English and French when nil. alt is
	// the languages whose names a place is also found by (GeoNames
	// only).
	display      string
	adminDisplay map[string]string
	foreign      []string
	alt          []string

	// minRows and maxRows are the file's sanity window: a build that
	// counts fewer rows, or more (maxRows 0 is no ceiling), refuses to
	// write.
	minRows int
	maxRows int

	why string // why the country is in the table
}

// enFr are the alternate-name languages most countries search: the
// names a pilot writing in English or French types ("Munich", "Vienne").
var enFr = []string{"en", "fr"}

// belgium shows each region's places in its language. Brussels is
// bilingual, and shown in French, the language of most of its
// inhabitants and of the app's first audience.
var belgium = map[string]string{"BRU": "fr", "WAL": "fr", "VLG": "nl"}

// switzerland shows each canton's places in its language, German where
// the map does not say otherwise. The four bilingual or trilingual
// cantons keep GeoNames' names, which follow each town's own language.
var switzerland = map[string]string{
	"GE": "fr", "VD": "fr", "NE": "fr", "JU": "fr",
	"TI": "it",
	"BE": "", "FR": "", "VS": "", "GR": "",
}

// countries is the table. The minRows floors sit near half of what the
// 2026-10-18 build kept, so a source that loses most of a country fails
// the run rather than shipping a near-empty file.
var countries = []country{
	// IGN's ADMIN EXPRESS COG: every commune.
	{iso: "fr", source: srcIGN, depts: metropole(), envelope: [4]float64{-5.5, 41, 10, 51.5}, minRows: 34000, maxRows: 36000, why: "metropolitan France and Corsica"},
	{iso: "gp", source: srcIGN, depts: []string{"971"}, envelope: [4]float64{-62, 15.7, -60.9, 16.6}, minRows: 10, why: "Guadeloupe"},
	{iso: "mq", source: srcIGN, depts: []string{"972"}, envelope: [4]float64{-61.4, 14.3, -60.7, 15}, minRows: 10, why: "Martinique"},
	{iso: "gf", source: srcIGN, depts: []string{"973"}, envelope: [4]float64{-54.7, 2, -51.5, 6}, minRows: 10, why: "Guyane"},
	{iso: "re", source: srcIGN, depts: []string{"974"}, envelope: [4]float64{55.1, -21.5, 56, -20.7}, minRows: 10, why: "La Réunion"},
	{iso: "yt", source: srcIGN, depts: []string{"976"}, envelope: [4]float64{44.9, -13.1, 45.4, -12.5}, minRows: 10, why: "Mayotte"},

	// GeoNames: the AIP publishers the app reads.
	{iso: "gb", source: srcGeoNames, cc: "GB", minPop: defaultMinPop, alt: enFr, minRows: 2200, why: "publisher (cmd/uk)"},
	{iso: "ie", source: srcGeoNames, cc: "IE", minPop: defaultMinPop, display: "en", foreign: []string{"ga"}, alt: enFr, minRows: 170, why: "publisher (cmd/eaip, cmd/ie)"},
	{iso: "es", source: srcGeoNames, cc: "ES", minPop: defaultMinPop, alt: []string{"en", "fr", "es"}, minRows: 3400, why: "publisher (cmd/es)"},
	{iso: "be", source: srcGeoNames, cc: "BE", minPop: defaultMinPop, adminDisplay: belgium, alt: []string{"en", "fr", "nl", "de"}, minRows: 860, why: "publisher (cmd/be)"},
	{iso: "de", source: srcGeoNames, cc: "DE", minPop: defaultMinPop, display: "de", alt: enFr, minRows: 3600, why: "publisher (cmd/de)"},
	{iso: "at", source: srcGeoNames, cc: "AT", minPop: defaultMinPop, display: "de", alt: enFr, minRows: 1000, why: "publisher (cmd/at)"},
	{iso: "nl", source: srcGeoNames, cc: "NL", minPop: defaultMinPop, display: "nl", alt: enFr, minRows: 640, why: "publisher (cmd/nl)"},
	{iso: "ch", source: srcGeoNames, cc: "CH", minPop: defaultMinPop, display: "de", adminDisplay: switzerland, alt: []string{"en", "fr", "de", "it"}, minRows: 590, why: "publisher (cmd/ch)"},
	{iso: "it", source: srcGeoNames, cc: "IT", minPop: defaultMinPop, display: "it", alt: enFr, minRows: 4900, why: "publisher (cmd/it)"},
	{iso: "ro", source: srcGeoNames, cc: "RO", minPop: defaultMinPop, display: "ro", alt: enFr, minRows: 2200, why: "publisher (cmd/ro)"},
	{iso: "fi", source: srcGeoNames, cc: "FI", minPop: defaultMinPop, alt: []string{"en", "fr", "fi", "sv"}, minRows: 280, why: "publisher (cmd/eaip, cmd/fi)"},
	{iso: "se", source: srcGeoNames, cc: "SE", minPop: defaultMinPop, display: "sv", alt: enFr, minRows: 400, why: "publisher (cmd/se)"},
	{iso: "dk", source: srcGeoNames, cc: "DK", minPop: defaultMinPop, display: "da", alt: enFr, minRows: 210, why: "publisher (cmd/dk)"},
	{iso: "sk", source: srcGeoNames, cc: "SK", minPop: defaultMinPop, display: "sk", alt: enFr, minRows: 300, why: "publisher (cmd/eaip)"},
	{iso: "rs", source: srcGeoNames, cc: "RS", minPop: defaultMinPop, alt: enFr, minRows: 220, why: "publisher (cmd/eaip)"},
	{iso: "xk", source: srcGeoNames, cc: "XK", minPop: defaultMinPop, alt: []string{"en", "fr", "sq"}, minRows: 30, why: "publisher (cmd/eaip)"},
	{iso: "is", source: srcGeoNames, cc: "IS", minPop: defaultMinPop, alt: enFr, minRows: 17, why: "publisher (cmd/eaip)"},
	{iso: "ge", source: srcGeoNames, cc: "GE", minPop: defaultMinPop, alt: enFr, minRows: 85, why: "publisher (cmd/ge)"},
	{iso: "us", source: srcGeoNames, cc: "US", minPop: defaultMinPop, alt: enFr, minRows: 8300, why: "publisher (cmd/faa)"},

	// GeoNames: the States whose AIP the app builds and holds.
	{iso: "pt", source: srcGeoNames, cc: "PT", minPop: defaultMinPop, display: "pt", alt: enFr, minRows: 460, why: "held State (cmd/eaip)"},
	{iso: "pl", source: srcGeoNames, cc: "PL", minPop: defaultMinPop, display: "pl", alt: enFr, minRows: 1400, why: "held State (cmd/eaip)"},
	{iso: "cz", source: srcGeoNames, cc: "CZ", minPop: defaultMinPop, display: "cs", alt: enFr, minRows: 740, why: "held State (cmd/eaip)"},
	{iso: "hu", source: srcGeoNames, cc: "HU", minPop: defaultMinPop, display: "hu", alt: enFr, minRows: 480, why: "held State (cmd/eaip)"},
	{iso: "si", source: srcGeoNames, cc: "SI", minPop: defaultMinPop, display: "sl", alt: enFr, minRows: 150, why: "held State (cmd/eaip)"},
	{iso: "ba", source: srcGeoNames, cc: "BA", minPop: defaultMinPop, display: "bs", alt: enFr, minRows: 140, why: "held State (cmd/eaip)"},
	{iso: "al", source: srcGeoNames, cc: "AL", minPop: defaultMinPop, display: "sq", alt: enFr, minRows: 180, why: "held State (cmd/eaip)"},
	{iso: "ee", source: srcGeoNames, cc: "EE", minPop: defaultMinPop, display: "et", alt: enFr, minRows: 55, why: "held State (cmd/eaip)"},
	{iso: "lv", source: srcGeoNames, cc: "LV", minPop: defaultMinPop, display: "lv", alt: enFr, minRows: 60, why: "held State (cmd/eaip)"},
	{iso: "no", source: srcGeoNames, cc: "NO", minPop: defaultMinPop, display: "no", foreign: []string{"en", "fr", "se", "smj", "sma"}, alt: enFr, minRows: 260, why: "held State (cmd/eaip)"},
	{iso: "mk", source: srcGeoNames, cc: "MK", minPop: defaultMinPop, alt: enFr, minRows: 95, why: "held State (cmd/mk)"},

	// GeoNames: the neighbours and the microstates between them.
	{iso: "lu", source: srcGeoNames, cc: "LU", minPop: defaultMinPop, alt: []string{"en", "fr", "de", "lb"}, minRows: 70, why: "neighbour"},
	{iso: "mc", source: srcGeoNames, cc: "MC", minPop: defaultMinPop, display: "fr", alt: enFr, minRows: 1, why: "microstate"},
	{iso: "li", source: srcGeoNames, cc: "LI", minPop: defaultMinPop, display: "de", alt: enFr, minRows: 7, why: "microstate"},
	{iso: "ad", source: srcGeoNames, cc: "AD", minPop: defaultMinPop, display: "ca", alt: enFr, minRows: 7, why: "microstate"},
	{iso: "sm", source: srcGeoNames, cc: "SM", minPop: defaultMinPop, display: "it", alt: enFr, minRows: 7, why: "microstate"},
	{iso: "va", source: srcGeoNames, cc: "VA", minPop: defaultMinPop, display: "it", alt: enFr, minRows: 1, why: "microstate"},
	{iso: "hr", source: srcGeoNames, cc: "HR", minPop: defaultMinPop, display: "hr", alt: enFr, minRows: 370, why: "neighbour"},
	{iso: "me", source: srcGeoNames, cc: "ME", minPop: defaultMinPop, alt: enFr, minRows: 20, why: "neighbour"},
	{iso: "gr", source: srcGeoNames, cc: "GR", minPop: defaultMinPop, alt: enFr, minRows: 560, why: "neighbour"},
	{iso: "bg", source: srcGeoNames, cc: "BG", minPop: defaultMinPop, alt: enFr, minRows: 150, why: "neighbour"},
	{iso: "lt", source: srcGeoNames, cc: "LT", minPop: defaultMinPop, display: "lt", alt: enFr, minRows: 55, why: "neighbour"},
	{iso: "mt", source: srcGeoNames, cc: "MT", minPop: defaultMinPop, alt: enFr, minRows: 30, why: "neighbour"},
	{iso: "cy", source: srcGeoNames, cc: "CY", minPop: defaultMinPop, alt: enFr, minRows: 50, why: "neighbour"},
	{iso: "gi", source: srcGeoNames, cc: "GI", minPop: defaultMinPop, alt: enFr, minRows: 1, why: "neighbour"},
	{iso: "im", source: srcGeoNames, cc: "IM", minPop: defaultMinPop, alt: enFr, minRows: 10, why: "neighbour"},
	{iso: "je", source: srcGeoNames, cc: "JE", minPop: defaultMinPop, alt: enFr, minRows: 3, why: "neighbour"},
	{iso: "gg", source: srcGeoNames, cc: "GG", minPop: defaultMinPop, alt: enFr, minRows: 5, why: "neighbour"},
	{iso: "fo", source: srcGeoNames, cc: "FO", minPop: defaultMinPop, alt: []string{"en", "fr", "da"}, minRows: 13, why: "neighbour"},
	{iso: "ax", source: srcGeoNames, cc: "AX", minPop: defaultMinPop, display: "sv", alt: enFr, minRows: 10, why: "neighbour"},
	{iso: "md", source: srcGeoNames, cc: "MD", minPop: defaultMinPop, display: "ro", alt: enFr, minRows: 45, why: "neighbour"},

	// GeoNames: the French overseas collectivities, every place it lists.
	{iso: "pm", source: srcGeoNames, cc: "PM", alt: enFr, minRows: 1, why: "French overseas collectivity"},
	{iso: "bl", source: srcGeoNames, cc: "BL", alt: enFr, minRows: 1, why: "French overseas collectivity"},
	{iso: "mf", source: srcGeoNames, cc: "MF", alt: enFr, minRows: 4, why: "French overseas collectivity"},
	{iso: "wf", source: srcGeoNames, cc: "WF", alt: enFr, minRows: 4, why: "French overseas collectivity"},
	{iso: "pf", source: srcGeoNames, cc: "PF", alt: enFr, minRows: 20, why: "French overseas collectivity"},
	{iso: "nc", source: srcGeoNames, cc: "NC", alt: enFr, minRows: 16, why: "French overseas collectivity"},

	// GeoNames: the US territories cmd/faa's data reaches.
	{iso: "pr", source: srcGeoNames, cc: "PR", minPop: defaultMinPop, alt: enFr, minRows: 110, why: "US territory"},
	{iso: "vi", source: srcGeoNames, cc: "VI", minPop: defaultMinPop, alt: enFr, minRows: 3, why: "US territory"},
	{iso: "gu", source: srcGeoNames, cc: "GU", minPop: defaultMinPop, alt: enFr, minRows: 12, why: "US territory"},
	{iso: "as", source: srcGeoNames, cc: "AS", minPop: defaultMinPop, alt: enFr, minRows: 8, why: "US territory"},
	{iso: "mp", source: srcGeoNames, cc: "MP", minPop: defaultMinPop, alt: enFr, minRows: 3, why: "US territory"},
}

// collectivities are the codes of the overseas collectivities, whose
// communes are not written: the table reads those collectivities from
// GeoNames, which lists their towns where the communes are a handful,
// some of them whole islands. The TAAF districts and Clipperton are in no
// file. A commune of any other département the table does not hold fails
// the build.
var collectivities = map[string]bool{
	"975": true, // Saint-Pierre-et-Miquelon: pm
	"977": true, // Saint-Barthélemy: bl
	"978": true, // Saint-Martin: mf
	"984": true, // Terres australes et antarctiques françaises
	"986": true, // Wallis-et-Futuna: wf
	"987": true, // French Polynesia: pf
	"988": true, // New Caledonia: nc
	"989": true, // Clipperton
}

// geoNamesFromIGN are the GeoNames country codes whose rows are left out
// because IGN already lists every commune there.
var geoNamesFromIGN = map[string]bool{
	"FR": true, "GP": true, "MQ": true, "GF": true, "RE": true, "YT": true,
}

// metropole lists the metropolitan départements: 01 to 95 without 20,
// which Corsica's 2A and 2B replaced.
func metropole() []string {
	var out []string
	for n := 1; n <= 95; n++ {
		if n == 20 {
			continue
		}
		out = append(out, fmt.Sprintf("%02d", n))
	}
	return append(out, "2A", "2B")
}

// displayIn is the display language of the country's places in the
// first-level division admin1.
func (c country) displayIn(admin1 string) string {
	if lang, ok := c.adminDisplay[admin1]; ok {
		return lang
	}
	return c.display
}

// foreignLanguages are the languages whose names mark GeoNames' own name
// for a place as foreign.
func (c country) foreignLanguages() []string {
	if c.foreign == nil {
		return enFr
	}
	return c.foreign
}

// languages are every language the country's alternate names are read
// in.
func (c country) languages() map[string]bool {
	out := map[string]bool{}
	for _, l := range append(append([]string{c.display}, c.foreignLanguages()...), c.alt...) {
		if l != "" {
			out[l] = true
		}
	}
	for _, l := range c.adminDisplay {
		if l != "" {
			out[l] = true
		}
	}
	return out
}

// inEnvelope reports whether lat, lon lies in the country's envelope,
// which a country without one always does.
func (c country) inEnvelope(lat, lon float64) bool {
	if c.envelope == [4]float64{} {
		return true
	}
	e := c.envelope
	return lon >= e[0] && lat >= e[1] && lon <= e[2] && lat <= e[3]
}
