package aixm5

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// radioFreqs lists the frequencies of a radio slice in order.
func radioFreqs(rs []RadioChannel) []string {
	out := make([]string, 0, len(rs))
	for _, r := range rs {
		out = append(out, r.Freq)
	}
	return out
}

// TestDecodeDonlonRadios pins the service -> channel chain on the Donlon
// reference set. AMSWELL CONTROL lists four channels, the last of them an HF
// channel in kHz; the decoder used to keep only that last link, so the FIR
// carried 4689.5 and nothing else. Every VHF channel is kept, in the order
// the service lists them, and the kHz one is dropped and counted: the radio
// column is MHz throughout and no reader converts. DONLON TOWER links two
// channels carrying one frequency, which the FIR-side dedup folds to one.
func TestDecodeDonlonRadios(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("testdata", "donlon-aip.xml"))
	if err != nil {
		t.Fatal(err)
	}
	msg, err := Decode(src)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	amswell := findAirspace(msg, "f4d5e4d4-d84a-481f-b9e3-b359e42c0dff")
	if amswell == nil {
		t.Fatal("AMSWELL FIR not decoded")
	}
	if got, want := radioFreqs(amswell.Radio), []string{"120.300", "117.900", "121.500"}; !reflect.DeepEqual(got, want) {
		t.Errorf("AMSWELL radio = %v, want %v", got, want)
	}
	for _, r := range amswell.Radio {
		if r.Unit != "AMSWELL CONTROL" || r.CallSign != "AMSWELL CONTROL" {
			t.Errorf("AMSWELL channel %s = (%q, %q), want AMSWELL CONTROL twice", r.Freq, r.Unit, r.CallSign)
		}
	}
	if msg.SkippedRadioChannels != 1 {
		t.Errorf("SkippedRadioChannels = %d, want 1 (the 4689.5 kHz channel)", msg.SkippedRadioChannels)
	}
	tower := findAirspace(msg, "21a13c9f-a8ff-4fdd-9aaa-5dbfd91514b9")
	if tower == nil {
		t.Fatal("DONLON CTR not decoded")
	}
	if got, want := radioFreqs(tower.Radio), []string{"118.100"}; !reflect.DeepEqual(got, want) {
		t.Errorf("DONLON CTR radio = %v, want %v", got, want)
	}
}

// serviceMessage is a NATS-shaped message: one CTR, one ATZ and two
// aerodromes, the services linking them to their channels the way the UK
// dataset does (several radioCommunication links per service, guard listed
// last, a tower service carrying its ground and delivery call signs).
const serviceMessage = `<?xml version="1.0"?>
<AIXMBasicMessage>
 <hasMember>
  <Airspace gml:id="uuid.a0000000-0000-0000-0000-000000000001">
   <timeSlice><AirspaceTimeSlice>
    <interpretation>BASELINE</interpretation>
    <type>CTR</type>
    <designator>EGKKCTR</designator>
    <name>CTR LONDON GATWICK</name>
    <geometryComponent><AirspaceGeometryComponent><theAirspaceVolume><AirspaceVolume>
     <horizontalProjection><Surface><patches><PolygonPatch><exterior><Ring><curveMember><Curve><segments>
      <GeodesicString><posList>51 -0.3 51 0 51.3 0 51.3 -0.3 51 -0.3</posList></GeodesicString>
     </segments></Curve></curveMember></Ring></exterior></PolygonPatch></patches></Surface></horizontalProjection>
    </AirspaceVolume></theAirspaceVolume></AirspaceGeometryComponent></geometryComponent>
   </AirspaceTimeSlice></timeSlice>
  </Airspace>
 </hasMember>
 <hasMember>
  <Airspace gml:id="uuid.a0000000-0000-0000-0000-000000000002">
   <timeSlice><AirspaceTimeSlice>
    <interpretation>BASELINE</interpretation>
    <type>ATZ</type>
    <designator>EGCMATZ</designator>
    <name>FENTON ATZ</name>
    <geometryComponent><AirspaceGeometryComponent><theAirspaceVolume><AirspaceVolume>
     <horizontalProjection><Surface><patches><PolygonPatch><exterior><Ring><curveMember><Curve><segments>
      <GeodesicString><posList>53 -2.2 53 -2.1 53.1 -2.1 53.1 -2.2 53 -2.2</posList></GeodesicString>
     </segments></Curve></curveMember></Ring></exterior></PolygonPatch></patches></Surface></horizontalProjection>
    </AirspaceVolume></theAirspaceVolume></AirspaceGeometryComponent></geometryComponent>
   </AirspaceTimeSlice></timeSlice>
  </Airspace>
 </hasMember>
 <hasMember>
  <AirportHeliport gml:id="uuid.b0000000-0000-0000-0000-000000000001">
   <timeSlice><AirportHeliportTimeSlice>
    <interpretation>BASELINE</interpretation>
    <designator>EGKK</designator>
    <name>LONDON GATWICK</name>
    <locationIndicatorICAO>EGKK</locationIndicatorICAO>
    <ARP><ElevatedPoint><pos>51.1481 -0.1903</pos></ElevatedPoint></ARP>
   </AirportHeliportTimeSlice></timeSlice>
  </AirportHeliport>
 </hasMember>
 <hasMember>
  <AirportHeliport gml:id="uuid.b0000000-0000-0000-0000-000000000002">
   <timeSlice><AirportHeliportTimeSlice>
    <interpretation>BASELINE</interpretation>
    <designator>EGCM</designator>
    <name>FENTON</name>
    <locationIndicatorICAO>EGCM</locationIndicatorICAO>
    <ARP><ElevatedPoint><pos>53.05 -2.15</pos></ElevatedPoint></ARP>
   </AirportHeliportTimeSlice></timeSlice>
  </AirportHeliport>
 </hasMember>
 <hasMember>
  <AirTrafficControlService gml:id="uuid.c0000000-0000-0000-0000-000000000001">
   <timeSlice><AirTrafficControlServiceTimeSlice>
    <interpretation>BASELINE</interpretation>
    <call-sign><CallsignDetail><callSign>GATWICK DIRECTOR</callSign><language>ENG</language></CallsignDetail></call-sign>
    <radioCommunication xlink:href="urn:uuid:d0000000-0000-0000-0000-000000000001"/>
    <radioCommunication xlink:href="urn:uuid:d0000000-0000-0000-0000-00000000dead"/>
    <radioCommunication xlink:href="urn:uuid:d0000000-0000-0000-0000-000000000002"/>
    <clientAirspace xlink:href="urn:uuid:a0000000-0000-0000-0000-000000000001"/>
    <clientAirport xlink:href="urn:uuid:b0000000-0000-0000-0000-000000000001"/>
    <type>APP</type>
   </AirTrafficControlServiceTimeSlice></timeSlice>
  </AirTrafficControlService>
 </hasMember>
 <hasMember>
  <AirTrafficControlService gml:id="uuid.c0000000-0000-0000-0000-000000000002">
   <timeSlice><AirTrafficControlServiceTimeSlice>
    <interpretation>BASELINE</interpretation>
    <call-sign><CallsignDetail><callSign>GATWICK TOWER</callSign><language>ENG</language></CallsignDetail></call-sign>
    <call-sign><CallsignDetail><callSign>GATWICK DELIVERY</callSign><language>ENG</language></CallsignDetail></call-sign>
    <call-sign><CallsignDetail><callSign>GATWICK GROUND</callSign><language>ENG</language></CallsignDetail></call-sign>
    <call-sign><CallsignDetail><callSign>GATWICK TURM</callSign><language>GER</language></CallsignDetail></call-sign>
    <radioCommunication xlink:href="urn:uuid:d0000000-0000-0000-0000-000000000003"/>
    <radioCommunication xlink:href="urn:uuid:d0000000-0000-0000-0000-000000000004"/>
    <radioCommunication xlink:href="urn:uuid:d0000000-0000-0000-0000-000000000005"/>
    <radioCommunication xlink:href="urn:uuid:d0000000-0000-0000-0000-000000000002"/>
    <clientAirspace xlink:href="urn:uuid:a0000000-0000-0000-0000-000000000001"/>
    <clientAirport xlink:href="urn:uuid:b0000000-0000-0000-0000-000000000001"/>
    <type>TWR</type>
   </AirTrafficControlServiceTimeSlice></timeSlice>
  </AirTrafficControlService>
 </hasMember>
 <hasMember>
  <AirTrafficControlService gml:id="uuid.c0000000-0000-0000-0000-000000000003">
   <timeSlice><AirTrafficControlServiceTimeSlice>
    <interpretation>BASELINE</interpretation>
    <call-sign><CallsignDetail><callSign>FENTON RADIO</callSign><language>ENG</language></CallsignDetail></call-sign>
    <call-sign><CallsignDetail><callSign>FENTON FIRE</callSign><language>ENG</language></CallsignDetail></call-sign>
    <radioCommunication xlink:href="urn:uuid:d0000000-0000-0000-0000-000000000006"/>
    <radioCommunication xlink:href="urn:uuid:d0000000-0000-0000-0000-000000000007"/>
    <clientAirspace xlink:href="urn:uuid:a0000000-0000-0000-0000-000000000002"/>
    <clientAirport xlink:href="urn:uuid:b0000000-0000-0000-0000-000000000002"/>
    <type>OTHER</type>
   </AirTrafficControlServiceTimeSlice></timeSlice>
  </AirTrafficControlService>
 </hasMember>
 <hasMember>
  <InformationService gml:id="uuid.c0000000-0000-0000-0000-000000000004">
   <timeSlice><InformationServiceTimeSlice>
    <interpretation>BASELINE</interpretation>
    <call-sign><CallsignDetail><callSign>FENTON HF</callSign><language>ENG</language></CallsignDetail></call-sign>
    <radioCommunication xlink:href="urn:uuid:d0000000-0000-0000-0000-000000000008"/>
    <clientAirspace xlink:href="urn:uuid:a0000000-0000-0000-0000-000000000002"/>
    <type>FIS</type>
   </InformationServiceTimeSlice></timeSlice>
  </InformationService>
 </hasMember>
 <hasMember><RadioCommunicationChannel gml:id="uuid.d0000000-0000-0000-0000-000000000001"><timeSlice><RadioCommunicationChannelTimeSlice>
  <interpretation>BASELINE</interpretation><frequencyTransmission uom="MHZ">126.825</frequencyTransmission>
 </RadioCommunicationChannelTimeSlice></timeSlice></RadioCommunicationChannel></hasMember>
 <hasMember><RadioCommunicationChannel gml:id="uuid.d0000000-0000-0000-0000-000000000002"><timeSlice><RadioCommunicationChannelTimeSlice>
  <interpretation>BASELINE</interpretation><frequencyTransmission uom="MHZ">121.500</frequencyTransmission>
 </RadioCommunicationChannelTimeSlice></timeSlice></RadioCommunicationChannel></hasMember>
 <hasMember><RadioCommunicationChannel gml:id="uuid.d0000000-0000-0000-0000-000000000003"><timeSlice><RadioCommunicationChannelTimeSlice>
  <interpretation>BASELINE</interpretation><frequencyTransmission uom="MHZ">124.230</frequencyTransmission>
 </RadioCommunicationChannelTimeSlice></timeSlice></RadioCommunicationChannel></hasMember>
 <hasMember><RadioCommunicationChannel gml:id="uuid.d0000000-0000-0000-0000-000000000004"><timeSlice><RadioCommunicationChannelTimeSlice>
  <interpretation>BASELINE</interpretation><frequencyTransmission uom="MHZ">121.955</frequencyTransmission>
 </RadioCommunicationChannelTimeSlice></timeSlice></RadioCommunicationChannel></hasMember>
 <hasMember><RadioCommunicationChannel gml:id="uuid.d0000000-0000-0000-0000-000000000005"><timeSlice><RadioCommunicationChannelTimeSlice>
  <interpretation>BASELINE</interpretation><frequencyTransmission uom="MHZ">121.805</frequencyTransmission>
 </RadioCommunicationChannelTimeSlice></timeSlice></RadioCommunicationChannel></hasMember>
 <hasMember><RadioCommunicationChannel gml:id="uuid.d0000000-0000-0000-0000-000000000006"><timeSlice><RadioCommunicationChannelTimeSlice>
  <interpretation>BASELINE</interpretation><frequencyTransmission uom="MHZ">121.600</frequencyTransmission>
 </RadioCommunicationChannelTimeSlice></timeSlice></RadioCommunicationChannel></hasMember>
 <hasMember><RadioCommunicationChannel gml:id="uuid.d0000000-0000-0000-0000-000000000007"><timeSlice><RadioCommunicationChannelTimeSlice>
  <interpretation>BASELINE</interpretation><frequencyTransmission uom="MHZ">120.710</frequencyTransmission>
 </RadioCommunicationChannelTimeSlice></timeSlice></RadioCommunicationChannel></hasMember>
 <hasMember><RadioCommunicationChannel gml:id="uuid.d0000000-0000-0000-0000-000000000008"><timeSlice><RadioCommunicationChannelTimeSlice>
  <interpretation>BASELINE</interpretation><frequencyTransmission uom="KHZ">5680</frequencyTransmission>
 </RadioCommunicationChannelTimeSlice></timeSlice></RadioCommunicationChannel></hasMember>
</AIXMBasicMessage>`

// TestServiceChannels pins how a service's channels reach the airspaces and
// aerodromes it serves:
//   - every channel is kept, in the order the service links them (GATWICK
//     DIRECTOR's 126.825 before its guard);
//   - a link to no channel is counted once, the rest of the service stands;
//   - a service with several call signs has each channel answered by the
//     call signs its band belongs to: a channel in the aerodrome surface
//     band takes the ground, delivery, apron and fire call signs, any other
//     channel the rest, the English call signs when the service has any;
//   - a channel only a surface position answers on is no channel of an
//     airspace (FENTON FIRE's 121.600 is not the ATZ's contact);
//   - a channel not in MHz is dropped and counted, never read as MHz.
func TestServiceChannels(t *testing.T) {
	msg, err := Decode([]byte(serviceMessage))
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	ctr := findAirspace(msg, "a0000000-0000-0000-0000-000000000001")
	atz := findAirspace(msg, "a0000000-0000-0000-0000-000000000002")
	if ctr == nil || atz == nil {
		t.Fatalf("airspaces not decoded: %v %v", ctr, atz)
	}
	wantCtr := []RadioChannel{
		{Freq: "126.825", Unit: "GATWICK DIRECTOR", CallSign: "GATWICK DIRECTOR"},
		{Freq: "121.500", Unit: "GATWICK DIRECTOR", CallSign: "GATWICK DIRECTOR"},
		{Freq: "124.230", Unit: "GATWICK TOWER", CallSign: "GATWICK TOWER"},
		{Freq: "121.500", Unit: "GATWICK TOWER", CallSign: "GATWICK TOWER"},
	}
	if !reflect.DeepEqual(ctr.Radio, wantCtr) {
		t.Errorf("CTR radio =\n  %v\nwant\n  %v", ctr.Radio, wantCtr)
	}
	wantAtz := []RadioChannel{{Freq: "120.710", Unit: "FENTON RADIO", CallSign: "FENTON RADIO"}}
	if !reflect.DeepEqual(atz.Radio, wantAtz) {
		t.Errorf("ATZ radio = %v, want %v", atz.Radio, wantAtz)
	}

	var egkk, egcm *Airport
	for i := range msg.Airports {
		switch msg.Airports[i].Designator {
		case "EGKK":
			egkk = &msg.Airports[i]
		case "EGCM":
			egcm = &msg.Airports[i]
		}
	}
	if egkk == nil || egcm == nil {
		t.Fatalf("aerodromes not decoded: %v %v", egkk, egcm)
	}
	const surface = "GATWICK DELIVERY / GATWICK GROUND"
	wantEgkk := []RadioChannel{
		{Freq: "126.825", Unit: "APP", CallSign: "GATWICK DIRECTOR"},
		{Freq: "121.500", Unit: "APP", CallSign: "GATWICK DIRECTOR"},
		{Freq: "124.230", Unit: "TWR", CallSign: "GATWICK TOWER"},
		{Freq: "121.955", Unit: "TWR", CallSign: surface},
		{Freq: "121.805", Unit: "TWR", CallSign: surface},
		{Freq: "121.500", Unit: "TWR", CallSign: "GATWICK TOWER"},
	}
	if !reflect.DeepEqual(egkk.Radio, wantEgkk) {
		t.Errorf("EGKK radio =\n  %v\nwant\n  %v", egkk.Radio, wantEgkk)
	}
	wantEgcm := []RadioChannel{
		{Freq: "121.600", Unit: "OTHER", CallSign: "FENTON FIRE"},
		{Freq: "120.710", Unit: "OTHER", CallSign: "FENTON RADIO"},
	}
	if !reflect.DeepEqual(egcm.Radio, wantEgcm) {
		t.Errorf("EGCM radio = %v, want %v", egcm.Radio, wantEgcm)
	}

	if msg.UnresolvedXlinks != 1 {
		t.Errorf("UnresolvedXlinks = %d, want 1 (the dangling channel link)", msg.UnresolvedXlinks)
	}
	if msg.SkippedRadioChannels != 1 {
		t.Errorf("SkippedRadioChannels = %d, want 1 (the kHz channel)", msg.SkippedRadioChannels)
	}

	// Curated, the tower's surface channels leave the TWR line for the
	// positions that answer on them, each under its own call sign, and the
	// fire channel goes with the rest of the fire service.
	got := CurateAirportRadios(egkk.Radio)
	want := []any{
		[]any{"126.825", "APP", "GATWICK DIRECTOR"},
		[]any{"121.500", "APP", "GATWICK DIRECTOR"},
		[]any{"124.230", "TWR", "GATWICK TOWER"},
		[]any{"121.955", "DEL", "GATWICK DELIVERY"},
		[]any{"121.955", "GND", "GATWICK GROUND"},
		[]any{"121.805", "DEL", "GATWICK DELIVERY"},
		[]any{"121.805", "GND", "GATWICK GROUND"},
		[]any{"121.500", "TWR", "GATWICK TOWER"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("curated EGKK =\n  %v\nwant\n  %v", got, want)
	}
	if got, want := CurateAirportRadios(egcm.Radio), []any{[]any{"120.710", "A/A", "FENTON RADIO"}}; !reflect.DeepEqual(got, want) {
		t.Errorf("curated EGCM = %v, want %v", got, want)
	}
}

// TestServiceCallSignsFallBack covers a service publishing no English call
// sign: every language's call signs answer, which is what the single-call-sign
// reader did before, and a lone call sign takes every channel whatever its
// band.
func TestServiceCallSignsFallBack(t *testing.T) {
	src := []byte(`<?xml version="1.0"?>
<AIXMBasicMessage>
 <hasMember>
  <AirportHeliport gml:id="uuid.b0000000-0000-0000-0000-000000000009">
   <timeSlice><AirportHeliportTimeSlice>
    <interpretation>BASELINE</interpretation>
    <designator>EDDL</designator>
    <locationIndicatorICAO>EDDL</locationIndicatorICAO>
    <ARP><ElevatedPoint><pos>51.28 6.76</pos></ElevatedPoint></ARP>
   </AirportHeliportTimeSlice></timeSlice>
  </AirportHeliport>
 </hasMember>
 <hasMember>
  <AirTrafficControlService gml:id="uuid.c0000000-0000-0000-0000-000000000009">
   <timeSlice><AirTrafficControlServiceTimeSlice>
    <interpretation>BASELINE</interpretation>
    <call-sign><CallsignDetail><callSign>DUESSELDORF VORFELD</callSign><language>GER</language></CallsignDetail></call-sign>
    <radioCommunication xlink:href="urn:uuid:d0000000-0000-0000-0000-000000000009"/>
    <radioCommunication xlink:href="urn:uuid:d0000000-0000-0000-0000-000000000010"/>
    <clientAirport xlink:href="urn:uuid:b0000000-0000-0000-0000-000000000009"/>
    <type>TWR</type>
   </AirTrafficControlServiceTimeSlice></timeSlice>
  </AirTrafficControlService>
 </hasMember>
 <hasMember><RadioCommunicationChannel gml:id="uuid.d0000000-0000-0000-0000-000000000009"><timeSlice><RadioCommunicationChannelTimeSlice>
  <interpretation>BASELINE</interpretation><frequencyTransmission uom="MHZ">121.780</frequencyTransmission>
 </RadioCommunicationChannelTimeSlice></timeSlice></RadioCommunicationChannel></hasMember>
 <hasMember><RadioCommunicationChannel gml:id="uuid.d0000000-0000-0000-0000-000000000010"><timeSlice><RadioCommunicationChannelTimeSlice>
  <interpretation>BASELINE</interpretation><frequencyTransmission uom="MHZ">118.305</frequencyTransmission>
 </RadioCommunicationChannelTimeSlice></timeSlice></RadioCommunicationChannel></hasMember>
</AIXMBasicMessage>`)
	msg, err := Decode(src)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if len(msg.Airports) != 1 {
		t.Fatalf("Airports = %d, want 1", len(msg.Airports))
	}
	want := []RadioChannel{
		{Freq: "121.780", Unit: "TWR", CallSign: "DUESSELDORF VORFELD"},
		{Freq: "118.305", Unit: "TWR", CallSign: "DUESSELDORF VORFELD"},
	}
	if got := msg.Airports[0].Radio; !reflect.DeepEqual(got, want) {
		t.Errorf("EDDL radio = %v, want %v", got, want)
	}
}

// TestSurfaceBand pins the aerodrome surface block's edges in both forms a
// value arrives in, the 8.33 kHz channel name and the frequency, and keeps
// the guard and its protection channel out.
func TestSurfaceBand(t *testing.T) {
	for freq, want := range map[string]bool{
		"121.500":  false,
		"121.525":  false,
		"121.540":  true,
		"121.5417": true,
		"121.600":  true,
		"121.955":  true,
		"121.990":  true,
		"121.9916": true,
		"122.000":  false,
		"118.305":  false,
		"241.925":  false,
		"":         false,
		"UHF":      false,
	} {
		if got := surfaceBand(freq); got != want {
			t.Errorf("surfaceBand(%q) = %v, want %v", freq, got, want)
		}
	}
}

// rankMessage is HEATHROW RADAR as NATS files it for the London CTR: the
// channel to be told onto first, guard, then the VFR one, whose remark is
// the only thing saying it is the channel a VFR crossing calls; and a DFS
// alternate channel listed ahead of its standard one.
const rankMessage = `<?xml version="1.0"?>
<AIXMBasicMessage>
 <hasMember>
  <Airspace gml:id="uuid.a0000000-0000-0000-0000-000000000011">
   <timeSlice><AirspaceTimeSlice>
    <interpretation>BASELINE</interpretation>
    <type>CTR</type>
    <designator>EGLLCTR</designator>
    <name>LONDON CTR</name>
    <geometryComponent><AirspaceGeometryComponent><theAirspaceVolume><AirspaceVolume>
     <horizontalProjection><Surface><patches><PolygonPatch><exterior><Ring><curveMember><Curve><segments>
      <GeodesicString><posList>51.3 -0.6 51.3 -0.2 51.6 -0.2 51.6 -0.6 51.3 -0.6</posList></GeodesicString>
     </segments></Curve></curveMember></Ring></exterior></PolygonPatch></patches></Surface></horizontalProjection>
    </AirspaceVolume></theAirspaceVolume></AirspaceGeometryComponent></geometryComponent>
   </AirspaceTimeSlice></timeSlice>
  </Airspace>
 </hasMember>
 <hasMember>
  <InformationService gml:id="uuid.c0000000-0000-0000-0000-000000000011">
   <timeSlice><InformationServiceTimeSlice>
    <interpretation>BASELINE</interpretation>
    <call-sign><CallsignDetail><callSign>HEATHROW RADAR</callSign><language>eng</language></CallsignDetail></call-sign>
    <radioCommunication xlink:href="urn:uuid:d0000000-0000-0000-0000-000000000011"/>
    <radioCommunication xlink:href="urn:uuid:d0000000-0000-0000-0000-000000000012"/>
    <radioCommunication xlink:href="urn:uuid:d0000000-0000-0000-0000-000000000013"/>
    <radioCommunication xlink:href="urn:uuid:d0000000-0000-0000-0000-000000000014"/>
    <radioCommunication xlink:href="urn:uuid:d0000000-0000-0000-0000-000000000015"/>
    <clientAirspace xlink:href="urn:uuid:a0000000-0000-0000-0000-000000000011"/>
    <type>OTHER:RADAR</type>
   </InformationServiceTimeSlice></timeSlice>
  </InformationService>
 </hasMember>
 <hasMember><RadioCommunicationChannel gml:id="uuid.d0000000-0000-0000-0000-000000000011"><timeSlice><RadioCommunicationChannelTimeSlice>
  <interpretation>BASELINE</interpretation><frequencyTransmission uom="MHZ">127.525</frequencyTransmission>
  <annotation><Note><purpose>REMARK</purpose><translatedNote><LinguisticNote><note lang="eng">When instructed by ATC.</note></LinguisticNote></translatedNote></Note></annotation>
 </RadioCommunicationChannelTimeSlice></timeSlice></RadioCommunicationChannel></hasMember>
 <hasMember><RadioCommunicationChannel gml:id="uuid.d0000000-0000-0000-0000-000000000012"><timeSlice><RadioCommunicationChannelTimeSlice>
  <interpretation>BASELINE</interpretation><frequencyTransmission uom="MHZ">121.500</frequencyTransmission>
  <annotation><Note><purpose>REMARK</purpose><translatedNote><LinguisticNote><note lang="eng">Emergency frequency O/R.</note></LinguisticNote></translatedNote></Note></annotation>
 </RadioCommunicationChannelTimeSlice></timeSlice></RadioCommunicationChannel></hasMember>
 <hasMember><RadioCommunicationChannel gml:id="uuid.d0000000-0000-0000-0000-000000000013"><timeSlice><RadioCommunicationChannelTimeSlice>
  <interpretation>BASELINE</interpretation><frequencyTransmission uom="MHZ">132.450</frequencyTransmission>
  <availability><RadioCommunicationOperationalStatus><annotation><Note><translatedNote><LinguisticNote><note lang="eng">Transit hours 0600-2300.</note></LinguisticNote></translatedNote></Note></annotation></RadioCommunicationOperationalStatus></availability>
  <annotation><Note><purpose>REMARK</purpose><translatedNote><LinguisticNote><note lang="eng">Frequency-CodeType: ALT</note></LinguisticNote></translatedNote></Note></annotation>
 </RadioCommunicationChannelTimeSlice></timeSlice></RadioCommunicationChannel></hasMember>
 <hasMember><RadioCommunicationChannel gml:id="uuid.d0000000-0000-0000-0000-000000000014"><timeSlice><RadioCommunicationChannelTimeSlice>
  <interpretation>BASELINE</interpretation><frequencyTransmission uom="MHZ">132.700</frequencyTransmission>
 </RadioCommunicationChannelTimeSlice></timeSlice></RadioCommunicationChannel></hasMember>
 <hasMember><RadioCommunicationChannel gml:id="uuid.d0000000-0000-0000-0000-000000000015"><timeSlice><RadioCommunicationChannelTimeSlice>
  <interpretation>BASELINE</interpretation><frequencyTransmission uom="MHZ">125.625</frequencyTransmission>
  <annotation><Note><purpose>REMARK</purpose><translatedNote><LinguisticNote><note lang="eng">VFR and Special VFR flights in the London CTR.
DOC 60 NM/20,000 FT.</note></LinguisticNote></translatedNote></Note></annotation>
 </RadioCommunicationChannelTimeSlice></timeSlice></RadioCommunicationChannel></hasMember>
</AIXMBasicMessage>`

// TestServiceChannelRank pins the order a service's channels are written
// in, which is the order the app offers them in (it sets the first working
// VHF channel of a line): a channel whose own remark addresses VFR or
// transit traffic first, a channel one is only told onto, requests, or an
// emergency, alternate or military one last, the rest between, each group
// in the order published. The remarks under the channel's availability
// (its hours) do not rank it. Keeping every channel in link order offered
// HEATHROW RADAR's "when instructed" 127.525 for the London CTR.
func TestServiceChannelRank(t *testing.T) {
	msg, err := Decode([]byte(rankMessage))
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	ctr := findAirspace(msg, "a0000000-0000-0000-0000-000000000011")
	if ctr == nil {
		t.Fatal("London CTR not decoded")
	}
	var got []string
	for _, r := range ctr.Radio {
		got = append(got, r.Freq)
	}
	want := []string{"125.625", "132.700", "127.525", "121.500", "132.450"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("London CTR channels = %v, want %v", got, want)
	}
}

func TestChannelRank(t *testing.T) {
	for _, c := range []struct {
		rank         string
		remarks      []string
		availability []string
		want         int
	}{
		{"", nil, nil, rankNormal},
		{"", []string{"DOC 25 NM/4,000 FT."}, nil, rankNormal},
		{"", []string{"0600-2300 (0500-2200)."}, nil, rankNormal},
		{"", []string{"Frequency-CodeType: STD"}, nil, rankNormal},
		{"", []string{"Transit Requests"}, nil, rankFirst},
		{"", []string{"VFR and Special VFR flights in the London CTR."}, nil, rankFirst},
		{"", []string{"As directed."}, nil, rankLater},
		{"", []string{"As Directed by ATC"}, nil, rankLater},
		{"", []string{"When directed by ATC."}, nil, rankLater},
		{"", []string{"When instructed by ATC."}, nil, rankLater},
		{"", []string{"O/R"}, nil, rankLater},
		{"", []string{"FL365 - FL660 on demand"}, nil, rankLater},
		{"", []string{"Non-ATS channel."}, nil, rankLater},
		{"", []string{"Emergency frequency."}, nil, rankLater},
		{"", []string{"DOC 18 NM/4000 FT. For UWAS Emergencies."}, nil, rankLater},
		{"", []string{"Standby frequency not continuously monitored."}, nil, rankLater},
		{"", []string{"Stand-by frequency for Frankfurt TWR 25 NM, 5000 ft"}, nil, rankLater},
		{"", []string{"Reserve frequency"}, nil, rankLater},
		{"", []string{"To be used in the event of failure of communications on channel 125.205."}, nil, rankLater},
		{"", []string{"Available when Fire vehicle attending aircraft on the ground in an emergency."}, nil, rankLater},
		{"", []string{"Alternate frequency"}, nil, rankLater},
		{"", []string{"Frequency-CodeType: ALT"}, nil, rankLater},
		{"", []string{"Frequency-CodeType: MIL"}, nil, rankLater},
		{"", []string{"Frequency-CodeType: GUARD"}, nil, rankLater},
		// A channel one is told onto is never promoted by what it serves.
		{"", []string{"VFR traffic as directed by ATC."}, nil, rankLater},
		// A remark opening on hours is a channel in service in them, as an
		// availability note is (DRESDEN TOWER's and GROUND's, primary
		// around the clock, ATC on request at night).
		{"PRIMARY", []string{"ATC from 2350 (2250) - 0410 (0310) O/R"}, nil, rankNormal},
		{"", []string{"0800-2000 (0700-1900) when directed by ATC."}, nil, rankNormal},
		// IFR and VFR together serve both, no VFR channel.
		{"", []string{"IFR/VFR"}, nil, rankNormal},
		{"", []string{"Delivery for IFR and VFR flights"}, nil, rankNormal},
		// NATS files its directives under the channel's availability: one
		// opening on a directive says when the channel is used at all, one
		// opening on hours is a channel in service in them.
		{"", nil, []string{"As Directed by ATC"}, rankLater},
		{"", nil, []string{"O/R"}, rankLater},
		{"", nil, []string{"Only when directed by ATC or by prior arrangement."}, rankLater},
		{"", nil, []string{"When directed by ATC."}, rankLater},
		{"", nil, []string{"0630-2100 (0500-2100) or as directed."}, rankNormal},
		{"", nil, []string{"until 2200 (2100) O/R"}, rankNormal},
		{"", nil, []string{"OTHER"}, rankNormal},
		// The publisher's own rank (the DFS on every channel, Georgia on
		// some): its alternate, guard, emergency and military channels
		// last, a secondary one after the primaries.
		{"PRIMARY", nil, nil, rankNormal},
		{"PRIMARY", nil, []string{"until 2200 (2100) O/R"}, rankNormal},
		{"SECONDARY", nil, nil, rankSecondary},
		{"ALTERNATE", nil, nil, rankLater},
		{"GUARD", nil, nil, rankLater},
		{"EMERG", []string{"Frequency-CodeType:"}, nil, rankLater},
		{"OTHER:MIL", nil, nil, rankLater},
		{"OTHER", []string{"Frequency-CodeType:"}, nil, rankNormal},
		{"SECONDARY", []string{"VFR traffic"}, nil, rankFirst},
	} {
		if got := channelRank(c.rank, c.remarks, c.availability); got != c.want {
			t.Errorf("channelRank(%q, %q, %q) = %d, want %d", c.rank, c.remarks, c.availability, got, c.want)
		}
	}
}

// rankEvidenceMessage carries the evidence the publishers file beyond the
// channel's own remarks: NATS's directives under availability (BIRMINGHAM
// RADAR's 131.330 "As Directed by ATC" ahead of its 123.980 H24, and an
// availability opening on hours, which ranks nothing), and the DFS's own
// rank, one channel per service (MUENCHEN's alternate 119.405 filed ahead of
// its primaries, one primary carrying its hours as an availability note).
const rankEvidenceMessage = `<?xml version="1.0"?>
<AIXMBasicMessage>
 <hasMember>
  <Airspace gml:id="uuid.a0000000-0000-0000-0000-000000000021">
   <timeSlice><AirspaceTimeSlice>
    <interpretation>BASELINE</interpretation>
    <type>CTR</type>
    <designator>EGBBCTR</designator>
    <name>BIRMINGHAM CTR</name>
    <geometryComponent><AirspaceGeometryComponent><theAirspaceVolume><AirspaceVolume>
     <horizontalProjection><Surface><patches><PolygonPatch><exterior><Ring><curveMember><Curve><segments>
      <GeodesicString><posList>52.3 -1.9 52.3 -1.6 52.6 -1.6 52.6 -1.9 52.3 -1.9</posList></GeodesicString>
     </segments></Curve></curveMember></Ring></exterior></PolygonPatch></patches></Surface></horizontalProjection>
    </AirspaceVolume></theAirspaceVolume></AirspaceGeometryComponent></geometryComponent>
   </AirspaceTimeSlice></timeSlice>
  </Airspace>
 </hasMember>
 <hasMember>
  <Airspace gml:id="uuid.a0000000-0000-0000-0000-000000000022">
   <timeSlice><AirspaceTimeSlice>
    <interpretation>BASELINE</interpretation>
    <type>CLASS</type>
    <designator>EDDMCLCA</designator>
    <name>MUENCHEN A</name>
    <geometryComponent><AirspaceGeometryComponent><theAirspaceVolume><AirspaceVolume>
     <horizontalProjection><Surface><patches><PolygonPatch><exterior><Ring><curveMember><Curve><segments>
      <GeodesicString><posList>48.2 11.6 48.2 11.9 48.5 11.9 48.5 11.6 48.2 11.6</posList></GeodesicString>
     </segments></Curve></curveMember></Ring></exterior></PolygonPatch></patches></Surface></horizontalProjection>
    </AirspaceVolume></theAirspaceVolume></AirspaceGeometryComponent></geometryComponent>
   </AirspaceTimeSlice></timeSlice>
  </Airspace>
 </hasMember>
 <hasMember>
  <AirportHeliport gml:id="uuid.b0000000-0000-0000-0000-000000000021">
   <timeSlice><AirportHeliportTimeSlice>
    <interpretation>BASELINE</interpretation>
    <designator>EDDM</designator>
    <name>MUENCHEN</name>
    <locationIndicatorICAO>EDDM</locationIndicatorICAO>
    <ARP><ElevatedPoint><pos>48.3538 11.7861</pos></ElevatedPoint></ARP>
   </AirportHeliportTimeSlice></timeSlice>
  </AirportHeliport>
 </hasMember>
 <hasMember>
  <InformationService gml:id="uuid.c0000000-0000-0000-0000-000000000021">
   <timeSlice><InformationServiceTimeSlice>
    <interpretation>BASELINE</interpretation>
    <call-sign><CallsignDetail><callSign>BIRMINGHAM RADAR</callSign><language>eng</language></CallsignDetail></call-sign>
    <radioCommunication xlink:href="urn:uuid:d0000000-0000-0000-0000-000000000021"/>
    <radioCommunication xlink:href="urn:uuid:d0000000-0000-0000-0000-000000000022"/>
    <clientAirspace xlink:href="urn:uuid:a0000000-0000-0000-0000-000000000021"/>
    <type>OTHER:RADAR</type>
   </InformationServiceTimeSlice></timeSlice>
  </InformationService>
 </hasMember>
 <hasMember>
  <InformationService gml:id="uuid.c0000000-0000-0000-0000-000000000022">
   <timeSlice><InformationServiceTimeSlice>
    <interpretation>BASELINE</interpretation>
    <call-sign><CallsignDetail><callSign>BIRMINGHAM INFORMATION</callSign><language>eng</language></CallsignDetail></call-sign>
    <radioCommunication xlink:href="urn:uuid:d0000000-0000-0000-0000-000000000023"/>
    <clientAirspace xlink:href="urn:uuid:a0000000-0000-0000-0000-000000000021"/>
    <type>FIS</type>
   </InformationServiceTimeSlice></timeSlice>
  </InformationService>
 </hasMember>
 <hasMember><RadioCommunicationChannel gml:id="uuid.d0000000-0000-0000-0000-000000000021"><timeSlice><RadioCommunicationChannelTimeSlice>
  <interpretation>BASELINE</interpretation><frequencyTransmission uom="MHZ">131.330</frequencyTransmission>
  <availability><RadioCommunicationOperationalStatus><operationalStatus>LIMITED</operationalStatus><annotation><Note><purpose>OTHER:AIXM45_MAPPING</purpose><translatedNote><LinguisticNote><note lang="eng">As Directed by ATC</note></LinguisticNote></translatedNote></Note></annotation></RadioCommunicationOperationalStatus></availability>
  <annotation><Note><purpose>REMARK</purpose><translatedNote><LinguisticNote><note lang="eng">DOC 40 NM/20,000 FT</note></LinguisticNote></translatedNote></Note></annotation>
 </RadioCommunicationChannelTimeSlice></timeSlice></RadioCommunicationChannel></hasMember>
 <hasMember><RadioCommunicationChannel gml:id="uuid.d0000000-0000-0000-0000-000000000022"><timeSlice><RadioCommunicationChannelTimeSlice>
  <interpretation>BASELINE</interpretation><frequencyTransmission uom="MHZ">123.980</frequencyTransmission>
 </RadioCommunicationChannelTimeSlice></timeSlice></RadioCommunicationChannel></hasMember>
 <hasMember><RadioCommunicationChannel gml:id="uuid.d0000000-0000-0000-0000-000000000023"><timeSlice><RadioCommunicationChannelTimeSlice>
  <interpretation>BASELINE</interpretation><frequencyTransmission uom="MHZ">124.600</frequencyTransmission>
  <availability><RadioCommunicationOperationalStatus><operationalStatus>LIMITED</operationalStatus><annotation><Note><purpose>OTHER:AIXM45_MAPPING</purpose><translatedNote><LinguisticNote><note lang="eng">0630-2100 (0500-2100) or as directed.</note></LinguisticNote></translatedNote></Note></annotation></RadioCommunicationOperationalStatus></availability>
 </RadioCommunicationChannelTimeSlice></timeSlice></RadioCommunicationChannel></hasMember>
 <hasMember>
  <AirTrafficControlService gml:id="uuid.c0000000-0000-0000-0000-000000000023">
   <timeSlice><AirTrafficControlServiceTimeSlice>
    <interpretation>BASELINE</interpretation>
    <call-sign><CallsignDetail><callSign>MUENCHEN TOWER</callSign><language>ENG</language></CallsignDetail></call-sign>
    <radioCommunication xlink:href="urn:uuid:d0000000-0000-0000-0000-000000000024"/>
    <clientAirspace xlink:href="urn:uuid:a0000000-0000-0000-0000-000000000022"/>
    <clientAirport xlink:href="urn:uuid:b0000000-0000-0000-0000-000000000021"/>
    <type>TWR</type>
   </AirTrafficControlServiceTimeSlice></timeSlice>
  </AirTrafficControlService>
 </hasMember>
 <hasMember>
  <AirTrafficControlService gml:id="uuid.c0000000-0000-0000-0000-000000000024">
   <timeSlice><AirTrafficControlServiceTimeSlice>
    <interpretation>BASELINE</interpretation>
    <call-sign><CallsignDetail><callSign>MUENCHEN TOWER</callSign><language>ENG</language></CallsignDetail></call-sign>
    <radioCommunication xlink:href="urn:uuid:d0000000-0000-0000-0000-000000000025"/>
    <clientAirspace xlink:href="urn:uuid:a0000000-0000-0000-0000-000000000022"/>
    <clientAirport xlink:href="urn:uuid:b0000000-0000-0000-0000-000000000021"/>
    <type>TWR</type>
   </AirTrafficControlServiceTimeSlice></timeSlice>
  </AirTrafficControlService>
 </hasMember>
 <hasMember>
  <AirTrafficControlService gml:id="uuid.c0000000-0000-0000-0000-000000000025">
   <timeSlice><AirTrafficControlServiceTimeSlice>
    <interpretation>BASELINE</interpretation>
    <call-sign><CallsignDetail><callSign>MUENCHEN TOWER</callSign><language>ENG</language></CallsignDetail></call-sign>
    <radioCommunication xlink:href="urn:uuid:d0000000-0000-0000-0000-000000000026"/>
    <clientAirspace xlink:href="urn:uuid:a0000000-0000-0000-0000-000000000022"/>
    <clientAirport xlink:href="urn:uuid:b0000000-0000-0000-0000-000000000021"/>
    <type>TWR</type>
   </AirTrafficControlServiceTimeSlice></timeSlice>
  </AirTrafficControlService>
 </hasMember>
 <hasMember><RadioCommunicationChannel gml:id="uuid.d0000000-0000-0000-0000-000000000024"><timeSlice><RadioCommunicationChannelTimeSlice>
  <interpretation>BASELINE</interpretation><rank>ALTERNATE</rank><frequencyTransmission uom="MHZ">119.405</frequencyTransmission>
  <annotation><Note><propertyName>rank</propertyName><purpose>REMARK</purpose><translatedNote><LinguisticNote><note>Frequency-CodeType: ALT</note></LinguisticNote></translatedNote></Note></annotation>
 </RadioCommunicationChannelTimeSlice></timeSlice></RadioCommunicationChannel></hasMember>
 <hasMember><RadioCommunicationChannel gml:id="uuid.d0000000-0000-0000-0000-000000000025"><timeSlice><RadioCommunicationChannelTimeSlice>
  <interpretation>BASELINE</interpretation><rank>PRIMARY</rank><frequencyTransmission uom="MHZ">120.505</frequencyTransmission>
  <annotation><Note><propertyName>availability</propertyName><purpose>DESCRIPTION</purpose><translatedNote><LinguisticNote><note>until 2200 (2100) O/R</note></LinguisticNote></translatedNote></Note></annotation>
 </RadioCommunicationChannelTimeSlice></timeSlice></RadioCommunicationChannel></hasMember>
 <hasMember><RadioCommunicationChannel gml:id="uuid.d0000000-0000-0000-0000-000000000026"><timeSlice><RadioCommunicationChannelTimeSlice>
  <interpretation>BASELINE</interpretation><rank>PRIMARY</rank><frequencyTransmission uom="MHZ">118.705</frequencyTransmission>
 </RadioCommunicationChannelTimeSlice></timeSlice></RadioCommunicationChannel></hasMember>
</AIXMBasicMessage>`

// TestChannelRankEvidence: the evidence ranks the channel wherever the
// publisher filed it, and a row lists its channels by rank across its
// services. Ranked within one service only, the DFS's one channel per
// service never moved, and MUENCHEN offered its alternate 119.405 first;
// read from its remarks only, NATS's BIRMINGHAM RADAR offered 131.330, the
// channel one is only told onto.
func TestChannelRankEvidence(t *testing.T) {
	msg, err := Decode([]byte(rankEvidenceMessage))
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	freqs := func(rs []RadioChannel) []string {
		var out []string
		for _, r := range rs {
			out = append(out, r.Freq)
		}
		return out
	}
	ctr := findAirspace(msg, "a0000000-0000-0000-0000-000000000021")
	if ctr == nil {
		t.Fatal("BIRMINGHAM CTR not decoded")
	}
	if got, want := freqs(ctr.Radio), []string{"123.980", "124.600", "131.330"}; !reflect.DeepEqual(got, want) {
		t.Errorf("BIRMINGHAM CTR channels = %v, want %v", got, want)
	}
	cta := findAirspace(msg, "a0000000-0000-0000-0000-000000000022")
	if cta == nil {
		t.Fatal("MUENCHEN A not decoded")
	}
	if got, want := freqs(cta.Radio), []string{"120.505", "118.705", "119.405"}; !reflect.DeepEqual(got, want) {
		t.Errorf("MUENCHEN A channels = %v, want %v", got, want)
	}
	var eddm *Airport
	for i := range msg.Airports {
		if msg.Airports[i].Designator == "EDDM" {
			eddm = &msg.Airports[i]
		}
	}
	if eddm == nil {
		t.Fatal("EDDM not decoded")
	}
	if got, want := freqs(eddm.Radio), []string{"120.505", "118.705", "119.405"}; !reflect.DeepEqual(got, want) {
		t.Errorf("EDDM channels = %v, want %v", got, want)
	}
}

// apronMessage is the DFS's apron control as it files it: a ground traffic
// control service linking its aerodrome and one channel.
const apronMessage = `<?xml version="1.0"?>
<AIXMBasicMessage>
 <hasMember>
  <AirportHeliport gml:id="uuid.b0000000-0000-0000-0000-000000000031">
   <timeSlice><AirportHeliportTimeSlice>
    <interpretation>BASELINE</interpretation>
    <designator>EDDF</designator>
    <name>FRANKFURT/MAIN</name>
    <locationIndicatorICAO>EDDF</locationIndicatorICAO>
    <ARP><ElevatedPoint><pos>50.0333 8.5706</pos></ElevatedPoint></ARP>
   </AirportHeliportTimeSlice></timeSlice>
  </AirportHeliport>
 </hasMember>
 <hasMember>
  <GroundTrafficControlService gml:id="uuid.c0000000-0000-0000-0000-000000000031">
   <timeSlice><GroundTrafficControlServiceTimeSlice>
    <interpretation>BASELINE</interpretation>
    <name>EDDF SMC</name>
    <call-sign><CallsignDetail><callSign>FRANKFURT APRON</callSign><language>ger</language></CallsignDetail></call-sign>
    <radioCommunication xlink:href="urn:uuid:d0000000-0000-0000-0000-000000000031"/>
    <clientAirport xlink:href="urn:uuid:b0000000-0000-0000-0000-000000000031"/>
    <type>SMGCS</type>
   </GroundTrafficControlServiceTimeSlice></timeSlice>
  </GroundTrafficControlService>
 </hasMember>
 <hasMember><RadioCommunicationChannel gml:id="uuid.d0000000-0000-0000-0000-000000000031"><timeSlice><RadioCommunicationChannelTimeSlice>
  <interpretation>BASELINE</interpretation><rank>PRIMARY</rank><frequencyTransmission uom="MHZ">121.700</frequencyTransmission>
 </RadioCommunicationChannelTimeSlice></timeSlice></RadioCommunicationChannel></hasMember>
</AIXMBasicMessage>`

// TestGroundTrafficControlService: the DFS's apron control reaches its
// aerodrome. Skipped as an unknown feature, no German aerodrome carried a
// ground-movement channel at all.
func TestGroundTrafficControlService(t *testing.T) {
	msg, err := Decode([]byte(apronMessage))
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if len(msg.Airports) != 1 {
		t.Fatalf("airports = %d, want 1", len(msg.Airports))
	}
	want := []RadioChannel{{Freq: "121.700", Unit: "SMGCS", CallSign: "FRANKFURT APRON"}}
	if got := msg.Airports[0].Radio; !reflect.DeepEqual(got, want) {
		t.Errorf("EDDF radio = %v, want %v", got, want)
	}
}

// groundCoverageMessage is Alderney's tower service as NATS files it: two
// call signs, ALDERNEY GROUND and ALDERNEY TOWER, and two channels, the
// tower's 125.355 and 130.505, whose remark gives its coverage at ground
// level ("DOC 3 NM/GND").
const groundCoverageMessage = `<?xml version="1.0"?>
<AIXMBasicMessage>
 <hasMember>
  <AirportHeliport gml:id="uuid.b0000000-0000-0000-0000-000000000041">
   <timeSlice><AirportHeliportTimeSlice>
    <interpretation>BASELINE</interpretation>
    <designator>EGJA</designator>
    <name>ALDERNEY</name>
    <locationIndicatorICAO>EGJA</locationIndicatorICAO>
    <ARP><ElevatedPoint><pos>49.7061 -2.2147</pos></ElevatedPoint></ARP>
   </AirportHeliportTimeSlice></timeSlice>
  </AirportHeliport>
 </hasMember>
 <hasMember>
  <AirTrafficControlService gml:id="uuid.c0000000-0000-0000-0000-000000000041">
   <timeSlice><AirTrafficControlServiceTimeSlice>
    <interpretation>BASELINE</interpretation>
    <call-sign><CallsignDetail><callSign>ALDERNEY GROUND</callSign><language>eng</language></CallsignDetail></call-sign>
    <call-sign><CallsignDetail><callSign>ALDERNEY TOWER</callSign><language>eng</language></CallsignDetail></call-sign>
    <radioCommunication xlink:href="urn:uuid:d0000000-0000-0000-0000-000000000041"/>
    <radioCommunication xlink:href="urn:uuid:d0000000-0000-0000-0000-000000000042"/>
    <clientAirport xlink:href="urn:uuid:b0000000-0000-0000-0000-000000000041"/>
    <type>TWR</type>
   </AirTrafficControlServiceTimeSlice></timeSlice>
  </AirTrafficControlService>
 </hasMember>
 <hasMember><RadioCommunicationChannel gml:id="uuid.d0000000-0000-0000-0000-000000000041"><timeSlice><RadioCommunicationChannelTimeSlice>
  <interpretation>BASELINE</interpretation><frequencyTransmission uom="MHZ">125.355</frequencyTransmission>
  <annotation><Note><purpose>REMARK</purpose><translatedNote><LinguisticNote><note lang="eng">DOC 25 NM/4,000 FT.</note></LinguisticNote></translatedNote></Note></annotation>
 </RadioCommunicationChannelTimeSlice></timeSlice></RadioCommunicationChannel></hasMember>
 <hasMember><RadioCommunicationChannel gml:id="uuid.d0000000-0000-0000-0000-000000000042"><timeSlice><RadioCommunicationChannelTimeSlice>
  <interpretation>BASELINE</interpretation><frequencyTransmission uom="MHZ">130.505</frequencyTransmission>
  <annotation><Note><purpose>REMARK</purpose><translatedNote><LinguisticNote><note lang="eng">DOC 3 NM/GND.</note></LinguisticNote></translatedNote></Note></annotation>
 </RadioCommunicationChannelTimeSlice></timeSlice></RadioCommunicationChannel></hasMember>
</AIXMBasicMessage>`

// TestGroundCoverageChannel: a channel outside the surface block whose own
// remark gives its coverage at ground level is the surface call signs', as
// one inside the block is. The band alone gave Alderney's 130.505 to the
// tower, the ground channel reading TWR.
func TestGroundCoverageChannel(t *testing.T) {
	msg, err := Decode([]byte(groundCoverageMessage))
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if len(msg.Airports) != 1 {
		t.Fatalf("airports = %d, want 1", len(msg.Airports))
	}
	want := []RadioChannel{
		{Freq: "125.355", Unit: "TWR", CallSign: "ALDERNEY TOWER"},
		{Freq: "130.505", Unit: "TWR", CallSign: "ALDERNEY GROUND"},
	}
	if got := msg.Airports[0].Radio; !reflect.DeepEqual(got, want) {
		t.Errorf("EGJA radio = %v, want %v", got, want)
	}
	for _, c := range []struct {
		note string
		want bool
	}{
		{"DOC 3 NM/GND.", true},
		{"DOC 2 NM/GND", true},
		{"DOC 5 NM / GND.", true},
		{"DOC 25 NM/4,000 FT.", false},
		{"Ground Movement Planner.", false},
	} {
		if got := groundCoverage([]string{c.note}); got != c.want {
			t.Errorf("groundCoverage(%q) = %v, want %v", c.note, got, c.want)
		}
	}
}

// TestSurfaceRoleChannels: a surface channel's own remark names the
// position working it, "Ground Movement Planning" (the UK's GMP, the
// delivery) or "Ground Movement Control" (the ground): the channel is
// that position's alone, where the band gave it to every surface call sign
// and Heathrow's 121.980, its delivery, read as ground as well. A channel
// whose remark names neither keeps them all.
func TestSurfaceRoleChannels(t *testing.T) {
	calls := []string{"HEATHROW TOWER", "HEATHROW DELIVERY", "HEATHROW GROUND"}
	for _, c := range []struct {
		freq    string
		remarks []string
		want    string
	}{
		{"118.505", nil, "HEATHROW TOWER"},
		{"121.980", []string{"Ground Movement Planning Departing aircraft are to make initial call to 'Heathrow Delivery' on this frequency."}, "HEATHROW DELIVERY"},
		{"121.905", []string{"DOC 5 NM/GND. Ground Movement Control."}, "HEATHROW GROUND"},
		{"121.855", nil, "HEATHROW DELIVERY / HEATHROW GROUND"},
	} {
		got, _ := channelCallSign(calls, c.freq, groundCoverage(c.remarks), surfaceRole(c.remarks))
		if got != c.want {
			t.Errorf("%s %q: call = %q, want %q", c.freq, c.remarks, got, c.want)
		}
	}
	// A role the service has no call sign for leaves the band's answer.
	if got, _ := channelCallSign([]string{"FOO TOWER", "FOO GROUND"}, "121.980", false, surfaceRole([]string{"Ground Movement Planning."})); got != "FOO GROUND" {
		t.Errorf("call = %q, want FOO GROUND", got)
	}
}

// TestSurfacePositionAnyWord: a call sign names a surface position by any
// of its words, the DFS numbering its apron parts after the word
// ("MUENCHEN APRON 1") and writing it in German too.
func TestSurfacePositionAnyWord(t *testing.T) {
	for call, want := range map[string]bool{
		"MUENCHEN APRON 1":    true,
		"FRANKFURT VORFELD 2": true,
		"KOELN GROUND":        true,
		"HEATHROW DELIVERY":   true,
		"LANGEN RADAR":        false,
		"DRESDEN TOWER":       false,
	} {
		if got := surfacePosition(call); got != want {
			t.Errorf("surfacePosition(%q) = %v, want %v", call, got, want)
		}
	}
}
