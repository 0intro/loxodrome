package aixm5

import "testing"

// NATS publishes each declared distance type of a runway direction as
// several values on the threshold's centreline point, the full length
// among the intersection departures, in no fixed order (Aldergrove 07,
// AIRAC 2026-09-03). The row keeps the longest of each type: a single
// field once kept the last, an intersection's 1204 m TORA.
func TestDecodeDeclaredDistancesKeepTheLongest(t *testing.T) {
	src := []byte(`<?xml version="1.0"?>
<AIXMBasicMessage>
 <hasMember>
  <AirportHeliport gml:id="uuid.ad000000-0000-0000-0000-000000000001">
   <identifier>ad000000-0000-0000-0000-000000000001</identifier>
   <timeSlice><AirportHeliportTimeSlice>
    <interpretation>BASELINE</interpretation>
    <designator>EGAA</designator><name>BELFAST ALDERGROVE</name><type>AD</type>
   </AirportHeliportTimeSlice></timeSlice>
  </AirportHeliport>
 </hasMember>
 <hasMember>
  <Runway gml:id="uuid.a0000000-0000-0000-0000-000000000002">
   <identifier>a0000000-0000-0000-0000-000000000002</identifier>
   <timeSlice><RunwayTimeSlice>
    <interpretation>BASELINE</interpretation>
    <designator>07/25</designator><type>RWY</type>
    <nominalLength uom="M">2780</nominalLength>
    <associatedAirportHeliport xlink:href="urn:uuid:ad000000-0000-0000-0000-000000000001"/>
   </RunwayTimeSlice></timeSlice>
  </Runway>
 </hasMember>
 <hasMember>
  <RunwayDirection gml:id="uuid.d0000000-0000-0000-0000-000000000003">
   <identifier>d0000000-0000-0000-0000-000000000003</identifier>
   <timeSlice><RunwayDirectionTimeSlice>
    <interpretation>BASELINE</interpretation>
    <designator>07</designator>
    <usedRunway xlink:href="urn:uuid:a0000000-0000-0000-0000-000000000002"/>
   </RunwayDirectionTimeSlice></timeSlice>
  </RunwayDirection>
 </hasMember>
 <hasMember>
  <RunwayCentrelinePoint gml:id="uuid.c0000000-0000-0000-0000-000000000004">
   <timeSlice><RunwayCentrelinePointTimeSlice>
    <interpretation>BASELINE</interpretation>
    <role>THR</role>
    <onRunway xlink:href="urn:uuid:d0000000-0000-0000-0000-000000000003"/>
    <associatedDeclaredDistance><RunwayDeclaredDistance>
     <type>ASDA</type>
     <declaredValue><RunwayDeclaredDistanceValue><distance uom="M">1204</distance></RunwayDeclaredDistanceValue></declaredValue>
     <declaredValue><RunwayDeclaredDistanceValue><distance uom="M">2779.75</distance></RunwayDeclaredDistanceValue></declaredValue>
     <declaredValue><RunwayDeclaredDistanceValue><distance uom="M">2197</distance></RunwayDeclaredDistanceValue></declaredValue>
    </RunwayDeclaredDistance></associatedDeclaredDistance>
    <associatedDeclaredDistance><RunwayDeclaredDistance>
     <type>TORA</type>
     <declaredValue><RunwayDeclaredDistanceValue><distance uom="M">2197</distance>
      <annotation><Note><purpose>REMARK</purpose></Note></annotation></RunwayDeclaredDistanceValue></declaredValue>
     <declaredValue><RunwayDeclaredDistanceValue><distance uom="M">2779.75</distance></RunwayDeclaredDistanceValue></declaredValue>
     <declaredValue><RunwayDeclaredDistanceValue><distance uom="M">1204</distance>
      <annotation><Note><purpose>REMARK</purpose></Note></annotation></RunwayDeclaredDistanceValue></declaredValue>
    </RunwayDeclaredDistance></associatedDeclaredDistance>
    <associatedDeclaredDistance><RunwayDeclaredDistance>
     <type>LDA</type>
     <declaredValue><RunwayDeclaredDistanceValue><distance uom="M">2779.75</distance></RunwayDeclaredDistanceValue></declaredValue>
    </RunwayDeclaredDistance></associatedDeclaredDistance>
   </RunwayCentrelinePointTimeSlice></timeSlice>
  </RunwayCentrelinePoint>
 </hasMember>
</AIXMBasicMessage>`)
	msg, err := Decode(src)
	if err != nil {
		t.Fatal(err)
	}
	if len(msg.Airports) != 1 || len(msg.Airports[0].Runways) != 1 {
		t.Fatalf("decoded %d airports", len(msg.Airports))
	}
	r := msg.Airports[0].Runways[0]
	for name, got := range map[string]*float64{"TORA": r.LeToraM, "ASDA": r.LeAsdaM, "LDA": r.LeLdaM} {
		if got == nil || *got != 2779.75 {
			t.Errorf("07 %s = %v, want 2779.75", name, got)
		}
	}
}

// Of several centreline points on one direction, the threshold's figures
// win over a point with no role, whatever their lengths.
func TestPickDistancesPrefersTheThreshold(t *testing.T) {
	got := pickDistances([]*rawCentrelinePoint{
		{distances: map[string]float64{"TORA": 3200}, annotated: true},
		{distances: map[string]float64{"TORA": 3050, "LDA": 2864}, role: "THR"},
		{distances: map[string]float64{"TORA": 2202}, annotated: true},
	})
	if got["TORA"] != 3050 || got["LDA"] != 2864 {
		t.Errorf("picked %v", got)
	}
}
