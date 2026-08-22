// service.go decodes the AIXM 5.1 service tree that publishers use
// to link airspace volumes to radio frequencies. The chain is:
//
//   AirTrafficControlService (or InformationService /
//   AirTrafficManagementService) ─clientAirspace─▶ Airspace
//                              │
//                              └─radioCommunication─▶
//                                  RadioCommunicationChannel
//                                  (frequencyTransmission / mode)
//
// The same three service kinds + RCC structure is used by NATS UK
// and ENAIRE Spain alike. France's SIA AIXM 4.5 uses an entirely
// different shape; this file is AIXM-5.1-only.

package aixm5

import (
	"encoding/xml"
	"strings"
)

// xmlServiceFeature is a generic shape for the three service types
// we care about. The TimeSlices field is decoded under whichever of
// three sibling element names the input uses (encoding/xml's
// namespace-blind matching picks the right slice).
type xmlServiceFeature struct {
	GMLID      string            `xml:"id,attr"`
	Identifier string            `xml:"identifier"`
	ATCSlices  []xmlServiceSlice `xml:"timeSlice>AirTrafficControlServiceTimeSlice"`
	InfoSlices []xmlServiceSlice `xml:"timeSlice>InformationServiceTimeSlice"`
	ATMSlices  []xmlServiceSlice `xml:"timeSlice>AirTrafficManagementServiceTimeSlice"`
}

type xmlServiceSlice struct {
	Interpretation     string              `xml:"interpretation"`
	CallsignDetails    []xmlCallsignDetail `xml:"call-sign>CallsignDetail"`
	RadioCommunication xmlHref             `xml:"radioCommunication"`
	ClientAirspaces    []xmlHref           `xml:"clientAirspace"`
	ClientAirports     []xmlHref           `xml:"clientAirport"`
	Type               string              `xml:"type"`
}

type xmlCallsignDetail struct {
	CallSign string `xml:"callSign"`
	Language string `xml:"language"`
}

// rawService is the post-decode shape of one Service timeslice; the
// resolution pass walks rawServices, looks up each radioCommunication
// xlink in rcc index, and folds the resulting (freq, unit, callsign)
// triple into every clientAirspace and clientAirport.
type rawService struct {
	serviceType     string
	callSign        string
	radioCommUUID   string
	clientAirspaces []string
	clientAirports  []string
}

// rawRcc is the post-decode shape of one RadioCommunicationChannel
// timeslice.
type rawRcc struct {
	id   string
	freq string
}

// rawServices accumulates undispatched service + RCC records.
type rawServices struct {
	services []rawService
	rccs     []rawRcc
}

// decodeAirTrafficControlServiceFeature, decodeInformationServiceFeature,
// decodeAirTrafficManagementServiceFeature: share the generic
// xmlServiceFeature struct; each picks the matching TimeSlice slice
// at decode time.
func decodeAirTrafficControlServiceFeature(dec *xml.Decoder, start *xml.StartElement, msg *Message, raw *rawServices) error {
	return decodeService(dec, start, msg, raw, kindATC)
}

func decodeInformationServiceFeature(dec *xml.Decoder, start *xml.StartElement, msg *Message, raw *rawServices) error {
	return decodeService(dec, start, msg, raw, kindInfo)
}

func decodeAirTrafficManagementServiceFeature(dec *xml.Decoder, start *xml.StartElement, msg *Message, raw *rawServices) error {
	return decodeService(dec, start, msg, raw, kindATM)
}

type serviceKind int

const (
	kindATC serviceKind = iota
	kindInfo
	kindATM
)

func decodeService(dec *xml.Decoder, start *xml.StartElement, msg *Message, raw *rawServices, kind serviceKind) error {
	var f xmlServiceFeature
	if err := dec.DecodeElement(&f, start); err != nil {
		return err
	}
	var slices []xmlServiceSlice
	switch kind {
	case kindATC:
		slices = f.ATCSlices
	case kindInfo:
		slices = f.InfoSlices
	case kindATM:
		slices = f.ATMSlices
	}
	for i := range slices {
		s := &slices[i]
		if !strings.EqualFold(strings.TrimSpace(s.Interpretation), "BASELINE") {
			msg.SkippedNonBaseline++
			continue
		}
		r := rawService{
			serviceType:   strings.TrimSpace(s.Type),
			callSign:      pickCallSign(s.CallsignDetails),
			radioCommUUID: uuidFromHref(s.RadioCommunication.Href),
		}
		for _, h := range s.ClientAirspaces {
			if id := uuidFromHref(h.Href); id != "" {
				r.clientAirspaces = append(r.clientAirspaces, id)
			}
		}
		for _, h := range s.ClientAirports {
			if id := uuidFromHref(h.Href); id != "" {
				r.clientAirports = append(r.clientAirports, id)
			}
		}
		raw.services = append(raw.services, r)
	}
	return nil
}

// pickCallSign returns the English call sign when available, then
// any other language, then empty.
func pickCallSign(cds []xmlCallsignDetail) string {
	var en, any string
	for _, c := range cds {
		v := strings.TrimSpace(c.CallSign)
		if v == "" {
			continue
		}
		if any == "" {
			any = v
		}
		if strings.EqualFold(strings.TrimSpace(c.Language), "eng") && en == "" {
			en = v
		}
	}
	if en != "" {
		return en
	}
	return any
}

// xmlRadioCommunicationChannel mirrors aixm:RadioCommunicationChannel.
// Only frequency-related fields matter for the SPA's radio column.
type xmlRadioCommunicationChannel struct {
	GMLID      string        `xml:"id,attr"`
	Identifier string        `xml:"identifier"`
	TimeSlices []xmlRccSlice `xml:"timeSlice>RadioCommunicationChannelTimeSlice"`
}

type xmlRccSlice struct {
	Interpretation        string       `xml:"interpretation"`
	FrequencyTransmission *xmlUOMValue `xml:"frequencyTransmission"`
	Channel               string       `xml:"channel"`
}

func decodeRadioCommunicationChannelFeature(dec *xml.Decoder, start *xml.StartElement, msg *Message, raw *rawServices) error {
	var f xmlRadioCommunicationChannel
	if err := dec.DecodeElement(&f, start); err != nil {
		return err
	}
	for i := range f.TimeSlices {
		s := &f.TimeSlices[i]
		if !strings.EqualFold(strings.TrimSpace(s.Interpretation), "BASELINE") {
			msg.SkippedNonBaseline++
			continue
		}
		freq := strings.TrimSpace(s.Channel)
		if freq == "" && s.FrequencyTransmission != nil {
			freq = strings.TrimSpace(s.FrequencyTransmission.Value)
		}
		if freq == "" {
			continue
		}
		raw.rccs = append(raw.rccs, rawRcc{
			id:   featureIdentifier(f.GMLID, f.Identifier),
			freq: freq,
		})
	}
	return nil
}

// resolveAirspaceRadios walks the service / RCC accumulators and
// attaches a RadioChannel slice to every Airspace any service links
// via clientAirspace.
func resolveAirspaceRadios(msg *Message, raw *rawServices) {
	if len(raw.services) == 0 {
		return
	}
	// Index RCCs by UUID.
	rccByID := make(map[string]string, len(raw.rccs))
	for i := range raw.rccs {
		rccByID[raw.rccs[i].id] = raw.rccs[i].freq
	}
	// Index airspaces by UUID for O(1) clientAirspace resolution. A
	// multi-component airspace decodes to several rows sharing one
	// UUID; each of them gets the channel.
	airspaceIdx := make(map[string][]int, len(msg.Airspaces))
	for i := range msg.Airspaces {
		id := msg.Airspaces[i].ID
		airspaceIdx[id] = append(airspaceIdx[id], i)
	}
	// Track de-dup per airspace; a service may publish overlapping
	// frequencies and we don't want the row to repeat them.
	type seenKey struct{ freq, call string }
	seen := make(map[int]map[seenKey]bool, len(msg.Airspaces))
	for _, svc := range raw.services {
		freq, ok := rccByID[svc.radioCommUUID]
		if !ok {
			if svc.radioCommUUID != "" {
				msg.UnresolvedXlinks++
			}
			continue
		}
		for _, aid := range svc.clientAirspaces {
			idxs, ok := airspaceIdx[aid]
			if !ok {
				msg.UnresolvedXlinks++
				continue
			}
			for _, i := range idxs {
				if seen[i] == nil {
					seen[i] = map[seenKey]bool{}
				}
				key := seenKey{freq: freq, call: svc.callSign}
				if seen[i][key] {
					continue
				}
				seen[i][key] = true
				msg.Airspaces[i].Radio = append(msg.Airspaces[i].Radio, RadioChannel{
					Freq:     freq,
					Unit:     svc.callSign,
					CallSign: svc.callSign,
				})
			}
		}
	}
}

// resolveAirportRadios walks the service / RCC accumulators and attaches a
// RadioChannel slice to every Airport any service links via clientAirport.
// Mirrors resolveAirspaceRadios, but RadioChannel.Unit carries the raw AIXM
// service type (TWR / APP / ATIS / OTHER / ...); the per-country emitter
// (cmd/uk) curates that into a display label, since which services to keep is
// country policy, not a decoder concern. CallSign carries the spoken call
// sign. A bad radioCommunication xlink is already counted by
// resolveAirspaceRadios (it sees every service), so only unresolved
// clientAirport targets bump UnresolvedXlinks here.
func resolveAirportRadios(msg *Message, raw *rawServices) {
	if len(raw.services) == 0 {
		return
	}
	rccByID := make(map[string]string, len(raw.rccs))
	for i := range raw.rccs {
		rccByID[raw.rccs[i].id] = raw.rccs[i].freq
	}
	airportIdx := make(map[string]int, len(msg.Airports))
	for i := range msg.Airports {
		airportIdx[msg.Airports[i].ID] = i
	}
	type seenKey struct{ freq, unit, call string }
	seen := make(map[int]map[seenKey]bool, len(msg.Airports))
	for _, svc := range raw.services {
		if len(svc.clientAirports) == 0 {
			continue
		}
		freq, ok := rccByID[svc.radioCommUUID]
		if !ok {
			continue
		}
		for _, aid := range svc.clientAirports {
			i, ok := airportIdx[aid]
			if !ok {
				msg.UnresolvedXlinks++
				continue
			}
			if seen[i] == nil {
				seen[i] = map[seenKey]bool{}
			}
			key := seenKey{freq: freq, unit: svc.serviceType, call: svc.callSign}
			if seen[i][key] {
				continue
			}
			seen[i][key] = true
			msg.Airports[i].Radio = append(msg.Airports[i].Radio, RadioChannel{
				Freq:     freq,
				Unit:     svc.serviceType,
				CallSign: svc.callSign,
			})
		}
	}
}
