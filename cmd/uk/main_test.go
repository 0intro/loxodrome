package main

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEffectiveFromName(t *testing.T) {
	cases := []struct{ in, want string }{
		{"EG_AIP_DS_20260514_XML.zip", "2026-05-14T00:00:00.000Z"},
		{"local/EG_OBS_DS_AREA1_FULL_20260611_XML.zip", "2026-06-11T00:00:00.000Z"},
		{"renamed-by-user.zip", ""},
		{"", ""},
	}
	for _, c := range cases {
		if got := effectiveFromName(c.in); got != c.want {
			t.Errorf("effectiveFromName(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// TestRunRefusesAnEmptyDecode runs the command over an aerodrome's AIXM
// with no navaid in it: a NATS file whose navaids no longer decode wrote an
// empty uk-navaids.json, and the weekly refresh committed it.
func TestRunRefusesAnEmptyDecode(t *testing.T) {
	in := filepath.Join("testdata", "radio", "gatwick.xml")
	for _, only := range []string{"navaids", "airports"} {
		out := t.TempDir()
		err := run([]string{"-in", in, "-out", out, "-only", only})
		if err == nil || !strings.Contains(err.Error(), "outside sanity window") {
			t.Errorf("run -only=%s = %v, want a sanity window error", only, err)
		}
		if _, err := os.Stat(filepath.Join(out, "uk-"+only+".json")); !errors.Is(err, fs.ErrNotExist) {
			t.Errorf("run -only=%s wrote uk-%s.json (stat: %v)", only, only, err)
		}
	}
}
