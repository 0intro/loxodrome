// datum.go gives the WFS's bare limits back the datum the AIP states.
//
// LFV's WFS carries a limit as a bare number of feet, and nearly every one
// is ft AMSL, which is how AIP Sweden writes them. Three are not: the floors
// of ES R129 and ES R130 are "400 ft SFC", and the HEMAVAN TIA/RMZ starts
// at "1000 ft GND" (AIRAC 2609). Read as AMSL, the Hemavan TIA would start
// below mountains well over 1000 ft high. The eAIP (IDS AIRNAV, no copyright
// clause) prints the datum in the zone's own table row, so the row naming the
// zone and printing the same figure with SFC, GND or AGL settles it.

package main

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/eaip"
)

// seEAIP is AIP Sweden's eAIP package, located through its own history page.
var seEAIP = eaip.Site{
	Country: "ES",
	Family:  eaip.IDS,
	Base:    "https://aro.lfv.se/content/eaip",
	Index:   "https://aro.lfv.se/content/eaip/default_offline.html",
	Lang:    "en-GB",
	Header:  eaip.BrowserHeaders,
}

// eaipSections carry every limit the airspace typenames draw from.
var eaipSections = []string{"ENR 2.1", "ENR 2.2", "ENR 5.1", "ENR 5.2", "ENR 5.3", "ENR 5.5"}

// datumHints are the eAIP's table rows that print a limit with a surface
// datum, as their visible text.
type datumHints struct {
	rows []string
}

// surfaceDatumRe finds a limit written against the surface.
var surfaceDatumRe = regexp.MustCompile(`(?i)\b(\d[\d ]*?)\s*FT\s*(SFC|GND|AGL|ASFC)\b`)

// loadDatumHints reads the eAIP's airspace sections and keeps the rows that
// state a surface datum. The package is resolved like any cohort State's, so
// a moved package fails here rather than silently reading nothing.
func loadDatumHints(ctx context.Context, now time.Time) (*datumHints, string, error) {
	cyc, err := seEAIP.Resolve(ctx, eaipSections[0], now, false)
	if err != nil {
		return nil, "", fmt.Errorf("AIP Sweden eAIP: %w", err)
	}
	h := &datumHints{}
	for _, section := range eaipSections {
		body, err := seEAIP.Get(ctx, seEAIP.PageURL(cyc, section))
		if err != nil {
			return nil, "", fmt.Errorf("AIP Sweden %s: %w", section, err)
		}
		doc, err := eaip.ParseHTML(body)
		if err != nil {
			return nil, "", fmt.Errorf("AIP Sweden %s: %w", section, err)
		}
		for _, table := range eaip.Elems(doc, "table") {
			for _, row := range eaip.ExpandTable(table) {
				text := strings.ToUpper(eaip.NormSpace(strings.Join(row, " ")))
				if surfaceDatumRe.MatchString(text) {
					h.rows = append(h.rows, text)
				}
			}
		}
	}
	return h, cyc.Dir, nil
}

// surface reports whether the eAIP row naming the zone prints this limit
// against the surface. The zone is found by its name's words in order,
// whatever separates them ("ES R129" is "ESR129 HELSINGBORG" in the AIP),
// and only as whole words, so ES R12 never answers for ES R129.
func (h *datumHints) surface(name, value string) bool {
	if h == nil || name == "" {
		return false
	}
	re := nameRe(name)
	if re == nil {
		return false
	}
	for _, row := range h.rows {
		if !re.MatchString(row) {
			continue
		}
		for _, m := range surfaceDatumRe.FindAllStringSubmatch(row, -1) {
			if strings.ReplaceAll(m[1], " ", "") == value {
				return true
			}
		}
	}
	return false
}

// tokenRe splits a name into its letter and digit runs.
var tokenRe = regexp.MustCompile(`[A-ZÅÄÖ]+|\d+`)

// nameRe matches a name's letter and digit runs in order, as whole words,
// with any separator (or none) between them.
func nameRe(name string) *regexp.Regexp {
	toks := tokenRe.FindAllString(strings.ToUpper(name), -1)
	if len(toks) == 0 {
		return nil
	}
	for i, t := range toks {
		toks[i] = regexp.QuoteMeta(t)
	}
	return regexp.MustCompile(`(?:^|[^A-Z0-9ÅÄÖ])` + strings.Join(toks, `[^A-Z0-9ÅÄÖ]*`) + `(?:[^A-Z0-9ÅÄÖ]|$)`)
}
