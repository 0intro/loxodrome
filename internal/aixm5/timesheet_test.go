package aixm5

import "testing"

// TestFormatTimesheetH24 pins the whole-day forms the publishers file for
// H24: the DFS and Sakaeronavigatsia write day ANY to ANY, 00:00-00:00
// (ED-R 146 BERLIN, the ED-R nuclear sites, UG-R 57), NATS 00:00-24:00
// with no day (EGLL, H24 in its AD 2.3). Read as "ANY 00:00-00:00", an
// H24 restricted area was a schedule nobody could read, and the alerts
// graded it caution instead of avoid.
func TestFormatTimesheetH24(t *testing.T) {
	cases := []struct {
		name string
		ts   xmlTimesheet
		want string
	}{
		{"DFS", xmlTimesheet{Day: "ANY", DayTil: "ANY", StartTime: "00:00", EndTime: "00:00", Excluded: "NO"}, "H24"},
		{"ANY to 24:00", xmlTimesheet{Day: "ANY", StartTime: "00:00", EndTime: "24:00"}, "H24"},
		{"NATS, no day", xmlTimesheet{StartTime: "00:00", EndTime: "24:00", Excluded: "NO"}, "H24"},
		{"whole year", xmlTimesheet{StartDate: "01-01", EndDate: "31-12", Day: "ANY", StartTime: "00:00", EndTime: "24:00"}, "H24"},
		{"a season", xmlTimesheet{StartDate: "01-04", EndDate: "30-09", Day: "ANY", StartTime: "00:00", EndTime: "00:00"}, "01 APR-30 SEP: ANY 00:00-00:00"},
		{"sunrise to sunset", xmlTimesheet{Day: "ANY", StartTime: "00:00", StartEvent: "SR", EndTime: "00:00", EndEvent: "SS"}, "ANY SR-SS"},
		{"excluded", xmlTimesheet{Day: "ANY", DayTil: "ANY", StartTime: "00:00", EndTime: "00:00", Excluded: "YES"}, "excl. ANY 00:00-00:00"},
		{"one day", xmlTimesheet{Day: "MON", StartTime: "00:00", EndTime: "24:00"}, "MON 00:00-24:00"},
		{"a window", xmlTimesheet{Day: "MON", StartTime: "07:00", EndTime: "22:30"}, "MON 07:00-22:30"},
	}
	for _, c := range cases {
		if got := formatTimesheet(c.ts); got != c.want {
			t.Errorf("%s: formatTimesheet(%+v) = %q, want %q", c.name, c.ts, got, c.want)
		}
	}
}

// TestDecodeH24Activation reads ED-R 146 BERLIN's activation as the DFS
// files it.
func TestDecodeH24Activation(t *testing.T) {
	const doc = `<?xml version="1.0"?>
<message:AIXMBasicMessage xmlns:message="http://www.aixm.aero/schema/5.1.1/message"
    xmlns:aixm="http://www.aixm.aero/schema/5.1.1" xmlns:gml="http://www.opengis.net/gml/3.2">
  <message:hasMember>
    <aixm:Airspace gml:id="a1">
      <gml:identifier codeSpace="urn:uuid:">edr146</gml:identifier>
      <aixm:timeSlice><aixm:AirspaceTimeSlice gml:id="t1">
        <aixm:interpretation>BASELINE</aixm:interpretation>
        <aixm:type>R</aixm:type>
        <aixm:designator>EDR146</aixm:designator>
        <aixm:name>BERLIN</aixm:name>
        <aixm:activation><aixm:AirspaceActivation gml:id="act1">
          <aixm:timeInterval><aixm:Timesheet gml:id="ts1">
            <aixm:timeReference>UTC</aixm:timeReference>
            <aixm:startDate/><aixm:endDate/>
            <aixm:day>ANY</aixm:day><aixm:dayTil>ANY</aixm:dayTil>
            <aixm:startTime>00:00</aixm:startTime><aixm:startEvent/>
            <aixm:endTime>00:00</aixm:endTime><aixm:endEvent/>
            <aixm:daylightSavingAdjust>NO</aixm:daylightSavingAdjust>
            <aixm:excluded>NO</aixm:excluded>
          </aixm:Timesheet></aixm:timeInterval>
          <aixm:activity>MILOPS</aixm:activity>
        </aixm:AirspaceActivation></aixm:activation>
      </aixm:AirspaceTimeSlice></aixm:timeSlice>
    </aixm:Airspace>
  </message:hasMember>
</message:AIXMBasicMessage>`
	msg, err := Decode([]byte(doc))
	if err != nil {
		t.Fatal(err)
	}
	if len(msg.Airspaces) != 1 || msg.Airspaces[0].WorkHr != "H24" {
		t.Fatalf("airspaces = %+v, want EDR146 with WorkHr H24", msg.Airspaces)
	}
}

// TestFormatTimesheet pins the DFS's schedules as its files state them.
// ED-R 32A MUNSTER A is MON to FRI 05:00-17:00, an hour earlier in summer,
// and read day and times alone it was "MON 05:00-17:00" all year. A
// sunrise to sunset schedule read "ANY -".
func TestFormatTimesheet(t *testing.T) {
	mins := func(n string) *xmlUOMValue { return &xmlUOMValue{UOM: "MIN", Value: n} }
	cases := []struct {
		name string
		ts   xmlTimesheet
		want string
	}{
		{"ED-R 32A", xmlTimesheet{StartDate: "01-01", EndDate: "31-12", Day: "MON", DayTil: "FRI",
			StartTime: "05:00", EndTime: "17:00", DaylightSavingAdjust: "YES"},
			"MON-FRI 05:00-17:00 (04:00-16:00)"},
		{"one day", xmlTimesheet{Day: "TUE", DayTil: "TUE", StartTime: "07:00", EndTime: "22:30"}, "TUE 07:00-22:30"},
		{"sunrise to sunset", xmlTimesheet{StartDate: "01-01", EndDate: "31-12", Day: "ANY",
			StartEvent: "SR", EndEvent: "SS", DaylightSavingAdjust: "NO"},
			"ANY SR-SS"},
		{"an event is never moved", xmlTimesheet{Day: "FRI", DayTil: "FRI", StartTime: "14:00",
			EndEvent: "SS", DaylightSavingAdjust: "YES"},
			"FRI 14:00-SS (13:00-SS)"},
		{"minutes from an event", xmlTimesheet{Day: "ANY", StartEvent: "SR", StartTimeRelativeEvent: mins("-30"),
			EndEvent: "SS", EndTimeRelativeEvent: mins("30")},
			"ANY SR-30-SS+30"},
		{"after sunset", xmlTimesheet{Day: "MON", StartEvent: "SS", StartTimeRelativeEvent: mins("30"), EndTime: "23:00"},
			"MON SS+30-23:00"},
		{"no offset", xmlTimesheet{Day: "ANY", StartEvent: "SR", StartTimeRelativeEvent: mins("0"), EndEvent: "SS"},
			"ANY SR-SS"},
		{"hours from an event", xmlTimesheet{Day: "ANY", StartTime: "07:00", EndEvent: "SS",
			EndTimeRelativeEvent: &xmlUOMValue{UOM: "HR", Value: "2"}},
			"ANY 07:00-SS+120"},
		{"the earlier", xmlTimesheet{StartDate: "SDLST", EndDate: "EDLST", Day: "ANY", StartTime: "08:00",
			EndTime: "16:00", EndEvent: "SS", EndTimeRelativeEvent: mins("30"), EndEventInterpretation: "EARLIEST"},
			"SDLST-EDLST: ANY 08:00-SS+30 MAX 16:00"},
		{"the later", xmlTimesheet{StartDate: "EDLST", EndDate: "SDLST", Day: "ANY", StartTime: "09:00",
			EndTime: "17:30", EndEvent: "SS", EndEventInterpretation: "LATEST"},
			"EDLST-SDLST: ANY 09:00-SS MNM 17:30"},
		{"the earlier in summer", xmlTimesheet{Day: "MON", StartTime: "07:00", EndTime: "21:00", EndEvent: "SS",
			EndEventInterpretation: "EARLIEST", DaylightSavingAdjust: "YES"},
			"MON 07:00-SS MAX 21:00 (06:00-SS MAX 20:00)"},
		{"no interpretation", xmlTimesheet{StartDate: "01-03", EndDate: "31-10", Day: "SAT", StartTime: "08:00",
			EndTime: "00:00", EndEvent: "SS", EndTimeRelativeEvent: mins("30")},
			"01 MAR-31 OCT: SAT 08:00-SS+30"},
		{"OTHER names no event", xmlTimesheet{Day: "MON", DayTil: "THU", StartTime: "07:00", StartEvent: "OTHER",
			EndTime: "23:00", EndEvent: "OTHER"},
			"MON-THU 07:00-23:00"},
		{"around midnight", xmlTimesheet{Day: "ANY", StartTime: "00:00", EndTime: "05:00", DaylightSavingAdjust: "YES"},
			"ANY 00:00-05:00 (23:00-04:00)"},
		{"a season across the new year", xmlTimesheet{StartDate: "01-11", EndDate: "28-02", Day: "WORK_DAY",
			StartTime: "08:00", EndEvent: "SS"},
			"01 NOV-28 FEB: WORK_DAY 08:00-SS"},
		{"excluded", xmlTimesheet{StartDate: "24-12", EndDate: "26-12", Day: "ANY", StartTime: "00:00",
			EndTime: "24:00", Excluded: "YES"},
			"excl. 24 DEC-26 DEC: ANY 00:00-24:00"},
		{"nothing", xmlTimesheet{TimeReference: "UTC", DaylightSavingAdjust: "NO"}, ""},
	}
	for _, c := range cases {
		if got := formatTimesheet(c.ts); got != c.want {
			t.Errorf("%s: formatTimesheet(%+v) = %q, want %q", c.name, c.ts, got, c.want)
		}
	}
}

// TestDecodeActivationSchedule reads ED-R 32A MUNSTER A's activation as
// the DFS files it: MON to FRI 05:00-17:00, an hour earlier in summer.
func TestDecodeActivationSchedule(t *testing.T) {
	const doc = `<?xml version="1.0"?>
<message:AIXMBasicMessage xmlns:message="http://www.aixm.aero/schema/5.1.1/message"
    xmlns:aixm="http://www.aixm.aero/schema/5.1.1" xmlns:gml="http://www.opengis.net/gml/3.2"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <message:hasMember>
    <aixm:Airspace gml:id="a1">
      <gml:identifier codeSpace="urn:uuid:">edr32a</gml:identifier>
      <aixm:timeSlice><aixm:AirspaceTimeSlice gml:id="t1">
        <aixm:interpretation>BASELINE</aixm:interpretation>
        <aixm:type>R</aixm:type>
        <aixm:designator>EDR32A</aixm:designator>
        <aixm:name>MUNSTER A</aixm:name>
        <aixm:activation><aixm:AirspaceActivation gml:id="act1">
          <aixm:timeInterval><aixm:Timesheet gml:id="ts1">
            <aixm:timeReference>UTC</aixm:timeReference>
            <aixm:startDate>01-01</aixm:startDate><aixm:endDate>31-12</aixm:endDate>
            <aixm:day>MON</aixm:day><aixm:dayTil>FRI</aixm:dayTil>
            <aixm:startTime>05:00</aixm:startTime><aixm:startEvent/>
            <aixm:startTimeRelativeEvent xsi:nil="true" uom="MIN" nilReason="unknown"/>
            <aixm:endTime>17:00</aixm:endTime><aixm:endEvent/>
            <aixm:endTimeRelativeEvent xsi:nil="true" uom="MIN" nilReason="unknown"/>
            <aixm:daylightSavingAdjust>YES</aixm:daylightSavingAdjust>
          </aixm:Timesheet></aixm:timeInterval>
          <aixm:activity>MILOPS</aixm:activity>
        </aixm:AirspaceActivation></aixm:activation>
      </aixm:AirspaceTimeSlice></aixm:timeSlice>
    </aixm:Airspace>
  </message:hasMember>
</message:AIXMBasicMessage>`
	msg, err := Decode([]byte(doc))
	if err != nil {
		t.Fatal(err)
	}
	if len(msg.Airspaces) != 1 || msg.Airspaces[0].WorkHr != "MON-FRI 05:00-17:00 (04:00-16:00)" {
		t.Fatalf("airspaces = %+v, want EDR32A with WorkHr MON-FRI 05:00-17:00 (04:00-16:00)", msg.Airspaces)
	}
}

// TestDecodeActivationStatus pairs each activation's status with its own
// hours, as NATS files EGD061 WOODBURY COMMON (UK AIP ENR 5.1: "Hours:
// Activated by NOTAM.") and the DFS a weekday timetable, a note's line
// break folded. An activation stating no status is left out.
func TestDecodeActivationStatus(t *testing.T) {
	const doc = `<?xml version="1.0"?>
<message:AIXMBasicMessage xmlns:message="http://www.aixm.aero/schema/5.1/message"
    xmlns:aixm="http://www.aixm.aero/schema/5.1" xmlns:gml="http://www.opengis.net/gml/3.2">
  <message:hasMember>
    <aixm:Airspace gml:id="a1">
      <gml:identifier codeSpace="urn:uuid:">egd061</gml:identifier>
      <aixm:timeSlice><aixm:AirspaceTimeSlice gml:id="t1">
        <aixm:interpretation>BASELINE</aixm:interpretation>
        <aixm:type>D</aixm:type>
        <aixm:designator>EGD061</aixm:designator>
        <aixm:name>WOODBURY COMMON</aixm:name>
        <aixm:activation><aixm:AirspaceActivation gml:id="id172946">
          <aixm:annotation><aixm:Note gml:id="id172947">
            <aixm:propertyName>timeInterval</aixm:propertyName>
            <aixm:purpose>OTHER:AIXM45_MAPPING</aixm:purpose>
            <aixm:translatedNote><aixm:LinguisticNote gml:id="id172948">
              <aixm:note lang="eng">Activated by NOTAM.</aixm:note>
            </aixm:LinguisticNote></aixm:translatedNote>
          </aixm:Note></aixm:annotation>
          <aixm:annotation><aixm:Note gml:id="id172949">
            <aixm:propertyName>timeInterval</aixm:propertyName>
            <aixm:purpose>WARNING</aixm:purpose>
            <aixm:translatedNote><aixm:LinguisticNote gml:id="id172950">
              <aixm:note lang="eng">activity periods
to be published by NOTAM</aixm:note>
            </aixm:LinguisticNote></aixm:translatedNote>
          </aixm:Note></aixm:annotation>
          <aixm:status>AVBL_FOR_ACTIVATION</aixm:status>
        </aixm:AirspaceActivation></aixm:activation>
        <aixm:activation><aixm:AirspaceActivation gml:id="act2">
          <aixm:timeInterval><aixm:Timesheet gml:id="ts2">
            <aixm:timeReference>UTC</aixm:timeReference>
            <aixm:day>MON</aixm:day><aixm:dayTil>FRI</aixm:dayTil>
            <aixm:startTime>05:00</aixm:startTime><aixm:endTime>17:00</aixm:endTime>
            <aixm:daylightSavingAdjust>YES</aixm:daylightSavingAdjust>
          </aixm:Timesheet></aixm:timeInterval>
          <aixm:status>ACTIVE</aixm:status>
        </aixm:AirspaceActivation></aixm:activation>
        <aixm:activation><aixm:AirspaceActivation gml:id="act3">
          <aixm:annotation><aixm:Note gml:id="n3">
            <aixm:translatedNote><aixm:LinguisticNote gml:id="l3">
              <aixm:note lang="eng">OTHER</aixm:note>
            </aixm:LinguisticNote></aixm:translatedNote>
          </aixm:Note></aixm:annotation>
        </aixm:AirspaceActivation></aixm:activation>
      </aixm:AirspaceTimeSlice></aixm:timeSlice>
    </aixm:Airspace>
  </message:hasMember>
</message:AIXMBasicMessage>`
	msg, err := Decode([]byte(doc))
	if err != nil {
		t.Fatal(err)
	}
	const want = "Available for activation: Activated by NOTAM.; activity periods to be published by NOTAM\n" +
		"Active: MON-FRI 05:00-17:00 (04:00-16:00)"
	if len(msg.Airspaces) != 1 || msg.Airspaces[0].Activity != want {
		t.Fatalf("airspaces = %+v, want EGD061 with Activity %q", msg.Airspaces, want)
	}
}
