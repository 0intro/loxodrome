package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gen2brain/webp"

	"github.com/0intro/loxodrome/internal/pmtiles"
)

var update = flag.Bool("update", false, "rewrite tests/fixtures/planign-mini.pmtiles")

// fixturePath is the archive tests/planignPack.spec.ts reads with the
// app's own pmtiles reader: the writer pinned across the language boundary.
const fixturePath = "../../tests/fixtures/planign-mini.pmtiles"

// solid is a 256 px PNG of one color.
func solid(t testing.TB, c color.NRGBA) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, tileSize, tileSize))
	for i := 0; i < len(img.Pix); i += 4 {
		img.Pix[i], img.Pix[i+1], img.Pix[i+2], img.Pix[i+3] = c.R, c.G, c.B, c.A
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

var (
	sea   = color.NRGBA{170, 211, 223, 255}
	land  = color.NRGBA{242, 239, 233, 255}
	urban = color.NRGBA{220, 200, 190, 255}
)

// fixtureTiles is the small pyramid the fixture holds: the world at zoom 0
// and 1 (three identical sea tiles in a row, so a run, and a land tile
// identical to zoom 0, so a back-reference), one tile over Paris at every
// zoom from 2 to 13, and Paris's eastern neighbour at zoom 13, absent.
func fixtureTiles() (want []tile, colors map[tile]color.NRGBA) {
	colors = map[tile]color.NRGBA{
		{0, 0, 0}: land,
		{1, 0, 0}: sea, {1, 0, 1}: sea, {1, 1, 1}: sea, // TileIDs 1, 2, 3
		{1, 1, 0}: land, // TileID 4
	}
	for z := uint8(2); z <= maxZoom; z++ {
		c := land
		if z%3 == 0 {
			c = color.NRGBA{200, 220, 180, 255}
		}
		if z == maxZoom {
			c = urban
		}
		colors[tile{z, lonToX(2.3488, z), latToY(48.8534, z)}] = c
	}
	for tl := range colors {
		want = append(want, tl)
	}
	east := tile{maxZoom, lonToX(2.3488, maxZoom) + 1, latToY(48.8534, maxZoom)}
	want = append(want, east)
	return want, colors
}

// buildFixture assembles the fixture pyramid through the real assembly,
// leaves forced, into outDir.
func buildFixture(t testing.TB, outDir string) *report {
	t.Helper()
	dir := t.TempDir()
	if err := writeJSON(filepath.Join(dir, "harvest.json"), harvest{Started: "2026-10-01"}); err != nil {
		t.Fatal(err)
	}
	c, release, err := openCache(dir, false, true, day0)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	want, colors := fixtureTiles()
	for _, tl := range want {
		col, ok := colors[tl]
		if !ok {
			if err := c.putNone(tl); err != nil {
				t.Fatal(err)
			}
			continue
		}
		e, err := encodeTile(solid(t, col))
		if err != nil {
			t.Fatal(err)
		}
		if err := c.putTile(tl, e); err != nil {
			t.Fatal(err)
		}
	}
	rep, err := assemble(c, want, regions, maxZoom, outDir, assembleOptions{leafSize: 4})
	if err != nil {
		t.Fatal(err)
	}
	return rep
}

func openArchive(t testing.TB, path string) *pmtiles.Reader {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	rd, err := pmtiles.Open(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		t.Fatal(err)
	}
	return rd
}

func TestAssembleFixture(t *testing.T) {
	out := t.TempDir()
	rep := buildFixture(t, out)
	if rep.Present != 17 || rep.Absent != 1 || rep.Census != 0 {
		t.Fatalf("present %d absent %d census %d", rep.Present, rep.Absent, rep.Census)
	}
	if !rep.Header.Leaves || rep.Header.Contents != 4 {
		t.Fatalf("header %+v", rep.Header)
	}
	if rep.PerZoom["13"] != 1 || rep.PerZoom["1"] != 4 {
		t.Fatalf("per zoom %v", rep.PerZoom)
	}
	rd := openArchive(t, filepath.Join(out, archiveName))
	if err := pmtiles.Verify(rd); err != nil {
		t.Fatal(err)
	}
	h := rd.Header()
	if h.TileType != pmtiles.TileTypeWebP || h.MinZoom != minZoom || h.MaxZoom != maxZoom || h.CenterZoom != 6 {
		t.Fatalf("header %+v", h)
	}
	var meta map[string]any
	if err := rd.Metadata(&meta); err != nil {
		t.Fatal(err)
	}
	if meta["version"] != "2026-10-01" || meta["loxodrome:digest"] != rep.Digest || !strings.Contains(meta["attribution"].(string), "Licence Ouverte") {
		t.Fatalf("metadata %v", meta)
	}
	// The report on disk is the one returned.
	b, _ := os.ReadFile(filepath.Join(out, reportName))
	var onDisk report
	if err := json.Unmarshal(b, &onDisk); err != nil || onDisk.Digest != rep.Digest || onDisk.Bytes != rep.Bytes {
		t.Fatalf("planign.json: %v %+v", err, onDisk)
	}
}

func TestDigestIsThePixels(t *testing.T) {
	a := buildFixture(t, t.TempDir())
	b := buildFixture(t, t.TempDir())
	if a.Digest != b.Digest {
		t.Fatal("the same pixels gave two digests")
	}
	// Another parameter is another edition.
	p := currentContentParams(regions, maxZoom)
	p.Quality = 70
	d1, _ := newDigester(currentContentParams(regions, maxZoom))
	d2, _ := newDigester(p)
	if d1.sum() == d2.sum() {
		t.Fatal("the quality is not in the digest")
	}
}

func TestDecide(t *testing.T) {
	rep := &report{Digest: "new", PerZoom: map[string]int{"8": 100, "12": 10000, "13": 39000}}
	if d, _, err := decide(nil, rep, false); err != nil || d != "upload" {
		t.Fatalf("first edition: %s %v", d, err)
	}
	same := &published{Version: "2026-07-03", Digest: "new", Tiles: rep.PerZoom}
	if d, _, err := decide(same, rep, false); err != nil || d != "skip" {
		t.Fatalf("unchanged: %s %v", d, err)
	}
	if d, _, err := decide(same, rep, true); err != nil || d != "upload" {
		t.Fatalf("forced: %s %v", d, err)
	}
	grown := &published{Version: "2026-07-03", Digest: "old", Tiles: map[string]int{"8": 100, "12": 9990, "13": 39000}}
	if d, _, err := decide(grown, rep, false); err != nil || d != "upload" {
		t.Fatalf("changed: %s %v", d, err)
	}
	// Zoom 13 lost 2 %: an outage's 404s, refused.
	lost := &published{Version: "2026-07-03", Digest: "old", Tiles: map[string]int{"13": 39800}}
	if _, _, err := decide(lost, rep, false); err == nil {
		t.Fatal("a zoom that lost 2 % of its tiles was accepted")
	}
	if d, _, err := decide(lost, rep, true); err != nil || d != "upload" {
		t.Fatalf("-force: %s %v", d, err)
	}
	// Low zooms are not guarded: the world's sea tiles may merge.
	low := &published{Version: "2026-07-03", Digest: "old", Tiles: map[string]int{"5": 2000}}
	if _, _, err := decide(low, rep, false); err != nil {
		t.Fatalf("zoom 5: %v", err)
	}
}

// worker mimics the chart worker's archive route over a file: Origin gate,
// HEAD with size and ETag, single bytes=N- or N-M ranges, exposed headers.
func worker(t *testing.T, path string) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Origin") != appOrigin {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		b, err := os.ReadFile(path)
		if err != nil {
			http.Error(w, "archive not found in R2", http.StatusNotFound)
			return
		}
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", appOrigin)
		h.Set("Access-Control-Expose-Headers", "ETag, Content-Range, Accept-Ranges, Content-Length")
		h.Set("ETag", `"abc-3"`)
		h.Set("Accept-Ranges", "bytes")
		size := int64(len(b))
		rng := r.Header.Get("Range")
		if rng == "" {
			h.Set("Content-Length", strconv.FormatInt(size, 10))
			if r.Method == http.MethodGet {
				_, _ = w.Write(b)
			}
			return
		}
		var from, to int64
		spec := strings.TrimPrefix(rng, "bytes=")
		parts := strings.SplitN(spec, "-", 2)
		from, _ = strconv.ParseInt(parts[0], 10, 64)
		to = size - 1
		if parts[1] != "" {
			to, _ = strconv.ParseInt(parts[1], 10, 64)
		}
		to = min(to, size-1)
		h.Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", from, to, size))
		h.Set("Content-Length", strconv.FormatInt(to-from+1, 10))
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write(b[from : to+1])
	}))
}

func TestPublishedEditionOverHTTP(t *testing.T) {
	out := t.TempDir()
	rep := buildFixture(t, out)
	srv := worker(t, filepath.Join(out, archiveName))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	prev, err := readPublished(ctx, srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	if prev.Digest != rep.Digest || prev.Version != "2026-10-01" || prev.Tiles["13"] != 1 || prev.Bytes != rep.Bytes {
		t.Fatalf("published %+v", prev)
	}
	if err := checkPublished(ctx, srv.URL, rep); err != nil {
		t.Fatal(err)
	}
	// Another build is noticed.
	other := *rep
	other.Digest = "something else"
	if err := checkPublished(ctx, srv.URL, &other); err == nil {
		t.Fatal("a served edition other than the one built passed")
	}
	// Nothing published yet.
	gone := worker(t, filepath.Join(out, "missing.pmtiles"))
	defer gone.Close()
	if _, err := readPublished(ctx, gone.URL); err != errNotPublished {
		t.Fatalf("404: %v", err)
	}
}

// TestFixtureIsCurrent rebuilds the fixture and compares it with the
// committed one by MEANING: the header, the metadata, the tiles' layout and
// their pixels. Never the bytes: CI may run another Go (gzip) or encode
// through a system libwebp.
func TestFixtureIsCurrent(t *testing.T) {
	out := t.TempDir()
	buildFixture(t, out)
	built := filepath.Join(out, archiveName)
	if *update {
		b, err := os.ReadFile(built)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(fixturePath, b, 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("wrote %s (%d bytes)", fixturePath, len(b))
	}
	want, got := openArchive(t, built), openArchive(t, fixturePath)
	wh, gh := want.Header(), got.Header()
	if gh.TileType != wh.TileType || gh.MinZoom != wh.MinZoom || gh.MaxZoom != wh.MaxZoom ||
		gh.AddressedTiles != wh.AddressedTiles || gh.TileEntries != wh.TileEntries || gh.TileContents != wh.TileContents ||
		gh.MinLonE7 != wh.MinLonE7 || gh.MaxLatE7 != wh.MaxLatE7 || gh.CenterZoom != wh.CenterZoom || (gh.LeafLength > 0) != (wh.LeafLength > 0) {
		t.Fatalf("header\n got %+v\nwant %+v\n(go test ./cmd/planign -run TestFixtureIsCurrent -update)", gh, wh)
	}
	var wm, gm map[string]any
	if err := want.Metadata(&wm); err != nil {
		t.Fatal(err)
	}
	if err := got.Metadata(&gm); err != nil {
		t.Fatal(err)
	}
	wj, _ := json.Marshal(wm)
	gj, _ := json.Marshal(gm)
	if !bytes.Equal(wj, gj) {
		t.Fatalf("metadata\n got %s\nwant %s", gj, wj)
	}
	var we, ge []pmtiles.Entry
	_ = want.Walk(func(e pmtiles.Entry) error { we = append(we, e); return nil })
	_ = got.Walk(func(e pmtiles.Entry) error { ge = append(ge, e); return nil })
	if len(we) != len(ge) {
		t.Fatalf("%d entries, want %d", len(ge), len(we))
	}
	for i := range we {
		if we[i].TileID != ge[i].TileID || we[i].RunLength != ge[i].RunLength {
			t.Fatalf("entry %d: %+v, want %+v", i, ge[i], we[i])
		}
		wb, _ := want.TileData(we[i])
		gb, _ := got.TileData(ge[i])
		if !samePixels(t, wb, gb) {
			t.Fatalf("entry %d: the tiles' pixels differ", i)
		}
	}
}

// samePixels decodes two WebP tiles and compares them within the error a
// lossy encoder of another version may make on a solid tile.
func samePixels(t *testing.T, a, b []byte) bool {
	t.Helper()
	ia, err := webp.Decode(bytes.NewReader(a))
	if err != nil {
		t.Fatal(err)
	}
	ib, err := webp.Decode(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	if ia.Bounds() != ib.Bounds() {
		return false
	}
	for _, p := range []image.Point{{0, 0}, {128, 128}, {255, 255}, {17, 200}} {
		ra, ga, ba, _ := ia.At(p.X, p.Y).RGBA()
		rb, gb, bb, _ := ib.At(p.X, p.Y).RGBA()
		for _, d := range []int{int(ra>>8) - int(rb>>8), int(ga>>8) - int(gb>>8), int(ba>>8) - int(bb>>8)} {
			if d > 3 || d < -3 {
				return false
			}
		}
	}
	return true
}
