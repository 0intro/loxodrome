package aip

import (
	"testing"
	"time"
)

// The pins mirror tests/airportCharts.spec.ts: 2026-06-07 falls inside the
// cycle effective 2026-05-14; 2026-06-11 opens the next cycle.
func TestCurrentAirac(t *testing.T) {
	cases := []struct {
		now, want string
	}{
		{"2026-06-07", "2026-05-14"},
		{"2026-05-14", "2026-05-14"},
		{"2026-06-10", "2026-05-14"},
		{"2026-06-11", "2026-06-11"},
		{"2024-01-25", "2024-01-25"},
		{"2026-07-21", "2026-07-09"},
	}
	for _, c := range cases {
		now, err := time.Parse("2006-01-02", c.now)
		if err != nil {
			t.Fatal(err)
		}
		if got := AiracISO(CurrentAirac(now)); got != c.want {
			t.Errorf("CurrentAirac(%s) = %s, want %s", c.now, got, c.want)
		}
	}
}

func TestNextAirac(t *testing.T) {
	now := time.Date(2026, time.July, 21, 12, 0, 0, 0, time.UTC)
	if got := AiracISO(NextAirac(now)); got != "2026-08-06" {
		t.Errorf("NextAirac = %s, want 2026-08-06", got)
	}
}

func TestEAIPDateSegment(t *testing.T) {
	eff := CurrentAirac(time.Date(2026, time.June, 7, 0, 0, 0, 0, time.UTC))
	if got := EAIPDateSegment(eff); got != "14_MAY_2026" {
		t.Errorf("EAIPDateSegment = %s, want 14_MAY_2026", got)
	}
}
