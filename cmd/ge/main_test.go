package main

import (
	"slices"
	"testing"
	"time"
)

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

func TestParseDataSets(t *testing.T) {
	// The page as Sakaeronavigatsia lists it once a pre-release is posted:
	// the next edition first, the one in force after it, and the obstacle
	// product beside them, which must not be picked.
	page := `<a class="dl" href="/storage/files/misc/UG_AIP_DS_20261126_AIRAC.zip">Download</a>` +
		`<a class="dl" href="/storage/files/misc/UG_AIP_DS_20260709_AIRAC.zip">Download</a>` +
		`<a href="/storage/files/misc/UG_OBS_DS_20260709_AIRAC.zip">obstacles</a>` +
		`<a class="dl" href="/storage/files/misc/UG_AIP_DS_20260709_AIRAC.zip">again</a>`
	sets := parseDataSets([]byte(page))
	if len(sets) != 2 {
		t.Fatalf("got %d data sets, want 2: %+v", len(sets), sets)
	}
	if sets[0].href != aisOrigin+"/storage/files/misc/UG_AIP_DS_20261126_AIRAC.zip" ||
		sets[1].href != aisOrigin+"/storage/files/misc/UG_AIP_DS_20260709_AIRAC.zip" {
		t.Errorf("hrefs %q, %q", sets[0].href, sets[1].href)
	}
	if got := sets[1].date.Format("2006-01-02"); got != "2026-07-09" {
		t.Errorf("date %s", got)
	}
}

func TestPickEditions(t *testing.T) {
	day := func(s string) time.Time {
		d, err := time.Parse("2006-01-02", s)
		if err != nil {
			t.Fatal(err)
		}
		return d
	}
	set := func(dates ...string) []dataSet {
		var out []dataSet
		for _, d := range dates {
			out = append(out, dataSet{href: d, date: day(d)})
		}
		return out
	}
	names := func(sets []dataSet) []string {
		var out []string
		for _, s := range sets {
			out = append(out, s.href)
		}
		return out
	}
	now := time.Date(2026, 10, 2, 15, 0, 0, 0, time.UTC)
	for _, c := range []struct {
		name string
		sets []dataSet
		want []string
	}{
		{"pre-release listed first", set("2026-11-26", "2026-07-09"), []string{"2026-07-09", "2026-11-26"}},
		{"one edition in force", set("2026-07-09"), []string{"2026-07-09"}},
		{"an older edition is skipped", set("2026-06-11", "2026-07-09", "2026-11-26"), []string{"2026-07-09", "2026-11-26"}},
		{"the soonest pre-release only", set("2026-12-24", "2026-11-26", "2026-07-09"), []string{"2026-07-09", "2026-11-26"}},
		{"today is in force", set("2026-10-02"), []string{"2026-10-02"}},
		{"nothing in force yet", set("2026-11-26"), []string{"2026-11-26"}},
	} {
		if got := names(pickEditions(c.sets, now)); !slices.Equal(got, c.want) {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}
