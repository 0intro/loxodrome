// previous.go compares a new edition with the one already published, and
// checks the published route once an upload is done.
//
// The decision is made against what pilots are actually being served,
// read with range requests through the chart worker, never against a note
// kept by the build: the Actions cache that would hold one is evicted after
// a week unread, and a quarterly job would always find it gone.

package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/pmtiles"
)

// appOrigin is the Origin the chart worker serves archives to.
const appOrigin = "https://loxodrome.fr"

// regressionFloor is how much of an edition's tiles a zoom may lose before
// the new one is refused. A partial IGN outage answering 404 for tiles that
// exist would otherwise ship a map with holes as an update.
const regressionFloor = 0.99

var errNotPublished = errors.New("not published")

// httpReaderAt reads a remote file with range requests.
type httpReaderAt struct {
	ctx    context.Context
	client *http.Client
	url    string
}

func (h *httpReaderAt) ReadAt(p []byte, off int64) (int, error) {
	req, err := http.NewRequestWithContext(h.ctx, http.MethodGet, h.url, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Origin", appOrigin)
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", off, off+int64(len(p))-1))
	res, err := h.client.Do(req)
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusPartialContent {
		return 0, fmt.Errorf("range %d+%d: HTTP %d", off, len(p), res.StatusCode)
	}
	n, err := io.ReadFull(res.Body, p)
	if err != nil {
		return n, err
	}
	return n, nil
}

// published is what the decision needs to know of the served edition.
type published struct {
	Version string
	Digest  string
	Tiles   map[string]int
	Bytes   int64
}

// readPublished reads the served edition's metadata, or errNotPublished.
func readPublished(ctx context.Context, url string) (*published, error) {
	client := &http.Client{Timeout: 2 * time.Minute}
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Origin", appOrigin)
	req.Header.Set("User-Agent", userAgent)
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	res.Body.Close()
	if res.StatusCode == http.StatusNotFound {
		return nil, errNotPublished
	}
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HEAD %s: HTTP %d", url, res.StatusCode)
	}
	size, err := strconv.ParseInt(res.Header.Get("Content-Length"), 10, 64)
	if err != nil || size <= 0 {
		return nil, fmt.Errorf("HEAD %s: no Content-Length", url)
	}
	rd, err := pmtiles.Open(&httpReaderAt{ctx: ctx, client: client, url: url}, size)
	if err != nil {
		return nil, err
	}
	var meta struct {
		Version string         `json:"version"`
		Digest  string         `json:"loxodrome:digest"`
		Tiles   map[string]int `json:"loxodrome:tiles"`
	}
	if err := rd.Metadata(&meta); err != nil {
		return nil, err
	}
	return &published{Version: meta.Version, Digest: meta.Digest, Tiles: meta.Tiles, Bytes: size}, nil
}

// decide says whether rep should replace prev (nil when nothing is
// published). It returns "upload" or "skip", or an error refusing an edition
// that lost tiles, unless force.
func decide(prev *published, rep *report, force bool) (string, string, error) {
	if prev == nil {
		return "upload", "first edition", nil
	}
	if prev.Digest == rep.Digest && !force {
		return "skip", "the published edition of " + prev.Version + " shows the same tiles", nil
	}
	for z, before := range prev.Tiles {
		n, err := strconv.Atoi(z)
		if err != nil || n < 8 || before == 0 {
			continue
		}
		after := rep.PerZoom[z]
		if float64(after) < float64(before)*regressionFloor && !force {
			return "", "", fmt.Errorf("zoom %s holds %d tiles where the published edition holds %d: refusing (an IGN outage answering 404?); -force overrides", z, after, before)
		}
	}
	if prev.Digest == rep.Digest {
		return "upload", "forced", nil
	}
	return "upload", "the tiles changed since the edition of " + prev.Version, nil
}

// checkPublished checks the served route after an upload: what the app's
// downloader needs (a HEAD with size and ETag, CORS for the app, a single
// range answered 206), that a foreign Origin is refused, and that the
// served edition is the one just built.
func checkPublished(ctx context.Context, url string, want *report) error {
	client := &http.Client{Timeout: 2 * time.Minute}
	do := func(method, origin, rng string) (*http.Response, error) {
		req, err := http.NewRequestWithContext(ctx, method, url, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("User-Agent", userAgent)
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		if rng != "" {
			req.Header.Set("Range", rng)
		}
		res, err := client.Do(req)
		if err != nil {
			return nil, err
		}
		res.Body.Close()
		return res, nil
	}
	var problems []string
	head, err := do(http.MethodHead, appOrigin, "")
	if err != nil {
		return err
	}
	if head.StatusCode != http.StatusOK {
		problems = append(problems, fmt.Sprintf("HEAD: HTTP %d", head.StatusCode))
	}
	if got := head.Header.Get("Content-Length"); got != strconv.FormatInt(want.Bytes, 10) {
		problems = append(problems, fmt.Sprintf("Content-Length %q, want %d", got, want.Bytes))
	}
	if head.Header.Get("ETag") == "" {
		problems = append(problems, "no ETag")
	}
	if got := head.Header.Get("Access-Control-Allow-Origin"); got != appOrigin {
		problems = append(problems, fmt.Sprintf("Access-Control-Allow-Origin %q", got))
	}
	if !strings.Contains(head.Header.Get("Access-Control-Expose-Headers"), "Content-Range") {
		problems = append(problems, "Content-Range not exposed")
	}
	if foreign, err := do(http.MethodHead, "https://example.org", ""); err != nil {
		return err
	} else if foreign.StatusCode != http.StatusForbidden {
		problems = append(problems, fmt.Sprintf("a foreign Origin got HTTP %d, want 403", foreign.StatusCode))
	}
	tail, err := do(http.MethodGet, appOrigin, fmt.Sprintf("bytes=%d-", want.Bytes-16))
	if err != nil {
		return err
	}
	if tail.StatusCode != http.StatusPartialContent ||
		tail.Header.Get("Content-Range") != fmt.Sprintf("bytes %d-%d/%d", want.Bytes-16, want.Bytes-1, want.Bytes) {
		problems = append(problems, fmt.Sprintf("range: HTTP %d, Content-Range %q", tail.StatusCode, tail.Header.Get("Content-Range")))
	}
	prev, err := readPublished(ctx, url)
	if err != nil {
		return err
	}
	if prev.Digest != want.Digest {
		problems = append(problems, fmt.Sprintf("served digest %s, built %s", prev.Digest, want.Digest))
	}
	if len(problems) > 0 {
		return fmt.Errorf("%s: %s", url, strings.Join(problems, "; "))
	}
	return nil
}
