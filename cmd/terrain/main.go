// Command terrain builds the elevation mosaic the application samples the
// ground from: one tile per z/x/y, three bands, pooled up a pyramid, from
// Copernicus GLO globally and from a national bare-earth product wherever one
// is published under a licence that permits re-serving.
//
//	go run ./cmd/terrain -region glo90                      # the global floor
//	go run ./cmd/terrain -region glo30 -bbox -12,34,42,72   # Europe
//	go run ./cmd/terrain -region nasadem                    # the GLO-30 holes
//	go run ./cmd/terrain -region fr -in /archive/rgealti     # a national tier
//	go run ./cmd/terrain -pool                              # THEN the pyramid
//	go run ./cmd/terrain -manifest                           # public/data/terrain.json
//
// A -region run writes that tier's native level and nothing above it: the
// coarse levels are one global pyramid over the finished mosaic, because a
// finer tier overwrites a coarser one where they overlap and any level pooled
// before that would hold a maximum lower than the ground. Build every tier,
// then -pool once.
//
// It is a LOCAL, occasional job like cmd/fr, not a scheduled workflow: the
// Copernicus edition is static (2021, verified unchanged in 2026) and the
// national products move on the order of years, while one run streams
// hundreds of gigabytes. What it writes is uploaded to R2 and served by the
// chart worker at /terrain/{z}/{x}/{y}.
//
// docs/terrain-sources.md carries each source's terms and the verdict on the
// ones not used; the tile format is internal/terrain.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/0intro/loxodrome/internal/terrain"
)

func main() {
	log := func(format string, a ...any) { fmt.Fprintf(os.Stderr, format+"\n", a...) }
	region := flag.String("region", "", "regions to build, comma separated (see -list)")
	list := flag.Bool("list", false, "list the regions and exit")
	bbox := flag.String("bbox", "", "limit to west,south,east,north")
	in := flag.String("in", "", "directory of source rasters, for a national region")
	out := flag.String("out", "local/terrain", "where the tiles are written")
	cache := flag.String("cache", "local/terrain-cache", "where fetched source rasters are kept")
	floor := flag.Int("floor", 6, "coarsest pyramid level to build")
	pool := flag.Bool("pool", false, "rebuild the whole pyramid from the deepest level on disk")
	resume := flag.Bool("resume", false, "skip tiles already on disk (SAME region only, see buildRegion)")
	poolFrom := flag.Int("pool-from", 0, "deepest level -pool rebuilds (default: one below the deepest on disk)")
	workers := flag.Int("concurrency", 6, "tiles built in parallel")
	manifest := flag.String("manifest", "", "write the region manifest to this path")
	receipts := flag.String("receipts", "", "write a sha256 per tile to this path")
	flag.Parse()

	if *list {
		for _, r := range regions {
			fmt.Printf("%-8s z%-3d %-4s %s\n", r.ID, r.Native, r.Datum, r.Label)
		}
		return
	}
	if err := run(*region, *bbox, *in, *out, *cache, *manifest, *receipts, *floor, *workers, *pool, *poolFrom, *resume, log); err != nil {
		log("terrain: %v", err)
		os.Exit(1)
	}
}

// Region is one tier of the mosaic: where it applies, what it is made of, and
// what the application must say about it. Adding a country is a row here plus
// a reader, which is the whole reason the table exists.
type Region struct {
	ID string
	// Label is the PRODUCT NAME and nothing else. It is printed in the About
	// credits beside the licence notice, in whichever language the app is
	// running in, and a product name is locale-invariant where an English
	// descriptive clause ("the global floor") is not: it read as English prose
	// in the middle of the French card. What each tier is FOR belongs in
	// docs/terrain-sources.md, which has room to say it properly.
	Label string
	// Priority orders the tiers where they overlap: a national product wins
	// over Copernicus, Copernicus over the global floor. It is the BUILD
	// ORDER that enforces it (see run): writeTile overwrites, so the tier
	// written last is the tier that stands, and regions are built coarsest
	// first so the best source lands on top.
	Priority int
	// Native is the deepest zoom this tier publishes.
	Native int
	// Datum says whether the ground is bare earth or a surface model, which
	// decides what an AGL floor may be resolved against. DSM tiers carry the
	// same surface in all three bands.
	Datum string
	// Vertical is the datum the heights are on, recorded rather than
	// converted: the spread across the sources is about 3 m, below the MSA's
	// own rounding.
	Vertical string
	Licence  string
	// Attribution is VERBATIM what the licence demands be shown.
	Attribution string
	Bounds      [4]float64 // west, south, east, north
	// Kind picks the reader: "copernicus30", "copernicus90", "nasadem",
	// "asc-lambert93", "asc-utm<zone><n|s>", "geotiff" (EPSG:4326).
	Kind string
	// Surface names the region whose DSM raises this one's max band, so
	// canopy and buildings keep padding terrain clearance over a bare-earth
	// tier while height above ground stays honest.
	Surface string
}

// The tiers. Terms, coverage and the sources deliberately NOT used are
// docs/terrain-sources.md; the two traps recorded there are FABDEM
// (CC BY-NC-SA, whose ShareAlike would infect every derived tile) and
// Copernicus EEA-10 (whose own licence excludes distribution to the public).
var regions = []Region{
	{
		ID: "fr", Label: "France, RGE ALTI 1 m", Priority: 10, Native: 14,
		Datum: "DTM", Vertical: "NGF-IGN69", Licence: "Licence Ouverte / Open Licence 2.0",
		Attribution: "IGN, RGE ALTI, Licence Ouverte 2.0",
		Bounds:      [4]float64{-5.3, 41.2, 9.7, 51.2}, Kind: "asc-lambert93", Surface: "glo30",
	},
	{
		ID: "ch", Label: "Switzerland, swissALTI3D", Priority: 11, Native: 14,
		Datum: "DTM", Vertical: "LN02", Licence: "swisstopo open government data",
		Attribution: "Source: Federal Office of Topography swisstopo",
		Bounds:      [4]float64{5.9, 45.8, 10.5, 47.9}, Kind: "geotiff", Surface: "glo30",
	},
	{
		ID: "at", Label: "Austria, DGM Osterreich 10 m", Priority: 12, Native: 13,
		Datum: "DTM", Vertical: "GHA", Licence: "CC BY 4.0",
		Attribution: "Land Karnten - data.gv.at",
		Bounds:      [4]float64{9.4, 46.3, 17.2, 49.1}, Kind: "geotiff", Surface: "glo30",
	},
	{
		ID: "it", Label: "Italy, TINITALY 1.1", Priority: 13, Native: 13,
		Datum: "DTM", Vertical: "orthometric", Licence: "CC BY 4.0",
		Attribution: "Tarquini S. et al. (2023), TINITALY 1.1, INGV, doi:10.13127/tinitaly/1.1",
		Bounds:      [4]float64{6.6, 35.4, 18.6, 47.1}, Kind: "geotiff", Surface: "glo30",
	},
	{
		ID: "nl", Label: "Netherlands, AHN4 5 m", Priority: 14, Native: 14,
		Datum: "DTM", Vertical: "NAP", Licence: "CC0 1.0",
		Attribution: "AHN, Rijkswaterstaat and the waterschappen",
		Bounds:      [4]float64{3.2, 50.7, 7.3, 53.7}, Kind: "geotiff", Surface: "glo30",
	},
	{
		ID: "fi", Label: "Finland, NLS elevation model 10 m", Priority: 15, Native: 13,
		Datum: "DTM", Vertical: "N2000", Licence: "CC BY 4.0",
		Attribution: "(c) National Land Survey of Finland, elevation model",
		Bounds:      [4]float64{19.0, 59.7, 31.6, 70.1}, Kind: "geotiff", Surface: "glo30",
	},
	{
		ID: "glo30", Label: "Copernicus GLO-30", Priority: 50, Native: 12,
		Datum: "DSM", Vertical: "EGM2008", Licence: "Copernicus DEM free and open",
		// Article 6(b) and 6(c) of the COP-DEM-GLO-30-F licence, VERBATIM. (b)
		// because what we serve is adapted (pooled, re-tiled, re-projected), and
		// (c) unconditionally on distribution to the general public. (a), the
		// bare source notice, is subsumed word for word by (b).
		Attribution: "produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and " +
			"© Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the " +
			"European Union and ESA; all rights reserved. The organisations in charge of " +
			"the Copernicus programme by law or by delegation do not incur any liability " +
			"for any use of the Copernicus WorldDEM-30.",
		// The product's own reach, not the reach of the first two continents
		// built from it: -bbox is INTERSECTED with this, so a box over Reunion
		// or New Caledonia would otherwise be intersected away to nothing.
		Bounds: [4]float64{-180, -60, 180, 84}, Kind: "copernicus30",
	},
	{
		ID: "nasadem", Label: "NASADEM", Priority: 55, Native: 12,
		Datum: "DSM", Vertical: "EGM96", Licence: "public domain (NASA LP DAAC)",
		Attribution: "NASADEM Merged DEM Global 1 arc second V001, NASA JPL, " +
			"distributed by the NASA EOSDIS Land Processes DAAC; public domain",
		Bounds: [4]float64{38, 38, 51, 44}, Kind: "nasadem",
	},
	{
		ID: "glo90", Label: "Copernicus GLO-90", Priority: 90, Native: 10,
		Datum: "DSM", Vertical: "EGM2008", Licence: "Copernicus DEM free and open",
		// The 90 m instance is its own licence (COP-DEM-GLO-90-F) and its
		// notices name their own product, trademark mark included. This row
		// carried the 30 m wording, which credits a product these tiles are
		// not made of and discharges nothing.
		Attribution: "produced using Copernicus WorldDEM™-90 © DLR e.V. 2010-2014 and " +
			"© Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the " +
			"European Union and ESA; all rights reserved. The organisations in charge of " +
			"the Copernicus programme by law or by delegation do not incur any liability " +
			"for any use of the Copernicus WorldDEM™-90.",
		Bounds: [4]float64{-180, -60, 180, 84}, Kind: "copernicus90",
	},
}

func regionByID(id string) (Region, bool) {
	for _, r := range regions {
		if r.ID == id {
			return r, true
		}
	}
	return Region{}, false
}

// orderedRegions resolves the -region list and puts it in BUILD order:
// coarsest first, so the best tier is written last and stands.
//
// This is the only thing that enforces Priority. writeTile overwrites
// unconditionally and a tile carries no record of which tier wrote it, so
// where two tiers publish the same level the winner is simply whoever ran
// last. Left to the order the flag was typed in, `-region glo30,nasadem`
// would bury 30 m Copernicus ground under NASADEM's 2000-era SRTM across the
// whole Caucasus, and nothing downstream would look wrong: the tiles are all
// present and all plausible.
func orderedRegions(spec string) ([]Region, error) {
	var out []Region
	for _, id := range strings.Split(spec, ",") {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		r, ok := regionByID(id)
		if !ok {
			return nil, fmt.Errorf("unknown region %q", id)
		}
		out = append(out, r)
	}
	// Descending priority: 90 (the global floor) first, 10 (a national
	// product) last. Stable, so two tiers at the same priority keep the
	// order they were asked for.
	sort.SliceStable(out, func(i, j int) bool { return out[i].Priority > out[j].Priority })
	return out, nil
}

func providerFor(r Region, in string, f *fetcher) (provider, error) {
	switch {
	case r.Kind == "copernicus30":
		return copernicus(f, 30), nil
	case r.Kind == "copernicus90":
		return copernicus(f, 90), nil
	case r.Kind == "nasadem":
		// -in still takes precedence, for a local set of .hgt files off the
		// DAAC; without it the tier fetches itself like the Copernicus ones,
		// so no build stops for a login.
		if in != "" {
			return nasadem(in), nil
		}
		return nasademFetched(f), nil
	case r.Kind == "asc-lambert93":
		if in == "" {
			return nil, fmt.Errorf("%s: -in must name a directory of .asc grids", r.ID)
		}
		return asciiGrids(in, terrain.Lambert93(), r.Label)
	case strings.HasPrefix(r.Kind, "asc-utm"):
		zone, north, err := utmSpec(strings.TrimPrefix(r.Kind, "asc-utm"))
		if err != nil {
			return nil, fmt.Errorf("%s: %w", r.ID, err)
		}
		if in == "" {
			return nil, fmt.Errorf("%s: -in must name a directory of .asc grids", r.ID)
		}
		return asciiGrids(in, terrain.UTM(zone, north), r.Label)
	case r.Kind == "geotiff":
		if in == "" {
			return nil, fmt.Errorf("%s: -in must name a directory of EPSG:4326 GeoTIFFs "+
				"(reproject the national product once; the reader refuses any other CRS)", r.ID)
		}
		return geoTIFFDir(in, r.Label)
	}
	return nil, fmt.Errorf("%s: no reader for kind %q", r.ID, r.Kind)
}

func utmSpec(s string) (zone int, north bool, err error) {
	if len(s) < 2 {
		return 0, false, fmt.Errorf("utm spec %q", s)
	}
	hemi := s[len(s)-1]
	zone, err = strconv.Atoi(s[:len(s)-1])
	if err != nil || zone < 1 || zone > 60 {
		return 0, false, fmt.Errorf("utm zone %q", s)
	}
	switch hemi {
	case 'n', 'N':
		return zone, true, nil
	case 's', 'S':
		return zone, false, nil
	}
	return 0, false, fmt.Errorf("utm hemisphere %q", string(hemi))
}

func run(
	regionSpec, bboxSpec, in, out, cache, manifest, receipts string,
	floor, workers int, pool bool, poolFrom int, resume bool, log func(string, ...any),
) error {
	limit, err := parseBbox(bboxSpec)
	if err != nil {
		return err
	}
	if regionSpec == "" {
		if !pool && manifest == "" && receipts == "" {
			return fmt.Errorf("nothing to do: pass -region, -pool (or -list)")
		}
		if pool {
			if err := poolPyramid(out, limit, floor, poolFrom, workers, log); err != nil {
				return err
			}
		}
		return finish(manifest, receipts, out, workers, log)
	}
	f := newFetcher(cache)

	want, err := orderedRegions(regionSpec)
	if err != nil {
		return err
	}
	for _, r := range want {
		ground, err := providerFor(r, in, f)
		if err != nil {
			return err
		}
		var surface provider
		if r.Surface != "" {
			s, ok := regionByID(r.Surface)
			if !ok {
				return fmt.Errorf("%s: surface region %q", r.ID, r.Surface)
			}
			if surface, err = providerFor(s, "", f); err != nil {
				return err
			}
		}
		if err := buildRegion(r, ground, surface, limit, out, workers, resume, log); err != nil {
			return err
		}
	}
	if pool {
		if err := poolPyramid(out, limit, floor, poolFrom, workers, log); err != nil {
			return err
		}
	}
	return finish(manifest, receipts, out, workers, log)
}

// finish writes the two things a build hands on: the manifest the client
// reads, and the receipts the upload diffs against. A tile is
// byte-deterministic for a given grid, so comparing hashes is a real change
// test: uploading regardless would roll every ETag and tell every user an
// update was waiting for tiles identical to the ones they hold.
func finish(manifest, receipts, out string, workers int, log func(string, ...any)) error {
	if manifest != "" {
		if err := writeManifest(manifest, out); err != nil {
			return err
		}
		log("wrote %s", manifest)
	}
	if receipts != "" {
		n, err := writeReceipts(receipts, out, workers)
		if err != nil {
			return err
		}
		log("wrote %s (%d tiles)", receipts, n)
	}
	return nil
}

// writeReceipts hashes every tile under `out`, keyed by the object name the
// worker serves it as.
// writeReceipts hashes every tile's CONTENT into the file the next upload
// diffs against. It reads and decompresses the whole output tree, two million
// small files off a spinning array, so it walks the directory once to collect
// the paths and then hashes them across workers: serial it managed 2 MB/s and
// took hours, because a lone reader gives the drive one seek at a time to
// service instead of a queue it can order.
func writeReceipts(path, out string, workers int) (int, error) {
	var files []string
	err := filepath.WalkDir(out, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() && strings.HasSuffix(p, ".terrain") {
			files = append(files, p)
		}
		return nil
	})
	if err != nil {
		return 0, err
	}

	sums := make(map[string]string, len(files))
	jobs := make(chan string, workers*4)
	var wg sync.WaitGroup
	var mu sync.Mutex
	var firstErr error
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for p := range jobs {
				rel, err := filepath.Rel(out, p)
				if err == nil {
					var b []byte
					if b, err = os.ReadFile(p); err == nil {
						// The receipt is over the tile's CONTENT, never over
						// the file: Go's DEFLATE output has changed between
						// toolchain releases, so hashing the stored bytes
						// would mark every tile on earth as changed after a
						// Go upgrade and re-upload a million objects whose
						// ground is identical, rolling every ETag to announce
						// an update that is the tiles the device already has.
						var payload []byte
						if payload, err = terrain.PayloadOf(b); err == nil {
							key := strings.TrimSuffix(filepath.ToSlash(rel), ".terrain")
							sum := receipt(payload)
							mu.Lock()
							sums[key] = sum
							mu.Unlock()
							continue
						}
					}
					err = fmt.Errorf("%s: %w", rel, err)
				}
				mu.Lock()
				if firstErr == nil {
					firstErr = err
				}
				mu.Unlock()
			}
		}()
	}
	for _, p := range files {
		jobs <- p
	}
	close(jobs)
	wg.Wait()
	if firstErr != nil {
		return 0, firstErr
	}

	b, err := json.MarshalIndent(sums, "", "  ")
	if err != nil {
		return 0, err
	}
	return len(sums), os.WriteFile(path, append(b, '\n'), 0o644)
}

func parseBbox(s string) ([4]float64, error) {
	if s == "" {
		return [4]float64{-180, -85, 180, 85}, nil
	}
	f := strings.Split(s, ",")
	if len(f) != 4 {
		return [4]float64{}, fmt.Errorf("-bbox wants west,south,east,north")
	}
	var b [4]float64
	for i, v := range f {
		x, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
		if err != nil {
			return b, fmt.Errorf("-bbox: %w", err)
		}
		b[i] = x
	}
	return b, nil
}

// tileRange is the slippy tile window covering a geographic box at one zoom.
func tileRange(z int, b [4]float64) (x0, y0, x1, y1 int) {
	n := float64(int(1) << uint(z))
	lonX := func(lon float64) float64 { return (lon + 180) / 360 * n }
	latY := func(lat float64) float64 {
		lat = math.Max(-85.05112878, math.Min(85.05112878, lat))
		r := lat * math.Pi / 180
		return (1 - math.Log(math.Tan(r)+1/math.Cos(r))/math.Pi) / 2 * n
	}
	x0 = int(math.Floor(lonX(b[0])))
	x1 = int(math.Floor(lonX(b[2])))
	y0 = int(math.Floor(latY(b[3])))
	y1 = int(math.Floor(latY(b[1])))
	clamp := func(v int) int {
		if v < 0 {
			return 0
		}
		if v > int(n)-1 {
			return int(n) - 1
		}
		return v
	}
	return clamp(x0), clamp(y0), clamp(x1), clamp(y1)
}

func intersect(a, b [4]float64) [4]float64 {
	return [4]float64{
		math.Max(a[0], b[0]), math.Max(a[1], b[1]),
		math.Min(a[2], b[2]), math.Min(a[3], b[3]),
	}
}

// -resume skips a tile already on disk, which turns a killed multi-hour build
// into one that carries on rather than one that starts again. It is safe ONLY
// for continuing an interrupted run of the SAME region: a tile records nothing
// about which tier wrote it, so resuming a FINER tier over a coarser one would
// read the coarse tiles as work already done and skip exactly the improvement
// the run exists to make. The Caucasus pass is the case in point, and it runs
// without it.
//
// buildRegion writes the region's NATIVE level only. The pyramid above it is
// deliberately not built here: the coarse levels are one global pyramid over
// the finished mosaic (-pool), because a finer tier overwrites a coarser
// tier's native level where they overlap, and anything pooled before that
// overwrite would carry a maximum LOWER than the ground really is. That error
// is invisible (the tile is present and plausible) and it is the wrong way
// round for terrain clearance, so the pyramid is never built until every
// native level that feeds it is on disk.
func buildRegion(
	r Region, ground, surface provider, limit [4]float64,
	out string, workers int, resume bool, log func(string, ...any),
) error {
	box := intersect(r.Bounds, limit)
	if box[0] >= box[2] || box[1] >= box[3] {
		log("%s: nothing inside the -bbox", r.ID)
		return nil
	}
	x0, y0, x1, y1 := tileRange(r.Native, box)
	total := (x1 - x0 + 1) * (y1 - y0 + 1)
	log("%s: %d tiles at z%d (%s)", r.ID, total, r.Native, ground.name())

	type job struct{ x, y int }
	jobs := make(chan job, workers*4)
	var wg sync.WaitGroup
	var mu sync.Mutex
	var written, empty, skipped int
	var firstErr error

	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range jobs {
				if resume {
					if _, err := os.Stat(tilePath(out, r.Native, j.x, j.y)); err == nil {
						mu.Lock()
						skipped++
						mu.Unlock()
						continue
					}
				}
				t, ok, err := buildOne(r, ground, surface, j.x, j.y)
				mu.Lock()
				if err != nil && firstErr == nil {
					firstErr = err
				}
				if !ok || err != nil {
					empty++
					mu.Unlock()
					continue
				}
				mu.Unlock()
				if err := writeTile(out, t); err != nil {
					mu.Lock()
					if firstErr == nil {
						firstErr = err
					}
					mu.Unlock()
					continue
				}
				mu.Lock()
				written++
				if written%2000 == 0 {
					log("%s: %d/%d", r.ID, written+empty+skipped, total)
				}
				mu.Unlock()
			}
		}()
	}
	for y := y0; y <= y1; y++ {
		for x := x0; x <= x1; x++ {
			jobs <- job{x, y}
		}
	}
	close(jobs)
	wg.Wait()
	if firstErr != nil {
		return firstErr
	}
	if skipped > 0 {
		log("%s: z%d done, %d tiles written, %d with no ground, %d already on disk",
			r.ID, r.Native, written, empty, skipped)
	} else {
		log("%s: z%d done, %d tiles written, %d with no ground", r.ID, r.Native, written, empty)
	}
	if written > 0 || skipped > 0 {
		if err := recordRegion(out, r.ID); err != nil {
			return err
		}
	}
	return nil
}

func buildOne(r Region, ground, surface provider, x, y int) (*terrain.Tile, bool, error) {
	// The tile's own centre decides which source rasters to hold; a tile that
	// straddles two degrees asks the provider again per pixel, which the
	// degree cache answers from memory.
	lon := terrain.TileLon(r.Native, float64(x)+0.5)
	lat := terrain.TileLat(r.Native, float64(y)+0.5)
	gs, err := sourcesAround(ground, lon, lat, r.Native, x, y)
	if err != nil {
		return nil, false, err
	}
	if len(gs) == 0 {
		return nil, false, nil
	}
	var ss []terrain.Source
	if surface != nil {
		if ss, err = sourcesAround(surface, lon, lat, r.Native, x, y); err != nil {
			return nil, false, err
		}
	}
	t, ok := terrain.BuildTile(r.Native, x, y, gs, ss)
	return t, ok, nil
}

// sourcesAround gathers the rasters covering a tile's four corners, which is
// every raster it can touch: a tile is far smaller than a source degree at
// every zoom this builds.
func sourcesAround(p provider, lon, lat float64, z, x, y int) ([]terrain.Source, error) {
	seen := map[terrain.Source]bool{}
	var out []terrain.Source
	corners := [][2]float64{
		{terrain.TileLon(z, float64(x)), terrain.TileLat(z, float64(y))},
		{terrain.TileLon(z, float64(x+1)), terrain.TileLat(z, float64(y))},
		{terrain.TileLon(z, float64(x)), terrain.TileLat(z, float64(y+1))},
		{terrain.TileLon(z, float64(x+1)), terrain.TileLat(z, float64(y+1))},
		{lon, lat},
	}
	for _, c := range corners {
		s, err := p.at(c[0], c[1])
		if err != nil {
			return nil, err
		}
		if s == nil || seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	return out, nil
}

func tilePath(out string, z, x, y int) string {
	return filepath.Join(out, strconv.Itoa(z), strconv.Itoa(x), strconv.Itoa(y)+".terrain")
}

func writeTile(out string, t *terrain.Tile) error {
	b, err := terrain.Encode(t)
	if err != nil {
		return err
	}
	p := tilePath(out, t.Z, t.X, t.Y)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	tmp := p + ".part"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

func readTile(out string, z, x, y int) (*terrain.Tile, error) {
	b, err := os.ReadFile(tilePath(out, z, x, y))
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return terrain.Decode(b)
}

// poolPyramid builds every coarse level of the FINISHED mosaic, from the
// deepest level on disk down to `floor`. It is the one place the pyramid is
// made, and it is run once every native tier has been written.
//
// A level whose children are absent is left exactly as it is: outside the
// tiers that reach z12 there are no z11 tiles, so pooling z10 there would
// find nothing and must not disturb the native z10 the global floor wrote.
// That is what lets one pass serve a mosaic whose tiers have different native
// levels.
func poolPyramid(out string, box [4]float64, floor, from, workers int, log func(string, ...any)) error {
	deepest, err := deepestLevel(out)
	if err != nil {
		return err
	}
	if deepest < 0 {
		return fmt.Errorf("%s holds no tiles to pool", out)
	}
	// -pool-from names the deepest level to REBUILD. It exists for a repair:
	// when the levels above a fault are known good, re-deriving them is hours
	// of identical output. A level is only safe to skip when nothing writes it
	// natively, which is why the default rebuilds everything below the deepest.
	top := deepest - 1
	if from > 0 {
		if from > deepest-1 {
			return fmt.Errorf("-pool-from z%d is not below the deepest level on disk (z%d)", from, deepest)
		}
		// Below the floor there is nothing to rebuild, and the loop below
		// would run zero times: a typo would report success having pooled
		// nothing, over data that decides minimum safe altitudes.
		if from < floor {
			return fmt.Errorf("-pool-from z%d is below the floor (z%d), so there is nothing to rebuild", from, floor)
		}
		top = from
	}
	log("pooling z%d down to z%d", top, floor)
	for z := top; z >= floor; z-- {
		n, err := poolLevel(out, z, box, workers, log)
		if err != nil {
			return err
		}
		log("z%d pooled, %d tiles", z, n)
	}
	return nil
}

// deepestLevel reads the level directories rather than trusting the registry,
// so a pool pass over a half-built mosaic pools what is actually there.
func deepestLevel(out string) (int, error) {
	entries, err := os.ReadDir(out)
	if err != nil {
		return -1, err
	}
	deepest := -1
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		z, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		if z > deepest {
			deepest = z
		}
	}
	return deepest, nil
}

// poolLevel builds one level from the one below it. This is where the
// pyramid's promise is kept: a parent's max is the max of its children, so a
// corridor read at a coarse level is answered exactly.
func poolLevel(out string, z int, box [4]float64, workers int, log func(string, ...any)) (int, error) {
	// The parents come from the CHILDREN THAT EXIST, not from a sweep of the
	// bbox. A world sweep at z11 is 4.2 million positions and about 17 million
	// reads that find nothing, to build the 350 000 parents that actually have
	// children beneath them; measured, it pooled 341 tiles a minute, which is
	// fifteen hours for one level and days for the pyramid. Reading the level
	// below and halving each address asks only for parents that can exist.
	kidsAt, err := tilesAtLevel(out, z+1)
	if err != nil {
		return 0, err
	}
	x0, y0, x1, y1 := tileRange(z, box)
	parents := map[[2]int]bool{}
	for k := range kidsAt {
		p := [2]int{k[0] / 2, k[1] / 2}
		if p[0] < x0 || p[0] > x1 || p[1] < y0 || p[1] > y1 {
			continue
		}
		parents[p] = true
	}
	if len(parents) == 0 {
		return 0, nil
	}

	// And it is one output per four inputs with no shared state, so it fans
	// out across cores instead of saturating one.
	jobs := make(chan [2]int, workers*4)
	var wg sync.WaitGroup
	var mu sync.Mutex
	var written int
	var firstErr error
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for p := range jobs {
				x, y := p[0], p[1]
				kids := [4]*terrain.Tile{}
				var err error
				for i, c := range [4][2]int{{0, 0}, {1, 0}, {0, 1}, {1, 1}} {
					kids[i], err = readTile(out, z+1, x*2+c[0], y*2+c[1])
					if err != nil {
						break
					}
				}
				if err != nil {
					mu.Lock()
					if firstErr == nil {
						firstErr = err
					}
					mu.Unlock()
					continue
				}
				t, ok := terrain.Pool4(z, x, y, kids[0], kids[1], kids[2], kids[3])
				if !ok {
					continue
				}
				// Where no child covered a pixel, keep what this level already
				// held: a coarser tier wrote it natively, and a tier's edge
				// does not fall on a tile boundary, so a straddling parent is
				// pooled on one side and empty on the other. Writing that out
				// would delete the floor's ground there.
				if prev, err := readTile(out, z, x, y); err == nil {
					terrain.KeepUncovered(t, prev)
				}
				if err := writeTile(out, t); err != nil {
					mu.Lock()
					if firstErr == nil {
						firstErr = err
					}
					mu.Unlock()
					continue
				}
				mu.Lock()
				written++
				if written%20000 == 0 {
					log("  z%d: %d/%d", z, written, len(parents))
				}
				mu.Unlock()
			}
		}()
	}
	for p := range parents {
		jobs <- p
	}
	close(jobs)
	wg.Wait()
	return written, firstErr
}

// tilesAtLevel lists the tile addresses present at one level, by reading the
// directory tree rather than probing an address range.
func tilesAtLevel(out string, z int) (map[[2]int]bool, error) {
	dir := filepath.Join(out, strconv.Itoa(z))
	xs, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	found := map[[2]int]bool{}
	for _, xe := range xs {
		if !xe.IsDir() {
			continue
		}
		x, err := strconv.Atoi(xe.Name())
		if err != nil {
			continue
		}
		ys, err := os.ReadDir(filepath.Join(dir, xe.Name()))
		if err != nil {
			return nil, err
		}
		for _, ye := range ys {
			name := ye.Name()
			if !strings.HasSuffix(name, ".terrain") {
				continue
			}
			y, err := strconv.Atoi(strings.TrimSuffix(name, ".terrain"))
			if err != nil {
				continue
			}
			found[[2]int{x, y}] = true
		}
	}
	return found, nil
}

// recordRegion notes that a tier really wrote tiles here, so the manifest
// credits what is SERVED rather than what the table knows about: an About
// modal naming a source the mosaic does not carry is a false credit.
func recordRegion(out, id string) error {
	have, err := builtRegions(out)
	if err != nil {
		return err
	}
	for _, s := range have {
		if s == id {
			return nil
		}
	}
	have = append(have, id)
	sort.Strings(have)
	b, err := json.MarshalIndent(have, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(out, "regions.json"), append(b, '\n'), 0o644)
}

func builtRegions(out string) ([]string, error) {
	b, err := os.ReadFile(filepath.Join(out, "regions.json"))
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var ids []string
	if err := json.Unmarshal(b, &ids); err != nil {
		return nil, err
	}
	return ids, nil
}

// --- the manifest -------------------------------------------------------

type manifestRegion struct {
	ID          string     `json:"id"`
	Label       string     `json:"label"`
	Native      int        `json:"native"`
	Datum       string     `json:"datum"`
	Vertical    string     `json:"vertical"`
	Licence     string     `json:"licence"`
	Attribution string     `json:"attribution"`
	Bounds      [4]float64 `json:"bounds"`
}

type manifestDoc struct {
	// Levels is what the client reads: the deepest tile level published
	// anywhere and the coarsest, which is the range its reductions may pick
	// from (map/terrain.ts TerrainLevels).
	Deepest  int              `json:"deepest"`
	Coarsest int              `json:"coarsest"`
	Regions  []manifestRegion `json:"regions"`
	// Tiles is the count actually present, so a half-finished build is
	// visible rather than implied.
	Tiles map[string]int `json:"tiles"`
}

func writeManifest(path, out string) error {
	doc := manifestDoc{Deepest: 0, Coarsest: 30, Tiles: map[string]int{}}
	entries, err := os.ReadDir(out)
	if err != nil {
		return fmt.Errorf("manifest: %s: %w", out, err)
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		z, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		n, err := countTiles(filepath.Join(out, e.Name()))
		if err != nil {
			return err
		}
		if n == 0 {
			continue
		}
		doc.Tiles[e.Name()] = n
		if z > doc.Deepest {
			doc.Deepest = z
		}
		if z < doc.Coarsest {
			doc.Coarsest = z
		}
	}
	if len(doc.Tiles) == 0 {
		return fmt.Errorf("manifest: no tiles under %s", out)
	}
	built, err := builtRegions(out)
	if err != nil {
		return err
	}
	if len(built) == 0 {
		return fmt.Errorf("manifest: %s/regions.json names no tier; build one first", out)
	}
	for _, id := range built {
		r, ok := regionByID(id)
		if !ok {
			return fmt.Errorf("manifest: built tier %q is not in the table", id)
		}
		doc.Regions = append(doc.Regions, manifestRegion{
			ID: r.ID, Label: r.Label, Native: r.Native, Datum: r.Datum,
			Vertical: r.Vertical, Licence: r.Licence, Attribution: r.Attribution,
			Bounds: r.Bounds,
		})
	}
	sort.Slice(doc.Regions, func(i, j int) bool { return doc.Regions[i].ID < doc.Regions[j].ID })
	b, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(b, '\n'), 0o644)
}

func countTiles(dir string) (int, error) {
	n := 0
	err := filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() && strings.HasSuffix(p, ".terrain") {
			n++
		}
		return nil
	})
	return n, err
}

// Receipt is a tile's hash, which is how an upload knows what changed: a tile
// is byte-deterministic for a given grid, so an unchanged one is never
// re-uploaded and never rolls its ETag.
func receipt(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
