package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

const goldenIndex = "testdata/places.meta.want.json"

// marshalIndex lays the index out as the build writes it.
func marshalIndex(t *testing.T, idx Index) []byte {
	t.Helper()
	b, err := json.MarshalIndent(idx, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	return append(b, '\n')
}

func TestBuildGoldenIndex(t *testing.T) {
	res, err := build(readInputs(t), testOptions())
	if err != nil {
		t.Fatal(err)
	}
	got := marshalIndex(t, res.Index)
	if *update {
		if err := os.WriteFile(goldenIndex, got, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(goldenIndex)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Errorf("index differs from %s (go test -update rewrites it):\n%s", goldenIndex, got)
	}
}

func TestBuildRows(t *testing.T) {
	res, err := build(readInputs(t), testOptions())
	if err != nil {
		t.Fatal(err)
	}
	rows := func(iso string) map[string][]any {
		out := map[string][]any{}
		for _, r := range res.Files[iso].Rows {
			cells := r.([]any)
			out[cells[0].(string)] = cells
		}
		return out
	}
	for _, c := range []struct {
		iso, id string
		want    []any
	}{
		{"fr", "fr:91223", []any{"fr:91223", "Étampes", 48.435, 2.161, 26857, "91", ""}},
		{"fr", "fr:39421", []any{"fr:39421", "Le Pin", 46.709, 5.57, nil, "39", ""}},
		{"gp", "gp:97101", []any{"gp:97101", "Les Abymes", 16.271, -61.505, 51055, "971", ""}},
		{"de", "de:2867714", []any{"de:2867714", "München", 48.137, 11.575, 1260391, "02", "Munich"}},
		{"de", "de:9000002", []any{"de:9000002", "Amtsdorf", 48.6, 11.1, nil, "02", ""}},
		{"de", "de:9000003", []any{"de:9000003", "Dachau", 48.26, 11.434, 47400, "02", ""}},
		{"us", "us:4717560", []any{"us:4717560", "Paris", 33.661, -95.556, 24782, "TX", ""}},
	} {
		if got := rows(c.iso)[c.id]; !slices.Equal(got, c.want) {
			t.Errorf("%s row = %v, want %v", c.id, got, c.want)
		}
	}
	if got := res.Files["fr"].Admins; got["91"] != "Essonne" || len(got) != 6 {
		t.Errorf("fr admins = %v, want the six départements used, 91 Essonne", got)
	}
	if got := res.Files["us"].Admins; len(got) != 3 || got["TX"] != "Texas" {
		t.Errorf("us admins = %v, want AK, HI and TX alone", got)
	}
	// Rows go in source order: INSEE codes as strings, geonameids as
	// numbers.
	var ids []string
	for _, r := range res.Files["fr"].Rows {
		ids = append(ids, r.([]any)[0].(string))
	}
	if want := []string{"fr:05135", "fr:09243", "fr:17319", "fr:2A004", "fr:39421", "fr:91223"}; !slices.Equal(ids, want) {
		t.Errorf("fr order = %v, want %v", ids, want)
	}
	ids = nil
	for _, r := range res.Files["us"].Rows {
		ids = append(ids, r.([]any)[0].(string))
	}
	if want := []string{"us:4717560", "us:5856195", "us:5879400"}; !slices.Equal(ids, want) {
		t.Errorf("us order = %v, want %v", ids, want)
	}
}

// Two builds of the same inputs write the same bytes, the index's
// generatedAt aside.
func TestBuildDeterministic(t *testing.T) {
	in := readInputs(t)
	a, err := build(in, testOptions())
	if err != nil {
		t.Fatal(err)
	}
	opts := testOptions()
	opts.Now = func() time.Time { return fixedNow().Add(36 * time.Hour) }
	b, err := build(in, opts)
	if err != nil {
		t.Fatal(err)
	}
	for iso := range a.Files {
		fa, _ := json.Marshal(a.Files[iso])
		fb, _ := json.Marshal(b.Files[iso])
		if !bytes.Equal(fa, fb) {
			t.Errorf("places-%s.json differs between two builds", iso)
		}
	}
	if a.Index.GeneratedAt == b.Index.GeneratedAt {
		t.Fatal("both builds stamped the same generatedAt")
	}
	b.Index.GeneratedAt = a.Index.GeneratedAt
	if !bytes.Equal(marshalIndex(t, a.Index), marshalIndex(t, b.Index)) {
		t.Error("the index differs between two builds beyond generatedAt")
	}
}

// The United States' rows sit in three pieces an ocean apart, which the
// index lists so the app loads the file only where it is needed.
func TestBuildBBoxes(t *testing.T) {
	res, err := build(readInputs(t), testOptions())
	if err != nil {
		t.Fatal(err)
	}
	us := res.Index.Countries["us"]
	if len(us.BBoxes) != 3 {
		t.Errorf("us bboxes = %v, want three (Texas, Alaska, Hawaii)", us.BBoxes)
	}
	// The envelope rounds outward: Honolulu at -157.858 sits inside it.
	if len(us.BBox) != 4 || us.BBox[0] > -157.858 || us.BBox[1] > 21.307 || us.BBox[2] < -95.556 || us.BBox[3] < 61.218 {
		t.Errorf("us bbox = %v, want it around Honolulu, Paris TX and Anchorage", us.BBox)
	}
	if de := res.Index.Countries["de"]; de.BBoxes != nil || de.BBox == nil {
		t.Errorf("de = %+v, want one envelope and no pieces", de)
	}
}

func TestBuildWindows(t *testing.T) {
	in := readInputs(t)
	opts := testOptions()
	opts.Countries = slices.Clone(testTable)
	for i, c := range countries {
		if c.iso == "fr" {
			opts.Countries[0] = countries[i]
		}
	}
	if _, err := build(in, opts); err == nil || !strings.Contains(err.Error(), "fr: 6 places outside the sanity window [34000, 36000]") {
		t.Errorf("build with France's window = %v, want France refused", err)
	}
	opts = testOptions()
	opts.GeoNamesMin = 30000
	if _, err := build(in, opts); err == nil || !strings.Contains(err.Error(), "geonames: 6 places") {
		t.Errorf("build with the GeoNames window = %v, want it refused", err)
	}
}

func TestCheckTable(t *testing.T) {
	if err := checkTable(countries); err != nil {
		t.Errorf("the country table: %v", err)
	}
	for _, c := range countries {
		if c.minRows < 1 || c.why == "" {
			t.Errorf("%s: a row needs a floor and a reason", c.iso)
		}
		if c.source == srcGeoNames && c.cc != strings.ToUpper(c.iso) {
			t.Errorf("%s: GeoNames code %s", c.iso, c.cc)
		}
	}
	for name, table := range map[string][]country{
		"an ISO code twice":    {testTable[2], testTable[2]},
		"a département twice":  {testTable[0], {iso: "zz", source: srcIGN, depts: []string{"91"}}},
		"France from GeoNames": {{iso: "zz", source: srcGeoNames, cc: "FR"}},
		"an unknown source":    {{iso: "zz", source: "osm"}},
		"an upper-case code":   {{iso: "DE", source: srcGeoNames, cc: "DE"}},
	} {
		if err := checkTable(table); err == nil {
			t.Errorf("checkTable accepted %s", name)
		}
	}
}

// The digest is what sha256sum prints for the inputs, hashed again.
func TestDigest(t *testing.T) {
	a, b := []byte("one\n"), []byte("two\n")
	listing := fmt.Sprintf("%x  a.json\n%x  dir/b.zip\n", sha256.Sum256(a), sha256.Sum256(b))
	want := fmt.Sprintf("%x", sha256.Sum256([]byte(listing)))
	if got := digest([]named{{"a.json", a}, {"dir/b.zip", b}}); got != want {
		t.Errorf("digest = %s, want %s", got, want)
	}
}

func TestRound3(t *testing.T) {
	for in, want := range map[float64]string{48.4345: "48.435", -0.0004: "0", 2.0: "2", -61.5017: "-61.502"} {
		b, _ := json.Marshal(round3(in))
		if string(b) != want {
			t.Errorf("round3(%v) encodes as %s, want %s", in, b, want)
		}
	}
}

// The index lists every file of the replay, from the right source.
func TestBuildIndexCountries(t *testing.T) {
	res, err := build(readInputs(t), testOptions())
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range testTable {
		e, ok := res.Index.Countries[c.iso]
		if !ok || e.Source != c.source || e.Rows != len(res.Files[c.iso].Rows) {
			t.Errorf("%s index entry = %+v", c.iso, e)
		}
	}
	if res.Index.PlaceCount != 6+1+3+3 {
		t.Errorf("placeCount = %d, want 13", res.Index.PlaceCount)
	}
	if res.Index.Sources.GeoNames.Date != "2026-10-18" {
		t.Errorf("GeoNames date = %q, want the newest row's, 2026-10-18", res.Index.Sources.GeoNames.Date)
	}
	if _, err := os.Stat(filepath.Join(replayDir, citiesName)); err != nil {
		t.Fatal(err)
	}
}
