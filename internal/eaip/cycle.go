// cycle.go tells the package in force from a stale one.
//
// A State's package is found by probing its path templates newest first,
// with two cycles of look-back because publishers drift off the AIRAC
// grid. The look-back is also how a MOVED package goes unnoticed: when
// AirNav Ireland moved its September 2026 package to AIRAC/{ISO}-AIRAC,
// no template matched it, the August package was still online a cycle
// back, and the weekly build shipped August as current for three weeks.
// (That folder was the newest package's; September moved on again when
// October arrived, and Ireland is now found from AirNav's own links.)
//
// An older package is sometimes exactly right. A State with no amendment
// for a cycle (Estonia and Bosnia on 2026-09-03) keeps the previous
// package in force, and from outside that looks the same as a move. What
// tells them apart is the publisher's own statement of which package is
// in force, the Pointer: a root redirect (Estonia), a start page
// (Serbia), a JSON issue list (Bosnia), or the State's cycle index. The
// package read is judged against it:
//
//   - the publisher names a NEWER package than the one read: an error,
//     the package has moved;
//   - it names the one read: confirmed, whatever its age;
//   - nothing states anything, and the package trails the cycle in force:
//     a warning inside StaleGrace of that cycle's start (a publisher
//     posting a day late is not a failure), an error after it, and an
//     error at once two cycles behind.

package eaip

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
)

// StaleGrace is how long a package one cycle behind is tolerated when no
// publisher statement confirms it. AirNav Ireland has posted a package a
// week late; three weeks of a stale Ireland is what the grace must not
// allow again.
const StaleGrace = 7 * 24 * time.Hour

// airacPeriod is the worldwide AIRAC interval.
const airacPeriod = 28 * 24 * time.Hour

// Pointer returns the effective date of the package the publisher states
// is in force at now.
type Pointer func(ctx context.Context, s *Site, now time.Time) (time.Time, error)

// isoDateRe finds an ISO calendar date in a URL or a page.
var isoDateRe = regexp.MustCompile(`\d{4}-\d{2}-\d{2}`)

// RedirectPointer reads the date out of the redirect a publisher's root
// answers with: Estonia's eaip.eans.ee/ redirects to the package in force
// ("…/2026-08-06/html/"), and only the Location header says which.
func RedirectPointer(url string) Pointer {
	return func(ctx context.Context, s *Site, now time.Time) (time.Time, error) {
		loc, err := s.redirectTarget(ctx, url)
		if err != nil {
			return time.Time{}, err
		}
		m := isoDateRe.FindString(loc)
		if m == "" {
			return time.Time{}, fmt.Errorf("%s redirects to %q, which names no date", url, loc)
		}
		return time.Parse("2006-01-02", m)
	}
}

// PagePointer reads the packages a publisher's start page links and
// returns the newest one already in force: Serbia's start_page.html links
// exactly the package in force, LPS SR's eAIP page the current package
// and the next, ALBCONTROL's AIP page every amendment folder.
func PagePointer(url string) Pointer {
	return func(ctx context.Context, s *Site, now time.Time) (time.Time, error) {
		body, err := s.Get(ctx, url)
		if err != nil {
			return time.Time{}, err
		}
		t, ok := newestInForce(pointerDates(string(body)), now)
		if !ok {
			return time.Time{}, fmt.Errorf("%s links no package in force", url)
		}
		return t, nil
	}
}

// effDirRe is LPS SR's "AIP_SR_EFF_03SEP2026" and dmyDirRe the dated
// amendment folders SMATSA and ALBCONTROL wrap their packages in
// ("03-Sep-2026-A", "06-AUG-2026-NA"). Neither is a directory the cycle
// index reader would take, so they are read here only, for their date.
var (
	effDirRe = regexp.MustCompile(`(?i)EFF_(\d{2})([A-Z]{3})(\d{4})`)
	dmyDirRe = regexp.MustCompile(`(?i)\b(\d{2})-([A-Z]{3})-(\d{4})-N?A\b`)
)

// pointerDates lists every package date a start page names.
func pointerDates(page string) []time.Time {
	var out []time.Time
	for _, c := range cyclesIn(page) {
		if t, err := effectiveDay(c.Effective); err == nil {
			out = append(out, t)
		}
	}
	for _, re := range []*regexp.Regexp{effDirRe, dmyDirRe} {
		for _, m := range re.FindAllStringSubmatch(page, -1) {
			if t, ok := parseIssueDate(m[1] + " " + m[2] + " " + m[3]); ok {
				out = append(out, t)
			}
		}
	}
	return out
}

// IssueListPointer reads a JSON array of issues, each carrying an
// effective date under a key naming it ("effectiveDate": "06 AUG 2026"),
// and returns the newest already in force. Bosnia's updates.json is the
// one such list in the cohort. The publication dates beside the
// effective ones are ignored on purpose: an issue published last month
// for next month is not in force.
func IssueListPointer(url string) Pointer {
	return func(ctx context.Context, s *Site, now time.Time) (time.Time, error) {
		body, err := s.Get(ctx, url)
		if err != nil {
			return time.Time{}, err
		}
		var issues []map[string]any
		if err := json.Unmarshal(body, &issues); err != nil {
			return time.Time{}, fmt.Errorf("%s: %w", url, err)
		}
		var effs []time.Time
		for _, is := range issues {
			for k, v := range is {
				str, ok := v.(string)
				if !ok || !strings.Contains(strings.ToLower(k), "effective") {
					continue
				}
				if t, ok := parseIssueDate(str); ok {
					effs = append(effs, t)
				}
			}
		}
		t, ok := newestInForce(effs, now)
		if !ok {
			return time.Time{}, fmt.Errorf("%s lists no issue in force", url)
		}
		return t, nil
	}
}

// parseIssueDate reads the two date spellings issue lists use: "06 AUG
// 2026" (Go matches month names case-insensitively) and ISO.
func parseIssueDate(s string) (time.Time, bool) {
	s = strings.TrimSpace(s)
	for _, layout := range []string{"02 Jan 2006", "2 Jan 2006", "2006-01-02"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

// newestInForce returns the latest date not after now's calendar day.
func newestInForce(effs []time.Time, now time.Time) (time.Time, bool) {
	y, m, d := now.UTC().Date()
	today := time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
	var best time.Time
	for _, t := range effs {
		if !t.After(today) && t.After(best) {
			best = t
		}
	}
	return best, !best.IsZero()
}

// effectiveDay parses a Cycle.Effective stamp ("2026-08-06T00:00:00.000Z"
// or a bare "2026-08-06") to UTC midnight of its calendar date.
func effectiveDay(s string) (time.Time, error) {
	if len(s) >= 10 {
		s = s[:10]
	}
	return time.Parse("2006-01-02", s)
}

// airacLag is how many AIRAC cycles a package effective at eff trails
// the cycle in force at now; 0 when it is that cycle or a later one. A
// package dated off the grid (Sweden's non-AIRAC amendment of 7 August)
// counts as the cycle it falls in.
func airacLag(eff, now time.Time) int {
	cur := aip.CurrentAirac(now)
	if !eff.Before(cur) {
		return 0
	}
	return int((cur.Sub(eff) + airacPeriod - 1) / airacPeriod)
}

// judge checks a readable package against what the publisher states,
// filling Lag, Confirmed and ResolvedBy. stated is the in-force date the
// State's own cycle index named (zero when it has none); the Pointer, when
// the Site has one, is asked as well.
func (s *Site) judge(ctx context.Context, c Cycle, now time.Time, stated time.Time, statedBy string) (Cycle, error) {
	eff, err := effectiveDay(c.Effective)
	if err != nil {
		return Cycle{}, fmt.Errorf("package %q: %w", c.Dir, err)
	}
	c.Lag = airacLag(eff, now)
	if s.Pointer != nil {
		p, err := s.Pointer(ctx, s, now)
		switch {
		case err != nil:
			c.PointerErr = err.Error()
		case p.After(stated):
			stated, statedBy = p, "publisher pointer"
		}
	}
	if !stated.IsZero() {
		if stated.After(eff) {
			return Cycle{}, fmt.Errorf(
				"the publisher's %s names the package effective %s as in force, but the newest readable one is %q, effective %s: the package has probably moved",
				statedBy, aip.AiracISO(stated), c.Dir, aip.AiracISO(eff))
		}
		if stated.Equal(eff) {
			c.Confirmed = true
			c.ResolvedBy += ", confirmed by the " + statedBy
		}
	}
	if !c.Confirmed && c.Lag > 0 {
		cur := aip.CurrentAirac(now)
		if c.Lag >= 2 || !now.Before(cur.Add(StaleGrace)) {
			return Cycle{}, fmt.Errorf(
				"the newest readable package, %q, is effective %s, %d cycle(s) behind the AIRAC cycle in force (%s), and nothing the publisher states confirms it: the package has probably moved",
				c.Dir, aip.AiracISO(eff), c.Lag, aip.AiracISO(cur))
		}
	}
	return c, nil
}

// redirectTarget returns the Location a URL redirects to, without
// following it.
func (s *Site) redirectTarget(ctx context.Context, url string) (string, error) {
	if s.Replay != "" {
		return s.replayedRedirect(url)
	}
	rt, err := s.transport()
	if err != nil {
		return "", err
	}
	client := &http.Client{
		Transport: rt,
		Timeout:   60 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	for k, v := range s.Header {
		req.Header.Set(k, v)
	}
	res, err := client.Do(req)
	if err != nil {
		return "", err
	}
	res.Body.Close()
	if res.StatusCode < 300 || res.StatusCode >= 400 {
		return "", fmt.Errorf("%s answered %d, not a redirect", url, res.StatusCode)
	}
	target := res.Header.Get("Location")
	s.saveRedirect(url, target)
	return target, nil
}

// emEffectiveRe reads the effective date the EUROCONTROL generator stamps
// on every page it writes.
var emEffectiveRe = regexp.MustCompile(`(?i)<meta[^>]+name="EM\.effectiveDateStart"[^>]+content="(\d{4}-\d{2}-\d{2})"`)

// validFromRe reads a page title's "valid from 09 JUL 2026", the form
// generators that stamp no EM meta still print.
var validFromRe = regexp.MustCompile(`(?i)valid\s+from\s+(\d{1,2})\s+([A-Z]{3})\s+(\d{4})`)

// PageEffective returns the effective date a page states, as
// "2026-08-06", or "" when it states none. A section untouched by the
// latest amendment keeps an older date, so a caller reading a whole
// package takes the latest over its pages.
func PageEffective(body []byte) string {
	if m := emEffectiveRe.FindSubmatch(body); m != nil {
		return string(m[1])
	}
	if m := validFromRe.FindSubmatch(body); m != nil {
		if t, ok := parseIssueDate(string(m[1]) + " " + string(m[2]) + " " + string(m[3])); ok {
			return aip.AiracISO(t)
		}
	}
	return ""
}
