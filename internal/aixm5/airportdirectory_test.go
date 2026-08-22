package aixm5

import (
	"reflect"
	"testing"
)

// The AIP directory content the decoder lifts off an AirportHeliport:
// the annotations, the operator contacts and the operating schedule.
// Both publisher dialects of a telephone number appear, because they
// really do differ: ED0042 writes the number into an annotation on the
// TelephoneContact (the DFS convention, which publishes no aixm:voice
// at all), EGXB into the schema's own voice / facsimile fields (NATS
// and ENAIRE). A note with no propertyName decodes too, ENAIRE
// leaving it out on nearly all of them.
const directorySrc = `<?xml version="1.0"?>
<AIXMBasicMessage>
 <hasMember>
  <AirportHeliport gml:id="uuid.bb000000-0000-0000-0000-000000000001">
   <timeSlice>
    <AirportHeliportTimeSlice>
     <interpretation>BASELINE</interpretation>
     <designator>ED0042</designator>
     <name>KLINIKUM TESTSTADT</name>
     <type>HP</type>
     <annotation>
      <Note>
       <propertyName>type</propertyName>
       <purpose>REMARK</purpose>
       <translatedNote><LinguisticNote><note>Heliport/Hospital</note></LinguisticNote></translatedNote>
      </Note>
     </annotation>
     <annotation>
      <Note>
       <propertyName>ARP</propertyName>
       <purpose>REMARK</purpose>
       <translatedNote><LinguisticNote><note>1.5 NM SE Flughafen Teststadt</note></LinguisticNote></translatedNote>
      </Note>
     </annotation>
     <availability>
      <AirportHeliportAvailability>
       <operationalStatus>NORMAL</operationalStatus>
       <timeInterval>
        <Timesheet><day>ANY</day><startTime>00:00</startTime><endTime>24:00</endTime></Timesheet>
       </timeInterval>
       <annotation>
        <Note>
         <propertyName>usage</propertyName>
         <translatedNote><LinguisticNote><note>multi-engine helicopters, performance class 1, HEMS</note></LinguisticNote></translatedNote>
        </Note>
       </annotation>
      </AirportHeliportAvailability>
     </availability>
     <contact>
      <ContactInformation>
       <name>STADT TESTSTADT</name>
       <address><PostalAddress><deliveryPoint>Hauptstrasse 1, 12345 Teststadt</deliveryPoint></PostalAddress></address>
       <phoneFax>
        <TelephoneContact>
         <annotation>
          <Note>
           <propertyName>voice</propertyName>
           <translatedNote><LinguisticNote><note>+49 123 4567 (Feuerwehr)</note></LinguisticNote></translatedNote>
          </Note>
         </annotation>
         <annotation>
          <Note>
           <propertyName>facsimile</propertyName>
           <translatedNote><LinguisticNote><note>+49 123 4568</note></LinguisticNote></translatedNote>
          </Note>
         </annotation>
        </TelephoneContact>
       </phoneFax>
       <networkNode><OnlineContact><linkage>mailto:ops@teststadt.de</linkage></OnlineContact></networkNode>
      </ContactInformation>
     </contact>
    </AirportHeliportTimeSlice>
   </timeSlice>
  </AirportHeliport>
 </hasMember>
 <hasMember>
  <AirportHeliport gml:id="uuid.bb000000-0000-0000-0000-000000000002">
   <timeSlice>
    <AirportHeliportTimeSlice>
     <interpretation>BASELINE</interpretation>
     <designator>EGXB</designator>
     <name>PORTLAND TEST</name>
     <type>HP</type>
     <annotation>
      <Note>
       <purpose>REMARK</purpose>
       <translatedNote><LinguisticNote><note>Level surface.</note></LinguisticNote></translatedNote>
      </Note>
     </annotation>
     <availability>
      <AirportHeliportAvailability>
       <timeInterval>
        <Timesheet><day>MON</day><dayTil>FRI</dayTil><startTime>09:00</startTime><endTime>16:00</endTime></Timesheet>
       </timeInterval>
      </AirportHeliportAvailability>
     </availability>
     <contact>
      <ContactInformation>
       <phoneFax>
        <TelephoneContact>
         <annotation>
          <Note>
           <propertyName>voice</propertyName>
           <translatedNote><LinguisticNote><note>(Admin)</note></LinguisticNote></translatedNote>
          </Note>
         </annotation>
         <voice>+44 1305 000000</voice>
         <facsimile>+44 1305 000001</facsimile>
        </TelephoneContact>
       </phoneFax>
       <networkNode><OnlineContact><eMail>ops@portland.test</eMail></OnlineContact></networkNode>
      </ContactInformation>
     </contact>
    </AirportHeliportTimeSlice>
   </timeSlice>
  </AirportHeliport>
 </hasMember>
</AIXMBasicMessage>`

func TestDecodeAirportDirectory(t *testing.T) {
	msg, err := Decode([]byte(directorySrc))
	if err != nil {
		t.Fatal(err)
	}
	if len(msg.Airports) != 2 {
		t.Fatalf("airports = %d, want 2", len(msg.Airports))
	}
	byID := map[string]*Airport{}
	for i := range msg.Airports {
		byID[msg.Airports[i].Designator] = &msg.Airports[i]
	}

	de := byID["ED0042"]
	if de == nil {
		t.Fatal("ED0042 missing")
	}
	// The feature's own annotations first, then the availability's, so
	// an emitter reading in order sees the field before its usage.
	want := []Note{
		{PropertyName: "type", Purpose: "REMARK", Text: "Heliport/Hospital"},
		{PropertyName: "ARP", Purpose: "REMARK", Text: "1.5 NM SE Flughafen Teststadt"},
		{PropertyName: "usage", Text: "multi-engine helicopters, performance class 1, HEMS"},
	}
	if !reflect.DeepEqual(de.Notes, want) {
		t.Errorf("ED0042 notes = %+v, want %+v", de.Notes, want)
	}
	if !reflect.DeepEqual(de.Hours, []string{"H24"}) {
		t.Errorf("ED0042 hours = %v, want [H24]", de.Hours)
	}
	if len(de.Contacts) != 1 {
		t.Fatalf("ED0042 contacts = %d, want 1", len(de.Contacts))
	}
	c := de.Contacts[0]
	if c.Name != "STADT TESTSTADT" || c.Address != "Hauptstrasse 1, 12345 Teststadt" {
		t.Errorf("ED0042 contact = %+v", c)
	}
	// The number lives in the annotation, not in aixm:voice.
	if !reflect.DeepEqual(c.Phone, []string{"+49 123 4567 (Feuerwehr)"}) ||
		!reflect.DeepEqual(c.Fax, []string{"+49 123 4568"}) ||
		!reflect.DeepEqual(c.Web, []string{"mailto:ops@teststadt.de"}) {
		t.Errorf("ED0042 contact details = %+v", c)
	}

	uk := byID["EGXB"]
	if uk == nil {
		t.Fatal("EGXB missing")
	}
	// A note the publisher leaves untyped still decodes; the emitters
	// decide what to do with one they cannot file.
	if len(uk.Notes) != 1 || uk.Notes[0].PropertyName != "" || uk.Notes[0].Text != "Level surface." {
		t.Errorf("EGXB notes = %+v", uk.Notes)
	}
	if len(uk.Hours) != 1 || uk.Hours[0] == "H24" || uk.Hours[0] == "" {
		t.Errorf("EGXB hours = %v, want a rendered window", uk.Hours)
	}
	uc := uk.Contacts[0]
	// The annotation beside the number is its LABEL and joins it.
	if !reflect.DeepEqual(uc.Phone, []string{"+44 1305 000000 (Admin)"}) ||
		!reflect.DeepEqual(uc.Fax, []string{"+44 1305 000001"}) ||
		!reflect.DeepEqual(uc.Email, []string{"ops@portland.test"}) {
		t.Errorf("EGXB contact = %+v", uc)
	}
	// A contact block with nothing in it is dropped rather than emitted
	// empty, so an emitter never renders a blank heading.
	if got := collectContacts([]xmlContactInfo{{}}); got != nil {
		t.Errorf("empty contact = %+v, want none", got)
	}
}
