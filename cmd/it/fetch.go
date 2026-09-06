// fetch.go downloads an open flightmaps snapshot.
//
// The public bucket is laid out by AIRAC cycle:
//
//	https://snapshots.openflightmaps.org/live/<YYNN>/ofmx/<region>/latest/ofmx_<region>.zip
//
// so the current cycle is derived from the AIRAC calendar rather than
// scraped. When that cycle is not published yet the previous one is
// tried, which is the normal state for the day or two after a rollover.

package main

import (
	"archive/zip"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/overlay"
)

const snapshotBase = "https://snapshots.openflightmaps.org/live"

func snapshotURL(cycle string) string {
	return fmt.Sprintf("%s/%s/ofmx/%s/latest/ofmx_%s.zip", snapshotBase, cycle, region, region)
}

// download fetches the snapshot for the given cycle, or for the current
// AIRAC cycle when none is named, falling back to the previous one.
func download(ctx context.Context, cycle, keepPath string) (path string, cleanup func(), err error) {
	cycles := []string{cycle}
	if cycle == "" {
		now := time.Now()
		cur := aip.CurrentAirac(now)
		cycles = []string{
			aip.AiracYYNN(cur),
			// The bucket can lag the rollover by a day or two; the cycle
			// before is the honest fallback rather than failing the run.
			aip.AiracYYNN(cur.AddDate(0, 0, -28)),
		}
	}

	var lastErr error
	for _, c := range cycles {
		body, err := overlay.HTTPGetAll(ctx, snapshotURL(c))
		if err != nil {
			lastErr = fmt.Errorf("cycle %s: %w", c, err)
			continue
		}
		// The bucket answers a small XML error document rather than a 404
		// for a missing key, so check the archive magic before trusting it.
		if len(body) < 4 || string(body[:2]) != "PK" {
			lastErr = fmt.Errorf("cycle %s: not a zip (%d bytes)", c, len(body))
			continue
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
		f, err := os.CreateTemp("", "ofmx-*.zip")
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
	return "", nil, fmt.Errorf("no OFMX snapshot for region %s: %w", region, lastErr)
}

// openSnapshot opens the .ofmx document inside the archive.
//
// The archive carries two forms of the same data: "isolated", which is
// the region alone, and "embedded", which repeats every neighbour's
// airspace that touches it. The isolated one is what we want: the
// neighbours are already covered by their own publishers, and the
// embedded copies would collide with them in the merge.
func openSnapshot(path string) (io.ReadCloser, string, error) {
	if strings.EqualFold(filepath.Ext(path), ".ofmx") || strings.EqualFold(filepath.Ext(path), ".xml") {
		f, err := os.Open(path)
		if err != nil {
			return nil, "", err
		}
		return f, filepath.Base(path), nil
	}
	zr, err := zip.OpenReader(path)
	if err != nil {
		return nil, "", fmt.Errorf("open %s: %w", path, err)
	}
	var pick *zip.File
	for _, f := range zr.File {
		if !strings.HasSuffix(strings.ToLower(f.Name), ".ofmx") {
			continue
		}
		if !strings.Contains(strings.ToLower(f.Name), "/isolated/") {
			continue
		}
		if pick == nil || f.UncompressedSize64 > pick.UncompressedSize64 {
			pick = f
		}
	}
	if pick == nil {
		_ = zr.Close()
		return nil, "", fmt.Errorf("%s has no isolated/*.ofmx member", filepath.Base(path))
	}
	fr, err := pick.Open()
	if err != nil {
		_ = zr.Close()
		return nil, "", err
	}
	return zipStream{fr, zr}, filepath.Base(pick.Name), nil
}

// zipStream ties a member stream's lifetime to its archive's.
type zipStream struct {
	io.ReadCloser
	zr *zip.ReadCloser
}

func (m zipStream) Close() error {
	err := m.ReadCloser.Close()
	if zerr := m.zr.Close(); err == nil {
		err = zerr
	}
	return err
}

// errCount reports a sanity-window failure.
func errCount(n, minN, maxN int) error {
	return fmt.Errorf("IT nature zone count %d outside sanity window [%d, %d] - source format may have changed",
		n, minN, maxN)
}
