package obstable

import (
	"math"
	"testing"
)

// A table missing a column this reader takes must fail loudly: the
// alternative is a dataset built from the wrong columns.
func TestHeaderRequiresEveryReadColumn(t *testing.T) {
	if _, err := Header([][]string{{"OBST ID", "TYPE", "COORD", "LAT", "LONG", "HGT AGL (FT)", "ELEV MSL (FT)"}}); err != nil {
		t.Errorf("complete header rejected: %v", err)
	}
	if _, err := Header([][]string{{"OBST ID", "TYPE", "COORD", "LAT", "LONG"}}); err == nil {
		t.Error("header with no height columns accepted")
	}
}

// A height column with no unit is refused rather than guessed at: feet
// read as metres put every obstacle three times too high.
func TestHeaderRequiresAUnit(t *testing.T) {
	if _, err := Header([][]string{{"OBST ID", "TYPE", "LAT", "LONG", "HGT AGL", "ELEV MSL (FT)"}}); err == nil {
		t.Error("height with no unit accepted")
	}
}

// The IAA's register heads its attributes over three rows: the attribute,
// its obligation, then the sub-heading naming the decimal columns and the
// unit. A heading is matched whole, so neither the sexagesimal position
// nor the accuracy column beside each attribute is taken for it.
func TestHeaderAcrossRows(t *testing.T) {
	rows := [][]string{
		{"Obstacle_identifier", "Horizontal_position", "", "", "", "Elevation", "Height", "Vertical accuracy", "Obstacle_type", "Lighting"},
		{"Mandatory", "Mandatory", "", "", "", "Mandatory", "Optional", "Mandatory", "Mandatory", "Mandatory"},
		{"", "LAT_DMS", "LONG_DMS", "LAT_DD", "LONG_DD", "(ft)", "(ft)", "(ft)", "", ""},
		{"EISN-0068", `53° 20' 58.51" N`, `006° 15' 36.18" W`, "53.349586", "-6.260050", "410.1", "397.3", "1", "Spire", "LI TYPE B RED"},
	}
	obs, st, err := Read(rows, Spec{})
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) != 1 || st.SkippedNoPosition != 0 {
		t.Fatalf("obstacles = %d, skipped %d; want 1, 0", len(obs), st.SkippedNoPosition)
	}
	o := obs[0]
	if o.ID != "EISN-0068" || o.Type != "Spire" || !o.Lighted {
		t.Errorf("got %+v", o)
	}
	if o.Lat != 53.34959 || o.Lon != -6.26005 {
		t.Errorf("position = %v, %v; want the decimal columns rounded", o.Lat, o.Lon)
	}
	if o.HeightM == nil || math.Abs(*o.HeightM-397.3*0.3048) > 1e-9 {
		t.Errorf("height = %v, want 397.3 ft in metres", o.HeightM)
	}
	if o.ElevM == nil || math.Abs(*o.ElevM-410.1*0.3048) > 1e-9 {
		t.Errorf("elevation = %v, want 410.1 ft in metres", o.ElevM)
	}
}

// A stated metre is taken as it stands.
func TestMetres(t *testing.T) {
	rows := [][]string{
		{"OBST ID", "TYPE", "LAT", "LONG", "HGT AGL (m)", "ELEV MSL (M)"},
		{"X1", "Mast", "50", "10", "120", "480"},
	}
	obs, _, err := Read(rows, Spec{})
	if err != nil {
		t.Fatal(err)
	}
	if *obs[0].HeightM != 120 || *obs[0].ElevM != 480 {
		t.Errorf("height/elev = %v/%v, want 120/480", *obs[0].HeightM, *obs[0].ElevM)
	}
}

// The registers write "NIL" and "Unknown" for a value they do not have;
// neither is a light, and a position written that way is no position.
func TestPlaceholders(t *testing.T) {
	rows := [][]string{
		{"OBST ID", "TYPE", "LAT", "LONG", "HGT AGL (FT)", "ELEV MSL (FT)", "LGT COLOR", "LGT TYPE", "LGT HR"},
		{"A", "Mast", "61", "25", "355", "983", "Unknown", "NIL", "NIL"},
		{"B", "Mast", "61", "25", "NIL", "Unknown", "Unknown", "NIL", "H24"},
		{"C", "Mast", "NIL", "25", "355", "983", "R", "F", "HN"},
		{"", "Mast", "61", "25", "355", "983", "R", "F", "HN"},
	}
	obs, st, err := Read(rows, Spec{})
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) != 2 || st.SkippedNoPosition != 1 {
		t.Fatalf("obstacles = %d, skipped %d; want 2, 1", len(obs), st.SkippedNoPosition)
	}
	if obs[0].Lighted {
		t.Error("Unknown NIL NIL read as lit")
	}
	if !obs[1].Lighted {
		t.Error("a light with hours and no colour read as unlit")
	}
	if obs[1].HeightM != nil || obs[1].ElevM != nil {
		t.Error("placeholder heights read as values")
	}
}

// The spec's kind map and clusters: a wind farm's turbines share the
// farm's identifier and are flagged as a group, a lone row is not.
func TestSpec(t *testing.T) {
	rows := [][]string{
		{"OBST ID", "TYPE", "LAT", "LONG", "HGT AGL (FT)", "ELEV MSL (FT)"},
		{"EISN-0008", "Wind Farm", "54.1", "-7.6", "332", "1365"},
		{"EISN-0008.001", "Wind Farm", "54.2", "-7.6", "332", "1137"},
		{"EISN-0068", "Spire", "53.3", "-6.2", "397", "410"},
	}
	spec := Spec{
		Kind: func(s string) string {
			if s == "Wind Farm" {
				return "WIND_TURBINE"
			}
			return s
		},
		Cluster: func(id string) string {
			for i := range id {
				if id[i] == '.' {
					return id[:i]
				}
			}
			return id
		},
	}
	obs, _, err := Read(rows, spec)
	if err != nil {
		t.Fatal(err)
	}
	for _, o := range obs {
		wantGroup := o.ID != "EISN-0068"
		if o.Group != wantGroup {
			t.Errorf("%s: group = %v, want %v", o.ID, o.Group, wantGroup)
		}
	}
	if obs[0].Type != "WIND_TURBINE" || obs[2].Type != "Spire" {
		t.Errorf("types = %q, %q", obs[0].Type, obs[2].Type)
	}
}

// A CSV row that gains or loses a column is an error, not a misread.
func TestCSVRaggedRow(t *testing.T) {
	if _, err := CSV([]byte("A;B\n1;2\n3\n"), ';'); err == nil {
		t.Error("ragged row accepted")
	}
	rows, err := CSV([]byte("\ufeffA;B\n1;2\n"), ';')
	if err != nil {
		t.Fatal(err)
	}
	if norm(rows[0][0]) != "A" {
		t.Errorf("byte-order mark kept: %q", norm(rows[0][0]))
	}
}

// ROMATSA prints the position packed and the unit row by row, and its
// aerodrome sets write a longitude's degrees in two digits.
func TestPackedPositionsAndRowUnits(t *testing.T) {
	rows := [][]string{
		{"Area of coverage", "Obstacle identifier", "Latitude", "Longitude", "Elevation", "Height", "Obstacle type", "Unit of measurement used", "Lighting"},
		{"1", "Basarabi", "441039N", "0282448E", "443", "344", "Antenna mast", "Feet", "NIL "},
		{"1", "LRBC_388", "463618.3979N", "265546.1821E", "344.22", "152.91", "ANTENNA", "METER", "YES"},
		{"1", "LRBC_1036", "463148.4783N", "265617.0581E", "374.7", "228.22", "STACK", "METER", "NO"},
		{"1", "Fagarasu Nou", "445246.1N", "0281419.44E", "976.759776", "410.1", "eolian power plant", "410.1", "Red lights "},
	}
	obs, st, err := Read(rows, Spec{})
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) != 3 || st.SkippedNoUnit != 1 || st.SkippedNoPosition != 0 {
		t.Fatalf("obstacles = %d, skipped for the unit %d, for the position %d; want 3, 1, 0",
			len(obs), st.SkippedNoUnit, st.SkippedNoPosition)
	}
	b := obs[0]
	if b.Lat != 44.1775 || b.Lon != 28.41333 || b.Lighted {
		t.Errorf("Basarabi = %v, %v lit %v; want 44.1775, 28.41333 unlit", b.Lat, b.Lon, b.Lighted)
	}
	if math.Abs(*b.HeightM-344*0.3048) > 1e-9 {
		t.Errorf("Basarabi height = %v, want 344 ft in metres", *b.HeightM)
	}
	a := obs[1]
	if a.Lat != 46.60511 || a.Lon != 26.9295 || !a.Lighted {
		t.Errorf("LRBC_388 = %v, %v lit %v; want 46.60511, 26.9295 lit", a.Lat, a.Lon, a.Lighted)
	}
	if *a.HeightM != 152.91 || *a.ElevM != 344.22 {
		t.Errorf("LRBC_388 height/elev = %v/%v, want the metres as printed", *a.HeightM, *a.ElevM)
	}
	if obs[2].Lighted {
		t.Error("a NO lighting cell read as lit")
	}
}

// A decimal outside the globe is no position.
func TestDecimalOutOfRange(t *testing.T) {
	rows := [][]string{
		{"OBST ID", "TYPE", "LAT", "LONG", "HGT AGL (FT)", "ELEV MSL (FT)"},
		{"A", "Mast", "441039", "28.4", "344", "443"},
	}
	_, st, err := Read(rows, Spec{})
	if err != nil {
		t.Fatal(err)
	}
	if st.SkippedNoPosition != 1 {
		t.Errorf("skipped %d, want the packed latitude without its hemisphere refused", st.SkippedNoPosition)
	}
}

// PANSA's eTOD register gives each height its own unit column and writes
// the position hemisphere first, spaced; ALBCONTROL's marks its degrees,
// minutes and seconds, heads its unit column "[vertical distance]" beside
// the geographical accuracy's, and writes "N" for no light.
func TestHemisphereFirstPositionsAndOwnUnits(t *testing.T) {
	pl := [][]string{
		{"DataBase", "Workspace", "", "", "", "", "", "", "", ""},
		{"Latitude", "Longitude", "Height", "Height Uom", "Elevation", "Elevation Uom", "Obstacle identifier", "Local language obstacle type", "Lighting", "Obstacle type"},
		{"N 49 18 29.60", "E 019 56 11.60", "339", "FT", "4006.93", "FT", "02302-2012-01", "Wieza", "YES", "Tower"},
		{"N 49 35 42.16", "E 020 40 40.01", "100", "M", "400.8", "M", "01627-2011-01", "Komin", "NO", "Chimney"},
	}
	obs, _, err := Read(pl, Spec{})
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) != 2 {
		t.Fatalf("%d obstacles, want 2", len(obs))
	}
	if obs[0].Lat != 49.30822 || obs[0].Lon != 19.93656 || !obs[0].Lighted || obs[0].Type != "Tower" {
		t.Errorf("PANSA row = %+v", obs[0])
	}
	if math.Abs(*obs[0].HeightM-339*0.3048) > 1e-9 || *obs[1].HeightM != 100 || obs[1].Lighted {
		t.Errorf("heights %v, %v; the second lit %v", *obs[0].HeightM, *obs[1].HeightM, obs[1].Lighted)
	}

	al := [][]string{
		{"Obstacle ID", "Type", "Latitude", "Longitude", "Unit of measurement [geographical accuracy]", "Elevation", "Height", "Unit of measurement [vertical distance]", "Lighted"},
		{"LAAA_A2024", "POLE", "N 40° 59' 31.3645''", "E 019° 59' 41.8940''", "FT", "199.375", "111.361", "M", "N"},
		{"LAAA_1874", "POLE", "N 41° 19' 42.8673\"", "W 019° 33' 19.6012\"", "FT", "153.54", "130.226", "M", "Y"},
	}
	obs, _, err = Read(al, Spec{})
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) != 2 || obs[0].Lat != 40.99205 || obs[0].Lon != 19.99497 || obs[0].Lighted {
		t.Fatalf("ALBCONTROL rows = %+v", obs)
	}
	if *obs[0].HeightM != 111.361 {
		t.Errorf("height %v m: the vertical distance's unit, not the accuracy's", *obs[0].HeightM)
	}
	if obs[1].Lon >= 0 || !obs[1].Lighted {
		t.Errorf("a W longitude reads %v, lit %v", obs[1].Lon, obs[1].Lighted)
	}
}
