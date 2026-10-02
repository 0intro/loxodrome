package aixm5

import (
	"math"
	"reflect"
	"testing"

	"github.com/0intro/loxodrome/internal/geodesy"
)

// centreMessage files three airspaces the ways publishers give a circle's
// or an arc's centre: the DFS and Sakaeronavigatsia as a bare gml:pos (ED-R
// 1 GARCHING, a circle; ED-R 4 WANNSEE, three geodesic sides and an arc),
// and a centre given only as a link to a point feature, which nothing here
// resolves.
const centreMessage = `<?xml version="1.0"?>
<AIXMBasicMessage>
 <hasMember>
  <Airspace gml:id="uuid.a0000000-0000-0000-0000-000000000021">
   <timeSlice><AirspaceTimeSlice>
    <interpretation>BASELINE</interpretation>
    <type>R</type>
    <designator>EDR1</designator>
    <name>GARCHING</name>
    <geometryComponent><AirspaceGeometryComponent><theAirspaceVolume><AirspaceVolume>
     <horizontalProjection><Surface><patches><PolygonPatch><exterior><Ring><curveMember><Curve><segments>
      <CircleByCenterPoint numArc="1"><pos>48.265 11.671388889</pos><radius uom="[nmi_i]">1.4</radius></CircleByCenterPoint>
     </segments></Curve></curveMember></Ring></exterior></PolygonPatch></patches></Surface></horizontalProjection>
    </AirspaceVolume></theAirspaceVolume></AirspaceGeometryComponent></geometryComponent>
   </AirspaceTimeSlice></timeSlice>
  </Airspace>
 </hasMember>
 <hasMember>
  <Airspace gml:id="uuid.a0000000-0000-0000-0000-000000000022">
   <timeSlice><AirspaceTimeSlice>
    <interpretation>BASELINE</interpretation>
    <type>R</type>
    <designator>EDR4</designator>
    <name>WANNSEE</name>
    <geometryComponent><AirspaceGeometryComponent><theAirspaceVolume><AirspaceVolume>
     <horizontalProjection><Surface><patches><PolygonPatch><exterior><Ring><curveMember><Curve><segments>
      <GeodesicString><posList>52.45 13.10 52.45 13.20 52.40 13.20</posList></GeodesicString>
      <ArcByCenterPoint numArc="1"><pos>52.42 13.15</pos><radius uom="[nmi_i]">2.5</radius><startAngle uom="deg">135</startAngle><endAngle uom="deg">315</endAngle></ArcByCenterPoint>
      <GeodesicString><posList>52.44 13.10 52.45 13.10</posList></GeodesicString>
     </segments></Curve></curveMember></Ring></exterior></PolygonPatch></patches></Surface></horizontalProjection>
    </AirspaceVolume></theAirspaceVolume></AirspaceGeometryComponent></geometryComponent>
   </AirspaceTimeSlice></timeSlice>
  </Airspace>
 </hasMember>
 <hasMember>
  <Airspace gml:id="uuid.a0000000-0000-0000-0000-000000000023">
   <timeSlice><AirspaceTimeSlice>
    <interpretation>BASELINE</interpretation>
    <type>R</type>
    <designator>EDR9</designator>
    <name>LINKED</name>
    <geometryComponent><AirspaceGeometryComponent><theAirspaceVolume><AirspaceVolume>
     <horizontalProjection><Surface><patches><PolygonPatch><exterior><Ring><curveMember><Curve><segments>
      <CircleByCenterPoint numArc="1"><pointProperty xlink:href="urn:uuid:b0000000-0000-0000-0000-000000000001"/><radius uom="[nmi_i]">1</radius></CircleByCenterPoint>
     </segments></Curve></curveMember></Ring></exterior></PolygonPatch></patches></Surface></horizontalProjection>
    </AirspaceVolume></theAirspaceVolume></AirspaceGeometryComponent></geometryComponent>
   </AirspaceTimeSlice></timeSlice>
  </Airspace>
 </hasMember>
</AIXMBasicMessage>`

// TestDecodeBarePosCentres: a circle or an arc whose centre is a bare
// gml:pos is read. The decoder read the centre only from a posList or an
// inline point, so every DFS and Georgian circle and arc was skipped: the
// circular volumes (ED-R 1 GARCHING among 396 German ones) left the dataset
// for want of a boundary, and every arc became the chord between its
// neighbours (ED-R 4 WANNSEE, the SYLT CTR). A centre given only as a link
// is still skipped, and counted.
func TestDecodeBarePosCentres(t *testing.T) {
	msg, err := Decode([]byte(centreMessage))
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	garching := findAirspace(msg, "a0000000-0000-0000-0000-000000000021")
	if garching == nil {
		t.Fatal("ED-R 1 not decoded")
	}
	if got, want := len(garching.Ring), geodesy.CircleSteps; got != want {
		t.Errorf("ED-R 1 ring = %d points, want the %d of a circle", got, want)
	}
	for _, p := range garching.Ring {
		if d := geodesy.DistanceM(48.265, 11.671388889, p[0], p[1]); d < 1.4*1852-5 || d > 1.4*1852+5 {
			t.Errorf("ED-R 1 vertex %v lies %.0f m from the centre, want 1.4 NM", p, d)
			break
		}
	}

	wannsee := findAirspace(msg, "a0000000-0000-0000-0000-000000000022")
	if wannsee == nil {
		t.Fatal("ED-R 4 not decoded")
	}
	onArc := 0
	for _, p := range wannsee.Ring {
		if d := geodesy.DistanceM(52.42, 13.15, p[0], p[1]); d > 2.5*1852-5 && d < 2.5*1852+5 {
			onArc++
		}
	}
	// A half circle at the tessellation step: far more than the five
	// vertices the two geodesic strings give.
	if onArc < geodesy.CircleSteps/2-2 {
		t.Errorf("ED-R 4 ring = %d points, %d on the arc; want the arc drawn, not its chord", len(wannsee.Ring), onArc)
	}

	linked := findAirspace(msg, "a0000000-0000-0000-0000-000000000023")
	if linked == nil {
		t.Fatal("the linked-centre airspace not decoded")
	}
	if len(linked.Ring) != 0 {
		t.Errorf("a circle whose centre is only a link drew %d points, want none", len(linked.Ring))
	}
	if msg.UnresolvedXlinks != 1 || msg.UnresolvedGeometryXlinks != 1 {
		t.Errorf("UnresolvedXlinks = %d, UnresolvedGeometryXlinks = %d; want 1 and 1: the linked centre alone, a boundary's",
			msg.UnresolvedXlinks, msg.UnresolvedGeometryXlinks)
	}
}

// arcMessage files an arc by the AIXM rule for its direction: the angle
// values increase along a clockwise arc and decrease along an anticlockwise
// one. NATS's KEMBLE RWY 26G (EGR1U010E) runs anticlockwise from 86.76 to
// 71.24 degrees, a 15.5-degree piece of its 2 NM circle; the DFS writes
// unwrapped angles, -188.08 to 91.93 a clockwise 280 degrees.
const arcMessage = `<?xml version="1.0"?>
<AIXMBasicMessage>
 <hasMember>
  <Airspace gml:id="uuid.a0000000-0000-0000-0000-000000000031">
   <timeSlice><AirspaceTimeSlice>
    <interpretation>BASELINE</interpretation>
    <type>R</type>
    <designator>EGR1U010E</designator>
    <name>KEMBLE RWY 26G</name>
    <geometryComponent><AirspaceGeometryComponent><theAirspaceVolume><AirspaceVolume>
     <horizontalProjection><Surface><patches><PolygonPatch><exterior><Ring><curveMember><Curve><segments>
      <GeodesicString><posList>51.68137 -1.98141 51.67500 -1.99200 51.66993 -2.00355</posList></GeodesicString>
      <ArcByCenterPoint numArc="1"><pos>51.66806 -2.05701</pos><radius uom="[nmi_i]">2</radius><startAngle uom="deg">86.760</startAngle><endAngle uom="deg">71.239</endAngle></ArcByCenterPoint>
      <GeodesicString><posList>51.67876 -2.00630 51.68137 -1.98141</posList></GeodesicString>
     </segments></Curve></curveMember></Ring></exterior></PolygonPatch></patches></Surface></horizontalProjection>
    </AirspaceVolume></theAirspaceVolume></AirspaceGeometryComponent></geometryComponent>
   </AirspaceTimeSlice></timeSlice>
  </Airspace>
 </hasMember>
 <hasMember>
  <Airspace gml:id="uuid.a0000000-0000-0000-0000-000000000032">
   <timeSlice><AirspaceTimeSlice>
    <interpretation>BASELINE</interpretation>
    <type>R</type>
    <designator>EDR4</designator>
    <name>WANNSEE</name>
    <geometryComponent><AirspaceGeometryComponent><theAirspaceVolume><AirspaceVolume>
     <horizontalProjection><Surface><patches><PolygonPatch><exterior><Ring><curveMember><Curve><segments>
      <ArcByCenterPoint numArc="1"><pos>52.42 13.15</pos><radius uom="[nmi_i]">2.5</radius><startAngle uom="deg">-188.08</startAngle><endAngle uom="deg">91.93</endAngle></ArcByCenterPoint>
     </segments></Curve></curveMember></Ring></exterior></PolygonPatch></patches></Surface></horizontalProjection>
    </AirspaceVolume></theAirspaceVolume></AirspaceGeometryComponent></geometryComponent>
   </AirspaceTimeSlice></timeSlice>
  </Airspace>
 </hasMember>
</AIXMBasicMessage>`

// TestArcDirection: an arc runs the way its angles run. Swept clockwise
// whatever the angles said, every anticlockwise arc went the long way round
// its centre: KEMBLE RWY 26G drew its whole 2 NM circle, 44.7 km2 for a
// zone of under 2, 593 UK rows a slot and 60 German ones.
func TestArcDirection(t *testing.T) {
	msg, err := Decode([]byte(arcMessage))
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	kemble := findAirspace(msg, "a0000000-0000-0000-0000-000000000031")
	if kemble == nil {
		t.Fatal("KEMBLE not decoded")
	}
	// Every vertex of the anticlockwise arc lies on the published piece,
	// bearings 71.2 to 86.8 from the centre, none on the rest of the circle.
	for _, p := range kemble.Ring {
		d := geodesy.DistanceM(51.66806, -2.05701, p[0], p[1])
		if d < 2*1852-5 || d > 2*1852+5 {
			continue
		}
		if b := geodesy.InitialBearing(51.66806, -2.05701, p[0], p[1]); b < 71 || b > 87 {
			t.Errorf("KEMBLE arc vertex %v at bearing %.1f, off the published 71.2 to 86.8", p, b)
			break
		}
	}
	if len(kemble.Ring) > 20 {
		t.Errorf("KEMBLE ring = %d points, want a short arc, not the circle round", len(kemble.Ring))
	}
	// Unwrapped angles: -188.08 to 91.93 is 280 degrees clockwise.
	wannsee := findAirspace(msg, "a0000000-0000-0000-0000-000000000032")
	if wannsee == nil {
		t.Fatal("WANNSEE not decoded")
	}
	var west, east bool
	for _, p := range wannsee.Ring {
		b := geodesy.InitialBearing(52.42, 13.15, p[0], p[1])
		// 280 degrees clockwise from 171.92 (= -188.08) through west and
		// north to 91.93 (east): the gap, 91.93 to 171.92, stays empty.
		if b > 95 && b < 168 {
			t.Errorf("WANNSEE vertex %v at bearing %.1f, inside the gap the arc leaves", p, b)
			break
		}
		west = west || (b > 260 && b < 280)
		east = east || (b > 85 && b < 95)
	}
	if !west || !east {
		t.Errorf("WANNSEE arc misses its sweep: west %v, east %v", west, east)
	}
}

// TestArcSnapsToItsVertices: an arc's computed ends give way to the
// published vertices they meet. KEMBLE's angles put its arc's ends 12 m off
// the corners the GeodesicStrings publish; kept, each junction drew a 12 m
// jog, and on the thin zone the jog crossed the arc (556 UK rings crossed
// themselves). Snapped, the corner is followed by the arc's first step, a
// tessellation step away.
func TestArcSnapsToItsVertices(t *testing.T) {
	msg, err := Decode([]byte(arcMessage))
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	kemble := findAirspace(msg, "a0000000-0000-0000-0000-000000000031")
	if kemble == nil {
		t.Fatal("KEMBLE not decoded")
	}
	ring := kemble.Ring
	idx := func(p [2]float64) int {
		for i, q := range ring {
			if q == p {
				return i
			}
		}
		return -1
	}
	before, after := idx([2]float64{51.66993, -2.00355}), idx([2]float64{51.67876, -2.0063})
	if before < 0 || after < 0 || after <= before+1 {
		t.Fatalf("published corners missing or adjacent in %v", ring)
	}
	gap := func(a, b [2]float64) float64 { return geodesy.DistanceM(a[0], a[1], b[0], b[1]) }
	if d := gap(ring[before], ring[before+1]); d < 50 {
		t.Errorf("the arc's computed start stays %.0f m past its corner, a jog", d)
	}
	if d := gap(ring[after-1], ring[after]); d < 50 {
		t.Errorf("the arc's computed end stays %.0f m short of its corner, a jog", d)
	}
	for i := before + 1; i < after; i++ {
		p := ring[i]
		if d := geodesy.DistanceM(51.66806, -2.05701, p[0], p[1]); math.Abs(d-2*1852) > 5 {
			t.Errorf("vertex %v between the corners lies %.0f m from the centre, off the arc", p, d)
		}
	}
}

// noProjectionMessage: a volume with no horizontalProjection (the DFS's
// contributor volumes), one with an empty surface (NATS's UIRs write
// <gml:patches/> beside the contributor link) and one with a boundary.
const noProjectionMessage = `<?xml version="1.0"?>
<AIXMBasicMessage>
 <hasMember><Airspace gml:id="uuid.a0000000-0000-0000-0000-000000000051"><timeSlice><AirspaceTimeSlice>
  <interpretation>BASELINE</interpretation><type>TMZ</type><designator>TMZ AGG</designator>
  <geometryComponent><AirspaceGeometryComponent><theAirspaceVolume><AirspaceVolume>
   <contributorAirspace><AirspaceVolumeDependency><theAirspace xlink:href="urn:uuid:a0000000-0000-0000-0000-000000000053"/></AirspaceVolumeDependency></contributorAirspace>
  </AirspaceVolume></theAirspaceVolume></AirspaceGeometryComponent></geometryComponent>
 </AirspaceTimeSlice></timeSlice></Airspace></hasMember>
 <hasMember><Airspace gml:id="uuid.a0000000-0000-0000-0000-000000000052"><timeSlice><AirspaceTimeSlice>
  <interpretation>BASELINE</interpretation><type>UIR</type><designator>UIR EMPTY</designator>
  <geometryComponent><AirspaceGeometryComponent><theAirspaceVolume><AirspaceVolume>
   <horizontalProjection><Surface gml:id="s52"><patches/></Surface></horizontalProjection>
  </AirspaceVolume></theAirspaceVolume></AirspaceGeometryComponent></geometryComponent>
 </AirspaceTimeSlice></timeSlice></Airspace></hasMember>
 <hasMember><Airspace gml:id="uuid.a0000000-0000-0000-0000-000000000053"><timeSlice><AirspaceTimeSlice>
  <interpretation>BASELINE</interpretation><type>TMZ</type><designator>TMZ OWN</designator>
  <geometryComponent><AirspaceGeometryComponent><theAirspaceVolume><AirspaceVolume>
   <horizontalProjection><Surface gml:id="s53"><patches><PolygonPatch><exterior><Ring><curveMember><Curve><segments>
    <GeodesicString><posList>50 8 50 9 51 9 50 8</posList></GeodesicString>
   </segments></Curve></curveMember></Ring></exterior></PolygonPatch></patches></Surface></horizontalProjection>
  </AirspaceVolume></theAirspaceVolume></AirspaceGeometryComponent></geometryComponent>
 </AirspaceTimeSlice></timeSlice></Airspace></hasMember>
</AIXMBasicMessage>`

// TestNoProjection: a volume stating no boundary of its own is told apart
// from one whose boundary decodes to nothing, the sidecar's watched count.
func TestNoProjection(t *testing.T) {
	msg, err := Decode([]byte(noProjectionMessage))
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	got := map[string]bool{}
	for _, a := range msg.Airspaces {
		got[a.Designator] = a.NoProjection
	}
	want := map[string]bool{"TMZ AGG": true, "UIR EMPTY": true, "TMZ OWN": false}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("NoProjection = %v, want %v", got, want)
	}
}

// geoBorderMessage: three boundaries follow the COAST border, filed after
// them as NATS files its coastlines, one the way the border runs, one
// against it, one from a vertex falling mid-segment; a fourth links a
// border the message does not hold.
const geoBorderMessage = `<?xml version="1.0"?>
<AIXMBasicMessage>
 <hasMember><Airspace gml:id="uuid.b0000000-0000-0000-0000-000000000001"><timeSlice><AirspaceTimeSlice>
  <interpretation>BASELINE</interpretation><type>D</type><designator>FORWARD</designator>
  <geometryComponent><AirspaceGeometryComponent><theAirspaceVolume><AirspaceVolume>
   <horizontalProjection><Surface gml:id="s1"><patches><PolygonPatch><exterior><Ring>
    <curveMember xlink:href="urn:uuid:c0a57000-0000-0000-0000-000000000001"/>
    <curveMember><Curve><segments><LineStringSegment><posList>49.95 0.3 50.5 0.3 50.5 0.1 49.95 0.1</posList></LineStringSegment></segments></Curve></curveMember>
   </Ring></exterior></PolygonPatch></patches></Surface></horizontalProjection>
  </AirspaceVolume></theAirspaceVolume></AirspaceGeometryComponent></geometryComponent>
 </AirspaceTimeSlice></timeSlice></Airspace></hasMember>
 <hasMember><Airspace gml:id="uuid.b0000000-0000-0000-0000-000000000002"><timeSlice><AirspaceTimeSlice>
  <interpretation>BASELINE</interpretation><type>D</type><designator>BACKWARD</designator>
  <geometryComponent><AirspaceGeometryComponent><theAirspaceVolume><AirspaceVolume>
   <horizontalProjection><Surface gml:id="s2"><patches><PolygonPatch><exterior><Ring>
    <curveMember><Curve><segments><LineStringSegment><posList>49.95 0.1 49.5 0.1 49.5 0.3 49.95 0.3</posList></LineStringSegment></segments></Curve></curveMember>
    <curveMember xlink:href="urn:uuid:c0a57000-0000-0000-0000-000000000001"/>
   </Ring></exterior></PolygonPatch></patches></Surface></horizontalProjection>
  </AirspaceVolume></theAirspaceVolume></AirspaceGeometryComponent></geometryComponent>
 </AirspaceTimeSlice></timeSlice></Airspace></hasMember>
 <hasMember><Airspace gml:id="uuid.b0000000-0000-0000-0000-000000000003"><timeSlice><AirspaceTimeSlice>
  <interpretation>BASELINE</interpretation><type>D</type><designator>MIDSEGMENT</designator>
  <geometryComponent><AirspaceGeometryComponent><theAirspaceVolume><AirspaceVolume>
   <horizontalProjection><Surface gml:id="s3"><patches><PolygonPatch><exterior><Ring>
    <curveMember xlink:href="urn:uuid:c0a57000-0000-0000-0000-000000000001"/>
    <curveMember><Curve><segments><LineStringSegment><posList>49.95 0.3 50.5 0.3 50.5 0.125 49.935 0.125</posList></LineStringSegment></segments></Curve></curveMember>
   </Ring></exterior></PolygonPatch></patches></Surface></horizontalProjection>
  </AirspaceVolume></theAirspaceVolume></AirspaceGeometryComponent></geometryComponent>
 </AirspaceTimeSlice></timeSlice></Airspace></hasMember>
 <hasMember><Airspace gml:id="uuid.b0000000-0000-0000-0000-000000000004"><timeSlice><AirspaceTimeSlice>
  <interpretation>BASELINE</interpretation><type>D</type><designator>UNHELD</designator>
  <geometryComponent><AirspaceGeometryComponent><theAirspaceVolume><AirspaceVolume>
   <horizontalProjection><Surface gml:id="s4"><patches><PolygonPatch><exterior><Ring>
    <curveMember xlink:href="urn:uuid:c0a57000-0000-0000-0000-000000000099"/>
    <curveMember><Curve><segments><LineStringSegment><posList>49.95 0.3 50.5 0.3 50.5 0.1 49.95 0.1</posList></LineStringSegment></segments></Curve></curveMember>
   </Ring></exterior></PolygonPatch></patches></Surface></horizontalProjection>
  </AirspaceVolume></theAirspaceVolume></AirspaceGeometryComponent></geometryComponent>
 </AirspaceTimeSlice></timeSlice></Airspace></hasMember>
 <hasMember><GeoBorder gml:id="id9"><identifier codeSpace="urn:uuid:">c0a57000-0000-0000-0000-000000000001</identifier><timeSlice><GeoBorderTimeSlice>
  <interpretation>BASELINE</interpretation><name>COAST</name>
  <border><Curve><segments><LineStringSegment><posList>50.0 0.0 49.95 0.1 49.92 0.15 49.9 0.2 49.92 0.25 49.95 0.3 50.0 0.4</posList></LineStringSegment></segments></Curve></border>
 </GeoBorderTimeSlice></timeSlice></GeoBorder></hasMember>
</AIXMBasicMessage>`

// TestGeoBorderFollowed: a boundary linking a GeoBorder follows the
// stretch of it between the ring's vertices on either side of the link, in
// the direction the ring runs, the border filed after the airspace or not.
// Unfollowed, it cut across (EGD802 CAPE WRATH up to 10 km off its coast,
// the Tbilisi FIR short of about 19 600 km2); a border the message does not
// hold is counted and the ring cuts across as before.
func TestGeoBorderFollowed(t *testing.T) {
	msg, err := Decode([]byte(geoBorderMessage))
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	got := map[string][][2]float64{}
	for _, a := range msg.Airspaces {
		got[a.Designator] = a.Ring
	}
	want := map[string][][2]float64{
		"FORWARD":    {{49.92, 0.15}, {49.9, 0.2}, {49.92, 0.25}, {49.95, 0.3}, {50.5, 0.3}, {50.5, 0.1}, {49.95, 0.1}},
		"BACKWARD":   {{49.95, 0.1}, {49.5, 0.1}, {49.5, 0.3}, {49.95, 0.3}, {49.92, 0.25}, {49.9, 0.2}, {49.92, 0.15}},
		"MIDSEGMENT": {{49.92, 0.15}, {49.9, 0.2}, {49.92, 0.25}, {49.95, 0.3}, {50.5, 0.3}, {50.5, 0.125}, {49.935, 0.125}},
		"UNHELD":     {{49.95, 0.3}, {50.5, 0.3}, {50.5, 0.1}, {49.95, 0.1}},
	}
	if !reflect.DeepEqual(got, want) {
		for k := range want {
			if !reflect.DeepEqual(got[k], want[k]) {
				t.Errorf("%s ring =\n  %v\nwant\n  %v", k, got[k], want[k])
			}
		}
	}
	if msg.UnresolvedGeometryXlinks != 1 || msg.UnresolvedXlinks != 1 {
		t.Errorf("UnresolvedGeometryXlinks = %d, UnresolvedXlinks = %d; want 1 and 1 (UNHELD's border)",
			msg.UnresolvedGeometryXlinks, msg.UnresolvedXlinks)
	}
}

// TestArcWholeTurns: a whole number of turns more is the same arc, and a
// whole number of turns alone is the full circle, the way the angles turn.
// Reduced after the test for a full circle, 0 to 720 came out a zero sweep
// and drew one NaN point, which failed the country's whole build, and an
// end a hair past a turn drew a two-point sliver.
func TestArcWholeTurns(t *testing.T) {
	full := int(math.Ceil(360/geodesy.ArcStepDeg)) + 1
	for _, c := range []struct {
		start, end string
		points     int
		clockwise  bool
	}{
		{"0", "720", full, true},
		{"10", "370.0000001", full, true},
		{"-360", "360", full, true},
		{"90", "-630", full, false},
		{"10", "380", int(math.Ceil(10/geodesy.ArcStepDeg)) + 1, true},
		{"10", "10", full, true},
	} {
		pts, ok, err := tessellateArc(gmlArc{
			Pos:        "50 8",
			Radius:     gmlRadius{UOM: "[nmi_i]", Value: "2"},
			StartAngle: gmlAngle{UOM: "deg", Value: c.start},
			EndAngle:   gmlAngle{UOM: "deg", Value: c.end},
		})
		if err != nil || !ok {
			t.Fatalf("%s to %s: %v, %v", c.start, c.end, ok, err)
		}
		if len(pts) != c.points {
			t.Errorf("%s to %s: %d points, want %d", c.start, c.end, len(pts), c.points)
		}
		for _, p := range pts {
			if math.IsNaN(p[0]) || math.IsNaN(p[1]) {
				t.Fatalf("%s to %s: a NaN point", c.start, c.end)
			}
		}
		// The first step turns the way the angles do.
		b0 := geodesy.InitialBearing(50, 8, pts[0][0], pts[0][1])
		b1 := geodesy.InitialBearing(50, 8, pts[1][0], pts[1][1])
		if turn := math.Mod(b1-b0+540, 360) - 180; (turn > 0) != c.clockwise {
			t.Errorf("%s to %s: first step turns %.1f degrees, want clockwise %v", c.start, c.end, turn, c.clockwise)
		}
	}
}

// TestJoinPartsClosingJunction: an arc's computed end gives way to the
// published vertex it meets across the ring's closing junction too, the
// ring closing on an arc or opening on one (164 UK rings drew a jog
// there), and never to a vertex further than arcSnapM: an arc ending a
// kilometre short of a corner is a boundary with a straight piece, not a
// junction off by a jog.
func TestJoinPartsClosingJunction(t *testing.T) {
	// 12 m north of the corner the ring opens with.
	corner, jog := [2]float64{50, 8}, [2]float64{50.000108, 8}
	line := ringPart{pts: [][2]float64{corner, {50, 8.1}, {50.1, 8.1}}}
	closing := ringPart{arc: true, pts: [][2]float64{{50.1, 8.1}, {50.08, 8.03}, {50.03, 8.004}, jog}}
	ring := joinParts([]ringPart{line, closing})
	if last := ring[len(ring)-1]; last == jog {
		t.Errorf("the closing arc keeps its computed end %v, 12 m from the corner it meets", last)
	}
	// Opening on the arc: its computed start gives way to the corner the
	// closing line ends on.
	opening := ringPart{arc: true, pts: [][2]float64{jog, {50.03, 8.004}, {50.08, 8.03}, {50.1, 8.1}}}
	back := ringPart{pts: [][2]float64{{50.1, 8.1}, {50, 8.1}, corner}}
	ring = joinParts([]ringPart{opening, back})
	if ring[0] == jog {
		t.Errorf("the opening arc keeps its computed start %v, 12 m from the corner the ring closes on", ring[0])
	}
	// A kilometre short: no junction, both kept.
	far := [2]float64{50.009, 8}
	closing.pts[len(closing.pts)-1] = far
	ring = joinParts([]ringPart{line, closing})
	if last := ring[len(ring)-1]; last != far {
		t.Errorf("an arc ending a kilometre from the corner was snapped onto it: ends at %v", last)
	}
}
