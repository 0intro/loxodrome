package aip

import (
	"testing"
	"time"
)

func TestResolveTarget(t *testing.T) {
	now := time.Date(2026, 5, 22, 12, 0, 0, 0, time.UTC)

	cases := []struct {
		name      string
		target    string
		effective string
		wantNext  bool
		wantErr   bool
	}{
		{"explicit current overrides future effective", "current", "2099-01-01T00:00:00.000Z", false, false},
		{"explicit next overrides past effective", "next", "2020-01-01T00:00:00.000Z", true, false},
		{"auto: empty effective stays current", "auto", "", false, false},
		{"auto: future effective routes to next", "auto", "2026-06-11T00:00:00.000+02:00", true, false},
		{"auto: past effective routes to current", "auto", "2026-05-14T00:00:00.000+02:00", false, false},
		{"auto: exactly now routes to current (not After)", "auto", now.Format(time.RFC3339Nano), false, false},
		{"auto: bare-date future effective routes to next (XML_SIA form)", "auto", "2026-08-06", true, false},
		{"auto: bare-date past effective routes to current", "auto", "2026-05-14", false, false},
		{"auto: unparseable effective is an error", "auto", "not-a-date", false, true},
		{"unknown target", "tomorrow", "2026-05-14T00:00:00.000+02:00", false, true},
	}
	for _, c := range cases {
		got, err := ResolveTarget(c.target, c.effective, now)
		if c.wantErr {
			if err == nil {
				t.Errorf("%s: got nil error, want one", c.name)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: %v", c.name, err)
			continue
		}
		if got != c.wantNext {
			t.Errorf("%s: got useNext=%v, want %v", c.name, got, c.wantNext)
		}
	}
}

func TestResolveTargetAutoOffsetBoundary(t *testing.T) {
	// The SIA stamps AIRAC effectives at local midnight ("+02:00"), an
	// instant of 22:00Z the EVENING BEFORE the cycle date. "auto" must
	// compare on the stamp's own calendar date at UTC midnight, so the
	// cycle stays in the .next slot until the AIRAC date itself instead
	// of landing in the current slot at 22:00Z the eve.
	eff := "2026-08-06T00:00:00.000+02:00"

	cases := []struct {
		name     string
		now      time.Time
		wantNext bool
	}{
		{
			// Past the raw-parse instant (22:00Z) but still the eve of the
			// AIRAC date: must stay .next (the raw comparison said current).
			"eve of the cycle date, after the raw 22:00Z instant",
			time.Date(2026, 8, 5, 23, 0, 0, 0, time.UTC),
			true,
		},
		{
			// UTC midnight of the calendar date: effective now (not After).
			"UTC midnight of the AIRAC date routes to current",
			time.Date(2026, 8, 6, 0, 0, 0, 0, time.UTC),
			false,
		},
	}
	for _, c := range cases {
		got, err := ResolveTarget("auto", eff, c.now)
		if err != nil {
			t.Errorf("%s: %v", c.name, err)
			continue
		}
		if got != c.wantNext {
			t.Errorf("%s: got useNext=%v, want %v", c.name, got, c.wantNext)
		}
	}
}
