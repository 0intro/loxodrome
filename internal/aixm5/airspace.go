package aixm5

import (
	"encoding/xml"
	"fmt"
	"slices"
	"strconv"
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

// xmlAirspaceActivation collects the activation's status, its annotations
// and (where structured) the Timesheet schedule.
type xmlAirspaceActivation struct {
	Status      string         `xml:"status"`
	Annotations []xmlNote      `xml:"annotation>Note"`
	Timesheets  []xmlTimesheet `xml:"timeInterval>Timesheet"`
}

// xmlTimesheet mirrors aixm:Timesheet. Only the fields needed for a
// readable text representation are captured.
type xmlTimesheet struct {
	TimeReference            string       `xml:"timeReference"`
	StartDate                string       `xml:"startDate"`
	EndDate                  string       `xml:"endDate"`
	Day                      string       `xml:"day"`
	DayTil                   string       `xml:"dayTil"`
	StartTime                string       `xml:"startTime"`
	StartEvent               string       `xml:"startEvent"`
	StartTimeRelativeEvent   *xmlUOMValue `xml:"startTimeRelativeEvent"`
	StartEventInterpretation string       `xml:"startEventInterpretation"`
	EndTime                  string       `xml:"endTime"`
	EndEvent                 string       `xml:"endEvent"`
	EndTimeRelativeEvent     *xmlUOMValue `xml:"endTimeRelativeEvent"`
	EndEventInterpretation   string       `xml:"endEventInterpretation"`
	DaylightSavingAdjust     string       `xml:"daylightSavingAdjust"`
	Excluded                 string       `xml:"excluded"`
}

type xmlAirspaceLayerClass struct {
	Classification string             `xml:"classification"`
	Levels         []xmlAirspaceLayer `xml:"associatedLevels>AirspaceLayer"`
}

// xmlAirspaceLayer is one vertical band a class applies to; its limits are
// read only to recover a datum its volume leaves unstated (layerReference).
type xmlAirspaceLayer struct {
	UpperLimit    *xmlUOMValue `xml:"upperLimit"`
	UpperLimitRef string       `xml:"upperLimitReference"`
	LowerLimit    *xmlUOMValue `xml:"lowerLimit"`
	LowerLimitRef string       `xml:"lowerLimitReference"`
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
		a.ClassCode = classOf(s.Classes)
		if len(s.GeometryComponents) == 1 {
			a.ClassBands = classBands(s.Classes)
		}
		a.Rmk = collectRemarkNotes(s.Annotations)
		a.WorkHr = collectActivationHours(s.Activations)
		a.Activity = collectActivationStatus(s.Activations)
		if len(s.GeometryComponents) == 0 {
			a.NoProjection = true
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
			for _, lim := range []*VerticalLimit{c.UpperLimit, c.LowerLimit} {
				if ref, ok := layerReference(s.Classes, lim); ok {
					lim.Ref = ref
					msg.LimitRefsFromLayers++
				}
			}
			surface := v.Surface
			if surface == nil {
				surface = v.ElevatedSurface
			}
			// No surface, or one with no patch (NATS writes an empty
			// <gml:patches/> beside a contributor link): no boundary of its
			// own, unlike one whose patches decode to nothing.
			c.NoProjection = surface == nil || len(surface.Patches) == 0
			parts, err := surfaceParts(surface, msg)
			if err != nil {
				return fmt.Errorf("airspace %s: %w", c.ID, err)
			}
			// A boundary following a GeoBorder waits for the border,
			// which the message may hold further on (border.go).
			if hasBorderLink(parts) {
				c.borderParts = parts
			} else {
				c.Ring = ringFromParts(parts)
			}
			msg.Airspaces = append(msg.Airspaces, c)
		}
	}
	return nil
}

// classOf returns an airspace's class: its one classification, or the
// most restrictive of several. ENAIRE lists a TMA's class layers in no
// order of their own: TMA PALMA's read G, D, C, A, class A holding from
// each sector's floor to FL195.
func classOf(classes []xmlAirspaceLayerClass) string {
	if len(classes) == 1 {
		return strings.TrimSpace(classes[0].Classification)
	}
	best := ""
	for _, c := range classes {
		if v := strings.TrimSpace(c.Classification); classRank(v) < classRank(best) {
			best = v
		}
	}
	return best
}

// classRank orders the ICAO airspace classes from the most restrictive, A,
// to the least, G (SERA Appendix 4). Anything else ranks after G.
func classRank(class string) int {
	if len(class) == 1 && 'A' <= class[0] && class[0] <= 'G' {
		return int(class[0] - 'A')
	}
	return 'G' - 'A' + 1
}

// classBands returns the bands of an airspace stacking several classes,
// one per level of each class layer, from the least restrictive class to
// the most. Nil unless there are two or more and each states both its
// limits: a layer stating none says nothing of where its class holds (TMA
// PALMA's G and D, the visual corridors, are stated in a remark).
func classBands(classes []xmlAirspaceLayerClass) []ClassBand {
	var out []ClassBand
	for _, c := range classes {
		if len(c.Levels) == 0 {
			return nil
		}
		for _, l := range c.Levels {
			upper := limitFromXML(l.UpperLimit, l.UpperLimitRef)
			lower := limitFromXML(l.LowerLimit, l.LowerLimitRef)
			if upper == nil || lower == nil || upper.Value == "" || lower.Value == "" {
				return nil
			}
			out = append(out, ClassBand{
				Class:      strings.TrimSpace(c.Classification),
				UpperLimit: upper,
				LowerLimit: lower,
			})
		}
	}
	if len(out) < 2 {
		return nil
	}
	slices.SortStableFunc(out, func(a, b ClassBand) int {
		return classRank(b.Class) - classRank(a.Class)
	})
	return out
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
		parts = append(parts, activationHours(a)...)
	}
	return strings.Join(parts, "; ")
}

// activationHours is one activation's hours: its timesheets, else the
// notes annotating it.
func activationHours(a xmlAirspaceActivation) []string {
	var parts []string
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
	return parts
}

// statusWords spells an activation's status (AIXM 5.1
// CodeStatusAirspaceType) as the row's hours remark prints it.
var statusWords = map[string]string{
	"ACTIVE":              "Active",
	"AVBL_FOR_ACTIVATION": "Available for activation",
	"INACTIVE":            "Inactive",
	"INTERMITTENT":        "Intermittent",
	"OTHER":               "Other",
}

// collectActivationStatus pairs each activation's status with its own
// hours, one activation a line ("Available for activation: Activated by
// NOTAM."), which collectActivationHours joins without them, a note's own
// line breaks folded into spaces. NATS states
// ACTIVE or AVBL_FOR_ACTIVATION on 496 of its 808 activations (AIRAC
// 2026-10-29), most of them with a note for hours ("Permanently
// available.", "Activated by NOTAM."). An activation stating none, or a
// status outside the code list, is left out.
func collectActivationStatus(acts []xmlAirspaceActivation) string {
	var lines []string
	for _, a := range acts {
		word, ok := statusWords[strings.ToUpper(strings.TrimSpace(a.Status))]
		if !ok {
			continue
		}
		// A note's own line breaks fold, a line being one activation.
		if hours := strings.Join(strings.Fields(strings.Join(activationHours(a), "; ")), " "); hours != "" {
			word += ": " + hours
		}
		lines = append(lines, word)
	}
	return strings.Join(lines, "\n")
}

// formatTimesheet renders a timesheet in the AIP's own form: its days
// (MON-FRI), its window from a clock time or an event (SR, SS+30), the
// summer window in brackets where the times move with summer time (UK AIP
// GEN 2.1 2.2: "Times applicable during the summer period are given in
// brackets"), and the part of the year it covers ahead of it:
//
//	01 APR-30 SEP: MON-FRI 05:00-17:00 (04:00-16:00)
//	ANY 08:00-SS+30 MAX 16:00
//
// A bound stating a clock time and an event says which applies, the
// earlier (the event at the clock time's MAX) or the later (its MNM), and
// one saying neither is its event: EDRK's 00:00 beside SS+30 closes
// nothing.
func formatTimesheet(ts xmlTimesheet) string {
	if allTheTime(ts) {
		return "H24"
	}
	window := func(shift int) string {
		start := boundOf(ts.StartTime, ts.StartEvent, ts.StartTimeRelativeEvent, ts.StartEventInterpretation, shift)
		end := boundOf(ts.EndTime, ts.EndEvent, ts.EndTimeRelativeEvent, ts.EndEventInterpretation, shift)
		if start == "" && end == "" {
			return ""
		}
		return start + "-" + end
	}
	days, times := dayRange(ts.Day, ts.DayTil), window(0)
	if days == "" && times == "" {
		return ""
	}
	out := strings.TrimSpace(days + " " + times)
	if strings.EqualFold(strings.TrimSpace(ts.DaylightSavingAdjust), "YES") {
		if summer := window(-60); summer != times {
			out += " (" + summer + ")"
		}
	}
	if season := Season(ts.StartDate, ts.EndDate); season != "" {
		out = season + ": " + out
	}
	if strings.EqualFold(strings.TrimSpace(ts.Excluded), "YES") {
		out = "excl. " + out
	}
	return out
}

// allTheTime reports whether a timesheet covers every day of the year
// from midnight to midnight, which the AIP states as H24. The DFS writes
// it day ANY to ANY, 00:00-00:00, Sakaeronavigatsia the same, NATS
// 00:00-24:00 with no day. Dates other than the whole year, a day other
// than ANY, an event or an exclusion make it a schedule.
func allTheTime(ts xmlTimesheet) bool {
	day := strings.TrimSpace(ts.Day)
	til := strings.TrimSpace(ts.DayTil)
	start := strings.TrimSpace(ts.StartTime)
	end := strings.TrimSpace(ts.EndTime)
	return (day == "" || day == "ANY") && (til == "" || til == "ANY") &&
		start == "00:00" && (end == "00:00" || end == "24:00") &&
		eventOf(ts.StartEvent) == "" && eventOf(ts.EndEvent) == "" &&
		Season(ts.StartDate, ts.EndDate) == "" &&
		!strings.EqualFold(strings.TrimSpace(ts.Excluded), "YES")
}

// dayRange renders a timesheet's days: one day, or the first and the last
// of a range (MON-FRI). AIXM's day codes are kept as they are (ANY, HOL,
// WORK_DAY).
func dayRange(day, til string) string {
	day, til = strings.TrimSpace(day), strings.TrimSpace(til)
	if til == "" || til == day {
		return day
	}
	return day + "-" + til
}

// boundOf renders one end of a timesheet's window: its clock time moved by
// shift minutes, its event with the minutes from it (SR-30, SS+30), or the
// event with the clock time it may not pass (interpretation EARLIEST, MAX)
// or precede (LATEST, MNM). An event is never moved: sunset is sunset in
// summer too.
func boundOf(clock, event string, offset *xmlUOMValue, interpretation string, shift int) string {
	clock = shiftClock(strings.TrimSpace(clock), shift)
	ev := eventOf(event)
	if ev == "" {
		return clock
	}
	if n := offsetMinutes(offset); n != 0 {
		ev += fmt.Sprintf("%+d", n)
	}
	if clock != "" {
		switch strings.ToUpper(strings.TrimSpace(interpretation)) {
		case "EARLIEST":
			return ev + " MAX " + clock
		case "LATEST":
			return ev + " MNM " + clock
		}
	}
	return ev
}

// eventOf returns a timesheet's event code (SR, SS), or "" for none and
// for OTHER, which names no event.
func eventOf(event string) string {
	ev := strings.TrimSpace(event)
	if strings.EqualFold(ev, "OTHER") {
		return ""
	}
	return ev
}

// offsetMinutes reads the minutes a bound lies from its event, 0 when the
// timesheet states none.
func offsetMinutes(v *xmlUOMValue) int {
	if v == nil {
		return 0
	}
	n, err := strconv.Atoi(strings.TrimSpace(v.Value))
	if err != nil {
		return 0
	}
	if strings.EqualFold(strings.TrimSpace(v.UOM), "HR") {
		n *= 60
	}
	return n
}

// shiftClock moves an hh:mm clock time by shift minutes, around the clock:
// 00:00 an hour earlier is 23:00. A time that does not parse is returned
// as it is.
func shiftClock(clock string, shift int) string {
	if shift == 0 {
		return clock
	}
	h, m, ok := strings.Cut(clock, ":")
	hh, err1 := strconv.Atoi(h)
	mm, err2 := strconv.Atoi(m)
	if !ok || err1 != nil || err2 != nil {
		return clock
	}
	t := ((hh*60+mm+shift)%(24*60) + 24*60) % (24 * 60)
	return fmt.Sprintf("%02d:%02d", t/60, t%60)
}

// Season renders the part of the year a timesheet covers, from its
// startDate and endDate: "" for the whole year, else its first and last
// days, 01 APR-30 SEP, the start and the end of summer time written SDLST
// and EDLST as the DFS writes them. cmd/faa renders the FAA's timesheets
// with it, so the hours column reads alike whoever published it.
func Season(from, to string) string {
	from, to = strings.TrimSpace(from), strings.TrimSpace(to)
	if (from == "" && to == "") || (from == "01-01" && to == "31-12") {
		return ""
	}
	return dateOf(from) + "-" + dateOf(to)
}

var monthNames = [...]string{"JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"}

// dateOf renders a timesheet's dd-mm date as 01 APR, and any other date
// (SDLST, EDLST) as it is.
func dateOf(d string) string {
	day, month, ok := strings.Cut(d, "-")
	m, err := strconv.Atoi(month)
	if !ok || len(day) != 2 || err != nil || m < 1 || m > 12 {
		return d
	}
	return day + " " + monthNames[m-1]
}

// limitFromXML packages an aixm:upperLimit / aixm:lowerLimit and
// its companion *Reference into a VerticalLimit. Returns nil when
// both inputs are empty (the AIXM permits omitting the volume's
// limits when the airspace has no vertical extent of its own).
// layerReference recovers the datum a volume's limit leaves unstated from
// the class layers of the same airspace. ENAIRE's export from the AIRAC
// cycle of 2026-10-01 (Amdt 411) writes every AirspaceVolume's limits with
// no upperLimitReference / lowerLimitReference, where its earlier ones
// stated both, while each AirspaceLayerClass's associatedLevels still state
// theirs. A layer stating the same value in the same unit is stating that
// limit: on ENAIRE's own 2026-07 export, which carried both, the layer's
// datum matched the volume's for 377 of the 392 limits a layer repeated,
// and 12 of the 15 others were floors at 0, where SFC, MSL and ENAIRE's
// OTHER:AGL_AMSL are one level. Layers stating the value under two datums
// say nothing, a stated reference is never overridden, and a flight level
// needs none. The restricted, danger and prohibited areas carry no class,
// so theirs stay unstated.
func layerReference(classes []xmlAirspaceLayerClass, lim *VerticalLimit) (string, bool) {
	if lim == nil || lim.Ref != "" || lim.Value == "" || strings.EqualFold(lim.Unit, "FL") {
		return "", false
	}
	found := ""
	for _, c := range classes {
		for _, l := range c.Levels {
			for _, side := range []struct {
				v   *xmlUOMValue
				ref string
			}{{l.UpperLimit, l.UpperLimitRef}, {l.LowerLimit, l.LowerLimitRef}} {
				ref := strings.TrimSpace(side.ref)
				if side.v == nil || ref == "" ||
					strings.TrimSpace(side.v.Value) != lim.Value ||
					!strings.EqualFold(strings.TrimSpace(side.v.UOM), lim.Unit) {
					continue
				}
				if found != "" && found != ref {
					return "", false
				}
				found = ref
			}
		}
	}
	return found, found != ""
}

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
