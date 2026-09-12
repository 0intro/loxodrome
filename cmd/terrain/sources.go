package main

import (
	"bufio"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/0intro/loxodrome/internal/terrain"
)

// A source PROVIDER answers "which raster covers this position", caching what
// it has fetched. The mosaic asks per output tile, so a provider is asked for
// the same degree cell hundreds of times running and must not fetch twice.
type provider interface {
	// at returns the source covering a position, or nil when the provider
	// publishes nothing there (a withheld tile, ocean, outside the product).
	at(lon, lat float64) (terrain.Source, error)
	// name is what the build log calls it.
	name() string
}

// degreeCache is the shared half of every provider below: one raster per
// whole degree, an LRU so a build walks a continent without holding it.
type degreeCache struct {
	mu    sync.Mutex
	order []string
	held  map[string]terrain.Source
	limit int
	load  func(latDeg, lonDeg int) (terrain.Source, error)
}

func newDegreeCache(limit int, load func(int, int) (terrain.Source, error)) *degreeCache {
	return &degreeCache{held: map[string]terrain.Source{}, limit: limit, load: load}
}

func (c *degreeCache) at(lon, lat float64) (terrain.Source, error) {
	latDeg := int(math.Floor(lat))
	lonDeg := int(math.Floor(lon))
	key := fmt.Sprintf("%d/%d", latDeg, lonDeg)
	c.mu.Lock()
	defer c.mu.Unlock()
	if s, ok := c.held[key]; ok {
		return s, nil
	}
	s, err := c.load(latDeg, lonDeg)
	if err != nil {
		return nil, err
	}
	c.held[key] = s
	c.order = append(c.order, key)
	for len(c.order) > c.limit {
		delete(c.held, c.order[0])
		c.order = c.order[1:]
	}
	return s, nil
}

// fetcher downloads a URL once and keeps the file, so a rerun of a build that
// died at 60 % costs nothing. A 404 is a fact about the product (Copernicus
// withholds tiles, and the sea has none) and is cached as such rather than
// retried every time.
type fetcher struct {
	dir    string
	client *http.Client
	mu     sync.Mutex
	absent map[string]bool
}

func newFetcher(dir string) *fetcher {
	return &fetcher{
		dir:    dir,
		client: &http.Client{Timeout: 10 * time.Minute},
		absent: map[string]bool{},
	}
}

// file returns the local path of a URL's body, or "" when the server says it
// does not exist.
func (f *fetcher) file(url, name string) (string, error) {
	path := filepath.Join(f.dir, name)
	if _, err := os.Stat(path); err == nil {
		return path, nil
	}
	f.mu.Lock()
	gone := f.absent[url]
	f.mu.Unlock()
	if gone {
		return "", nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", err
	}
	resp, err := f.client.Get(url)
	if err != nil {
		return "", fmt.Errorf("%s: %w", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusForbidden {
		f.mu.Lock()
		f.absent[url] = true
		f.mu.Unlock()
		return "", nil
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("%s: %s", url, resp.Status)
	}
	// Write beside the target and rename, so a run interrupted mid-download
	// never leaves a truncated raster where a complete one was.
	tmp := path + ".part"
	out, err := os.Create(tmp)
	if err != nil {
		return "", err
	}
	if _, err := io.Copy(out, resp.Body); err != nil {
		out.Close()
		os.Remove(tmp)
		return "", fmt.Errorf("%s: %w", url, err)
	}
	if err := out.Close(); err != nil {
		os.Remove(tmp)
		return "", err
	}
	return path, os.Rename(tmp, path)
}

// --- Copernicus GLO-30 / GLO-90 -----------------------------------------
//
// One Cloud-Optimized GeoTIFF per whole degree, anonymous on AWS Open Data.
// The public instance WITHHOLDS the tiles covering a few countries, and
// because it withholds by whole degree that takes their neighbours' ground
// with it: verified 2026-09-04, N41/E044 and N41/E045 are absent, which is
// Tbilisi and eastern Georgia. A missing tile here is not an error, it is the
// next source's turn.

func copernicus(f *fetcher, res int) provider {
	host := fmt.Sprintf("https://copernicus-dem-%dm.s3.amazonaws.com", res)
	step := 10
	if res == 90 {
		step = 30
	}
	return &named{
		label: fmt.Sprintf("Copernicus GLO-%d", res),
		cache: newDegreeCache(8, func(latDeg, lonDeg int) (terrain.Source, error) {
			id := fmt.Sprintf("Copernicus_DSM_COG_%d_%s_00_%s_00_DEM", step, ns(latDeg), ew(lonDeg))
			url := fmt.Sprintf("%s/%s/%s.tif", host, id, id)
			path, err := f.file(url, fmt.Sprintf("glo%d/%s.tif", res, id))
			if err != nil || path == "" {
				return nil, err
			}
			return openGeoTIFF(path)
		}),
	}
}

// --- NASADEM ------------------------------------------------------------
//
// Public domain, 1 arc-second, 60 N to 56 S: what fills the Copernicus holes
// without regressing Georgia from 30 m to the 90 m floor. The LP DAAC pool
// needs an Earthdata login, so the builder reads a DIRECTORY of .hgt files
// the operator downloaded once rather than carrying a credential.

// nasademFetched reads NASADEM from OpenTopography's public bucket, which
// serves it anonymously as one 1 arc-second GeoTIFF per degree.
//
// The product itself is distributed by the LP DAAC behind an Earthdata login,
// which would make this the one tier a build cannot complete unattended. It
// does not have to be: NASADEM is NASA data in the public domain, the login
// gates the DAAC's own distribution rather than the data, and OpenTopography
// hosts the same grids in the open. The bytes are checked on arrival like any
// other source, so the mirror is a delivery route and not a claim about the
// data.
//
// Deliberately NOT the other anonymous copy, s3://elevation-tiles-prod/skadi:
// that is the Mapzen bucket this whole mosaic exists to stop depending on.
func nasademFetched(f *fetcher) provider {
	const host = "https://opentopography.s3.sdsc.edu/raster/NASADEM/NASADEM_be"
	return &named{
		label: "NASADEM (OpenTopography mirror)",
		cache: newDegreeCache(8, func(latDeg, lonDeg int) (terrain.Source, error) {
			// The mirror lower-cases the hemisphere letters; the DAAC does not.
			id := fmt.Sprintf("NASADEM_HGT_%s%s", strings.ToLower(ns(latDeg)), strings.ToLower(ew(lonDeg)))
			url := fmt.Sprintf("%s/%s.tif", host, id)
			path, err := f.file(url, fmt.Sprintf("nasadem/%s.tif", id))
			if err != nil || path == "" {
				return nil, err
			}
			return openGeoTIFF(path)
		}),
	}
}

func nasadem(dir string) provider {
	return &named{
		label: "NASADEM",
		cache: newDegreeCache(8, func(latDeg, lonDeg int) (terrain.Source, error) {
			name := fmt.Sprintf("%s%s.hgt", ns(latDeg), ew(lonDeg))
			path := filepath.Join(dir, name)
			fh, err := os.Open(path)
			if os.IsNotExist(err) {
				return nil, nil
			}
			if err != nil {
				return nil, err
			}
			defer fh.Close()
			return terrain.ReadHGT(fh, name)
		}),
	}
}

// --- ESRI ASCII grids ---------------------------------------------------
//
// What IGN ships RGE ALTI as (1 m, per department, in its own projection),
// and what several other national agencies ship too. The archives are 7z, so
// the operator unpacks once and points the builder at the directory: a local
// build from data already on the machine, the cmd/fr idiom.

func asciiGrids(dir string, proj terrain.Projection, label string) (provider, error) {
	var paths []string
	err := filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() && strings.EqualFold(filepath.Ext(p), ".asc") {
			paths = append(paths, p)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if len(paths) == 0 {
		return nil, fmt.Errorf("%s: no .asc under %s", label, dir)
	}
	return &ascProvider{label: label, paths: paths, proj: proj, held: map[string]terrain.Source{}}, nil
}

type ascProvider struct {
	label string
	paths []string
	proj  terrain.Projection
	mu    sync.Mutex
	held  map[string]terrain.Source
	index []ascExtent
}

// ascExtent is a grid's own PROJECTED extent, read from its header. The
// coverage test projects the query point into it rather than inverting the
// projection: an inverse would be sixty lines of series per CRS to answer a
// question the forward direction already answers.
type ascExtent struct {
	path           string
	x0, y0, x1, y1 float64
}

func (a *ascProvider) name() string { return a.label }

// at loads the grid covering a position, building the extent index on first
// use: an ASCII grid states its own extent in its header, so the index is the
// headers alone and never the millions of values behind them.
func (a *ascProvider) at(lon, lat float64) (terrain.Source, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.index == nil {
		for _, p := range a.paths {
			e, err := ascHeaderExtent(p)
			if err != nil {
				return nil, err
			}
			a.index = append(a.index, e)
		}
	}
	x, y := a.proj.Forward(lon, lat)
	for _, e := range a.index {
		if x < e.x0 || x > e.x1 || y < e.y0 || y > e.y1 {
			continue
		}
		if s, ok := a.held[e.path]; ok {
			return s, nil
		}
		fh, err := os.Open(e.path)
		if err != nil {
			return nil, err
		}
		g, err := terrain.ReadAsciiGrid(fh)
		fh.Close()
		if err != nil {
			return nil, fmt.Errorf("%s: %w", e.path, err)
		}
		g.Proj = a.proj
		// One department at a time: they are large and a build walks them in
		// order.
		if len(a.held) > 4 {
			a.held = map[string]terrain.Source{}
		}
		a.held[e.path] = g
		return g, nil
	}
	return nil, nil
}

// ascHeaderExtent reads the six header lines of an ESRI ASCII grid and
// nothing else, so indexing a department costs a few hundred bytes a file
// rather than the millions of values behind them.
func ascHeaderExtent(path string) (ascExtent, error) {
	fh, err := os.Open(path)
	if err != nil {
		return ascExtent{}, err
	}
	defer fh.Close()
	head := make(map[string]float64, 6)
	br := bufio.NewReader(fh)
	for len(head) < 6 {
		line, err := br.ReadString('\n')
		if err != nil {
			return ascExtent{}, fmt.Errorf("%s: header: %w", path, err)
		}
		f := strings.Fields(line)
		if len(f) != 2 {
			return ascExtent{}, fmt.Errorf("%s: header line %q", path, strings.TrimSpace(line))
		}
		v, err := strconv.ParseFloat(f[1], 64)
		if err != nil {
			return ascExtent{}, fmt.Errorf("%s: header %q: %w", path, f[0], err)
		}
		head[strings.ToLower(f[0])] = v
	}
	cols, rows, size := head["ncols"], head["nrows"], head["cellsize"]
	x0, ok := head["xllcenter"]
	y0, okY := head["yllcenter"]
	if !ok || !okY {
		x0, ok = head["xllcorner"]
		y0, okY = head["yllcorner"]
		if !ok || !okY {
			return ascExtent{}, fmt.Errorf("%s: no xll/yll origin", path)
		}
		x0 += size / 2
		y0 += size / 2
	}
	return ascExtent{
		path: path,
		x0:   x0, y0: y0,
		x1: x0 + (cols-1)*size, y1: y0 + (rows-1)*size,
	}, nil
}

// --- EPSG:4326 GeoTIFF directories --------------------------------------
//
// The universal national input. Every agency ships its own CRS (Austria
// Lambert, RD New, LV95, TM35FIN), and writing an inverse for each would be
// several hundred lines of series apiece for a build-time step the operator
// runs once: reprojecting a national product to EPSG:4326 before the build is
// one command on their machine, and the reader refuses anything else rather
// than guessing.

func geoTIFFDir(dir, label string) (provider, error) {
	var paths []string
	err := filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		ext := strings.ToLower(filepath.Ext(p))
		if !d.IsDir() && (ext == ".tif" || ext == ".tiff") {
			paths = append(paths, p)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if len(paths) == 0 {
		return nil, fmt.Errorf("%s: no .tif under %s", label, dir)
	}
	sort.Strings(paths)
	return &tifProvider{label: label, paths: paths, held: map[string]terrain.Source{}}, nil
}

type tifProvider struct {
	label string
	paths []string
	mu    sync.Mutex
	held  map[string]terrain.Source
	index []tifExtent
}

type tifExtent struct {
	path                     string
	west, south, east, north float64
}

func (t *tifProvider) name() string { return t.label }

func (t *tifProvider) at(lon, lat float64) (terrain.Source, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.index == nil {
		for _, p := range t.paths {
			fh, err := os.Open(p)
			if err != nil {
				return nil, err
			}
			w, s, e, n, err := terrain.GeoTIFFBounds(fh)
			fh.Close()
			if err != nil {
				return nil, fmt.Errorf("%s: %w", p, err)
			}
			t.index = append(t.index, tifExtent{p, w, s, e, n})
		}
	}
	for _, e := range t.index {
		if lon < e.west || lon > e.east || lat < e.south || lat > e.north {
			continue
		}
		if s, ok := t.held[e.path]; ok {
			return s, nil
		}
		s, err := openGeoTIFF(e.path)
		if err != nil {
			return nil, err
		}
		if len(t.held) > 4 {
			t.held = map[string]terrain.Source{}
		}
		t.held[e.path] = s
		return s, nil
	}
	return nil, nil
}

// --- helpers ------------------------------------------------------------

type named struct {
	label string
	cache *degreeCache
}

func (n *named) name() string { return n.label }
func (n *named) at(lon, lat float64) (terrain.Source, error) {
	return n.cache.at(lon, lat)
}

func openGeoTIFF(path string) (terrain.Source, error) {
	fh, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer fh.Close()
	st, err := fh.Stat()
	if err != nil {
		return nil, err
	}
	g, err := terrain.ReadGeoTIFF(fh, st.Size())
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return g, nil
}

func ns(lat int) string {
	if lat < 0 {
		return fmt.Sprintf("S%02d", -lat)
	}
	return fmt.Sprintf("N%02d", lat)
}

func ew(lon int) string {
	if lon < 0 {
		return fmt.Sprintf("W%03d", -lon)
	}
	return fmt.Sprintf("E%03d", lon)
}
