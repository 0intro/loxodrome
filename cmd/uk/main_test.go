package main

import "testing"

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
