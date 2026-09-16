package main

import "testing"

func TestEffectiveFromName(t *testing.T) {
	cases := []struct{ in, want string }{
		{"UG_AIP_DS_FULL_20260709_AIRAC.xml", "2026-07-09T00:00:00.000Z"},
		{"UG_AIP_DS_20260806_AIRAC.zip", "2026-08-06T00:00:00.000Z"},
		// No date in the name: the caller falls back to the dateStamp.
		{"dataset.xml", ""},
	}
	for _, c := range cases {
		if got := effectiveFromName(c.in); got != c.want {
			t.Errorf("effectiveFromName(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestGeCountryFromIcao(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"UGKO", "GE"},
		{"UGTB", "GE"},
		{"", "GE"},
	} {
		if got := geCountryFromIcao(c.in); got != c.want {
			t.Errorf("geCountryFromIcao(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestDataSetHrefRe(t *testing.T) {
	page := `<a class="dl" href="/storage/files/misc/UG_AIP_DS_20260709_AIRAC.zip">AIP data set</a>` +
		`<a href="/storage/files/misc/UG_OBS_DS_20260709_AIRAC.zip">obstacles</a>`
	m := dataSetHrefRe.FindSubmatch([]byte(page))
	if m == nil {
		t.Fatal("no match")
	}
	// The obstacle product sits on the same page and must not be picked.
	if got := string(m[1]); got != "/storage/files/misc/UG_AIP_DS_20260709_AIRAC.zip" {
		t.Errorf("matched %q", got)
	}
}
