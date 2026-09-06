// fetch.go discovers and downloads the current Georgian AIP Data Set.
//
// Sakaeronavigatsia lists exactly one data set on its AIS page, so the
// discovery is a scrape of that page for the .zip link rather than a
// date-derived URL: the filename carries the AIRAC date and would have
// to be guessed otherwise, and a guess that missed would fetch nothing
// rather than fail loudly.

package main

import (
	"context"
	"fmt"
	"os"
	"path"
	"regexp"
	"strings"

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

// dataSetHrefRe finds the AIP Data Set link on the AIS page. The name
// shape is fixed (UG_AIP_DS_<date>_AIRAC.zip); other products on the same
// page (obstacles, FPD, terrain) carry their own names, so anchoring on
// the AIP one keeps the discovery unambiguous.
var dataSetHrefRe = regexp.MustCompile(`href="([^"]*UG_AIP_DS_\d{8}_AIRAC\.zip)"`)

// fetchDataSet downloads the current data set and returns its AIXM
// document. When snapshotDir is set the raw zip is written there too, so
// a run can be replayed offline with -in.
func fetchDataSet(ctx context.Context, snapshotDir string) ([]byte, string, error) {
	page, err := overlay.HTTPGetAll(ctx, aisPageURL)
	if err != nil {
		return nil, "", fmt.Errorf("AIS page: %w", err)
	}
	m := dataSetHrefRe.FindSubmatch(page)
	if m == nil {
		return nil, "", fmt.Errorf("no UG_AIP_DS_*.zip link on %s; the AIS page layout may have changed", aisPageURL)
	}
	href := string(m[1])
	if strings.HasPrefix(href, "/") {
		href = aisOrigin + href
	}

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
