package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The manifest's edition is the digest of the receipts the same pass
// writes: it holds while the tiles do and moves when one tile changes.
func TestManifestEditionFollowsTheTiles(t *testing.T) {
	out := t.TempDir()
	if err := recordRegion(out, "glo90"); err != nil {
		t.Fatal(err)
	}
	for _, x := range []int{100, 101} {
		if err := writeTile(out, flat(10, x, 100, 800)); err != nil {
			t.Fatal(err)
		}
	}
	dir := t.TempDir()
	readJSON := func(path string, v any) {
		t.Helper()
		b, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(b, v); err != nil {
			t.Fatal(err)
		}
	}
	// edition runs finish as the recipe does, -manifest beside -receipts, or
	// -manifest alone, and returns the edition the manifest states.
	edition := func(receipts string) string {
		t.Helper()
		manifest := filepath.Join(dir, "terrain.json")
		if err := finish(manifest, receipts, out, 2, quiet); err != nil {
			t.Fatal(err)
		}
		var doc manifestDoc
		readJSON(manifest, &doc)
		return doc.Edition
	}

	receipts := filepath.Join(dir, "receipts.json")
	first := edition(receipts)
	var sums map[string]string
	readJSON(receipts, &sums)
	if len(sums) != 2 {
		t.Fatalf("receipts hold %d tiles, want 2", len(sums))
	}
	if want := editionOf(sums); first != want || len(first) != 16 {
		t.Fatalf("edition %q, want %q, the digest of the receipts", first, want)
	}
	if alone := edition(""); alone != first {
		t.Errorf("edition %q from -manifest alone, want %q", alone, first)
	}

	if err := writeTile(out, flat(10, 101, 100, 900)); err != nil {
		t.Fatal(err)
	}
	if moved := edition(receipts); moved == first {
		t.Errorf("edition %q after a tile changed, want another", moved)
	}
}
