// Command airports fetches the OurAirports CSVs and emits airports.json
// plus airports.meta.json, the worldwide airport baseline the SPA loads.
// France AIXM enrichment lives in cmd/fr (fr-airports.json); the SPA
// merges both at load time.
//
// Run directly or via the data-airports GitHub workflow.

package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
)

const (
	airportsURL    = "https://davidmegginson.github.io/ourairports-data/airports.csv"
	runwaysURL     = "https://davidmegginson.github.io/ourairports-data/runways.csv"
	frequenciesURL = "https://davidmegginson.github.io/ourairports-data/airport-frequencies.csv"
	fetchTimeout   = 60 * time.Second
)

// httpClient bounds each request (connect, headers and body read) so a
// single stalled OurAirports fetch can't hang past the per-request
// ceiling; the parent context still caps the whole concurrent batch.
var httpClient = &http.Client{Timeout: fetchTimeout}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	outDir := flag.String("out", "public/data", "output directory for airports.json and airports.meta.json (relative to the working directory; run from repo root)")
	flag.Parse()

	ctx, cancel := context.WithTimeout(context.Background(), fetchTimeout)
	defer cancel()

	bodies, err := fetchAll(ctx, airportsURL, runwaysURL, frequenciesURL)
	if err != nil {
		return err
	}
	airportsCsv, runwaysCsv, frequenciesCsv := bodies[0], bodies[1], bodies[2]

	res, err := buildArtifact(airportsCsv, Options{RunwaysCsv: runwaysCsv, FrequenciesCsv: frequenciesCsv})
	if err != nil {
		return err
	}

	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		return err
	}
	if err := aip.WriteCompactJSON(filepath.Join(*outDir, "airports.json"), res.Airports); err != nil {
		return err
	}
	if err := aip.WritePrettyJSON(filepath.Join(*outDir, "airports.meta.json"), res.Meta); err != nil {
		return err
	}

	fmt.Printf("wrote %d airports, %d runways and %d frequencies (from %d source rows; %d unknown type(s): %s)\n",
		len(res.Airports.Rows), res.Meta.RunwayCount, res.Meta.FrequencyCount, res.Meta.RawRowCount,
		len(res.Meta.UnknownTypes), joinOrNone(res.Meta.UnknownTypes))
	return nil
}

// fetchAll fetches the URLs concurrently. Returns the bodies in the same
// order, or the first error encountered.
func fetchAll(ctx context.Context, urls ...string) ([]string, error) {
	bodies := make([]string, len(urls))
	errs := make(chan error, len(urls))
	var wg sync.WaitGroup
	for i, u := range urls {
		wg.Add(1)
		go func(i int, u string) {
			defer wg.Done()
			body, err := fetch(ctx, u)
			if err != nil {
				errs <- err
				return
			}
			bodies[i] = body
		}(i, u)
	}
	wg.Wait()
	close(errs)
	if err, ok := <-errs; ok {
		return nil, err
	}
	return bodies, nil
}

func fetch(ctx context.Context, url string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	res, err := httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("fetch %s: %w", url, err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("fetch %s: HTTP %d", url, res.StatusCode)
	}
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return "", fmt.Errorf("read %s: %w", url, err)
	}
	return string(body), nil
}

func joinOrNone(s []string) string {
	if len(s) == 0 {
		return "none"
	}
	out := s[0]
	for _, v := range s[1:] {
		out += ", " + v
	}
	return out
}
