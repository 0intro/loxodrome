package aixm5

import (
	"encoding/xml"
	"slices"
	"strings"
)

// xmlAirportHeliport mirrors the aixm:AirportHeliport tree.
type xmlAirportHeliport struct {
	GMLID      string            `xml:"id,attr"`
	Identifier string            `xml:"identifier"`
	TimeSlices []xmlAirportSlice `xml:"timeSlice>AirportHeliportTimeSlice"`
}

type xmlAirportSlice struct {
	Interpretation        string                   `xml:"interpretation"`
	Designator            string                   `xml:"designator"`
	Name                  string                   `xml:"name"`
	LocationIndicatorICAO string                   `xml:"locationIndicatorICAO"`
	DesignatorIATA        string                   `xml:"designatorIATA"`
	ControlType           string                   `xml:"controlType"`
	Type                  string                   `xml:"type"`
	Abandoned             string                   `xml:"abandoned"`
	FieldElevation        *xmlUOMValue             `xml:"fieldElevation"`
	TransitionAltitude    *xmlUOMValue             `xml:"transitionAltitude"`
	ServedCity            xmlAirportCity           `xml:"servedCity"`
	ARP                   xmlAirportARP            `xml:"ARP"`
	Availability          []xmlAirportAvailability `xml:"availability>AirportHeliportAvailability"`
	// Annotations are the directory free text: what the AIP prints
	// about the field beyond its geometry. DFS and NATS type each one
	// with a propertyName (usage / voice / timeInterval / ARP / type),
	// which is what makes them sortable into a panel; ENAIRE mostly
	// leaves it blank.
	Annotations []xmlNote `xml:"annotation>Note"`
	// Contacts are the operator and its telephone / online details.
	Contacts []xmlContactInfo `xml:"contact>ContactInformation"`
}

// xmlContactInfo mirrors aixm:ContactInformation. Publishers split on
// where the number lives: NATS and ENAIRE fill the schema's own
// aixm:voice / aixm:facsimile, while DFS leaves those out and writes
// the number into an annotation on the TelephoneContact instead
// (propertyName voice / facsimile), so both forms decode here.
type xmlContactInfo struct {
	Name          string           `xml:"name"`
	DeliveryPoint string           `xml:"address>PostalAddress>deliveryPoint"`
	Phones        []xmlPhoneNumber `xml:"phoneFax>TelephoneContact"`
	Online        []xmlOnline      `xml:"networkNode>OnlineContact"`
}

type xmlPhoneNumber struct {
	Voice       string    `xml:"voice"`
	Facsimile   string    `xml:"facsimile"`
	Annotations []xmlNote `xml:"annotation>Note"`
}

type xmlOnline struct {
	// The schema spells it eMail; every publisher follows.
	Email   string `xml:"eMail"`
	Linkage string `xml:"linkage"`
}

// xmlAirportAvailability lists each usage profile published for the
// aerodrome. AIXM 5.1 separates "what kinds of traffic are allowed"
// (usage.type: PERMIT / PRIVATE / RESERV / OTHER) from the actual
// flight-rule restrictions (selection > ConditionCombination >
// flight > FlightCharacteristic > rule = VFR / IFR / IFR_AND_VFR).
// operationalStatus (NORMAL / LIMITED / CLOSED) rides the same block,
// scoped by the timeInterval Timesheets when the publisher states it
// for a period only (DFS codes EDOP's winter closure that way).
type xmlAirportAvailability struct {
	OperationalStatus string            `xml:"operationalStatus"`
	Timesheets        []xmlTimesheet    `xml:"timeInterval>Timesheet"`
	Usages            []xmlAirportUsage `xml:"usage>AirportHeliportUsage"`
	// Annotations scope the availability, which is where DFS states an
	// aerodrome's usage conditions ("multi-engine helicopters, up to
	// 14.90 m, performance class 1, HEMS").
	Annotations []xmlNote `xml:"annotation>Note"`
}

type xmlAirportUsage struct {
	Type      string                     `xml:"type"`
	Selection []xmlAirportConditionCombo `xml:"selection>ConditionCombination"`
}

type xmlAirportConditionCombo struct {
	Flights []xmlAirportFlightCharacteristic `xml:"flight>FlightCharacteristic"`
}

type xmlAirportFlightCharacteristic struct {
	Rule   string `xml:"rule"`   // VFR / IFR / IFR_AND_VFR
	Status string `xml:"status"` // sometimes used; e.g. MILITARY
}

type xmlAirportCity struct {
	Name string `xml:"City>name"`
}

type xmlAirportARP struct {
	Pos string `xml:"ElevatedPoint>pos"`
}

// xmlRunway mirrors the aixm:Runway tree. The link back to the
// parent airport is an xlink:href; the post-stream resolver walks
// runways and attaches each to its airport in the same Message.
type xmlRunway struct {
	GMLID      string           `xml:"id,attr"`
	Identifier string           `xml:"identifier"`
	TimeSlices []xmlRunwaySlice `xml:"timeSlice>RunwayTimeSlice"`
}

// xmlRunwayDirection mirrors aixm:RunwayDirection. Each direction
// of a physical runway has its own RunwayDirection feature carrying
// the designator (e.g. "09L"), bearing, and a usedRunway xlink back
// to the parent Runway. Despite the misleading "onRunway" name on
// the centreline-point side of the relationship, AIXM 5.1 publishers
// (NATS UK and ENAIRE Spain alike) link RunwayCentrelinePoints to
// RunwayDirections, not directly to Runways.
type xmlRunwayDirection struct {
	GMLID      string                    `xml:"id,attr"`
	Identifier string                    `xml:"identifier"`
	TimeSlices []xmlRunwayDirectionSlice `xml:"timeSlice>RunwayDirectionTimeSlice"`
}

type xmlRunwayDirectionSlice struct {
	Interpretation string  `xml:"interpretation"`
	Designator     string  `xml:"designator"`
	UsedRunway     xmlHref `xml:"usedRunway"`
}

// xmlRunwayCentrelinePoint mirrors aixm:RunwayCentrelinePoint.
// Carries one direction's threshold + declared distances. The
// onRunway xlink links back to the parent Runway; designator
// ("09L" or "27R") tells us which half of a two-way runway to
// fold the distances into.
type xmlRunwayCentrelinePoint struct {
	GMLID      string                  `xml:"id,attr"`
	Identifier string                  `xml:"identifier"`
	TimeSlices []xmlRwyCentreLineSlice `xml:"timeSlice>RunwayCentrelinePointTimeSlice"`
}

type xmlRwyCentreLineSlice struct {
	Interpretation string             `xml:"interpretation"`
	Designator     string             `xml:"designator"`
	Role           string             `xml:"role"`
	OnRunway       xmlHref            `xml:"onRunway"`
	Distances      []xmlAssocDistance `xml:"associatedDeclaredDistance"`
}

type xmlAssocDistance struct {
	Distance xmlRwyDeclaredDistance `xml:"RunwayDeclaredDistance"`
}

type xmlRwyDeclaredDistance struct {
	Type  string                    `xml:"type"` // TORA / TODA / ASDA / LDA
	Value xmlRwyDeclaredDistanceVal `xml:"declaredValue>RunwayDeclaredDistanceValue"`
}

type xmlRwyDeclaredDistanceVal struct {
	Distance *xmlUOMValue `xml:"distance"`
}

type xmlRunwaySlice struct {
	Interpretation    string               `xml:"interpretation"`
	Designator        string               `xml:"designator"`
	Type              string               `xml:"type"`
	NominalLength     *xmlUOMValue         `xml:"nominalLength"`
	NominalWidth      *xmlUOMValue         `xml:"nominalWidth"`
	SurfaceProperties xmlSurfaceProperties `xml:"surfaceProperties"`
	AssociatedAirport xmlHref              `xml:"associatedAirportHeliport"`
}

type xmlSurfaceProperties struct {
	Composition string `xml:"SurfaceCharacteristics>composition"`
}

// xmlHref captures an xlink:href attribute. The Href value is
// "urn:uuid:<UUID>" in production AIXM 5.1 files; uuidFromHref
// converts it to the bare UUID that matches gml:id's "uuid.<UUID>"
// scheme after stripUUIDPrefix.
type xmlHref struct {
	Href string `xml:"href,attr"`
}

// decodeAirportHeliportFeature appends one Airport per BASELINE
// timeslice. Runway resolution is deferred to resolveRunways(),
// which runs after the streaming pass when every airport + runway
// in the message has been collected.
func decodeAirportHeliportFeature(dec *xml.Decoder, start *xml.StartElement, msg *Message) error {
	var f xmlAirportHeliport
	if err := dec.DecodeElement(&f, start); err != nil {
		return err
	}
	for i := range f.TimeSlices {
		s := &f.TimeSlices[i]
		if !strings.EqualFold(strings.TrimSpace(s.Interpretation), "BASELINE") {
			msg.SkippedNonBaseline++
			continue
		}
		a := Airport{
			ID:          featureIdentifier(f.GMLID, f.Identifier),
			Designator:  pickIcao(s.Designator, s.LocationIndicatorICAO),
			IATA:        strings.TrimSpace(s.DesignatorIATA),
			Name:        strings.TrimSpace(s.Name),
			City:        strings.TrimSpace(s.ServedCity.Name),
			ControlType: strings.TrimSpace(s.ControlType),
			Type:        strings.TrimSpace(s.Type),
		}
		ctype := strings.ToUpper(a.ControlType)
		a.Military = ctype == "MILITARY" || ctype == "JOINT"
		a.Joint = ctype == "JOINT"
		a.Abandoned = strings.EqualFold(strings.TrimSpace(s.Abandoned), "YES")
		if lat, lon, ok := parsePos(s.ARP.Pos); ok {
			a.Lat, a.Lon = round5(lat), round5(lon)
		}
		if m, ok := metresFromUOM(s.FieldElevation); ok {
			a.ElevM = &m
		}
		// Positive-only: guards against 0 placeholders on records
		// without a real transition altitude (xsi:nil entries already
		// decode to empty and fail metresFromUOM).
		if m, ok := metresFromUOM(s.TransitionAltitude); ok && m > 0 {
			a.TransitionAltM = &m
		}
		a.Access, a.VFR, a.IFR = digestAvailability(s.Availability)
		a.OperationalStatus = standingStatus(s.Availability)
		a.Notes = collectNotes(s.Annotations)
		for _, av := range s.Availability {
			a.Notes = append(a.Notes, collectNotes(av.Annotations)...)
			for _, ts := range av.Timesheets {
				if h := formatTimesheet(ts); h != "" && !slices.Contains(a.Hours, h) {
					a.Hours = append(a.Hours, h)
				}
			}
		}
		a.Contacts = collectContacts(s.Contacts)
		msg.Airports = append(msg.Airports, a)
	}
	return nil
}

// collectNotes flattens the decoded annotations, one entry per
// translated text. Purpose and propertyName ride along: the emitters
// need them to file a note under the right heading, unlike the airspace
// side's collectRemarkNotes, which only wants the prose.
func collectNotes(notes []xmlNote) []Note {
	var out []Note
	for _, n := range notes {
		prop := strings.TrimSpace(n.PropertyName)
		purpose := strings.ToUpper(strings.TrimSpace(n.Purpose))
		for _, t := range n.LinguisticTxt {
			if v := strings.TrimSpace(t.Note); v != "" {
				out = append(out, Note{PropertyName: prop, Purpose: purpose, Text: v})
			}
		}
	}
	return out
}

// collectContacts decodes the operator blocks. A telephone number is
// read from the schema's own voice / facsimile fields, and, for the
// publishers that leave those out, from the annotation whose
// propertyName names the kind (DFS writes every number that way).
func collectContacts(cis []xmlContactInfo) []Contact {
	var out []Contact
	for _, ci := range cis {
		c := Contact{
			Name:    strings.TrimSpace(ci.Name),
			Address: strings.TrimSpace(ci.DeliveryPoint),
		}
		for _, p := range ci.Phones {
			// One TelephoneContact is one number. Where the schema's own
			// field carries it, an annotation of the same kind is the
			// number's LABEL and joins it ("01305-701702 (Admin)"); where
			// the field is absent, the annotation IS the number, which is
			// how DFS publishes every one of them.
			voice, fax := strings.TrimSpace(p.Voice), strings.TrimSpace(p.Facsimile)
			for _, n := range collectNotes(p.Annotations) {
				switch strings.ToLower(n.PropertyName) {
				case "voice":
					voice = joinLabel(voice, n.Text)
				case "facsimile":
					fax = joinLabel(fax, n.Text)
				}
			}
			if voice != "" {
				c.Phone = append(c.Phone, voice)
			}
			if fax != "" {
				c.Fax = append(c.Fax, fax)
			}
		}
		for _, o := range ci.Online {
			if v := strings.TrimSpace(o.Email); v != "" {
				c.Email = append(c.Email, v)
			}
			if v := strings.TrimSpace(o.Linkage); v != "" {
				c.Web = append(c.Web, v)
			}
		}
		if c.Name == "" && c.Address == "" && len(c.Phone) == 0 && len(c.Fax) == 0 &&
			len(c.Email) == 0 && len(c.Web) == 0 {
			continue
		}
		out = append(out, c)
	}
	return out
}

// joinLabel appends a qualifier to a value, or returns the qualifier
// alone when there is no value to qualify.
func joinLabel(value, label string) string {
	switch {
	case value == "":
		return label
	case label == "" || strings.Contains(value, label):
		return value
	default:
		return value + " " + label
	}
}

// standingStatus returns the aerodrome's unconditional
// aixm:operationalStatus (NORMAL / LIMITED / CLOSED), upper-cased.
// An availability carrying Timesheets states its status for those
// periods, so the standing one is the first availability published
// without any.
func standingStatus(avs []xmlAirportAvailability) string {
	for _, av := range avs {
		if len(av.Timesheets) > 0 {
			continue
		}
		if st := strings.ToUpper(strings.TrimSpace(av.OperationalStatus)); st != "" {
			return st
		}
	}
	return ""
}

// digestAvailability collapses every published usage profile into
// the three France-compatible fields:
//
//   - access "cap" when any usage allows general civilian traffic
//     (type=PERMIT / OTHER / empty). "restricted" when only PRIVATE
//     / RESERV / MILITARY profiles are present. Empty when the
//     publisher omits the availability tree entirely.
//   - vfr / ifr true when any FlightCharacteristic.rule on any
//     usage selection permits that rule (rule=VFR, IFR, IFR_AND_VFR).
//
// Mixed-rule aerodromes (typical for major airports) set both vfr
// and ifr to true; tiny grass strips with VFR-only usage leave ifr
// false. The status field is also checked for MILITARY tags some
// publishers attach to specific FlightCharacteristics.
func digestAvailability(avs []xmlAirportAvailability) (access string, vfr, ifr bool) {
	if len(avs) == 0 {
		return "", false, false
	}
	sawCivil := false
	sawRestricted := false
	for _, av := range avs {
		for _, u := range av.Usages {
			t := strings.ToUpper(strings.TrimSpace(u.Type))
			switch t {
			case "", "PERMIT", "OTHER":
				sawCivil = true
			case "PRIVATE", "RESERV", "MILITARY":
				sawRestricted = true
			default:
				sawCivil = true
			}
			for _, c := range u.Selection {
				for _, fc := range c.Flights {
					r := strings.ToUpper(strings.TrimSpace(fc.Rule))
					switch r {
					case "VFR":
						vfr = true
					case "IFR":
						ifr = true
					case "IFR_AND_VFR", "VFR_AND_IFR", "ALL":
						vfr = true
						ifr = true
					}
				}
			}
		}
	}
	switch {
	case sawCivil:
		access = "cap"
	case sawRestricted:
		access = "restricted"
	}
	return access, vfr, ifr
}

// pickIcao returns the first non-empty ICAO identifier from the
// designator / locationIndicatorICAO pair. Some AIXM publishers
// populate only one of the two; both carry the same value when
// both are present.
func pickIcao(designator, locInd string) string {
	if d := strings.TrimSpace(designator); d != "" {
		return d
	}
	return strings.TrimSpace(locInd)
}

// decodeRunwayFeature collects raw runway slices; resolveRunways()
// attaches each to its parent airport once streaming is complete.
func decodeRunwayFeature(dec *xml.Decoder, start *xml.StartElement, msg *Message, raw *rawRunways) error {
	var f xmlRunway
	if err := dec.DecodeElement(&f, start); err != nil {
		return err
	}
	for i := range f.TimeSlices {
		s := &f.TimeSlices[i]
		if !strings.EqualFold(strings.TrimSpace(s.Interpretation), "BASELINE") {
			msg.SkippedNonBaseline++
			continue
		}
		r := rawRunway{
			runway: Runway{
				ID:         featureIdentifier(f.GMLID, f.Identifier),
				Designator: strings.TrimSpace(s.Designator),
				Surface:    strings.TrimSpace(s.SurfaceProperties.Composition),
			},
			parentUUID: uuidFromHref(s.AssociatedAirport.Href),
		}
		r.runway.Le, r.runway.He = splitRunwayDesignator(r.runway.Designator)
		if m, ok := metresFromUOM(s.NominalLength); ok {
			r.runway.LengthM = &m
		}
		if m, ok := metresFromUOM(s.NominalWidth); ok {
			r.runway.WidthM = &m
		}
		raw.runways = append(raw.runways, r)
	}
	return nil
}

// rawRunways accumulates undispatched runway records between the
// streaming pass and the resolution pass; one per BASELINE
// timeslice. centreLine points carry the per-direction declared
// distances; the resolver folds them into the matching Runway.
type rawRunways struct {
	runways     []rawRunway
	directions  []rawRunwayDirection
	centrelines []rawCentrelinePoint
}

type rawRunway struct {
	runway     Runway
	parentUUID string
}

type rawCentrelinePoint struct {
	// directionUUID is the onRunway xlink target. Despite the AIXM
	// element name, it actually references a RunwayDirection, not a
	// Runway. Resolution looks it up in rawDirections to recover the
	// designator + parent Runway.
	directionUUID string
	distances     map[string]float64 // "TORA" / "LDA" -> metres
}

// rawRunwayDirection captures the designator + runway link for the
// resolution pass.
type rawRunwayDirection struct {
	uuid       string // RunwayDirection's identifier
	designator string // e.g. "09L"
	runwayUUID string // usedRunway xlink target (a Runway's identifier)
}

// resolveRunways attaches each raw runway to its parent Airport
// (matched by UUID) and then folds RunwayCentrelinePoint declared
// distances into the matching Runway's per-direction fields.
// Orphan runways or orphan centreline points (xlinks pointing
// outside the message) bump Message.UnresolvedXlinks.
func resolveRunways(msg *Message, raw *rawRunways) {
	if len(raw.runways) == 0 && len(raw.centrelines) == 0 {
		return
	}
	airportIdx := make(map[string]int, len(msg.Airports))
	for i := range msg.Airports {
		airportIdx[msg.Airports[i].ID] = i
	}
	// Index runways by their own ID so centreline-point lookups
	// can find them after they're attached to airports.
	runwayLoc := make(map[string]struct{ airport, runway int }, len(raw.runways))
	for i := range raw.runways {
		r := &raw.runways[i]
		j, ok := airportIdx[r.parentUUID]
		if !ok {
			msg.UnresolvedXlinks++
			continue
		}
		k := len(msg.Airports[j].Runways)
		msg.Airports[j].Runways = append(msg.Airports[j].Runways, r.runway)
		runwayLoc[r.runway.ID] = struct{ airport, runway int }{j, k}
	}
	// Index directions by UUID so RCP resolution can look up the
	// parent runway + designator in one hop.
	directionIdx := make(map[string]*rawRunwayDirection, len(raw.directions))
	for i := range raw.directions {
		directionIdx[raw.directions[i].uuid] = &raw.directions[i]
	}
	for i := range raw.centrelines {
		c := &raw.centrelines[i]
		dir, ok := directionIdx[c.directionUUID]
		if !ok {
			msg.UnresolvedXlinks++
			continue
		}
		loc, ok := runwayLoc[dir.runwayUUID]
		if !ok {
			msg.UnresolvedXlinks++
			continue
		}
		applyDistances(&msg.Airports[loc.airport].Runways[loc.runway], dir.designator, c)
	}
}

// applyDistances folds one centreline-point's declared distances
// into the matching half (le or he) of its parent runway. The
// designator comes from the linked RunwayDirection (RCPs themselves
// usually leave aixm:designator nil). When the designator matches
// neither half (rare; usually a runway renumbering mid-cycle), the
// distances are silently dropped.
func applyDistances(r *Runway, designator string, c *rawCentrelinePoint) {
	var lda, tora, toda, asda **float64
	switch strings.TrimSpace(designator) {
	case r.Le:
		lda, tora, toda, asda = &r.LeLdaM, &r.LeToraM, &r.LeTodaM, &r.LeAsdaM
	case r.He:
		lda, tora, toda, asda = &r.HeLdaM, &r.HeToraM, &r.HeTodaM, &r.HeAsdaM
	default:
		return
	}
	for typ, m := range c.distances {
		v := m
		switch typ {
		case "LDA":
			*lda = &v
		case "TORA":
			*tora = &v
		case "TODA":
			*toda = &v
		case "ASDA":
			*asda = &v
		}
	}
}

// decodeRunwayDirectionFeature captures the designator + parent
// Runway link, both of which RunwayCentrelinePoint resolution
// needs (RCPs link to RunwayDirections, not Runways directly).
func decodeRunwayDirectionFeature(dec *xml.Decoder, start *xml.StartElement, msg *Message, raw *rawRunways) error {
	var f xmlRunwayDirection
	if err := dec.DecodeElement(&f, start); err != nil {
		return err
	}
	for i := range f.TimeSlices {
		s := &f.TimeSlices[i]
		if !strings.EqualFold(strings.TrimSpace(s.Interpretation), "BASELINE") {
			msg.SkippedNonBaseline++
			continue
		}
		raw.directions = append(raw.directions, rawRunwayDirection{
			uuid:       featureIdentifier(f.GMLID, f.Identifier),
			designator: strings.TrimSpace(s.Designator),
			runwayUUID: uuidFromHref(s.UsedRunway.Href),
		})
	}
	return nil
}

// decodeRunwayCentrelinePointFeature collects the per-direction
// centreline-point + declared-distance values for the resolution
// pass. Only BASELINE timeslices are kept.
func decodeRunwayCentrelinePointFeature(dec *xml.Decoder, start *xml.StartElement, msg *Message, raw *rawRunways) error {
	var f xmlRunwayCentrelinePoint
	if err := dec.DecodeElement(&f, start); err != nil {
		return err
	}
	for i := range f.TimeSlices {
		s := &f.TimeSlices[i]
		if !strings.EqualFold(strings.TrimSpace(s.Interpretation), "BASELINE") {
			msg.SkippedNonBaseline++
			continue
		}
		c := rawCentrelinePoint{
			directionUUID: uuidFromHref(s.OnRunway.Href),
			distances:     map[string]float64{},
		}
		for _, ad := range s.Distances {
			t := strings.ToUpper(strings.TrimSpace(ad.Distance.Type))
			if t == "" {
				continue
			}
			if m, ok := metresFromUOM(ad.Distance.Value.Distance); ok {
				// Keep the first value per (designator, type); a
				// runway may publish per-schedule variants but the
				// row schema only carries one number per direction
				// per type.
				if _, exists := c.distances[t]; !exists {
					c.distances[t] = m
				}
			}
		}
		if len(c.distances) == 0 {
			continue
		}
		raw.centrelines = append(raw.centrelines, c)
	}
	return nil
}

// uuidFromHref normalises the publisher-dependent xlink:href forms
// to a bare UUID matching the gml:identifier scheme:
//
//   - "urn:uuid:<UUID>"  NATS UK convention
//   - "#urn.uuid.<UUID>" ENAIRE LE_Amdt_*_<ICAO>.xml convention
//   - "#uuid.<UUID>"     ENAIRE twin-aerodrome / ADHP convention
//   - "#<gml-id>"        Donlon convention (legacy)
//   - "<UUID>"           bare UUID; pass through
//
// External xlinks (no fragment identifier, no urn:uuid:) pass
// through unchanged so the caller can log them and decide what to
// do.
func uuidFromHref(href string) string {
	s := strings.TrimSpace(href)
	s = strings.TrimPrefix(s, "#")
	switch {
	case strings.HasPrefix(s, "urn:uuid:"):
		return strings.TrimPrefix(s, "urn:uuid:")
	case strings.HasPrefix(s, "urn.uuid."):
		return strings.TrimPrefix(s, "urn.uuid.")
	case strings.HasPrefix(s, "uuid."):
		return strings.TrimPrefix(s, "uuid.")
	}
	return s
}

// splitRunwayDesignator splits "09L/27R" into ("09L", "27R"). A
// single-direction designator returns (s, "").
func splitRunwayDesignator(s string) (string, string) {
	s = strings.TrimSpace(s)
	if i := strings.Index(s, "/"); i >= 0 {
		return strings.TrimSpace(s[:i]), strings.TrimSpace(s[i+1:])
	}
	return s, ""
}
