package main

import (
	"encoding/json"
	"math"
	"reflect"
	"slices"
	"sort"
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
		pointFeature("-77.4", "38.9", `"IDENT_TXT":"AML","SUBTYPE_CODE":3,"DATASOURCE_TXT":"NASR","FREQUENCY_VAL":113.5,"CHANNEL_TXT":"082X","ELEV_VAL":340`),
		pointFeature("-87.7", "41.9", `"IDENT_TXT":"OBK","SUBTYPE_CODE":3,"DATASOURCE_TXT":"NASR","FREQUENCY_VAL":113.0`),
		pointFeature("-70.0", "42.0", `"IDENT_TXT":"BOS","SUBTYPE_CODE":1,"DATASOURCE_TXT":"NASR","FREQUENCY_VAL":388`),
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

// TestBuildNavaidsPointColumns covers a designated point the layer places by
// its LATITUDE / LONGITUDE columns alone, which it writes in degrees,
// minutes and seconds ("31-53-41.240N"): 231 rows of the 2026-09-03
// edition, 217 of them US reporting points (FULTY in Alabama among them),
// which the fallback read as decimals and dropped as unplaced.
func TestBuildNavaidsPointColumns(t *testing.T) {
	systems := geojson(pointFeature("-77.4", "38.9", `"IDENT":"AML","TYPE_CODE":8`))
	points := geojson(
		`{"type":"Feature","geometry":null,"properties":{"IDENT":"FULTY","TYPE_CODE":"RPT","LATITUDE":"31-53-41.240N","LONGITUDE":"086-15-32.060W"}}`,
		`{"type":"Feature","geometry":null,"properties":{"IDENT":"DECML","TYPE_CODE":"WPT","LATITUDE":"41.5","LONGITUDE":"-72.25"}}`,
		`{"type":"Feature","geometry":null,"properties":{"IDENT":"NOWHR","TYPE_CODE":"WPT","LATITUDE":"","LONGITUDE":"086-15-32.060W"}}`,
	)
	art, meta, err := BuildNavaids(systems, geojson(), points, NavaidsOptions{
		Now: fixedNow, MinNavaids: 1, MaxNavaids: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	if meta.SkippedNoGeo != 1 {
		t.Errorf("SkippedNoGeo = %d, want 1 (only the point with no latitude)", meta.SkippedNoGeo)
	}
	at := map[string][2]float64{}
	for _, r := range art.Rows {
		c := r.([]any)
		at[c[2].(string)] = [2]float64{c[4].(float64), c[5].(float64)}
	}
	if got, want := at["FULTY"], [2]float64{31.89479, -86.25891}; got != want {
		t.Errorf("FULTY at %v, want %v", got, want)
	}
	if got, want := at["DECML"], [2]float64{41.5, -72.25}; got != want {
		t.Errorf("DECML at %v, want %v", got, want)
	}
}

// TestBuildAirportsNasrOnly covers the rows the layer carries without an FAA
// identifier: 206 in the 2026-09-03 edition, Canadian and Mexican fields
// for chart context and copies of NASR fields under another register's
// code. They are not NASR records, the FAA has no authority on them, and
// they repeat: 16 unidentified Mexican strips all carry the ICAO code MM,
// and Tinian comes twice, as NASR's PGWT and as a copy keyed TNI. They are
// skipped and counted, which also leaves every ident unique.
func TestBuildAirportsNasrOnly(t *testing.T) {
	airports := geojson(
		pointFeature("145.61935", "14.99924", `"GLOBAL_ID":"A","IDENT":"TNI","ICAO_ID":"PGWT","NAME":"Francisco Manglona Borja/Tinian Intl","TYPE_CODE":"AD","OPERSTATUS":"OPERATIONAL","MIL_CODE":"CIVIL"`),
		pointFeature("145.61935", "14.99923", `"GLOBAL_ID":"B","IDENT":null,"ICAO_ID":"TNI","NAME":"Francisco Manglona Borja Tinian Intl","TYPE_CODE":"AD","OPERSTATUS":"OPERATIONAL","MIL_CODE":"CIVIL"`),
		pointFeature("-103.77", "28.04", `"GLOBAL_ID":"C","IDENT":null,"ICAO_ID":"MM","NAME":"Mina Hercules","TYPE_CODE":"AD","OPERSTATUS":"OPERATIONAL","MIL_CODE":"CIVIL"`),
		pointFeature("-101.24", "29.22", `"GLOBAL_ID":"D","IDENT":"","ICAO_ID":"MM","NAME":"Rancho La Margarita","TYPE_CODE":"AD","OPERSTATUS":"OPERATIONAL","MIL_CODE":"CIVIL"`),
	)
	// Each field has a runway; only the kept one's is written, and counted.
	runways := geojson(
		pointFeature("145.6", "15.0", `"AIRPORT_ID":"A","DESIGNATOR":"08/26","LENGTH":8600,"WIDTH":150,"DIM_UOM":"FT","COMP_CODE":"ASPH"`),
		pointFeature("145.6", "15.0", `"AIRPORT_ID":"B","DESIGNATOR":"08/26","LENGTH":8600,"WIDTH":150,"DIM_UOM":"FT","COMP_CODE":"ASPH"`),
		pointFeature("-103.8", "28.0", `"AIRPORT_ID":"C","DESIGNATOR":"01/19","LENGTH":3000,"WIDTH":60,"DIM_UOM":"FT","COMP_CODE":"DIRT"`),
	)
	art, meta, err := BuildAirports(airports, runways, AirportsOptions{
		Now: fixedNow, MinAirports: 1, MaxAirports: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	var idents []string
	for _, r := range art.Rows {
		idents = append(idents, r.([]any)[0].(string))
	}
	if len(idents) != 1 || idents[0] != "PGWT" {
		t.Errorf("idents = %v, want only the NASR row PGWT", idents)
	}
	if meta.SkippedNonNasr != 3 || meta.AhpCount != 1 {
		t.Errorf("SkippedNonNasr = %d, AhpCount = %d; want 3 and 1", meta.SkippedNonNasr, meta.AhpCount)
	}
	if meta.RunwayCount != 1 {
		t.Errorf("RunwayCount = %d, want 1: the runways written, not those of the fields left out", meta.RunwayCount)
	}
}

// TestBuildAirportsRepeatedIdents: an ident two rows carry no longer fails
// the build. The navaids, the airports and the obstacles are built in one run,
// so one repeat in the airport layer held all three back from the weekly
// commit. A field filed twice is kept once; of two different fields under
// one ident the richer is kept (more runways, then an open field over a
// closed one, then content), never a second row under an ident of the
// builder's own making ("00A#2"), which no baseline row, NOTAM or pilot
// knows.
func TestBuildAirportsRepeatedIdents(t *testing.T) {
	airports := geojson(
		pointFeature("-87.9", "41.97", `"GLOBAL_ID":"A","IDENT":"ORD","ICAO_ID":"KORD","NAME":"Chicago O'Hare Intl","TYPE_CODE":"AD","OPERSTATUS":"OPERATIONAL","MIL_CODE":"CIVIL"`),
		pointFeature("-87.9", "41.97", `"GLOBAL_ID":"B","IDENT":"ORD","ICAO_ID":"KORD","NAME":"Chicago O'Hare Intl","TYPE_CODE":"AD","OPERSTATUS":"OPERATIONAL","MIL_CODE":"CIVIL"`),
		pointFeature("-97.0", "35.0", `"GLOBAL_ID":"C","IDENT":"00A","NAME":"Total Rf","TYPE_CODE":"HP","OPERSTATUS":"OPERATIONAL","MIL_CODE":"CIVIL"`),
		pointFeature("-97.5", "35.5", `"GLOBAL_ID":"D","IDENT":"00A","NAME":"Other Rf","TYPE_CODE":"AD","OPERSTATUS":"OPERATIONAL","MIL_CODE":"CIVIL"`),
		pointFeature("-98.0", "36.0", `"GLOBAL_ID":"E","IDENT":"01A","NAME":"Shut Strip","TYPE_CODE":"AD","OPERSTATUS":"CLOSED","MIL_CODE":"CIVIL"`),
		pointFeature("-98.5", "36.5", `"GLOBAL_ID":"F","IDENT":"01A","NAME":"Open Strip","TYPE_CODE":"AD","OPERSTATUS":"OPERATIONAL","MIL_CODE":"CIVIL"`),
	)
	runways := geojson(
		pointFeature("-97.5", "35.5", `"AIRPORT_ID":"D","DESIGNATOR":"18/36","LENGTH":2500,"DIM_UOM":"FT"`),
	)
	for _, order := range []string{"as filed", "reversed"} {
		in := airports
		if order == "reversed" {
			var c geoCollection
			if err := json.Unmarshal(airports, &c); err != nil {
				t.Fatal(err)
			}
			slices.Reverse(c.Features)
			b, err := json.Marshal(c)
			if err != nil {
				t.Fatal(err)
			}
			in = b
		}
		art, meta, err := BuildAirports(in, runways, AirportsOptions{
			Now: fixedNow, MinAirports: 1, MaxAirports: 100,
		})
		if err != nil {
			t.Fatalf("%s: a repeated ident failed the build: %v", order, err)
		}
		names := map[string]string{}
		for _, r := range art.Rows {
			c := r.([]any)
			if _, dup := names[c[0].(string)]; dup {
				t.Errorf("%s: %s written twice", order, c[0])
			}
			names[c[0].(string)] = c[2].(string)
		}
		if want := map[string]string{"KORD": "Chicago O'Hare Intl", "00A": "Other Rf", "01A": "Open Strip"}; !reflect.DeepEqual(names, want) {
			t.Errorf("%s: rows = %v, want %v (the field with a runway, the open one)", order, names, want)
		}
		if meta.RepeatedRows != 1 || meta.ConflictingRows != 2 || meta.AhpCount != 3 {
			t.Errorf("%s: RepeatedRows = %d, ConflictingRows = %d, AhpCount = %d; want 1, 2 and 3",
				order, meta.RepeatedRows, meta.ConflictingRows, meta.AhpCount)
		}
	}
}

// TestBuildNavaidsRepeatWithoutGlobalID: two different stations under one
// ident, one of them without a GLOBAL_ID to carry in its id, no longer fail
// the run; each keeps its own id, the second by content under "<id>#2".
func TestBuildNavaidsRepeatWithoutGlobalID(t *testing.T) {
	systems := geojson(
		pointFeature("-84.0", "31.0", `"GLOBAL_ID":"G1","IDENT":"AA","NAME_TXT":"CEDAR","TYPE_CODE":3,"NAS_USE":1`),
		pointFeature("-97.0", "47.0", `"IDENT":"AA","NAME_TXT":"KENIE","TYPE_CODE":3,"NAS_USE":1`),
	)
	art, meta, err := BuildNavaids(systems, geojson(), geojson(), NavaidsOptions{
		Now: fixedNow, MinNavaids: 1, MaxNavaids: 100,
	})
	if err != nil {
		t.Fatalf("a repeat without a GLOBAL_ID failed the build: %v", err)
	}
	rows := navaidRows(t, art)
	if _, ok := rows["faa:NDB:AA"]; !ok {
		t.Errorf("no faa:NDB:AA among %v", rows)
	}
	if _, ok := rows["faa:NDB:AA#2"]; !ok {
		t.Errorf("no faa:NDB:AA#2 among %v", rows)
	}
	if meta.SeparatedRows != 1 {
		t.Errorf("SeparatedRows = %d, want 1", meta.SeparatedRows)
	}
}

// TestBuildNavaidsOwnFixReportingPoint: a foreign register files a station's
// own fix as a reporting point (RPT, ORI) referencing the station (REFFAC):
// the navaid's row draws it, and it was drawn again as a triangle over it
// (47 in the 2026-09-03 edition, Durango and Chihuahua among them). The
// reference decides, whatever ident the point carries ("(UK)" on UK) and
// whichever record of the station it names: YOC's references the Canadian
// record the copy rule sets aside. A reporting point referencing nothing
// is its own, and so is one referencing a station from further off, or
// another station than the one it sits on.
func TestBuildNavaidsOwnFixReportingPoint(t *testing.T) {
	systems := geojson(
		pointFeature("-104.51642", "24.13801", `"GLOBAL_ID":"D1","IDENT":"DGO","NAME_TXT":"DURANGO","TYPE_CODE":6,"COUNTRY":"Mexico"`),
		pointFeature("-106.0", "28.7", `"GLOBAL_ID":"C1","IDENT":"CUU","NAME_TXT":"CHIHUAHUA","TYPE_CODE":6,"COUNTRY":"Mexico"`),
		pointFeature("-80.0", "40.0", `"GLOBAL_ID":"U1","IDENT":"UK","NAME_TXT":"UKIAH","TYPE_CODE":3,"NAS_USE":1`),
		pointFeature("-139.84", "67.57", `"GLOBAL_ID":"Y1","IDENT":"YOC","NAME_TXT":"OLD CROW","TYPE_CODE":3,"NAS_USE":0`),
		pointFeature("-139.84", "67.57", `"GLOBAL_ID":"Y2","IDENT":"YOC","NAME_TXT":"OLD CROW","TYPE_CODE":3`),
	)
	points := geojson(
		pointFeature("-104.51642", "24.13801", `"GLOBAL_ID":"P1","IDENT":"DGO","TYPE_CODE":"RPT","COUNTRY":"Mexico","REFFAC":"D1"`),
		pointFeature("-106.0", "28.7", `"GLOBAL_ID":"P2","IDENT":"CUU","TYPE_CODE":"RPT","COUNTRY":"Mexico"`),
		pointFeature("-80.0", "40.0", `"GLOBAL_ID":"P3","IDENT":"(UK)","TYPE_CODE":"RPT","REFFAC":"U1"`),
		pointFeature("-139.84", "67.57", `"GLOBAL_ID":"P4","IDENT":"YOC","TYPE_CODE":"RPT","COUNTRY":"Canada","REFFAC":"Y2"`),
		// A reporting point defined off Durango, 20 NM away.
		pointFeature("-104.51642", "24.47", `"GLOBAL_ID":"P5","IDENT":"DGONR","TYPE_CODE":"RPT","COUNTRY":"Mexico","REFFAC":"D1"`),
		// A reporting point on Chihuahua's site referencing Durango.
		pointFeature("-106.0", "28.7", `"GLOBAL_ID":"P6","IDENT":"CUUAB","TYPE_CODE":"RPT","COUNTRY":"Mexico","REFFAC":"D1"`),
	)
	art, meta, err := BuildNavaids(systems, geojson(), points, NavaidsOptions{
		Now: fixedNow, MinNavaids: 1, MaxNavaids: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	rows := navaidRows(t, art)
	for _, gone := range []string{"faa:VFR_REPORTING_POINT:DGO", "faa:VFR_REPORTING_POINT:(UK)", "faa:VFR_REPORTING_POINT:YOC"} {
		if _, ok := rows[gone]; ok {
			t.Errorf("%s, a station's own fix, is drawn over the station", gone)
		}
	}
	for _, kept := range []string{"faa:VFR_REPORTING_POINT:CUU", "faa:VFR_REPORTING_POINT:DGONR", "faa:VFR_REPORTING_POINT:CUUAB"} {
		if _, ok := rows[kept]; !ok {
			t.Errorf("%s was dropped, not the fix of the station it sits on", kept)
		}
	}
	if meta.SkippedNavaidFixes != 3 {
		t.Errorf("SkippedNavaidFixes = %d, want 3", meta.SkippedNavaidFixes)
	}
}

// TestBuildNavaidsCopyIsSameFamily: the copy rule drops another register's
// record of a station the FAA files at one spot under one ident, and a copy
// shares a piece of the station's equipment (sameNavaidFamily). An NDB
// sharing its ident and site with a VOR is another station, not the VOR's
// copy, whatever evidence each record carries, and so is a DME beside a
// plain VOR, which has no distance half; a DME filed for a VOR/DME's or an
// NDB/DME's distance half is the copy.
func TestBuildNavaidsCopyIsSameFamily(t *testing.T) {
	systems := geojson(
		pointFeature("-80.0", "40.0", `"GLOBAL_ID":"V1","IDENT":"XYZ","NAME_TXT":"EXAMPLE","TYPE_CODE":6,"NAS_USE":1`),
		pointFeature("-80.0", "40.0", `"GLOBAL_ID":"N1","IDENT":"XYZ","NAME_TXT":"EXAMPLE","TYPE_CODE":3`),
		pointFeature("-80.0", "40.0", `"GLOBAL_ID":"M1","IDENT":"XYZ","NAME_TXT":"EXAMPLE","TYPE_CODE":5`),
		pointFeature("-81.0", "41.0", `"GLOBAL_ID":"V2","IDENT":"PLN","NAME_TXT":"PLAIN","TYPE_CODE":7,"NAS_USE":1`),
		pointFeature("-81.0", "41.0", `"GLOBAL_ID":"M2","IDENT":"PLN","NAME_TXT":"PLAIN","TYPE_CODE":5`),
		pointFeature("-82.0", "42.0", `"GLOBAL_ID":"B1","IDENT":"NBD","NAME_TXT":"NDB DME","TYPE_CODE":4,"NAS_USE":1`),
		pointFeature("-82.0", "42.0", `"GLOBAL_ID":"M3","IDENT":"NBD","NAME_TXT":"NDB DME","TYPE_CODE":5`),
	)
	art, meta, err := BuildNavaids(systems, geojson(), geojson(), NavaidsOptions{
		Now: fixedNow, MinNavaids: 1, MaxNavaids: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	rows := navaidRows(t, art)
	for _, id := range []string{"faa:VOR-DME:XYZ", "faa:NDB:XYZ", "faa:VOR:PLN", "faa:DME:PLN", "faa:NDB:NBD"} {
		if _, ok := rows[id]; !ok {
			t.Errorf("no %s: another station was taken for a copy", id)
		}
	}
	for _, id := range []string{"faa:DME:XYZ", "faa:DME:NBD"} {
		if _, ok := rows[id]; ok {
			t.Errorf("%s drawn, a copy of the station's distance half", id)
		}
	}
	if meta.SkippedForeignCopies != 2 {
		t.Errorf("SkippedForeignCopies = %d, want 2", meta.SkippedForeignCopies)
	}
}

// navaidRows indexes a navaid artefact's rows by id.
func navaidRows(t *testing.T, art overlayArtifact) map[string][]any {
	t.Helper()
	out := map[string][]any{}
	for _, r := range art.Rows {
		c := r.([]any)
		id := c[0].(string)
		if _, dup := out[id]; dup {
			t.Errorf("id %s carried by two rows", id)
		}
		out[id] = c
	}
	return out
}

// TestBuildNavaidsOwnComponents covers the frequency join. A radio navaid's
// frequency, channel and elevation live on its components, which the FAA
// files per piece of equipment and keys by ident alone, and idents repeat:
// NDB AA is CEDAR in Georgia and KENIE in North Dakota, and the ADDE half
// of the layer files foreign stations under US idents. Joined on the ident
// alone, KENIE printed CEDAR's 341 kHz and elevation, and TACANs and DMEs
// printed an NDB's kHz as MHz. A navaid now reads only its own components:
// the same ident, a kind it is made of, within 25 NM, NASR before ADDE, the
// nearest first, and a frequency only in its band. Two stations under one
// ident carry their GLOBAL_ID in their id, whatever order the layer lists
// them in.
func TestBuildNavaidsOwnComponents(t *testing.T) {
	cedar := pointFeature("-82.6144", "33.5333", `"GLOBAL_ID":"0C3EF273","IDENT":"AA","NAME_TXT":"CEDAR","TYPE_CODE":3,"NAS_USE":1,"STATE":"GA"`)
	kenie := pointFeature("-96.8152", "47.0091", `"GLOBAL_ID":"61963E1E","IDENT":"AA","NAME_TXT":"KENIE","TYPE_CODE":3,"NAS_USE":1,"STATE":"ND"`)
	others := []string{
		pointFeature("-73.1568", "44.4769", `"GLOBAL_ID":"B1","IDENT":"BJA","NAME_TXT":"BURLINGTON","TYPE_CODE":9,"NAS_USE":1`),
		pointFeature("-76.4106", "38.2811", `"GLOBAL_ID":"N1","IDENT":"NHK","NAME_TXT":"NAS PATUXENT RIVER","TYPE_CODE":9,"NAS_USE":1`),
		pointFeature("-87.3", "30.4", `"GLOBAL_ID":"D1","IDENT":"DWG","NAME_TXT":"WARRINGTON","TYPE_CODE":9,"NAS_USE":1`),
		pointFeature("-92.1521", "34.8101", `"GLOBAL_ID":"L1","IDENT":"LIT","NAME_TXT":"LITTLE ROCK","TYPE_CODE":8,"NAS_USE":1`),
		pointFeature("-100.0", "40.0", `"GLOBAL_ID":"S1","IDENT":"SRC","NAME_TXT":"SOURCES","TYPE_CODE":7,"NAS_USE":1`),
		pointFeature("-81.1235", "37.7803", `"GLOBAL_ID":"K1","IDENT":"BKW","NAME_TXT":"BECKLEY","TYPE_CODE":5,"NAS_USE":1`),
		pointFeature("-128.5878", "54.4608", `"GLOBAL_ID":"X1","IDENT":"IXT","NAME_TXT":"TERRACE","TYPE_CODE":5`),
	}
	components := geojson(
		pointFeature("-82.6144", "33.5333", `"GFID":"c1","IDENT_TXT":"AA","SUBTYPE_CODE":1,"DATASOURCE_TXT":"NASR","FREQUENCY_VAL":341,"ELEV_VAL":515`),
		pointFeature("-96.8152", "47.0091", `"GFID":"c2","IDENT_TXT":"AA","SUBTYPE_CODE":1,"DATASOURCE_TXT":"NASR","FREQUENCY_VAL":365,"ELEV_VAL":887.8`),
		pointFeature("5.0", "52.0", `"GFID":"c3","IDENT_TXT":"AA","SUBTYPE_CODE":1,"DATASOURCE_TXT":"ADDE","FREQUENCY_VAL":355`),
		// BJA's own TACAN component has its channel and no frequency; the
		// ADDE NDB under its ident is 2 900 NM away.
		pointFeature("-73.1568", "44.4769", `"GFID":"c4","IDENT_TXT":"BJA","SUBTYPE_CODE":4,"DATASOURCE_TXT":"NASR","CHANNEL_TXT":"71X","ELEV_VAL":308.5`),
		pointFeature("-8.0", "38.0", `"GFID":"c5","IDENT_TXT":"BJA","SUBTYPE_CODE":1,"DATASOURCE_TXT":"ADDE","FREQUENCY_VAL":376`),
		// NHK's only component is the co-located NDB: its 400 kHz is no
		// TACAN frequency.
		pointFeature("-76.4106", "38.2881", `"GFID":"c6","IDENT_TXT":"NHK","SUBTYPE_CODE":1,"DATASOURCE_TXT":"NASR","FREQUENCY_VAL":400,"ELEV_VAL":19`),
		// DWG pairs its channel 002X with 134.5 MHz, above the VOR band.
		pointFeature("-87.3", "30.4", `"GFID":"c7","IDENT_TXT":"DWG","SUBTYPE_CODE":4,"DATASOURCE_TXT":"NASR","FREQUENCY_VAL":134.5,"CHANNEL_TXT":"002X"`),
		// LIT's components sit 8 NM from the system's position: still its own.
		pointFeature("-92.1805", "34.6777", `"GFID":"c8","IDENT_TXT":"LIT","SUBTYPE_CODE":3,"DATASOURCE_TXT":"NASR","FREQUENCY_VAL":113.9,"ELEV_VAL":240`),
		pointFeature("-92.1805", "34.6777", `"GFID":"c9","IDENT_TXT":"LIT","SUBTYPE_CODE":4,"DATASOURCE_TXT":"NASR","FREQUENCY_VAL":113.9,"CHANNEL_TXT":"086X","ELEV_VAL":240`),
		// NASR's record wins over a nearer ADDE one; a fan marker sharing
		// the ident is no part of the VOR.
		pointFeature("-100.001", "40.0", `"GFID":"c10","IDENT_TXT":"SRC","SUBTYPE_CODE":3,"DATASOURCE_TXT":"ADDE","FREQUENCY_VAL":113.0,"ELEV_VAL":100`),
		pointFeature("-100.01", "40.0", `"GFID":"c11","IDENT_TXT":"SRC","SUBTYPE_CODE":3,"DATASOURCE_TXT":"NASR","FREQUENCY_VAL":113.2,"ELEV_VAL":2000`),
		pointFeature("-100.0", "40.0", `"GFID":"c12","IDENT_TXT":"SRC","SUBTYPE_CODE":0,"DATASOURCE_TXT":"NASR","ELEV_VAL":5`),
		// BKW is a VORTAC reduced to a DME: NASR keeps its VOR and TACAN
		// records, and the TACAN is what serves the distance.
		pointFeature("-81.1235", "37.7803", `"GFID":"c13","IDENT_TXT":"BKW","SUBTYPE_CODE":3,"DATASOURCE_TXT":"NASR","FREQUENCY_VAL":117.7,"ELEV_VAL":2517`),
		pointFeature("-81.1235", "37.7803", `"GFID":"c14","IDENT_TXT":"BKW","SUBTYPE_CODE":4,"DATASOURCE_TXT":"NASR","FREQUENCY_VAL":117.7,"CHANNEL_TXT":"124X","ELEV_VAL":2517`),
		// IXT is an ILS's DME, paired with its localizer.
		pointFeature("-128.5878", "54.4608", `"GFID":"c15","IDENT_TXT":"IXT","SUBTYPE_CODE":2,"DATASOURCE_TXT":"ADDE","CHANNEL_TXT":"038","ELEV_VAL":713`),
		pointFeature("-128.555", "54.47", `"GFID":"c16","IDENT_TXT":"IXT","SUBTYPE_CODE":7,"DATASOURCE_TXT":"ADDE","FREQUENCY_VAL":110.1,"ELEV_VAL":703`),
	)
	for _, order := range [][]string{{cedar, kenie}, {kenie, cedar}} {
		systems := geojson(append(append([]string{}, order...), others...)...)
		art, meta, err := BuildNavaids(systems, components, geojson(), NavaidsOptions{
			Now: fixedNow, MinNavaids: 1, MaxNavaids: 100,
		})
		if err != nil {
			t.Fatal(err)
		}
		rows := navaidRows(t, art)
		for id, want := range map[string][3]any{
			"faa:NDB:AA:61963E1E": {"365", "", 888},
			"faa:NDB:AA:0C3EF273": {"341", "", 515},
			"faa:TACAN:BJA":       {"", "71X", 309},
			"faa:TACAN:NHK":       {"", "", nil},
			"faa:TACAN:DWG":       {"134.500", "002X", nil},
			"faa:VORTAC:LIT":      {"113.900", "086X", 240},
			"faa:VOR:SRC":         {"113.200", "", 2000},
			"faa:DME:BKW":         {"117.700", "124X", 2517},
			"faa:DME:IXT":         {"110.100", "038", 713},
		} {
			r, ok := rows[id]
			if !ok {
				t.Errorf("no row %s", id)
				continue
			}
			if got := [3]any{r[6], r[7], r[8]}; got != want {
				t.Errorf("%s freq, channel, elev = %v, want %v", id, got, want)
			}
		}
		if meta.SuffixedIds != 2 || meta.NoFrequency != 2 {
			t.Errorf("SuffixedIds = %d, NoFrequency = %d; want 2 (the AA pair) and 2 (BJA, NHK)", meta.SuffixedIds, meta.NoFrequency)
		}
	}
}

// TestBuildNavaidsCopies covers the records a second register files for
// one navaid or point. A radio navaid with no NAS_USE beside the FAA's own
// under its ident (YVR's Canadian copy) goes; a designated point of kind
// OTHER that is a radio navaid's own fix (the same ident within 1 NM) goes,
// the navaid drawing it already (1 326 of them); and a point with no STATE
// beside one with a STATE under its ident goes, whatever kind either is
// (KUTAL is a Russian RPT on the FAA's own WPT). A foreign navaid or point
// standing alone stays.
func TestBuildNavaidsCopies(t *testing.T) {
	systems := geojson(
		pointFeature("-123.149", "49.077", `"GLOBAL_ID":"V1","IDENT":"YVR","NAME_TXT":"VANCOUVER","TYPE_CODE":6,"NAS_USE":1,"COUNTRY":"UNITED STATES"`),
		pointFeature("-123.149", "49.077", `"GLOBAL_ID":"V2","IDENT":"YVR","NAME_TXT":"VANCOUVER","TYPE_CODE":6,"NAS_USE":null,"COUNTRY":"Canada"`),
		pointFeature("-139.845", "67.571", `"GLOBAL_ID":"Y1","IDENT":"YOC","NAME_TXT":"OLD CROW","TYPE_CODE":3,"COUNTRY":"Canada"`),
		pointFeature("-92.1521", "34.8101", `"GLOBAL_ID":"L1","IDENT":"LIT","NAME_TXT":"LITTLE ROCK","TYPE_CODE":8,"NAS_USE":1`),
	)
	points := geojson(
		pointFeature("-92.1521", "34.8101", `"GLOBAL_ID":"P1","IDENT":"LIT","TYPE_CODE":"OTHER","STATE":"ARKANSAS"`),
		pointFeature("-95.0", "35.0", `"GLOBAL_ID":"P2","IDENT":"LONER","TYPE_CODE":"OTHER","STATE":"OKLAHOMA"`),
		pointFeature("170.0", "60.0", `"GLOBAL_ID":"P3","IDENT":"KUTAL","TYPE_CODE":"WPT","STATE":"RUSSIAN FEDERATION"`),
		pointFeature("170.0", "60.0", `"GLOBAL_ID":"P4","IDENT":"KUTAL","TYPE_CODE":"RPT","COUNTRY":"Russia"`),
		pointFeature("150.0", "55.0", `"GLOBAL_ID":"P5","IDENT":"ALONE","TYPE_CODE":"RPT","COUNTRY":"Russia"`),
	)
	art, meta, err := BuildNavaids(systems, geojson(), points, NavaidsOptions{
		Now: fixedNow, MinNavaids: 1, MaxNavaids: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	rows := navaidRows(t, art)
	var ids []string
	for id := range rows {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	want := []string{
		"faa:NDB:YOC",
		"faa:VFR_REPORTING_POINT:ALONE",
		"faa:VOR-DME:YVR",
		"faa:VORTAC:LIT",
		"faa:WAYPOINT:KUTAL",
		"faa:WAYPOINT:LONER",
	}
	if !reflect.DeepEqual(ids, want) {
		t.Errorf("ids = %v, want %v", ids, want)
	}
	if meta.SkippedNavaidFixes != 1 || meta.SkippedForeignCopies != 2 {
		t.Errorf("SkippedNavaidFixes = %d, SkippedForeignCopies = %d; want 1 and 2",
			meta.SkippedNavaidFixes, meta.SkippedForeignCopies)
	}
	if meta.RadioCount != 3 || meta.PointCount != 3 {
		t.Errorf("radio = %d, points = %d; want 3 and 3", meta.RadioCount, meta.PointCount)
	}
}

// TestBuildNavaidsPairsItsChannel: a TACAN or DME channel fixes the VHF
// frequency paired with it (ICAO Annex 10 Volume I), and the navaid layer
// states the channel afresh where the component register can lag. DGO's
// layer says 076 (112.9) while a NASR component 0.97 NM off still said
// 112.2 / 059X, and NASR winning, the file printed the stale pair: a
// component's frequency is its own only where it pairs with the layer's
// channel, and failing any, the channel's pair stands. The layer writes
// the channel bare, so the channel shown is a component's naming it, with
// the mode the layer leaves out, and a bare number pairs with its Y
// frequency too. An NDB/DME's channel is its DME's, which says nothing of
// the NDB's carrier.
func TestBuildNavaidsPairsItsChannel(t *testing.T) {
	systems := geojson(
		pointFeature("-104.53", "24.12", `"GLOBAL_ID":"G1","IDENT":"DGO","NAME_TXT":"DURANGO","TYPE_CODE":6,"CHANNEL":"076","COUNTRY":"Mexico"`),
		pointFeature("-113.30", "31.35", `"GLOBAL_ID":"G2","IDENT":"PPE","NAME_TXT":"PUERTO PENASCO","TYPE_CODE":6,"CHANNEL":"096","COUNTRY":"Mexico"`),
		pointFeature("-79.79", "44.58", `"GLOBAL_ID":"G3","IDENT":"YEE","NAME_TXT":"MIDLAND","TYPE_CODE":5,"CHANNEL":"075","COUNTRY":"Canada"`),
		pointFeature("-80.00", "40.00", `"GLOBAL_ID":"G4","IDENT":"YYY","NAME_TXT":"YANKEE","TYPE_CODE":9,"CHANNEL":"021","COUNTRY":"Canada"`),
		pointFeature("162.957", "5.353", `"GLOBAL_ID":"G5","IDENT":"UKS","NAME_TXT":"KOSRAE","TYPE_CODE":4,"CHANNEL":"100","COUNTRY":"Federated States of Micronesia"`),
	)
	components := geojson(
		pointFeature("-104.54", "24.135", `"GFID":"d1","IDENT_TXT":"DGO","SUBTYPE_CODE":3,"DATASOURCE_TXT":"NASR","FREQUENCY_VAL":112.2,"CHANNEL_TXT":"059X"`),
		pointFeature("-104.53", "24.12", `"GFID":"d2","IDENT_TXT":"DGO","SUBTYPE_CODE":3,"DATASOURCE_TXT":"ADDE","FREQUENCY_VAL":112.9,"CHANNEL_TXT":"076X"`),
		pointFeature("-113.50", "31.30", `"GFID":"p1","IDENT_TXT":"PPE","SUBTYPE_CODE":3,"DATASOURCE_TXT":"NASR","FREQUENCY_VAL":112.1,"CHANNEL_TXT":"058X"`),
		pointFeature("-79.79", "44.58", `"GFID":"e1","IDENT_TXT":"YEE","SUBTYPE_CODE":2,"DATASOURCE_TXT":"ADDE","FREQUENCY_VAL":112.8,"CHANNEL_TXT":"075X"`),
		pointFeature("-80.00", "40.00", `"GFID":"y1","IDENT_TXT":"YYY","SUBTYPE_CODE":4,"DATASOURCE_TXT":"ADDE","FREQUENCY_VAL":108.45,"CHANNEL_TXT":"021Y"`),
		pointFeature("162.957", "5.353", `"GFID":"k1","IDENT_TXT":"UKS","SUBTYPE_CODE":1,"DATASOURCE_TXT":"ADDE","FREQUENCY_VAL":393`),
	)
	art, meta, err := BuildNavaids(systems, components, geojson(), NavaidsOptions{
		Now: fixedNow, MinNavaids: 1, MaxNavaids: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	rows := navaidRows(t, art)
	for id, want := range map[string][2]any{
		// The ADDE component pairs with the layer's 076 and the NASR one
		// is stale: its frequency and its spelling of the channel.
		"faa:VOR-DME:DGO": {"112.900", "076X"},
		// No component pairs: the channel's own pair, as the layer
		// writes the channel.
		"faa:VOR-DME:PPE": {"114.900", "096"},
		"faa:DME:YEE":     {"112.800", "075X"},
		// A bare 021 is 21X or 21Y; the station works Y.
		"faa:TACAN:YYY": {"108.450", "021Y"},
		// The DME's channel stands beside the NDB's carrier.
		"faa:NDB:UKS": {"393", "100"},
	} {
		r, ok := rows[id]
		if !ok {
			t.Errorf("no row %s", id)
			continue
		}
		if got := [2]any{r[6], r[7]}; got != want {
			t.Errorf("%s freq, channel = %v, want %v", id, got, want)
		}
	}
	if meta.ChannelMismatches != 2 {
		t.Errorf("ChannelMismatches = %d, want 2 (DGO's and PPE's stale NASR records)", meta.ChannelMismatches)
	}
}

func TestPairedVHF(t *testing.T) {
	for ch, want := range map[string]float64{
		"076X": 112.90, "096X": 114.90, "059X": 112.20, "017X": 108.00, "027X": 109.00, "053X": 111.60,
		"084X": 113.70, "125X": 117.80, "111Y": 116.45, "18Y": 108.15, "002X": 134.50, "060X": 133.30,
		"33X": 109.60, "083": 113.60, "": 0, "abc": 0, "127X": 0, "000X": 0,
	} {
		if got := pairedVHFMHz(ch); math.Abs(got-want) > 1e-9 {
			t.Errorf("pairedVHFMHz(%q) = %v, want %v", ch, got, want)
		}
	}
	for _, c := range []struct {
		channel string
		mhz     float64
		want    bool
	}{
		{"076", 112.90, true}, {"076", 112.95, true}, {"076X", 112.95, false}, {"076Y", 112.95, true},
		{"076", 112.20, false}, {"", 112.90, false}, {"127", 117.90, false},
	} {
		if got := channelPairs(c.channel, c.mhz); got != c.want {
			t.Errorf("channelPairs(%q, %v) = %v, want %v", c.channel, c.mhz, got, c.want)
		}
	}
	for _, c := range []struct {
		a, b string
		want bool
	}{
		{"076", "076X", true}, {"76", "076Y", true}, {"076X", "076X", true}, {"076X", "076Y", false},
		{"076", "059X", false}, {"", "076X", false},
	} {
		if got := sameChannel(c.a, c.b); got != c.want {
			t.Errorf("sameChannel(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}

// TestBuildNavaidsSplitAfterRepeats: the meta's radio / point split counts
// the rows written. The loop dropping repeats compared each row against a
// radio count it was decrementing, so two radios filed twice beside two
// points read 3 / 1.
func TestBuildNavaidsSplitAfterRepeats(t *testing.T) {
	a := pointFeature("-100.0", "40.0", `"GLOBAL_ID":"A1","IDENT":"AAA","NAME_TXT":"ALPHA","TYPE_CODE":7,"NAS_USE":1`)
	b := pointFeature("-101.0", "41.0", `"GLOBAL_ID":"B1","IDENT":"BBB","NAME_TXT":"BRAVO","TYPE_CODE":7,"NAS_USE":1`)
	systems := geojson(a, b, a, b)
	points := geojson(
		pointFeature("-95.0", "35.0", `"GLOBAL_ID":"P1","IDENT":"PONE","TYPE_CODE":"WPT","STATE":"OKLAHOMA"`),
		pointFeature("-96.0", "36.0", `"GLOBAL_ID":"P2","IDENT":"PTWO","TYPE_CODE":"WPT","STATE":"OKLAHOMA"`),
	)
	_, meta, err := BuildNavaids(systems, geojson(), points, NavaidsOptions{Now: fixedNow, MinNavaids: 1, MaxNavaids: 100})
	if err != nil {
		t.Fatal(err)
	}
	if meta.RadioCount != 2 || meta.PointCount != 2 || meta.RepeatedRows != 2 {
		t.Errorf("radio = %d, points = %d, repeated = %d; want 2, 2 and 2", meta.RadioCount, meta.PointCount, meta.RepeatedRows)
	}
}

// TestBuildNavaidsNasUseZero: the FAA files NAS_USE on every station it
// carries, 0 where it does not use one, and the copy another register files
// beside it carries none. YOC's own record states 0 and its copy nothing, so
// the field's presence is what keeps the right one: read as no NAS use, the
// 0 left neither record the stronger and Old Crow drew twice. Its value
// ranks two of the FAA's own, the one it uses kept.
func TestBuildNavaidsNasUseZero(t *testing.T) {
	for _, c := range []struct {
		name     string
		records  []string
		wantName string
	}{
		{"the FAA's own stating 0, beside a copy stating nothing", []string{
			`"GLOBAL_ID":"Y0","IDENT":"YOC","NAME_TXT":"OLD CROW","TYPE_CODE":3,"NAS_USE":0,"COUNTRY":"CA"`,
			`"GLOBAL_ID":"Y1","IDENT":"YOC","NAME_TXT":"OLD CROW NDB","TYPE_CODE":3,"COUNTRY":"Canada"`,
		}, "OLD CROW"},
		{"one in NAS use beside one not", []string{
			`"GLOBAL_ID":"Y0","IDENT":"YOC","NAME_TXT":"OLD CROW","TYPE_CODE":3,"NAS_USE":0`,
			`"GLOBAL_ID":"Y1","IDENT":"YOC","NAME_TXT":"OLD CROW NDB","TYPE_CODE":3,"NAS_USE":1`,
		}, "OLD CROW NDB"},
	} {
		t.Run(c.name, func(t *testing.T) {
			var feats []string
			for _, r := range c.records {
				feats = append(feats, pointFeature("-139.845", "67.571", r))
			}
			art, meta, err := BuildNavaids(geojson(feats...), geojson(), geojson(), NavaidsOptions{Now: fixedNow, MinNavaids: 1, MaxNavaids: 100})
			if err != nil {
				t.Fatal(err)
			}
			rows := navaidRows(t, art)
			if r, ok := rows["faa:NDB:YOC"]; !ok || len(rows) != 1 || r[3] != c.wantName || meta.SkippedForeignCopies != 1 {
				t.Errorf("rows = %v, copies = %d; want %q alone and one copy", rows, meta.SkippedForeignCopies, c.wantName)
			}
		})
	}
}
