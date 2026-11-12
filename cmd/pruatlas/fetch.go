// fetch.go: HTTP plumbing for pruatlas. pruatlas serves a single static
// GeoJSON file off GitHub Pages; one GET and we're done. The companion
// discoverLatestPruURL hits the GitHub Contents API to find the newest
// ir-NNN.geojson so we never serve stale cycles.

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"

	"github.com/0intro/loxodrome/internal/overlay"
)

// pruatlasContentsURL lists inst/extdata via the GitHub Contents API. It's
// public, no auth required, and returns a JSON array of file metadata
// including download URLs. (60 req/hour anonymous; nowhere near a worry
// for a weekly cron.)
const pruatlasContentsURL = "https://api.github.com/repos/euctrl-pru/pruatlas/contents/inst/extdata"

func fetchPruatlas(ctx context.Context, u string) ([]byte, error) {
	return overlay.HTTPGetAll(ctx, u)
}

// discoverLatestPruURL asks the GitHub Contents API for inst/extdata and
// returns the URL of the highest-numbered ir-NNN.geojson; pruatlas's
// AIRAC-cycle file convention. On any error (rate-limit, GitHub down,
// schema change) the caller should fall back to its pinned default. The
// pinned default is the safety net, not the primary path.
func discoverLatestPruURL(ctx context.Context) (string, int, error) {
	body, err := overlay.HTTPGetAll(ctx, pruatlasContentsURL)
	if err != nil {
		return "", 0, err
	}
	var items []struct {
		Name        string `json:"name"`
		DownloadURL string `json:"download_url"`
	}
	if err := json.Unmarshal(body, &items); err != nil {
		return "", 0, fmt.Errorf("decode pruatlas contents listing: %w", err)
	}
	re := regexp.MustCompile(`^ir-(\d+)\.geojson$`)
	bestCycle := 0
	bestURL := ""
	for _, it := range items {
		m := re.FindStringSubmatch(it.Name)
		if len(m) != 2 {
			continue
		}
		n, err := strconv.Atoi(m[1])
		if err != nil {
			continue
		}
		if n > bestCycle {
			bestCycle = n
			bestURL = it.DownloadURL
		}
	}
	if bestCycle == 0 {
		return "", 0, fmt.Errorf("no ir-NNN.geojson found in inst/extdata")
	}
	return bestURL, bestCycle, nil
}
