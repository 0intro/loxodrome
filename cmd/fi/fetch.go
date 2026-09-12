// fetch.go locates the Area 1 archives on the Fintraffic ANS obstacle
// index and downloads the one the run asked for.
//
// The index lists every obstacle product the AIS publishes: the Area 1
// set for the whole territory, the per-aerodrome OLS and Area 4 sets, and
// a CHG_ delta beside each. Only Area 1 is taken (docs/fi-aip.md), and
// only the full file, never the delta.
//
// The publication directory and the effective date are independent: the
// August 2026 cycle sits under 2026-06, the September one under 2026-07.
// Neither is derivable from the other, so the index is read rather than
// a path guessed.

package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/overlay"
)

const (
	// indexURL redirects to the AIS site's obstacle-data page.
	indexURL = "https://www.ais.fi/ais/aipobst/aipobst.htm"
	// siteBase resolves the index's root-relative hrefs.
	siteBase = "https://www.ais.fi"
)

// release is one published Area 1 archive.
type release struct {
	URL  string
	Name string
	// Effective is the AIRAC effective date the filename states, as the
	// RFC3339 stamp the meta sidecar and the slot resolver read.
	Effective string
	// day is the same date parsed, for choosing between releases.
	day time.Time
}

// releaseRe matches an Area 1 archive link on the index.
//
// The leading slash is what excludes the CHG_ deltas: their filename
// follows "…/CHG_ef_efin…", so no path separator immediately precedes
// the ef_efin prefix and the pattern cannot match them. The month is
// matched case-insensitively because the publisher writes both
// "06_aug_2026" and "16_APR_2026".
var releaseRe = regexp.MustCompile(
	`(?i)"(/sites/default/files/[^"]*/(ef_efin_area1_obstdata_(\d{2})_([a-z]{3})_(\d{4})\.zip))"`)

// findReleases reads every Area 1 archive off the index page, newest
// first.
func findReleases(page []byte) ([]release, error) {
	var out []release
	seen := map[string]bool{}
	for _, m := range releaseRe.FindAllStringSubmatch(string(page), -1) {
		if seen[m[1]] {
			continue
		}
		seen[m[1]] = true
		day, ok := parseFileDate(m[3], m[4], m[5])
		if !ok {
			continue
		}
		out = append(out, release{
			URL:       siteBase + m[1],
			Name:      m[2],
			Effective: day.Format("2006-01-02") + "T00:00:00.000Z",
			day:       day,
		})
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("no Area 1 archives on %s (index layout may have changed)", indexURL)
	}
	// Newest first, so picking a slot is a scan from the front.
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].day.After(out[j-1].day); j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out, nil
}

// resolveRelease picks the archive the target asks for: the pre-release
// for "next", the cycle in force otherwise. A nil release with no error
// means "next" was asked for and none is posted yet.
func resolveRelease(ctx context.Context, target string, now time.Time) (*release, error) {
	page, err := overlay.HTTPGetAll(ctx, indexURL)
	if err != nil {
		return nil, fmt.Errorf("obstacle index: %w", err)
	}
	rels, err := findReleases(page)
	if err != nil {
		return nil, err
	}
	return pickRelease(rels, target, now)
}

// pickRelease is resolveRelease's choice, split out so it is testable
// without the network.
//
// The two slots are read from opposite ends of the newest-first list. The
// cycle in force is the newest release at or before today, so the first
// non-future entry wins. The pre-release is the NEAREST future one, which
// is the LAST future entry, not the first: Fintraffic posts several cycles
// at once (06 Aug, 03 Sep and 01 Oct were all listed on 21 August 2026),
// and taking the first would slot the furthest-out edition and leave the
// cycle in between unpublished, the app serving August obstacles through
// the whole of September.
func pickRelease(rels []release, target string, now time.Time) (*release, error) {
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	if target == "next" {
		var pick *release
		for i := range rels {
			if rels[i].day.After(today) {
				pick = &rels[i]
			}
		}
		// A pre-release nobody has posted yet is normal, not an error.
		return pick, nil
	}
	for i := range rels {
		if !rels[i].day.After(today) {
			return &rels[i], nil
		}
	}
	return nil, fmt.Errorf("no Area 1 archive effective on or before %s", today.Format("2006-01-02"))
}

// months maps the filename's three-letter month, which the publisher
// writes in either case. time.Parse would need one canonical spelling,
// and a table says what is accepted more plainly than a normalisation
// step would.
var months = map[string]time.Month{
	"jan": time.January, "feb": time.February, "mar": time.March,
	"apr": time.April, "may": time.May, "jun": time.June,
	"jul": time.July, "aug": time.August, "sep": time.September,
	"oct": time.October, "nov": time.November, "dec": time.December,
}

// parseFileDate turns the filename's dd_mmm_yyyy into a UTC date.
func parseFileDate(dd, mmm, yyyy string) (time.Time, bool) {
	mon, ok := months[strings.ToLower(mmm)]
	if !ok {
		return time.Time{}, false
	}
	var d, y int
	if _, err := fmt.Sscanf(dd, "%d", &d); err != nil || d < 1 || d > 31 {
		return time.Time{}, false
	}
	if _, err := fmt.Sscanf(yyyy, "%d", &y); err != nil {
		return time.Time{}, false
	}
	return time.Date(y, mon, d, 0, 0, 0, 0, time.UTC), true
}

// effectiveFromName reads the effective date off a local -in filename,
// so an offline replay stamps the same date the fetch would have.
func effectiveFromName(name string) string {
	m := releaseNameRe.FindStringSubmatch(name)
	if m == nil {
		return ""
	}
	day, ok := parseFileDate(m[1], m[2], m[3])
	if !ok {
		return ""
	}
	return day.Format("2006-01-02") + "T00:00:00.000Z"
}

// releaseNameRe matches the bare filename, with or without the CHG_
// prefix: a local file is whatever the operator hands us.
var releaseNameRe = regexp.MustCompile(`(?i)_(\d{2})_([a-z]{3})_(\d{4})\.(?:zip|csv)$`)

// download fetches the archive, optionally keeping a copy for replay.
func download(ctx context.Context, url, keepPath string) ([]byte, error) {
	body, err := overlay.HTTPGetAll(ctx, url)
	if err != nil {
		return nil, fmt.Errorf("obstacle data set: %w", err)
	}
	if keepPath != "" {
		if err := os.MkdirAll(filepath.Dir(keepPath), 0o755); err != nil {
			return nil, err
		}
		if err := os.WriteFile(keepPath, body, 0o644); err != nil {
			return nil, err
		}
	}
	return body, nil
}
