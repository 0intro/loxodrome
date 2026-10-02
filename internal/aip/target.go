// target.go resolves the -target flag (current / next / auto) plus the
// AIXM effective date into a boolean "use the .next slot" choice.

package aip

import (
	"fmt"
	"time"
)

// effectiveDay parses an AIRAC effective stamp to UTC midnight of its OWN
// calendar date, taken in the stamp's own zone. AIRAC effectives are
// calendar dates; the SIA stamps them at local midnight ("+02:00"), an
// instant of 22:00Z the EVE of the cycle date, so comparing the raw
// instant would move the cycle a cycle boundary two hours early. The AIXM
// root carries RFC3339-with-fraction and the XML_SIA export a bare
// calendar date ("2026-08-06"); accept both, like the app side's
// parseEffectiveMs.
func effectiveDay(effective string) (time.Time, error) {
	eff, err := time.Parse(time.RFC3339Nano, effective)
	if err != nil {
		eff, err = time.Parse("2006-01-02", effective)
	}
	if err != nil {
		return time.Time{}, fmt.Errorf("parse AIRAC effective %q: %w", effective, err)
	}
	y, m, d := eff.Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC), nil
}

// ResolveTarget maps the -target flag plus the AIXM effective date to a
// boolean "use the .next slot" choice. "auto" sends a future-dated cycle
// to the .next slot and an already-active cycle to the current slot. An
// empty effective string under "auto" always picks current (used when no
// AIXM is provided at all, e.g. OurAirports-only runs).
func ResolveTarget(target, effective string, now time.Time) (bool, error) {
	switch target {
	case "current":
		return false, nil
	case "next":
		return true, nil
	case "auto":
		if effective == "" {
			return false, nil
		}
		effDay, err := effectiveDay(effective)
		if err != nil {
			return false, err
		}
		return effDay.After(now), nil
	default:
		return false, fmt.Errorf(`-target must be one of "current", "next", "auto"; got %q`, target)
	}
}
