// Command planign builds the offline pack of IGN's Plan IGN base map: one
// PMTiles archive of WebP tiles, zoom 0 to 13, over France and the overseas
// territories Plan IGN draws, which the app downloads whole through the
// chart worker and serves from the device (docs/offline-maps.md).
//
// Plan IGN is under the Licence Ouverte 2.0 (IGN's catalogue record
// IGNF_PLAN-IGN), which allows this redistribution where OpenStreetMap's
// tile policy does not; docs/plan-ign.md records the terms read. The source
// is IGN's own WMTS pyramid, the very tiles the live layer shows, so the
// pack and the online map cannot drift apart. IGN's downloadable edition is
// Lambert-93 TIFF at about 28 GB a department, which would mean reprojecting
// the map, not shipping it.
//
// A build is one harvest, resumable from its cache (cache.go), then one
// assembly (assemble.go), then one decision against the edition already
// published (previous.go): an unchanged map is not uploaded again, so no
// pilot is told about an update that is the tiles they already hold. The
// upload itself is the workflow's (data-planign.yml), which keeps the R2
// token out of the job that runs this code.
//
//	go run -tags nodynamic ./cmd/planign -previous https://charts.loxodrome.fr/planign/archive
//	go run -tags nodynamic ./cmd/planign -dry-run
//	go run -tags nodynamic ./cmd/planign -check-published https://charts.loxodrome.fr/planign/archive
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// exitIncomplete tells a caller (the workflow) that the harvest stopped
// cleanly before the end and the cache is ready to resume.
const exitIncomplete = 3

type options struct {
	cacheDir, outDir string
	boxes            []region
	hiZoom           uint8
	concurrency      int
	rate             float64
	fresh, resume    bool
	fetchOnly        bool
	assembleOnly     bool
	previous         string
	force            bool
}

func main() {
	log.SetFlags(0)
	var (
		o           options
		regionList  string
		hiZoom      int
		deadline    time.Duration
		dryRun      bool
		checkPublic string
	)
	flag.StringVar(&o.cacheDir, "cache", "local/planign-cache", "tile cache, resumable")
	flag.StringVar(&o.outDir, "out", "local/planign", "directory for planign.pmtiles and planign.json")
	flag.StringVar(&regionList, "regions", "all", `comma-separated region names, or "all"`)
	flag.IntVar(&hiZoom, "maxzoom", maxZoom, "last zoom (lower it for a quick trial)")
	flag.IntVar(&o.concurrency, "concurrency", 8, "requests in flight")
	flag.Float64Var(&o.rate, "rate", 15, "requests per second, all workers together")
	flag.BoolVar(&o.fresh, "fresh", false, "empty the cache first: a new edition")
	flag.BoolVar(&o.resume, "resume", false, "continue a cache older than a week")
	flag.DurationVar(&deadline, "deadline", 0, "stop the harvest cleanly after this long (exit 3, resumable)")
	flag.BoolVar(&dryRun, "dry-run", false, "print the tile counts and exit")
	flag.BoolVar(&o.fetchOnly, "fetch-only", false, "harvest, then stop")
	flag.BoolVar(&o.assembleOnly, "assemble-only", false, "assemble from the cache, fetching nothing")
	flag.StringVar(&o.previous, "previous", "", "URL of the published archive to decide against")
	flag.BoolVar(&o.force, "force", false, "upload even when the tiles did not change or a zoom lost tiles")
	flag.StringVar(&checkPublic, "check-published", "", "check the published archive at this URL against planign.json, then exit")
	flag.Parse()

	boxes, err := selectRegions(strings.Split(regionList, ","))
	if err != nil {
		log.Fatalf("planign: %v", err)
	}
	if hiZoom < minZoom || hiZoom > maxZoom {
		log.Fatalf("planign: -maxzoom must be %d..%d", minZoom, maxZoom)
	}
	o.boxes, o.hiZoom = boxes, uint8(hiZoom)
	if dryRun {
		printCounts(enumerate(minZoom, o.hiZoom, worldMaxZoom, boxes, lowZoomMargin, lowZoomMarginMaxZoom))
		return
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if checkPublic != "" {
		if err := runCheck(ctx, checkPublic, o.outDir); err != nil {
			log.Fatalf("planign: %v", err)
		}
		return
	}

	err = run(ctx, o, deadline)
	switch {
	case err == nil:
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, context.Canceled), errors.Is(err, errIncomplete):
		log.Printf("planign: %v; the cache resumes on the next run", err)
		os.Exit(exitIncomplete)
	default:
		log.Fatalf("planign: %v", err)
	}
}

func run(ctx context.Context, o options, deadline time.Duration) error {
	if err := checkEncoder(); err != nil {
		return err
	}
	c, release, err := openCache(o.cacheDir, o.fresh, o.resume, time.Now())
	if err != nil {
		return err
	}
	defer release()
	want := enumerate(minZoom, o.hiZoom, worldMaxZoom, o.boxes, lowZoomMargin, lowZoomMarginMaxZoom)
	log.Printf("harvest of %s, cache %s", c.started, c.dir)

	if !o.assembleOnly {
		hctx := ctx
		if deadline > 0 {
			var cancel context.CancelFunc
			hctx, cancel = context.WithTimeout(ctx, deadline)
			defer cancel()
		}
		f := newFetcher(wmtsEndpoint, o.rate, o.concurrency)
		if err := harvestAll(hctx, f, c, want, o.concurrency); err != nil {
			return err
		}
	}
	if o.fetchOnly {
		return nil
	}

	rep, err := assemble(c, want, o.boxes, o.hiZoom, o.outDir, assembleOptions{})
	if err != nil {
		return err
	}
	log.Printf("%s: %d bytes, %d tiles present, %d absent, digest %s",
		filepath.Join(o.outDir, archiveName), rep.Bytes, rep.Present, rep.Absent, rep.Digest[:16])
	if rep.Census > 0 {
		log.Printf("census: %d present tiles sit under an absent parent: the pyramid is not monotonic, never prune", rep.Census)
	}

	if o.previous == "" {
		return nil
	}
	prev, err := readPublished(ctx, o.previous)
	if errors.Is(err, errNotPublished) {
		prev, err = nil, nil
	}
	if err != nil {
		return fmt.Errorf("the published edition: %w", err)
	}
	decision, reason, err := decide(prev, rep, o.force)
	if err != nil {
		return err
	}
	rep.Decision, rep.Reason = decision, reason
	log.Printf("decision: %s (%s)", decision, reason)
	return writeJSON(filepath.Join(o.outDir, reportName), rep)
}

// runCheck is -check-published: the route against the report just built.
func runCheck(ctx context.Context, url, outDir string) error {
	b, err := os.ReadFile(filepath.Join(outDir, reportName))
	if err != nil {
		return err
	}
	var rep report
	if err := json.Unmarshal(b, &rep); err != nil {
		return err
	}
	if err := checkPublished(ctx, url, &rep); err != nil {
		return err
	}
	log.Printf("%s serves the edition of %s (%d bytes, digest %s)", url, rep.Version, rep.Bytes, rep.Digest[:16])
	return nil
}

// printCounts is -dry-run: the request volume per zoom.
func printCounts(want []tile) {
	per := map[uint8]int{}
	for _, t := range want {
		per[t.z]++
	}
	for z := uint8(minZoom); z <= maxZoom; z++ {
		if n, ok := per[z]; ok {
			fmt.Printf("z%-2d %7d\n", z, n)
		}
	}
	fmt.Printf("all %7d\n", len(want))
}
