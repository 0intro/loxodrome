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
	"fmt"
	"net/http"
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
	// Lang is the language suffix ("en-GB"). Empty means sniff it.
	Lang string
	// Header is sent with every request. Some sites (M-NAV, skeyes)
	// reject a client that does not look like a browser.
	Header map[string]string
	// ExtraCA is a PEM certificate added to a COPY of the system trust
	// pool for this site alone. It is for a server that sends the wrong
	// intermediate: Slovenia Control's leaf is issued by "RapidSSL TLS
	// RSA CA G1" while the server sends "RapidSSL Global TLS RSA4096
	// SHA256 2022 CA1", so no strict client can build a path, and a
	// browser only succeeds because it fetches the real intermediate
	// itself from the leaf's Authority Information Access extension.
	// Supplying that intermediate is the same repair; the ROOT still has
	// to be one the system trusts, so nothing is weakened.
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

// SectionURL is the URL of one AIP section ("ENR 5.1", "AD 2.EBAW").
func (s *Site) SectionURL(cycleDir, section string) string {
	base := strings.TrimSuffix(s.Base, "/")
	if cycleDir != "" {
		base += "/" + strings.Trim(cycleDir, "/")
	}
	lang := s.Lang
	if lang == "" {
		lang = "en-GB"
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

// Cycle is one published edition of a package.
type Cycle struct {
	// Dir is the path segment under Base.
	Dir string
	// Effective is the ISO-8601 UTC midnight of the effective date.
	Effective string
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
	seen := map[string]Cycle{}
	page := string(body)

	for _, m := range cycleDirRe.FindAllStringSubmatch(page, -1) {
		dir := m[0]
		seen[dir] = Cycle{Dir: dir, Effective: m[1] + "T00:00:00.000Z"}
	}
	for _, m := range isoDirRe.FindAllStringSubmatch(page, -1) {
		seen[m[1]] = Cycle{Dir: m[1], Effective: m[1] + "T00:00:00.000Z"}
	}
	for _, m := range idsCycleRe.FindAllStringSubmatch(page, -1) {
		dir := strings.ReplaceAll(m[1], "%20", " ")
		seen[dir] = Cycle{
			Dir:       dir,
			Effective: fmt.Sprintf("%s-%s-%sT00:00:00.000Z", m[2], m[3], m[4]),
		}
	}
	out := make([]Cycle, 0, len(seen))
	for _, c := range seen {
		out = append(out, c)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("no cycle directories on %s; the index layout may have changed", idx)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Effective > out[j].Effective })
	return out, nil
}

// lookBackCycles is how many AIRAC cycles before the one in force are
// probed. A State that has not yet posted the current package still has
// the previous one on line, and reading it is right: it is what is in
// force until the new one appears.
const lookBackCycles = 2

// Resolve finds the package directory holding the sections of the AIRAC
// cycle in force at now, or of the one after it when next is set.
//
// probeSection is fetched to confirm a candidate really exists, so a
// directory named by an index but not yet populated cannot be mistaken
// for a published cycle.
func (s *Site) Resolve(ctx context.Context, probeSection string, now time.Time, next bool) (Cycle, error) {
	cands, err := s.candidates(ctx, now, next)
	if err != nil {
		return Cycle{}, err
	}
	var firstErr error
	for _, c := range cands {
		for _, dir := range s.dirVariants(ctx, c.Dir) {
			body, err := s.Get(ctx, s.SectionURL(dir, probeSection))
			if err != nil {
				if firstErr == nil {
					firstErr = err
				}
				continue
			}
			if !isSection(body, probeSection) {
				// AirNav Ireland answers a missing package with a 302 to its
				// own error page, so an HTTP status alone would accept a
				// cycle that was never published.
				if firstErr == nil {
					firstErr = fmt.Errorf("%s: not an AIP section page", s.SectionURL(dir, probeSection))
				}
				continue
			}
			c.Dir = dir
			return c, nil
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

// candidates lists the cycle directories worth probing, best first.
func (s *Site) candidates(ctx context.Context, now time.Time, next bool) ([]Cycle, error) {
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
		return out, nil
	}
	if s.Index == "" {
		// The State publishes one package with no cycle level.
		return []Cycle{{}}, nil
	}
	cycles, err := s.Cycles(ctx, now)
	if err != nil {
		return nil, err
	}
	nowISO := aip.AiracISO(now.UTC())
	var out []Cycle
	for _, c := range cycles {
		if next != (c.Effective > nowISO+"T00:00:00.000Z") {
			continue
		}
		out = append(out, c)
	}
	return out, nil
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

// tlsClient builds (once) the client that trusts the system pool plus
// the site's own supplied intermediate.
func (s *Site) tlsClient() (*http.Client, error) {
	if s.client != nil {
		return s.client, nil
	}
	pool, err := x509.SystemCertPool()
	if err != nil {
		return nil, fmt.Errorf("system cert pool: %w", err)
	}
	if !pool.AppendCertsFromPEM(s.ExtraCA) {
		return nil, fmt.Errorf("ExtraCA is not a PEM certificate")
	}
	s.client = &http.Client{
		Timeout: 300 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12},
		},
	}
	return s.client, nil
}

// BrowserHeaders is the header set a WAF-guarded site needs. M-NAV
// answers 406 to a plain client, and skeyes 403; both are satisfied by
// looking like a browser.
var BrowserHeaders = map[string]string{
	"User-Agent":      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
	"Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
	"Accept-Language": "en-GB,en;q=0.9",
}
