// types.go is the type resolver the States reading ICAO-laid-out sections
// share: cmd/eaip's cohort, and cmd/ro over Romania's PDF sections.

package eaip

import (
	"regexp"
	"strings"
)

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

// SectionType is the type resolver every State in the cohort shares.
// The section says what family a table belongs to and the designator
// refines it, which is exactly how ICAO lays the AIP out.
func SectionType(section, designator, name string) string {
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
		case delegatedRe.MatchString(up):
			// Airspace one State's ATS provides over another's (Finland's
			// HALTI, EFDLG1 CTA, delegated to Norway), which the chart's
			// delegation comb draws. Before the FIR test, since the name
			// often cites the FIR it lies in.
			return "DLG-ATS"
		case infoZoneRe.MatchString(up):
			// A flight or traffic information zone or area: class G,
			// entered on the radio, which is a radio mandatory zone
			// whatever the State calls it (Finland's and Portugal's FIZ,
			// Norway's TIA, Sweden's TIZ and TIA). The State's word is
			// kept, the builder drawing it as the RMZ it is and the
			// panel naming it, as for the FIZ an AD 2.17 publishes.
			return infoZoneRe.FindString(up)
		case firWordRe.MatchString(up):
			// pruatlas carries every FIR, with the chart's arcs (black
			// between States, grey inside one) and under the ICAO
			// indicator NOTAM ownership keys on. The eAIP's own ring
			// would be a second boundary drawn over it without the arcs,
			// under a slug id that shadows nothing.
			return ""
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
		// A name that says none of it leaves the designator to: KANS's
		// "BKRMZ1", named only "Polygon-like shape defined by points", is a
		// radio mandatory zone and not a control area.
		if m := zoneDesignatorRe.FindStringSubmatch(strings.ToUpper(strings.TrimSpace(designator))); m != nil {
			return m[1]
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
		// A State may name the area by its kind and number with no ICAO
		// prefix to split a designator off: SMATSA's "TSA 02", "TRA 01 Lok".
		if m := tsaTraNameRe.FindStringSubmatch(strings.ToUpper(strings.TrimSpace(name))); m != nil {
			return m[1]
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

// zoneDesignatorRe is a designator naming the kind of zone it is, after
// the State's two-letter prefix: "BKRMZ2".
var zoneDesignatorRe = regexp.MustCompile(`^[A-Z]{2}(RMZ|TMZ)\d*[A-Z]?$`)

// tsaTraNameRe is an area named by its kind: "TSA 02".
var tsaTraNameRe = regexp.MustCompile(`^(TSA|TRA)\b`)

// firWordRe recognises a flight information or upper information region
// by its abbreviation, as a word: a "FIRING" range is not one.
var firWordRe = regexp.MustCompile(`\b(?:FIR|UIR)\b`)

// delegatedRe recognises a delegated area: a DLG designator ("EFDLG1") or
// the delegation named in words.
var delegatedRe = regexp.MustCompile(`\b(?:[A-Z]{2})?DLG\d*\b|\bDELEGAT`)

// infoZoneRe recognises a flight or traffic information zone or area.
var infoZoneRe = regexp.MustCompile(`\b(?:FIZ|TIZ|TIA)\b`)

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
