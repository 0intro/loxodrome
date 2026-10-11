package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/aixm5"
)

const roFixture = "testdata/Obstacle_Data_LRBB_Area_1_16_APR_2026.csv"

// The fixture keeps the data set's own bytes (ISO 8859-2, CRLF) for a row
// of every type it writes, the aerodrome sets' metre rows with their
// two-digit longitudes, and the row whose unit cell holds its height; its
// .crc32q states the fixture's own sums.
func TestBuildRoObstacles(t *testing.T) {
	out := t.TempDir()
	now := func() time.Time { return time.Date(2026, time.September, 24, 12, 0, 0, 0, time.UTC) }
	if err := buildRoObstacles(out, "current", roFixture, "", aip.SanityWindows{MinObstacles: 1, MaxObstacles: 100}, now); err != nil {
		t.Fatal(err)
	}
	var art struct {
		Fields []string `json:"fields"`
		Rows   [][]any  `json:"rows"`
	}
	b, err := os.ReadFile(filepath.Join(out, "ro-obstacles.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, &art); err != nil {
		t.Fatal(err)
	}
	var meta struct {
		Effective     string            `json:"effective"`
		UnknownTypes  []string          `json:"unknownTypes"`
		Integrity     map[string]string `json:"integrity"`
		SkippedNoUnit int               `json:"skippedNoUnit"`
	}
	b, err = os.ReadFile(filepath.Join(out, "ro-obstacles.meta.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, &meta); err != nil {
		t.Fatal(err)
	}
	if meta.Effective != "2026-04-16T00:00:00.000Z" || len(meta.UnknownTypes) != 0 || meta.SkippedNoUnit != 1 {
		t.Errorf("meta = %+v", meta)
	}
	if meta.Integrity["crc32q"] != "1FC938CF" {
		t.Errorf("integrity = %v", meta.Integrity)
	}
	if len(art.Rows) != 27 {
		t.Fatalf("rows = %d, want 27 (28 less the one with no unit)", len(art.Rows))
	}
	rows := map[string][]any{}
	for _, r := range art.Rows {
		rows[r[0].(string)] = r
	}
	// fields: id, type, name, lat, lon, elev, hgt, lit, group
	for _, c := range []struct {
		id   string
		want []any
		why  string
	}{
		{"ro:BASARABI-441039N0282448E", []any{"mast", "Basarabi", 44.1775, 28.41333, 443.0, 344.0, false, false}, "a place, in feet"},
		{"ro:BARLAD-461429N0275104E", []any{"mast", "Bârlad", 46.24139, 27.85111, 1575.0, 655.0, true, false}, "decoded from ISO 8859-2"},
		{"ro:LRBC_388", []any{"antenna", "", 46.60511, 26.9295, 1129.0, 502.0, true, false}, "a code, in metres, its longitude's degrees in two digits"},
		{"ro:LRBC_1036", []any{"chimney", "", 46.53013, 26.93807, 1229.0, 749.0, false, false}, "lighting NO"},
		{"ro:ARAD-461015N0212601E", []any{"chimney", "Arad", 46.17083, 21.43361, 732.0, 377.0, false, true}, "2 chimneys"},
		{"ro:23-AUGUST-435233N0283321E", []any{"windturbine", "23 August", 43.8758, 28.55572, 647.0, 492.0, true, false}, "a place with a number in its name"},
	} {
		r, ok := rows[c.id]
		if !ok {
			t.Errorf("%s (%s) missing", c.id, c.why)
			continue
		}
		for i, w := range c.want {
			if r[i+1] != w {
				t.Errorf("%s (%s): field %s = %v, want %v", c.id, c.why, art.Fields[i+1], r[i+1], w)
			}
		}
	}
	// The two Fantanele turbines share their place, so both are grouped.
	n := 0
	for _, r := range art.Rows {
		if r[2] == "Fantanele" {
			n++
			if r[8] != true {
				t.Errorf("%s: a wind farm's turbine not grouped", r[0])
			}
		}
	}
	if n != 2 {
		t.Errorf("Fantanele rows = %d, want 2", n)
	}
}

// Both sums are checked, and a damaged file is refused.
func TestVerifyRoObst(t *testing.T) {
	data, err := os.ReadFile(roFixture)
	if err != nil {
		t.Fatal(err)
	}
	sums, err := os.ReadFile(roFixture + ".crc32q")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := verifyRoObst(data, sums); err != nil {
		t.Errorf("the fixture refused: %v", err)
	}
	if _, err := verifyRoObst(data[:len(data)-10], sums); err == nil {
		t.Error("a truncated file accepted")
	}
	if _, err := verifyRoObst(data, []byte("1FC938CF")); err == nil {
		t.Error("a check file without its SHA-1 accepted")
	}
	if _, err := verifyRoObst(data, []byte("00000000\nfbf5b669d10e8417302b07fdcb9e04499949a008")); err == nil {
		t.Error("a wrong CRC-32Q accepted")
	}
}

// Every type the data set wrote on 2026-09-24 reaches the codelist, and a
// count or a plural stands for several.
func TestKindOf(t *testing.T) {
	for _, c := range []struct {
		in      string
		code    string
		several bool
	}{
		{"eolian power plant", "WIND_TURBINE", false},
		{"1 eolian power plant", "WIND_TURBINE", false},
		{"Eolian power plants", "WIND_TURBINE", true},
		{"102 eolian power plants", "WIND_TURBINE", true},
		{"Eolian Powerplants", "WIND_TURBINE", true},
		{"WINDMILL", "WIND_TURBINE", false},
		{"Antenna mast", "MAST", false},
		{"2 antenna masts ", "MAST", true},
		{"ANTENNA", "ANTENNA", false},
		{"antenna", "ANTENNA", false},
		{"Building+ antenna", "ANTENNA", false},
		{"anemometric tower  ", "MAST", false},
		{"anemometric towers", "MAST", true},
		{"Chimney", "CHIMNEY", false},
		{"CHIMNEY", "CHIMNEY", false},
		{"2 chimneys", "CHIMNEY", true},
		{"Chimneys", "CHIMNEY", true},
		{"STACK", "STACK", false},
		{"Building", "BUILDING", false},
		{"Buildings", "BUILDING", true},
		{"Tower", "TOWER", false},
		{"Gasometer", "Gasometer", false},
	} {
		code, several := kindOf(c.in)
		if code != c.code || several != c.several {
			t.Errorf("kindOf(%q) = %s, %v; want %s, %v", c.in, code, several, c.code, c.several)
		}
	}
}

// A place becomes the name, and its id is derived from the place and the
// position; ids stay unique whatever the data set repeats.
func TestRoShape(t *testing.T) {
	obs := []aixm5.Obstacle{
		{ID: "Pestera", Type: "eolian power plant", Lat: 44.2158, Lon: 28.05236},
		{ID: "Pestera", Type: "eolian power plant", Lat: 44.21595, Lon: 28.05213},
		{ID: "LRIA_4450", Type: "WINDMILL", Lat: 46.89, Lon: 27.66822},
		{ID: "LRIA_4450", Type: "WINDMILL", Lat: 46.89, Lon: 27.66822},
		{ID: "Bucuresti", Type: "Antenna mast", Lat: 44.39361, Lon: 26.125},
	}
	roShape(obs)
	want := []struct {
		id, name string
		group    bool
	}{
		{"PESTERA-441257N0280308E", "Pestera", true},
		{"PESTERA-441257N0280308E-2", "Pestera", true},
		{"LRIA_4450", "", false},
		{"LRIA_4450-2", "", false},
		{"BUCURESTI-442337N0260730E", "Bucuresti", false},
	}
	for i, w := range want {
		if obs[i].ID != w.id || obs[i].Name != w.name || obs[i].Group != w.group {
			t.Errorf("row %d = %s %q group %v, want %s %q group %v", i, obs[i].ID, obs[i].Name, obs[i].Group, w.id, w.name, w.group)
		}
	}
}

func TestDecodeRo(t *testing.T) {
	if got := string(decodeRo([]byte("B\xe2rlad, Bra\xbaov, Timi\xbaoara, Pite\xbati"))); got != "Bârlad, Braşov, Timişoara, Piteşti" {
		t.Errorf("decodeRo = %q", got)
	}
	if got := string(decodeRo([]byte("Bârlad"))); got != "Bârlad" {
		t.Errorf("UTF-8 decoded again: %q", got)
	}
}

func TestPackedPos(t *testing.T) {
	if got := packedPos(44.1775, 28.41333); got != "441039N0282448E" {
		t.Errorf("packedPos = %s", got)
	}
	if got := packedPos(-33.5, -70.25); got != "333000S0701500W" {
		t.Errorf("packedPos south-west = %s", got)
	}
}

// The page links the data set relative to itself; the one in force is the
// newest dated by today, and a pre-release is the nearest after it.
func TestFindAndPickRoObstFiles(t *testing.T) {
	page := []byte(`<a href="../files/obst/Obstacle_Data_LRBB_Area_1_16_APR_2026.csv">Air Navigation Obstacles</a>
<a href="../files/obst/Obstacle_Data_LRBB_Area_1_16_APR_2026.csv.crc32q">CRC32Q</a>
<a href="../files/obst/Obstacle_Data_LRBB_Area_1_29_OCT_2026.csv">next</a>`)
	files := findRoObstFiles(page)
	if len(files) != 2 {
		t.Fatalf("files = %+v", files)
	}
	if files[0].URL != "https://www.aisro.ro/files/obst/Obstacle_Data_LRBB_Area_1_16_APR_2026.csv" {
		t.Errorf("url = %s", files[0].URL)
	}
	now := time.Date(2026, time.September, 24, 0, 0, 0, 0, time.UTC)
	if f := pickRoObstFile(files, "current", now); f == nil || f.Name != "Obstacle_Data_LRBB_Area_1_16_APR_2026.csv" {
		t.Errorf("current = %+v", f)
	}
	if f := pickRoObstFile(files, "next", now); f == nil || f.Name != "Obstacle_Data_LRBB_Area_1_29_OCT_2026.csv" {
		t.Errorf("next = %+v", f)
	}
	if f := pickRoObstFile(files[:1], "next", now); f != nil {
		t.Errorf("next with nothing posted = %+v", f)
	}
}

// TestRoShapeSuffixByContent: two obstacles one id names are told apart by
// their content, never by the file's order: the same turbine keeps its id
// whichever way round ROMATSA lists the pair.
func TestRoShapeSuffixByContent(t *testing.T) {
	a := aixm5.Obstacle{ID: "Pestera", Type: "eolian power plant", Lat: 44.2158, Lon: 28.05236}
	b := aixm5.Obstacle{ID: "Pestera", Type: "eolian power plant", Lat: 44.21595, Lon: 28.05213}
	for _, obs := range [][]aixm5.Obstacle{{a, b}, {b, a}} {
		roShape(obs)
		for _, o := range obs {
			want := "PESTERA-441257N0280308E"
			if o.Lat == b.Lat {
				want += "-2"
			}
			if o.ID != want {
				t.Errorf("obstacle at %v = %s, want %s", o.Lat, o.ID, want)
			}
		}
	}
	// One place and position, told apart by a figure or a flag alone
	// (VALEA-NUCARILOR's pairs differ in their heights): the lower, then
	// the unlit, keeps the bare id whichever the file lists first.
	h := func(v float64) *float64 { return &v }
	mast := func(elev, height float64, lit bool) aixm5.Obstacle {
		return aixm5.Obstacle{ID: "Valea Nucarilor", Type: "mast", Lat: 45.1, Lon: 28.9, ElevM: h(elev), HeightM: h(height), Lighted: lit}
	}
	for _, pair := range []struct {
		name        string
		bare, other aixm5.Obstacle
	}{
		{"height", mast(40, 60, false), mast(40, 75, false)},
		{"elevation", mast(40, 60, false), mast(52, 60, false)},
		{"lighting", mast(40, 60, false), mast(40, 60, true)},
	} {
		for _, obs := range [][]aixm5.Obstacle{{pair.bare, pair.other}, {pair.other, pair.bare}} {
			roShape(obs)
			for _, o := range obs {
				want := "VALEA-NUCARILOR-450600N0285400E"
				if *o.ElevM != *pair.bare.ElevM || *o.HeightM != *pair.bare.HeightM || o.Lighted != pair.bare.Lighted {
					want += "-2"
				}
				if o.ID != want {
					t.Errorf("%s pair: %s, want %s", pair.name, o.ID, want)
				}
			}
		}
	}
}
