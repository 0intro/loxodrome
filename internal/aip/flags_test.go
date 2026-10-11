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
