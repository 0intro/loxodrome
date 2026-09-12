// supaip_fetch.go: acquire the ENAIRE supplement corpus. Two modes,
// mirroring cmd/be: live from aip.enaire.es (throttled, optionally
// snapshotting every document), or offline from a snapshot directory,
// which is what the Go tests read.
//
// A supplement whose document cannot be fetched degrades to a
// geometry-less row rather than sinking the run: the listing entry is
// still worth publishing (its subject, validity and links reach the
// panel and the NOTAM chips), and one 404 must not cost the dataset.

package main

import (
	"context"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/eaip"
)

const (
	esSupListEs = "Suplementos-es.html"
	esSupListEn = "Suplementos-en.html"

	// aip.enaire.es answers a default Go client, but the site is a
	// public AIP served to browsers and the courtesy costs nothing; the
	// load is ~240 small documents a week, paced by esFetchInterval.
	esUserAgent     = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0"
	esAcceptHeader  = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
	esFetchInterval = 200 * time.Millisecond
)

// esCorpus is one acquired supplement corpus: the two listings plus every
// supplement document, keyed by its file name.
type esCorpus struct {
	listingEs []byte
	listingEn []byte
	docs      map[string][]byte
}

func newEsCorpus() *esCorpus { return &esCorpus{docs: map[string][]byte{}} }

// doc returns a fetched document by URL, with the file name it was found
// under. A supplement published only as a PDF may be carried as a
// pre-rendered `pdftotext -layout` capture beside it (the .txt sibling),
// which is what the Go tests hold instead of a PDF binary: the name is
// returned so the caller knows which reader to use.
func (c *esCorpus) doc(url string) ([]byte, string) {
	if url == "" {
		return nil, ""
	}
	name := path.Base(url)
	if data, ok := c.docs[name]; ok {
		return data, name
	}
	if ext := path.Ext(name); ext == ".pdf" {
		alt := strings.TrimSuffix(name, ext) + ".txt"
		if data, ok := c.docs[alt]; ok {
			return data, alt
		}
	}
	return nil, ""
}

type esFetcher struct {
	client   *http.Client
	interval time.Duration
	last     time.Time
	fetched  int
}

func newEsFetcher() *esFetcher {
	return &esFetcher{client: &http.Client{Timeout: 60 * time.Second}, interval: esFetchInterval}
}

func (f *esFetcher) wait(ctx context.Context) {
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

func (f *esFetcher) get(ctx context.Context, url string) ([]byte, error) {
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
		req.Header.Set("User-Agent", esUserAgent)
		req.Header.Set("Accept", esAcceptHeader)
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

// acquireEsSupLive fetches both listings and every supplement document
// they link. snapshotDir, when non-empty, receives every raw file.
func acquireEsSupLive(ctx context.Context, snapshotDir string) (*esCorpus, []esListingRow, error) {
	f := newEsFetcher()
	c := newEsCorpus()

	save := func(name string, data []byte) error {
		if snapshotDir == "" {
			return nil
		}
		if err := os.MkdirAll(snapshotDir, 0o755); err != nil {
			return err
		}
		return os.WriteFile(filepath.Join(snapshotDir, name), data, 0o644)
	}

	var err error
	if c.listingEs, err = f.get(ctx, esAipBase+esSupListEs); err != nil {
		return nil, nil, fmt.Errorf("supplement listing: %w", err)
	}
	if err := save(esSupListEs, c.listingEs); err != nil {
		return nil, nil, err
	}
	if c.listingEn, err = f.get(ctx, esAipBase+esSupListEn); err != nil {
		// The English listing only supplies the English subjects; the
		// dataset is still publishable without it.
		fmt.Fprintf(os.Stderr, "es: english supplement listing: %v\n", err)
	} else if err := save(esSupListEn, c.listingEn); err != nil {
		return nil, nil, err
	}

	rows, warns := parseEsListings(parseOrNil(c.listingEs), parseOrNil(c.listingEn))
	for _, w := range warns {
		fmt.Fprintf(os.Stderr, "es: supplement listing: %s\n", w)
	}
	for _, r := range rows {
		url := r.bodyURL()
		if url == "" {
			continue
		}
		data, err := f.get(ctx, url)
		if err != nil {
			fmt.Fprintf(os.Stderr, "es: sup %s: %v\n", r.title(), err)
			continue
		}
		c.docs[path.Base(url)] = data
		if err := save(path.Base(url), data); err != nil {
			return nil, nil, err
		}
	}
	return c, rows, nil
}

// acquireEsSupOffline reads a snapshot directory: the two listings plus
// every supplement document beside them.
func acquireEsSupOffline(dir string) (*esCorpus, []esListingRow, error) {
	c := newEsCorpus()
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		name := d.Name()
		if !strings.HasSuffix(name, ".html") && !strings.HasSuffix(name, ".pdf") && !strings.HasSuffix(name, ".txt") {
			return nil
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		switch name {
		case esSupListEs:
			c.listingEs = data
		case esSupListEn:
			c.listingEn = data
		default:
			c.docs[name] = data
		}
		return nil
	})
	if err != nil {
		return nil, nil, err
	}
	if c.listingEs == nil && c.listingEn == nil {
		return nil, nil, fmt.Errorf("no supplement listing in %s", dir)
	}
	rows, warns := parseEsListings(parseOrNil(c.listingEs), parseOrNil(c.listingEn))
	for _, w := range warns {
		fmt.Fprintf(os.Stderr, "es: supplement listing: %s\n", w)
	}
	return c, rows, nil
}

func parseOrNil(data []byte) *eaip.Node {
	if len(data) == 0 {
		return nil
	}
	doc, err := eaip.ParseHTML(data)
	if err != nil {
		return nil
	}
	return doc
}
