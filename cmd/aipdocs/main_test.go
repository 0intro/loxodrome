package main

import (
	"os"
	"path/filepath"
	"testing"
)

// A pruned auto build keeps the cached plates of the cycles it built and
// removes the others, so the scheduled build's cache holds the cycles in
// use rather than one more every AIRAC. Without -prune every cycle stays,
// and a single-slot build refuses -prune: it would drop the plates of the
// slot it skipped.
func TestRunPrunesOtherCycles(t *testing.T) {
	cases := []struct {
		target  string
		prune   bool
		wantErr bool
		kept    map[string]bool
	}{
		{"auto", true, false, map[string]bool{"29_OCT_2026": true, "26_NOV_2026": true, "01_OCT_2026": false}},
		{"auto", false, false, map[string]bool{"29_OCT_2026": true, "26_NOV_2026": true, "01_OCT_2026": true}},
		{"current", true, true, map[string]bool{"29_OCT_2026": true, "26_NOV_2026": true, "01_OCT_2026": true}},
	}
	for _, c := range cases {
		data, out, cache := t.TempDir(), t.TempDir(), t.TempDir()
		rows := `{"fields":["icao","charts","vac"],"rows":[["LFPN",[],"ad"]]}`
		writeFile(t, filepath.Join(data, "fr-adcharts.json"), rows)
		writeFile(t, filepath.Join(data, "fr-adcharts.meta.json"), `{"effective":"2026-10-29"}`)
		writeFile(t, filepath.Join(data, "fr-adcharts.next.json"), rows)
		writeFile(t, filepath.Join(data, "fr-adcharts.next.meta.json"), `{"effective":"2026-11-26"}`)
		// Every plate is cached already, so the build fetches nothing.
		for cycle := range c.kept {
			writeFile(t, filepath.Join(cache, "vac", cycle, "AD-2.LFPN.pdf"), "%PDF-1.4\n")
		}

		err := run("vac", "fr", c.target, data, out, cache, 1, 0, c.prune)
		if (err != nil) != c.wantErr {
			t.Errorf("run(-target %s, -prune=%v) error = %v, want error %v", c.target, c.prune, err, c.wantErr)
		}
		for cycle, want := range c.kept {
			_, err := os.Stat(filepath.Join(cache, "vac", cycle))
			if got := err == nil; got != want {
				t.Errorf("run(-target %s, -prune=%v): vac/%s kept = %v, want %v", c.target, c.prune, cycle, got, want)
			}
		}
	}
}

func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}
