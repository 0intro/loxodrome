// Command zsm fetches the zones of major sensitivity (ZSM) the STAC
// publishes for the large raptors' national action plans, and writes
// fr-zsm.json and fr-zsm.meta.json: each zone's buffer polygon, its
// species, whether it is active, and the height to overfly it at. AIP
// France ENR 5.6-1 sends pilots to the same page; docs/zsm-study.md holds
// the reading.
//
// Run directly or via the data-zsm GitHub workflow (daily).
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
)

const (
	// The STAC's ZSM page: it links the KML edition in force.
	pageURL = "https://www.stac.aviation-civile.gouv.fr/fr/zsm"
	// Polite identification per the cmd/supaip precedent.
	userAgent = "loxodrome-zsm/1.0 (+https://loxodrome.fr)"
	// The whole run: one page and a KML of about 1.5 MB.
	runTimeout = 5 * time.Minute
)

var httpClient = &http.Client{Timeout: time.Minute}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "zsm:", err)
		os.Exit(1)
	}
}

func run() error {
	outDir := flag.String("out", "public/data", "output directory for fr-zsm.json and fr-zsm.meta.json")
	in := flag.String("in", "", "read this KML file instead of the STAC's page and its link (offline)")
	flag.Parse()

	ctx, cancel := context.WithTimeout(context.Background(), runTimeout)
	defer cancel()

	var src []source
	edition := ""
	if *in != "" {
		body, err := os.ReadFile(*in)
		if err != nil {
			return err
		}
		src = append(src, source{url: filepath.Base(*in), body: body})
	} else {
		page, err := get(ctx, pageURL)
		if err != nil {
			return err
		}
		links := kmlLinks(page, pageURL)
		if len(links) == 0 {
			return fmt.Errorf("%s: no KML link", pageURL)
		}
		edition = editionDate(page)
		for _, u := range links {
			body, err := get(ctx, u)
			if err != nil {
				return err
			}
			src = append(src, source{url: u, body: body})
		}
	}
	artifact, meta, err := build(src, edition, time.Now)
	if err != nil {
		return err
	}
	if err := aip.WriteCompactJSON(filepath.Join(*outDir, "fr-zsm.json"), artifact); err != nil {
		return err
	}
	if err := aip.WritePrettyJSON(filepath.Join(*outDir, "fr-zsm.meta.json"), meta); err != nil {
		return err
	}
	fmt.Printf("wrote %d zones (%d active) from %d file(s); edition %s\n", meta.ZoneCount, meta.ActiveCount, len(src), meta.Edition)
	return nil
}

// get fetches u, retrying a transient failure three times.
func get(ctx context.Context, u string) ([]byte, error) {
	const attempts = 4
	backoff := 2 * time.Second
	var last error
	for i := 1; i <= attempts; i++ {
		body, status, err := getOnce(ctx, u)
		if err == nil && status == http.StatusOK {
			return body, nil
		}
		if err == nil {
			last = fmt.Errorf("GET %s: HTTP %d", u, status)
			if status != http.StatusTooManyRequests && status < 500 {
				return nil, last
			}
		} else {
			last = fmt.Errorf("GET %s: %w", u, err)
		}
		if i == attempts {
			break
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(backoff):
		}
		backoff *= 2
	}
	return nil, last
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
		return nil, 0, err
	}
	return body, res.StatusCode, nil
}
