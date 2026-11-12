// fetch.go asks IGN's WMTS for the tiles.
//
// The Géoplateforme CGU list the WMTS as "Non soumis à limite d'usage" and
// keep the right to block an abusive client, so the harvest is deliberately
// slow and honest: one shared limiter for every request (retries included),
// a User-Agent naming the project, Retry-After obeyed and a 429 or 503
// pausing every worker, and a stop at the first 403. It runs once a quarter
// on one machine, where a device-side download would be thousands.
//
// A 400 is retried like a 5xx, not taken as final: on 2026-10-01 IGN's load
// balancer answered one tile 400, 85,000 tiles into the first harvest, and
// the same request answered 200 a minute later. A request that is really
// malformed fails every attempt, then every tile, and the breaker stops the
// run.

package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	wmtsEndpoint = "https://data.geopf.fr/wmts"
	wmtsLayer    = "GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2"
	wmtsStyle    = "normal"
	// wmtsMatrixSet is the name the capabilities list for this layer. The
	// bare "PM" answers the same bytes today (checked 2026-10-01), but it is
	// not advertised for Plan IGN, and the advertised name is the contract.
	wmtsMatrixSet = "PM_0_19"
	wmtsFormat    = "image/png"

	userAgent = "Loxodrome-planign/1 (+https://loxodrome.fr; https://github.com/0intro/loxodrome)"

	// maxTileBytes refuses a runaway body. A Plan IGN tile is under 120 KB.
	maxTileBytes = 4 << 20
	// attemptTimeout bounds one request, headers and body.
	attemptTimeout = 60 * time.Second
)

// tileURL is the GetTile request for t. The query is spelled as the app's
// live layer spells it (src/lib/map/baseLayers.ts).
func tileURL(base string, t tile) string {
	return fmt.Sprintf("%s?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=%s&STYLE=%s&FORMAT=%s&TILEMATRIXSET=%s&TILEMATRIX=%d&TILEROW=%d&TILECOL=%d",
		base, wmtsLayer, wmtsStyle, wmtsFormat, wmtsMatrixSet, t.z, t.y, t.x)
}

// fatalError is an answer that ends the harvest: a 403 is IGN refusing this
// client, a 401 a service that wants a key Plan IGN never needed. Retrying
// either is exactly what a polite client must not do.
type fatalError struct {
	tile   tile
	status int
}

func (e *fatalError) Error() string {
	return fmt.Sprintf("%s: IGN answered HTTP %d; stopping", e.tile, e.status)
}

// fetcher makes the requests: the limiter, the pause and the retries.
type fetcher struct {
	base     string
	client   *http.Client
	interval time.Duration // between two requests, all workers together
	attempts int
	backoff  time.Duration

	mu    sync.Mutex
	next  time.Time // the next free request slot
	until time.Time // no request before this (a 429 or 503 pause)
}

func newFetcher(base string, rate float64, concurrency int) *fetcher {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	// The default keeps two idle connections per host, which at eight in
	// flight would open a new TLS session for most requests.
	tr.MaxIdleConnsPerHost = concurrency
	return &fetcher{
		base:     base,
		client:   &http.Client{Transport: tr, Timeout: attemptTimeout},
		interval: time.Duration(float64(time.Second) / rate),
		attempts: 4,
		backoff:  2 * time.Second,
	}
}

// wait blocks until this request may go out.
func (f *fetcher) wait(ctx context.Context) error {
	f.mu.Lock()
	now := time.Now()
	slot := f.next
	if slot.Before(now) {
		slot = now
	}
	if f.until.After(slot) {
		slot = f.until
	}
	f.next = slot.Add(f.interval)
	f.mu.Unlock()
	return sleepCtx(ctx, time.Until(slot))
}

// pause holds every worker for d.
func (f *fetcher) pause(d time.Duration) {
	f.mu.Lock()
	if until := time.Now().Add(d); until.After(f.until) {
		f.until = until
	}
	f.mu.Unlock()
}

// get fetches one tile. It returns the PNG body for a present tile, a nil
// body and nil error for an absent one (404), a *fatalError to stop, or an
// error once the retries are spent.
func (f *fetcher) get(ctx context.Context, t tile) ([]byte, error) {
	u := tileURL(f.base, t)
	backoff := f.backoff
	var last error
	for attempt := 1; attempt <= f.attempts; attempt++ {
		if err := f.wait(ctx); err != nil {
			return nil, err
		}
		body, status, retryAfter, err := f.once(ctx, u)
		if err == nil {
			switch {
			case status == http.StatusOK:
				return body, nil
			case status == http.StatusNotFound:
				return nil, nil
			case status == http.StatusUnauthorized || status == http.StatusForbidden:
				return nil, &fatalError{tile: t, status: status}
			case status != http.StatusTooManyRequests && status != http.StatusBadRequest && status < 500:
				return nil, fmt.Errorf("%s: HTTP %d", t, status)
			}
			last = fmt.Errorf("%s: HTTP %d", t, status)
		} else {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			last = fmt.Errorf("%s: %w", t, err)
		}
		wait := max(backoff, retryAfter)
		if status == http.StatusTooManyRequests || status == http.StatusServiceUnavailable {
			f.pause(wait)
		}
		if attempt == f.attempts {
			break
		}
		if err := sleepCtx(ctx, wait); err != nil {
			return nil, err
		}
		backoff *= 2
	}
	return nil, last
}

// once is a single request. A 200 that is not a PNG (a portal, an error
// page served with the wrong status) comes back as an error, so it is
// retried and never cached as a tile.
func (f *fetcher) once(ctx context.Context, u string) ([]byte, int, time.Duration, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, 0, 0, err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", wmtsFormat)
	res, err := f.client.Do(req)
	if err != nil {
		return nil, 0, 0, err
	}
	defer res.Body.Close()
	retryAfter := parseRetryAfter(res.Header.Get("Retry-After"), time.Now())
	body, err := io.ReadAll(io.LimitReader(res.Body, maxTileBytes+1))
	if err != nil {
		return nil, res.StatusCode, retryAfter, err
	}
	if len(body) > maxTileBytes {
		return nil, res.StatusCode, retryAfter, fmt.Errorf("body over %d bytes", maxTileBytes)
	}
	if res.StatusCode == http.StatusOK && !strings.HasPrefix(res.Header.Get("Content-Type"), wmtsFormat) {
		return nil, res.StatusCode, retryAfter, fmt.Errorf("answered %q, not %s", res.Header.Get("Content-Type"), wmtsFormat)
	}
	return body, res.StatusCode, retryAfter, nil
}

// parseRetryAfter reads either form of the header: seconds or an HTTP date.
func parseRetryAfter(v string, now time.Time) time.Duration {
	v = strings.TrimSpace(v)
	if v == "" {
		return 0
	}
	if s, err := strconv.Atoi(v); err == nil && s > 0 {
		return time.Duration(s) * time.Second
	}
	if t, err := http.ParseTime(v); err == nil && t.After(now) {
		return t.Sub(now)
	}
	return 0
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return ctx.Err()
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// breaker stops a harvest that is failing rather than one that is slow:
// twenty failed tiles in a row, or more than 2 % of the last 500, mean IGN
// is down or refusing us, and pressing on would only add load and holes.
type breaker struct {
	mu      sync.Mutex
	run     int
	window  [500]bool
	n, pos  int
	failed  int
	tripped error
}

const (
	breakerRun   = 20
	breakerRatio = 0.02
)

// record notes an outcome and reports an error once the breaker trips.
func (b *breaker) record(failed bool) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.tripped != nil {
		return b.tripped
	}
	if failed {
		b.run++
	} else {
		b.run = 0
	}
	if b.n == len(b.window) && b.window[b.pos] {
		b.failed--
	}
	b.window[b.pos] = failed
	if failed {
		b.failed++
	}
	b.pos = (b.pos + 1) % len(b.window)
	if b.n < len(b.window) {
		b.n++
	}
	switch {
	case b.run >= breakerRun:
		b.tripped = fmt.Errorf("%d tiles failed in a row", b.run)
	case b.n == len(b.window) && float64(b.failed)/float64(b.n) > breakerRatio:
		b.tripped = fmt.Errorf("%d of the last %d tiles failed", b.failed, b.n)
	}
	return b.tripped
}

var errIncomplete = errors.New("harvest incomplete")
