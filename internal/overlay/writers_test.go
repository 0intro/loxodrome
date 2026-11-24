package overlay

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"testing"
)

// TestWritersReplaceTheFile pins that a dataset is written beside its name
// and renamed over it. A run that dies while writing then leaves the
// committed file whole: fr-supaip.json is the durable record of every
// lapsed supplement, and the next run would rebuild a cut one from the
// listing alone.
func TestWritersReplaceTheFile(t *testing.T) {
	for name, write := range map[string]func(string, any) error{
		"WriteCompactJSON": WriteCompactJSON,
		"WritePrettyJSON":  WritePrettyJSON,
	} {
		dir := t.TempDir()
		path := filepath.Join(dir, "fr-supaip.json")
		if err := os.WriteFile(path, []byte(`{"old":true}`), 0o644); err != nil {
			t.Fatal(err)
		}
		before, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		old, err := os.Open(path)
		if err != nil {
			t.Fatal(err)
		}
		if err := write(path, map[string]bool{"new": true}); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		// A descriptor opened before the write still reads the old file:
		// the new one took its name, and the old bytes were never cut.
		b, err := io.ReadAll(old)
		old.Close()
		if err != nil || string(b) != `{"old":true}` {
			t.Errorf("%s: the old file reads %q, %v: it was rewritten in place", name, b, err)
		}
		var got map[string]bool
		b, err = os.ReadFile(path)
		if err != nil || json.Unmarshal(b, &got) != nil || !got["new"] {
			t.Errorf("%s: %s holds %q, %v", name, path, b, err)
		}
		if after, err := os.Stat(path); err != nil || after.Mode().Perm() != before.Mode().Perm() {
			t.Errorf("%s: mode %v, %v, want %v", name, after.Mode().Perm(), err, before.Mode().Perm())
		}
		if ents, err := os.ReadDir(dir); err != nil || len(ents) != 1 {
			t.Errorf("%s: %d files beside the dataset, %v, want none", name, len(ents)-1, err)
		}
	}
}
