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

func main() {
	log.SetFlags(0)
	log.SetPrefix("adcharts: ")
	if err := run(context.Background()); err != nil {
		log.Fatal(err)
	}
}

func run(ctx context.Context) error {
	outDir := flag.String("out", "public/data", "output directory")
	rate := flag.Duration("rate", 400*time.Millisecond, "minimum interval between SIA requests")
	only := flag.String("only", "", "comma-separated ICAO filter (debug; skips the sanity floors)")
	minAerodromes := flag.Int("min-aerodromes", 100, "sanity floor: aerodromes with charts")
	minCharts := flag.Int("min-charts", 1000, "sanity floor: total charts")
	minVacAerodromes := flag.Int("min-vac-aerodromes", 300, "sanity floor: Atlas VAC aerodrome plates")
	minVacHeliports := flag.Int("min-vac-heliports", 150, "sanity floor: Atlas VAC helistation plates")
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
	if *only == "" {
		if meta.Aerodromes < *minAerodromes || meta.Charts < *minCharts {
			return fmt.Errorf("sanity floor: %d aerodromes / %d charts (want >= %d / %d)",
				meta.Aerodromes, meta.Charts, *minAerodromes, *minCharts)
		}
		if meta.VacAerodromes < *minVacAerodromes || meta.VacHeliports < *minVacHeliports {
			return fmt.Errorf("sanity floor: %d VAC aerodromes / %d VAC helistations (want >= %d / %d)",
				meta.VacAerodromes, meta.VacHeliports, *minVacAerodromes, *minVacHeliports)
		}
	}
	if _, err := aip.WriteDataset(*outDir, "fr-adcharts", "current", meta.Effective, art, meta); err != nil {
		return err
	}
	log.Printf("current %s: %d aerodromes, %d charts, VAC plates %d AD / %d HEL",
		meta.Effective, meta.Aerodromes, meta.Charts, meta.VacAerodromes, meta.VacHeliports)

	if *skipNext {
		return nil
	}
	// Next cycle: published only during the SIA pre-release window; a 404
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
	if *only == "" && (metaN.Aerodromes < *minAerodromes || metaN.Charts < *minCharts ||
		metaN.VacAerodromes < *minVacAerodromes || metaN.VacHeliports < *minVacHeliports) {
		log.Printf("next %s: below sanity floors (%d aerodromes, %d charts, %d/%d VAC plates), skipped",
			metaN.Effective, metaN.Aerodromes, metaN.Charts, metaN.VacAerodromes, metaN.VacHeliports)
		return nil
	}
	if _, err := aip.WriteDataset(*outDir, "fr-adcharts", "next", metaN.Effective, artN, metaN); err != nil {
		return err
	}
	log.Printf("next %s: %d aerodromes, %d charts, VAC plates %d AD / %d HEL",
		metaN.Effective, metaN.Aerodromes, metaN.Charts, metaN.VacAerodromes, metaN.VacHeliports)
	return nil
}

// scrape walks one eAIP tree: menu -> per-aerodrome pages -> chart lists.
func scrape(ctx context.Context, f *fetcher, effective time.Time, filter func(string) bool) (Artifact, Meta, error) {
	base := aip.SIAEAIPHTMLBase(effective)
	menuURL := base + "FR-menu-fr-FR.html"
	menuHTML, err := f.get(ctx, menuURL)
	if err != nil {
		return Artifact{}, Meta{}, err
	}
	// The two Atlas VAC indexes decide every plate link the panel offers,
	// so they are fetched with the menu and share its error handling: a
	// cycle either has both or is not written at all. Shipping a slot with
	// an empty index would silently drop every Carte VAC link.
	vacBase := aip.SIAAtlasVACBase(effective)
	vacAD, err := fetchAeroArray(ctx, f, vacBase+aip.SIAVacIndexJS)
	if err != nil {
		return Artifact{}, Meta{}, err
	}
	vacHel, err := fetchAeroArray(ctx, f, vacBase+aip.SIAVacHIndexJS)
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
		url := fmt.Sprintf("%sFR-AD-%d.%s-fr-FR.html", base, p.Section, p.ICAO)
		html, err := f.get(ctx, url)
		if err != nil {
			return Artifact{}, Meta{}, err
		}
		charts[p.ICAO] = parseCharts(html)
	}
	art, meta := build(charts, vacAD, vacHel, effective, menuURL, f.fetched-start, time.Now())
	return art, meta, nil
}

// fetchAeroArray reads one Atlas VAC index file. An empty list is an error:
// the file exists in every cycle and a silent zero would strip the plate
// links from a whole slot.
func fetchAeroArray(ctx context.Context, f *fetcher, url string) ([]string, error) {
	js, err := f.get(ctx, url)
	if err != nil {
		return nil, err
	}
	codes := parseAeroArray(js)
	if len(codes) == 0 {
		return nil, fmt.Errorf("%s: no codes in the Atlas VAC index", url)
	}
	return codes, nil
}
