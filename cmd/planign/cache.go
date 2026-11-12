// cache.go keeps the harvest on disk, one file per tile, so a run that is
// stopped (a deadline, a crash, a pulled cable, a CI job hitting its limit)
// resumes where it was instead of asking IGN for 160,000 tiles again.
//
// Layout under the cache directory:
//
//	params.json   what the cached tiles were fetched and encoded with
//	harvest.json  the day the harvest started: the edition's date
//	lock          the PID of the run holding the cache
//	tiles/z/x/y.tile  a present tile: 32-byte pixel hash, then the WebP
//	tiles/z/x/y.none  an absent tile: IGN answered 404
//
// Every file is written beside its name and renamed, so an interrupted
// write never leaves a half tile for the next run to adopt.

package main

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// params are what make a cached tile what it is. A cache fetched or
// encoded otherwise is refused rather than mixed into a new edition. The
// regions and zooms are not here: they decide which tiles a run WANTS, and a
// tile already cached under other boxes is the same tile.
type params struct {
	Layer     string `json:"layer"`
	Style     string `json:"style"`
	MatrixSet string `json:"matrixSet"`
	Format    string `json:"format"`
	Quality   int    `json:"quality"`
	Method    int    `json:"method"`
}

func currentParams() params {
	return params{
		Layer:     wmtsLayer,
		Style:     wmtsStyle,
		MatrixSet: wmtsMatrixSet,
		Format:    wmtsFormat,
		Quality:   webpQuality,
		Method:    webpMethod,
	}
}

// harvest records when the harvest began. Its date is the edition's
// `version`, the "date de dernière mise à jour" the Licence Ouverte asks a
// reuse to state.
type harvest struct {
	Started string `json:"started"` // YYYY-MM-DD, UTC
}

// staleAfter is how old a cache may be before a run refuses to continue it
// without being told. IGN updates Plan IGN monthly: a cache from last
// quarter resumed by mistake would publish last quarter's map as new.
const staleAfter = 7 * 24 * time.Hour

type cache struct {
	dir     string
	started string
}

// openCache takes the cache directory for a run. fresh empties it first;
// resume continues a cache older than staleAfter. The returned func releases
// the lock.
func openCache(dir string, fresh, resume bool, now time.Time) (*cache, func(), error) {
	if fresh {
		if err := os.RemoveAll(dir); err != nil {
			return nil, nil, err
		}
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, nil, err
	}
	release, err := lockDir(dir)
	if err != nil {
		return nil, nil, err
	}
	c := &cache{dir: dir}
	if err := c.checkParams(); err != nil {
		release()
		return nil, nil, err
	}
	if err := c.loadHarvest(now, resume); err != nil {
		release()
		return nil, nil, err
	}
	return c, release, nil
}

func (c *cache) checkParams() error {
	want := currentParams()
	path := filepath.Join(c.dir, "params.json")
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return writeJSON(path, want)
	}
	if err != nil {
		return err
	}
	var got params
	if err := json.Unmarshal(b, &got); err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	if got != want {
		return fmt.Errorf("cache %s was made with %+v, this build uses %+v: pass -fresh", c.dir, got, want)
	}
	return nil
}

func (c *cache) loadHarvest(now time.Time, resume bool) error {
	path := filepath.Join(c.dir, "harvest.json")
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		h := harvest{Started: now.UTC().Format(time.DateOnly)}
		c.started = h.Started
		return writeJSON(path, h)
	}
	if err != nil {
		return err
	}
	var h harvest
	if err := json.Unmarshal(b, &h); err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	day, err := time.Parse(time.DateOnly, h.Started)
	if err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	if now.Sub(day) > staleAfter && !resume {
		return fmt.Errorf("cache %s is a harvest started on %s: pass -fresh for a new edition or -resume to finish that one", c.dir, h.Started)
	}
	c.started = h.Started
	return nil
}

// lockDir claims the cache for this process. A lock left by a process that
// no longer runs is taken over; a live one is refused, since two harvests
// writing one cache would both believe they own the tiles.
func lockDir(dir string) (func(), error) {
	path := filepath.Join(dir, "lock")
	for range 2 {
		f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if err == nil {
			_, werr := fmt.Fprintf(f, "%d\n", os.Getpid())
			cerr := f.Close()
			if werr != nil || cerr != nil {
				os.Remove(path)
				return nil, errors.Join(werr, cerr)
			}
			return func() { os.Remove(path) }, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, err
		}
		b, _ := os.ReadFile(path)
		pid, perr := strconv.Atoi(strings.TrimSpace(string(b)))
		if perr == nil && pid > 0 && processAlive(pid) {
			return nil, fmt.Errorf("cache %s is held by process %d", dir, pid)
		}
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
	}
	return nil, fmt.Errorf("cache %s: could not take the lock", dir)
}

func processAlive(pid int) bool {
	p, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return p.Signal(syscall.Signal(0)) == nil
}

func (c *cache) path(t tile, ext string) string {
	return filepath.Join(c.dir, "tiles", strconv.Itoa(int(t.z)), strconv.FormatUint(uint64(t.x), 10),
		strconv.FormatUint(uint64(t.y), 10)+ext)
}

// resolved reports whether the cache already answers for t.
func (c *cache) resolved(t tile) bool {
	if _, err := os.Stat(c.path(t, ".tile")); err == nil {
		return true
	}
	_, err := os.Stat(c.path(t, ".none"))
	return err == nil
}

func (c *cache) putTile(t tile, e encoded) error {
	b := make([]byte, 0, sha256.Size+len(e.webp))
	b = append(b, e.pixels[:]...)
	b = append(b, e.webp...)
	return writeAtomic(c.path(t, ".tile"), b)
}

func (c *cache) putNone(t tile) error {
	return writeAtomic(c.path(t, ".none"), nil)
}

// cachedTile is a tile read back from the cache.
type cachedTile struct {
	present bool
	pixels  [sha256.Size]byte
	webp    []byte
}

// get reads t back. A tile the cache does not answer for is an error: the
// archive is only assembled from a complete harvest.
func (c *cache) get(t tile) (cachedTile, error) {
	b, err := os.ReadFile(c.path(t, ".tile"))
	if err == nil {
		if len(b) <= sha256.Size {
			return cachedTile{}, fmt.Errorf("%s: truncated tile", t)
		}
		var ct cachedTile
		ct.present = true
		copy(ct.pixels[:], b[:sha256.Size])
		ct.webp = b[sha256.Size:]
		return ct, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return cachedTile{}, err
	}
	if _, err := os.Stat(c.path(t, ".none")); err == nil {
		return cachedTile{}, nil
	}
	return cachedTile{}, fmt.Errorf("%s: not harvested", t)
}

func writeAtomic(path string, b []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".part"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func writeJSON(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "\t")
	if err != nil {
		return err
	}
	return writeAtomic(path, append(b, '\n'))
}
