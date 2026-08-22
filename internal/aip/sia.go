// sia.go holds the SIA URL templates and the Atlas VAC vocabulary shared by
// the commands that read the French eAIP tree: cmd/adcharts, which records
// which idents have a plate, and cmd/aipdocs, which fetches those plates
// into an offline pack. Both have to spell the same paths, and a second
// copy of a template whose dated segments rotate every 28 days is a copy
// that will eventually disagree with the first.
//
// The SPA builds the same URLs at render time in src/lib/data/airports.ts
// (siaEaipHtmlBase, siaAtlasVacUrl); keep the three in step.

package aip

import (
	"fmt"
	"strings"
	"time"
)

// SIAHost is the SIA web site, the origin of every template below.
const SIAHost = "https://www.sia.aviation-civile.gouv.fr"

// SIAEAIPHTMLBase returns the html/eAIP/ directory (trailing slash) of the
// SIA eAIP tree for one AIRAC effective date.
func SIAEAIPHTMLBase(effective time.Time) string {
	return fmt.Sprintf("%s/media/dvd/eAIP_%s/FRANCE/AIRAC-%s/html/eAIP/",
		SIAHost, EAIPDateSegment(effective), AiracISO(effective))
}

// SIAAtlasVACBase returns the Atlas VAC directory (trailing slash) for one
// AIRAC effective date. It is a SIBLING of the eAIP tree, one level above
// FRANCE/AIRAC-<iso>/, and holds the visual approach plates the eAIP does
// not publish.
func SIAAtlasVACBase(effective time.Time) string {
	return fmt.Sprintf("%s/media/dvd/eAIP_%s/Atlas-VAC/",
		SIAHost, EAIPDateSegment(effective))
}

// The Atlas VAC index files, one per product, listing the codes each
// actually carries. Membership is data, not a guess: a code in the list
// resolves, one outside it 404s.
const (
	SIAVacIndexJS  = "Javascript/AeroArraysVac.js"  // aerodromes, product VAC
	SIAVacHIndexJS = "Javascript/AeroArraysVach.js" // helistations, product VACH
)

// VacKind is the Atlas VAC membership stored per ident in fr-adcharts.json:
// which product (or both) publishes a plate for it. Empty when neither
// does. Mirrored by VacAtlas in src/lib/data/airports.ts.
type VacKind = string

const (
	VacNone VacKind = ""
	VacAD   VacKind = "ad"
	VacHel  VacKind = "hel"
	VacBoth VacKind = "both"
)

// SIAVacSections lists the Atlas VAC sections one membership token covers:
// section 2 is the aerodrome product, section 3 the helistation one, and
// "both" means the ident has a plate in each.
func SIAVacSections(kind VacKind) []int {
	switch kind {
	case VacAD:
		return []int{2}
	case VacHel:
		return []int{3}
	case VacBoth:
		return []int{2, 3}
	default:
		return nil
	}
}

// SIAVacPlateName is the file name of one Atlas VAC plate. The two products
// each spell their own path, which is why the directory is not simply the
// section number:
//
//	VAC  / AD / 2  aerodromes,   keyed by ICAO       (AD-2.LFPG.pdf)
//	VACH / AD / 3  helistations, keyed by SIA codeId (AD-3.LF075.pdf)
func SIAVacPlateName(code string, section int) string {
	return fmt.Sprintf("AD-%d.%s.pdf", section, strings.ToUpper(code))
}

// SIAVacPlateURL is the absolute URL of one plate for one AIRAC cycle.
// Mirrors siaAtlasVacUrl in src/lib/data/airports.ts.
func SIAVacPlateURL(effective time.Time, code string, section int) string {
	product := "VAC"
	if section == 3 {
		product = "VACH"
	}
	return fmt.Sprintf("%sPDF_AIPparSSection/%s/AD/%s",
		SIAAtlasVACBase(effective), product, SIAVacPlateName(code, section))
}
