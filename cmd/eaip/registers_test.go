package main

import (
	"archive/zip"
	"bytes"
	"context"
	"os"
	"path/filepath"
	"regexp"
	"testing"
	"time"
)

// zipOf builds a zip of the named entries.
func zipOf(t *testing.T, entries map[string][]byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, data := range entries {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// PANSA's eTOD register: a zip holding one semicolon-separated file under
// a metadata preamble, each height with its own unit column.
func TestReadPansaCSV(t *testing.T) {
	csv := "DataBase;Workspace;Source;;;;;;;\n" +
		"AERODB;LIVE;2609_OBSTACLE;;;;;;;\n" +
		";;;;;;;;;\n" +
		"Latitude;Longitude;Height;Height Uom;Elevation;Elevation Uom;Obstacle identifier;Lighting;Obstacle type;Location\n" +
		"N 49 18 29.60;E 019 56 11.60;339;FT;4006.93;FT;02302-2012-01;YES;Tower;Zakopane\n" +
		"N 49 35 42.16;E 020 40 40.01;329;FT;1314.89;FT;01627-2011-01;NO;Chimney;Nowy Sacz\n"
	obs, err := readPansaCSV(zipOf(t, map[string][]byte{"eTOD_AREA1_Obstacles_2026-09-03.csv": []byte(csv)}))
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) != 2 || obs[0].Type != "TOWER" || !obs[0].Lighted || obs[1].Lighted || obs[1].Type != "CHIMNEY" {
		t.Errorf("obstacles %+v", obs)
	}
}

// EANS's register: a zip holding a KMZ, each placemark's attributes a
// table in its description; a line obstacle states no position there and
// is placed at its first vertex.
func TestReadEansKMZ(t *testing.T) {
	table := func(rows ...string) string {
		var b bytes.Buffer
		b.WriteString("<![CDATA[<html><body><table><tr><td>X</td></tr><tr><td><table>")
		for i := 0; i+1 < len(rows); i += 2 {
			b.WriteString("<tr><td>" + rows[i] + "</td><td>" + rows[i+1] + "</td></tr>")
		}
		b.WriteString("</table></td></tr></table></body></html>]]>")
		return b.String()
	}
	kml := `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Folder>
<Placemark><name>5001</name><description>` + table("ID", "5001", "HOR_POS_N_DEG", "57.762522", "HOR_POS_E_DEG", "27.044619",
		"ELEVATION_FT", "1112", "HEIGHT_FT", "438", "TYPE", "ANTENNA", "LIGHTING", "YES") + `</description>
<Point><coordinates>27.044619,57.762522,338.75</coordinates></Point></Placemark>
<Placemark><name>20295</name><description>` + table("ID", "20295", "ELEVATION_FT", "365", "HEIGHT_FT", "355", "TYPE", "CRANE", "LIGHTING", "NO") + `</description>
<MultiGeometry><LineString><coordinates> 24.968714,59.495528,111 24.964897,59.493344,111</coordinates></LineString></MultiGeometry></Placemark>
</Folder></Document></kml>`
	kmz := zipOf(t, map[string][]byte{"doc.kml": []byte(kml)})
	obs, err := readEansKMZ(zipOf(t, map[string][]byte{"ESTONIA_AREA_1_OBSTACLE_14052026.kmz": kmz, "ESTONIA_AREA_1_OBSTACLE_14052026.xls": []byte("legacy")}))
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) != 2 {
		t.Fatalf("%d obstacles, want 2", len(obs))
	}
	if obs[0].ID != "5001" || obs[0].Lat != 57.76252 || !obs[0].Lighted {
		t.Errorf("point obstacle %+v", obs[0])
	}
	if obs[1].ID != "20295" || obs[1].Lat != 59.49553 || obs[1].Lon != 24.96871 || obs[1].Lighted {
		t.Errorf("line obstacle %+v, want it at its first vertex", obs[1])
	}
}

// The edition in force on the slot's day is the newest the index lists on
// or before it.
func TestRegisterEdition(t *testing.T) {
	dir := t.TempDir()
	page := `<a href="https://docs.example/etod/area1/set_2026-08-06.zip">a</a>
<a href="https://docs.example/etod/area1/set_2026-09-03.zip">b</a>
<a href="https://docs.example/etod/area1/set_2026-10-01.zip">c</a>`
	name := filepath.Join(dir, "idx.example", "etod", "index.html")
	if err := os.MkdirAll(filepath.Dir(name), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(name, []byte(page), 0o644); err != nil {
		t.Fatal(err)
	}
	r := &obstacleRegister{
		Index:      "https://idx.example/etod/",
		Link:       regexp.MustCompile(`href="(https://docs\.example/etod/area1/set_(\d{4}-\d{2}-\d{2})\.zip)"`),
		DateLayout: "2006-01-02",
	}
	s := &State{}
	s.Site.Replay = dir
	for _, c := range []struct{ day, want string }{
		{"2026-09-24", "https://docs.example/etod/area1/set_2026-09-03.zip"},
		{"2026-10-01", "https://docs.example/etod/area1/set_2026-10-01.zip"},
	} {
		day, _ := time.Parse("2006-01-02", c.day)
		got, _, err := r.edition(context.Background(), s, day)
		if err != nil || got != c.want {
			t.Errorf("on %s: %q, %v; want %q", c.day, got, err, c.want)
		}
	}
}
