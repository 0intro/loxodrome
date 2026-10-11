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
	// The DFS's apron control, a ground traffic control service.
	"SMGCS": "GND",
}

// airportServiceLabel curates one service into a display label. NATS models an
// aerodrome's air-ground radio as an "OTHER" service whose call sign ends in
// "RADIO"; everything else under OTHER (FIRE, RESCUE, MET, RADAR, BRIEFING,
// ...) is curated out.
func airportServiceLabel(serviceType, callSign string) (string, bool) {
	t := strings.ToUpper(strings.TrimSpace(serviceType))
	if label, ok := airportServiceTypeLabel[t]; ok {
		label = refineByCallSign(label, callSign)
		return label, label != ""
	}
	if t == "OTHER" || t == "OTHER:RADIO" {
		if fields := strings.Fields(strings.ToUpper(callSign)); len(fields) > 0 && fields[len(fields)-1] == "RADIO" {
			return "A/A", true
		}
	}
	return "", false
}

// refineByCallSign sharpens a TWR or GND label when the call sign names a
// surface position. NATS publishes those under a tower service type,
// distinguishing them only by call sign ("ALDERGROVE GROUND", "LUTON
// DELIVERY"): a ground or delivery position takes GND or DEL, an apron (the
// DFS's German VORFELD, and its numbered "MUENCHEN APRON 1") GND beside its
// own call sign, the surface position it is. The fire service and the
// de-icing coordination channel are curated out (the empty label), as the
// fire service is under an OTHER service: read as TWR or GND, their channel
// was offered as a position's to call. Other labels are returned unchanged.
func refineByCallSign(label, callSign string) string {
	if label != "TWR" && label != "GND" {
		return label
	}
	for _, w := range strings.Fields(strings.ToUpper(callSign)) {
		switch w {
		case "GROUND", "APRON", "VORFELD":
			return "GND"
		case "DELIVERY":
			return "DEL"
		case "FIRE", "DE-ICING", "DEICING":
			return ""
		}
	}
	return label
}

// CurateAirportRadios maps the raw airport RadioChannels (Unit = raw AIXM
// service type) to curated [freq, label, callSign] row triples for the airport
// JSON. Non-allowlisted services and blank frequencies are dropped and
// (freq, label) pairs de-duplicated. Returns a non-nil (possibly empty) slice
// so the JSON column is always an array.
//
// A channel several call signs answer on arrives with them joined by " / "
// (channelCallSign): Gatwick's tower service files its delivery and ground
// channels without saying which is which, so 121.955 and 121.805 each carry
// "GATWICK DELIVERY / GATWICK GROUND". Each position is curated on its own,
// so such a channel becomes a DEL row and a GND row under their own call
// signs, never a TWR row, and a part curated out (the fire service) goes
// alone. Parts landing on one label stay one row, joined as they came. Only
// the spaced separator splits: "KOELN/BONN TOWER" is one call sign.
func CurateAirportRadios(radios []RadioChannel) []any {
	out := []any{}
	seen := map[string]bool{}
	for _, r := range radios {
		freq := strings.TrimSpace(r.Freq)
		if freq == "" {
			continue
		}
		var labels []string
		calls := map[string][]string{}
		for _, part := range strings.Split(r.CallSign, " / ") {
			part = strings.TrimSpace(part)
			label, ok := airportServiceLabel(r.Unit, part)
			if !ok {
				continue
			}
			if _, dup := calls[label]; !dup {
				labels = append(labels, label)
			}
			calls[label] = append(calls[label], part)
		}
		for _, label := range labels {
			key := freq + "|" + label
			if seen[key] {
				continue
			}
			seen[key] = true
			out = append(out, []any{freq, label, strings.Join(calls[label], " / ")})
		}
	}
	return out
}
