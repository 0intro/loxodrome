package main

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/0intro/loxodrome/internal/aixm5"
	"github.com/0intro/loxodrome/internal/aixm5build"
)

func fixedNow() time.Time {
	return time.Date(2026, time.August, 15, 12, 0, 0, 0, time.UTC)
}

func readFixture(t *testing.T) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "area1_trimmed.csv"))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// The fixture carries one row of every type the register publishes, so a
// new spelling shows up here as an unmapped type rather than as a
// silently miscoloured glyph on the map.
func TestParseObstacles(t *testing.T) {
	obstacles, st, err := parseObstacles(readFixture(t))
	if err != nil {
		t.Fatal(err)
	}
	if len(obstacles) != 12 {
		t.Fatalf("obstacles = %d, want 12", len(obstacles))
	}
	if st.SkippedNoPosition != 0 {
		t.Errorf("skipped %d rows for position, want 0", st.SkippedNoPosition)
	}

	by := map[string]aixm5.Obstacle{}
	for _, o := range obstacles {
		by[o.ID] = o
	}

	m, ok := by["EFINOB 10031"]
	if !ok {
		t.Fatal("EFINOB 10031 missing")
	}
	if m.Type != "Mast" {
		t.Errorf("type = %q, want Mast", m.Type)
	}
	// The decimal columns are rounded like every other publisher's
	// positions, which the AIXM decoder does for them and this path has
	// to do for itself.
	if m.Lat != 61.93083 || m.Lon != 25.73176 {
		t.Errorf("position = %v, %v, want 61.93083, 25.73176", m.Lat, m.Lon)
	}
	// The register publishes no names.
	if m.Name != "" {
		t.Errorf("name = %q, want empty", m.Name)
	}
}

// Heights are published in feet, the shared builder takes metres and
// converts back, so the emitted value has to be the publisher's own
// integer rather than one off by a unit conversion.
func TestHeightsRoundTripToFeet(t *testing.T) {
	raw := readFixture(t)
	obstacles, _, err := parseObstacles(raw)
	if err != nil {
		t.Fatal(err)
	}
	artifact, _, err := aixm5build.BuildObstacles(&aixm5.Message{Obstacles: obstacles},
		"fixture", raw, "2026-08-06T00:00:00.000Z",
		aixm5build.ObstaclesOptions{IDPrefix: "fi", Country: "FI", Now: fixedNow, MinObstacles: 1, MaxObstacles: 20})
	if err != nil {
		t.Fatal(err)
	}
	// fields: id, type, name, lat, lon, elev, hgt, lit, group
	want := map[string][2]int{
		"fi:EFINOB 10031": {983, 355},
		"fi:EFINOB 48507": {863, 755},
		"fi:EFINOB 41400": {339, 329},
	}
	seen := 0
	for _, r := range artifact.Rows {
		row := r.([]any)
		w, ok := want[row[0].(string)]
		if !ok {
			continue
		}
		seen++
		if row[5] != w[0] || row[6] != w[1] {
			t.Errorf("%s: elev/hgt = %v/%v, want %d/%d", row[0], row[5], row[6], w[0], w[1])
		}
	}
	if seen != len(want) {
		t.Errorf("matched %d rows, want %d", seen, len(want))
	}
}

// The three lighting columns disagree with each other, so the rule reads
// all of them: a light is published when any one says something.
func TestLighted(t *testing.T) {
	obstacles, _, err := parseObstacles(readFixture(t))
	if err != nil {
		t.Fatal(err)
	}
	lit := map[string]bool{}
	for _, o := range obstacles {
		lit[o.ID] = o.Lighted
	}
	cases := []struct {
		id   string
		want bool
		why  string
	}{
		{"EFINOB 10031", true, "R F HN"},
		{"EFINOB 64068", true, "the one yellow light"},
		{"EFINOB 48507", true, "colour unknown but lit H24"},
		{"EFINOB 12206", false, "Unknown NIL NIL"},
	}
	for _, c := range cases {
		if got, ok := lit[c.id]; !ok {
			t.Errorf("%s missing", c.id)
		} else if got != c.want {
			t.Errorf("%s (%s): lighted = %v, want %v", c.id, c.why, got, c.want)
		}
	}
}

// Every type the register writes has to reach the shared codelist;
// anything new lands in unknownTypes, which is the drift signal.
func TestEveryPublishedTypeIsMapped(t *testing.T) {
	raw := readFixture(t)
	obstacles, _, err := parseObstacles(raw)
	if err != nil {
		t.Fatal(err)
	}
	_, meta, err := aixm5build.BuildObstacles(&aixm5.Message{Obstacles: obstacles},
		"fixture", raw, "2026-08-06T00:00:00.000Z",
		aixm5build.ObstaclesOptions{IDPrefix: "fi", Country: "FI", Now: fixedNow, MinObstacles: 1, MaxObstacles: 20})
	if err != nil {
		t.Fatal(err)
	}
	if len(meta.UnknownTypes) != 0 {
		t.Errorf("unknownTypes = %v, want none", meta.UnknownTypes)
	}
	// "Built structure" and "Pole" are the two the AIXM publishers never
	// write, so they are the two most likely to regress.
	for _, code := range []string{"building", "pylon", "windturbine", "mast", "chimney", "crane", "tower"} {
		if meta.Counts[code] == 0 {
			t.Errorf("no rows counted as %q", code)
		}
	}
}

// A table missing a column this command reads must fail loudly: the
// alternative is a dataset built from the wrong columns.
func TestHeaderColsRequiresEveryReadColumn(t *testing.T) {
	if _, err := headerCols([]string{"OBST ID", "TYPE", "COORD", "LAT", "LONG", "HGT AGL (FT)", "ELEV MSL (FT)"}); err != nil {
		t.Errorf("complete header rejected: %v", err)
	}
	if _, err := headerCols([]string{"OBST ID", "TYPE", "COORD", "LAT", "LONG"}); err == nil {
		t.Error("header with no height columns accepted")
	}
}

// The CSV rides inside a zip; a bare .csv path is the offline-replay
// convenience.
func TestReadCSVFromZip(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.Create("ef_efin_area1_obstdata_06_aug_2026.csv")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte("OBST ID;TYPE\r\n")); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	data, name, err := readCSV(buf.Bytes(), "ef_efin_area1_obstdata_06_aug_2026.zip")
	if err != nil {
		t.Fatal(err)
	}
	if name != "ef_efin_area1_obstdata_06_aug_2026.csv" {
		t.Errorf("name = %q", name)
	}
	if string(data) != "OBST ID;TYPE\r\n" {
		t.Errorf("data = %q", data)
	}
}

// The index lists every obstacle product the AIS publishes. Only the
// Area 1 archives are ours, and never the CHG_ deltas beside them.
func TestFindReleases(t *testing.T) {
	page := []byte(`
	  <a href="/sites/default/files/2026-06/ef_eflp_ols_obstdata_06_aug_2026.zip">OLS</a>
	  <a href="/sites/default/files/2026-06/CHG_ef_efin_area1_obstdata_06_aug_2026.zip">delta</a>
	  <a href="/sites/default/files/2026-06/ef_efin_area1_obstdata_06_aug_2026.zip">Area 1</a>
	  <a href="/sites/default/files/2026-07/ef_efin_area1_obstdata_03_sep_2026.zip">Area 1 next</a>
	  <a href="/sites/default/files/2026-03/ef_efhk_ols_obstdata_16_APR_2026.zip">OLS</a>
	  <a href="/sites/default/files/2024-06/ef_efhk_04l_area4_obstdata_08_aug_2024.zip">Area 4</a>
	`)
	rels, err := findReleases(page)
	if err != nil {
		t.Fatal(err)
	}
	if len(rels) != 2 {
		t.Fatalf("releases = %d, want 2: %+v", len(rels), rels)
	}
	// Newest first.
	if rels[0].Name != "ef_efin_area1_obstdata_03_sep_2026.zip" {
		t.Errorf("first = %q, want the September file", rels[0].Name)
	}
	if rels[0].Effective != "2026-09-03T00:00:00.000Z" {
		t.Errorf("effective = %q", rels[0].Effective)
	}
	if rels[1].URL != "https://www.ais.fi/sites/default/files/2026-06/ef_efin_area1_obstdata_06_aug_2026.zip" {
		t.Errorf("url = %q", rels[1].URL)
	}
}

// -target picks the release as well as the slot, because both cycles are
// on the index at once.
func TestPickRelease(t *testing.T) {
	page := []byte(`
	  <a href="/sites/default/files/2026-06/ef_efin_area1_obstdata_06_aug_2026.zip">a</a>
	  <a href="/sites/default/files/2026-07/ef_efin_area1_obstdata_03_sep_2026.zip">b</a>
	`)
	rels, err := findReleases(page)
	if err != nil {
		t.Fatal(err)
	}
	now := fixedNow()
	for _, c := range []struct{ target, want string }{
		{"auto", "ef_efin_area1_obstdata_06_aug_2026.zip"},
		{"current", "ef_efin_area1_obstdata_06_aug_2026.zip"},
		{"next", "ef_efin_area1_obstdata_03_sep_2026.zip"},
	} {
		got, err := pickRelease(rels, c.target, now)
		if err != nil {
			t.Fatalf("%s: %v", c.target, err)
		}
		if got == nil || got.Name != c.want {
			t.Errorf("%s: %v, want %s", c.target, got, c.want)
		}
	}

	// A pre-release nobody has posted yet is normal, not an error: the
	// scheduled run has to leave the current slot alone and exit clean.
	only := rels[1:]
	got, err := pickRelease(only, "next", now)
	if err != nil || got != nil {
		t.Errorf("next with no pre-release = %v, %v; want nil, nil", got, err)
	}
}

// Fintraffic posts several cycles at once, and on 21 August 2026 it was
// carrying three. The pre-release slot must take the NEAREST of them: the
// furthest-out edition would leave the cycle in between unpublished, and
// pickActiveDataset only promotes .next once its effective has arrived, so
// the app would serve August obstacles through the whole of September.
func TestPickReleaseTwoPreReleases(t *testing.T) {
	page := []byte(`
	  <a href="/sites/default/files/2026-06/ef_efin_area1_obstdata_06_aug_2026.zip">a</a>
	  <a href="/sites/default/files/2026-07/ef_efin_area1_obstdata_03_sep_2026.zip">b</a>
	  <a href="/sites/default/files/2026-08/ef_efin_area1_obstdata_01_oct_2026.zip">c</a>
	`)
	rels, err := findReleases(page)
	if err != nil {
		t.Fatal(err)
	}
	now := fixedNow()
	for _, c := range []struct{ target, want string }{
		{"current", "ef_efin_area1_obstdata_06_aug_2026.zip"},
		{"next", "ef_efin_area1_obstdata_03_sep_2026.zip"},
	} {
		got, err := pickRelease(rels, c.target, now)
		if err != nil {
			t.Fatalf("%s: %v", c.target, err)
		}
		if got == nil || got.Name != c.want {
			t.Errorf("%s: %v, want %s", c.target, got, c.want)
		}
	}
}

// An offline replay has to stamp the same effective date the fetch would
// have, which the filename is the only carrier of.
func TestEffectiveFromName(t *testing.T) {
	cases := []struct{ name, want string }{
		{"ef_efin_area1_obstdata_06_aug_2026.zip", "2026-08-06T00:00:00.000Z"},
		{"ef_efin_area1_obstdata_16_APR_2026.zip", "2026-04-16T00:00:00.000Z"},
		{"ef_efin_area1_obstdata_03_sep_2026.csv", "2026-09-03T00:00:00.000Z"},
		{"obstacles.zip", ""},
	}
	for _, c := range cases {
		if got := effectiveFromName(c.name); got != c.want {
			t.Errorf("effectiveFromName(%q) = %q, want %q", c.name, got, c.want)
		}
	}
}
