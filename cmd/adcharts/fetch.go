package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

// errNotFound marks an HTTP 404, so the caller can tell "next cycle not
// published yet" (expected outside the pre-release window) from a failure.
var errNotFound = errors.New("HTTP 404")

type fetcher struct {
	client   *http.Client
	interval time.Duration
	last     time.Time
	fetched  int
}

func newFetcher(interval time.Duration) *fetcher {
	return &fetcher{
		client:   &http.Client{Timeout: 60 * time.Second},
		interval: interval,
	}
}

// wait paces requests at the fetcher's interval (politeness throttle).
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

// get fetches one URL, retrying transient failures with linear backoff.
// A 404 returns errNotFound immediately (the tree either exists or not).
func (f *fetcher) get(ctx context.Context, url string) ([]byte, error) {
	var lastErr error
	for attempt := 0; attempt < 4; attempt++ {
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
			return nil, fmt.Errorf("GET %s: %w", url, errNotFound)
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
