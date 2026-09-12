package aixm5

import (
	"math"
	"testing"
)

// TestDecodeAllSplitSources covers the multi-source contract DFS
// Germany relies on: the AirportHeliport, its Runway and an unrelated
// Airspace arrive in three separate AIXM files, and DecodeAll must
// stream all members first, then resolve the runway->airport xlink
// once over the combined set. Decoding the runway file alone leaves
// the xlink unresolved, which is exactly why the per-country command
// cannot decode the files independently.
func TestDecodeAllSplitSources(t *testing.T) {
	// Source A: the airport, plus the message dateStamp.
	srcA := []byte(`<?xml version="1.0"?>
<AIXMBasicMessage>
 <messageMetadata><dateStamp><DateTime>2026-07-09</DateTime></dateStamp></messageMetadata>
 <hasMember>
  <AirportHeliport gml:id="uuid.11111111-1111-1111-1111-111111111111">
   <timeSlice><AirportHeliportTimeSlice>
    <interpretation>BASELINE</interpretation>
    <designator>EDDT</designator>
    <name>BERLIN TEGEL</name>
    <locationIndicatorICAO>EDDT</locationIndicatorICAO>
    <ARP><ElevatedPoint><pos>52.5597 13.2877</pos></ElevatedPoint></ARP>
   </AirportHeliportTimeSlice></timeSlice>
  </AirportHeliport>
 </hasMember>
</AIXMBasicMessage>`)

	// Source B: the runway, linking back to the airport by xlink only.
	srcB := []byte(`<?xml version="1.0"?>
<AIXMBasicMessage>
 <hasMember>
  <Runway gml:id="uuid.22222222-2222-2222-2222-222222222222">
   <timeSlice><RunwayTimeSlice>
    <interpretation>BASELINE</interpretation>
    <designator>08R/26L</designator>
    <nominalLength uom="M">3023</nominalLength>
    <nominalWidth uom="M">46</nominalWidth>
    <surfaceProperties><SurfaceCharacteristics><composition>ASPH</composition></SurfaceCharacteristics></surfaceProperties>
    <associatedAirportHeliport xlink:href="urn:uuid:11111111-1111-1111-1111-111111111111"/>
   </RunwayTimeSlice></timeSlice>
  </Runway>
 </hasMember>
</AIXMBasicMessage>`)

	// Source C: an unrelated airspace, to prove cross-source accumulation.
	srcC := []byte(`<?xml version="1.0"?>
<AIXMBasicMessage>
 <hasMember>
  <Airspace gml:id="uuid.33333333-3333-3333-3333-333333333333">
   <timeSlice><AirspaceTimeSlice>
    <interpretation>BASELINE</interpretation>
    <type>CTR</type>
    <designator>EDDT</designator>
    <name>TEGEL</name>
    <geometryComponent><AirspaceGeometryComponent><theAirspaceVolume><AirspaceVolume>
     <horizontalProjection><Surface><patches><PolygonPatch><exterior><Ring><curveMember><Curve><segments>
      <GeodesicString><posList>52 13 52 14 53 14 53 13 52 13</posList></GeodesicString>
     </segments></Curve></curveMember></Ring></exterior></PolygonPatch></patches></Surface></horizontalProjection>
    </AirspaceVolume></theAirspaceVolume></AirspaceGeometryComponent></geometryComponent>
   </AirspaceTimeSlice></timeSlice>
  </Airspace>
 </hasMember>
</AIXMBasicMessage>`)

	msg, err := DecodeAll(srcA, srcB, srcC)
	if err != nil {
		t.Fatalf("DecodeAll: %v", err)
	}
	if got, want := len(msg.Airports), 1; got != want {
		t.Fatalf("Airports = %d, want %d", got, want)
	}
	if got, want := len(msg.Airspaces), 1; got != want {
		t.Fatalf("Airspaces = %d, want %d (cross-source accumulation)", got, want)
	}
	if msg.Effective != "2026-07-09" {
		t.Errorf("Effective = %q, want 2026-07-09 (first source's dateStamp)", msg.Effective)
	}
	if msg.UnresolvedXlinks != 0 {
		t.Errorf("UnresolvedXlinks = %d, want 0 (runway resolved across sources)", msg.UnresolvedXlinks)
	}

	a := &msg.Airports[0]
	if a.Designator != "EDDT" {
		t.Errorf("Airport Designator = %q, want EDDT", a.Designator)
	}
	if len(a.Runways) != 1 {
		t.Fatalf("EDDT Runways = %d, want 1 (xlink from source B resolved)", len(a.Runways))
	}
	r := a.Runways[0]
	if r.Le != "08R" || r.He != "26L" {
		t.Errorf("runway designators = %q/%q, want 08R/26L", r.Le, r.He)
	}
	if r.Surface != "ASPH" {
		t.Errorf("runway surface = %q, want ASPH", r.Surface)
	}
	if r.LengthM == nil || math.Abs(*r.LengthM-3023) > 1e-6 {
		t.Errorf("runway LengthM = %v, want 3023", r.LengthM)
	}

	// Decoding the runway file alone cannot resolve the xlink: no
	// airport is present, so the runway is dropped as an unresolved
	// reference. This is the failure DecodeAll exists to prevent.
	lone, err := Decode(srcB)
	if err != nil {
		t.Fatalf("Decode(srcB): %v", err)
	}
	if len(lone.Airports) != 0 {
		t.Errorf("lone runway decode: Airports = %d, want 0", len(lone.Airports))
	}
	if lone.UnresolvedXlinks != 1 {
		t.Errorf("lone runway decode: UnresolvedXlinks = %d, want 1", lone.UnresolvedXlinks)
	}
}
