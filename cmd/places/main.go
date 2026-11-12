// Command places builds the place names Loxodrome searches and names
// positions by: every French commune from IGN's ADMIN EXPRESS COG, read
// through the Géoplateforme's WFS, and the towns of the other countries
// the app covers from GeoNames. It writes one places-<iso>.json per
// country and their one index, places.meta.json (docs/places.md).
//
// Everything is fetched, built and checked in memory first. Then the
// country files are written, the file of a country the table no longer
// holds is removed, and the index goes last: a run that fails writes
// nothing.
//
// Run from the repository root:
//
//	go run ./cmd/places                               # fetch, write public/data
//	go run ./cmd/places -keep local/places-inputs     # and keep the downloads
//	go run ./cmd/places -in local/places-inputs -out /tmp/places
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/overlay"
)

const (
	// Polite identification, as the other fetchers send it.
	userAgent = "loxodrome-places/1.0 (+https://loxodrome.fr)"

	// The whole run's budget: some 80 downloads, IGN's pages and
	// GeoNames' files, the largest (GeoNames' United States alternate
	// names) 23 MB, in about a minute on 2026-10-19.
	fetchTimeout = 20 * time.Minute

	// defaultOutDir is resolved against the working directory, expected
	// to be the repository root.
	defaultOutDir = "public/data"

	indexName = "places.meta.json"
)

// countryFile matches a country file's name, capturing its ISO code.
var countryFile = regexp.MustCompile(`^places-([a-z]+)\.json$`)

func main() {
	err := run(context.Background(), os.Args[1:], Options{
		Countries:   countries,
		GeoNamesMin: defaultGeoNamesMin,
		GeoNamesMax: defaultGeoNamesMax,
		Now:         time.Now,
	})
	var usage usageError
	switch {
	case err == nil:
	case errors.As(err, &usage):
		// The flag set has printed the error and the usage.
		if errors.Is(usage.err, flag.ErrHelp) {
			os.Exit(0)
		}
		os.Exit(2)
	default:
		fmt.Fprintln(os.Stderr, "places:", err)
		os.Exit(1)
	}
}

// A usageError is a command line the flag set refused.
type usageError struct{ err error }

func (e usageError) Error() string { return e.err.Error() }

func run(ctx context.Context, args []string, opts Options) error {
	fs := flag.NewFlagSet("places", flag.ContinueOnError)
	in := fs.String("in", "", "offline replay: read the inputs from this directory, as -keep wrote them, instead of fetching")
	keep := fs.String("keep", "", "write every download into this directory, for a replay with -in")
	outDir := fs.String("out", defaultOutDir, "output directory for places-*.json and "+indexName)
	rate := fs.Duration("rate", 500*time.Millisecond, "minimum interval between two downloads")
	if err := fs.Parse(args); err != nil {
		return usageError{err}
	}
	if fs.NArg() > 0 || (*in != "" && *keep != "") {
		fmt.Fprintln(fs.Output(), "usage: places [-in dir | -keep dir] [-out dir] [-rate interval]")
		return usageError{errors.New("bad command line")}
	}

	ctx, cancel := context.WithTimeout(ctx, fetchTimeout)
	defer cancel()

	src := &fetcher{in: *in, keep: *keep, lim: &limiter{interval: *rate}}
	inputs, err := src.inputs(ctx, opts.Countries)
	if err != nil {
		return err
	}
	res, err := build(inputs, opts)
	if err != nil {
		return err
	}
	if err := write(*outDir, res); err != nil {
		return err
	}
	d := res.Index.Dropped
	fmt.Printf("wrote %d places in %d files; dropped: IGN %d collectivity, %d no position; GeoNames %d section, %d historical, %d below floor, %d duplicate, %d no position, %d not populated\n",
		res.Index.PlaceCount, len(res.Files),
		d.IGN.Collectivity, d.IGN.NoPosition,
		d.GeoNames.Section, d.GeoNames.Historical, d.GeoNames.BelowFloor, d.GeoNames.Duplicate, d.GeoNames.NoPosition, d.GeoNames.NotPopulated)
	return nil
}

// write puts the country files in outDir, removes the places-<iso>.json
// of every country the build did not write, and writes the index last.
func write(outDir string, res Result) error {
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return err
	}
	for _, iso := range sortedKeys(res.Files) {
		if err := aip.WriteCompactJSON(filepath.Join(outDir, "places-"+iso+".json"), res.Files[iso]); err != nil {
			return err
		}
	}
	entries, err := os.ReadDir(outDir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		m := countryFile.FindStringSubmatch(e.Name())
		if m == nil || e.IsDir() {
			continue
		}
		if _, ok := res.Files[m[1]]; ok {
			continue
		}
		if err := os.Remove(filepath.Join(outDir, e.Name())); err != nil {
			return err
		}
	}
	return aip.WritePrettyJSON(filepath.Join(outDir, indexName), res.Index)
}

// A fetcher reads the inputs: from a replay directory, or from the
// network, keeping each download under its input name when asked.
type fetcher struct {
	in   string
	keep string
	lim  *limiter
}

// inputs reads everything a build of table needs.
func (s *fetcher) inputs(ctx context.Context, table []country) (Inputs, error) {
	in := Inputs{Alternates: map[string][]byte{}}
	for _, l := range []struct {
		dst   *[]named
		layer ignLayer
	}{
		{&in.ChefLieux, ignChefLieux},
		{&in.Communes, ignCommunes},
		{&in.Departements, ignDepartements},
	} {
		pages, err := s.pages(ctx, l.layer)
		if err != nil {
			return Inputs{}, err
		}
		*l.dst = pages
	}
	for _, f := range []struct {
		dst       *[]byte
		name, url string
	}{
		{&in.Cities, citiesName, geoNamesDumpURL + citiesName},
		{&in.Admin1, admin1Name, geoNamesDumpURL + admin1Name},
	} {
		b, err := s.get(ctx, f.name, f.url)
		if err != nil {
			return Inputs{}, err
		}
		*f.dst = b
	}
	for _, t := range table {
		if t.source != srcGeoNames {
			continue
		}
		name := alternatesName(t.cc)
		b, err := s.get(ctx, name, geoNamesDumpURL+name)
		if err != nil {
			return Inputs{}, err
		}
		in.Alternates[t.cc] = b
	}
	return in, nil
}

// pages reads a WFS layer a page at a time, live or from a replay
// directory, where the kept pages say how many followed them as they did
// live. The pages' tiling is checked when they are read (readLayer).
func (s *fetcher) pages(ctx context.Context, l ignLayer) ([]named, error) {
	var out []named
	start := 0
	for i := range ignMaxPages {
		name := l.pageName(i)
		b, err := s.get(ctx, name, l.pageURL(start))
		if err != nil {
			return nil, err
		}
		var p wfsPage
		if err := json.Unmarshal(b, &p); err != nil {
			if bytes.HasPrefix(bytes.TrimSpace(b), []byte("<")) {
				return nil, fmt.Errorf("ign %s: the WFS answered XML, not GeoJSON: %.300s", name, b)
			}
			return nil, fmt.Errorf("ign %s: %w", name, err)
		}
		out = append(out, named{name, b})
		start += p.NumberReturned
		if p.NumberReturned == 0 || start >= p.NumberMatched {
			return out, nil
		}
	}
	return nil, fmt.Errorf("ign %s: more than %d pages", l.name, ignMaxPages)
}

// get reads one input.
func (s *fetcher) get(ctx context.Context, name, url string) ([]byte, error) {
	if s.in != "" {
		return os.ReadFile(filepath.Join(s.in, filepath.FromSlash(name)))
	}
	s.lim.wait(ctx)
	b, err := overlay.HTTPGetAllWithHeaders(ctx, url, map[string]string{"User-Agent": userAgent})
	if err != nil {
		return nil, err
	}
	if s.keep != "" {
		path := filepath.Join(s.keep, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return nil, err
		}
		if err := os.WriteFile(path, b, 0o644); err != nil {
			return nil, err
		}
	}
	return b, nil
}

// limiter enforces a minimum interval between live requests (cmd/metar's).
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
