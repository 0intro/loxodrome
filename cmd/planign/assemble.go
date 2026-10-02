// assemble.go turns a complete harvest into the archive and its report.
//
// The archive is written beside its name and renamed only after it has been
// verified (internal/pmtiles' own Verify) and read back tile by tile against
// the cache: a writer bug would otherwise reach every pilot who downloads it.

package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strconv"

	"github.com/0intro/loxodrome/internal/pmtiles"
)

const (
	archiveName = "planign.pmtiles"
	reportName  = "planign.json"
)

// center is where a reader that honours the header opens: mainland France.
var center = [3]float64{2.5, 46.6, 6}

// report is planign.json: what was built, and what the decision was.
type report struct {
	Version string         `json:"version"`
	Digest  string         `json:"digest"`
	Bytes   int64          `json:"bytes"`
	SHA256  string         `json:"sha256"`
	Present int            `json:"present"`
	Absent  int            `json:"absent"`
	PerZoom map[string]int `json:"perZoom"`
	Header  struct {
		Addressed uint64 `json:"addressed"`
		Entries   uint64 `json:"entries"`
		Contents  uint64 `json:"contents"`
		Leaves    bool   `json:"leaves"`
	} `json:"header"`
	// Census counts present tiles whose parent is absent. Zero means the
	// pyramid is monotonic, which is what pruning would assume.
	Census int `json:"census"`
	// TopDuplicates lists the pixel images shared by the most tiles: sea,
	// mostly, but a placeholder IGN served in place of 404s would show here.
	TopDuplicates []duplicate `json:"topDuplicates"`
	Decision      string      `json:"decision,omitempty"`
	Reason        string      `json:"reason,omitempty"`
}

type duplicate struct {
	Pixels string         `json:"pixels"`
	Tiles  int            `json:"tiles"`
	Zooms  map[string]int `json:"zooms"`
}

// assembleOptions carry what the fixture test overrides.
type assembleOptions struct {
	leafSize int // pmtiles.Options.LeafSize
}

func currentContentParams(boxes []region, hi uint8) contentParams {
	return contentParams{
		Layer:        wmtsLayer,
		Style:        wmtsStyle,
		MatrixSet:    wmtsMatrixSet,
		MinZoom:      minZoom,
		MaxZoom:      int(hi),
		WorldMaxZoom: worldMaxZoom,
		Regions:      boxes,
		Margin:       lowZoomMargin,
		MarginMax:    lowZoomMarginMaxZoom,
		TileType:     "webp",
		Quality:      webpQuality,
		Method:       webpMethod,
		MetaRevision: metaRevision,
	}
}

// bounds is the union of the boxes: west, south, east, north.
func bounds(boxes []region) [4]float64 {
	b := [4]float64{180, 90, -180, -90}
	for _, r := range boxes {
		b[0], b[1] = min(b[0], r.West), min(b[1], r.South)
		b[2], b[3] = max(b[2], r.East), max(b[3], r.North)
	}
	return b
}

// metadata is the archive's JSON metadata.
func metadata(version, digest string, boxes []region, hi uint8, perZoom map[string]int) map[string]any {
	return map[string]any{
		"name":              "Plan IGN",
		"description":       "IGN's Plan IGN over France and its overseas territories, for the Loxodrome offline base map.",
		"attribution":       "© IGN, Plan IGN, Licence Ouverte 2.0",
		"version":           version,
		"type":              "baselayer",
		"format":            "webp",
		"minzoom":           minZoom,
		"maxzoom":           int(hi),
		"bounds":            bounds(boxes),
		"center":            center,
		"loxodrome:source":  wmtsEndpoint + " " + wmtsLayer + " " + wmtsMatrixSet,
		"loxodrome:digest":  digest,
		"loxodrome:tiles":   perZoom,
		"loxodrome:licence": "Licence Ouverte 2.0 (Etalab)",
	}
}

// assemble writes outDir/planign.pmtiles from the cache and returns the
// report. Every wanted tile must be resolved in the cache.
func assemble(c *cache, want []tile, boxes []region, hi uint8, outDir string, opt assembleOptions) (*report, error) {
	sorted := slices.Clone(want)
	slices.SortFunc(sorted, func(a, b tile) int {
		ia, ib := pmtiles.ZxyToID(a.z, a.x, a.y), pmtiles.ZxyToID(b.z, b.x, b.y)
		switch {
		case ia < ib:
			return -1
		case ia > ib:
			return 1
		}
		return 0
	})

	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return nil, err
	}
	spool, err := os.CreateTemp(outDir, "spool-*")
	if err != nil {
		return nil, err
	}
	defer func() {
		spool.Close()
		os.Remove(spool.Name())
	}()

	dg, err := newDigester(currentContentParams(boxes, hi))
	if err != nil {
		return nil, err
	}
	w := pmtiles.NewWriter(spool, pmtiles.Options{
		TileType:   pmtiles.TileTypeWebP,
		Bounds:     bounds(boxes),
		Center:     [2]float64{center[0], center[1]},
		CenterZoom: uint8(center[2]),
		LeafSize:   opt.leafSize,
	})

	rep := &report{Version: c.started, PerZoom: map[string]int{}}
	wanted := make(map[tile]bool, len(sorted))
	for _, t := range sorted {
		wanted[t] = true
	}
	present := make(map[tile]bool, len(sorted))
	dups := map[[sha256.Size]byte]*duplicate{}
	// TileID order is zoom order, so a tile's parent is always seen first.
	for _, t := range sorted {
		ct, err := c.get(t)
		if err != nil {
			return nil, err
		}
		if !ct.present {
			rep.Absent++
			continue
		}
		present[t] = true
		rep.Present++
		z := strconv.Itoa(int(t.z))
		rep.PerZoom[z]++
		if t.z > minZoom {
			if p := t.parent(); wanted[p] && !present[p] {
				rep.Census++
			}
		}
		d := dups[ct.pixels]
		if d == nil {
			d = &duplicate{Pixels: hex.EncodeToString(ct.pixels[:8]), Zooms: map[string]int{}}
			dups[ct.pixels] = d
		}
		d.Tiles++
		d.Zooms[z]++
		dg.add(t, ct.pixels)
		if err := w.Add(pmtiles.ZxyToID(t.z, t.x, t.y), ct.webp); err != nil {
			return nil, err
		}
	}
	if rep.Present == 0 {
		return nil, fmt.Errorf("no tile present among %d", len(sorted))
	}
	rep.Digest = dg.sum()
	rep.TopDuplicates = topDuplicates(dups, 8)

	part := filepath.Join(outDir, archiveName+".part")
	out, err := os.Create(part)
	if err != nil {
		return nil, err
	}
	hasher := sha256.New()
	h, err := w.Finish(io.MultiWriter(out, hasher), metadata(c.started, rep.Digest, boxes, hi, rep.PerZoom))
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return nil, err
	}
	rep.SHA256 = hex.EncodeToString(hasher.Sum(nil))
	rep.Header.Addressed, rep.Header.Entries, rep.Header.Contents = h.AddressedTiles, h.TileEntries, h.TileContents
	rep.Header.Leaves = h.LeafLength > 0

	if err := readBack(part, c, sorted); err != nil {
		return nil, fmt.Errorf("%s: %w", part, err)
	}
	info, err := os.Stat(part)
	if err != nil {
		return nil, err
	}
	rep.Bytes = info.Size()
	if err := os.Rename(part, filepath.Join(outDir, archiveName)); err != nil {
		return nil, err
	}
	return rep, writeJSON(filepath.Join(outDir, reportName), rep)
}

// readBack verifies the written archive and compares every tile with the
// cache, present and absent alike.
func readBack(path string, c *cache, sorted []tile) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	rd, err := pmtiles.Open(f, info.Size())
	if err != nil {
		return err
	}
	if err := pmtiles.Verify(rd); err != nil {
		return fmt.Errorf("verify: %w", err)
	}
	for _, t := range sorted {
		ct, err := c.get(t)
		if err != nil {
			return err
		}
		got, err := rd.Get(t.z, t.x, t.y)
		if err != nil {
			return fmt.Errorf("%s: %w", t, err)
		}
		if ct.present != (got != nil) || !bytes.Equal(got, ct.webp) {
			return fmt.Errorf("%s: read back differs from the cache", t)
		}
	}
	return nil
}

func topDuplicates(dups map[[sha256.Size]byte]*duplicate, n int) []duplicate {
	var all []duplicate
	for _, d := range dups {
		if d.Tiles > 1 {
			all = append(all, *d)
		}
	}
	slices.SortFunc(all, func(a, b duplicate) int {
		if a.Tiles != b.Tiles {
			return b.Tiles - a.Tiles
		}
		if a.Pixels < b.Pixels {
			return -1
		}
		return 1
	})
	return all[:min(n, len(all))]
}
