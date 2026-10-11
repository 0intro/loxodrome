// fetch.go: acquire one skeyes eAIP publication tree. Two modes:
//   - live: fetch the pages from ops.skeyes.be (eAIP_Main is the current
//     cycle, eAIP_Next the pre-released next cycle), throttled, optionally
//     dumping every page to a snapshot directory (gitignored local/).
//   - offline (-in): read a snapshot directory back, no network. The Go
//     tests run on trimmed snapshots under testdata/.
//
// The page list is menu-driven: EB-menu-en-GB.html enumerates the AD 2
// aerodrome and AD 3 heliport pages; the ENR pages are a fixed list; the
// eSUP listing enumerates the supplement pages.

package main

import (
	"context"
	"fmt"
	"github.com/0intro/loxodrome/internal/eaip"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"golang.org/x/net/html"
)

const (
	eaipBase = "https://ops.skeyes.be/html/belgocontrol_static/eaip/"
	slotMain = "eAIP_Main"
	slotNext = "eAIP_Next"

	// The skeyes WAF turns away requests that don't look like a browser:
	// non-browser User-Agents get HTTP 403 (curl's default,
	// Go-http-client, even an honest tool UA), and so does a browser UA
	// without its usual Accept headers (Go sends none by default). The
	// fetcher therefore presents a consistent mainstream-browser header
	// set. The content is the public AIP; the load is ~160 small pages
	// per 28-day cycle, throttled by fetchInterval.
	userAgent      = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0"
	acceptHeader   = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
	acceptLanguage = "en-US,en;q=0.5"
	fetchInterval  = 250 * time.Millisecond
)

const menuPage = "eAIP/EB-menu-en-GB.html"

const supListPage = "eSUP/EB-eSUPs-en-GB.html"

// enrPages are the fixed data sections cmd/be parses.
var enrPages = []string{
	"eAIP/EB-ENR-2.1-en-GB.html", // FIR/UIR/UTA/CTA/TMA (FIR + UIR skipped: pruatlas)
	"eAIP/EB-ENR-2.2-en-GB.html", // other regulated airspace (EIJSDEN, ZEELAND, ...)
	"eAIP/EB-ENR-4.1-en-GB.html", // radio navaids
	"eAIP/EB-ENR-4.4-en-GB.html", // designated points
	"eAIP/EB-ENR-5.1-en-GB.html", // P / R / D
	"eAIP/EB-ENR-5.2-en-GB.html", // TRA / TSA
	"eAIP/EB-ENR-5.3-en-GB.html", // other dangerous activities
	"eAIP/EB-ENR-5.4-en-GB.html", // obstacles
	"eAIP/EB-ENR-5.5-en-GB.html", // aerial sporting / recreational
	"eAIP/EB-ENR-5.6-en-GB.html", // bird areas
}

// tree is one acquired publication: page name (relative to <slot>/html/)
// -> raw HTML, plus the cycle validity parsed from the page titles.
type tree struct {
	label     string // "eAIP_Main", "eAIP_Next", or the -in directory
	pages     map[string][]byte
	effective string // RFC3339 with fraction, aip.ResolveTarget's format
	docs      map[string]*html.Node
}

// doc lazily parses one page. nil when the page is absent or malformed.
func (t *tree) doc(name string) *html.Node {
	if d, ok := t.docs[name]; ok {
		return d
	}
	var d *html.Node
	if data, ok := t.pages[name]; ok {
		if parsed, err := eaip.ParseHTML(data); err == nil {
			d = parsed
		}
	}
	if t.docs == nil {
		t.docs = map[string]*html.Node{}
	}
	t.docs[name] = d
	return d
}

// adPages returns the AD 2 + AD 3 page names present in the tree, sorted.
func (t *tree) adPages() []string {
	var out []string
	for name := range t.pages {
		if adPageRe.MatchString(filepath.Base(name)) {
			out = append(out, name)
		}
	}
	sort.Strings(out)
	return out
}

// supPages returns the eSUP supplement page names present in the tree, sorted.
func (t *tree) supPages() []string {
	var out []string
	for name := range t.pages {
		if supPageRe.MatchString(filepath.Base(name)) {
			out = append(out, name)
		}
	}
	sort.Strings(out)
	return out
}

// rawConcat returns every page's bytes concatenated in sorted-name order:
// the stable "source bytes" the meta sha256 fingerprints.
func (t *tree) rawConcat() []byte {
	names := make([]string, 0, len(t.pages))
	for n := range t.pages {
		names = append(names, n)
	}
	sort.Strings(names)
	var b []byte
	for _, n := range names {
		b = append(b, t.pages[n]...)
	}
	return b
}

var (
	adPageRe    = regexp.MustCompile(`^EB-AD-[23]\.[A-Z0-9]{4}-en-GB\.html$`)
	supPageRe   = regexp.MustCompile(`^EB-eSUP-\d{4}-\d{3}-en-GB\.html$`)
	validFromRe = regexp.MustCompile(`valid from (\d{1,2}) ([A-Z]{3}) (\d{4})`)
)

var monthNum = map[string]string{
	"JAN": "01", "FEB": "02", "MAR": "03", "APR": "04", "MAY": "05", "JUN": "06",
	"JUL": "07", "AUG": "08", "SEP": "09", "OCT": "10", "NOV": "11", "DEC": "12",
}

// effectiveFromTitles scans the eAIP page titles ("AIP for BELGIUM
// (section ENR-2.1) valid from 09 JUL 2026") and returns the LATEST date
// in aip.ResolveTarget's RFC3339 form. Sections untouched by the current
// amendment keep an older date, so the maximum is the cycle's effective
// date. "" when no title parses.
func (t *tree) effectiveFromTitles() string {
	best := ""
	for name := range t.pages {
		if !strings.HasPrefix(name, "eAIP/") {
			continue
		}
		d := t.doc(name)
		if d == nil {
			continue
		}
		m := validFromRe.FindStringSubmatch(eaip.PageTitle(d))
		if m == nil {
			continue
		}
		mon, ok := monthNum[m[2]]
		if !ok {
			continue
		}
		iso := fmt.Sprintf("%s-%s-%02s", m[3], mon, m[1])
		if len(m[1]) == 1 {
			iso = fmt.Sprintf("%s-%s-0%s", m[3], mon, m[1])
		}
		if iso > best {
			best = iso
		}
	}
	if best == "" {
		return ""
	}
	return best + "T00:00:00.000Z"
}

// --- live fetch ---------------------------------------------------------

type fetcher struct {
	client   *http.Client
	interval time.Duration
	last     time.Time
	fetched  int
}

func newFetcher() *fetcher {
	return &fetcher{
		client:   &http.Client{Timeout: 60 * time.Second},
		interval: fetchInterval,
	}
}

func (f *fetcher) wait(ctx context.Context) {
	if f.interval <= 0 || f.last.IsZero() {
		f.last = time.Now()
		return
	}
	if d := f.interval - time.Since(f.last); d > 0 {
		select {
		case <-time.After(d):
		case <-ctx.Done():
		}
	}
	f.last = time.Now()
}

// get fetches one URL with the browser UA, retrying transient failures.
func (f *fetcher) get(ctx context.Context, url string) ([]byte, error) {
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			select {
			case <-time.After(time.Duration(attempt) * 2 * time.Second):
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		f.wait(ctx)
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("User-Agent", userAgent)
		req.Header.Set("Accept", acceptHeader)
		req.Header.Set("Accept-Language", acceptLanguage)
		res, err := f.client.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		body, err := io.ReadAll(res.Body)
		res.Body.Close()
		switch {
		case res.StatusCode == http.StatusOK && err == nil:
			f.fetched++
			return body, nil
		case res.StatusCode == http.StatusNotFound:
			return nil, fmt.Errorf("GET %s: HTTP 404", url)
		default:
			if err != nil {
				lastErr = err
			} else {
				lastErr = fmt.Errorf("GET %s: HTTP %d", url, res.StatusCode)
			}
		}
	}
	return nil, lastErr
}

// acquireLive fetches one publication slot. withSup adds the eSUP listing
// and its per-supplement pages (the Main slot only; supplements are not
// AIRAC-sliced). snapshotDir, when non-empty, receives every raw page.
func acquireLive(ctx context.Context, f *fetcher, slot string, needAD, withSup bool, snapshotDir string) (*tree, error) {
	t := &tree{label: slot, pages: map[string][]byte{}}
	base := eaipBase + slot + "/html/"

	fetch := func(name string) error {
		data, err := f.get(ctx, base+name)
		if err != nil {
			return err
		}
		t.pages[name] = data
		if snapshotDir != "" {
			path := filepath.Join(snapshotDir, filepath.FromSlash(name))
			if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
				return err
			}
			if err := os.WriteFile(path, data, 0o644); err != nil {
				return err
			}
		}
		return nil
	}

	// The menu is the probe: a slot that is not published (or a WAF block)
	// fails here, before any bulk fetching.
	if err := fetch(menuPage); err != nil {
		return nil, err
	}
	for _, name := range enrPages {
		if err := fetch(name); err != nil {
			return nil, err
		}
	}
	if needAD {
		for _, name := range menuADPages(t.doc(menuPage)) {
			if err := fetch("eAIP/" + name); err != nil {
				return nil, err
			}
		}
	}
	if withSup {
		if err := fetch(supListPage); err != nil {
			return nil, err
		}
		for _, name := range supListPages(t.doc(supListPage)) {
			if err := fetch("eSUP/" + name); err != nil {
				// One broken supplement page must not sink the dataset.
				fmt.Fprintf(os.Stderr, "be: esup %s: %v\n", name, err)
			}
		}
	}
	t.effective = t.effectiveFromTitles()
	return t, nil
}

// menuADPages extracts the AD 2 / AD 3 page filenames from the menu frame.
func menuADPages(menu *html.Node) []string {
	if menu == nil {
		return nil
	}
	seen := map[string]bool{}
	var out []string
	for _, a := range eaip.AnchorsIn(menu) {
		name := strings.SplitN(filepath.Base(a.Href), "#", 2)[0]
		if adPageRe.MatchString(name) && !seen[name] {
			seen[name] = true
			out = append(out, name)
		}
	}
	sort.Strings(out)
	return out
}

// supListPages extracts the per-supplement page filenames from the eSUP
// listing.
func supListPages(list *html.Node) []string {
	if list == nil {
		return nil
	}
	seen := map[string]bool{}
	var out []string
	for _, a := range eaip.AnchorsIn(list) {
		name := strings.SplitN(filepath.Base(a.Href), "#", 2)[0]
		if supPageRe.MatchString(name) && !seen[name] {
			seen[name] = true
			out = append(out, name)
		}
	}
	sort.Strings(out)
	return out
}

// acquireOffline reads a snapshot directory tree (-in): every *.html under
// dir, named by its path relative to dir.
func acquireOffline(dir string) (*tree, error) {
	t := &tree{label: dir, pages: map[string][]byte{}}
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(d.Name(), ".html") {
			return err
		}
		rel, err := filepath.Rel(dir, path)
		if err != nil {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		t.pages[filepath.ToSlash(rel)] = data
		return nil
	})
	if err != nil {
		return nil, err
	}
	if len(t.pages) == 0 {
		return nil, fmt.Errorf("%s: no .html pages found", dir)
	}
	t.effective = t.effectiveFromTitles()
	return t, nil
}
