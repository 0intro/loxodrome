package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func listDir(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, e := range entries {
		out = append(out, e.Name())
	}
	return out
}

func TestRunReplay(t *testing.T) {
	out := t.TempDir()
	// A country the table no longer holds, and a file of another dataset.
	for _, name := range []string{"places-zz.json", "metar-stations.json"} {
		if err := os.WriteFile(filepath.Join(out, name), []byte("{}"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := run(t.Context(), []string{"-in", replayDir, "-out", out}, testOptions()); err != nil {
		t.Fatal(err)
	}
	want := []string{"metar-stations.json", "places-de.json", "places-fr.json", "places-gp.json", "places-us.json", indexName}
	if got := listDir(t, out); !slices.Equal(got, want) {
		t.Errorf("wrote %v, want %v", got, want)
	}

	b, err := os.ReadFile(filepath.Join(out, indexName))
	if err != nil {
		t.Fatal(err)
	}
	golden, err := os.ReadFile(goldenIndex)
	if err != nil {
		t.Fatal(err)
	}
	// The run stamps its own clock, the golden the fixed one.
	var got, wantIdx Index
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(golden, &wantIdx); err != nil {
		t.Fatal(err)
	}
	got.GeneratedAt = wantIdx.GeneratedAt
	if string(marshalIndex(t, got)) != string(golden) {
		t.Errorf("the index written differs from %s", goldenIndex)
	}

	b, err = os.ReadFile(filepath.Join(out, "places-de.json"))
	if err != nil {
		t.Fatal(err)
	}
	var de File
	if err := json.Unmarshal(b, &de); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(de.Fields, fields) || len(de.Rows) != 3 || de.Admins["02"] != "Bavaria" {
		t.Errorf("places-de.json = %+v", de)
	}
}

// A run that fails its checks leaves the directory as it was.
func TestRunFailureWritesNothing(t *testing.T) {
	out := t.TempDir()
	stale := filepath.Join(out, "places-zz.json")
	if err := os.WriteFile(stale, []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	opts := testOptions()
	opts.GeoNamesMin = 30000
	if err := run(t.Context(), []string{"-in", replayDir, "-out", out}, opts); err == nil {
		t.Fatal("run passed a GeoNames total under its floor")
	}
	if got := listDir(t, out); !slices.Equal(got, []string{"places-zz.json"}) {
		t.Errorf("a failed run left %v, want the directory untouched", got)
	}
}

func TestRunUsage(t *testing.T) {
	for _, args := range [][]string{
		{"-in", "a", "-keep", "b"},
		{"extra"},
		{"-nosuchflag"},
	} {
		var usage usageError
		if err := run(t.Context(), args, testOptions()); !errors.As(err, &usage) {
			t.Errorf("run(%q) = %v, want a usage error", args, err)
		}
	}
}

func TestRunMissingInput(t *testing.T) {
	if err := run(t.Context(), []string{"-in", t.TempDir(), "-out", t.TempDir()}, testOptions()); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("run from an empty directory = %v, want a missing input", err)
	}
}
