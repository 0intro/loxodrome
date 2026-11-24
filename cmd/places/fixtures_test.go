package main

import (
	"archive/zip"
	"bytes"
	"flag"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"
)

var update = flag.Bool("update", false, "rewrite testdata/places.meta.want.json and the replay archives in testdata/inputs")

// replayDir is a replay directory as -keep writes one, small enough to
// read: IGN's pages, two for the chefs-lieux and two for the communes,
// and the GeoNames files, whose archives are built from
// testdata/unzipped (TestReplayArchives).
const replayDir = "testdata/inputs"

// testTable is the table the fixtures are built by: every source and
// both kinds of file, each window open.
var testTable = []country{
	{iso: "fr", source: srcIGN, depts: metropole(), envelope: [4]float64{-5.5, 41, 10, 51.5}, minRows: 1, why: "test"},
	{iso: "gp", source: srcIGN, depts: []string{"971"}, envelope: [4]float64{-62, 15.7, -60.9, 16.6}, minRows: 1, why: "test"},
	{iso: "de", source: srcGeoNames, cc: "DE", minPop: defaultMinPop, display: "de", alt: enFr, minRows: 1, why: "test"},
	{iso: "us", source: srcGeoNames, cc: "US", minPop: defaultMinPop, alt: enFr, minRows: 1, why: "test"},
}

func fixedNow() time.Time {
	return time.Date(2026, time.October, 18, 12, 0, 0, 0, time.UTC)
}

func testOptions() Options {
	return Options{Countries: testTable, GeoNamesMin: 1, GeoNamesMax: 100, Now: fixedNow}
}

// readInputs reads the replay directory the way a -in run does.
func readInputs(t *testing.T) Inputs {
	t.Helper()
	src := &fetcher{in: replayDir}
	in, err := src.inputs(t.Context(), testTable)
	if err != nil {
		t.Fatal(err)
	}
	return in
}

// zipStored archives one member, stored rather than deflated and dated
// to a fixed instant, so the bytes depend on nothing but the content.
func zipStored(t *testing.T, member string, data []byte) []byte {
	t.Helper()
	var b bytes.Buffer
	zw := zip.NewWriter(&b)
	w, err := zw.CreateHeader(&zip.FileHeader{Name: member, Method: zip.Store, Modified: fixedNow()})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

// TestReplayArchives holds each archive of the replay directory to the
// text it is built from, which is what a reviewer reads; -update
// rebuilds them.
func TestReplayArchives(t *testing.T) {
	for _, a := range []struct{ archive, member, source string }{
		{citiesName, "cities500.txt", "cities500.txt"},
		{alternatesName("DE"), "DE.txt", "alternatenames/DE.txt"},
		{alternatesName("US"), "US.txt", "alternatenames/US.txt"},
	} {
		want, err := os.ReadFile(filepath.Join("testdata", "unzipped", filepath.FromSlash(a.source)))
		if err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(replayDir, filepath.FromSlash(a.archive))
		if *update {
			if err := os.WriteFile(path, zipStored(t, a.member, want), 0o644); err != nil {
				t.Fatal(err)
			}
			continue
		}
		zipped, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		rc, err := openZipEntry(zipped, a.member)
		if err != nil {
			t.Fatalf("%s: %v", a.archive, err)
		}
		got, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(got, want) {
			t.Errorf("%s holds a %s other than testdata/unzipped/%s: run go test -update", a.archive, a.member, a.source)
		}
	}
}
