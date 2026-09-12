package aixm5

import (
	"encoding/xml"
	"strconv"
	"strings"
)

// xmlEquipment is a generic typed feature record for any of
// aixm:VOR, aixm:DME, aixm:NDB, aixm:TACAN. The fields populated
// vary by element kind:
//
//   - VOR  : Frequency, Location, Elevation
//   - DME  : Channel, Location, Elevation
//   - NDB  : Frequency (kHz), Location, Elevation
//   - TACAN: Channel, Location, Elevation
type xmlEquipment struct {
	GMLID           string              `xml:"id,attr"`
	Identifier      string              `xml:"identifier"`
	TimeSlices      []xmlEquipmentSlice `xml:"timeSlice>VORTimeSlice"`
	DMETimeSlices   []xmlEquipmentSlice `xml:"timeSlice>DMETimeSlice"`
	NDBTimeSlices   []xmlEquipmentSlice `xml:"timeSlice>NDBTimeSlice"`
	TACANTimeSlices []xmlEquipmentSlice `xml:"timeSlice>TACANTimeSlice"`
}

type xmlEquipmentSlice struct {
	Interpretation string            `xml:"interpretation"`
	Designator     string            `xml:"designator"`
	Name           string            `xml:"name"`
	Frequency      *xmlUOMValue      `xml:"frequency"`
	Channel        string            `xml:"channel"`
	Location       xmlNavaidLocation `xml:"location"`
}

// xmlNavaidLocation accepts either aixm:ElevatedPoint (carries
// elevation) or plain aixm:Point (no elevation, used by waypoints).
// ENAIRE publishes DesignatedPoints with aixm:Point; NATS uses
// aixm:ElevatedPoint for both navaids and waypoints.
type xmlNavaidLocation struct {
	ElevPos  string       `xml:"ElevatedPoint>pos"`
	ElevElev *xmlUOMValue `xml:"ElevatedPoint>elevation"`
	PlainPos string       `xml:"Point>pos"`
}

// Pos returns the first non-empty location string (ElevatedPoint
// wins, plain Point falls back).
func (l *xmlNavaidLocation) Pos() string {
	if l.ElevPos != "" {
		return l.ElevPos
	}
	return l.PlainPos
}

// xmlDesignatedPoint mirrors aixm:DesignatedPoint (5-letter waypoint
// or named compulsory reporting point).
type xmlDesignatedPoint struct {
	GMLID      string                    `xml:"id,attr"`
	Identifier string                    `xml:"identifier"`
	TimeSlices []xmlDesignatedPointSlice `xml:"timeSlice>DesignatedPointTimeSlice"`
}

type xmlDesignatedPointSlice struct {
	Interpretation string            `xml:"interpretation"`
	Designator     string            `xml:"designator"`
	Name           string            `xml:"name"`
	Type           string            `xml:"type"`
	Location       xmlNavaidLocation `xml:"location"`
}

// xmlNavaidGroup mirrors the composite aixm:Navaid feature; it
// groups co-located equipment (e.g. VOR + DME → VOR-DME) and
// xlinks each component.
type xmlNavaidGroup struct {
	GMLID      string                `xml:"id,attr"`
	Identifier string                `xml:"identifier"`
	TimeSlices []xmlNavaidGroupSlice `xml:"timeSlice>NavaidTimeSlice"`
}

type xmlNavaidGroupSlice struct {
	Interpretation string               `xml:"interpretation"`
	Designator     string               `xml:"designator"`
	Name           string               `xml:"name"`
	Type           string               `xml:"type"` // VOR_DME / VORTAC / ILS_DME / ...
	Components     []xmlNavaidComponent `xml:"navaidEquipment>NavaidComponent"`
	Location       xmlNavaidLocation    `xml:"location"`
}

type xmlNavaidComponent struct {
	TheNavaidEquipment xmlHref `xml:"theNavaidEquipment"`
}

// rawNavaids collects feature streams before composite resolution.
type rawNavaids struct {
	vors    []rawNavaid
	dmes    []rawNavaid
	ndbs    []rawNavaid
	tacans  []rawNavaid
	dpoints []rawNavaid
	groups  []rawNavaidGroup
}

type rawNavaid struct {
	id         string
	designator string
	name       string
	lat, lon   float64
	hasPos     bool
	elevM      *float64
	freqMHz    *float64
	freqKHz    *float64
	channel    string
	dpnType    string // DesignatedPoint type (ICAO / COORD / ...); classifies waypoints
}

type rawNavaidGroup struct {
	id           string
	designator   string
	name         string
	groupType    string // VOR_DME, VORTAC, ...
	lat, lon     float64
	hasPos       bool
	componentIDs []string // UUIDs of the referenced VOR / DME / etc.
}

// decodeVORFeature, decodeDMEFeature, decodeNDBFeature,
// decodeTACANFeature: same generic shape, different time-slice
// element name. We share the xml struct via separate slice fields
// so encoding/xml's namespace-blind matching pulls the right slice.
// The equipment kind itself is re-derived by resolveNavaids from
// which per-type slice a record sits in.
func decodeVORFeature(dec *xml.Decoder, start *xml.StartElement, raw *rawNavaids, msg *Message) error {
	return decodeEquipment(dec, start, &raw.vors, msg)
}

func decodeDMEFeature(dec *xml.Decoder, start *xml.StartElement, raw *rawNavaids, msg *Message) error {
	return decodeEquipment(dec, start, &raw.dmes, msg)
}

func decodeNDBFeature(dec *xml.Decoder, start *xml.StartElement, raw *rawNavaids, msg *Message) error {
	return decodeEquipment(dec, start, &raw.ndbs, msg)
}

func decodeTACANFeature(dec *xml.Decoder, start *xml.StartElement, raw *rawNavaids, msg *Message) error {
	return decodeEquipment(dec, start, &raw.tacans, msg)
}

// decodeEquipment streams the per-type element (aixm:VOR / DME /
// NDB / TACAN), accepting any time-slice variant the source uses.
func decodeEquipment(dec *xml.Decoder, start *xml.StartElement, into *[]rawNavaid, msg *Message) error {
	var f xmlEquipment
	if err := dec.DecodeElement(&f, start); err != nil {
		return err
	}
	slices := f.TimeSlices
	if len(slices) == 0 {
		slices = f.DMETimeSlices
	}
	if len(slices) == 0 {
		slices = f.NDBTimeSlices
	}
	if len(slices) == 0 {
		slices = f.TACANTimeSlices
	}
	for i := range slices {
		s := &slices[i]
		if !strings.EqualFold(strings.TrimSpace(s.Interpretation), "BASELINE") {
			msg.SkippedNonBaseline++
			continue
		}
		n := rawNavaid{
			id:         featureIdentifier(f.GMLID, f.Identifier),
			designator: strings.TrimSpace(s.Designator),
			name:       strings.TrimSpace(s.Name),
			channel:    strings.TrimSpace(s.Channel),
		}
		if lat, lon, ok := parsePos(s.Location.Pos()); ok {
			n.lat, n.lon, n.hasPos = round5(lat), round5(lon), true
		}
		if m, ok := metresFromUOM(s.Location.ElevElev); ok {
			n.elevM = &m
		}
		if s.Frequency != nil {
			if f, unit, ok := parseFrequency(s.Frequency); ok {
				switch unit {
				case "MHZ":
					n.freqMHz = &f
				case "KHZ":
					n.freqKHz = &f
				}
			}
		}
		*into = append(*into, n)
	}
	return nil
}

func decodeDesignatedPointFeature(dec *xml.Decoder, start *xml.StartElement, raw *rawNavaids, msg *Message) error {
	var f xmlDesignatedPoint
	if err := dec.DecodeElement(&f, start); err != nil {
		return err
	}
	for i := range f.TimeSlices {
		s := &f.TimeSlices[i]
		if !strings.EqualFold(strings.TrimSpace(s.Interpretation), "BASELINE") {
			msg.SkippedNonBaseline++
			continue
		}
		n := rawNavaid{
			id:         featureIdentifier(f.GMLID, f.Identifier),
			designator: strings.TrimSpace(s.Designator),
			name:       strings.TrimSpace(s.Name),
			dpnType:    strings.TrimSpace(s.Type),
		}
		if lat, lon, ok := parsePos(s.Location.Pos()); ok {
			n.lat, n.lon, n.hasPos = round5(lat), round5(lon), true
		}
		raw.dpoints = append(raw.dpoints, n)
	}
	return nil
}

func decodeNavaidGroupFeature(dec *xml.Decoder, start *xml.StartElement, raw *rawNavaids, msg *Message) error {
	var f xmlNavaidGroup
	if err := dec.DecodeElement(&f, start); err != nil {
		return err
	}
	for i := range f.TimeSlices {
		s := &f.TimeSlices[i]
		if !strings.EqualFold(strings.TrimSpace(s.Interpretation), "BASELINE") {
			msg.SkippedNonBaseline++
			continue
		}
		g := rawNavaidGroup{
			id:         featureIdentifier(f.GMLID, f.Identifier),
			designator: strings.TrimSpace(s.Designator),
			name:       strings.TrimSpace(s.Name),
			groupType:  strings.TrimSpace(s.Type),
		}
		if lat, lon, ok := parsePos(s.Location.Pos()); ok {
			g.lat, g.lon, g.hasPos = round5(lat), round5(lon), true
		}
		for _, c := range s.Components {
			if id := uuidFromHref(c.TheNavaidEquipment.Href); id != "" {
				g.componentIDs = append(g.componentIDs, id)
			}
		}
		raw.groups = append(raw.groups, g)
	}
	return nil
}

// parseFrequency parses a frequency literal+uom into (MHz/KHz value,
// unit, ok). Used by both equipment time-slice frequency and DME
// "ghost" frequency back-references.
func parseFrequency(v *xmlUOMValue) (val float64, unit string, ok bool) {
	if v == nil {
		return 0, "", false
	}
	x, err := strconv.ParseFloat(strings.TrimSpace(v.Value), 64)
	if err != nil {
		return 0, "", false
	}
	return x, strings.ToUpper(strings.TrimSpace(v.UOM)), true
}

// resolveNavaids flattens the per-type equipment streams plus the
// composite aixm:Navaid groups into a single msg.Navaids slice. A
// component referenced by a composite group is *suppressed* from the
// standalone slice; the group's row carries the merged frequency /
// channel.
//
// Composite type mapping:
//   - VOR + DME → "VOR-DME"
//   - VOR + TACAN → "VORTAC"
//   - ILS-localised composites are not emitted (no ILS support yet).
func resolveNavaids(msg *Message, raw *rawNavaids) {
	byID := map[string]*rawNavaid{}
	add := func(slice []rawNavaid) {
		for i := range slice {
			r := &slice[i]
			byID[r.id] = r
		}
	}
	add(raw.vors)
	add(raw.dmes)
	add(raw.ndbs)
	add(raw.tacans)
	add(raw.dpoints)

	// First emit composite navaids; mark their components as
	// consumed so we don't emit them twice.
	consumed := map[string]bool{}
	for i := range raw.groups {
		g := &raw.groups[i]
		typeCode := compositeType(g.groupType)
		if typeCode == "" {
			// Unknown / unsupported composite; emit a generic
			// row labelled with whatever the AIXM said.
			typeCode = strings.ToUpper(strings.ReplaceAll(g.groupType, "_", "-"))
			if typeCode == "" {
				continue
			}
		}
		out := Navaid{
			ID:         g.id,
			Type:       typeCode,
			Designator: g.designator,
			Name:       g.name,
		}
		if g.hasPos {
			out.Lat, out.Lon = g.lat, g.lon
		}
		// Fold component frequency / channel / elevation.
		for _, cid := range g.componentIDs {
			c, ok := byID[cid]
			if !ok {
				msg.UnresolvedXlinks++
				continue
			}
			consumed[cid] = true
			if !out.hasPos() && c.hasPos {
				out.Lat, out.Lon = c.lat, c.lon
			}
			if out.ElevM == nil && c.elevM != nil {
				out.ElevM = c.elevM
			}
			if out.FreqMHz == nil && c.freqMHz != nil {
				out.FreqMHz = c.freqMHz
			}
			if out.FreqKHz == nil && c.freqKHz != nil {
				out.FreqKHz = c.freqKHz
			}
			if out.Channel == "" && c.channel != "" {
				out.Channel = c.channel
			}
		}
		msg.Navaids = append(msg.Navaids, out)
	}

	emit := func(slice []rawNavaid, kind string) {
		for i := range slice {
			r := &slice[i]
			if consumed[r.id] {
				continue
			}
			t := kind
			if t == "" {
				t = designatedPointType(r.dpnType)
				if t == "" {
					continue // ADHP designated point on an aerodrome
				}
			}
			out := Navaid{
				ID:         r.id,
				Type:       t,
				Designator: r.designator,
				Name:       r.name,
				ElevM:      r.elevM,
				FreqMHz:    r.freqMHz,
				FreqKHz:    r.freqKHz,
				Channel:    r.channel,
			}
			if r.hasPos {
				out.Lat, out.Lon = r.lat, r.lon
			}
			msg.Navaids = append(msg.Navaids, out)
		}
	}
	emit(raw.vors, "VOR")
	emit(raw.dmes, "DME")
	emit(raw.ndbs, "NDB")
	emit(raw.tacans, "TACAN")
	emit(raw.dpoints, "") // classify designated points by their AIXM type
}

// designatedPointType maps an AIXM DesignatedPoint type to the SPA navaid
// type: the 5-letter ICAO points are RNAV waypoints; ADHP points sit on an
// aerodrome (the airport symbol already covers them) and return "" to be
// dropped; everything else (COORD, OTHER, named points) is a VFR reporting
// point.
func designatedPointType(dpnType string) string {
	switch strings.ToUpper(strings.TrimSpace(dpnType)) {
	case "ICAO":
		return "WAYPOINT"
	case "ADHP":
		return ""
	default:
		return "VFR_REPORTING_POINT"
	}
}

// compositeType maps the AIXM 5.1 codeNavaidService composite type
// to the SPA-facing type code. Empty for unsupported composites.
func compositeType(t string) string {
	switch strings.ToUpper(strings.TrimSpace(t)) {
	case "VOR_DME", "VOR-DME":
		return "VOR-DME"
	case "VORTAC":
		return "VORTAC"
	case "TACAN":
		return "TACAN"
	case "NDB_DME":
		return "NDB-DME"
	}
	return ""
}

// hasPos reports whether the Navaid has a valid lat/lon. Used as
// a guard when folding component locations into a composite parent
// that didn't carry its own position.
func (n Navaid) hasPos() bool {
	return n.Lat != 0 || n.Lon != 0
}
