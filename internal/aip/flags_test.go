package aip

import "testing"

func TestDatasetFilter(t *testing.T) {
	all := DatasetFilter("")
	for _, n := range []string{"airports", "airspaces", "anything"} {
		if !all(n) {
			t.Errorf("empty -only filter rejected %q, want accept-all", n)
		}
	}

	// Whitespace around and between names is tolerated; matching is
	// case-insensitive both ways.
	f := DatasetFilter("  airports , Navaids ")
	cases := map[string]bool{
		"airports":  true,
		"navaids":   true,
		"AIRPORTS":  true,
		"Navaids":   true,
		"airspaces": false,
		"obstacles": false,
	}
	for name, want := range cases {
		if got := f(name); got != want {
			t.Errorf("DatasetFilter(...)(%q) = %v, want %v", name, got, want)
		}
	}
}

// A run cut down by -only is a debugging aid. Written into public/data it
// replaces the whole dataset with the few rows it kept, and a commit of
// the working tree ships them.
func TestPartialOutRefusesPublicData(t *testing.T) {
	scratch := t.TempDir()
	cases := []struct {
		only, out string
		refused   bool
	}{
		{"EGLL,EGLW", "public/data", true},
		{"LFPL", "./public/data/", true},
		{"LFPL", scratch, false},
		{"", "public/data", false},
		{"  ", "public/data", false},
	}
	for _, c := range cases {
		err := PartialOut(c.only, c.out)
		if (err != nil) != c.refused {
			t.Errorf("PartialOut(%q, %q) = %v, want refused %v", c.only, c.out, err, c.refused)
		}
	}
}
