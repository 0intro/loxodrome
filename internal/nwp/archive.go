package nwp

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/0intro/loxodrome/internal/pmtiles"
)

// Format names the archives this package writes.
const (
	Format        = "loxodrome-nwp"
	FormatVersion = 1
	WriterVersion = "nwp 1"
)

// GridDesc is the native grid in a descriptor.
type GridDesc struct {
	Ni    int   `json:"ni"`
	Nj    int   `json:"nj"`
	North int64 `json:"northE6"`
	West  int64 `json:"westE6"`
	Di    int64 `json:"diE6"`
	Dj    int64 `json:"djE6"`
	Wraps bool  `json:"wraps"`
}

// SegmentDesc lists a segment's variables and the hours it holds.
type SegmentDesc struct {
	Name  string `json:"name"`
	Steps []int  `json:"steps"`
	Vars  []Var  `json:"vars"`
}

// SourceRef names one source file a block was read from.
type SourceRef struct {
	URL  string `json:"url"`
	ETag string `json:"etag,omitempty"`
	Size int64  `json:"size"`
}

// Descriptor is an archive's metadata: everything a reader needs to turn
// a tile into values.
type Descriptor struct {
	Format     string        `json:"format"`
	Version    int           `json:"version"`
	Writer     string        `json:"writer"`
	Model      string        `json:"model"`
	Run        time.Time     `json:"run"`
	First      int           `json:"first"`
	Last       int           `json:"last"`
	Grid       GridDesc      `json:"grid"`
	Tile       int           `json:"tile"`
	Missing    int           `json:"missing"`
	Levels     []Level       `json:"levels"`
	Segments   []SegmentDesc `json:"segments"`
	GustPeriod []int         `json:"gustPeriod"`
	Covered    int           `json:"covered"`
	Sources    []SourceRef   `json:"sources,omitempty"`
}

// Canary is a tile whose segments' hashes the publisher checks with the
// read path's own decoder before a run goes live.
type Canary struct {
	Z        int      `json:"z"`
	X        int      `json:"x"`
	Y        int      `json:"y"`
	Segments []string `json:"segments"` // hex SHA-256 of each uncompressed segment
}

// ArchiveKey is where a block's archive lives in the bucket: a run's FIRST
// block under first/, kept a week for the past hours, the rest under
// blocks/, kept while the run is among its model's last three.
func ArchiveKey(m *Model, run time.Time, index int, b Block) string {
	if index == 0 {
		return "first/" + m.ID + "/" + RunKey(run) + ".pmtiles"
	}
	return "blocks/" + m.ID + "/" + RunKey(run) + "/" + b.Name() + ".pmtiles"
}

// VersionedKey names an archive by its content too, the first twelve hex
// digits of its SHA-256 before `.pmtiles`. The read path caches an
// archive's byte ranges for a week by (key, range) as immutable, so a block
// built again under its old key (a retry, a rebuild after lost state, another
// mirror's bytes, another Go release's deflate output) would shift every
// offset under a cached directory; under a key of its own, its receipt names
// it and the next publication releases the old one.
func VersionedKey(key, sha256 string) string {
	if len(sha256) < 12 || !strings.HasSuffix(key, ".pmtiles") {
		return key
	}
	return strings.TrimSuffix(key, ".pmtiles") + "." + sha256[:12] + ".pmtiles"
}

// ReceiptKey is where a block's receipt lives.
func ReceiptKey(m *Model, run time.Time, b Block) string {
	return "receipts/" + m.ID + "/" + RunKey(run) + "/" + b.Name() + ".json"
}

// Receipt describes a built archive.
type Receipt struct {
	Key      string    `json:"key"`
	Model    string    `json:"model"`
	Run      time.Time `json:"run"`
	First    int       `json:"first"`
	Last     int       `json:"last"`
	Size     int64     `json:"size"`
	SHA256   string    `json:"sha256"`
	Content  string    `json:"content"` // SHA-256 over every uncompressed segment, in tile order
	Tiles    int       `json:"tiles"`
	Covered  int       `json:"covered"`
	Canaries []Canary  `json:"canaries"`
	// Steps are each segment's hours, by segment name, and GustPeriod
	// the gust's period by sfc step: what a reader plans its reads with
	// before opening any archive.
	Steps      map[string][]int `json:"steps"`
	GustPeriod []int            `json:"gustPeriod"`
	Built      time.Time        `json:"built"`
	Sources    []SourceRef      `json:"sources,omitempty"`
}

// gather fills one tile's values from the cube.
func (c *Cube) gather(l Level, tx, ty int) (*TileData, bool) {
	g := c.Model.Grid
	var t TileData
	any := false
	const p = TileSize
	for s := Segment(0); s < NumSegments; s++ {
		nv := len(c.Layout[s])
		ns := len(c.Steps[s])
		if s == SegStatic {
			ns = 1
		}
		vals := make([]int16, nv*ns*p*p)
		for vi := 0; vi < nv; vi++ {
			for si := 0; si < ns; si++ {
				field := c.data[s][c.slot(s, vi, si)]
				base := (vi*ns + si) * p * p
				for b := 0; b < p; b++ {
					for a := 0; a < p; a++ {
						q := int16(Missing)
						i, j, ok := l.Native(tx*p+a, ty*p+b, g)
						if ok && field != nil {
							k := j*g.Ni + i
							if c.Covered(k) {
								q = field[k]
							}
						}
						if q != Missing {
							any = true
						}
						vals[base+b*p+a] = q
					}
				}
			}
		}
		t[s] = vals
	}
	return &t, any
}

type tileRef struct {
	id      uint64
	l       Level
	tx, ty  int
	payload []byte
	hashes  [NumSegments]SegmentHash
	skip    bool
}

// Descriptor describes the cube as an archive.
func (c *Cube) Descriptor(levels []Level, sources []SourceRef) Descriptor {
	g := c.Model.Grid
	d := Descriptor{
		Format: Format, Version: FormatVersion, Writer: WriterVersion,
		Model: c.Model.ID, Run: c.Run.UTC(), First: c.Block.First, Last: c.Block.Last,
		Grid:       GridDesc{Ni: g.Ni, Nj: g.Nj, North: g.North, West: g.West, Di: g.Di, Dj: g.Dj, Wraps: g.Wraps},
		Tile:       TileSize,
		Missing:    Missing,
		Levels:     levels,
		GustPeriod: c.GustPeriod,
		Covered:    c.CoveredCount(),
		Sources:    sources,
	}
	for s := Segment(0); s < NumSegments; s++ {
		steps := c.Steps[s]
		if steps == nil {
			steps = []int{}
		}
		d.Segments = append(d.Segments, SegmentDesc{Name: s.String(), Steps: steps, Vars: c.Layout[s]})
	}
	return d
}

// WriteArchive builds the cube's PMTiles archive at path, every level of
// its pyramid, tiles with no value at all left out (a reader takes an
// absent tile for points no member of this model covers).
func (c *Cube) WriteArchive(path string, sources []SourceRef) (Receipt, error) {
	levels, err := Pyramid(c.Model)
	if err != nil {
		return Receipt{}, err
	}
	var refs []*tileRef
	for _, l := range levels {
		for ty := 0; ty < l.Ty; ty++ {
			for tx := 0; tx < l.Tx; tx++ {
				refs = append(refs, &tileRef{id: pmtiles.ZxyToID(uint8(l.Z), uint32(tx), uint32(ty)), l: l, tx: tx, ty: ty})
			}
		}
	}
	sort.Slice(refs, func(a, b int) bool { return refs[a].id < refs[b].id })

	work := make(chan *tileRef)
	errs := make(chan error, 1)
	var wg sync.WaitGroup
	for w := 0; w < runtime.GOMAXPROCS(0); w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			enc, err := newTileEncoder()
			if err != nil {
				select {
				case errs <- err:
				default:
				}
				for range work {
				}
				return
			}
			for r := range work {
				t, any := c.gather(r.l, r.tx, r.ty)
				if !any {
					r.skip = true
					continue
				}
				p, h, err := enc.encode(t)
				if err != nil {
					select {
					case errs <- err:
					default:
					}
					continue
				}
				r.payload, r.hashes = p, h
			}
		}()
	}
	for _, r := range refs {
		work <- r
	}
	close(work)
	wg.Wait()
	select {
	case err := <-errs:
		return Receipt{}, err
	default:
	}

	spool, err := os.CreateTemp("", "nwp-spool-*")
	if err != nil {
		return Receipt{}, err
	}
	defer os.Remove(spool.Name())
	defer spool.Close()
	g := c.Model.Grid
	south, east := float64(g.South())/1e6, float64(g.East())/1e6
	west, north := float64(g.West)/1e6, float64(g.North)/1e6
	if g.Wraps {
		east = west + 360 - float64(g.Di)/1e6
	}
	w := pmtiles.NewWriter(spool, pmtiles.Options{
		TileType:   pmtiles.TileTypeUnknown,
		Bounds:     [4]float64{west, south, min(east, 180), north},
		Center:     [2]float64{(west + min(east, 180)) / 2, (south + north) / 2},
		CenterZoom: uint8(levels[0].Z),
	})
	content := sha256.New()
	tiles := 0
	for _, r := range refs {
		if r.skip {
			continue
		}
		if err := w.Add(r.id, r.payload); err != nil {
			return Receipt{}, err
		}
		for _, h := range r.hashes {
			content.Write(h[:])
		}
		tiles++
	}
	if tiles == 0 {
		return Receipt{}, fmt.Errorf("nwp: %s %s %s holds no value", c.Model.ID, RunKey(c.Run), c.Block.Name())
	}
	f, err := os.Create(path)
	if err != nil {
		return Receipt{}, err
	}
	hw := sha256.New()
	if _, err := w.Finish(io.MultiWriter(f, hw), c.Descriptor(levels, sources)); err != nil {
		f.Close()
		return Receipt{}, err
	}
	if err := f.Close(); err != nil {
		return Receipt{}, err
	}
	st, err := os.Stat(path)
	if err != nil {
		return Receipt{}, err
	}
	rec := Receipt{
		Model: c.Model.ID, Run: c.Run.UTC(), First: c.Block.First, Last: c.Block.Last,
		Size: st.Size(), SHA256: hex.EncodeToString(hw.Sum(nil)), Content: hex.EncodeToString(content.Sum(nil)),
		Tiles: tiles, Covered: c.CoveredCount(), Built: time.Now().UTC(), Sources: sources,
	}
	rec.Canaries = canaries(refs, levels)
	rec.Steps = map[string][]int{}
	for sg := SegSfc; sg < NumSegments; sg++ {
		rec.Steps[sg.String()] = append([]int{}, c.Steps[sg]...)
	}
	rec.GustPeriod = c.GustPeriod
	return rec, nil
}

// canaries picks three written tiles: the native tile at the middle of
// the written ones, the first native one, and the coarsest level's first.
func canaries(refs []*tileRef, levels []Level) []Canary {
	var native, coarse []*tileRef
	for _, r := range refs {
		if r.skip {
			continue
		}
		if r.l.Z == levels[0].Z {
			native = append(native, r)
		}
		if r.l.Z == levels[len(levels)-1].Z {
			coarse = append(coarse, r)
		}
	}
	var pick []*tileRef
	if len(native) > 0 {
		pick = append(pick, native[len(native)/2], native[0])
	}
	if len(coarse) > 0 && len(levels) > 1 {
		pick = append(pick, coarse[0])
	}
	var out []Canary
	for _, r := range pick {
		cn := Canary{Z: r.l.Z, X: r.tx, Y: r.ty}
		for _, h := range r.hashes {
			cn.Segments = append(cn.Segments, hex.EncodeToString(h[:]))
		}
		out = append(out, cn)
	}
	return out
}
