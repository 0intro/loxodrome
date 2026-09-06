// coords.go: parse the eAIP's compact sexagesimal coordinates, vertical
// limits, published feet figures and radio frequencies into the aixm5
// vocabulary the shared builders consume.

package eaip

import (
	"math"
	"regexp"
	"strconv"
	"strings"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/aixm5"
)

// CoordPat is one "DDMMSS[.ss]N DDDMMSS[.ss]E" pair, the only coordinate
// form the Belgian data tables use.
const CoordPat = `(\d{6}(?:\.\d+)?[NS])\s*(\d{7}(?:\.\d+)?[EW])`

var CoordRe = regexp.MustCompile(CoordPat)

// ParsePair decodes the two CoordRe capture groups into rounded decimal
// degrees.
func ParsePair(latS, lonS string) (float64, float64, bool) {
	lat, ok1 := aip.ParseLat(latS)
	lon, ok2 := aip.ParseLon(lonS)
	if !ok1 || !ok2 {
		return 0, 0, false
	}
	return aip.Round5(lat), aip.Round5(lon), true
}

// FirstCoord returns the first coordinate pair in s.
func FirstCoord(s string) (float64, float64, bool) {
	m := CoordRe.FindStringSubmatch(NormSpace(s))
	if m == nil {
		return 0, 0, false
	}
	return ParsePair(m[1], m[2])
}

// SpacedCoordRe is the "46 10 29 N 013 39 58 E" form, the same DMS
// values with their degrees, minutes and seconds spaced apart. Slovenia
// writes every ENR 2 boundary this way, and the compact form beside it,
// so a reader that knows only the compact one loses most of the country.
var SpacedCoordRe = regexp.MustCompile(`\b(\d{2})\s(\d{2})\s(\d{2}(?:\.\d+)?)\s*([NS])\s+(\d{3})\s(\d{2})\s(\d{2}(?:\.\d+)?)\s*([EW])`)

// SpacedCoord parses one spaced-DMS pair from the text SpacedCoordRe
// matched.
func SpacedCoord(s string) ([2]float64, bool) {
	m := SpacedCoordRe.FindStringSubmatch(NormSpace(s))
	if m == nil {
		return [2]float64{}, false
	}
	lat, ok1 := aip.ParseLat(m[1] + m[2] + m[3] + m[4])
	lon, ok2 := aip.ParseLon(m[5] + m[6] + m[7] + m[8])
	if !ok1 || !ok2 {
		return [2]float64{}, false
	}
	return [2]float64{Round5(lat), Round5(lon)}, true
}

// ShortCoordRe is the minutes-only "5048N 00421E" form some prose sections
// use (ENR 5.3 weather-balloon sites).
var ShortCoordRe = regexp.MustCompile(`\b(\d{4})([NS])\s*(\d{5})([EW])`)

// ShortCoord parses the first minutes-only coordinate pair in s.
func ShortCoord(s string) ([2]float64, bool) {
	m := ShortCoordRe.FindStringSubmatch(NormSpace(s))
	if m == nil {
		return [2]float64{}, false
	}
	lat, ok1 := aip.ParseLat(m[1] + "00" + m[2])
	lon, ok2 := aip.ParseLon(m[3] + "00" + m[4])
	if !ok1 || !ok2 {
		return [2]float64{}, false
	}
	return [2]float64{aip.Round5(lat), aip.Round5(lon)}, true
}

var (
	flRe  = regexp.MustCompile(`^FL\s*(\d+)`)
	altRe = regexp.MustCompile(`^([\d ]+)\s*(FT|M)\b\s*(AMSL|MSL|AGL|ASFC|SFC|GND)?`)
)

// ParseVerticalPair splits an "upper / lower" cell into its two limits.
// Every eAIP prints the upper limit first.
//
// Three separators occur, and all three have to work or a State loses
// half its limits: an explicit slash ("FL 195 / GND"), a line break
// ("2000FT AMSL" then "GND", which is how Portugal prints it), and a
// bare run of spaces where the cell was flattened. The slash is tried
// first; failing that the text is cut where the SECOND limit starts,
// found by scanning for a token that begins a limit.
func ParseVerticalPair(s string) (upper, lower *aixm5.VerticalLimit) {
	if parts := strings.SplitN(s, "/", 2); len(parts) == 2 {
		return ParseVLimit(parts[0]), ParseVLimit(parts[1])
	}
	if a, b, ok := splitTwoLimits(s); ok {
		return ParseVLimit(a), ParseVLimit(b)
	}
	return ParseVLimit(s), nil
}

// limitStartRe matches a token that can only begin a vertical limit.
var limitStartRe = regexp.MustCompile(`(?i)\b(FL\s*\d+|UNL|UNLIMITED|GND|GROUND|SFC|MSL|\d[\d ]*\s*(?:FT|M)\b)`)

// splitTwoLimits cuts a cell that carries both limits with no slash
// between them, at the start of the second one.
func splitTwoLimits(s string) (string, string, bool) {
	t := NormSpace(s)
	locs := limitStartRe.FindAllStringIndex(t, -1)
	if len(locs) < 2 {
		return "", "", false
	}
	// The second match starts the lower limit; everything before it,
	// including any reference word the upper limit carried, is the upper.
	cut := locs[1][0]
	upper := strings.TrimSpace(t[:cut])
	lower := strings.TrimSpace(t[cut:])
	if upper == "" || lower == "" {
		return "", "", false
	}
	return upper, lower, true
}

// ParseVLimit decodes one side of a vertical-limits cell. nil when the text
// carries no recognisable limit.
func ParseVLimit(s string) *aixm5.VerticalLimit {
	v := strings.TrimSpace(NormSpace(s))
	v = strings.TrimSuffix(v, ".")
	v = strings.TrimSpace(v)
	up := strings.ToUpper(v)
	switch up {
	case "":
		return nil
	case "UNL", "UNLIMITED":
		return &aixm5.VerticalLimit{Value: "UNL"}
	case "GND", "GROUND":
		return &aixm5.VerticalLimit{Value: "GND"}
	case "SFC", "SEA", "WATER":
		return &aixm5.VerticalLimit{Value: "SFC"}
	case "MSL":
		return &aixm5.VerticalLimit{Value: "0", Unit: "FT", Ref: "MSL"}
	}
	if m := flRe.FindStringSubmatch(up); m != nil {
		return &aixm5.VerticalLimit{Value: m[1], Unit: "FL", Ref: "STD"}
	}
	if m := altRe.FindStringSubmatch(up); m != nil {
		val := strings.ReplaceAll(strings.TrimSpace(m[1]), " ", "")
		if val == "" {
			return nil
		}
		ref := ""
		switch m[3] {
		case "AMSL", "MSL":
			ref = "MSL"
		case "AGL", "ASFC", "SFC", "GND":
			ref = "SFC"
		}
		return &aixm5.VerticalLimit{Value: val, Unit: m[2], Ref: ref}
	}
	return nil
}

var intGroupsRe = regexp.MustCompile(`\d[\d ]*`)

// ParseFtInt extracts the first integer figure from an eAIP feet cell
// ("1 534 FT / 24°C" -> 1534). The eAIP groups thousands with NBSP,
// normalized to plain spaces upstream.
func ParseFtInt(s string) (int, bool) {
	m := intGroupsRe.FindString(NormSpace(s))
	if m == "" {
		return 0, false
	}
	n, err := strconv.Atoi(strings.ReplaceAll(strings.TrimSpace(m), " ", ""))
	if err != nil {
		return 0, false
	}
	return n, true
}

const FtPerM = 0.3048

// FtToM converts a published feet figure to the aixm5 metre fields (the
// shared builders convert back to feet at emit; exact for integer feet).
func FtToM(ft float64) float64 { return ft * FtPerM }

var (
	MhzRe = regexp.MustCompile(`(\d{2,3}\.\d{1,3})\s*MHZ`)
	KhzRe = regexp.MustCompile(`(\d{3,4}(?:\.\d)?)\s*KHZ`)
	ChRe  = regexp.MustCompile(`\bCH\s*(\d{1,3}[XY])`)
	// The decimal separator is the publisher's: Slovakia and Poland
	// print "127,425 MHz".
	bareRadio = regexp.MustCompile(`\b\d{2,3}[.,]\d{1,3}\b`)
)

// FreqsComVHF returns the COM-band VHF frequencies printed in a cell. The
// AD 2.18 tables print most values bare ("135.205", "MHZ" only sometimes),
// and military aerodromes list UHF beside VHF; the airband filter
// (117.975-137 MHz) keeps exactly what the panels publish elsewhere.
func FreqsComVHF(s string) []string {
	var out []string
	for _, m := range bareRadio.FindAllString(NormSpace(s), -1) {
		m = strings.ReplaceAll(m, ",", ".")
		if v, err := strconv.ParseFloat(m, 64); err == nil && v >= 117.975 && v <= 137.0 {
			out = append(out, m)
		}
	}
	return out
}

// limitFt is a limit's comparable height in feet, for putting a pair the
// right way up. Rough on purpose: it decides which of two limits of ONE
// volume is the upper, never what either limit means (formatVLimit and
// the vertical core do that), so an AGL / AMSL difference cannot change
// the answer.
func limitFt(v *aixm5.VerticalLimit) (float64, bool) {
	if v == nil {
		return 0, false
	}
	switch strings.ToUpper(v.Value) {
	case "UNL":
		return math.Inf(1), true
	case "GND", "SFC":
		return math.Inf(-1), true
	}
	n, err := strconv.ParseFloat(strings.ReplaceAll(v.Value, " ", ""), 64)
	if err != nil {
		return 0, false
	}
	switch strings.ToUpper(v.Unit) {
	case "FL":
		return n * 100, true
	case "M":
		return n / FtPerM, true
	case "FT", "":
		return n, true
	}
	return 0, false
}

// maxFlightLevel and maxAltitudeFt bound a plausible published limit.
// Nothing in an AIP sits above FL 660 (UNL says the rest), so a value an
// order of magnitude past it is a parse failure rather than a limit.
const (
	maxFlightLevel = 700
	maxAltitudeFt  = 100000
)

// PlausibleLimit reports whether a parsed limit could be a published
// one. A nil limit is plausible: it is simply absent.
func PlausibleLimit(v *aixm5.VerticalLimit) bool {
	ft, ok := limitFt(v)
	if !ok {
		return true
	}
	if math.IsInf(ft, 0) {
		return true
	}
	if strings.EqualFold(v.Unit, "FL") {
		return ft/100 <= maxFlightLevel
	}
	return ft <= maxAltitudeFt
}

// OrderLimits puts a parsed pair the right way up, reporting whether it
// had to swap them.
//
// ICAO's ENR 2.1 prints the upper limit first and ParseVerticalPair
// assumes it, but AirNav Ireland prints the lower first: the Shannon FIR
// reads "SFC / FL 245". Taken on trust that files the FIR as ground on
// top and FL 245 at the bottom, and every comparison downstream is then
// backwards. Comparing the two heights costs nothing and cannot be
// fooled by a State changing convention.
func OrderLimits(upper, lower **aixm5.VerticalLimit) bool {
	u, uok := limitFt(*upper)
	l, lok := limitFt(*lower)
	if !uok || !lok || u >= l {
		return false
	}
	*upper, *lower = *lower, *upper
	return true
}

// atsCallSign trims an ENR 2.1 call-sign cell to the call sign itself.
// The column also carries the languages and the hours of service
// ("BUDAPEST CONTROL/RADAR EN H24"), which belong to WorkHr and to no
// radio row.
func atsCallSign(s string) string {
	s = NormSpace(strings.TrimSpace(s))
	if loc := callSignTailRe.FindStringIndex(s); loc != nil {
		s = s[:loc[0]]
	}
	return strings.TrimSpace(strings.Trim(s, "-,;("))
}

// callSignTailRe finds where the languages and hours start: a bracketed
// language list, a two-letter language code, or an hours token.
var callSignTailRe = regexp.MustCompile(`(?i)\s*(\(|\bEN\b|\bH24\b|\bHJ\b|\bHO\b|\bHX\b|\bSR\b|\d{4}\s*-\s*\d{4})`)

// RadioChannelsFrom pairs every COM-band frequency printed in a cell with
// the ATS unit and call sign printed beside it, which is how ICAO's
// ENR 2.1 publishes an airspace's radio: one unit, one call sign, and one
// to several frequencies ("127.500 MHz 124.700 MHz 119.075 MHz").
//
// The airband filter in FreqsComVHF is what keeps a military UHF channel
// out: Slovenia's cell reads "... 119.885 363.300 MHz/", and 363.300 is
// not a channel any civil aircraft can set.
func RadioChannelsFrom(freqCell, unitCell, callSignCell string) []aixm5.RadioChannel {
	freqs := FreqsComVHF(freqCell)
	if len(freqs) == 0 {
		return nil
	}
	unit := NormSpace(strings.TrimSpace(unitCell))
	call := atsCallSign(callSignCell)
	out := make([]aixm5.RadioChannel, 0, len(freqs))
	for _, f := range freqs {
		out = append(out, aixm5.RadioChannel{Freq: f, Unit: unit, CallSign: call})
	}
	return out
}
