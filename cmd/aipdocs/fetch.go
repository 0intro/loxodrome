// fetch.go pulls the PDFs, through a content cache on disk.
//
// The cache is what makes a scheduled rebuild polite. A supplement's URL is
// stable, so a weekly SUP build re-fetches only what the SIA has added
// since; the plates rotate with the AIRAC cycle, so their cache is keyed by
// cycle and a rebuild inside one cycle costs nothing. Without it every run
// would pull the same 430 MB off a government file server.

package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sync"

	"github.com/0intro/loxodrome/internal/overlay"
)

// browserUA identifies the fetch as a browser. The SIA's front end answers
// plain library clients inconsistently (cmd/be found the same WAF 403ing
// generic clients outright), and a plate that 404s for the wrong reason
// would land in the pack's `missing` list as though the SIA had retired it.
const browserUA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
	"(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"

// pdfMagic opens every PDF. The SIA answers a missing file with a 404
// carrying an HTML error page, and its WAF can answer a challenge page with
// a 200, so the body is checked rather than the status alone: a pack must
// never hand a pilot an error page named AD-2.LFPN.pdf.
var pdfMagic = []byte("%PDF")

// fetched is one document's outcome.
type fetched struct {
	ref     docRef
	path    string // cached file, empty when the document is missing
	missing bool   // the source does not publish it (404 or not a PDF)
	err     error  // a real failure: retries exhausted, disk, context
}

// fetcher pulls documents concurrently into a cache directory.
type fetcher struct {
	dir         string
	concurrency int
}

// get returns the cached path for one document, fetching it when absent.
func (f *fetcher) get(ctx context.Context, ref docRef) fetched {
	dst := filepath.Join(f.dir, ref.Name)
	if info, err := os.Stat(dst); err == nil && info.Size() > 0 {
		return fetched{ref: ref, path: dst}
	}
	body, err := overlay.HTTPGetAllWithHeaders(ctx, ref.URL, map[string]string{
		"User-Agent": browserUA,
		"Accept":     "application/pdf,*/*",
	})
	if err != nil {
		var status *overlay.StatusError
		if errors.As(err, &status) && status.Status == http.StatusNotFound {
			return fetched{ref: ref, missing: true}
		}
		return fetched{ref: ref, err: err}
	}
	if !bytes.HasPrefix(body, pdfMagic) {
		return fetched{ref: ref, missing: true}
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return fetched{ref: ref, err: err}
	}
	// Write beside the target and rename, so an interrupted run cannot
	// leave a half-written PDF that the next one adopts from the cache.
	tmp := dst + ".part"
	if err := os.WriteFile(tmp, body, 0o644); err != nil {
		return fetched{ref: ref, err: err}
	}
	if err := os.Rename(tmp, dst); err != nil {
		return fetched{ref: ref, err: err}
	}
	return fetched{ref: ref, path: dst}
}

// all fetches every reference, at most concurrency at a time, and returns
// the outcomes in the input's order so a build is reproducible.
func (f *fetcher) all(ctx context.Context, refs []docRef, progress func(done, total int)) []fetched {
	out := make([]fetched, len(refs))
	sem := make(chan struct{}, f.concurrency)
	var wg sync.WaitGroup
	var mu sync.Mutex
	done := 0

	for i, ref := range refs {
		wg.Add(1)
		go func(i int, ref docRef) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				out[i] = fetched{ref: ref, err: ctx.Err()}
				return
			}
			defer func() { <-sem }()
			out[i] = f.get(ctx, ref)
			mu.Lock()
			done++
			n := done
			mu.Unlock()
			if progress != nil {
				progress(n, len(refs))
			}
		}(i, ref)
	}
	wg.Wait()
	return out
}

// firstError reports the first genuine failure among the outcomes, so a
// build stops rather than shipping a pack with documents silently absent.
func firstError(results []fetched) error {
	for _, r := range results {
		if r.err != nil {
			return fmt.Errorf("%s: %w", r.ref.Name, r.err)
		}
	}
	return nil
}
