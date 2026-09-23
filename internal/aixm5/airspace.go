package aixm5

import (
	"encoding/xml"
	"fmt"
	"strings"
)

// xmlAirspace mirrors the aixm:Airspace tree. Only the fields the
// SPA's airspace overlay needs are decoded.
type xmlAirspace struct {
	GMLID      string             `xml:"id,attr"`
	Identifier string             `xml:"identifier"`
	TimeSlices []xmlAirspaceSlice `xml:"timeSlice>AirspaceTimeSlice"`
}

type xmlAirspaceSlice struct {
	Interpretation     string                  `xml:"interpretation"`
	Type               string                  `xml:"type"`
	LocalType          string                  `xml:"localType"`
	Designator         string                  `xml:"designator"`
	Name               string                  `xml:"name"`
	Classes            []xmlAirspaceLayerClass `xml:"class>AirspaceLayerClass"`
	GeometryComponents []xmlAirspaceGeomComp   `xml:"geometryComponent>AirspaceGeometryComponent"`
	Annotations        []xmlNote               `xml:"annotation>Note"`
	Activations        []xmlAirspaceActivation `xml:"activation>AirspaceActivation"`
}

// xmlNote mirrors aixm:Note. ENAIRE puts free-text into aixm:note;
// NATS uses aixm:LinguisticNote/note. Both forms decode here because
// the field is matched by local name (the Lang tag tracks the
// publisher's chosen locale; we only care about the text).
type xmlNote struct {
	Purpose       string             `xml:"purpose"`
	PropertyName  string             `xml:"propertyName"`
	LinguisticTxt []xmlLinguisticTxt `xml:"translatedNote>LinguisticNote"`
}

type xmlLinguisticTxt struct {
	Lang string `xml:"lang,attr"`
	Note string `xml:"note"`
}

// xmlAirspaceActivation collects the activation annotations and
// (where structured) the Timesheet schedule.
type xmlAirspaceActivation struct {
	Annotations []xmlNote      `xml:"annotation>Note"`
	Timesheets  []xmlTimesheet `xml:"timeInterval>Timesheet"`
}

// xmlTimesheet mirrors aixm:Timesheet. Only the fields needed for a
// readable text representation are captured.
type xmlTimesheet struct {
	TimeReference string `xml:"timeReference"`
	Day           string `xml:"day"`
	StartTime     string `xml:"startTime"`
	EndTime       string `xml:"endTime"`
	Excluded      string `xml:"excluded"`
}

type xmlAirspaceLayerClass struct {
	Classification string `xml:"classification"`
}

type xmlAirspaceGeomComp struct {
	Volume xmlAirspaceVolume `xml:"theAirspaceVolume>AirspaceVolume"`
}

type xmlAirspaceVolume struct {
	UpperLimit    *xmlUOMValue `xml:"upperLimit"`
	UpperLimitRef string       `xml:"upperLimitReference"`
	LowerLimit    *xmlUOMValue `xml:"lowerLimit"`
	LowerLimitRef string       `xml:"lowerLimitReference"`
	// Two AIXM 5.1 alternatives: <aixm:Surface> for plain polygons,
	// <aixm:ElevatedSurface> for surfaces with elevation context. Both
	// carry the same gml:patches structure; pick whichever the source
	// populates.
	Surface         *gmlSurface `xml:"horizontalProjection>Surface"`
	ElevatedSurface *gmlSurface `xml:"horizontalProjection>ElevatedSurface"`
}

type xmlUOMValue struct {
	UOM   string `xml:"uom,attr"`
	Value string `xml:",chardata"`
}

// decodeAirspaceFeature consumes the <aixm:Airspace> element and
// appends one Airspace per BASELINE timeslice geometry component
// (typically exactly one) to msg.Airspaces; the components share the
// slice's identity and each carries its own ring and vertical limits
// (AIXM 5.1 allows 0..* components, e.g. a TMA aggregated from
// sectors with different limits). Features using more than one
// component count to msg.MultiComponentAirspaces so the meta sidecar
// surfaces the pattern. Non-BASELINE slices count to
// msg.SkippedNonBaseline and are dropped. A timeslice without any
// geometry component is decoded with an empty Ring; the caller
// emits a row anyway (vertical-only airspaces don't get a polygon
// but the metadata still matters for things like FIR class).
func decodeAirspaceFeature(dec *xml.Decoder, start *xml.StartElement, msg *Message) error {
	var f xmlAirspace
	if err := dec.DecodeElement(&f, start); err != nil {
		return err
	}
	for i := range f.TimeSlices {
		s := &f.TimeSlices[i]
		if !strings.EqualFold(strings.TrimSpace(s.Interpretation), "BASELINE") {
			msg.SkippedNonBaseline++
			continue
		}
		a := Airspace{
			ID:         featureIdentifier(f.GMLID, f.Identifier),
			Designator: strings.TrimSpace(s.Designator),
			Name:       strings.TrimSpace(s.Name),
			Type:       strings.TrimSpace(s.Type),
			LocalType:  strings.TrimSpace(s.LocalType),
		}
		if len(s.Classes) > 0 {
			a.ClassCode = strings.TrimSpace(s.Classes[0].Classification)
		}
		a.Rmk = collectRemarkNotes(s.Annotations)
		a.WorkHr = collectActivationHours(s.Activations)
		if len(s.GeometryComponents) == 0 {
			msg.Airspaces = append(msg.Airspaces, a)
			continue
		}
		if len(s.GeometryComponents) > 1 {
			msg.MultiComponentAirspaces++
		}
		for ci := range s.GeometryComponents {
			v := &s.GeometryComponents[ci].Volume
			c := a
			c.UpperLimit = limitFromXML(v.UpperLimit, v.UpperLimitRef)
			c.LowerLimit = limitFromXML(v.LowerLimit, v.LowerLimitRef)
			surface := v.Surface
			if surface == nil {
				surface = v.ElevatedSurface
			}
			ring, err := ringFromSurface(surface, msg)
			if err != nil {
				return fmt.Errorf("airspace %s: %w", c.ID, err)
			}
			c.Ring = ring
			msg.Airspaces = append(msg.Airspaces, c)
		}
	}
	return nil
}

// collectRemarkNotes joins every aixm:Note whose purpose is REMARK
// (or unset) into one string, separated by "; ". Other purposes
// (WARNING, ALERT, DESCRIPTION, ...) are skipped because they're
// not what the SPA's rmk column displays.
func collectRemarkNotes(notes []xmlNote) string {
	var parts []string
	for _, n := range notes {
		switch strings.ToUpper(strings.TrimSpace(n.Purpose)) {
		case "", "REMARK", "DESCRIPTION":
			// keep
		default:
			continue
		}
		for _, t := range n.LinguisticTxt {
			if v := strings.TrimSpace(t.Note); v != "" {
				parts = append(parts, v)
			}
		}
	}
	return strings.Join(parts, "; ")
}

// collectActivationHours assembles a workHr-style string from the
// activation block. Structured Timesheets (Day + Start-End) win;
// free-text annotations on activation fill in when no Timesheet is
// published.
func collectActivationHours(acts []xmlAirspaceActivation) string {
	var parts []string
	for _, a := range acts {
		for _, ts := range a.Timesheets {
			if entry := formatTimesheet(ts); entry != "" {
				parts = append(parts, entry)
			}
		}
		if len(a.Timesheets) == 0 {
			for _, n := range a.Annotations {
				for _, t := range n.LinguisticTxt {
					if v := strings.TrimSpace(t.Note); v != "" {
						parts = append(parts, v)
					}
				}
			}
		}
	}
	return strings.Join(parts, "; ")
}

func formatTimesheet(ts xmlTimesheet) string {
	day := strings.TrimSpace(ts.Day)
	start := strings.TrimSpace(ts.StartTime)
	end := strings.TrimSpace(ts.EndTime)
	if day == "ANY" && start == "00:00" && end == "24:00" {
		return "H24"
	}
	if day == "" && start == "" && end == "" {
		return ""
	}
	out := strings.TrimSpace(strings.Join([]string{day, start + "-" + end}, " "))
	if strings.EqualFold(strings.TrimSpace(ts.Excluded), "YES") {
		out = "excl. " + out
	}
	return out
}

// limitFromXML packages an aixm:upperLimit / aixm:lowerLimit and
// its companion *Reference into a VerticalLimit. Returns nil when
// both inputs are empty (the AIXM permits omitting the volume's
// limits when the airspace has no vertical extent of its own).
func limitFromXML(v *xmlUOMValue, ref string) *VerticalLimit {
	if v == nil && ref == "" {
		return nil
	}
	out := &VerticalLimit{Ref: strings.TrimSpace(ref)}
	if v != nil {
		out.Value = strings.TrimSpace(v.Value)
		out.Unit = strings.TrimSpace(v.UOM)
	}
	if out.Value == "" && out.Unit == "" && out.Ref == "" {
		return nil
	}
	return out
}
