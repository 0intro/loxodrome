// Command supaip builds public/data/fr-supaip.json (+ .meta.json): the
// French AIP SUP (aeronautical supplement) overlay. It scrapes the public SIA
// listing pages (no API key, throttled), downloads each supplement's PDF, and
// parses the PDF for the supplement's area geometry, validity, and vertical
// limits.
//
// Run (live, the workflow default):
//
//	go run ./cmd/supaip
//
// Offline (no network) from a snapshot or testdata mirror:
//
//	go run ./cmd/supaip -listing-dir <dir> -mirror <dir>
//
// where <dir> holds <region>/listing.html and <region>/*.pdf.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/0intro/loxodrome/internal/overlay"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	out := flag.String("out", "public/data", "output directory for fr-supaip.json and fr-supaip.meta.json")
	listingDir := flag.String("listing-dir", "", "offline: directory of <region>/listing.html (enables offline mode)")
	mirrorDir := flag.String("mirror", "", "offline: directory of <region>/*.pdf (default: -listing-dir)")
	cacheDir := flag.String("cache", "local/supaip-cache", "live: PDF content cache directory")
	navaidsPath := flag.String("navaids", "public/data/fr-navaids.json", "fr-navaids.json used to resolve radial/DME fixes")
	rate := flag.Duration("rate", time.Second, "live: minimum interval between SIA requests (throttle)")
	minSup := flag.Int("min-supaip", 0, "sanity-window floor for supplement count (0 = default)")
	maxSup := flag.Int("max-supaip", 0, "sanity-window ceiling for supplement count (0 = default)")
	retainFrom := flag.Int("retain-from", 2026, "keep supplements the SIA has stopped listing from this year on (0 = rebuild from scratch)")
	backfill := flag.Int("backfill", 0, "live: also sweep the media store for that year's supplements the listing has dropped (0 = off)")
	refresh := flag.Bool("refresh-retained", false, "live: re-fetch and re-parse the retained supplements, so they track parser improvements")
	dumpPDF := flag.String("dump-pdf", "", "debug: print a PDF's reconstructed lines, then exit")
	dumpGeom := flag.String("dump-geom", "", "debug: parse a PDF's geometry and print the result, then exit")
	forcePoppler := flag.Bool("poppler", false, "debug: force the poppler pdftotext extractor for -dump-pdf / -dump-geom")
	flag.Parse()

	if *dumpPDF != "" {
		return debugDumpPDF(*dumpPDF, *forcePoppler)
	}
	if *dumpGeom != "" {
		return debugDumpGeom(*dumpGeom, *forcePoppler)
	}

	nav, err := loadNavaids(*navaidsPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "supaip: navaids unavailable (%v); radial/DME fixes disabled\n", err)
	}

	// The artefact this run replaces is also the only durable record of the
	// supplements the SIA has since delisted, so it is read back in and its
	// dropped rows are carried forward (merge.go). Unreadable is not fatal:
	// the run then rebuilds from scratch, exactly as it did before.
	outPath := filepath.Join(*out, "fr-supaip.json")
	prev, err := readPrevious(outPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "supaip: previous artefact unusable (%v); rebuilding from scratch\n", err)
	}

	res, err := acquire(context.Background(), acquireOpts{
		listingDir:      *listingDir,
		mirrorDir:       *mirrorDir,
		cacheDir:        *cacheDir,
		rate:            *rate,
		backfillYear:    *backfill,
		prevRows:        previousRows(prev),
		refreshRetained: *refresh,
		retainFrom:      *retainFrom,
	})
	if err != nil {
		return fmt.Errorf("supaip: %w", err)
	}

	art, meta, err := Build(res, nav, buildOpts{
		now:        time.Now,
		minSupaip:  *minSup,
		maxSupaip:  *maxSup,
		prev:       prev,
		retainFrom: *retainFrom,
	})
	if err != nil {
		return err
	}

	if err := os.MkdirAll(*out, 0o755); err != nil {
		return err
	}
	if err := overlay.WriteCompactJSON(outPath, art); err != nil {
		return err
	}
	if err := overlay.WritePrettyJSON(filepath.Join(*out, "fr-supaip.meta.json"), meta); err != nil {
		return err
	}
	fmt.Printf("wrote fr-supaip.json: %d supplements (%d with geometry, %d none, %d parse-errors, %d retained)\n",
		meta.Total, meta.WithGeometry, meta.None, meta.ParseErrors, meta.Retained)
	return nil
}

func debugDumpPDF(path string, forcePoppler bool) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	rows, poppler, err := extractFor(data, forcePoppler)
	if err != nil {
		return err
	}
	if poppler {
		fmt.Fprintln(os.Stderr, "extractor: poppler (rsc.io/pdf could not read this file)")
	}
	for _, r := range rows {
		fmt.Println(r.text())
	}
	return nil
}

func dashTo(s string) string {
	if s == "" {
		return ""
	}
	return ".." + s
}

func debugDumpGeom(path string, forcePoppler bool) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	rows, poppler, err := extractFor(data, forcePoppler)
	if err != nil {
		return err
	}
	if poppler {
		fmt.Println("extractor=poppler")
	}
	res := parseGeometry(rows, nil)
	respaceZoneNames(res.zones, data)
	fmt.Printf("source=%s confidence=%s\n", res.source, res.confidence)
	fmt.Printf("fir=%v adhp=%v\n", res.fir, res.adhp)
	fmt.Printf("bbox=%v\n", res.bbox)
	fmt.Printf("warnings=%v\n", res.warnings)
	fmt.Printf("zones=%d\n", len(res.zones))
	for _, z := range res.zones {
		kind, n := "none", 0
		if z.geom != nil {
			kind = z.geom.kind
			switch kind {
			case "polygon":
				n = len(z.geom.ring)
			case "multipolygon":
				n = len(z.geom.rings)
			case "circle":
				n = 1
			}
		}
		fmt.Printf("  zone %q: %s(%d) lower=%v upper=%v src=%s", z.name, kind, n, z.lower, z.upper, z.source)
		if z.sameAs != "" {
			fmt.Printf(" sameAs=%q", z.sameAs)
		}
		fmt.Println()
		for _, a := range z.activations {
			fmt.Printf("    active %s%s %s-%s\n", a.date, dashTo(a.dateTo), a.from, a.to)
		}
	}
	return nil
}
