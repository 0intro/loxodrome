// family.go maps a UK chart title onto the chart-family codes the app
// already labels and orders (CHART_FAMILY_ORDER in
// src/lib/data/airports.ts, chartFamilies in the i18n catalogs). NATS
// titles are descriptive English, so the mapping is by keyword; anything
// unmatched becomes MISC (counted in the meta, so a new title style is
// visible cycle to cycle).

package main

import "strings"

// familyRule is one keyword test. Order matters: the first rule whose
// keyword the upper-cased title contains wins, so the more specific
// phrases come first.
type familyRule struct {
	keyword string
	code    string
}

var familyRules = []familyRule{
	// Coding tables / coding data are text data pages, whatever procedure
	// they annex (STAR coding tables, SBAS FAS data blocks).
	{"CODING", "DATA"},
	// An "AERODROME CHART ..." is the aerodrome chart family even when its
	// title mentions ground movement (the A380 / code E / F variants).
	{"AERODROME CHART", "ADC"},
	{"GROUND MOVEMENT", "GMC"},
	{"PARKING", "APDC"},
	{"DOCKING", "APDC"},
	{"SURVEILLANCE MINIMUM ALTITUDE", "ATCSMAC"},
	{"OBSTACLE", "AOC"},
	{"PRECISION APPROACH TERRAIN", "PATC"},
	{"INSTRUMENT APPROACH", "IAC"},
	{"INITIAL APPROACH", "IAC"},
	{"APPROACH TRANSITION", "IAC"},
	{"APPROACH CHART", "IAC"},
	{"STANDARD DEPARTURE", "SID"},
	{"STANDARD INSTRUMENT DEPARTURE", "SID"},
	{"(SID)", "SID"},
	{"STANDARD ARRIVAL", "STAR"},
	{"STANDARD INSTRUMENT ARRIVAL", "STAR"},
	{"(STAR)", "STAR"},
	{"VISUAL APPROACH", "VAC"},
	{"AREA CHART", "ARC"},
}

// chartFamily resolves one title to its family code, MISC when no rule
// matches (control-zone charts, noise-preferential routeings, local
// flying areas and the like).
func chartFamily(title string) string {
	u := strings.ToUpper(title)
	for _, r := range familyRules {
		if strings.Contains(u, r.keyword) {
			return r.code
		}
	}
	return "MISC"
}
