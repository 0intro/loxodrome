// service.go decodes the AIXM 5.1 service tree that publishers use
// to link airspace volumes to radio frequencies. The chain is:
//
//   AirTrafficControlService (or InformationService /
//   AirTrafficManagementService) ─clientAirspace─▶ Airspace
//                              │
//                              └─radioCommunication─▶ (one or more)
//                                  RadioCommunicationChannel
//                                  (frequencyTransmission / mode)
//
// The same three service kinds + RCC structure is used by NATS UK
// and ENAIRE Spain alike. France's SIA AIXM 4.5 uses an entirely
// different shape; this file is AIXM-5.1-only.
//
// A service links EVERY channel it works: NATS's GATWICK DIRECTOR is
// 126.825, 118.950, 129.025 and 121.500. radioCommunication is therefore
// a list here. Read as one element, encoding/xml kept the last link only,
// which is how ten UK and Georgian control zones came to offer 121.500
// alone and twelve German ones a military UHF channel.
//
// The order they are written in is the order the app offers them in (it
// sets the first working VHF channel of a line), and the link order is no
// answer: HEATHROW RADAR links 127.525 ("When instructed by ATC."), guard,
// then 125.625, the channel its remark gives VFR flights in the London CTR,
// and guard sits first or in the middle as often as last. So the channels
// are ranked by the evidence their publisher files (channelRank: its own
// rank, the channel's remarks, the notes under its availability), and a
// row, an airspace's or an aerodrome's, lists them by rank across all the
// services serving it, in link order within a rank: the DFS files one
// channel per service, so ranked within a service alone nothing moved.

package aixm5

import (
	"encoding/xml"
	"math"
	"regexp"
	"slices"
	"strconv"
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
	GTCSlices  []xmlServiceSlice `xml:"timeSlice>GroundTrafficControlServiceTimeSlice"`
}

type xmlServiceSlice struct {
	Interpretation     string              `xml:"interpretation"`
	CallsignDetails    []xmlCallsignDetail `xml:"call-sign>CallsignDetail"`
	RadioCommunication []xmlHref           `xml:"radioCommunication"`
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
// triples into every clientAirspace and clientAirport.
type rawService struct {
	serviceType string
	// callSigns are the service's distinct call signs in the order
	// published (serviceCallSigns); channelCallSign says which of them
	// answer on a given channel.
	callSigns []string
	// radioCommUUIDs are the channel links in the order published.
	radioCommUUIDs  []string
	clientAirspaces []string
	clientAirports  []string
}

// rawRcc is the post-decode shape of one RadioCommunicationChannel
// timeslice. An empty freq marks a channel the decoder dropped (not in
// MHz), so a link to it is known and is not counted as unresolved. rank
// orders the channels (channelRank).
type rawRcc struct {
	id   string
	freq string
	rank int
	// ground: the channel's own remark gives its coverage at ground level
	// (groundCoverage).
	ground bool
	// role: the surface position its remark names (surfaceRole).
	role string
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

// decodeGroundTrafficControlServiceFeature reads the DFS's apron control,
// which it files as a ground traffic control service (type SMGCS) linking
// its aerodrome: skipped as an unknown feature, no German aerodrome carried
// a ground-movement channel.
func decodeGroundTrafficControlServiceFeature(dec *xml.Decoder, start *xml.StartElement, msg *Message, raw *rawServices) error {
	return decodeService(dec, start, msg, raw, kindGTC)
}

type serviceKind int

const (
	kindATC serviceKind = iota
	kindInfo
	kindATM
	kindGTC
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
	case kindGTC:
		slices = f.GTCSlices
	}
	for i := range slices {
		s := &slices[i]
		if !strings.EqualFold(strings.TrimSpace(s.Interpretation), "BASELINE") {
			msg.SkippedNonBaseline++
			continue
		}
		r := rawService{
			serviceType: strings.TrimSpace(s.Type),
			callSigns:   serviceCallSigns(s.CallsignDetails),
		}
		for _, h := range s.RadioCommunication {
			if id := uuidFromHref(h.Href); id != "" {
				r.radioCommUUIDs = append(r.radioCommUUIDs, id)
			}
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

// serviceCallSigns lists a service's distinct call signs in the order
// published: the English ones when the service has any, else every
// language's. DFS files each call sign once per language ("DUESSELDORF
// TOWER" in English and German, "HANNOVER APPROACH" in German beside the
// English "HANNOVER ARRIVAL"), so the English set is what a pilot calls.
func serviceCallSigns(cds []xmlCallsignDetail) []string {
	var en, all []string
	for _, c := range cds {
		v := strings.TrimSpace(c.CallSign)
		if v == "" {
			continue
		}
		if !slices.Contains(all, v) {
			all = append(all, v)
		}
		if strings.EqualFold(strings.TrimSpace(c.Language), "eng") && !slices.Contains(en, v) {
			en = append(en, v)
		}
	}
	if len(en) > 0 {
		return en
	}
	return all
}

// surfaceBand reports whether a channel lies in the VHF block set aside
// for aerodrome surface communications: channels 121.540 to 121.990
// inclusive (121.5417 to 121.9916 MHz), per the allotment table of the
// ICAO EUR Frequency Management Manual (EUR Doc 011, Edition 2025, Part
// II 2.1), which is built on Annex 10 Volume V 4.1.1. Both forms of a
// value read: the 8.33 kHz channel name (121.540) and the frequency
// (121.5417).
func surfaceBand(freq string) bool {
	f, err := strconv.ParseFloat(strings.TrimSpace(freq), 64)
	if err != nil {
		return false
	}
	k := math.Round(f * 1000)
	return k >= 121540 && k <= 121992
}

// surfacePosition reports whether a call sign names a position working the
// aerodrome surface rather than airspace: ground, delivery, apron (the DFS
// files it in German too, VORFELD, and numbers its parts, "MUENCHEN APRON
// 1"), de-icing, or the fire service's own channel.
func surfacePosition(callSign string) bool {
	for _, w := range strings.Fields(strings.ToUpper(callSign)) {
		switch w {
		case "GROUND", "DELIVERY", "APRON", "VORFELD", "DE-ICING", "DEICING", "FIRE":
			return true
		}
	}
	return false
}

// groundCoverage reports whether a channel's remarks give its designated
// operational coverage at ground level, "DOC 3 NM/GND": a surface
// channel whatever its band. NATS writes it on 24 channels, 23 of them in
// the surface block already; the 24th is Alderney's 130.505.
var groundCoverageRe = regexp.MustCompile(`(?i)\bDOC\b[^.]*?\bNM\s*/\s*GND\b`)

func groundCoverage(remarks []string) bool {
	for _, n := range remarks {
		if groundCoverageRe.MatchString(n) {
			return true
		}
	}
	return false
}

// surfaceRole reads the surface position a channel's remarks name: "Ground
// Movement Planning", the UK's GMP, is the delivery ("DELIVERY"), "Ground
// Movement Control" the ground ("GROUND"); "" when they name neither, or
// both.
var (
	gmpRe = regexp.MustCompile(`(?i)\bground\s+movement\s+planning\b`)
	gmcRe = regexp.MustCompile(`(?i)\bground\s+movement\s+control\b`)
)

func surfaceRole(remarks []string) string {
	planning, control := false, false
	for _, n := range remarks {
		planning = planning || gmpRe.MatchString(n)
		control = control || gmcRe.MatchString(n)
	}
	switch {
	case planning && !control:
		return "DELIVERY"
	case control && !planning:
		return "GROUND"
	}
	return ""
}

// channelCallSign names who answers on one channel of a service, and
// whether only surface positions do. A service with several call signs
// never says which channel is whose: NATS files GATWICK TOWER, DELIVERY
// and GROUND under one tower service linking five channels. The band
// decides it: a channel in the surface block is the ground, delivery,
// apron or fire call signs', any other channel the rest's (the tower's,
// and the guard it listens on), and so is a channel whose own remark gives
// its coverage at ground level (`ground`, groundCoverage): Alderney's
// 130.505 lies outside the block and read as the tower's. Among the
// surface call signs, a channel whose remark names its position (`role`,
// surfaceRole) is that position's alone: Heathrow's 121.980, "Ground
// Movement Planning", is its delivery and read as ground as well. When the
// band leaves no call sign, every call sign answers; several are joined
// with " / ", which CurateAirportRadios splits back per position.
//
// What the data cannot say is left as it reads: a service whose call signs
// all work airspace keeps them joined on every channel (MANCHESTER
// DIRECTOR / MANCHESTER RADAR), since nothing says which channel is the
// director's.
func channelCallSign(callSigns []string, freq string, ground bool, role string) (call string, surfaceOnly bool) {
	if len(callSigns) == 0 {
		return "", false
	}
	group := callSigns
	if len(callSigns) > 1 {
		inBand := surfaceBand(freq) || ground
		var picked []string
		for _, c := range callSigns {
			if surfacePosition(c) == inBand {
				picked = append(picked, c)
			}
		}
		if len(picked) > 0 {
			group = picked
		}
		if inBand && role != "" {
			var named []string
			for _, c := range group {
				if slices.Contains(strings.Fields(strings.ToUpper(c)), role) {
					named = append(named, c)
				}
			}
			if len(named) > 0 {
				group = named
			}
		}
	}
	surfaceOnly = true
	for _, c := range group {
		if !surfacePosition(c) {
			surfaceOnly = false
			break
		}
	}
	return strings.Join(group, " / "), surfaceOnly
}

// serviceChannel is one channel of a service, attributed.
type serviceChannel struct {
	freq, call string
	// surfaceOnly: only surface positions answer on it (channelCallSign).
	surfaceOnly bool
	rank        int
}

// serviceChannels resolves a service's channel links, attributing each one,
// ranked by their remarks and in the order published within a rank; it also
// returns how many links name no channel at all, counted per link. A
// dropped channel (not in MHz) is known and skipped.
func serviceChannels(svc *rawService, rccByID map[string]rawRcc) (chans []serviceChannel, unresolved int) {
	for _, id := range svc.radioCommUUIDs {
		rcc, ok := rccByID[id]
		if !ok {
			unresolved++
			continue
		}
		if rcc.freq == "" {
			continue
		}
		call, surfaceOnly := channelCallSign(svc.callSigns, rcc.freq, rcc.ground, rcc.role)
		chans = append(chans, serviceChannel{freq: rcc.freq, call: call, surfaceOnly: surfaceOnly, rank: rcc.rank})
	}
	slices.SortStableFunc(chans, func(a, b serviceChannel) int { return a.rank - b.rank })
	return chans, unresolved
}

// rankedRows gathers a row's channels with their ranks, and lists them by
// rank, in the order they were gathered within a rank: a row is the
// channels of all the services serving it, each service's already ranked,
// and the DFS files one channel per service, so a row ranked service by
// service kept its alternate first.
type rankedRows map[int][]rankedChannel

type rankedChannel struct {
	ch   RadioChannel
	rank int
}

func (rr rankedRows) add(i int, ch RadioChannel, rank int) {
	rr[i] = append(rr[i], rankedChannel{ch: ch, rank: rank})
}

// sorted is row i's channels by rank.
func (rr rankedRows) sorted(i int) []RadioChannel {
	row := rr[i]
	slices.SortStableFunc(row, func(a, b rankedChannel) int { return a.rank - b.rank })
	out := make([]RadioChannel, len(row))
	for k, c := range row {
		out[k] = c.ch
	}
	return out
}

// rccIndex maps each decoded channel's UUID to it (freq "" for a channel
// the decoder dropped).
func rccIndex(raw *rawServices) map[string]rawRcc {
	m := make(map[string]rawRcc, len(raw.rccs))
	for i := range raw.rccs {
		m[raw.rccs[i].id] = raw.rccs[i]
	}
	return m
}

// A channel one is only told onto, asks for, keeps for an emergency or
// holds in reserve: a channel to set on reaching the airspace is never one
// of these. The DFS states an alternate, military or guard channel as its
// legacy frequency code type too.
var laterRemark = regexp.MustCompile(`(?i)\b(as directed|when directed|directed by|when instructed|instructed by|on request|on demand|non-ats|emergency|emergencies|fire|alternate|stand-?by|reserve frequency|not continuously monitored|failure of communications?)\b|\bo/r\b|frequency-codetype:\s*(alt|mil|guard|emrg)\b`)

// An availability note opening on a directive says when the channel is used
// at all: NATS files "As directed by ATC", "O/R" and the fire vehicle's
// channel there. One opening on hours is a channel in service in them,
// whatever it adds ("0630-2100 (0500-2100) or as directed"), and so is the
// DFS's "until 2200 (2100) O/R", its hours filed as a note.
var laterAvailability = regexp.MustCompile(`(?i)^\s*(only\s+)?((as|when)\s+(directed|instructed)\b|o/r\b|on\s+(request|demand)\b|available\s+when\s+fire\b|emergenc)`)

// A remark opening on hours says when the channel is in service, whatever
// it adds, as an availability note opening on them does: the DFS files
// DRESDEN TOWER's and GROUND's "ATC from 2350 (2250) - 0410 (0310) O/R" as
// a remark, the night on request, the channel primary around the clock.
var hoursFirst = regexp.MustCompile(`(?i)^\s*(atc\s+)?((from|until|between)\s+)?\d{4}\b`)

// A channel the remark gives the VFR or the transit traffic: the one a
// light aircraft calls (NATS's HEATHROW RADAR 125.625, "VFR and Special VFR
// flights in the London CTR"; "Transit Requests"). One naming IFR and VFR
// together (the DFS's "IFR/VFR" deliveries) serves both, and is no VFR
// channel.
var (
	firstRemark = regexp.MustCompile(`(?i)\b(vfr|transits?)\b`)
	bothRules   = regexp.MustCompile(`(?i)\bifr\s*(/|and|&|,)\s*vfr\b|\bvfr\s*(/|and|&|,)\s*ifr\b`)
)

// The ranks of a channel, the order a service's channels and a row's are
// written in.
const (
	// rankFirst is a channel whose remark addresses VFR or transit traffic.
	rankFirst = iota
	// rankNormal is the rest, a publisher's PRIMARY channel among them.
	rankNormal
	// rankSecondary is a channel its publisher ranks SECONDARY.
	rankSecondary
	// rankLater is a channel one is only told onto, asks for, or keeps for
	// an emergency or in reserve.
	rankLater
)

// channelRank ranks a channel by the evidence its publisher files: its own
// rank (AIXM's CodeFacilityRankingType, which the DFS states on every
// channel and Georgia on some: ALTERNATE, GUARD, EMERG and the military
// ones last, SECONDARY after the primaries), its remarks (laterRemark
// anywhere in one not opening on hours, a VFR or transit channel first),
// and the notes under its availability (laterAvailability, a directive
// opening one). Demotion wins: a channel one is told onto is never the one
// to call first, whoever it serves.
func channelRank(rank string, remarks, availability []string) int {
	r := strings.ToUpper(strings.TrimSpace(rank))
	if r == "ALTERNATE" || r == "GUARD" || strings.HasPrefix(r, "EMERG") || strings.Contains(r, "MIL") {
		return rankLater
	}
	first := false
	for _, n := range remarks {
		if laterRemark.MatchString(n) && !hoursFirst.MatchString(n) {
			return rankLater
		}
		if firstRemark.MatchString(n) && !bothRules.MatchString(n) {
			first = true
		}
	}
	for _, n := range availability {
		if laterAvailability.MatchString(n) {
			return rankLater
		}
	}
	switch {
	case first:
		return rankFirst
	case r == "SECONDARY":
		return rankSecondary
	}
	return rankNormal
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
	// The publisher's own rank of the channel (channelRank).
	Rank string `xml:"rank"`
	// The channel's notes: its remarks, and the DFS's hours, filed as notes
	// on the availability property (channelRank reads them apart).
	Remarks []xmlRccRemark `xml:"annotation>Note"`
	// The notes under its availability, where NATS files its directives.
	Availability []xmlRccRemark `xml:"availability>RadioCommunicationOperationalStatus>annotation>Note"`
}

type xmlRccRemark struct {
	PropertyName string   `xml:"propertyName"`
	Notes        []string `xml:"translatedNote>LinguisticNote>note"`
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
			// The uom states the unit, and the radio column is MHz
			// throughout: a channel in any other unit (an HF channel in
			// kHz) is dropped, never read as MHz. A missing uom reads as
			// MHz.
			if uom := strings.TrimSpace(s.FrequencyTransmission.UOM); freq != "" && uom != "" && !strings.EqualFold(uom, "MHZ") {
				msg.SkippedRadioChannels++
				raw.rccs = append(raw.rccs, rawRcc{id: featureIdentifier(f.GMLID, f.Identifier)})
				continue
			}
		}
		if freq == "" {
			continue
		}
		var remarks, availability []string
		for _, r := range s.Remarks {
			if strings.EqualFold(strings.TrimSpace(r.PropertyName), "availability") {
				availability = append(availability, r.Notes...)
			} else {
				remarks = append(remarks, r.Notes...)
			}
		}
		for _, r := range s.Availability {
			availability = append(availability, r.Notes...)
		}
		raw.rccs = append(raw.rccs, rawRcc{
			id:     featureIdentifier(f.GMLID, f.Identifier),
			freq:   freq,
			rank:   channelRank(s.Rank, remarks, availability),
			ground: groundCoverage(remarks),
			role:   surfaceRole(remarks),
		})
	}
	return nil
}

// resolveAirspaceRadios walks the service / RCC accumulators and
// attaches a RadioChannel slice to every Airspace any service links
// via clientAirspace. A channel only surface positions answer on is no
// channel of an airspace: FENTON FIRE's 121.600 rides the air-ground
// service that serves the ATZ, and a contact line read from it would
// hand the pilot the fire vehicle. Channel links naming no channel are
// counted here, once per link, since this pass sees every service.
func resolveAirspaceRadios(msg *Message, raw *rawServices) {
	if len(raw.services) == 0 {
		return
	}
	rccByID := rccIndex(raw)
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
	rows := rankedRows{}
	for si := range raw.services {
		svc := &raw.services[si]
		all, unresolved := serviceChannels(svc, rccByID)
		msg.UnresolvedXlinks += unresolved
		var chans []serviceChannel
		for _, c := range all {
			if !c.surfaceOnly {
				chans = append(chans, c)
			}
		}
		if len(chans) == 0 {
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
				for _, c := range chans {
					key := seenKey{freq: c.freq, call: c.call}
					if seen[i][key] {
						continue
					}
					seen[i][key] = true
					rows.add(i, RadioChannel{
						Freq:     c.freq,
						Unit:     c.call,
						CallSign: c.call,
					}, c.rank)
				}
			}
		}
	}
	for i := range rows {
		msg.Airspaces[i].Radio = append(msg.Airspaces[i].Radio, rows.sorted(i)...)
	}
}

// resolveAirportRadios walks the service / RCC accumulators and attaches a
// RadioChannel slice to every Airport any service links via clientAirport.
// Mirrors resolveAirspaceRadios, but RadioChannel.Unit carries the raw AIXM
// service type (TWR / APP / ATIS / OTHER / ...); the per-country emitter
// (cmd/uk) curates that into a display label, since which services to keep is
// country policy, not a decoder concern. CallSign carries who answers on the
// channel (channelCallSign), several call signs joined with " / ". Surface
// channels stay: they are the aerodrome's. A bad radioCommunication xlink is
// already counted by resolveAirspaceRadios (it sees every service), so only
// unresolved clientAirport targets bump UnresolvedXlinks here.
func resolveAirportRadios(msg *Message, raw *rawServices) {
	if len(raw.services) == 0 {
		return
	}
	rccByID := rccIndex(raw)
	airportIdx := make(map[string]int, len(msg.Airports))
	for i := range msg.Airports {
		airportIdx[msg.Airports[i].ID] = i
	}
	type seenKey struct{ freq, unit, call string }
	seen := make(map[int]map[seenKey]bool, len(msg.Airports))
	rows := rankedRows{}
	for si := range raw.services {
		svc := &raw.services[si]
		if len(svc.clientAirports) == 0 {
			continue
		}
		chans, _ := serviceChannels(svc, rccByID)
		if len(chans) == 0 {
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
			for _, c := range chans {
				key := seenKey{freq: c.freq, unit: svc.serviceType, call: c.call}
				if seen[i][key] {
					continue
				}
				seen[i][key] = true
				rows.add(i, RadioChannel{
					Freq:     c.freq,
					Unit:     svc.serviceType,
					CallSign: c.call,
				}, c.rank)
			}
		}
	}
	for i := range rows {
		msg.Airports[i].Radio = append(msg.Airports[i].Radio, rows.sorted(i)...)
	}
}
