// Command ukcharts scrapes the NATS UK eAIP per-aerodrome pages (AD 2
// aerodromes, AD 3 heliports) for their chart lists and writes
// uk-adcharts.json, the UK counterpart of fr-adcharts.json (cmd/adcharts):
// per aerodrome, the published charts as [code, title, path] rows. NATS
// names its chart files with opaque per-amendment numbers
// (graphics/487994.pdf), so the family and description come from the
// AD 2.24 table titles, mapped by keyword. The stored path is relative to
// the AIRAC-root URL, and the app rebuilds absolute URLs against the cycle
// in force at render (the dated tree rotates every 28 days, no stable
// alias). Re-scraped per cycle like cmd/adcharts.
//
// cmd/uk stays the AIXM decoder; this is a separate scraper because the
// two read entirely different sources.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
)

const (
	natsHost = "https://www.aurora.nats.co.uk"

	// userAgent presents a mainstream-browser header set: the NATS site
	// serves the eAIP behind a filter that turns away non-browser clients.
	userAgent      = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0"
	acceptHeader   = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
	acceptLanguage = "en-US,en;q=0.5"
)

func main() {
	log.SetFlags(0)
	log.SetPrefix("ukcharts: ")
	if err := run(context.Background()); err != nil {
		log.Fatal(err)
	}
}

// eaipBase returns the AIRAC-root URL of the NATS eAIP for one effective
// date (trailing slash). Mirrors natsEaipBase in
// src/lib/data/airports.ts, which builds the same base at render.
func eaipBase(effective time.Time) string {
	return fmt.Sprintf("%s/htmlAIP/Publications/%s-AIRAC/", natsHost, aip.AiracISO(effective))
}

func run(ctx context.Context) error {
	outDir := flag.String("out", "public/data", "output directory")
	rate := flag.Duration("rate", 500*time.Millisecond, "minimum interval between NATS requests")
	only := flag.String("only", "", "comma-separated ICAO filter (debug; skips the sanity floors)")
	minAerodromes := flag.Int("min-aerodromes", 60, "sanity floor: aerodromes with charts")
	minCharts := flag.Int("min-charts", 1000, "sanity floor: total charts")
	skipNext := flag.Bool("skip-next", false, "scrape the current cycle only")
	flag.Parse()

	f := newFetcher(*rate)
	filter := aip.DatasetFilter(*only)
	now := time.Now().UTC()

	// Current cycle: any page failure is fatal, a partial dataset would
	// silently drop the missing aerodromes' charts on commit.
	current := aip.CurrentAirac(now)
	art, meta, err := scrape(ctx, f, current, filter)
	if err != nil {
		return err
	}
	if *only == "" && (meta.Aerodromes < *minAerodromes || meta.Charts < *minCharts) {
		return fmt.Errorf("sanity floor: %d aerodromes / %d charts (want >= %d / %d)",
			meta.Aerodromes, meta.Charts, *minAerodromes, *minCharts)
	}
	if _, err := aip.WriteDataset(*outDir, "uk-adcharts", "current", meta.Effective, art, meta); err != nil {
		return err
	}
	log.Printf("current %s: %d aerodromes, %d charts", meta.Effective, meta.Aerodromes, meta.Charts)

	if *skipNext {
		return nil
	}
	// Next cycle: NATS publishes it during the pre-release window; a 404
	// on its menu is the normal "not yet" answer, other failures degrade
	// to a warning so the current slot still commits.
	next := aip.NextAirac(now)
	artN, metaN, err := scrape(ctx, f, next, filter)
	switch {
	case errors.Is(err, errNotFound):
		log.Printf("next %s: not published yet", aip.AiracISO(next))
		return nil
	case err != nil:
		log.Printf("next %s: %v (skipped)", aip.AiracISO(next), err)
		return nil
	}
	if *only == "" && (metaN.Aerodromes < *minAerodromes || metaN.Charts < *minCharts) {
		log.Printf("next %s: below sanity floors (%d aerodromes, %d charts), skipped",
			metaN.Effective, metaN.Aerodromes, metaN.Charts)
		return nil
	}
	if _, err := aip.WriteDataset(*outDir, "uk-adcharts", "next", metaN.Effective, artN, metaN); err != nil {
		return err
	}
	log.Printf("next %s: %d aerodromes, %d charts", metaN.Effective, metaN.Aerodromes, metaN.Charts)
	return nil
}

// scrape walks one eAIP tree: menu -> per-aerodrome pages -> chart lists.
func scrape(ctx context.Context, f *fetcher, effective time.Time, filter func(string) bool) (Artifact, Meta, error) {
	base := eaipBase(effective)
	menuURL := base + "html/eAIP/EG-menu-en-GB.html"
	menuHTML, err := f.get(ctx, menuURL)
	if err != nil {
		return Artifact{}, Meta{}, err
	}
	pages := parseMenu(menuHTML)
	if len(pages) == 0 {
		return Artifact{}, Meta{}, fmt.Errorf("%s: no AD pages in menu", menuURL)
	}
	start := f.fetched
	charts := map[string][]chartRef{}
	for _, p := range pages {
		if !filter(p.ICAO) {
			continue
		}
		url := fmt.Sprintf("%shtml/eAIP/EG-AD-%d.%s-en-GB.html", base, p.Section, p.ICAO)
		html, err := f.get(ctx, url)
		if err != nil {
			return Artifact{}, Meta{}, err
		}
		charts[p.ICAO] = parseCharts(html)
	}
	art, meta := build(charts, effective, base, menuURL, f.fetched-start, time.Now())
	return art, meta, nil
}
