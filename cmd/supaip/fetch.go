// fetch.go: acquire SUP AIP listings and PDFs. Two modes:
//   - live: scrape the public SIA site, throttled, with a content cache so
//     re-runs only fetch new PDFs (the cache lives under local/, gitignored,
//     and is persisted across CI runs by actions/cache).
//   - offline: read a directory tree of <region>/listing.html + PDFs (the
//     /archive snapshot or a testdata mirror), no network.

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/overlay"
)

const userAgent = "loxodrome-supaip/1.0 (+https://loxodrome.fr)"

type acquireOpts struct {
	listingDir string        // offline: <dir>/<region>/listing.html
	mirrorDir  string        // offline: <dir>/<region>/*.pdf (defaults to listingDir)
	cacheDir   string        // live: content cache directory
	rate       time.Duration // live: minimum interval between requests
	// backfillYear sweeps the media store for that year's supplements the
	// listing no longer advertises; 0 (the default) skips the sweep.
	backfillYear int
	// prevRows are the previous artefact's rows, so the sweep does not re-probe
	// what retention already carries and -refresh-retained can re-parse them.
	prevRows [][]any
	// refreshRetained re-fetches and re-parses the delisted supplements, so
	// they track parser improvements instead of freezing.
	refreshRetained bool
	// retainFrom bounds which delisted supplements are worth refreshing.
	retainFrom int
}

type acquireResult struct {
	sups       []rawSup
	listingSha map[string]string
	fetched    int
	cached     int
}

// acquire gathers every supplement (PDF bytes loaded) across the five
// regions, plus per-region listing fingerprints for the meta.
func acquire(ctx context.Context, o acquireOpts) (acquireResult, error) {
	if o.listingDir != "" {
		return acquireOffline(o)
	}
	return acquireLive(ctx, o)
}

func acquireOffline(o acquireOpts) (acquireResult, error) {
	mirror := o.mirrorDir
	if mirror == "" {
		mirror = o.listingDir
	}
	res := acquireResult{listingSha: map[string]string{}}
	for _, reg := range regions {
		data, err := os.ReadFile(filepath.Join(o.listingDir, reg.key, "listing.html"))
		if err != nil {
			continue // region absent from this mirror
		}
		res.listingSha[reg.key] = sha(data)
		for _, row := range parseListing(data) {
			fn, pdf, ok := findMirrorPDF(filepath.Join(mirror, reg.key), row, "fr")
			if !ok {
				continue
			}
			_, pdfEn, _ := findMirrorPDF(filepath.Join(mirror, reg.key), row, "en")
			res.sups = append(res.sups, newRawSup(reg.key, row, fn, pdf, pdfEn))
			res.cached++
		}
	}
	return res, nil
}

// findMirrorPDF locates a row's PDF (lang "fr" or "en") in a mirror region
// directory. Filenames vary by region (lf_sup_, pacn_sup_a_, run_sup_, ...) but
// all end in "_<year>_<NNN>_<lang>.pdf".
func findMirrorPDF(dir string, row listingRow, lang string) (string, []byte, bool) {
	suffix := fmt.Sprintf("_%d_%03d_%s.pdf", row.year, row.number, lang)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", nil, false
	}
	for _, e := range entries {
		n := e.Name()
		if strings.Contains(n, "_sup") && strings.HasSuffix(n, suffix) {
			if b, err := os.ReadFile(filepath.Join(dir, n)); err == nil {
				return n, b, true
			}
		}
	}
	return "", nil, false
}

func acquireLive(ctx context.Context, o acquireOpts) (acquireResult, error) {
	cache, err := openPDFCache(o.cacheDir)
	if err != nil {
		return acquireResult{}, err
	}
	defer cache.save()
	lim := &limiter{interval: o.rate}
	res := acquireResult{listingSha: map[string]string{}}
	for _, reg := range regions {
		lim.wait(ctx)
		data, err := overlay.HTTPGetAll(ctx, siaHost+"/documents/supaip/aip/id/"+reg.id)
		if err != nil {
			return acquireResult{}, fmt.Errorf("listing %s: %w", reg.key, err)
		}
		res.listingSha[reg.key] = sha(data)
		for _, row := range parseListing(data) {
			fn, pdf, hit, err := cache.get(ctx, row.downloadURL, lim)
			if err != nil {
				fmt.Fprintf(os.Stderr, "supaip: %s %d/%d: %v\n", reg.key, row.number, row.year, err)
				continue
			}
			// The English subject lives only in the parallel _en.pdf, fetched
			// directly from the media path (best-effort; many regions are
			// French-only, so a 404 just leaves the supplement English-less).
			var pdfEn []byte
			if en := enFilename(fn); en != fn {
				if b, eerr := cache.getDirect(ctx, pdfURL(en), en, "en:", lim); eerr != nil {
					fmt.Fprintf(os.Stderr, "supaip: %s %d/%d en: %v\n", reg.key, row.number, row.year, eerr)
				} else {
					pdfEn = b
				}
			}
			res.sups = append(res.sups, newRawSup(reg.key, row, fn, pdf, pdfEn))
			if hit {
				res.cached++
			} else {
				res.fetched++
			}
		}
	}

	// The sweep runs last, so the listing has already said which numbers are
	// live and only the genuinely absent ones cost a request. It is opt-in:
	// once its result is committed, retention keeps it and the weekly run
	// stays as cheap as it was.
	listed := make(map[string]bool, len(res.sups))
	for _, s := range res.sups {
		listed[fmt.Sprintf("%s-%d-%03d", s.region, s.year, s.number)] = true
	}

	// Re-parsing the delisted supplements first means the sweep and the merge
	// both see them as present, so neither re-probes nor re-freezes them.
	if o.refreshRetained {
		fresh := refreshRetained(ctx, cache, lim, o.prevRows, o.retainFrom, listed)
		for _, s := range fresh {
			listed[fmt.Sprintf("%s-%d-%03d", s.region, s.year, s.number)] = true
		}
		res.sups = append(res.sups, fresh...)
	}

	if o.backfillYear > 0 {
		have := make(map[string]bool, len(listed))
		for k := range listed {
			have[k] = true
		}
		for _, row := range o.prevRows {
			if id := rowID(row); id != "" {
				have[id] = true
			}
		}
		swept := sweepMissing(ctx, cache, lim, o.backfillYear, have)
		res.sups = append(res.sups, swept...)
		res.fetched += len(swept)
	}
	return res, nil
}

func newRawSup(region string, row listingRow, filename string, pdf, pdfEn []byte) rawSup {
	return rawSup{
		region:    region,
		number:    row.number,
		year:      row.year,
		descFr:    row.descFr,
		validFrom: row.validFrom,
		validTo:   row.validTo,
		ifr:       row.ifr,
		vfr:       row.vfr,
		airac:     strings.Contains(filename, "_sup_a_"),
		filename:  filename,
		pdf:       pdf,
		pdfEn:     pdfEn,
	}
}

// --- live PDF cache -------------------------------------------------------

// pdfCache is a content cache keyed by the SIA download id. The manifest maps
// each id to the resolved PDF filename so a cache hit needs no HTTP at all.
type pdfCache struct {
	dir      string
	manifest map[string]string // download id -> filename
	client   *http.Client
}

func openPDFCache(dir string) (*pdfCache, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	c := &pdfCache{
		dir:      dir,
		manifest: map[string]string{},
		client:   &http.Client{Timeout: 60 * time.Second},
	}
	if b, err := os.ReadFile(filepath.Join(dir, "manifest.json")); err == nil {
		_ = json.Unmarshal(b, &c.manifest)
	}
	return c, nil
}

func (c *pdfCache) save() {
	b, err := json.MarshalIndent(c.manifest, "", "  ")
	if err == nil {
		_ = os.WriteFile(filepath.Join(c.dir, "manifest.json"), b, 0o644)
	}
}

// get returns a PDF's filename and bytes, downloading (throttled) only on a
// cache miss. hit reports whether it came from the cache.
func (c *pdfCache) get(ctx context.Context, downloadURL string, lim *limiter) (string, []byte, bool, error) {
	id := path.Base(strings.TrimRight(downloadURL, "/"))
	if fn, ok := c.manifest[id]; ok {
		if b, err := os.ReadFile(filepath.Join(c.dir, fn)); err == nil {
			return fn, b, true, nil
		}
	}
	lim.wait(ctx)
	fn, body, err := c.download(ctx, downloadURL)
	if err != nil {
		return "", nil, false, err
	}
	if err := os.WriteFile(filepath.Join(c.dir, fn), body, 0o644); err != nil {
		return "", nil, false, err
	}
	c.manifest[id] = fn
	return fn, body, false, nil
}

// getDirect fetches a PDF straight from a known media URL, caching it under
// filename. A 404 is cached as a negative so an absent file is not re-requested
// every run; it returns nil bytes (not an error). keyPrefix namespaces the
// negative cache, since the same store holds both the _en siblings and the
// backfill's probes by number.
func (c *pdfCache) getDirect(ctx context.Context, url, filename, keyPrefix string, lim *limiter) ([]byte, error) {
	key := keyPrefix + filename
	if v, ok := c.manifest[key]; ok {
		if v == enMissing {
			return nil, nil
		}
		if b, err := os.ReadFile(filepath.Join(c.dir, v)); err == nil {
			return b, nil
		}
	}
	lim.wait(ctx)
	body, status, err := c.fetchURL(ctx, url)
	if err != nil {
		return nil, err
	}
	if status == http.StatusNotFound {
		c.manifest[key] = enMissing
		return nil, nil
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("GET %s: HTTP %d", url, status)
	}
	if err := os.WriteFile(filepath.Join(c.dir, filename), body, 0o644); err != nil {
		return nil, err
	}
	c.manifest[key] = filename
	return body, nil
}

const enMissing = "404" // negative-cache marker for an absent file

// Retry envelope for the per-PDF downloads, mirroring overlay.HTTPGetAll's:
// a one-off SIA 5xx on a newly listed supplement would otherwise drop it
// from the artifact until the next scheduled run. Package vars so tests can
// shrink them.
var (
	pdfMaxAttempts = 4
	pdfBackoffBase = 2 * time.Second
)

// fetchURL GETs a URL, returning its body and status (404 is not an error).
// Transport errors and 5xx / 429 are retried with exponential backoff.
func (c *pdfCache) fetchURL(ctx context.Context, url string) ([]byte, int, error) {
	backoff := pdfBackoffBase
	var body []byte
	var status int
	var err error
	for attempt := 1; attempt <= pdfMaxAttempts; attempt++ {
		body, status, err = c.fetchURLOnce(ctx, url)
		retryable := err != nil || status == http.StatusTooManyRequests ||
			(status >= 500 && status < 600)
		if !retryable || attempt == pdfMaxAttempts {
			break
		}
		select {
		case <-ctx.Done():
			return nil, 0, ctx.Err()
		case <-time.After(backoff):
		}
		backoff *= 2
	}
	return body, status, err
}

func (c *pdfCache) fetchURLOnce(ctx context.Context, url string) ([]byte, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("User-Agent", userAgent)
	res, err := c.client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, res.StatusCode, nil
	}
	body, err := io.ReadAll(res.Body)
	return body, res.StatusCode, err
}

// download follows the /documents/download/f/d/<N> 302 to the real PDF and
// returns its filename (from the final URL) and bytes. Transport errors and
// 5xx / 429 are retried with exponential backoff.
func (c *pdfCache) download(ctx context.Context, url string) (string, []byte, error) {
	backoff := pdfBackoffBase
	var lastErr error
	for attempt := 1; attempt <= pdfMaxAttempts; attempt++ {
		fn, body, retryable, err := c.downloadOnce(ctx, url)
		if err == nil {
			return fn, body, nil
		}
		lastErr = err
		if !retryable || attempt == pdfMaxAttempts {
			break
		}
		select {
		case <-ctx.Done():
			return "", nil, ctx.Err()
		case <-time.After(backoff):
		}
		backoff *= 2
	}
	return "", nil, lastErr
}

func (c *pdfCache) downloadOnce(ctx context.Context, url string) (fn string, body []byte, retryable bool, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", nil, false, err
	}
	req.Header.Set("User-Agent", userAgent)
	res, err := c.client.Do(req)
	if err != nil {
		return "", nil, true, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		retryable = res.StatusCode == http.StatusTooManyRequests ||
			(res.StatusCode >= 500 && res.StatusCode < 600)
		return "", nil, retryable, fmt.Errorf("GET %s: HTTP %d", url, res.StatusCode)
	}
	body, err = io.ReadAll(res.Body)
	if err != nil {
		return "", nil, true, err
	}
	fn = path.Base(res.Request.URL.Path)
	if !strings.HasSuffix(strings.ToLower(fn), ".pdf") {
		return "", nil, false, fmt.Errorf("GET %s: unexpected file %q", url, fn)
	}
	return fn, body, false, nil
}

// limiter enforces a minimum interval between live requests.
type limiter struct {
	interval time.Duration
	last     time.Time
}

func (l *limiter) wait(ctx context.Context) {
	if l.interval <= 0 {
		return
	}
	if !l.last.IsZero() {
		if d := l.interval - time.Since(l.last); d > 0 {
			select {
			case <-time.After(d):
			case <-ctx.Done():
			}
		}
	}
	l.last = time.Now()
}

func sha(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
