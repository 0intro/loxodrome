package aixm5

import (
	"math"
	"os"
	"path/filepath"
	"testing"

	"github.com/0intro/loxodrome/internal/geodesy"
)

// TestDecodeDonlonAIP walks the AIXM Donlon 2017 AIP sample and
// asserts the headline feature shapes. Donlon is the canonical AIXM
// 5.1.1 reference dataset (github.com/aixm/donlon), publicly
// licenced (BSD), and exercises every geometry kind we care about:
// polygon (FIR), circle (TMA), and a wide-corridor airspace.
func TestDecodeDonlonAIP(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("testdata", "donlon-aip.xml"))
	if err != nil {
		t.Fatal(err)
	}
	msg, err := Decode(src)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}

	if msg.Effective == "" {
		t.Errorf("Effective is empty; messageMetadata dateStamp should have been picked up")
	}
	if got, min := len(msg.Airspaces), 5; got < min {
		t.Errorf("Airspaces count = %d, want >= %d", got, min)
	}
	if msg.SkippedNonBaseline != 0 {
		t.Logf("SkippedNonBaseline = %d", msg.SkippedNonBaseline)
	}

	// Donlon has both polygon and circle airspaces; both should be
	// represented in the decoded set.
	var polygonFound, circleFound, withClass bool
	var withUpperLimit, withLowerLimit bool
	for i := range msg.Airspaces {
		a := &msg.Airspaces[i]
		if a.ClassCode != "" {
			withClass = true
		}
		if a.UpperLimit != nil {
			withUpperLimit = true
		}
		if a.LowerLimit != nil {
			withLowerLimit = true
		}
		// A GeodesicString polygon ring carries 4+ distinct vertices.
		// A CircleByCenterPoint tessellation produces geodesy.CircleSteps
		// (64) points exactly.
		switch len(a.Ring) {
		case 64:
			circleFound = true
		default:
			if len(a.Ring) >= 4 {
				polygonFound = true
			}
		}
	}
	if !polygonFound {
		t.Errorf("no airspace with a polygon ring decoded; ring lengths: %s",
			describeRings(msg.Airspaces))
	}
	if !circleFound {
		t.Errorf("no airspace with a circle ring decoded; ring lengths: %s",
			describeRings(msg.Airspaces))
	}
	if !withClass {
		t.Errorf("no airspace decoded with a ClassCode")
	}
	if !withUpperLimit {
		t.Errorf("no airspace decoded with an UpperLimit")
	}
	if !withLowerLimit {
		t.Errorf("no airspace decoded with a LowerLimit")
	}

	// Specifically: the AMSWELL FIR (uuid.f4d5e4d4-d84a-481f-b9e3-b359e42c0dff)
	// is a 9-vertex GeodesicString polygon. Our decoder should pick
	// that up verbatim.
	amswell := findAirspace(msg, "f4d5e4d4-d84a-481f-b9e3-b359e42c0dff")
	if amswell == nil {
		t.Fatalf("AMSWELL FIR not decoded")
	}
	if amswell.Type != "FIR" {
		t.Errorf("AMSWELL Type = %q, want FIR", amswell.Type)
	}
	if amswell.Designator != "EAAD" {
		t.Errorf("AMSWELL Designator = %q, want EAAD", amswell.Designator)
	}
	if amswell.Name != "AMSWELL" {
		t.Errorf("AMSWELL Name = %q, want AMSWELL", amswell.Name)
	}
	// FIRs commonly carry multiple class layers; the first one wins.
	if amswell.ClassCode == "" {
		t.Errorf("AMSWELL ClassCode is empty")
	}
	// 9 source vertices, densified along the declared great circles
	// (25 km steps; the Donlon segments are hundreds of km long).
	if got, want := len(amswell.Ring), 243; got != want {
		t.Errorf("AMSWELL ring length = %d, want %d", got, want)
	}
	// First vertex of the AMSWELL polygon, rounded.
	if len(amswell.Ring) > 0 {
		if got, want := amswell.Ring[0], [2]float64{57.08333, -40.0}; !approxRingEqual(got, want, 1e-5) {
			t.Errorf("AMSWELL Ring[0] = %v, want ~%v", got, want)
		}
	}

	// Airport + Navaid headline checks: Donlon AIP carries 2
	// AirportHeliports (EADD with runways, EADH as a heliport) and a
	// couple of VOR-DME composite navaids (BOR, DON).
	if got, want := len(msg.Airports), 2; got < want {
		t.Errorf("Airports = %d, want >= %d", got, want)
	}
	if got, want := len(msg.Navaids), 2; got < want {
		t.Errorf("Navaids = %d, want >= %d", got, want)
	}
	var sawVORDME bool
	for i := range msg.Navaids {
		if msg.Navaids[i].Type == "VOR-DME" {
			sawVORDME = true
			break
		}
	}
	if !sawVORDME {
		t.Errorf("expected at least one VOR-DME composite navaid")
	}
	// EADD has at least one runway (09L/27R per Donlon).
	var eadd *Airport
	for i := range msg.Airports {
		if msg.Airports[i].Designator == "EADD" {
			eadd = &msg.Airports[i]
		}
	}
	if eadd == nil {
		t.Fatalf("EADD airport not decoded")
	}
	if len(eadd.Runways) == 0 {
		t.Errorf("EADD has no runways; xlink resolution likely broken")
	}
	// Donlon publishes transitionAltitude 3500 FT on EADD.
	if eadd.TransitionAltM == nil || math.Abs(*eadd.TransitionAltM-3500*0.3048) > 1e-9 {
		t.Errorf("EADD TransitionAltM = %v, want 3500 ft (1066.8 m)", eadd.TransitionAltM)
	}

	// The NIBORD TMA (uuid.f0331134-d00a-4f9b-ac4f-34718d462729) is a
	// 50 NM CircleByCenterPoint; should tessellate to CircleSteps points.
	nibord := findAirspace(msg, "f0331134-d00a-4f9b-ac4f-34718d462729")
	if nibord == nil {
		t.Fatalf("NIBORD TMA not decoded")
	}
	if nibord.Type != "TMA" {
		t.Errorf("NIBORD Type = %q, want TMA", nibord.Type)
	}
	if got, want := len(nibord.Ring), 64; got != want {
		t.Errorf("NIBORD circle ring length = %d, want %d", got, want)
	}
	if nibord.ClassCode != "C" {
		t.Errorf("NIBORD ClassCode = %q, want C", nibord.ClassCode)
	}
	if nibord.UpperLimit == nil || nibord.UpperLimit.Value != "450" ||
		nibord.UpperLimit.Unit != "FL" {
		t.Errorf("NIBORD UpperLimit = %+v, want FL 450", nibord.UpperLimit)
	}
}

// TestDecodeDonlonObstacles walks the Donlon Area 1 obstacle dataset.
// Headline checks:
//   - >= 1 obstacle decoded
//   - lat/lon present and within Donlon's envelope (~40N-58N, -42E - -21E)
//   - the first VerticalStructure (OBS-0001, ANTENNA, 52.36N -28.04E)
//     carries name / type / height / elevation
func TestDecodeDonlonObstacles(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("testdata", "donlon-obs.xml"))
	if err != nil {
		t.Fatal(err)
	}
	msg, err := Decode(src)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}

	if len(msg.Obstacles) == 0 {
		t.Fatalf("no obstacles decoded")
	}
	// OBS-0001 is the first VerticalStructure in the file; an antenna
	// at 52.36171389 -28.03756667 with 120 m verticalExtent and 150 m
	// elevation. The decoder rounds coords to 5 dp and converts the
	// values to metres (already metres here).
	obs := findObstacle(msg, "5f68d835-828c-4ccd-91b7-791058d9dd4d")
	if obs == nil {
		t.Fatalf("OBS-0001 (5f68d835-...) not decoded; got idents: %v", obstacleIdents(msg))
	}
	if obs.Name != "OBS-0001" {
		t.Errorf("Name = %q, want OBS-0001", obs.Name)
	}
	if obs.Type != "ANTENNA" {
		t.Errorf("Type = %q, want ANTENNA", obs.Type)
	}
	if !obs.Lighted {
		t.Errorf("Lighted = false, want true")
	}
	if got, want := obs.Lat, 52.36171; math.Abs(got-want) > 1e-5 {
		t.Errorf("Lat = %v, want ~%v", got, want)
	}
	if got, want := obs.Lon, -28.03757; math.Abs(got-want) > 1e-5 {
		t.Errorf("Lon = %v, want ~%v", got, want)
	}
	if obs.HeightM == nil || math.Abs(*obs.HeightM-120) > 1e-6 {
		t.Errorf("HeightM = %v, want 120", obs.HeightM)
	}
	if obs.ElevM == nil || math.Abs(*obs.ElevM-150) > 1e-6 {
		t.Errorf("ElevM = %v, want 150", obs.ElevM)
	}
}

func TestParsePosList(t *testing.T) {
	cases := []struct {
		in   string
		want [][2]float64
	}{
		{"52.0 -30.0 53.0 -29.0", [][2]float64{{52, -30}, {53, -29}}},
		{"  52.0\n-30.0\n53.0\n-29.0  ", [][2]float64{{52, -30}, {53, -29}}},
		{"", nil},
	}
	for _, c := range cases {
		got, err := parsePosList(c.in)
		if err != nil {
			t.Errorf("parsePosList(%q): %v", c.in, err)
			continue
		}
		if len(got) != len(c.want) {
			t.Errorf("parsePosList(%q) = %v, want %v", c.in, got, c.want)
			continue
		}
		for i, p := range got {
			if math.Abs(p[0]-c.want[i][0]) > 1e-6 || math.Abs(p[1]-c.want[i][1]) > 1e-6 {
				t.Errorf("parsePosList(%q)[%d] = %v, want %v", c.in, i, p, c.want[i])
			}
		}
	}
	if _, err := parsePosList("52.0 -30.0 53.0"); err == nil {
		t.Errorf("odd value count should error")
	}
}

func TestRadiusToMeters(t *testing.T) {
	cases := []struct {
		val, uom string
		want     float64
		wantErr  bool
	}{
		{"5", "NM", 9260, false},
		{"5", "[nmi_i]", 9260, false},
		{"3", "KM", 3000, false},
		{"3", "km", 3000, false},
		{"250", "M", 250, false},
		{"1000", "FT", 304.8, false},
		{"1", "BANANA", 0, true},
	}
	for _, c := range cases {
		got, err := radiusToMeters(c.val, c.uom)
		if c.wantErr {
			if err == nil {
				t.Errorf("radiusToMeters(%q, %q) want error", c.val, c.uom)
			}
			continue
		}
		if err != nil {
			t.Errorf("radiusToMeters(%q, %q): %v", c.val, c.uom, err)
			continue
		}
		if math.Abs(got-c.want) > 1e-3 {
			t.Errorf("radiusToMeters(%q, %q) = %v, want %v", c.val, c.uom, got, c.want)
		}
	}
}

// helpers

func findAirspace(msg *Message, uuid string) *Airspace {
	for i := range msg.Airspaces {
		if msg.Airspaces[i].ID == uuid {
			return &msg.Airspaces[i]
		}
	}
	return nil
}

func findObstacle(msg *Message, uuid string) *Obstacle {
	for i := range msg.Obstacles {
		if msg.Obstacles[i].ID == uuid {
			return &msg.Obstacles[i]
		}
	}
	return nil
}

func obstacleIdents(msg *Message) []string {
	out := make([]string, 0, len(msg.Obstacles))
	for i := range msg.Obstacles {
		out = append(out, msg.Obstacles[i].ID)
	}
	return out
}

func describeRings(as []Airspace) string {
	out := ""
	for i := range as {
		if i > 5 {
			out += ", ..."
			break
		}
		if i > 0 {
			out += ", "
		}
		out += as[i].ID[:8] + "=" + itoa(len(as[i].Ring))
	}
	return out
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := false
	if n < 0 {
		neg = true
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

func approxRingEqual(got, want [2]float64, tol float64) bool {
	return math.Abs(got[0]-want[0]) < tol && math.Abs(got[1]-want[1]) < tol
}

// TestDecodeMultiComponentAirspace: an Airspace timeslice with several
// AirspaceGeometryComponents (AIXM 5.1 allows 0..*) decodes to one row per
// component, each with its own ring and vertical limits, and the feature
// counts into MultiComponentAirspaces.
func TestDecodeMultiComponentAirspace(t *testing.T) {
	src := []byte(`<?xml version="1.0"?>
<AIXMBasicMessage>
 <hasMember>
  <Airspace gml:id="uuid.7c6bfb26-0001-4f7f-9333-000000000001">
   <timeSlice>
    <AirspaceTimeSlice>
     <interpretation>BASELINE</interpretation>
     <type>TMA</type>
     <designator>EAMC</designator>
     <name>MULTI</name>
     <geometryComponent>
      <AirspaceGeometryComponent>
       <theAirspaceVolume>
        <AirspaceVolume>
         <upperLimit uom="FL">195</upperLimit>
         <upperLimitReference>STD</upperLimitReference>
         <lowerLimit uom="FT">2500</lowerLimit>
         <lowerLimitReference>MSL</lowerLimitReference>
         <horizontalProjection>
          <Surface>
           <patches>
            <PolygonPatch>
             <exterior>
              <Ring>
               <curveMember>
                <Curve>
                 <segments>
                  <GeodesicString>
                   <posList>50 -1 50 0 51 0 51 -1 50 -1</posList>
                  </GeodesicString>
                 </segments>
                </Curve>
               </curveMember>
              </Ring>
             </exterior>
            </PolygonPatch>
           </patches>
          </Surface>
         </horizontalProjection>
        </AirspaceVolume>
       </theAirspaceVolume>
      </AirspaceGeometryComponent>
     </geometryComponent>
     <geometryComponent>
      <AirspaceGeometryComponent>
       <theAirspaceVolume>
        <AirspaceVolume>
         <upperLimit uom="FT">2500</upperLimit>
         <upperLimitReference>MSL</upperLimitReference>
         <lowerLimit>GND</lowerLimit>
         <lowerLimitReference>SFC</lowerLimitReference>
         <horizontalProjection>
          <Surface>
           <patches>
            <PolygonPatch>
             <exterior>
              <Ring>
               <curveMember>
                <Curve>
                 <segments>
                  <GeodesicString>
                   <posList>52 -1 52 0 53 0 53 -1 52 -1</posList>
                  </GeodesicString>
                 </segments>
                </Curve>
               </curveMember>
              </Ring>
             </exterior>
            </PolygonPatch>
           </patches>
          </Surface>
         </horizontalProjection>
        </AirspaceVolume>
       </theAirspaceVolume>
      </AirspaceGeometryComponent>
     </geometryComponent>
    </AirspaceTimeSlice>
   </timeSlice>
  </Airspace>
 </hasMember>
</AIXMBasicMessage>`)
	msg, err := Decode(src)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if got, want := len(msg.Airspaces), 2; got != want {
		t.Fatalf("Airspaces = %d, want %d (one row per geometry component)", got, want)
	}
	if msg.MultiComponentAirspaces != 1 {
		t.Errorf("MultiComponentAirspaces = %d, want 1", msg.MultiComponentAirspaces)
	}
	a, b := &msg.Airspaces[0], &msg.Airspaces[1]
	for _, r := range []*Airspace{a, b} {
		if r.Designator != "EAMC" || r.Name != "MULTI" || r.Type != "TMA" {
			t.Errorf("shared identity not carried: %+v", r)
		}
	}
	if a.UpperLimit == nil || a.UpperLimit.Value != "195" || a.UpperLimit.Unit != "FL" {
		t.Errorf("first component UpperLimit = %+v, want FL 195", a.UpperLimit)
	}
	if b.UpperLimit == nil || b.UpperLimit.Value != "2500" || b.UpperLimit.Unit != "FT" {
		t.Errorf("second component UpperLimit = %+v, want 2500 FT", b.UpperLimit)
	}
	// 4 corners each, densified along the declared great circles (the
	// 1-degree edges exceed the 25 km step), closing vertex dropped.
	if len(a.Ring) != 16 || len(b.Ring) != 16 {
		t.Fatalf("ring lengths = %d / %d, want 16 / 16 (densified, closing vertex dropped)", len(a.Ring), len(b.Ring))
	}
	if !approxRingEqual(a.Ring[0], [2]float64{50, -1}, 1e-9) {
		t.Errorf("first component Ring[0] = %v, want [50 -1]", a.Ring[0])
	}
	if !approxRingEqual(b.Ring[0], [2]float64{52, -1}, 1e-9) {
		t.Errorf("second component Ring[0] = %v, want [52 -1]", b.Ring[0])
	}
}

// TestDecodeMixedSegmentKindsInOrder: NATS encodes the FIR boundaries
// as ONE curve whose <gml:segments> interleaves GeodesicString runs
// with linear LineStringSegment stretches along parallels (LONDON FIR:
// geodesics for the borders, linear runs along 50N and 55N). Per-kind
// struct grouping used to concatenate all geodesics before all lines,
// re-ordering the ring into a self-crossing bowtie (the EGTT001 bug).
// The ring must come out in document order with the junction
// duplicates collapsed and the closing vertex dropped.
func TestDecodeMixedSegmentKindsInOrder(t *testing.T) {
	src := []byte(`<?xml version="1.0"?>
<AIXMBasicMessage>
 <hasMember>
  <Airspace gml:id="uuid.7c6bfb26-0002-4f7f-9333-000000000002">
   <timeSlice>
    <AirspaceTimeSlice>
     <interpretation>BASELINE</interpretation>
     <type>FIR</type>
     <designator>EGTT</designator>
     <name>MINI LONDON</name>
     <geometryComponent>
      <AirspaceGeometryComponent>
       <theAirspaceVolume>
        <AirspaceVolume>
         <horizontalProjection>
          <Surface>
           <patches>
            <PolygonPatch>
             <exterior>
              <Ring>
               <curveMember>
                <Curve>
                 <segments>
                  <GeodesicString interpolation="geodesic">
                   <pointProperty><Point><pos>55.0 5.0</pos></Point></pointProperty>
                   <pointProperty><Point><pos>51.5 2.0</pos></Point></pointProperty>
                   <pointProperty><Point><pos>50.0 -0.25</pos></Point></pointProperty>
                  </GeodesicString>
                  <LineStringSegment interpolation="linear">
                   <pointProperty><Point><pos>50.0 -0.25</pos></Point></pointProperty>
                   <pointProperty><Point><pos>50.0 -2.0</pos></Point></pointProperty>
                  </LineStringSegment>
                  <GeodesicString interpolation="geodesic">
                   <pointProperty><Point><pos>50.0 -2.0</pos></Point></pointProperty>
                   <pointProperty><Point><pos>51.0 -8.0</pos></Point></pointProperty>
                   <pointProperty><Point><pos>55.0 -5.5</pos></Point></pointProperty>
                  </GeodesicString>
                  <LineStringSegment interpolation="linear">
                   <pointProperty><Point><pos>55.0 -5.5</pos></Point></pointProperty>
                   <pointProperty><Point><pos>55.0 5.0</pos></Point></pointProperty>
                  </LineStringSegment>
                 </segments>
                </Curve>
               </curveMember>
              </Ring>
             </exterior>
            </PolygonPatch>
           </patches>
          </Surface>
         </horizontalProjection>
        </AirspaceVolume>
       </theAirspaceVolume>
      </AirspaceGeometryComponent>
     </geometryComponent>
    </AirspaceTimeSlice>
   </timeSlice>
  </Airspace>
 </hasMember>
</AIXMBasicMessage>`)
	msg, err := Decode(src)
	if err != nil {
		t.Fatal(err)
	}
	if len(msg.Airspaces) != 1 {
		t.Fatalf("Airspaces = %d, want 1", len(msg.Airspaces))
	}
	got := msg.Airspaces[0].Ring
	// The six corners must appear in DOCUMENT order (the old per-kind
	// grouping scattered the linear runs to the end); geodesic legs are
	// densified between them, linear legs stay unexpanded chords.
	corners := [][2]float64{
		{55, 5}, {51.5, 2}, {50, -0.25}, {50, -2}, {51, -8}, {55, -5.5},
	}
	idx := make([]int, 0, len(corners))
	at := 0
	for _, c := range corners {
		found := -1
		for i := at; i < len(got); i++ {
			if approxRingEqual(got[i], c, 1e-5) {
				found = i
				break
			}
		}
		if found == -1 {
			t.Fatalf("corner %v not found in order in Ring %v", c, got)
		}
		idx = append(idx, found)
		at = found + 1
	}
	if idx[0] != 0 {
		t.Errorf("Ring starts at %v, want the first corner [55 5]", got[0])
	}
	// Linear legs: [50 -0.25] -> [50 -2] adjacent, and the closing
	// [55 -5.5] -> [55 5] run leaves [55 -5.5] as the LAST point (the
	// closing duplicate of the first corner is dropped).
	if idx[3] != idx[2]+1 {
		t.Errorf("linear 50N leg was expanded: corners at %d and %d", idx[2], idx[3])
	}
	if idx[5] != len(got)-1 {
		t.Errorf("Ring ends at %v, want the last corner [55 -5.5]", got[len(got)-1])
	}
	// Geodesic legs are densified: no two consecutive points further
	// apart than one step (+1 m slack). The two LINEAR legs, the 50N
	// run [50 -0.25] -> [50 -2] and the closing 55N run
	// [55 -5.5] -> [55 5], stay chords by design.
	linear := func(a, b [2]float64) bool {
		return (approxRingEqual(a, corners[2], 1e-5) && approxRingEqual(b, corners[3], 1e-5)) ||
			(approxRingEqual(a, corners[5], 1e-5) && approxRingEqual(b, corners[0], 1e-5))
	}
	prev := got[len(got)-1]
	for _, p := range got {
		if d := geodesy.DistanceM(prev[0], prev[1], p[0], p[1]); prev != p && d > geodesy.GreatCircleStepM+1 && !linear(prev, p) {
			t.Fatalf("gap %v -> %v is %.0f m, want <= %.0f", prev, p, d, geodesy.GreatCircleStepM)
		}
		prev = p
	}
	if msg.UnresolvedXlinks != 0 {
		t.Errorf("UnresolvedXlinks = %d, want 0", msg.UnresolvedXlinks)
	}
}

// TestDecodeAirportAbandoned pins the two operational-status signals
// DFS publishes on its aerodromes: aixm:abandoned, the permanent
// statement the emitters map to the "closed" type, and the
// availability's operationalStatus, which a Timesheet scopes to a
// period (EDOP's winter closure has that shape, so only an
// unconditional status is reported as standing).
func TestDecodeAirportAbandoned(t *testing.T) {
	src := []byte(`<?xml version="1.0"?>
<AIXMBasicMessage>
 <hasMember>
  <AirportHeliport gml:id="uuid.aa000000-0000-0000-0000-000000000001">
   <timeSlice>
    <AirportHeliportTimeSlice>
     <interpretation>BASELINE</interpretation>
     <designator>EDXA</designator>
     <name>ABANDONED PLAIN</name>
     <type>LS</type>
     <abandoned>YES</abandoned>
     <availability>
      <AirportHeliportAvailability>
       <timeInterval nilReason="unknown" xsi:nil="true"/>
       <operationalStatus>CLOSED</operationalStatus>
      </AirportHeliportAvailability>
     </availability>
    </AirportHeliportTimeSlice>
   </timeSlice>
  </AirportHeliport>
 </hasMember>
 <hasMember>
  <AirportHeliport gml:id="uuid.aa000000-0000-0000-0000-000000000002">
   <timeSlice>
    <AirportHeliportTimeSlice>
     <interpretation>BASELINE</interpretation>
     <designator>EDXB</designator>
     <name>ABANDONED SEASONAL</name>
     <type>LS</type>
     <abandoned>YES</abandoned>
     <availability>
      <AirportHeliportAvailability>
       <timeInterval>
        <Timesheet>
         <timeReference>UTC</timeReference>
         <startDate>EDLST</startDate>
         <endDate>SDLST</endDate>
        </Timesheet>
       </timeInterval>
       <operationalStatus>CLOSED</operationalStatus>
      </AirportHeliportAvailability>
     </availability>
    </AirportHeliportTimeSlice>
   </timeSlice>
  </AirportHeliport>
 </hasMember>
 <hasMember>
  <AirportHeliport gml:id="uuid.aa000000-0000-0000-0000-000000000003">
   <timeSlice>
    <AirportHeliportTimeSlice>
     <interpretation>BASELINE</interpretation>
     <designator>EDXC</designator>
     <name>OPEN HELIPORT</name>
     <type>HP</type>
     <abandoned>NO</abandoned>
     <availability>
      <AirportHeliportAvailability>
       <operationalStatus>NORMAL</operationalStatus>
       <usage>
        <AirportHeliportUsage>
         <type>PERMIT</type>
        </AirportHeliportUsage>
       </usage>
      </AirportHeliportAvailability>
     </availability>
    </AirportHeliportTimeSlice>
   </timeSlice>
  </AirportHeliport>
 </hasMember>
</AIXMBasicMessage>`)
	msg, err := Decode(src)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	byIcao := map[string]*Airport{}
	for i := range msg.Airports {
		byIcao[msg.Airports[i].Designator] = &msg.Airports[i]
	}
	cases := []struct {
		icao      string
		abandoned bool
		status    string
	}{
		{"EDXA", true, "CLOSED"},
		{"EDXB", true, ""},
		{"EDXC", false, "NORMAL"},
	}
	for _, c := range cases {
		a := byIcao[c.icao]
		if a == nil {
			t.Fatalf("%s not decoded", c.icao)
		}
		if a.Abandoned != c.abandoned {
			t.Errorf("%s Abandoned = %v, want %v", c.icao, a.Abandoned, c.abandoned)
		}
		if a.OperationalStatus != c.status {
			t.Errorf("%s OperationalStatus = %q, want %q", c.icao, a.OperationalStatus, c.status)
		}
	}
	if a := byIcao["EDXC"]; a != nil && a.Access != "cap" {
		t.Errorf("EDXC Access = %q, want cap (the usage tree still digests)", a.Access)
	}
}

// TestObstacleCRS84Order covers the coordinate-order trap. AIXM's own
// convention, and the EPSG:4326 axis order, is latitude first; the OGC
// CRS84 identifier means the opposite. FOCA publishes the Swiss obstacle
// register in CRS84, and reading one as the other put Switzerland in
// Somalia.
func TestObstacleCRS84Order(t *testing.T) {
	const doc = `<?xml version="1.0"?>
<message:AIXMBasicMessage xmlns:message="http://www.aixm.aero/schema/5.1/message"
    xmlns:aixm="http://www.aixm.aero/schema/5.1" xmlns:gml="http://www.opengis.net/gml/3.2">
  <message:hasMember>
    <aixm:VerticalStructure gml:id="v1">
      <gml:identifier codeSpace="urn:uuid:">crs84</gml:identifier>
      <aixm:timeSlice><aixm:VerticalStructureTimeSlice gml:id="t1">
        <aixm:interpretation>BASELINE</aixm:interpretation>
        <aixm:name>SWISS MAST</aixm:name>
        <aixm:type>MAST</aixm:type>
        <aixm:part><aixm:VerticalStructurePart gml:id="p1">
          <aixm:verticalExtent uom="M">30</aixm:verticalExtent>
          <aixm:horizontalProjection_location>
            <aixm:ElevatedPoint srsName="urn:ogc:def:crs:OGC:1.3:CRS84" gml:id="e1">
              <gml:pos>7.91031674 46.59800138</gml:pos>
            </aixm:ElevatedPoint>
          </aixm:horizontalProjection_location>
        </aixm:VerticalStructurePart></aixm:part>
      </aixm:VerticalStructureTimeSlice></aixm:timeSlice>
    </aixm:VerticalStructure>
  </message:hasMember>
  <message:hasMember>
    <aixm:VerticalStructure gml:id="v2">
      <gml:identifier codeSpace="urn:uuid:">plain</gml:identifier>
      <aixm:timeSlice><aixm:VerticalStructureTimeSlice gml:id="t2">
        <aixm:interpretation>BASELINE</aixm:interpretation>
        <aixm:name>PLAIN MAST</aixm:name>
        <aixm:type>MAST</aixm:type>
        <aixm:part><aixm:VerticalStructurePart gml:id="p2">
          <aixm:horizontalProjection_location>
            <aixm:ElevatedPoint gml:id="e2"><gml:pos>46.59800138 7.91031674</gml:pos></aixm:ElevatedPoint>
          </aixm:horizontalProjection_location>
        </aixm:VerticalStructurePart></aixm:part>
      </aixm:VerticalStructureTimeSlice></aixm:timeSlice>
    </aixm:VerticalStructure>
  </message:hasMember>
</message:AIXMBasicMessage>`
	msg, err := Decode([]byte(doc))
	if err != nil {
		t.Fatal(err)
	}
	if len(msg.Obstacles) != 2 {
		t.Fatalf("got %d obstacles, want 2", len(msg.Obstacles))
	}
	for _, o := range msg.Obstacles {
		// Both rows describe the same mast in the Bernese Oberland.
		if o.Lat < 46 || o.Lat > 47 || o.Lon < 7 || o.Lon > 8 {
			t.Errorf("%s: got (%.5f, %.5f), want a point in Switzerland", o.ID, o.Lat, o.Lon)
		}
	}
}

// TestObstacleLinearExtent covers a linear obstacle, and the rule that
// an obstacle is placed at the first part carrying a position rather
// than literally the first part. FOCA files a power line with its spans
// first and its pylons after; taking parts[0] dropped every transmission
// line, catenary and cableway in Switzerland.
func TestObstacleLinearExtent(t *testing.T) {
	const doc = `<?xml version="1.0"?>
<message:AIXMBasicMessage xmlns:message="http://www.aixm.aero/schema/5.1/message"
    xmlns:aixm="http://www.aixm.aero/schema/5.1" xmlns:gml="http://www.opengis.net/gml/3.2">
  <message:hasMember>
    <aixm:VerticalStructure gml:id="v1">
      <gml:identifier codeSpace="urn:uuid:">span-first</gml:identifier>
      <aixm:timeSlice><aixm:VerticalStructureTimeSlice gml:id="t1">
        <aixm:interpretation>BASELINE</aixm:interpretation>
        <aixm:name>POWER LINE</aixm:name>
        <aixm:type>TRANSMISSION_LINE</aixm:type>
        <aixm:part><aixm:VerticalStructurePart gml:id="p1">
          <aixm:horizontalProjection_linearExtent>
            <aixm:ElevatedCurve srsName="urn:ogc:def:crs:OGC:1.3:CRS84" gml:id="c1">
              <gml:segments><gml:GeodesicString>
                <gml:posList>7.91031674 46.59800138 7.9103687 46.59852796</gml:posList>
              </gml:GeodesicString></gml:segments>
            </aixm:ElevatedCurve>
          </aixm:horizontalProjection_linearExtent>
        </aixm:VerticalStructurePart></aixm:part>
        <aixm:part><aixm:VerticalStructurePart gml:id="p2">
          <aixm:verticalExtent uom="M">42</aixm:verticalExtent>
          <aixm:horizontalProjection_location>
            <aixm:ElevatedPoint srsName="urn:ogc:def:crs:OGC:1.3:CRS84" gml:id="e1">
              <gml:pos>7.95 46.60</gml:pos>
              <aixm:elevation uom="M">810</aixm:elevation>
            </aixm:ElevatedPoint>
          </aixm:horizontalProjection_location>
        </aixm:VerticalStructurePart></aixm:part>
      </aixm:VerticalStructureTimeSlice></aixm:timeSlice>
    </aixm:VerticalStructure>
  </message:hasMember>
  <message:hasMember>
    <aixm:VerticalStructure gml:id="v2">
      <gml:identifier codeSpace="urn:uuid:">span-only</gml:identifier>
      <aixm:timeSlice><aixm:VerticalStructureTimeSlice gml:id="t2">
        <aixm:interpretation>BASELINE</aixm:interpretation>
        <aixm:name>CABLEWAY</aixm:name>
        <aixm:type>CABLE_CAR</aixm:type>
        <aixm:part><aixm:VerticalStructurePart gml:id="p3">
          <aixm:horizontalProjection_linearExtent>
            <aixm:ElevatedCurve srsName="urn:ogc:def:crs:OGC:1.3:CRS84" gml:id="c2">
              <gml:segments><gml:GeodesicString>
                <gml:posList>8.10 46.70 8.11 46.71</gml:posList>
              </gml:GeodesicString></gml:segments>
            </aixm:ElevatedCurve>
          </aixm:horizontalProjection_linearExtent>
        </aixm:VerticalStructurePart></aixm:part>
      </aixm:VerticalStructureTimeSlice></aixm:timeSlice>
    </aixm:VerticalStructure>
  </message:hasMember>
</message:AIXMBasicMessage>`
	msg, err := Decode([]byte(doc))
	if err != nil {
		t.Fatal(err)
	}
	if len(msg.Obstacles) != 2 {
		t.Fatalf("got %d obstacles, want 2 (a span-only obstacle must not vanish)", len(msg.Obstacles))
	}
	byID := map[string]Obstacle{}
	for _, o := range msg.Obstacles {
		byID[o.ID] = o
	}
	// The pylon part carries the position, the height and the elevation,
	// even though the span is filed first.
	pl := byID["span-first"]
	if pl.Lat < 46.59 || pl.Lat > 46.61 || pl.Lon < 7.94 || pl.Lon > 7.96 {
		t.Errorf("power line placed at (%.5f, %.5f), want the pylon", pl.Lat, pl.Lon)
	}
	if pl.HeightM == nil || *pl.HeightM != 42 {
		t.Errorf("power line height lost")
	}
	if pl.ElevM == nil || *pl.ElevM != 810 {
		t.Errorf("power line elevation lost")
	}
	// A cableway with nothing but a span still lands on its span.
	cw := byID["span-only"]
	if cw.Lat < 46.69 || cw.Lat > 46.71 || cw.Lon < 8.09 || cw.Lon > 8.11 {
		t.Errorf("cableway placed at (%.5f, %.5f)", cw.Lat, cw.Lon)
	}
}
