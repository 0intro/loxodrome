// dms.go parses DMS and decimal-degree coordinate strings into decimal
// degrees and rounds coordinates to a stable 5 decimal places.

package aip

import (
	"math"
	"strconv"
	"strings"
)

// ParseLat decodes a latitude in DMS, such as "470440.00N" or "470440N",
// or in decimal degrees, such as "46.16371667N": the SIA writes some of
// its coordinates so since its BMJ 02/2026, for consistency with the EAD
// (its Lisez_moi.txt).
func ParseLat(s string) (float64, bool) { return parseCoord(s, 2, "NS") }

// ParseLon decodes a longitude in DMS, such as "0020137.00E", or in
// decimal degrees, such as "005.99990561E".
func ParseLon(s string) (float64, bool) { return parseCoord(s, 3, "EW") }

// parseCoord decodes a degrees-minutes-seconds string, or a decimal-degrees
// one, whose point follows the degrees where a DMS one's follows the
// seconds. degDigits is 2 for latitude and 3 for longitude; hemis lists the
// valid trailing letters.
func parseCoord(s string, degDigits int, hemis string) (float64, bool) {
	s = strings.TrimSpace(s)
	if len(s) < degDigits+2 { // DD(D) + a point or MM + hemisphere
		return 0, false
	}
	hemi := s[len(s)-1]
	if !strings.ContainsRune(hemis, rune(hemi)) {
		return 0, false
	}
	body := s[:len(s)-1]
	var val float64
	if body[degDigits] == '.' {
		v, err := strconv.ParseFloat(body, 64)
		if err != nil || v < 0 {
			return 0, false
		}
		val = v
	} else {
		if len(body) < degDigits+4 { // DD(D) + MM + SS
			return 0, false
		}
		deg, err1 := strconv.ParseFloat(body[:degDigits], 64)
		min, err2 := strconv.ParseFloat(body[degDigits:degDigits+2], 64)
		sec, err3 := strconv.ParseFloat(body[degDigits+2:], 64)
		if err1 != nil || err2 != nil || err3 != nil {
			return 0, false
		}
		if deg < 0 || min < 0 || min >= 60 || sec < 0 || sec >= 60 {
			return 0, false
		}
		val = deg + min/60 + sec/3600
	}
	if hemi == 'S' || hemi == 'W' {
		val = -val
	}
	val = math.Round(val*1e7) / 1e7
	limit := 90.0
	if degDigits == 3 {
		limit = 180.0
	}
	if val < -limit || val > limit {
		return 0, false
	}
	return val, true
}

// Round5 rounds a coordinate to 5 decimal places (~1 m).
func Round5(x float64) float64 {
	return math.Round(x*1e5) / 1e5
}
