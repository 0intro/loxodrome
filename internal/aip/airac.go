package aip

import (
	"fmt"
	"strings"
	"time"
)

// AIRAC cycle arithmetic, mirroring src/lib/data/airac.ts (the app builds
// its SIA / NATS chart links from the same 28-day grid, so the Go side must
// agree with it to the day). Anchor: cycle 2401, effective 25 January 2024.
var airacEpoch = time.Date(2024, time.January, 25, 0, 0, 0, 0, time.UTC)

// airacPeriod is the worldwide AIRAC interval.
const airacPeriod = 28 * 24 * time.Hour

// CurrentAirac returns the effective date (UTC midnight) of the AIRAC
// cycle in force at now.
func CurrentAirac(now time.Time) time.Time {
	elapsed := now.UTC().Sub(airacEpoch)
	cycles := elapsed / airacPeriod
	if elapsed < 0 && elapsed%airacPeriod != 0 {
		cycles--
	}
	return airacEpoch.Add(cycles * airacPeriod)
}

// NextAirac returns the effective date of the cycle following
// CurrentAirac(now).
func NextAirac(now time.Time) time.Time {
	return CurrentAirac(now).Add(airacPeriod)
}

// EAIPDateSegment formats an AIRAC effective date as the SIA eAIP dated
// path segment, e.g. "09_JUL_2026" (upper-case English month; Go's
// reference-time month names are locale-independent).
func EAIPDateSegment(t time.Time) string {
	return strings.ToUpper(t.UTC().Format("02_Jan_2006"))
}

// AiracISO formats an AIRAC effective date as YYYY-MM-DD, the form the
// eAIP "AIRAC-" path segment and the dataset metas use.
func AiracISO(t time.Time) string {
	return t.UTC().Format("2006-01-02")
}

// AiracYYNN returns the ICAO four-digit YYNN cycle label for the AIRAC
// cycle in force at t (e.g. "2607"), mirroring airacYYNN in
// src/lib/data/airac.ts. The FAA d-TPP terminal-procedure cycle uses the
// same numbering, so this builds its path segment. 13 cycles per year
// holds for 2024..2030.
func AiracYYNN(t time.Time) string {
	elapsed := t.UTC().Sub(airacEpoch)
	idx := int(elapsed / airacPeriod)
	if elapsed < 0 && elapsed%airacPeriod != 0 {
		idx--
	}
	y := 2024
	for idx >= 13 {
		idx -= 13
		y++
	}
	for idx < 0 {
		idx += 13
		y--
	}
	return fmt.Sprintf("%02d%02d", y%100, idx+1)
}
