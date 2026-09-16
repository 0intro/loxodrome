package main

import (
	"math"
	"os"
	"path/filepath"
	"testing"
)

func TestLoadOverrides(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "overrides.tsv")
	body := "" +
		"# a comment, and the reason the entry exists\n" +
		"\n" +
		"LFxx\t2\t1\t50\t33\t400\t480\t48.7\t2.5\t48.9\t2.7\n"
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	ov, err := loadOverrides(path)
	if err != nil {
		t.Fatal(err)
	}
	f, ok := ov.lookup("lfxx", 2, 1)
	if !ok {
		t.Fatal("override not found (the ident should match case-insensitively)")
	}
	// The two corners define the affine: the clip's own corners must come
	// back as the coordinates that were typed.
	lat, lon := f.Geo.at(f.Clip.x0, f.Clip.y0)
	if math.Abs(lat-48.7) > 1e-9 || math.Abs(lon-2.5) > 1e-9 {
		t.Errorf("SW corner %.6f,%.6f, want 48.7,2.5", lat, lon)
	}
	lat, lon = f.Geo.at(f.Clip.x1, f.Clip.y1)
	if math.Abs(lat-48.9) > 1e-9 || math.Abs(lon-2.7) > 1e-9 {
		t.Errorf("NE corner %.6f,%.6f, want 48.9,2.7", lat, lon)
	}
	if _, ok := ov.lookup("LFxx", 2, 2); ok {
		t.Error("an override answered for a page it does not address")
	}
}

func TestLoadOverridesRejectsMalformedLines(t *testing.T) {
	dir := t.TempDir()
	for name, body := range map[string]string{
		"short":      "LFxx\t2\t1\t50\t33\t400\n",
		"not-a-num":  "LFxx\t2\t1\t50\t33\t400\t480\t48.7\t2.5\t48.9\tEAST\n",
		"empty-clip": "LFxx\t2\t1\t50\t33\t50\t480\t48.7\t2.5\t48.9\t2.7\n",
	} {
		path := filepath.Join(dir, name+".tsv")
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := loadOverrides(path); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// A missing file is not an error: the table is optional.
	if ov, err := loadOverrides(filepath.Join(dir, "absent.tsv")); err != nil || len(ov) != 0 {
		t.Errorf("a missing override table should read empty, got %v %v", ov, err)
	}
}
