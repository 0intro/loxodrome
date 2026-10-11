// fetch.go discovers and downloads the Georgian AIP Data Sets.
//
// The discovery is a scrape of the AIS page for the .zip links rather than
// a date-derived URL: the filename carries the AIRAC date and would have
// to be guessed otherwise, and a guess that missed would fetch nothing
// rather than fail loudly. The page lists the edition in force and, once
// Sakaeronavigatsia posts it, the next one beside it, the pre-release
// FIRST (2026-10-02: 20261126 above 20260709), so taking the first link
// stopped the cycle in force from ever being rebuilt.

package main

import (
	"context"
	"fmt"
	"os"
	"path"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/aixm5build"
	"github.com/0intro/loxodrome/internal/overlay"
)

const (
	aisPageURL = "https://ais.airnav.ge/en/aip-dataset"
	aisOrigin  = "https://ais.airnav.ge"

	defaultMinGeAirspaces  = 5
	defaultMaxGeAirspaces  = 2000
	defaultMaxGeObstacles  = 20000
	defaultMaxGeAirports   = 200
	defaultMinGeAerodromes = 1
	defaultMaxGeAerodromes = 200
)

// geCountryFromIcao maps the Georgian ICAO prefix to ISO-3166. UG is the
// Georgian family; the AIP publishes only Georgian aerodromes.
var geCountryFromIcao = aixm5build.IcaoCountry(map[string]string{
	"UG": "GE",
}, "GE")

// dataSetHrefRe finds the AIP Data Set links on the AIS page. The name
// shape is fixed (UG_AIP_DS_<date>_AIRAC.zip); other products on the same
// page (obstacles, FPD, terrain) carry their own names, so anchoring on
// the AIP one keeps the discovery unambiguous.
var dataSetHrefRe = regexp.MustCompile(`href="([^"]*UG_AIP_DS_(\d{8})_AIRAC\.zip)"`)

// dataSet is one edition the AIS page links.
type dataSet struct {
	href string
	date time.Time // the AIRAC date the name carries
}

// listDataSets reads every AIP Data Set link off the AIS page, absolute
// and once each.
func listDataSets(ctx context.Context) ([]dataSet, error) {
	page, err := overlay.HTTPGetAll(ctx, aisPageURL)
	if err != nil {
		return nil, fmt.Errorf("AIS page: %w", err)
	}
	sets := parseDataSets(page)
	if len(sets) == 0 {
		return nil, fmt.Errorf("no UG_AIP_DS_*.zip link on %s; the AIS page layout may have changed", aisPageURL)
	}
	return sets, nil
}

// parseDataSets is listDataSets' page scrape.
func parseDataSets(page []byte) []dataSet {
	var sets []dataSet
	seen := map[string]bool{}
	for _, m := range dataSetHrefRe.FindAllSubmatch(page, -1) {
		href := string(m[1])
		if strings.HasPrefix(href, "/") {
			href = aisOrigin + href
		}
		d, err := time.Parse("20060102", string(m[2]))
		if err != nil || seen[href] {
			continue
		}
		seen[href] = true
		sets = append(sets, dataSet{href: href, date: d})
	}
	return sets
}

// pickEditions chooses what to build and in which order: the newest edition
// at or before today is the cycle in force, the first after it the
// pre-release (the .next slot takes the soonest future edition, never a
// later one), current first so that writing it retires a pre-release it
// has caught up with. Editions older than the one in force are skipped.
// Every edition still ahead means the page carries no cycle in force yet:
// the soonest one is built, filed by its own date.
func pickEditions(sets []dataSet, now time.Time) []dataSet {
	sorted := append([]dataSet(nil), sets...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].date.Before(sorted[j].date) })
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	var cur, next *dataSet
	for i := range sorted {
		if !sorted[i].date.After(today) {
			cur = &sorted[i]
		} else if next == nil {
			next = &sorted[i]
		}
	}
	var out []dataSet
	if cur != nil {
		out = append(out, *cur)
	}
	if next != nil {
		out = append(out, *next)
	}
	return out
}

// fetchDataSet downloads one data set and returns its AIXM document. When
// snapshotDir is set the raw zip is written there too, so a run can be
// replayed offline with -in.
func fetchDataSet(ctx context.Context, href, snapshotDir string) ([]byte, string, error) {
	zipBytes, err := overlay.HTTPGetAll(ctx, href)
	if err != nil {
		return nil, "", fmt.Errorf("data set %s: %w", href, err)
	}
	zipName := path.Base(href)

	if snapshotDir != "" {
		if err := os.MkdirAll(snapshotDir, 0o755); err != nil {
			return nil, "", err
		}
		if err := os.WriteFile(path.Join(snapshotDir, zipName), zipBytes, 0o644); err != nil {
			return nil, "", err
		}
	}

	// aip.ReadLargestXML wants a path; the zip is already in hand, so go
	// through a temporary file rather than duplicating its member walk.
	tmp, err := os.CreateTemp("", "ge-aip-*.zip")
	if err != nil {
		return nil, "", err
	}
	defer func() {
		_ = os.Remove(tmp.Name())
	}()
	if _, err := tmp.Write(zipBytes); err != nil {
		_ = tmp.Close()
		return nil, "", err
	}
	if err := tmp.Close(); err != nil {
		return nil, "", err
	}
	src, inner, err := aip.ReadLargestXML(tmp.Name())
	if err != nil {
		return nil, "", fmt.Errorf("%s: %w", zipName, err)
	}
	// Report the member name, which carries the AIRAC date.
	return src, inner, nil
}
