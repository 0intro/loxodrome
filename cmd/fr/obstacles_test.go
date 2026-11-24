package main

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// TestBuildObstacles walks the synthetic fixture and asserts the decoded
// shape: per-type counts, lit / group flags, the "other" fallback for
// unknown French txtDescrType values, and the skippedNoGeo counter.
func TestBuildObstacles(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("testdata", "obstacles", "sample.aixm.xml"))
	if err != nil {
		t.Fatal(err)
	}
	fixedNow := func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) }
	art, meta, err := BuildObstacles(src, ObstaclesOptions{
		Source:       "sample.aixm.xml",
		Now:          fixedNow,
		MinObstacles: 1,
		MaxObstacles: 100,
	})
	if err != nil {
		t.Fatal(err)
	}

	// Fixture has 8 <Obs>, one with a bad coordinate that gets skipped.
	if meta.ObstacleCount != 7 {
		t.Errorf("ObstacleCount = %d, want 7", meta.ObstacleCount)
	}
	if meta.SkippedNoGeo != 1 {
		t.Errorf("SkippedNoGeo = %d, want 1", meta.SkippedNoGeo)
	}
	// 5 of 7 rows have codeLgt=Y, 1 of 7 has codeGroup=Y.
	if meta.LitCount != 5 {
		t.Errorf("LitCount = %d, want 5", meta.LitCount)
	}
	if meta.GroupCount != 1 {
		t.Errorf("GroupCount = %d, want 1", meta.GroupCount)
	}

	// Per-type counts.
	want := map[string]int{
		"windturbine": 1, // Eolienne(s)
		"pylon":       1, // Pylône
		"mast":        1, // Mât
		"antenna":     1, // Antenne
		"chimney":     1, // Cheminée
		"lighthouse":  1, // Phare marin
		"other":       1, // unknown French type falls through
	}
	for k, v := range want {
		if meta.Counts[k] != v {
			t.Errorf("counts[%q] = %d, want %d", k, meta.Counts[k], v)
		}
	}
	// "Étrange chose" must show up in unknownTypes.
	foundUnknown := false
	for _, t := range meta.UnknownTypes {
		if t == "Étrange chose" {
			foundUnknown = true
		}
	}
	if !foundUnknown {
		t.Errorf("UnknownTypes missing %q: %v", "Étrange chose", meta.UnknownTypes)
	}

	// Spot-check the artefact schema and the first row's shape.
	if len(art.Fields) != 10 || art.Fields[0] != "id" || art.Fields[8] != "group" ||
		art.Fields[9] != "rmk" {
		t.Errorf("fields shape mismatch: %v", art.Fields)
	}
	row0 := art.Rows[0].([]any)
	if got, want := row0[0].(string), "1000001"; got != want {
		t.Errorf("row[0].id = %q, want %q", got, want)
	}
	// The remark is emitted verbatim, the two-backslash FR/EN separator kept
	// for the SPA to split (see fixture obstacle 1000001).
	if got, want := row0[9].(string), `Pylône métallique\\Metallic pylon`; got != want {
		t.Errorf("row[0].rmk = %q, want %q", got, want)
	}
	if got, want := row0[1].(string), "pylon"; got != want {
		t.Errorf("row[0].type = %q, want %q", got, want)
	}
	if got, want := row0[7].(bool), false; got != want {
		t.Errorf("row[0].lit = %v, want %v", got, want)
	}
}

func TestClassifyAllKnownObstacleTypes(t *testing.T) {
	// Smoke-test that every entry in obstacleTypes returns a non-empty
	// language-neutral code (catches typos in either side of the map).
	for fr, code := range obstacleTypes {
		if code == "" {
			t.Errorf("obstacleTypes[%q] = empty", fr)
		}
	}
}

// frObs is one <Obs> of a test snapshot.
func frObs(mid, name, typ, lat, lon, hgt string) string {
	return `<Obs><ObsUid mid="` + mid + `"><geoLat>` + lat + `</geoLat><geoLong>` + lon + `</geoLong></ObsUid>` +
		`<txtName>` + name + `</txtName><txtDescrType>` + typ + `</txtDescrType><codeGroup>N</codeGroup>` +
		`<codeLgt>N</codeLgt><valElev>800</valElev><valHgt>` + hgt + `</valHgt><uomDistVer>FT</uomDistVer></Obs>`
}

func frSnapshot(obs ...string) []byte {
	return []byte(`<?xml version="1.0" encoding="UTF-8"?><AIXM-Snapshot effective="2026-09-03T00:00:00.000+02:00" version="4.5">` +
		strings.Join(obs, "") + `</AIXM-Snapshot>`)
}

// TestBuildObstaclesRepeatedMid covers the SIA reusing an ObsUid mid: in
// the 2026-09-03 and 2026-10-01 exports, 18293531 is both tower 16022 and
// pylon 16045, 26 km apart. Every member of such a mid is addressed as
// mid:txtName, which no file order decides; an Obs filed twice is kept
// once; and two obstacles a mid and a name cannot tell apart refuse the
// build by name.
func TestBuildObstaclesRepeatedMid(t *testing.T) {
	fixedNow := func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) }
	opts := ObstaclesOptions{Source: "test", Now: fixedNow, MinObstacles: 1, MaxObstacles: 100}
	pylon := frObs("5", "22033", "Pylône", "482936.00N", "0015526.00W", "167")
	art, meta, err := BuildObstacles(frSnapshot(
		frObs("18293531", "16022", "Tour", "452846.00N", "0000853.00E", "285"),
		pylon,
		frObs("18293531", "16045", "Pylône", "454138.07N", "0001622.87E", "174"),
		pylon,
	), opts)
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, r := range art.Rows {
		ids = append(ids, r.([]any)[0].(string))
	}
	if want := []string{"18293531:16022", "5", "18293531:16045"}; !reflect.DeepEqual(ids, want) {
		t.Errorf("ids = %v, want %v", ids, want)
	}
	if meta.ObstacleCount != 3 || meta.RepeatedMids != 1 || meta.RepeatedRows != 1 || meta.Counts["pylon"] != 2 {
		t.Errorf("count = %d, repeatedMids = %d, repeatedRows = %d, pylons = %d; want 3, 1, 1, 2",
			meta.ObstacleCount, meta.RepeatedMids, meta.RepeatedRows, meta.Counts["pylon"])
	}

	_, _, err = BuildObstacles(frSnapshot(
		frObs("7", "31001", "Mât", "450000.00N", "0010000.00E", "100"),
		frObs("7", "31001", "Mât", "450000.00N", "0010000.00E", "130"),
	), opts)
	if err == nil || !strings.Contains(err.Error(), "7:31001") {
		t.Errorf("two obstacles under one mid and name: err = %v, want a refusal naming 7:31001", err)
	}
}
