// http.go: HTTP plumbing shared by pruatlas and FAA fetchers. Both
// upstream styles (single static GeoJSON from GitHub, paginated FAA
// FeatureServer) flow through the same retry/backoff envelope.

package overlay

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Retry envelope for HTTPGetAll. Package vars (not consts) so tests can
// shrink the backoff and attempt count; production callers get these
// defaults.
var (
	maxAttempts = 4
	backoffBase = 2 * time.Second
	// httpClient bounds each attempt (connect, headers and body read) so
	// one hung FeatureServer page can't consume the caller's whole
	// context budget before the retry/backoff envelope reacts. It has to
	// clear the slowest page a publisher legitimately serves, not the
	// typical one: the FAA Class_Airspace layer spends about 75 s of
	// server time per 500-row page on a cold cache, so a 60 s bound timed
	// out resultOffset=500 on all four attempts and failed every
	// scheduled run. The real per-command budget is the caller's own
	// context (pruatlas allows a minute in total, FAA thirty), which
	// still cuts in first wherever it is tighter.
	httpClient = &http.Client{Timeout: 300 * time.Second}
)

// StatusError is a failed GET whose HTTP status is known, so a caller that
// treats one status specially can test for it instead of matching on
// message text. cmd/aipdocs needs the distinction: a 404 is a plate the SIA
// genuinely does not publish, which belongs in the pack's `missing` list,
// where a 5xx that outlived the retries is a build failure and must not
// quietly drop a document a pilot expects to find.
type StatusError struct {
	URL    string
	Status int
}

func (e *StatusError) Error() string {
	return fmt.Sprintf("GET %s: HTTP %d", e.URL, e.Status)
}

// HTTPGetAll performs a GET with the request's context cancellation,
// retrying transient FeatureServer 5xx responses with exponential
// backoff. The FAA Class_Airspace layer in particular routinely 504s on
// cold pages. Returns the full body on 200; the whole body is buffered
// into memory (FAA pages cap at ~5 MB, small enough to fit comfortably).
func HTTPGetAll(ctx context.Context, u string) ([]byte, error) {
	return HTTPGetAllWithHeaders(ctx, u, nil)
}

// HTTPGetAllWithHeaders is HTTPGetAll with request headers, for a site
// behind a WAF that rejects a client which does not look like a browser
// (skeyes answers 403, M-NAV 406).
func HTTPGetAllWithHeaders(ctx context.Context, u string, header map[string]string) ([]byte, error) {
	return HTTPGetAllWithClient(ctx, u, header, nil)
}

// HTTPGetAllWithClient is HTTPGetAllWithHeaders through a caller-supplied
// client, for a publisher that needs its own TLS configuration. A nil
// client is the shared one.
func HTTPGetAllWithClient(ctx context.Context, u string, header map[string]string, client *http.Client) ([]byte, error) {
	backoff := backoffBase
	var lastErr error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		body, status, err := httpGetOnce(ctx, u, header, client)
		if err == nil && status == http.StatusOK {
			return body, nil
		}
		retryable := err != nil || (status >= 500 && status < 600) || status == http.StatusTooManyRequests
		if !retryable {
			return nil, &StatusError{URL: u, Status: status}
		}
		if err != nil {
			lastErr = fmt.Errorf("GET %s: %w", u, err)
		} else {
			lastErr = &StatusError{URL: u, Status: status}
		}
		if attempt == maxAttempts {
			break
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(backoff):
		}
		backoff *= 2
	}
	return nil, lastErr
}

func httpGetOnce(ctx context.Context, u string, header map[string]string, client *http.Client) ([]byte, int, error) {
	if client == nil {
		client = httpClient
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, 0, err
	}
	for k, v := range header {
		req.Header.Set(k, v)
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, res.StatusCode, err
	}
	return body, res.StatusCode, nil
}
