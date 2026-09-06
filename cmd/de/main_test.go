package main

import (
	"testing"
)

func TestEffectiveFromName(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		// DFS: ED_<Feature>_<published>_<effective>_revision.xml; the
		// effective date is the second (last) ISO date.
		{"ED_Airspace_StrokedBorders_2026-06-11_2026-07-09_revision.xml", "2026-07-09T00:00:00.000Z"},
		{"local/de/ED_Obstacles_Area_1_2026-06-11_2026-07-09_revision.xml", "2026-07-09T00:00:00.000Z"},
		{"ED_Navaids_2025-12-25_2026-01-22_revision.xml", "2026-01-22T00:00:00.000Z"},
		{"no-date-here.xml", ""},
	}
	for _, c := range cases {
		if got := effectiveFromName(c.in); got != c.want {
			t.Errorf("effectiveFromName(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestNormaliseEffective(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"20260709", "2026-07-09T00:00:00.000Z"}, // DFS AmdtNumeric
		{"2026-07-09", "2026-07-09T00:00:00.000Z"},
		{"  20260709  ", "2026-07-09T00:00:00.000Z"},
		{"", ""},
		{"2026-07-09T12:00:00Z", "2026-07-09T12:00:00Z"}, // already a timestamp: passthrough
	}
	for _, c := range cases {
		if got := normaliseEffective(c.in); got != c.want {
			t.Errorf("normaliseEffective(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestDeCountryFromIcao(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"EDDF", "DE"}, // civil
		{"EDDM", "DE"},
		{"ETNS", "DE"}, // military family
		{"ET", "DE"},
		{"E", "DE"}, // too short: default DE (German AIP dataset)
		{"", "DE"},
	}
	for _, c := range cases {
		if got := deCountryFromIcao(c.in); got != c.want {
			t.Errorf("deCountryFromIcao(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
