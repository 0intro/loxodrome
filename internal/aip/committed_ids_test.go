package aip

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// TestCommittedIdsUnique holds every committed dataset the app indexes by
// id to one row per id: the navaids, obstacles, nature zones and
// supplements by id, the aerodromes and their facilities by ident. The
// builders write each id once (DropRepeatedRows keeps a record filed twice
// once, SeparateConflictingRows gives two records their own ids), but the
// weekly data jobs commit what a builder writes without running the tests,
// so a builder that stopped doing so would ship a repeat; this is where it
// shows. Airspace rows share ids on purpose (a CTA in parts) and are
// addressed by key instead. It must read the committed data, never nothing:
// a glob that stopped matching would pass on an empty set.
func TestCommittedIdsUnique(t *testing.T) {
	dir := filepath.Join("..", "..", "public", "data")
	checked, current := 0, 0
	for _, set := range []struct {
		globs []string
		key   string
	}{
		{[]string{"*-navaids*.json", "*-obstacles*.json", "*-nature*.json", "*-supaip*.json"}, "id"},
		{[]string{"airports.json", "*-airports*.json", "*-aerodrome-facilities*.json"}, "ident"},
	} {
		for _, g := range set.globs {
			files, err := filepath.Glob(filepath.Join(dir, g))
			if err != nil {
				t.Fatal(err)
			}
			// Every glob matches something: one that stopped matching
			// checked nothing, and the total floor below missed it as long
			// as the others were many (three SUP AIP files among 112).
			if len(files) == 0 {
				t.Errorf("%s matches no committed dataset", g)
			}
			for _, f := range files {
				if strings.HasSuffix(f, ".meta.json") {
					continue
				}
				checked++
				if !strings.HasSuffix(f, ".next.json") {
					current++
				}
				if repeats := repeatedKeys(t, f, set.key); len(repeats) > 0 {
					t.Errorf("%s: %d %ss carried by more than one row: %s",
						filepath.Base(f), len(repeats), set.key, strings.Join(first(repeats, 8), ", "))
				}
			}
		}
	}
	// 71 current-slot files on 2026-09-28. The pre-release pairs are not
	// counted, their number moving with the AIRAC calendar: a build that
	// writes the current slot deletes the pair it caught up with
	// (pruneSupersededNext), and 41 of the 112 files that day were one.
	// Well under the current count is a glob matching less, or a data
	// directory gone missing.
	if current < 60 {
		t.Errorf("checked %d current-slot datasets (%d with the pre-releases), want at least 60: the globs no longer match what is committed", current, checked)
	}
}

func repeatedKeys(t *testing.T, path, key string) []string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Fields []string `json:"fields"`
		Rows   [][]any  `json:"rows"`
	}
	if err := json.Unmarshal(b, &doc); err != nil {
		t.Fatalf("%s: %v", path, err)
	}
	col := slices.Index(doc.Fields, key)
	if col < 0 {
		t.Fatalf("%s: no %s column in %v", path, key, doc.Fields)
	}
	seen := map[string]int{}
	var repeats []string
	for _, r := range doc.Rows {
		if col >= len(r) {
			continue
		}
		k := fmt.Sprint(r[col])
		seen[k]++
		if seen[k] == 2 {
			repeats = append(repeats, k)
		}
	}
	return repeats
}

func first(s []string, n int) []string {
	if len(s) > n {
		return append(s[:n:n], "...")
	}
	return s
}
