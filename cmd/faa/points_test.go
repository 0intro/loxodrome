package main

import (
	"testing"
)

// geojson builds a minimal FeatureCollection for the point builders.
func geojson(features ...string) []byte {
	out := `{"type":"FeatureCollection","features":[`
	for i, f := range features {
		if i > 0 {
			out += ","
		}
		out += f
	}
	return []byte(out + "]}")
}

func pointFeature(lon, lat string, props string) string {
	return `{"type":"Feature","geometry":{"type":"Point","coordinates":[` + lon + `,` + lat + `]},"properties":{` + props + `}}`
}

// TestBuildNavaidsTypes pins the NASR type-code mapping, the frequency
// unit rule and the CNF drop.
func TestBuildNavaidsTypes(t *testing.T) {
	systems := geojson(
		pointFeature("-77.4", "38.9", `"IDENT":"AML","NAME_TXT":"ARMEL","TYPE_CODE":8`),
		pointFeature("-87.7", "41.9", `"IDENT":"OBK","NAME_TXT":"NORTHBROOK","TYPE_CODE":6`),
		pointFeature("-70.0", "42.0", `"IDENT":"BOS","NAME_TXT":"BOSTON","TYPE_CODE":3`),
		// An unmapped code is reported, not guessed at.
		pointFeature("-70.1", "42.1", `"IDENT":"XXX","NAME_TXT":"MYSTERY","TYPE_CODE":42`),
	)
	components := geojson(
		pointFeature("-77.4", "38.9", `"IDENT_TXT":"AML","FREQUENCY_VAL":113.5,"CHANNEL_TXT":"082X","ELEV_VAL":340`),
		pointFeature("-87.7", "41.9", `"IDENT_TXT":"OBK","FREQUENCY_VAL":113.0`),
		pointFeature("-70.0", "42.0", `"IDENT_TXT":"BOS","FREQUENCY_VAL":388`),
	)
	points := geojson(
		pointFeature("-72.0", "41.0", `"IDENT":"HOTEL","TYPE_CODE":"WPT"`),
		pointFeature("-72.1", "41.1", `"IDENT":"BRAVO","TYPE_CODE":"RPT"`),
		pointFeature("-72.2", "41.2", `"IDENT":"CNF01","TYPE_CODE":"CNF"`),
	)

	art, meta, err := BuildNavaids(systems, components, points, NavaidsOptions{
		Now: fixedNow, MinNavaids: 1, MaxNavaids: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	if meta.SkippedCnf != 1 {
		t.Errorf("SkippedCnf = %d, want 1 (a Computer Navigation Fix is not a charted point)", meta.SkippedCnf)
	}
	if meta.RadioCount != 3 || meta.PointCount != 2 {
		t.Errorf("radio = %d, points = %d, want 3 and 2", meta.RadioCount, meta.PointCount)
	}
	if len(meta.UnknownTypes) != 1 || meta.UnknownTypes[0] != "NAVAID:42" {
		t.Errorf("UnknownTypes = %v, want the unmapped NASR code reported", meta.UnknownTypes)
	}

	byIdent := map[string][]any{}
	for _, r := range art.Rows {
		cells := r.([]any)
		byIdent[cells[2].(string)] = cells
	}
	if got := byIdent["AML"][1]; got != "VORTAC" {
		t.Errorf("AML type = %v, want VORTAC", got)
	}
	if got := byIdent["OBK"][1]; got != "VOR-DME" {
		t.Errorf("OBK type = %v, want VOR-DME", got)
	}
	// The VHF navaid frequency is MHz to three decimals...
	if got := byIdent["AML"][6]; got != "113.500" {
		t.Errorf("AML freq = %v, want 113.500 MHz", got)
	}
	// ...and the NDB carrier is whole kHz. The magnitudes overlap, so
	// the type is what picks the unit.
	if got := byIdent["BOS"][1]; got != "NDB" {
		t.Errorf("BOS type = %v, want NDB", got)
	}
	if got := byIdent["BOS"][6]; got != "388" {
		t.Errorf("BOS freq = %v, want 388 kHz", got)
	}
	if got := byIdent["HOTEL"][1]; got != "WAYPOINT" {
		t.Errorf("HOTEL type = %v, want WAYPOINT", got)
	}
	if got := byIdent["BRAVO"][1]; got != "VFR_REPORTING_POINT" {
		t.Errorf("BRAVO type = %v, want VFR_REPORTING_POINT", got)
	}
	if meta.BBox == nil {
		t.Error("the meta should carry the envelope the coverage gate reads")
	}
}

// TestBuildObstaclesTypes pins the FAA obstacle vocabulary, which is its
// own codelist and not the AIXM one, plus the lighting and cluster rules.
func TestBuildObstaclesTypes(t *testing.T) {
	raw := geojson(
		pointFeature("-97.0", "35.0", `"OAS_Number":"01-000001","Type_Code":"WINDMILL          ","City":"WOODWARD","AGL":512,"AMSL":2510,"Lighting":"R","Quantity":"1"`),
		pointFeature("-97.1", "35.1", `"OAS_Number":"01-000002","Type_Code":"T-L TWR           ","City":"ENID","AGL":600,"AMSL":1900,"Lighting":"N","Quantity":"3"`),
		pointFeature("-97.2", "35.2", `"OAS_Number":"01-000003","Type_Code":"COOL TWR          ","City":"TULSA","AGL":700,"AMSL":1400,"Lighting":"U","Quantity":"1"`),
		pointFeature("-97.3", "35.3", `"OAS_Number":"01-000004","Type_Code":"ZEPPELIN MOORING  ","City":"NOWHERE","AGL":800,"AMSL":900,"Lighting":"D","Quantity":"1"`),
	)
	art, meta, err := BuildObstacles(raw, ObstaclesOptions{
		Now: fixedNow, MinObstacles: 1, MaxObstacles: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	if meta.FloorFt != usObstacleFloorFt {
		t.Errorf("FloorFt = %d, want the height filter recorded in the meta", meta.FloorFt)
	}
	byID := map[string][]any{}
	for _, r := range art.Rows {
		cells := r.([]any)
		byID[cells[0].(string)] = cells
	}
	if got := byID["faa:01-000001"][1]; got != "windturbine" {
		t.Errorf("WINDMILL -> %v, want windturbine", got)
	}
	// The padded, space-separated FAA spellings normalise before lookup.
	if got := byID["faa:01-000002"][1]; got != "pylon" {
		t.Errorf("T-L TWR -> %v, want pylon", got)
	}
	if got := byID["faa:01-000003"][1]; got != "tower" {
		t.Errorf("COOL TWR -> %v, want tower", got)
	}
	// "N" (none) and "U" (unknown) are not lit; anything else is.
	if lit := byID["faa:01-000001"][7].(bool); !lit {
		t.Error("lighting R should count as lit")
	}
	if lit := byID["faa:01-000002"][7].(bool); lit {
		t.Error("lighting N should not count as lit")
	}
	if lit := byID["faa:01-000003"][7].(bool); lit {
		t.Error("lighting U (unknown) should not be asserted as lit")
	}
	if meta.LitCount != 2 {
		t.Errorf("LitCount = %d, want 2", meta.LitCount)
	}
	// Quantity > 1 is the DOF's cluster flag.
	if grp := byID["faa:01-000002"][8].(bool); !grp {
		t.Error("Quantity 3 should set the group flag")
	}
	if grp := byID["faa:01-000001"][8].(bool); grp {
		t.Error("Quantity 1 should not set the group flag")
	}
	// An unmapped code falls back to "other" and is reported.
	if got := byID["faa:01-000004"][1]; got != "other" {
		t.Errorf("unmapped type -> %v, want other", got)
	}
	if len(meta.UnknownTypes) != 1 {
		t.Errorf("UnknownTypes = %v, want the unmapped spelling reported", meta.UnknownTypes)
	}
}

func TestBuildNavaidsSanityWindow(t *testing.T) {
	systems := geojson(pointFeature("-77.4", "38.9", `"IDENT":"AML","TYPE_CODE":8`))
	empty := geojson()
	if _, _, err := BuildNavaids(systems, empty, empty, NavaidsOptions{
		Now: fixedNow, MinNavaids: 100, MaxNavaids: 200,
	}); err == nil {
		t.Error("a count below the floor should fail the sanity window")
	}
}

// TestRenderSchedule pins the Airspace_Schedule rendering: the AIXM
// timesheets collapse into the same day-and-time prose the AIXM
// publishers already put in the hours column.
func TestRenderSchedule(t *testing.T) {
	sheet := func(day, start, end string) string {
		return `<Timesheet><timeReference>UTC-6</timeReference><startDate>01-01</startDate>` +
			`<endDate>31-12</endDate><day>` + day + `</day><startTime>` + start +
			`</startTime><endTime>` + end + `</endTime></Timesheet>`
	}
	cases := []struct{ in, want string }{
		// A single all-days sheet.
		{`<schedule>` + sheet("ANY", "06:00", "22:00") + `</schedule>`, "ANY 06:00-22:00 (UTC-6)"},
		// A contiguous weekday run collapses to a range, and the weekend
		// window stays its own part.
		{`<schedule>` +
			sheet("MON", "07:00", "23:00") + sheet("TUE", "07:00", "23:00") +
			sheet("WED", "07:00", "23:00") + sheet("THU", "07:00", "23:00") +
			sheet("FRI", "07:00", "23:00") +
			sheet("SAT", "07:00", "17:00") + sheet("SUN", "07:00", "17:00") +
			`</schedule>`,
			"MON-FRI 07:00-23:00; SAT-SUN 07:00-17:00 (UTC-6)"},
		// Every day on one window is just ANY.
		{`<schedule>` +
			sheet("MON", "06:00", "22:00") + sheet("TUE", "06:00", "22:00") +
			sheet("WED", "06:00", "22:00") + sheet("THU", "06:00", "22:00") +
			sheet("FRI", "06:00", "22:00") + sheet("SAT", "06:00", "22:00") +
			sheet("SUN", "06:00", "22:00") + `</schedule>`,
			"ANY 06:00-22:00 (UTC-6)"},
		// Unparseable input yields nothing rather than a guess.
		{`not xml`, ""},
	}
	for _, c := range cases {
		if got := renderSchedule(c.in); got != c.want {
			t.Errorf("renderSchedule:\n got %q\nwant %q", got, c.want)
		}
	}
}

// TestUsAirportType pins the facility-type mapping, including the rule
// that a closed field is closed whatever its shape says.
func TestUsAirportType(t *testing.T) {
	cases := []struct {
		code   string
		closed bool
		ft     int
		want   string
	}{
		{"AD", false, 9000, "large_airport"},
		{"AD", false, 5000, "medium_airport"},
		{"AD", false, 2000, "small_airport"},
		{"AD", true, 9000, "closed"},
		{"HP", false, 0, "heliport"},
		{"SP", false, 0, "seaplane_base"},
		{"BP", false, 0, "balloonport"},
		{"GL", false, 0, "small_airport"},
		{"UL", false, 0, "small_airport"},
	}
	for _, c := range cases {
		if got := usAirportType(c.code, c.closed, c.ft); got != c.want {
			t.Errorf("usAirportType(%q, %v, %d) = %q, want %q", c.code, c.closed, c.ft, got, c.want)
		}
	}
}

// TestBuildAirportsIdentAndStatus pins the ident rule (the ICAO code when
// there is one, else the FAA identifier, which is how the OurAirports
// baseline names US fields) and the status mapping.
func TestBuildAirportsIdentAndStatus(t *testing.T) {
	airports := geojson(
		pointFeature("-87.9", "41.97", `"GLOBAL_ID":"A","IDENT":"ORD","ICAO_ID":"KORD","NAME":"Chicago O'Hare Intl","TYPE_CODE":"AD","OPERSTATUS":"OPERATIONAL","PRIVATEUSE":0,"IAPEXISTS":1,"MIL_CODE":"CIVIL","ELEVATION":680,"SERVCITY":"CHICAGO"`),
		pointFeature("-97.0", "35.0", `"GLOBAL_ID":"B","IDENT":"00A","NAME":"Total Rf","TYPE_CODE":"HP","OPERSTATUS":"OPERATIONAL","PRIVATEUSE":1,"IAPEXISTS":0,"MIL_CODE":"CIVIL"`),
		pointFeature("-76.0", "38.8", `"GLOBAL_ID":"C","IDENT":"ADW","ICAO_ID":"KADW","NAME":"Joint Base Andrews","TYPE_CODE":"AD","OPERSTATUS":"OPERATIONAL","PRIVATEUSE":0,"IAPEXISTS":1,"MIL_CODE":"ALL"`),
		pointFeature("-70.0", "42.0", `"GLOBAL_ID":"D","IDENT":"XXX","NAME":"Gone","TYPE_CODE":"AD","OPERSTATUS":"INDEFINITE","PRIVATEUSE":0,"IAPEXISTS":0,"MIL_CODE":"CIVIL"`),
	)
	runways := geojson(
		pointFeature("-87.9", "41.97", `"AIRPORT_ID":"A","DESIGNATOR":"10L/28R","LENGTH":13000,"WIDTH":150,"DIM_UOM":"FT","COMP_CODE":"CONC","LIGHTINTNS":"LIH"`),
	)
	art, meta, err := BuildAirports(airports, runways, AirportsOptions{
		Now: fixedNow, MinAirports: 1, MaxAirports: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	byIdent := map[string][]any{}
	for _, r := range art.Rows {
		cells := r.([]any)
		byIdent[cells[0].(string)] = cells
	}
	if _, ok := byIdent["KORD"]; !ok {
		t.Error("an ICAO-coded field should key on its ICAO code, as the baseline does")
	}
	if _, ok := byIdent["00A"]; !ok {
		t.Error("a field with no ICAO code should key on its FAA identifier")
	}
	// Column 11 military, 14 joint, 10 access, 1 type.
	if byIdent["KADW"][11] != true || byIdent["KADW"][14] != true {
		t.Error("MIL_CODE ALL is joint civil / military")
	}
	if byIdent["KORD"][11] != false {
		t.Error("a CIVIL field is not military")
	}
	if byIdent["00A"][10] != "restricted" {
		t.Error("a private-use field is access restricted")
	}
	// ...but still civilian and VFR-usable, so it keeps the civil symbol.
	if byIdent["00A"][12] != true {
		t.Error("a private-use field is still VFR")
	}
	if byIdent["XXX"][1] != "closed" {
		t.Error("OPERSTATUS INDEFINITE is closed")
	}
	if byIdent["XXX"][12] != false {
		t.Error("a closed field is not VFR")
	}
	// Frequencies are deliberately empty so mergeAixmOverlay keeps the
	// baseline's tower / ground / approach list.
	if got := byIdent["KORD"][15].([]any); len(got) != 0 {
		t.Errorf("frequencies = %v, want empty so the baseline survives", got)
	}
	if meta.MilitaryCount != 1 || meta.JointCount != 1 || meta.PrivateCount != 1 || meta.IcaoCount != 2 {
		t.Errorf("meta counts = mil %d joint %d private %d icao %d",
			meta.MilitaryCount, meta.JointCount, meta.PrivateCount, meta.IcaoCount)
	}
	if len(meta.UnknownStatus) != 0 {
		t.Errorf("UnknownStatus = %v, want none", meta.UnknownStatus)
	}
}
