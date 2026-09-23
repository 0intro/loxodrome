package aip

import (
	"os"
	"path/filepath"
	"testing"
)

// writeNextPair drops a .next artefact + sidecar carrying effective into
// dir, standing in for a pre-release a previous run left behind.
func writeNextPair(t *testing.T, dir, prefix, effective string) (string, string) {
	t.Helper()
	jsonPath := filepath.Join(dir, prefix+".next.json")
	metaPath := filepath.Join(dir, prefix+".next.meta.json")
	if err := os.WriteFile(jsonPath, []byte(`[]`), 0o644); err != nil {
		t.Fatal(err)
	}
	body := `{"effective": ` + effective + `}` + "\n"
	if err := os.WriteFile(metaPath, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return jsonPath, metaPath
}

func exists(t *testing.T, path string) bool {
	t.Helper()
	_, err := os.Stat(path)
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	return err == nil
}

// TestWriteDatasetRetiresSupersededNext pins the rule that a pre-release
// the current slot has caught up with is deleted, and that anything the
// writer cannot read confidently is left alone. Nothing else in the
// toolchain removes a .next pair, so without this a cycle's pre-release
// outlives its own changeover.
func TestWriteDatasetRetiresSupersededNext(t *testing.T) {
	cases := []struct {
		name         string
		currentEff   string
		nextSidecar  string // the raw JSON value written for "effective"
		wantNextKept bool
	}{
		{"strictly later pre-release stays", "2026-08-06T00:00:00.000Z", `"2026-09-03T00:00:00.000Z"`, true},
		{"same cycle is superseded", "2026-08-06T00:00:00.000Z", `"2026-08-06T00:00:00.000Z"`, false},
		{"earlier cycle is superseded", "2026-08-06T00:00:00.000Z", `"2026-07-09T00:00:00.000Z"`, false},
		{"bare calendar dates compare too", "2026-08-06", `"2026-08-06"`, false},
		{"SIA local midnight is the same day, not the eve", "2026-08-06T00:00:00.000+02:00", `"2026-08-06T00:00:00.000Z"`, false},
		{"unparseable pre-release date is kept", "2026-08-06", `"not-a-date"`, true},
		{"empty pre-release date is kept", "2026-08-06", `""`, true},
	}

	for _, c := range cases {
		dir := t.TempDir()
		jsonPath, metaPath := writeNextPair(t, dir, "xx-airspaces", c.nextSidecar)

		slot, err := WriteDataset(dir, "xx-airspaces", "current", c.currentEff, []int{}, map[string]string{"effective": c.currentEff})
		if err != nil {
			t.Errorf("%s: %v", c.name, err)
			continue
		}
		if slot != "current" {
			t.Errorf("%s: slot = %q, want current", c.name, slot)
		}
		if got := exists(t, jsonPath); got != c.wantNextKept {
			t.Errorf("%s: .next.json present = %v, want %v", c.name, got, c.wantNextKept)
		}
		if got := exists(t, metaPath); got != c.wantNextKept {
			t.Errorf("%s: .next.meta.json present = %v, want %v", c.name, got, c.wantNextKept)
		}
		// The current slot is written either way.
		if !exists(t, filepath.Join(dir, "xx-airspaces.json")) {
			t.Errorf("%s: current artefact missing", c.name)
		}
	}
}

// TestWriteDatasetPruneIsInert covers the cases where there is nothing to
// prune: no pre-release on disk, a sidecar that is not JSON, an empty
// effective on the current slot (ENAIRE), and a .next write, which must
// never touch the current slot.
func TestWriteDatasetPruneIsInert(t *testing.T) {
	t.Run("no pre-release on disk", func(t *testing.T) {
		dir := t.TempDir()
		if _, err := WriteDataset(dir, "xx-airspaces", "current", "2026-08-06", []int{}, map[string]string{}); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("undecodable sidecar is kept", func(t *testing.T) {
		dir := t.TempDir()
		jsonPath := filepath.Join(dir, "xx-airspaces.next.json")
		metaPath := filepath.Join(dir, "xx-airspaces.next.meta.json")
		if err := os.WriteFile(jsonPath, []byte(`[]`), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(metaPath, []byte(`not json at all`), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := WriteDataset(dir, "xx-airspaces", "current", "2026-08-06", []int{}, map[string]string{}); err != nil {
			t.Fatal(err)
		}
		if !exists(t, metaPath) || !exists(t, jsonPath) {
			t.Error("an undecodable sidecar must leave the pre-release alone")
		}
	})

	t.Run("empty current effective keeps the pre-release", func(t *testing.T) {
		// ENAIRE publishes no effective date, so every Spanish dataset
		// writes an empty one; that is not evidence the pre-release lapsed.
		dir := t.TempDir()
		jsonPath, metaPath := writeNextPair(t, dir, "es-airspaces", `"2026-08-06T00:00:00.000Z"`)
		if _, err := WriteDataset(dir, "es-airspaces", "current", "", []int{}, map[string]string{}); err != nil {
			t.Fatal(err)
		}
		if !exists(t, metaPath) || !exists(t, jsonPath) {
			t.Error("an empty current effective must leave the pre-release alone")
		}
	})

	t.Run("writing next leaves the current slot", func(t *testing.T) {
		dir := t.TempDir()
		curPath := filepath.Join(dir, "xx-airspaces.json")
		if err := os.WriteFile(curPath, []byte(`[]`), 0o644); err != nil {
			t.Fatal(err)
		}
		slot, err := WriteDataset(dir, "xx-airspaces", "next", "2026-09-03", []int{}, map[string]string{})
		if err != nil {
			t.Fatal(err)
		}
		if slot != "next" {
			t.Errorf("slot = %q, want next", slot)
		}
		if !exists(t, curPath) {
			t.Error("a .next write must not touch the current slot")
		}
	})
}
