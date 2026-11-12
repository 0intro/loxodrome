// fetch.go locates the obstacle registers on the IAA's obstacle page and
// downloads the ones a slot needs.
//
// The page lists two registers, each as one spreadsheet per AIRAC
// amendment, the edition in force beside the next once it is posted:
//
//	Area 1                          .../obstacles/area1/enr-5-4-airac-amendment-008-26-effective-aug-2026.xlsx
//	Safety Significant Obstacles    .../safety-significant-obstacles/safety-significant-obstacles-airac-amendment-008-26-effective-aug-2026.xlsx
//
// The amendment number counts the IAA's own AIRAC amendments, not the
// cycles ("011/26" is effective on 26 November, cycle 2612), and the name
// states the month and not the day. The AIRAC calendar gives the day,
// since a month holds one effective date, except the one month a year
// (October 2026: the 1st and the 29th) that holds two; the register's own
// change record names the edition then (register.go).

package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/overlay"
)

const (
	// pageURL is the IAA's obstacle page, the one Ireland's ENR 5.4 points
	// at (the address it names answers with a redirect here).
	pageURL = "https://www.iaa.ie/commercial-aviation/airspace/air-navigation-obstacles"
	// siteBase resolves a root-relative href.
	siteBase = "https://www.iaa.ie"
)

// header is sent with every request. The Azure Front Door in front of the
// site answers 403 to a request asking for "Accept-Encoding: gzip", which
// is what Go's transport (and Python's) adds on its own, while a browser's
// "gzip, deflate, br" and a plain "identity" pass (measured 2026-09-24,
// on the page and the spreadsheets alike). Asking for the file
// uncompressed is the one that pretends to be nothing; the spreadsheets
// are zips already. It also answers 403 to Go's own User-Agent
// ("Go-http-client/1.1") on the spreadsheets, whatever the encoding, while
// a client that names itself passes (measured 2026-10-02, when two runs in
// a row lost both registers to it), so the requests say who they are.
var header = map[string]string{
	"Accept-Encoding": "identity",
	"User-Agent":      "loxodrome-ie/1.0 (+https://loxodrome.fr)",
}

// forbiddenWait is how long a 403 is waited out before the next attempt,
// times the attempt. The site answers one now and then on a cache miss,
// the same request passing a minute later (measured 2026-09-24, while a
// burst of downloads ran): an origin limiter, not a refusal, so the run
// waits it out rather than failing the weekly refresh.
var forbiddenWait = 30 * time.Second

const forbiddenAttempts = 4

// get fetches a URL, waiting out the site's intermittent 403.
func get(ctx context.Context, u string) ([]byte, error) {
	for attempt := 1; ; attempt++ {
		body, err := overlay.HTTPGetAllWithHeaders(ctx, u, header)
		var se *overlay.StatusError
		if err == nil || !errors.As(err, &se) || se.Status != http.StatusForbidden || attempt == forbiddenAttempts {
			return body, err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(time.Duration(attempt) * forbiddenWait):
		}
	}
}

// list is one of the page's two registers.
type list int

const (
	area1 list = iota
	safetySignificant
)

// listRes match each list's files by the directory the IAA files them in.
var listRes = [...]*regexp.Regexp{
	area1:             regexp.MustCompile(`(?i)href="((?:https://www\.iaa\.ie)?/[^"]*/obstacles/area1/([^"/?]+\.xlsx)[^"]*)"`),
	safetySignificant: regexp.MustCompile(`(?i)href="((?:https://www\.iaa\.ie)?/[^"]*/safety-significant-obstacles/([^"/?]+\.xlsx)[^"]*)"`),
}

// release is one published spreadsheet.
type release struct {
	URL  string
	Name string
	// year and month are what the name states of the effective date.
	year  int
	month time.Month
	// Effective is the AIRAC date the file is in force from, fixed by
	// effectiveOf.
	Effective time.Time
	// body is the file, once downloaded.
	body []byte
}

// effectiveNameRe is the month and year a file name states.
var effectiveNameRe = regexp.MustCompile(`(?i)effective-([a-z]+)-(\d{4})`)

// months maps a month's first three letters, which is all the IAA's
// names are known to write.
var months = map[string]time.Month{
	"jan": time.January, "feb": time.February, "mar": time.March,
	"apr": time.April, "may": time.May, "jun": time.June,
	"jul": time.July, "aug": time.August, "sep": time.September,
	"oct": time.October, "nov": time.November, "dec": time.December,
}

// monthOf reads the effective month off a file name.
func monthOf(name string) (int, time.Month, bool) {
	m := effectiveNameRe.FindStringSubmatch(name)
	if m == nil || len(m[1]) < 3 {
		return 0, 0, false
	}
	mon, ok := months[strings.ToLower(m[1][:3])]
	if !ok {
		return 0, 0, false
	}
	var y int
	if _, err := fmt.Sscanf(m[2], "%d", &y); err != nil {
		return 0, 0, false
	}
	return y, mon, true
}

// findReleases reads one list's files off the page.
func findReleases(page []byte, l list) []release {
	var out []release
	seen := map[string]bool{}
	for _, m := range listRes[l].FindAllStringSubmatch(string(page), -1) {
		u := m[1]
		if strings.HasPrefix(u, "/") {
			u = siteBase + u
		}
		if seen[m[2]] {
			continue
		}
		seen[m[2]] = true
		y, mon, ok := monthOf(m[2])
		if !ok {
			continue
		}
		out = append(out, release{URL: u, Name: m[2], year: y, month: mon})
	}
	return out
}

// airacDays lists the AIRAC effective dates falling in a month.
func airacDays(y int, mon time.Month) []time.Time {
	first := time.Date(y, mon, 1, 0, 0, 0, 0, time.UTC)
	d := aip.CurrentAirac(first)
	if d.Before(first) {
		d = aip.NextAirac(first)
	}
	var out []time.Time
	for ; d.Month() == mon && d.Year() == y; d = d.AddDate(0, 0, 28) {
		out = append(out, d)
	}
	return out
}

// ambiguous reports a release whose month holds two AIRAC dates, so that
// only its change record can say which it is effective on.
func (r release) ambiguous() bool {
	return len(airacDays(r.year, r.month)) > 1
}

// effectiveOf fixes the date a release is in force from: the month's one
// AIRAC date, or, of two, the one the workbook's change record names as
// its newest edition. A change record naming an edition AFTER that date
// is refused, since the file would then be slotted before the amendment it
// carries is in force.
func effectiveOf(r release, edition time.Time) (time.Time, error) {
	days := airacDays(r.year, r.month)
	var eff time.Time
	switch {
	case len(days) == 1:
		eff = days[0]
	default:
		for _, d := range days {
			if edition.Equal(d) {
				eff = d
			}
		}
		if eff.IsZero() {
			return eff, fmt.Errorf("%s: %s %d holds %d AIRAC dates and the change record names none of them (newest edition %s)",
				r.Name, r.month, r.year, len(days), edition.Format("2006-01-02"))
		}
	}
	if edition.After(eff) {
		return eff, fmt.Errorf("%s: the change record dates an edition %s, after the %s the name states",
			r.Name, edition.Format("2006-01-02"), eff.Format("2006-01-02"))
	}
	return eff, nil
}

// pick is the pair of files a slot is built from.
type pick struct {
	area1, safetySignificant *release
}

// effective is the date the pair is in force from, the later of the two.
func (p pick) effective() time.Time {
	if p.safetySignificant.Effective.After(p.area1.Effective) {
		return p.safetySignificant.Effective
	}
	return p.area1.Effective
}

// pickSet chooses each list's file for the target: for the slot in force,
// the newest file effective by today; for the pre-release, the files in
// force on the NEAREST future date either list names. A list that posts
// nothing for that date carries its edition in force, since the two
// registers are amended apart. A nil pick with no error means "next" was
// asked for and nothing future is posted, which is normal. Every release
// must have its Effective fixed.
func pickSet(a1, sso []release, target string, now time.Time) (*pick, error) {
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	on := today
	if target == "next" {
		var next time.Time
		for _, r := range append(append([]release(nil), a1...), sso...) {
			if r.Effective.After(today) && (next.IsZero() || r.Effective.Before(next)) {
				next = r.Effective
			}
		}
		if next.IsZero() {
			return nil, nil
		}
		on = next
	}
	inForce := func(rels []release, what string) (*release, error) {
		var best *release
		for i := range rels {
			if r := &rels[i]; !r.Effective.After(on) && (best == nil || r.Effective.After(best.Effective)) {
				best = r
			}
		}
		if best == nil {
			return nil, fmt.Errorf("no %s register effective on or before %s on %s (page layout may have changed)",
				what, on.Format("2006-01-02"), pageURL)
		}
		return best, nil
	}
	var p pick
	var err error
	if p.area1, err = inForce(a1, "Area 1"); err != nil {
		return nil, err
	}
	if p.safetySignificant, err = inForce(sso, "Safety Significant Obstacles"); err != nil {
		return nil, err
	}
	return &p, nil
}

// resolvePick reads the page and picks the target's files. A file whose
// month holds two AIRAC dates is downloaded first, since only its change
// record can date it.
func resolvePick(ctx context.Context, target string, now time.Time, keepDir string) (*pick, error) {
	page, err := get(ctx, pageURL)
	if err != nil {
		return nil, fmt.Errorf("obstacle page: %w", err)
	}
	lists := [2][]release{findReleases(page, area1), findReleases(page, safetySignificant)}
	for l := range lists {
		for i := range lists[l] {
			r := &lists[l][i]
			var edition time.Time
			if r.ambiguous() {
				if r.body, err = download(ctx, *r, keepDir); err != nil {
					return nil, err
				}
				reg, err := readRegister(r.body, r.Name)
				if err != nil {
					return nil, err
				}
				edition = reg.edition
			}
			if r.Effective, err = effectiveOf(*r, edition); err != nil {
				return nil, err
			}
		}
	}
	return pickSet(lists[0], lists[1], target, now)
}

// download fetches one spreadsheet, keeping a copy under its published
// name when asked, which is what a replay's -in / -sso read back.
func download(ctx context.Context, r release, keepDir string) ([]byte, error) {
	body, err := get(ctx, r.URL)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", r.Name, err)
	}
	if keepDir != "" {
		if err := os.MkdirAll(keepDir, 0o755); err != nil {
			return nil, err
		}
		if err := os.WriteFile(filepath.Join(keepDir, r.Name), body, 0o644); err != nil {
			return nil, err
		}
	}
	return body, nil
}
