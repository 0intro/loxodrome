// fetch.go: HTTP plumbing for the FAA FeatureServers. Each layer caps
// each response at 2,000 features, so we ask the layer for its row count
// and then walk /query?resultOffset=N&resultRecordCount=500 until we hold
// that many, refusing to write a layer that came back short. The shared
// HTTP retry envelope lives in internal/overlay.

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/overlay"
)

// faaPageSize is well below the FeatureServer's documented maxRecordCount
// (2000); the Class_Airspace layer in particular 504s on full-size pages,
// so we ask for quarter-pages to stay inside the server's time budget.
// The loop terminator still trips when a page comes back short.
const faaPageSize = 500

// maxThrottleWaits bounds the quota waits per layer, so a service that
// is genuinely stuck fails instead of looping for the whole timeout.
const maxThrottleWaits = 20

// defaultThrottleWait is what we wait when the service does not say.
const defaultThrottleWait = 60 * time.Second

// retryAfterRe reads the "Retry after N sec" the quota error carries.
var retryAfterRe = regexp.MustCompile(`(?i)retry after\s+(\d+)\s*sec`)

// retryAfter picks the wait the service asked for, with a little slack so
// the next request lands after the window rather than on its edge.
func retryAfter(message string, details []string) time.Duration {
	for _, s := range append([]string{message}, details...) {
		if m := retryAfterRe.FindStringSubmatch(s); m != nil {
			if n, err := strconv.Atoi(m[1]); err == nil && n > 0 {
				return time.Duration(n)*time.Second + 5*time.Second
			}
		}
	}
	return defaultThrottleWait
}

// fetchFAACount asks the layer how many rows it holds. The paginator
// checks itself against this, because a short page is not a reliable
// end-of-data signal: the server can answer one under load, and the
// walk would then stop early and yield a truncated layer that still
// looks well-formed.
func fetchFAACount(ctx context.Context, base, where string) (int, error) {
	q := url.Values{}
	q.Set("where", where)
	q.Set("returnCountOnly", "true")
	q.Set("f", "json")
	body, err := overlay.HTTPGetAll(ctx, base+"?"+q.Encode())
	if err != nil {
		return 0, err
	}
	var res struct {
		Count *int `json:"count"`
	}
	if err := json.Unmarshal(body, &res); err != nil {
		return 0, fmt.Errorf("decode count: %w", err)
	}
	if res.Count == nil {
		return 0, fmt.Errorf("count absent from %s", base)
	}
	return *res.Count, nil
}

// fetchFAAPaginated downloads a complete FeatureServer layer by paging
// through /query?where=1=1. The pages are stitched back into one GeoJSON
// FeatureCollection so parseFAA can ingest them uniformly.
func fetchFAAPaginated(ctx context.Context, base string) ([]byte, error) {
	return fetchFAAWhere(ctx, base, "1=1")
}

// fetchFAAWhere is fetchFAAPaginated with a server-side filter, which is
// what keeps the Digital Obstacle File to the rows worth committing: the
// full layer is 652 525 obstacles and the height floor cuts it to a
// national set the size of Spain's.
func fetchFAAWhere(ctx context.Context, base, where string) ([]byte, error) {
	want, err := fetchFAACount(ctx, base, where)
	if err != nil {
		return nil, err
	}

	combined := struct {
		Type     string            `json:"type"`
		Features []json.RawMessage `json:"features"`
	}{Type: "FeatureCollection"}
	throttled := 0

	for offset := 0; ; offset += faaPageSize {
		q := url.Values{}
		q.Set("where", where)
		q.Set("outFields", "*")
		q.Set("f", "geojson")
		q.Set("resultOffset", strconv.Itoa(offset))
		q.Set("resultRecordCount", strconv.Itoa(faaPageSize))

		u := base + "?" + q.Encode()
		body, err := overlay.HTTPGetAll(ctx, u)
		if err != nil {
			return nil, err
		}
		var page struct {
			Features []json.RawMessage `json:"features"`
			// An ArcGIS error comes back as HTTP 200 with an error
			// object and no features. Left undetected it reads as an
			// empty page, which ends the walk and reports a bare
			// "paged short" instead of what the server actually said.
			Error *struct {
				Code    int      `json:"code"`
				Message string   `json:"message"`
				Details []string `json:"details"`
			} `json:"error"`
		}
		if err := json.Unmarshal(body, &page); err != nil {
			return nil, fmt.Errorf("decode page at offset %d: %w", offset, err)
		}
		if page.Error != nil {
			// 429 is a per-minute request-unit quota, not a failure: the
			// service says how long to wait and then serves the same page
			// happily. It arrives as HTTP 200 with an error object, so the
			// shared HTTP retry envelope never sees it and the wait has to
			// happen here. Building every US dataset in one run reaches the
			// quota routinely.
			if page.Error.Code == 429 && throttled < maxThrottleWaits {
				throttled++
				wait := retryAfter(page.Error.Message, page.Error.Details)
				fmt.Fprintf(os.Stderr, "%s: quota reached at offset %d, waiting %s (%d/%d)\n",
					base, offset, wait, throttled, maxThrottleWaits)
				select {
				case <-time.After(wait):
				case <-ctx.Done():
					return nil, ctx.Err()
				}
				offset -= faaPageSize // retry the same page
				continue
			}
			return nil, fmt.Errorf("%s at offset %d: server error %d: %s %s",
				base, offset, page.Error.Code, page.Error.Message,
				strings.Join(page.Error.Details, "; "))
		}
		combined.Features = append(combined.Features, page.Features...)
		// The row count is the terminator, not the page shape. A short
		// page used to end the walk, but the server answers one under
		// load without setting exceededTransferLimit, and the layer then
		// came back quietly truncated: one measured run stopped at 3463
		// of 6061 Class_Airspace rows and still exited 0.
		if len(combined.Features) >= want {
			break
		}
		// A page with nothing in it cannot advance the walk, so stop
		// rather than spin; the count check below turns it into an error.
		if len(page.Features) == 0 {
			break
		}
	}
	if got := len(combined.Features); got != want {
		return nil, fmt.Errorf("%s: collected %d of %d rows; the layer paged short", base, got, want)
	}
	return json.Marshal(combined)
}
