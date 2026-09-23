// Command metar fetches the worldwide NOAA AWC METAR station catalog and
// emits metar-stations.json plus metar-stations.meta.json, the static
// station metadata the SPA joins onto the live /wx observations by ident
// (positions, names, ICAO/IATA/FAA/WMO ids, country, elevation, METAR/TAF
// capability). The live METAR/TAF feed is unchanged; this only replaces the
// implicit "which stations exist and where" the old bbox tiling inferred
// from observations.
//
// Run directly or via the data-metar GitHub workflow (weekly).

package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
)

const (
	// The stationinfo data API. No CORS is needed here (server-side, unlike
	// the browser's /wx proxy), so we hit aviationweather.gov directly.
	stationInfoURL = "https://aviationweather.gov/api/data/stationinfo"
	// Polite identification per the cmd/supaip precedent.
	userAgent = "loxodrome-metar/1.0 (+https://loxodrome.fr)"
	// The whole crawl budget; a few hundred to ~2000 paced requests fit well
	// inside it.
	fetchTimeout = 25 * time.Minute
	// Per-request ceiling so one stalled response can't eat the budget.
	perRequest = 30 * time.Second
)

// httpClient bounds each attempt; the retry/backoff envelope lives in
// getWithRetry and the inter-request pace in the limiter.
var httpClient = &http.Client{Timeout: perRequest}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	outDir := flag.String("out", "public/data", "output directory for metar-stations.json and metar-stations.meta.json (relative to the working directory; run from repo root)")
	// AWC allows 100 requests/minute; 700 ms keeps us at ~85/min with margin.
	rate := flag.Duration("rate", 700*time.Millisecond, "minimum interval between AWC requests")
	flag.Parse()

	ctx, cancel := context.WithTimeout(context.Background(), fetchTimeout)
	defer cancel()

	lim := &limiter{interval: *rate}
	fetch := func(ctx context.Context, b Bbox) ([]Station, error) {
		return fetchStations(ctx, lim, b)
	}

	stations, reqs, err := crawlStations(ctx, fetch, CrawlOptions{})
	if err != nil {
		return err
	}

	res, err := buildArtifact(stations, Options{Requests: reqs})
	if err != nil {
		return err
	}

	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		return err
	}
	if err := aip.WriteCompactJSON(filepath.Join(*outDir, "metar-stations.json"), res.Catalog); err != nil {
		return err
	}
	if err := aip.WritePrettyJSON(filepath.Join(*outDir, "metar-stations.meta.json"), res.Meta); err != nil {
		return err
	}

	fmt.Printf("wrote %d METAR stations (%d with TAF, %d countries) from %d requests\n",
		res.Meta.StationCount, res.Meta.TafCount, res.Meta.CountryCount, res.Meta.Requests)
	return nil
}

// fetchStations performs one paced, retried stationinfo bbox request.
func fetchStations(ctx context.Context, lim *limiter, b Bbox) ([]Station, error) {
	lim.wait(ctx)
	u := stationInfoURL + "?format=json&bbox=" + bboxParam(b)
	body, err := getWithRetry(ctx, u)
	if err != nil {
		return nil, err
	}
	return parseStationPage(body)
}

// bboxParam formats a box as minLat,minLon,maxLat,maxLon (two decimals, the
// notam-proxy /wx convention; integer with the default 16-degree seed grid).
func bboxParam(b Bbox) string {
	f := func(v float64) string { return strconv.FormatFloat(v, 'f', 2, 64) }
	return f(b.MinLat) + "," + f(b.MinLon) + "," + f(b.MaxLat) + "," + f(b.MaxLon)
}

// getWithRetry GETs a URL with the request context, retrying transient 5xx /
// 429 responses with exponential backoff (the internal/overlay envelope,
// inlined here so we can set the User-Agent header).
func getWithRetry(ctx context.Context, u string) ([]byte, error) {
	const maxAttempts = 4
	backoff := 2 * time.Second
	var lastErr error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		body, status, err := getOnce(ctx, u)
		// 204 (and an empty 200 body) is the normal "no stations in this box"
		// answer over ocean; parseStationPage turns the empty body into [].
		if err == nil && (status == http.StatusOK || status == http.StatusNoContent) {
			return body, nil
		}
		retryable := err != nil || status == http.StatusTooManyRequests || (status >= 500 && status < 600)
		if !retryable {
			return nil, fmt.Errorf("GET %s: HTTP %d", u, status)
		}
		if err != nil {
			lastErr = fmt.Errorf("GET %s: %w", u, err)
		} else {
			lastErr = fmt.Errorf("GET %s: HTTP %d", u, status)
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

func getOnce(ctx context.Context, u string) ([]byte, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("User-Agent", userAgent)
	res, err := httpClient.Do(req)
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

// limiter enforces a minimum interval between live requests (cmd/supaip's).
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
