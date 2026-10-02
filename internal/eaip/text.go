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

// looseCoordRe is the compact pair with its hemisphere letters set apart,
// and whatever labels between: NAV Portugal's "LAT : 411408 N LONG :
// 0084041 W".
var looseCoordRe = regexp.MustCompile(`\b(\d{6}(?:\.\d+)?)\s?([NS])\b\D{0,20}?\b(\d{7}(?:\.\d+)?)\s?([EW])\b`)

// AnyCoord returns the first coordinate pair in s in any of the forms an
// aerodrome page writes its reference point: compact ("511122N
// 0042737E"), spaced ("53 38 15N 006 52 50W", "49 01 46 N 017 26 23 E") or
// compact with the hemispheres apart ("LAT : 411408 N LONG : 0084041 W").
// Last, a figure split by a stray space: AirNav's October 2026 package
// prints Sligo's as "54164 9 N 0083557 W", beside "19 2 ft" and "202 6" on
// the same page, and it reads once the digits are joined, which the
// hemisphere letters and the minute and second ranges still check.
func AnyCoord(s string) (float64, float64, bool) {
	if lat, lon, ok := FirstCoord(s); ok {
		return lat, lon, true
	}
	if c, ok := SpacedCoord(s); ok {
		return c[0], c[1], true
	}
	if m := looseCoordRe.FindStringSubmatch(NormSpace(s)); m != nil {
		return ParsePair(m[1]+m[2], m[3]+m[4])
	}
	if m := markedCoordRe.FindStringSubmatch(NormSpace(s)); m != nil {
		return ParsePair(dmsField(m[1], m[2], m[3], 2)+m[4], dmsField(m[5], m[6], m[7], 3)+m[8])
	}
	if joined := joinDigits(NormSpace(s)); joined != NormSpace(s) {
		if lat, lon, ok := FirstCoord(joined); ok {
			return lat, lon, true
		}
		if m := looseCoordRe.FindStringSubmatch(joined); m != nil {
			return ParsePair(m[1]+m[2], m[3]+m[4])
		}
	}
	return 0, 0, false
}

// markedCoordRe is the pair written with its degree, minute and second
// marks, the SIA's "49°00'35"N 002°32'52"E".
var markedCoordRe = regexp.MustCompile(`(\d{1,2})\s*°\s*(\d{1,2})\s*['’′]\s*(\d{1,2}(?:[.,]\d+)?)\s*(?:"|”|″|'')?\s*([NS])\W{0,6}?` +
	`(\d{1,3})\s*°\s*(\d{1,2})\s*['’′]\s*(\d{1,2}(?:[.,]\d+)?)\s*(?:"|”|″|'')?\s*([EW])`)

// dmsField writes degrees, minutes and seconds as the compact form's
// field, the degrees to the given width: "49", "0", "35" is "490035".
func dmsField(deg, min, sec string, width int) string {
	sec = strings.Replace(sec, ",", ".", 1)
	whole, frac, _ := strings.Cut(sec, ".")
	out := strings.Repeat("0", max(0, width-len(deg))) + deg +
		strings.Repeat("0", max(0, 2-len(min))) + min +
		strings.Repeat("0", max(0, 2-len(whole))) + whole
	if frac != "" {
		out += "." + frac
	}
	return out
}

// digitGapRe is a space between two digits.
var digitGapRe = regexp.MustCompile(`(\d) (\d)`)

// joinDigits closes every space between two digits.
func joinDigits(s string) string {
	for {
		t := digitGapRe.ReplaceAllString(s, "$1$2")
		if t == s {
			return s
		}
		s = t
	}
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
	// Avians writes a flight level "F660".
	flRe = regexp.MustCompile(`^FL?\s*(\d+)`)
	// ALT is ICAO's abbreviation for an altitude, above mean sea level:
	// NATS's "1000 FT ALT", SMATSA's "11500 FT ALT"; and an altitude on the
	// QNH is one too, ROMATSA's "2500 FT QNH".
	altRe = regexp.MustCompile(`^([\d ]+)\s*(FT|M)\b\s*(AMSL|MSL|ALT|QNH|AGL|ASFC|SFC|GND)?`)
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
//
// Two more forms are read before and after those. A pair whose limits are
// LABELLED says which is which ("Upper limit: 1000 FT ALT Lower limit:
// SFC", NATS's ENR 5.1, AirNav Ireland's ENR 5.5), and read positionally
// the labels break the pair. Only a cell OPENING with a label is read so:
// labels further on belong to a note on parts of the area (skeyes's TRA
// North Alpha, "FL 195 / 4500 FT AMSL ... (2) Upper limit FL 095 in area
// ... Lower limit FL 145 in ..."), and read as the pair they would mix
// two parts into one volume. And a pair SET BY NOTAM inside a stated
// envelope ("By NOTAM (Within FL 330 / FL 125)", SMATSA's TSA and TRA)
// reads as that envelope, the volume the AIP gives the area, wherever the
// cell yields no whole pair otherwise.
func ParseVerticalPair(s string) (upper, lower *aixm5.VerticalLimit) {
	if lead, up, lo, ok := splitLabelledLimits(s); ok && lead == "" {
		if up != "" && lo != "" {
			return firstLimit(up), firstLimit(lo)
		}
		if up == "" {
			// A lower label alone gives the floor, the ceiling published
			// elsewhere: Avinor's ENR 5.1 areas state "Lower limit: GND"
			// and leave the upper to the NOTAM activating them.
			return nil, firstLimit(lo)
		}
		// A single "Vertical limits:" label holds the pair.
		s = up
	}
	upper, lower = positionalPair(s)
	if upper == nil || lower == nil {
		if env, ok := notamEnvelope(s); ok {
			if u, l := positionalPair(env); u != nil && l != nil {
				return u, l
			}
		}
	}
	return upper, lower
}

// withinRe opens an envelope: "(Within FL 330 / FL 125)".
var withinRe = regexp.MustCompile(`(?i)\bwithin\b`)

// andRe joins two envelopes one cell gives a single area ("Within 5000 FT
// AMSL / GND and FL 125 / FL 195"), which is two bands and no one pair.
var andRe = regexp.MustCompile(`(?i)\band\b`)

// notamEnvelope returns the first envelope a cell states, up to its
// closing bracket or the next "Within": SMATSA gives an area and its
// flight-plan buffer zone one each in one bracket ("TSA 07 TANGO MNE:
// Within FL 380 / FL 200 TSA 07Z TANGO MNE: Within FL 395 / FL 200"), the
// area's own first.
func notamEnvelope(s string) (string, bool) {
	loc := withinRe.FindStringIndex(s)
	if loc == nil {
		return "", false
	}
	rest := s[loc[1]:]
	if i := strings.IndexByte(rest, ')'); i >= 0 {
		rest = rest[:i]
	}
	if next := withinRe.FindStringIndex(rest); next != nil {
		rest = rest[:next[0]]
	}
	if andRe.MatchString(rest) {
		return "", false
	}
	return rest, true
}

// positionalPair reads a pair by position: a slash, else the start of the
// second limit.
func positionalPair(s string) (upper, lower *aixm5.VerticalLimit) {
	if parts := strings.SplitN(s, "/", 2); len(parts) == 2 {
		return ParseVLimit(parts[0]), ParseVLimit(parts[1])
	}
	if a, b, ok := splitTwoLimits(s); ok {
		return ParseVLimit(a), ParseVLimit(b)
	}
	return ParseVLimit(s), nil
}

// heightRe is a limit token that is a height, which a reference may
// follow.
var heightRe = regexp.MustCompile(`(?i)^\d[\d ]*\s*(?:FT|M)$`)

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
	// The next match starts the lower limit; everything before it,
	// including any reference word the upper limit carried, is the upper.
	// A bare MSL is itself a limit (sea level), so one following a value
	// with nothing between is that value's reference: Fintraffic's "1300
	// FT MSL SFC".
	// Only after a height in feet or metres, and only the first: a flight
	// level takes no reference, so Portugal's "FL 500 MSL" is FL 500 over
	// sea level, and in "1000 FT MSL MSL" the second is the floor.
	isMSL := func(i int) bool { return strings.EqualFold(t[locs[i][0]:locs[i][1]], "MSL") }
	cut := -1
	for i := 1; i < len(locs); i++ {
		if isMSL(i) && heightRe.MatchString(t[locs[i-1][0]:locs[i-1][1]]) && strings.TrimSpace(t[locs[i-1][1]:locs[i][0]]) == "" {
			continue
		}
		cut = locs[i][0]
		break
	}
	if cut < 0 {
		return "", "", false
	}
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
	up := feetRe.ReplaceAllString(strings.ToUpper(v), "FT")
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
		case "AMSL", "MSL", "ALT", "QNH":
			ref = "MSL"
		case "AGL", "ASFC", "SFC", "GND":
			ref = "SFC"
		}
		return &aixm5.VerticalLimit{Value: val, Unit: m[2], Ref: ref}
	}
	return nil
}

// feetRe is the unit spelt out, as Avians writes it in English ("3000
// feet MSL") and in Icelandic ("7000 fet MSL") where a cell leads with the
// Icelandic half.
var feetRe = regexp.MustCompile(`\b(?:FEET|FOOT|FET)\b`)

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
	MhzRe = regexp.MustCompile(`\b(\d{2,3}\.\d{1,3})\s*MHZ`)
	KhzRe = regexp.MustCompile(`(\d{3,4}(?:\.\d)?)\s*KHZ`)
	ChRe  = regexp.MustCompile(`\bCH\s*(\d{1,3}[XY])`)
	// The decimal separator is the publisher's: Slovakia and Poland
	// print "127,425 MHz". The unit may follow with no space, NAV
	// Portugal's "122.555MHZ".
	bareRadio = regexp.MustCompile(`\b(\d{2,3}[.,]\d{1,3})(?:\b|(?i:MHZ))`)
)

// FreqsComVHF returns the COM-band VHF frequencies printed in a cell. The
// AD 2.18 tables print most values bare ("135.205", "MHZ" only sometimes),
// and military aerodromes list UHF beside VHF; the airband filter
// (117.975-137 MHz) keeps exactly what the panels publish elsewhere.
func FreqsComVHF(s string) []string {
	var out []string
	for _, sm := range bareRadio.FindAllStringSubmatch(NormSpace(s), -1) {
		m := strings.ReplaceAll(sm[1], ",", ".")
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

// atsCallSign reads the call sign out of ICAO's ENR 2.1 call-sign cell,
// which runs it into the languages, the conditions of use and the hours
// ("ŠTEFÁNIK RADAR SK, EN", "Pristina Approach ENG Mon -Sun: H24") and
// may give it in two languages, either way round ("BANJA LUKA APPROACH/
// BANJA LUKA PRILAZNA KONTROLA", "Reykjavík flugstjórn / Reykjavík
// Control", "IVALON TORNI IVALO TOWER").
//
// The call sign ends at the first service word of ICAO's English
// vocabulary, and starts after the last separator before it or, where the
// two languages share one run, at the place the unit is named after.
// Whatever does not read that way is no call sign, and the unit is what
// the panels print in its place.
func atsCallSign(cell, unit string) string {
	s := NormSpace(strings.TrimSpace(cell))
	loc := callSignServiceRe.FindStringIndex(s)
	if loc == nil {
		return ""
	}
	head := s[:loc[1]]
	if i := strings.LastIndexAny(head[:loc[0]], "/,;("); i >= 0 {
		head = head[i+1:]
	}
	head = strings.TrimSpace(head)
	fields := strings.Fields(head)
	if place := unitPlace(unit); place != "" {
		for i := len(fields) - 2; i >= 0; i-- {
			if strings.EqualFold(fields[i], place) {
				fields = fields[i:]
				break
			}
		}
	}
	// Fintraffic gives the Finnish call sign first, the place in the
	// genitive: "PIRKKALAN TUTKA PIRKKALA RADAR".
	if n := len(fields); n > 2 {
		place, first := strings.ToUpper(fields[n-2]), strings.ToUpper(fields[0])
		if len(first) > len(place) && strings.HasPrefix(first, place) {
			fields = fields[n-2:]
		}
	}
	// A name of more than a few words before the service is prose the
	// cell carried, not a call sign.
	if len(fields) < 2 || len(fields) > 5 {
		return ""
	}
	return strings.Join(fields, " ")
}

// callSignServiceRe matches the service word a call sign ends with.
var callSignServiceRe = regexp.MustCompile(`(?i)\b(?:APPROACH|APP|CONTROL|RADAR|TOWER|TWR|INFORMATION|INFO|RADIO|GROUND|DIRECTOR|TRAFFIC|DELIVERY|APRON|DEPARTURE|ARRIVAL|CENTRE|CENTER)\b`)

// unitPlace is the first word of a unit's name that is not an ATS
// abbreviation: "IVALO" of "IVALO ATS", "HELSINKI" of "HELSINKI-VANTAA
// ATS", "Dublin" of "ATS Dublin".
func unitPlace(unit string) string {
	for _, w := range strings.FieldsFunc(NormSpace(unit), func(r rune) bool {
		return r == ' ' || r == '-' || r == '/' || r == ',' || r == '(' || r == ')'
	}) {
		switch strings.ToUpper(w) {
		case "ATS", "ACC", "APP", "TWR", "OAC", "FIC", "AFIS", "ATSU", "UNIT", "AND", "OR":
			continue
		}
		return w
	}
	return ""
}

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
	call := atsCallSign(callSignCell, unitCell)
	out := make([]aixm5.RadioChannel, 0, len(freqs))
	for _, f := range freqs {
		out = append(out, aixm5.RadioChannel{Freq: f, Unit: unit, CallSign: call})
	}
	return out
}
