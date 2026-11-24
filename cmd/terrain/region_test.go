package main

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/0intro/loxodrome/internal/terrain"
)

// plane is one whole degree of flat ground.
type plane struct {
	west, south, v float64
}

func (p *plane) Pool(w, s, e, n float64) (float64, float64, float64, bool) {
	if e <= p.west || w >= p.west+1 || n <= p.south || s >= p.south+1 {
		return 0, 0, 0, false
	}
	return p.v, p.v, p.v, true
}

func (p *plane) Nearest(lon, lat float64) (float64, bool) {
	if lon < p.west || lon >= p.west+1 || lat < p.south || lat >= p.south+1 {
		return 0, false
	}
	return p.v, true
}

// degrees serves a raster per whole degree it holds, keyed by the degree's
// south-west corner, and nothing for the ones it withholds, as Copernicus
// does.
func degrees(held map[[2]int]*plane) provider {
	return &named{label: "test degrees", cache: newDegreeCache(8, func(lat, lon int) (terrain.Source, error) {
		if p, ok := held[[2]int{lon, lat}]; ok {
			return p, nil
		}
		return nil, nil
	})}
}

func quiet(string, ...any) {}

// inside is a box within one tile, so a build over it builds that tile alone.
func inside(z, x, y int) [4]float64 {
	return [4]float64{
		terrain.TileLon(z, float64(x)+0.25), terrain.TileLat(z, float64(y)+0.75),
		terrain.TileLon(z, float64(x)+0.75), terrain.TileLat(z, float64(y)+0.25),
	}
}

// GLO-30 withholds whole degrees, so the Caucasus pass builds a tile on the
// edge of one from the degree beside it and no-data over the rest. Written
// as it stood, that tile replaced the one NASADEM had written, and the strip
// of the withheld degree it covered lost its ground. 12/2537/1528 is such a
// tile in the mosaic: GLO-30 serves N41/E042 and withholds N41/E043.
func TestBuildKeepsTheGroundItHasNoSourceFor(t *testing.T) {
	out := t.TempDir()
	const z, x, y = 12, 2537, 1528
	if err := writeTile(out, flat(z, x, y, 400)); err != nil {
		t.Fatal(err)
	}
	glo30 := degrees(map[[2]int]*plane{{42, 41}: {42, 41, 500}})
	r, _ := regionByID("glo30")
	if err := buildRegion(r, glo30, nil, inside(z, x, y), out, 1, false, quiet); err != nil {
		t.Fatal(err)
	}
	got, err := readTile(out, z, x, y)
	if err != nil || got == nil {
		t.Fatalf("readTile(%d/%d/%d) = %v, %v", z, x, y, got, err)
	}
	built, kept := 0, 0
	for j := 0; j < terrain.Size; j++ {
		for i := 0; i < terrain.Size; i++ {
			k := j*terrain.Size + i
			want := int16(500)
			if terrain.TileLon(z, float64(x)+float64(i)/terrain.Size) >= 43 {
				want = 400
				kept++
			} else {
				built++
			}
			if got.Mean[k] != want || got.Max[k] != want || got.Min[k] != want {
				t.Fatalf("pixel %d,%d is %d/%d/%d, want %d", i, j, got.Min[k], got.Mean[k], got.Max[k], want)
			}
		}
	}
	if built == 0 || kept == 0 {
		t.Fatalf("%d pixels built and %d kept: the tile does not straddle 43 E", built, kept)
	}
}

// A tile on disk that does not decode is neither ground to keep nor a tile
// to write over: the build stops on it.
func TestBuildStopsOnATileItCannotRead(t *testing.T) {
	out := t.TempDir()
	const z, x, y = 12, 2537, 1528
	p := tilePath(out, z, x, y)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	junk := []byte("not a tile")
	if err := os.WriteFile(p, junk, 0o644); err != nil {
		t.Fatal(err)
	}
	glo30 := degrees(map[[2]int]*plane{{42, 41}: {42, 41, 500}})
	r, _ := regionByID("glo30")
	if err := buildRegion(r, glo30, nil, inside(z, x, y), out, 1, false, quiet); err == nil {
		t.Fatal("buildRegion wrote over a tile it could not read")
	}
	if b, err := os.ReadFile(p); err != nil || !bytes.Equal(b, junk) {
		t.Fatalf("the unreadable tile was replaced: %q, %v", b, err)
	}
}

// writeASC writes an ESRI ASCII grid of n by n cells of one value, tied at
// its outer corner as IGN ties RGE ALTI's.
func writeASC(t *testing.T, path string, xll, yll, cell float64, n, v int) {
	t.Helper()
	var b strings.Builder
	fmt.Fprintf(&b, "ncols %d\nnrows %d\nxllcorner %.3f\nyllcorner %.3f\ncellsize %g\nNODATA_value -99999\n",
		n, n, xll, yll, cell)
	row := strings.TrimSuffix(strings.Repeat(strconv.Itoa(v)+" ", n), " ") + "\n"
	for range n {
		b.WriteString(row)
	}
	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		t.Fatal(err)
	}
}

// RGE ALTI ships in grids of 1 km, and a z14 tile over France is 1.7 km
// across, so a tile can stand on nine of them. The build gathered only the
// grids under the tile's four corners and its centre, and wrote no-data over
// the other four: the ones in the middle of each edge.
func TestBuildReadsEveryGridUnderATile(t *testing.T) {
	dir := t.TempDir()
	// Over Lyon, 45.74 N.
	const z, x, y = 14, 8412, 5845
	l93 := terrain.Lambert93()
	cx, cy := l93.Forward(terrain.TileLon(z, x+0.5), terrain.TileLat(z, y+0.5))
	want := map[int16]bool{}
	for j := -1; j <= 1; j++ {
		for i := -1; i <= 1; i++ {
			v := 100 + 10*(j+1) + i + 1
			want[int16(v)] = true
			name := filepath.Join(dir, fmt.Sprintf("dalle_%d_%d.asc", i+1, j+1))
			writeASC(t, name, cx+float64(i)*1000-500, cy+float64(j)*1000-500, 5, 200, v)
		}
	}
	fr, err := asciiGrids(dir, l93, "RGE ALTI")
	if err != nil {
		t.Fatal(err)
	}
	r, _ := regionByID("fr")
	tile, ok, err := buildOne(r, fr, nil, x, y)
	if err != nil || !ok {
		t.Fatalf("buildOne(%d/%d/%d) = %v, %v", z, x, y, ok, err)
	}
	seen := map[int16]int{}
	for _, v := range tile.Mean {
		seen[v]++
	}
	if n := seen[terrain.NoData]; n > 0 {
		t.Errorf("%d of %d pixels are no-data", n, terrain.Pixels)
	}
	for v := range want {
		if seen[v] == 0 {
			t.Errorf("the grid of %d m is missing from the tile", v)
		}
	}
}
