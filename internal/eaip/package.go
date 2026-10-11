// package.go models the generated eAIP package itself: where a State's
// sections live, and how to find the cycle that is in force.
//
// Most European States publish their AIP as a generated eAIP package,
// and the packages are far more alike than they look. Two generator
// families cover the region:
//
//   - EUROCONTROL eAIP Specification: an XHTML frameset index.html, a
//     <title> reading "eAIS Package ...", menu.js / amendments.js /
//     commands.js, and section files at
//     html/eAIP/<CC>-<SECTION>-<lang>.html. Verified on Slovenia,
//     Hungary, Serbia and Montenegro, Bosnia, Albania, Czechia and, in a
//     flat variant with no eAIP/ subdirectory, Slovakia.
//   - IDS AIRNAV: section filenames use a SPACE rather than a hyphen
//     ("BK-ENR 5.1-en-GB.html") and the package sits directly under
//     eAIP/. Poland and Kosovo run it.
//
// Two traps are worth naming because both silently produce an empty
// scrape rather than an error:
//
//   - The language suffix is not always -en-GB. Hungary uses -en-HU,
//     Slovakia -en-SK, Croatia had -en-HR. It is sniffed, not assumed.
//   - Directory naming is not derivable. Albania has used
//     "23-Mar-2023-A", "23-Jan-2025-NA" and "14-MAY-2026-A"; Serbia
//     mixes -A and -NA suffixes and inconsistent month casing. The
//     cycle directory is discovered from the State's own index rather
//     than built from a date.

package eaip

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"net/http"
	neturl "net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/overlay"
)

// Family is the generator that produced a package.
type Family int

const (
	// Eurocontrol lays sections out as html/eAIP/<CC>-<SECTION>-<lang>.html.
	Eurocontrol Family = iota
	// EurocontrolFlat is the same, without the eAIP/ subdirectory
	// (Slovakia).
	EurocontrolFlat
	// IDS uses a space before the section number and no html/ level.
	IDS
)

// Site describes one State's eAIP.
type Site struct {
	// Country is the two-letter ICAO prefix the section files carry
	// ("LJ", "LH", "EI"). Empty where the generator omits it (Poland).
	Country string
	// Family is the generator.
	Family Family
	// Base is the URL of the directory holding the cycle directories, or
	// of the package itself when neither Templates nor Index is set.
	Base string
	// Templates are cycle-directory templates, tried in order against the
	// AIRAC grid. See CyclePath for the placeholders. Preferred over
	// Index: the AIRAC dates are worldwide arithmetic, so probing them
	// survives an index page being redesigned.
	Templates []string
	// Index is the page listing the cycles, used when Templates is empty.
	// It takes the same placeholders, so a State whose index filename
	// carries the effective date is still reachable.
	Index string
	// Lang is the language suffix ("en-GB") to fall back on. The suffix a
	// package's own frameset names is tried first (sniffLang): NAV
	// Portugal moved from -en-GB to -en-PT and left the June -en-GB files
	// online, so a pinned suffix quietly read a stale package. Empty
	// falls back to en-GB.
	Lang string
	// NextBase is the pre-release package of a State publishing one fixed
	// "current" package and one fixed "forthcoming" one beside it
	// (Portugal's eAIP_Current / eAIP_Forthcoming_1). Its effective date
	// is read off its pages. Empty when the State has no such package.
	NextBase string
	// Pointer reads the publisher's own statement of the package in
	// force, against which the package read is judged (cycle.go). Nil
	// when the State states nothing but its cycle index, if it has one.
	Pointer Pointer
	// BaseFrom is a URL whose redirect lands on the history page of the
	// packages, for a publisher whose base carries an edition number no
	// template derives: Avinor's aim-prod.avinor.no/no/AIP/ answers with
	// .../View/Index/155/history-no-NO.html, and the 155 moves. Base and
	// Index are then taken from where it lands.
	BaseFrom string
	// Header is sent with every request. Some sites (M-NAV, skeyes)
	// reject a client that does not look like a browser.
	Header map[string]string
	// Snapshot, when set, is a directory every page Get fetches is also
	// written to, under its host and path, so a reader can be developed
	// and checked against a fixed copy (cmd/eaip -snapshot).
	Snapshot string
	// Replay, when set, is a directory a Snapshot wrote, which every page
	// is read from INSTEAD of the network: a page it lacks fails as a
	// missing one would. A reader change is then judged against the same
	// pages before and after it, and iterating on one costs the
	// publishers nothing (cmd/eaip -replay).
	Replay string
	// Fill, with Replay, fetches a page the snapshot lacks from the
	// network and adds it to the snapshot, so a new section is read once
	// and every page already held is not asked for again.
	Fill bool
	// ExtraCA holds PEM certificates offered to this site's chain
	// verification as INTERMEDIATES, never as roots. It is for a server
	// that sends the wrong intermediate, or none: Slovenia Control's leaf
	// is issued by "RapidSSL TLS RSA CA G1" while the server sends
	// "RapidSSL Global TLS RSA4096 SHA256 2022 CA1", and Avians sends its
	// leaf alone. A browser succeeds because it fetches the missing
	// certificates itself from the leaf's Authority Information Access
	// extension; supplying them is the same repair, and the path must
	// still end at a root the system trusts, so nothing is weakened.
	ExtraCA []byte

	client *http.Client
}

// CyclePath expands a template against an AIRAC effective date. The
// placeholders are the ones States actually name their directories with:
//
//	{ISO}    2026-08-06
//	{YYYY} {YY} {MM} {DD}
//	{MONTH}  AUGUST      {MON} AUG
//	{Month}  August      {Mon} Aug
func CyclePath(tmpl string, eff time.Time) string {
	eff = eff.UTC()
	r := strings.NewReplacer(
		"{ISO}", eff.Format("2006-01-02"),
		"{YYYY}", eff.Format("2006"),
		"{YY}", eff.Format("06"),
		"{MM}", eff.Format("01"),
		"{DD}", eff.Format("02"),
		"{MONTH}", strings.ToUpper(eff.Format("January")),
		"{MON}", strings.ToUpper(eff.Format("Jan")),
		"{Month}", eff.Format("January"),
		"{Mon}", eff.Format("Jan"),
	)
	return r.Replace(tmpl)
}

// SectionURL is the URL of one AIP section ("ENR 5.1", "AD 2.EBAW") in
// the cycle directory given, under the Site's own base and language.
func (s *Site) SectionURL(cycleDir, section string) string {
	return s.PageURL(Cycle{Dir: cycleDir}, section)
}

// PageURL is the URL of one AIP section in a resolved package, which
// carries its own base (a forthcoming package lives beside the current
// one) and the language suffix its frameset named.
func (s *Site) PageURL(c Cycle, section string) string {
	return s.sectionURL(c.base(s), c.Dir, section, c.lang(s))
}

// base is the package's base URL: its own when it has one.
func (c Cycle) base(s *Site) string {
	if c.Base != "" {
		return c.Base
	}
	return s.Base
}

// lang is the package's language suffix: the one sniffed from it, else
// the Site's fallback, else en-GB.
func (c Cycle) lang(s *Site) string {
	switch {
	case c.Lang != "":
		return c.Lang
	case s.Lang != "":
		return s.Lang
	}
	return "en-GB"
}

func (s *Site) sectionURL(base, cycleDir, section, lang string) string {
	base = strings.TrimSuffix(base, "/")
	if cycleDir != "" {
		base += "/" + strings.Trim(cycleDir, "/")
	}
	prefix := ""
	if s.Country != "" {
		prefix = s.Country + "-"
	}
	switch s.Family {
	case IDS:
		// "eAIP/BK-ENR 5.1-en-GB.html", and with no State prefix at all
		// in Poland's package: "eAIP/ENR 5.1-en-GB.html".
		return fmt.Sprintf("%s/eAIP/%s%s-%s.html", base, prefix, section, lang)
	case EurocontrolFlat:
		// "html/LZ-ENR-5.1-en-SK.html"
		return fmt.Sprintf("%s/html/%s%s-%s.html", base, prefix, hyphenate(section), lang)
	default:
		// "html/eAIP/LJ-ENR-5.1-en-GB.html"
		return fmt.Sprintf("%s/html/eAIP/%s%s-%s.html", base, prefix, hyphenate(section), lang)
	}
}

// hyphenate turns "ENR 5.1" into "ENR-5.1", the EUROCONTROL spelling.
func hyphenate(section string) string {
	return strings.ReplaceAll(strings.TrimSpace(section), " ", "-")
}

// cycleDirRe recognises a cycle directory in an index page. The
// EUROCONTROL packages name them by effective date; the IDS ones embed
// the date in an amendment label.
var cycleDirRe = regexp.MustCompile(`(?i)(\d{4}-\d{2}-\d{2})-AIRAC`)

// isoDirRe recognises a cycle directory named by its effective date
// alone, which is how Hungary lists them ("href=\"./2026-06-11/\""). It is
// deliberately anchored on the quoted href so a date in prose cannot be
// read as a directory.
var isoDirRe = regexp.MustCompile(`href="\.?/?(\d{4}-\d{2}-\d{2})/"`)

// idsCycleRe recognises the IDS form, "AIRAC AMDT 08-2026_2026_08_06".
var idsCycleRe = regexp.MustCompile(`(?i)(AIRAC[%20\s]+AMDT[%20\s]+[\d-]+_(\d{4})_(\d{2})_(\d{2}))`)

// idsDirRe recognises any IDS AIRNAV cycle directory a history page links,
// by the effective date the generator appends to the directory's name
// whatever the amendment label before it: "AIRAC AIP AMDT 6-2026_2026_10_29"
// and a non-AIRAC "AIP AMDT 1-2026_2026_08_07" (Sweden), "06 AUG
// 2026_2026_08_06" (Finland), "A_08-2026_2026_09_03" (Iceland). Anchored on
// the link, whose separator LFV writes as a backslash.
var idsDirRe = regexp.MustCompile(`href="\s*(?:https?://[^"\s]*?/)?\.?[\\/]?([^"\\/]*?_(\d{4})_(\d{2})_(\d{2}))[\\/]`)

// pkgPathRe recognises a package linked by its path, the effective date
// being the last segment before html/: LGS's
// "eAIPfiles/2026_006_03-SEP-2026/data/2026-09-03/html/index.html".
var pkgPathRe = regexp.MustCompile(`href="\s*\.?/?([^"\s:]*?/(\d{4}-\d{2}-\d{2}))/html/`)

// linkedPkgRe recognises a package linked by its URL, the directory's last
// segment being its effective date and "-AIRAC", under whatever parent the
// publisher filed it: AirNav Ireland's AIM page links
// "https://www.airnav.ie/AIRAC_SEPT_2026/2026-09-03-AIRAC/html/index.html"
// beside "AIRAC_AUGUST_2026/26-08-06-AIRAC" and the forthcoming
// "AIRAC/2026-10-01-AIRAC". The parent names a month in whatever spelling
// the day's editor chose (SEPT, AUGUST), and the year in the date runs to
// four digits or two, so no template reaches these: only the link does.
var linkedPkgRe = regexp.MustCompile(`href="\s*([^"\s]*?/((?:\d{4}|\d{2})-\d{2}-\d{2})-AIRAC)/html/`)

// Cycle is one published edition of a package, and once Resolve has
// read it, what is known about it.
type Cycle struct {
	// Dir is the path segment under the base.
	Dir string
	// Effective is the ISO-8601 UTC midnight of the effective date.
	Effective string
	// Base overrides Site.Base for this edition: Portugal's forthcoming
	// package lives beside the current one, not under it.
	Base string
	// Lang is the language suffix the edition's own frameset names; empty
	// falls back to Site.Lang.
	Lang string
	// Lag is how many AIRAC cycles the edition trails the cycle in force
	// when it was resolved (cycle.go).
	Lag int
	// Confirmed says the publisher's own index or pointer names this
	// edition as the one in force, which is what makes a lagging edition
	// right rather than stale.
	Confirmed bool
	// ResolvedBy says how the edition was found, for the meta.
	ResolvedBy string
	// PointerErr records a pointer that could not be read; the edition is
	// then judged as if the State stated nothing.
	PointerErr string
	// FromPages says Effective was read off the pages, not a directory
	// name, so a build reading the whole package takes the latest date
	// over its pages (an untouched section keeps an older one).
	FromPages bool
}

// Cycles discovers the editions a site publishes, newest first.
//
// The index is scraped rather than derived because the directory naming
// is not predictable; see the package comment.
func (s *Site) Cycles(ctx context.Context, now time.Time) ([]Cycle, error) {
	idx := CyclePath(s.Index, aip.CurrentAirac(now))
	if idx == "" {
		idx = s.Base
	}
	body, err := s.Get(ctx, idx)
	if err != nil {
		return nil, fmt.Errorf("cycle index %s: %w", idx, err)
	}
	out := rebase(cyclesIn(string(body)), s.Base)
	if len(out) == 0 {
		return nil, fmt.Errorf("no cycle directories on %s; the index layout may have changed", idx)
	}
	return out, nil
}

// rebase makes the directories an index links by their full URL relative
// to the site's base, and drops those on another site.
func rebase(cycles []Cycle, base string) []Cycle {
	base = strings.TrimSuffix(base, "/") + "/"
	out := cycles[:0]
	for _, c := range cycles {
		if strings.Contains(c.Dir, "://") {
			if !strings.HasPrefix(c.Dir, base) {
				continue
			}
			c.Dir = strings.TrimPrefix(c.Dir, base)
		}
		out = append(out, c)
	}
	return out
}

// cyclesIn reads every cycle directory a page names, newest first.
func cyclesIn(page string) []Cycle {
	seen := map[string]Cycle{}
	for _, m := range cycleDirRe.FindAllStringSubmatch(page, -1) {
		dir := m[0]
		seen[dir] = Cycle{Dir: dir, Effective: m[1] + "T00:00:00.000Z"}
	}
	for _, m := range isoDirRe.FindAllStringSubmatch(page, -1) {
		seen[m[1]] = Cycle{Dir: m[1], Effective: m[1] + "T00:00:00.000Z"}
	}
	for _, m := range pkgPathRe.FindAllStringSubmatch(page, -1) {
		seen[m[1]] = Cycle{Dir: m[1], Effective: m[2] + "T00:00:00.000Z"}
	}
	for _, m := range linkedPkgRe.FindAllStringSubmatch(page, -1) {
		date := m[2]
		if len(date) == len("26-09-03") {
			date = "20" + date
		}
		seen[m[1]] = Cycle{Dir: m[1], Effective: date + "T00:00:00.000Z"}
		// The bare "<date>-AIRAC" cycleDirRe read inside the link names
		// the same package without its parent, a directory that is not
		// there to probe.
		delete(seen, m[1][strings.LastIndex(m[1], "/")+1:])
	}
	for _, re := range []*regexp.Regexp{idsCycleRe, idsDirRe} {
		for _, m := range re.FindAllStringSubmatch(page, -1) {
			dir := strings.ReplaceAll(m[1], "%20", " ")
			seen[dir] = Cycle{
				Dir:       dir,
				Effective: fmt.Sprintf("%s-%s-%sT00:00:00.000Z", m[2], m[3], m[4]),
			}
		}
	}
	out := make([]Cycle, 0, len(seen))
	for _, c := range seen {
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Effective != out[j].Effective {
			return out[i].Effective > out[j].Effective
		}
		// Two packages on one date (LGS issues an AIRAC and a non-AIRAC
		// amendment for 2026-09-03): the AIRAC one first.
		if ni, nj := isNonAirac(out[i].Dir), isNonAirac(out[j].Dir); ni != nj {
			return nj
		}
		return out[i].Dir < out[j].Dir
	})
	return out
}

// isNonAirac reports a package named as a non-AIRAC amendment.
func isNonAirac(dir string) bool {
	return strings.Contains(strings.ToUpper(dir), "NON-AIRAC")
}

// lookBackCycles is how many AIRAC cycles before the one in force are
// probed. A State that has not yet posted the current package still has
// the previous one on line, and reading it is right: it is what is in
// force until the new one appears.
const lookBackCycles = 2

// Resolve finds the package holding the sections of the AIRAC cycle in
// force at now, or of the one after it when next is set.
//
// probeSection is fetched to confirm a candidate really exists, so a
// directory named by an index but not yet populated cannot be mistaken
// for a published cycle. The package found for the current slot is then
// judged against what the publisher states is in force (cycle.go), so a
// package that moved out from under its templates fails the build rather
// than shipping the previous cycle as current.
func (s *Site) Resolve(ctx context.Context, probeSection string, now time.Time, next bool) (Cycle, error) {
	if s.BaseFrom != "" {
		if err := s.locate(ctx); err != nil {
			return Cycle{}, err
		}
	}
	if next && s.NextBase != "" {
		return s.resolveFixed(ctx, s.NextBase, probeSection, now, true)
	}
	if len(s.Templates) == 0 && s.Index == "" {
		if next {
			// One fixed package and no forthcoming one: nothing to read.
			return Cycle{}, nil
		}
		return s.resolveFixed(ctx, s.Base, probeSection, now, false)
	}
	cands, stated, err := s.candidates(ctx, now, next)
	if err != nil {
		return Cycle{}, err
	}
	var firstErr error
	for _, c := range cands {
		for _, dir := range s.dirVariants(ctx, c.Dir) {
			c.Dir = dir
			pkg, _, err := s.probe(ctx, c, probeSection)
			if err != nil {
				if firstErr == nil {
					firstErr = err
				}
				continue
			}
			if next {
				return pkg, nil
			}
			statedBy := ""
			if len(s.Templates) > 0 {
				pkg.ResolvedBy = "path templates"
			} else {
				pkg.ResolvedBy = "cycle index"
				statedBy = "cycle index"
			}
			return s.judge(ctx, pkg, now, stated, statedBy)
		}
	}
	if firstErr == nil {
		firstErr = fmt.Errorf("no candidate cycle directory")
	}
	if next {
		// A missing pre-release is normal, not a failure.
		return Cycle{}, nil
	}
	return Cycle{}, fmt.Errorf("no readable package under %s: %w", s.Base, firstErr)
}

// locate follows BaseFrom to the history page it lands on, which is both
// the index of the packages and the directory they sit in.
func (s *Site) locate(ctx context.Context) error {
	if s.Replay != "" {
		final, err := s.replayedRedirect(s.BaseFrom)
		if err != nil {
			return fmt.Errorf("locate %s: %w", s.BaseFrom, err)
		}
		return s.landOn(final)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.BaseFrom, nil)
	if err != nil {
		return err
	}
	for k, v := range s.Header {
		req.Header.Set(k, v)
	}
	rt, err := s.transport()
	if err != nil {
		return err
	}
	res, err := (&http.Client{Transport: rt, Timeout: 60 * time.Second}).Do(req)
	if err != nil {
		return fmt.Errorf("locate %s: %w", s.BaseFrom, err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("locate %s: %s", s.BaseFrom, res.Status)
	}
	final := res.Request.URL.String()
	s.saveRedirect(s.BaseFrom, final)
	return s.landOn(final)
}

// landOn takes the base and the index from the history page BaseFrom
// led to.
func (s *Site) landOn(final string) error {
	i := strings.LastIndex(final, "/")
	if i < 0 {
		return fmt.Errorf("locate %s: landed on %q", s.BaseFrom, final)
	}
	s.Base, s.Index = final[:i], final
	return nil
}

// maxFixedLag bounds how old a fixed-path package may be. The fixed path
// is the publisher's own "current" alias, so a cycle or two behind is a
// State that did not amend; three is the alias no longer being what it
// says.
const maxFixedLag = 3

// resolveFixed reads a State that publishes one package at a fixed path
// (Czechia, Portugal's eAIP_Current), or one fixed forthcoming package
// beside it (eAIP_Forthcoming_1), taking the effective date off the
// probe page since no directory names it.
func (s *Site) resolveFixed(ctx context.Context, base, probeSection string, now time.Time, next bool) (Cycle, error) {
	c := Cycle{Base: base, FromPages: true, ResolvedBy: "fixed path"}
	if base == s.Base {
		c.Base = ""
	}
	pkg, body, err := s.probe(ctx, c, probeSection)
	if err != nil {
		if next {
			return Cycle{}, nil
		}
		return Cycle{}, fmt.Errorf("no readable package at %s: %w", base, err)
	}
	eff := PageEffective(body)
	if eff == "" {
		return Cycle{}, fmt.Errorf("%s states no effective date", s.PageURL(pkg, probeSection))
	}
	pkg.Effective = eff + "T00:00:00.000Z"
	t, err := effectiveDay(eff)
	if err != nil {
		return Cycle{}, err
	}
	if next {
		if _, inForce := newestInForce([]time.Time{t}, now); inForce {
			// The forthcoming alias still serves the package in force.
			return Cycle{}, nil
		}
		return pkg, nil
	}
	pkg.Lag = airacLag(t, now)
	pkg.Confirmed = true
	if pkg.Lag >= maxFixedLag {
		return Cycle{}, fmt.Errorf("the fixed path %s serves a package effective %s, %d cycles old",
			s.PageURL(pkg, probeSection), eff, pkg.Lag)
	}
	return pkg, nil
}

// probe fetches a candidate's probe section in each language suffix the
// package may use, the one its own frameset names first, and returns the
// candidate completed with the language that answered, and the page.
func (s *Site) probe(ctx context.Context, c Cycle, section string) (Cycle, []byte, error) {
	var firstErr error
	for _, lang := range s.langsFor(ctx, c) {
		c.Lang = lang
		url := s.PageURL(c, section)
		body, err := s.Get(ctx, url)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		if !isSection(body, section) {
			// AirNav Ireland answers a missing package with a 302 to its
			// own error page, so an HTTP status alone would accept a cycle
			// that was never published.
			if firstErr == nil {
				firstErr = fmt.Errorf("%s: not an AIP section page", url)
			}
			continue
		}
		return c, body, nil
	}
	return Cycle{}, nil, firstErr
}

// langsFor lists the language suffixes worth trying for a package: the
// one its frameset names, then the Site's own, then en-GB when the Site
// names none. A Site that pins a suffix never falls back to en-GB, since
// a stale -en-GB copy left beside the live files is exactly the trap.
func (s *Site) langsFor(ctx context.Context, c Cycle) []string {
	var out []string
	add := func(l string) {
		if l == "" {
			return
		}
		for _, x := range out {
			if x == l {
				return
			}
		}
		out = append(out, l)
	}
	add(s.sniffLang(ctx, c))
	add(s.Lang)
	if s.Lang == "" {
		add("en-GB")
	}
	return out
}

// sniffLang reads the language suffix a EUROCONTROL package's frameset
// names ("eAIP/LP-menu-en-PT.html"), from the html/ directory where most
// keep it, else from the package root. IDS AIRNAV spells every file with
// its fixed suffix and has nothing to sniff. "" when nothing names one.
func (s *Site) sniffLang(ctx context.Context, c Cycle) string {
	if s.Family == IDS {
		return ""
	}
	root := strings.TrimSuffix(c.base(s), "/")
	if c.Dir != "" {
		root += "/" + strings.Trim(c.Dir, "/")
	}
	for _, p := range []string{"/html/", "/"} {
		body, err := s.Get(ctx, root+p)
		if err != nil {
			continue
		}
		if l := SniffLang(body); l != "" {
			return l
		}
	}
	return ""
}

// candidates lists the cycle directories worth probing, best first, and
// the in-force date the State's own cycle index states (zero when the
// State is located by templates).
func (s *Site) candidates(ctx context.Context, now time.Time, next bool) ([]Cycle, time.Time, error) {
	if len(s.Templates) > 0 {
		var effs []time.Time
		if next {
			effs = []time.Time{aip.NextAirac(now)}
		} else {
			eff := aip.CurrentAirac(now)
			for i := 0; i <= lookBackCycles; i++ {
				effs = append(effs, eff.AddDate(0, 0, -28*i))
			}
		}
		var out []Cycle
		for _, eff := range effs {
			for _, t := range s.Templates {
				out = append(out, Cycle{
					Dir:       CyclePath(t, eff),
					Effective: aip.AiracISO(eff) + "T00:00:00.000Z",
				})
			}
		}
		return out, time.Time{}, nil
	}
	cycles, err := s.Cycles(ctx, now)
	if err != nil {
		return nil, time.Time{}, err
	}
	nowISO := aip.AiracISO(now.UTC())
	var out []Cycle
	var stated time.Time
	for _, c := range cycles {
		if next != (c.Effective > nowISO+"T00:00:00.000Z") {
			continue
		}
		if !next && stated.IsZero() {
			// Newest first: the first one in force is what the index states.
			if t, err := effectiveDay(c.Effective); err == nil {
				stated = t
			}
		}
		out = append(out, c)
	}
	if next && len(out) > 1 {
		// The pre-release slot holds the edition that takes effect NEXT:
		// Avians posts two ahead (2026-10-01 and 2026-10-29), and the
		// later one in the slot would keep the one between from ever
		// being shown. Only the soonest date, since falling back to a
		// later one on a failed read would skip a cycle just the same;
		// its packages keep their order, the AIRAC one first.
		soonest := out[len(out)-1].Effective
		i := len(out) - 1
		for i > 0 && out[i-1].Effective == soonest {
			i--
		}
		out = out[i:]
	}
	return out, stated, nil
}

// isSection reports whether a fetched page really is the AIP section
// asked for: it names the section and carries a table. Both are needed,
// since a site's own error page can name the section from the URL.
func isSection(body []byte, section string) bool {
	page := string(body)
	if !strings.Contains(strings.ToLower(page), "<table") {
		return false
	}
	return strings.Contains(page, section) || strings.Contains(page, hyphenate(section))
}

// framePathRe reads the path a EUROCONTROL frameset points its content
// frames at. Hungary nests the package one level deeper than the cycle
// directory ("2026-06-11/2026-06-11-AIRAC/html/..."), and the frameset is
// the only place that inner name is written down.
var framePathRe = regexp.MustCompile(`(?:src|href)="([^"]*?)html[/\\]`)

// dirVariants returns the directory itself and, when its frameset names
// an inner package directory, that deeper path too.
func (s *Site) dirVariants(ctx context.Context, dir string) []string {
	out := []string{dir}
	base := strings.TrimSuffix(s.Base, "/")
	if dir != "" {
		base += "/" + strings.Trim(dir, "/")
	}
	body, err := s.Get(ctx, base+"/")
	if err != nil {
		return out
	}
	m := framePathRe.FindSubmatch(body)
	if m == nil {
		return out
	}
	inner := strings.Trim(strings.ReplaceAll(string(m[1]), `\`, "/"), "/")
	if inner == "" || strings.Contains(inner, "..") {
		return out
	}
	return append(out, strings.Trim(dir+"/"+inner, "/"))
}

// langSuffixRe finds a section filename's language suffix in an index or
// menu page: "-en-GB.html", "-en-HU.html", "-en-SK.html".
var langSuffixRe = regexp.MustCompile(`-(?:en|EN)-([A-Za-z]{2})\.html`)

// SniffLang reads the language suffix off a page listing section files.
// Returns "" when the page names none, in which case the caller keeps
// its default.
func SniffLang(body []byte) string {
	m := langSuffixRe.FindSubmatch(body)
	if m == nil {
		return ""
	}
	return "en-" + strings.ToUpper(string(m[1]))
}

// Get fetches a page with the site's headers, through the shared HTTP
// retry envelope.
func (s *Site) Get(ctx context.Context, url string) ([]byte, error) {
	body, err := s.get(ctx, url)
	if err == nil && s.Snapshot != "" {
		s.save(url, body)
	}
	return body, err
}

func (s *Site) get(ctx context.Context, url string) ([]byte, error) {
	if s.Replay != "" {
		name, ok := snapshotName(s.Replay, url)
		if !ok {
			return nil, fmt.Errorf("%s: not a replayable URL", url)
		}
		body, err := os.ReadFile(name)
		if err == nil {
			return body, nil
		}
		if !s.Fill {
			return nil, fmt.Errorf("%s: not in the replayed snapshot", url)
		}
		body, err = s.fetch(ctx, url)
		if err == nil {
			if err := os.MkdirAll(filepath.Dir(name), 0o755); err == nil {
				_ = os.WriteFile(name, body, 0o644)
			}
		}
		return body, err
	}
	return s.fetch(ctx, url)
}

// fetch reads a page from the network, with the site's headers and
// certificates.
func (s *Site) fetch(ctx context.Context, url string) ([]byte, error) {
	if len(s.ExtraCA) > 0 {
		c, err := s.tlsClient()
		if err != nil {
			return nil, err
		}
		return overlay.HTTPGetAllWithClient(ctx, url, s.Header, c)
	}
	if len(s.Header) == 0 {
		return overlay.HTTPGetAll(ctx, url)
	}
	return overlay.HTTPGetAllWithHeaders(ctx, url, s.Header)
}

// save writes a fetched page under the snapshot directory, by its host
// and unescaped path. A failure costs the copy, never the fetch.
func (s *Site) save(raw string, body []byte) {
	name, ok := snapshotName(s.Snapshot, raw)
	if !ok {
		return
	}
	if err := os.MkdirAll(filepath.Dir(name), 0o755); err != nil {
		return
	}
	_ = os.WriteFile(name, body, 0o644)
}

// snapshotName is where a snapshot keeps a URL's page: under its host and
// its unescaped path, a directory's page as its index.html. The query is
// not part of the name, and no snapshotted page needs one.
func snapshotName(dir, raw string) (string, bool) {
	u, err := neturl.Parse(raw)
	if err != nil {
		return "", false
	}
	p, err := neturl.PathUnescape(u.EscapedPath())
	if err != nil {
		p = u.Path
	}
	name := filepath.Join(dir, u.Host, filepath.FromSlash(path.Clean("/"+p)))
	if strings.HasSuffix(p, "/") {
		name = filepath.Join(name, "index.html")
	}
	return name, true
}

// A redirect is part of what a snapshot must hold, since a publisher's
// pointer can be one (EANS's root names the issue in force) and so can
// the way to its packages (Avinor's BaseFrom): the target is kept in a
// file beside the page's own name.
const redirectSuffix = ".redirect"

// saveRedirect records where a URL led, when snapshotting.
func (s *Site) saveRedirect(raw, target string) {
	if s.Snapshot == "" {
		return
	}
	name, ok := snapshotName(s.Snapshot, raw)
	if !ok {
		return
	}
	if err := os.MkdirAll(filepath.Dir(name), 0o755); err != nil {
		return
	}
	_ = os.WriteFile(name+redirectSuffix, []byte(target), 0o644)
}

// replayedRedirect reads back where a URL led when it was snapshotted.
func (s *Site) replayedRedirect(raw string) (string, error) {
	name, ok := snapshotName(s.Replay, raw)
	if !ok {
		return "", fmt.Errorf("%s: not a replayable URL", raw)
	}
	b, err := os.ReadFile(name + redirectSuffix)
	if err != nil {
		return "", fmt.Errorf("%s: no redirect in the replayed snapshot", raw)
	}
	return strings.TrimSpace(string(b)), nil
}

// PackageRoot is the directory an edition's files sit under: its base
// and its cycle directory.
func (s *Site) PackageRoot(c Cycle) string {
	root := strings.TrimSuffix(c.base(s), "/")
	if c.Dir != "" {
		root += "/" + strings.Trim(c.Dir, "/")
	}
	return root
}

// HTTPClient is the client a request outside Get goes through, trusting
// what the site's own does.
func (s *Site) HTTPClient() (*http.Client, error) {
	if len(s.ExtraCA) > 0 {
		return s.tlsClient()
	}
	return &http.Client{Timeout: 60 * time.Second}, nil
}

// transport is the round tripper a request outside Get goes through: the
// default one, or the one trusting the site's supplied intermediate.
func (s *Site) transport() (http.RoundTripper, error) {
	if len(s.ExtraCA) == 0 {
		return http.DefaultTransport, nil
	}
	c, err := s.tlsClient()
	if err != nil {
		return nil, err
	}
	return c.Transport, nil
}

// tlsClient builds (once) the client that verifies the site against the
// system roots with ExtraCA added to the intermediates. crypto/tls takes
// no extra intermediates, so the standard verification is replaced by
// the same one done in VerifyConnection with them.
func (s *Site) tlsClient() (*http.Client, error) {
	if s.client != nil {
		return s.client, nil
	}
	extra, err := pemCertificates(s.ExtraCA)
	if err != nil {
		return nil, err
	}
	s.client = &http.Client{
		Timeout: 300 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{
				MinVersion:         tls.VersionTLS12,
				InsecureSkipVerify: true, // verified in VerifyConnection
				VerifyConnection: func(cs tls.ConnectionState) error {
					return verifyWithIntermediates(cs, extra, nil)
				},
			},
		},
	}
	return s.client, nil
}

// pemCertificates parses every certificate of a PEM bundle.
func pemCertificates(bundle []byte) ([]*x509.Certificate, error) {
	var out []*x509.Certificate
	for rest := bundle; ; {
		var b *pem.Block
		b, rest = pem.Decode(rest)
		if b == nil {
			break
		}
		if b.Type != "CERTIFICATE" {
			continue
		}
		c, err := x509.ParseCertificate(b.Bytes)
		if err != nil {
			return nil, fmt.Errorf("ExtraCA: %w", err)
		}
		out = append(out, c)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("ExtraCA holds no PEM certificate")
	}
	return out, nil
}

// verifyWithIntermediates verifies the server's chain for its name, with
// the certificates it sent and the extra ones as intermediates, against
// roots (nil: the system's).
func verifyWithIntermediates(cs tls.ConnectionState, extra []*x509.Certificate, roots *x509.CertPool) error {
	if len(cs.PeerCertificates) == 0 {
		return fmt.Errorf("the server sent no certificate")
	}
	inter := x509.NewCertPool()
	for _, c := range extra {
		inter.AddCert(c)
	}
	for _, c := range cs.PeerCertificates[1:] {
		inter.AddCert(c)
	}
	_, err := cs.PeerCertificates[0].Verify(x509.VerifyOptions{
		DNSName:       cs.ServerName,
		Intermediates: inter,
		Roots:         roots,
	})
	return err
}

// BrowserHeaders is the header set a WAF-guarded site needs. M-NAV
// answers 406 to a plain client, and skeyes 403; both are satisfied by
// looking like a browser.
var BrowserHeaders = map[string]string{
	"User-Agent":      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
	"Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
	"Accept-Language": "en-GB,en;q=0.9",
}
