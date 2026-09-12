// airportradio.go curates the raw airport RadioChannels (attached by
// resolveAirportRadios, with Unit = the raw AIXM 5.1 service type) into the
// [freq, label, call] row triples the airport JSON carries. The service-type
// vocabulary is the AIXM 5.1 standard shared by NATS UK and ENAIRE Spain, so
// both cmd/uk and cmd/es use this one mapping (France's AIXM 4.5 codeType
// vocabulary is curated separately in cmd/fr). Canonical labels match the
// OurAirports (cmd/airports) and FR (cmd/fr) sources so the SPA reads one
// vocabulary across publishers.

package aixm5

import "strings"

// airportServiceTypeLabel maps an AIXM 5.1 service type code to the canonical
// label shown in the airport panel. Codes not in the table are handled by
// airportServiceLabel (the "OTHER" air-ground case) or dropped (OTHER:MET,
// BRIEFING, fire/rescue, ...).
var airportServiceTypeLabel = map[string]string{
	"TWR":  "TWR",
	"APP":  "APP",
	"ACS":  "ACS",
	"ATIS": "ATIS",
	"AFIS": "AFIS",
	"FIS":  "FIS",
	"INFO": "INFO",
	"GND":  "GND",
	"DEL":  "DEL",
}

// airportServiceLabel curates one service into a display label. NATS models an
// aerodrome's air-ground radio as an "OTHER" service whose call sign ends in
// "RADIO"; everything else under OTHER (FIRE, RESCUE, MET, RADAR, BRIEFING,
// ...) is curated out.
func airportServiceLabel(serviceType, callSign string) (string, bool) {
	t := strings.ToUpper(strings.TrimSpace(serviceType))
	if label, ok := airportServiceTypeLabel[t]; ok {
		return refineByCallSign(label, callSign), true
	}
	if t == "OTHER" || t == "OTHER:RADIO" {
		if fields := strings.Fields(strings.ToUpper(callSign)); len(fields) > 0 && fields[len(fields)-1] == "RADIO" {
			return "A/A", true
		}
	}
	return "", false
}

// refineByCallSign sharpens a TWR label to GND / DEL when the call sign names a
// ground or delivery position. NATS publishes those under a tower service type,
// distinguishing them only by call sign ("ALDERGROVE GROUND", "LUTON
// DELIVERY"). Other labels are returned unchanged.
func refineByCallSign(label, callSign string) string {
	if label != "TWR" {
		return label
	}
	fields := strings.Fields(strings.ToUpper(callSign))
	if len(fields) == 0 {
		return label
	}
	switch fields[len(fields)-1] {
	case "GROUND":
		return "GND"
	case "DELIVERY":
		return "DEL"
	}
	return label
}

// CurateAirportRadios maps the raw airport RadioChannels (Unit = raw AIXM
// service type) to curated [freq, label, callSign] row triples for the airport
// JSON. Non-allowlisted services and blank frequencies are dropped and
// (freq, label) pairs de-duplicated. Returns a non-nil (possibly empty) slice
// so the JSON column is always an array.
func CurateAirportRadios(radios []RadioChannel) []any {
	out := []any{}
	seen := map[string]bool{}
	for _, r := range radios {
		freq := strings.TrimSpace(r.Freq)
		if freq == "" {
			continue
		}
		label, ok := airportServiceLabel(r.Unit, r.CallSign)
		if !ok {
			continue
		}
		key := freq + "|" + label
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, []any{freq, label, strings.TrimSpace(r.CallSign)})
	}
	return out
}
