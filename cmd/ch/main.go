// Command ch reads the Swiss air navigation obstacle data set and emits
// ch-obstacles.json.
//
// Obstacles only, and deliberately so. Switzerland's airspace is not
// available on any free licence: skyguide sells the AIP through
// skybriefing on an annual subscription plus per-product fees, and there
// is no free eAIP (docs/aip-sources.md). What IS open is the obstacle
// register, which FOCA publishes on the federal geodata platform in
// AIXM under the opendata.swiss "open use, must provide the source"
// terms.
//
// That is worth having on its own: the register is the cables,
// cableways, power lines and masts of Article 2(k) of the Aviation
// Infrastructure Ordinance, and an Alpine cable is exactly the obstacle
// a VFR obstacle layer exists for.
//
// The data set is half a gigabyte of XML, so it is decoded as a stream
// (aixm5.DecodeReaders) rather than buffered.
//
// Run directly:
//
//	go run ./cmd/ch
//	go run ./cmd/ch -in local/luftfahrthindernis_4326.aixm.zip
package main

import (
	"cmp"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/aixm5"
	"github.com/0intro/loxodrome/internal/aixm5build"
	"github.com/0intro/loxodrome/internal/overlay"
)

const (
	// defaultOutDir is resolved relative to the working directory,
	// expected to be the repo root (`go run ./cmd/ch`).
	defaultOutDir = "public/data"

	// obstacleURL is the STAC asset FOCA publishes; the collection is
	// ch.bazl.luftfahrthindernis on the federal geodata platform.
	obstacleURL = "https://data.geo.admin.ch/ch.bazl.luftfahrthindernis/luftfahrthindernis/luftfahrthindernis_4326.aixm.zip"

	defaultMinChObstacles = 5000
	defaultMaxChObstacles = 60000

	fetchTimeout = 30 * time.Minute
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	in := flag.String("in", "", "path to a local luftfahrthindernis_*.aixm.zip (skips the fetch)")
	outDir := flag.String("out", defaultOutDir, "output directory for ch-obstacles.json and ch-obstacles.meta.json")
	target := flag.String("target", "auto", `output slot: "current" (ch-obstacles.json), "next" (ch-obstacles.next.json), or "auto"`)
	only := flag.String("only", "", "comma-separated dataset filter; empty means all (obstacles)")
	keep := flag.String("keep", "", "write the downloaded archive here (offline replay with -in)")
	var win aip.SanityWindows
	win.Register(flag.CommandLine)
	flag.Parse()

	want := aip.DatasetFilter(*only)
	if !want("obstacles") {
		return nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), fetchTimeout)
	defer cancel()

	path := *in
	if path == "" {
		p, cleanup, err := download(ctx, *keep)
		if err != nil {
			return err
		}
		defer cleanup()
		path = p
	}

	rc, name, err := aip.OpenLargestXML(path)
	if err != nil {
		return err
	}
	defer func() {
		_ = rc.Close()
	}()

	// Hash the source while decoding it: the meta records what was read,
	// and a second pass over half a gigabyte would be wasteful.
	h := sha256.New()
	msg, err := aixm5.DecodeReaders(io.TeeReader(rc, h))
	if err != nil {
		return fmt.Errorf("decode %s: %w", name, err)
	}

	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		return err
	}

	artifact, meta, err := aixm5build.BuildObstacles(msg, name, nil, effectiveFromName(name),
		aixm5build.ObstaclesOptions{
			IDPrefix:     "ch",
			Country:      "CH",
			Now:          time.Now,
			MinObstacles: cmp.Or(win.MinObstacles, defaultMinChObstacles),
			MaxObstacles: cmp.Or(win.MaxObstacles, defaultMaxChObstacles),
		})
	if err != nil {
		return err
	}
	// The shared builder hashes the bytes it is given; it was given none,
	// because the source was streamed. Stamp the streamed hash instead.
	meta.SourceSha256 = hex.EncodeToString(h.Sum(nil))

	slot, err := aip.WriteDataset(*outDir, "ch-obstacles", *target, meta.Effective, artifact, meta)
	if err != nil {
		return err
	}
	fmt.Printf("wrote %d obstacles (%d lit) from %s; effective %s; slot=%s\n",
		meta.ObstacleCount, meta.LitCount, name, meta.Effective, slot)
	if len(meta.UnknownTypes) > 0 {
		fmt.Printf("unmapped obstacle types: %v\n", meta.UnknownTypes)
	}
	return nil
}

// download fetches the archive to a temporary file, or to keepPath when
// one is given. The data set is far too large to hold in memory twice,
// so it goes to disk and is then streamed.
func download(ctx context.Context, keepPath string) (path string, cleanup func(), err error) {
	body, err := overlay.HTTPGetAll(ctx, obstacleURL)
	if err != nil {
		return "", nil, fmt.Errorf("obstacle data set: %w", err)
	}
	if keepPath != "" {
		if err := os.MkdirAll(filepath.Dir(keepPath), 0o755); err != nil {
			return "", nil, err
		}
		if err := os.WriteFile(keepPath, body, 0o644); err != nil {
			return "", nil, err
		}
		return keepPath, func() {}, nil
	}
	f, err := os.CreateTemp("", "ch-obstacles-*.zip")
	if err != nil {
		return "", nil, err
	}
	if _, err := f.Write(body); err != nil {
		_ = f.Close()
		_ = os.Remove(f.Name())
		return "", nil, err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(f.Name())
		return "", nil, err
	}
	return f.Name(), func() { _ = os.Remove(f.Name()) }, nil
}

// dataSetDateRe matches the publication date in the member name,
// Swiss_Obstacle_2026-08-14_005847.aixm.xml.
var dataSetDateRe = regexp.MustCompile(`(\d{4}-\d{2}-\d{2})`)

// effectiveFromName reads the publication date off the member name.
//
// FOCA revises the register "as needed" rather than on the AIRAC grid,
// so this is a publication date, not an AIRAC effective date; it is what
// the slot resolver and the About dialog have to go on, and it is the
// honest thing to report.
func effectiveFromName(name string) string {
	m := dataSetDateRe.FindStringSubmatch(name)
	if m == nil {
		return ""
	}
	return m[1] + "T00:00:00.000Z"
}
