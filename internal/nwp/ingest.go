package nwp

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/0intro/loxodrome/internal/grib2"
)

// Météo-France's open store (Etalab 2.0) and ECMWF's open data mirrors
// (CC BY 4.0), in the order they are asked.
const MeteoFranceBase = "https://meteofrance-pnt.s3.rbx.io.cloud.ovh.net"

var ECMWFBases = []string{
	"https://data.ecmwf.int/forecasts",
	"https://storage.googleapis.com/ecmwf-open-data",
	"https://ecmwf-forecasts.s3.eu-central-1.amazonaws.com",
}

// MFFile is one Météo-France source file of a block: its package and its
// key under the store's root.
type MFFile struct{ Pkg, Key string }

// mfLabels are a block's file labels: its hour group's ("00H06H"), or one
// per hour ("007H") for a model publishing a file per hour.
func (m *Model) mfLabels(b Block) []string {
	if !m.mfHourly {
		return []string{b.Label}
	}
	out := make([]string, 0, b.Last-b.First+1)
	for h := b.First; h <= b.Last; h++ {
		out = append(out, fmt.Sprintf("%03dH", h))
	}
	return out
}

// MFKey names a Météo-France package file under the store's root.
func MFKey(m *Model, run time.Time, pkg, label string) string {
	r := run.UTC().Format("2006-01-02T15:04:05Z")
	return fmt.Sprintf("pnt/%s/%s/%s/%s__%s__%s__%s.grib2", r, m.mfDir, pkg, m.mfStem, pkg, label, r)
}

// MFBlockFiles lists a block's source files: label by label, IP1, the
// cloud package, SP1 and SP2 within each. loxodrome-nwp's discovery builds
// the same keys (discover.ts mfKeys), the suite holding the two together
// through models.json.
func MFBlockFiles(m *Model, run time.Time, b Block) []MFFile {
	var out []MFFile
	for _, label := range m.mfLabels(b) {
		for _, pkg := range m.packages() {
			out = append(out, MFFile{Pkg: pkg, Key: MFKey(m, run, pkg, label)})
		}
	}
	return out
}

func mfURL(base, key string) string { return base + "/" + key }

func (m *Model) packages() []string { return []string{"IP1", m.cloudPkg, "SP1", "SP2"} }

// mfHourlyInFlight is how many of an hourly model's files a block reads at
// once (four a forecast hour); a grouped model reads its four together.
const mfHourlyInFlight = 8

// ecmwfURL names an IFS step file (ext "grib2" or "index").
func ecmwfURL(base string, run time.Time, step int, ext string) string {
	r := run.UTC()
	return fmt.Sprintf("%s/%s/%02dz/ifs/0p25/oper/%s0000-%dh-oper-fc.%s", base, r.Format("20060102"), r.Hour(), r.Format("2006010215"), step, ext)
}

// IngestOptions configure a block's ingest.
type IngestOptions struct {
	Fetcher  *Fetcher
	MFBase   string
	ECMWF    []string
	Store    Store // the orography cache
	Decoders int
	Log      func(format string, args ...any)
	// Elevation, when set, is the orography an earlier block of the same
	// job decoded, which saves reading it again.
	Elevation []int16
}

func (o *IngestOptions) logf(format string, args ...any) {
	if o.Log != nil {
		o.Log(format, args...)
	}
}

// OrographyKey is where the model's orography is cached between blocks.
func OrographyKey(m *Model) string { return "static/" + m.ID + "/orography.i16.gz" }

type job struct {
	field *grib2.Field
	w     want
	hour  int
}

// IngestBlock reads one time block of one run from its publisher into a
// cube, checks it whole (every wanted field present once, at every step,
// plausible) and returns it with the files it came from.
func IngestBlock(ctx context.Context, m *Model, run time.Time, b Block, o IngestOptions) (*Cube, []SourceRef, error) {
	if o.Fetcher == nil {
		o.Fetcher = &Fetcher{}
	}
	if o.MFBase == "" {
		o.MFBase = MeteoFranceBase
	}
	if len(o.ECMWF) == 0 {
		o.ECMWF = ECMWFBases
	}
	nd := o.Decoders
	if nd <= 0 {
		nd = runtime.GOMAXPROCS(0)
	}
	cube := NewCube(m, run, b)
	ws := wants(m)
	idx := indexWants(ws)

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	jobs := make(chan job, nd)
	var firstErr error
	var errOnce sync.Once
	fail := func(err error) {
		errOnce.Do(func() {
			firstErr = err
			cancel()
		})
	}
	var dwg sync.WaitGroup
	for d := 0; d < nd; d++ {
		dwg.Add(1)
		go func() {
			defer dwg.Done()
			var buf []float32
			for j := range jobs {
				n := j.field.Grid.Points()
				if cap(buf) < n {
					buf = make([]float32, n)
				}
				buf = buf[:n]
				if err := j.field.Values(buf); err != nil {
					fail(fmt.Errorf("%s +%dh: %w", j.w.varKey, j.hour, err))
					continue
				}
				if err := cube.Set(j.w.varKey, j.hour, buf, j.w.conv); err != nil {
					fail(err)
				}
			}
		}()
	}

	// accept checks a message against the wants and queues what is
	// wanted. A field on another grid or of another run is refused.
	accept := func(msg []byte, off int64, pkg string) error {
		fields, err := grib2.Parse(msg, off)
		if err != nil {
			// A message in a form the reader refuses fails the block only
			// when it may be a field we read: a publisher adding an
			// unrelated parameter in another template must not refuse
			// every block until the code changes.
			if errors.Is(err, grib2.ErrUnsupported) {
				if id, perr := grib2.Peek(msg); perr == nil && !idx.mayHold(id) {
					return nil
				}
			}
			return err
		}
		for _, f := range fields {
			w, ok := idx[fieldKey(f)]
			if !ok || (pkg != "" && w.pkg != pkg) {
				continue
			}
			if !f.RefTime.Equal(run) {
				return fmt.Errorf("%s: field of run %s in run %s", w.varKey, f.RefTime.Format(time.RFC3339), run.Format(time.RFC3339))
			}
			if err := checkGrid(m, f.Grid); err != nil {
				return fmt.Errorf("%s: %w", w.varKey, err)
			}
			lead := f.ValidTime().Sub(run)
			if lead%time.Hour != 0 {
				return fmt.Errorf("%s: valid %s is not on the hour", w.varKey, f.ValidTime())
			}
			hour := int(lead / time.Hour)
			if w.static {
				if hour != 0 || o.Elevation != nil {
					continue
				}
			} else if hour < b.First || hour > b.Last || (w.gust && hour == 0) {
				continue
			}
			if w.gust {
				cube.SetGustPeriod(hour, f.Period)
			}
			select {
			case jobs <- job{f, w, hour}:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		return nil
	}

	var sources []SourceRef
	var smu sync.Mutex
	var fwg sync.WaitGroup
	switch m.Source {
	case MeteoFrance:
		// Each file its own request, resume and idle cut.
		files := MFBlockFiles(m, run, b)
		inFlight := len(files)
		if m.mfHourly {
			inFlight = mfHourlyInFlight
		}
		sem := make(chan struct{}, inFlight)
		for _, file := range files {
			fwg.Add(1)
			go func() {
				defer fwg.Done()
				select {
				case sem <- struct{}{}:
				case <-ctx.Done():
					fail(ctx.Err())
					return
				}
				defer func() { <-sem }()
				ref, err := o.Fetcher.Messages(ctx, mfURL(o.MFBase, file.Key), func(msg []byte, off int64) error { return accept(msg, off, file.Pkg) })
				if err != nil {
					fail(err)
					return
				}
				smu.Lock()
				sources = append(sources, ref)
				smu.Unlock()
			}()
		}
	case ECMWF:
		steps := m.Steps(b, FamilyLevels)
		sem := make(chan struct{}, 3)
		for _, step := range steps {
			fwg.Add(1)
			go func() {
				defer fwg.Done()
				sem <- struct{}{}
				defer func() { <-sem }()
				ref, err := ingestIFSStep(ctx, o, run, step, ws, accept)
				if err != nil {
					fail(err)
					return
				}
				smu.Lock()
				sources = append(sources, ref)
				smu.Unlock()
			}()
		}
	}
	fwg.Wait()
	close(jobs)
	dwg.Wait()
	if firstErr != nil {
		return nil, nil, firstErr
	}
	sort.Slice(sources, func(i, j int) bool { return sources[i].URL < sources[j].URL })

	// The orography: derived from this block's own column (ARPEGE), or
	// decoded from this block (the first), handed over by the job, cached by
	// an earlier block, or read again from the source.
	if m.GroundFromColumn {
		elev, err := cube.GroundFromColumn()
		if err != nil {
			return nil, nil, err
		}
		if err := cube.SetQuantized(VarElevation, 0, elev); err != nil {
			return nil, nil, err
		}
	} else if !cube.Has(VarElevation, 0) {
		elev := o.Elevation
		if elev == nil && o.Store != nil {
			elev, _ = loadOrography(ctx, o.Store, m)
		}
		if elev == nil {
			var err error
			if elev, err = fetchOrography(ctx, m, run, o); err != nil {
				return nil, nil, fmt.Errorf("orography: %w", err)
			}
		}
		if err := cube.SetQuantized(VarElevation, 0, elev); err != nil {
			return nil, nil, err
		}
	} else if o.Store != nil {
		if err := saveOrography(ctx, o.Store, m, cube.Grid(SegStatic, 0, 0)); err != nil {
			o.logf("caching the orography: %v", err)
		}
	}

	var missing []string
	for key, hours := range expected(m, b, ws) {
		for _, h := range hours {
			if !cube.Has(key, h) {
				missing = append(missing, fmt.Sprintf("%s+%d", key, h))
			}
		}
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		if len(missing) > 8 {
			missing = append(missing[:8], fmt.Sprintf("and %d more", len(missing)-8))
		}
		return nil, nil, fmt.Errorf("nwp: %s %s %s lacks %s", m.ID, RunKey(run), b.Name(), strings.Join(missing, ", "))
	}
	if err := cube.CheckPlausible(); err != nil {
		return nil, nil, err
	}
	return cube, sources, nil
}

func checkGrid(m *Model, g grib2.Grid) error {
	want := m.Grid
	e6 := func(x float64) int64 {
		if x < 0 {
			return int64(x*1e6 - 0.5)
		}
		return int64(x*1e6 + 0.5)
	}
	if g.Ni != want.Ni || g.Nj != want.Nj || e6(g.North) != want.North || e6(g.West) != want.West ||
		e6(g.Di) != want.Di || e6(g.Dj) != want.Dj || g.Wraps != want.Wraps {
		return fmt.Errorf("grid %dx%d %g/%g by %g/%g, the model's is %dx%d %d/%d by %d/%d (1e-6 degrees)",
			g.Ni, g.Nj, g.North, g.West, g.Di, g.Dj, want.Ni, want.Nj, want.North, want.West, want.Di, want.Dj)
	}
	return nil
}

// indexEntry is one line of an ECMWF open-data .index.
type indexEntry struct {
	Param    string `json:"param"`
	Levtype  string `json:"levtype"`
	Levelist string `json:"levelist"`
	Step     string `json:"step"`
	Offset   int64  `json:"_offset"`
	Length   int64  `json:"_length"`
}

// ifsGustNames are the names ECMWF's open data gives the 10 m gust, by
// step: "10fg" through +90 h (the hour since the previous post-processing),
// "10fg3" from +93 to +144 h (the last three hours), "10fg" again from
// +150 h (the last six). One GRIB2 identity under all three, the message
// stating its own period, which the cube records; only the index lookup
// needs the names. Wanting "10fg" alone failed every block past +90 h, and
// every IFS run was published truncated to its first day (2026-10-07).
var ifsGustNames = map[string]bool{"10fg": true, "10fg3": true, "10fg6": true}

// ifsPicks selects, from one step's .index, the entries of the wanted
// fields: each once, the gust under whichever name the step gives it. An
// error when the index does not list every one of them.
func ifsPicks(raw []byte, ws []want, step int) ([]indexEntry, error) {
	type wkey struct{ param, levtype, level string }
	need := map[wkey]bool{}
	var gust string
	for _, w := range ws {
		if w.ifs == "" || (w.static && step != 0) || (w.gust && step == 0) {
			continue
		}
		lv := ""
		if w.levtype == "pl" {
			lv = fmt.Sprint(w.level0)
		}
		if w.gust {
			gust = w.ifs
		}
		need[wkey{w.ifs, w.levtype, lv}] = true
	}
	var picks []indexEntry
	picked := map[wkey]bool{}
	sc := bufio.NewScanner(bytes.NewReader(raw))
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		if len(bytes.TrimSpace(sc.Bytes())) == 0 {
			continue
		}
		var e indexEntry
		if err := json.Unmarshal(sc.Bytes(), &e); err != nil {
			return nil, err
		}
		lv := ""
		if e.Levtype == "pl" {
			lv = e.Levelist
		}
		param := e.Param
		if gust != "" && e.Levtype == "sfc" && ifsGustNames[param] {
			param = gust
		}
		k := wkey{param, e.Levtype, lv}
		if need[k] && !picked[k] {
			picked[k] = true
			picks = append(picks, e)
		}
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	if len(picks) != len(need) {
		return nil, fmt.Errorf("%d of the %d wanted fields indexed", len(picks), len(need))
	}
	return picks, nil
}

// ingestIFSStep reads one IFS step: its index, then only the wanted
// messages, adjacent ones in one ranged request.
func ingestIFSStep(ctx context.Context, o IngestOptions, run time.Time, step int, ws []want, accept func([]byte, int64, string) error) (SourceRef, error) {
	// A step is read whole from one mirror before any message is handed
	// over, so that whatever fails there, the index, a byte range or the
	// framing of what came back, the next mirror is asked without a message
	// reaching the cube twice.
	var lastErr error
	for _, base := range o.ECMWF {
		ref, spans, err := readIFSStep(ctx, o, base, run, step, ws)
		if err != nil {
			lastErr = err
			if ctx.Err() != nil {
				return SourceRef{}, ctx.Err()
			}
			o.logf("%v; asking the next mirror", err)
			continue
		}
		for _, s := range spans {
			// A coalesced span holds unwanted messages between wanted
			// ones; accept skips them by key.
			if err := messagesIn(s.b, s.from, func(msg []byte, off int64) error { return accept(msg, off, "") }); err != nil {
				return SourceRef{}, err
			}
		}
		return ref, nil
	}
	return SourceRef{}, lastErr
}

type ifsSpan struct {
	from int64
	b    []byte
}

// readIFSStep reads one step's wanted messages from one mirror: its index,
// then the byte ranges, messages under 1 MiB apart in one request, each
// range checked to be whole GRIB messages.
func readIFSStep(ctx context.Context, o IngestOptions, base string, run time.Time, step int, ws []want) (SourceRef, []ifsSpan, error) {
	idxURL := ecmwfURL(base, run, step, "index")
	raw, err := o.Fetcher.Bytes(ctx, idxURL, 0, 0)
	if err != nil {
		return SourceRef{}, nil, err
	}
	picks, err := ifsPicks(raw, ws, step)
	if err != nil {
		return SourceRef{}, nil, fmt.Errorf("%s: %w", idxURL, err)
	}
	sort.Slice(picks, func(i, j int) bool { return picks[i].Offset < picks[j].Offset })
	type span struct{ from, to int64 }
	var ranges []span
	for _, e := range picks {
		if n := len(ranges); n > 0 && e.Offset-ranges[n-1].to < 1<<20 {
			ranges[n-1].to = max(ranges[n-1].to, e.Offset+e.Length)
			continue
		}
		ranges = append(ranges, span{e.Offset, e.Offset + e.Length})
	}
	dataURL := ecmwfURL(base, run, step, "grib2")
	var size int64
	out := make([]ifsSpan, 0, len(ranges))
	for _, r := range ranges {
		b, err := o.Fetcher.Bytes(ctx, dataURL, r.from, r.to)
		if err != nil {
			return SourceRef{}, nil, err
		}
		if err := messagesIn(b, r.from, func([]byte, int64) error { return nil }); err != nil {
			return SourceRef{}, nil, fmt.Errorf("%s bytes %d-%d: %w", dataURL, r.from, r.to-1, err)
		}
		size += int64(len(b))
		out = append(out, ifsSpan{r.from, b})
	}
	return SourceRef{URL: dataURL, Size: size}, out, nil
}

func loadOrography(ctx context.Context, s Store, m *Model) ([]int16, error) {
	b, err := s.Get(ctx, OrographyKey(m))
	if err != nil {
		return nil, err
	}
	zr, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	raw, err := io.ReadAll(zr)
	if err != nil {
		return nil, err
	}
	n := m.Grid.Ni * m.Grid.Nj
	if len(raw) != 2*n {
		return nil, fmt.Errorf("cached orography holds %d bytes, the grid %d points", len(raw), n)
	}
	out := make([]int16, n)
	for i := range out {
		out[i] = int16(binary.LittleEndian.Uint16(raw[2*i:]))
	}
	return out, nil
}

func saveOrography(ctx context.Context, s Store, m *Model, elev []int16) error {
	if elev == nil {
		return errors.New("no orography to cache")
	}
	// A cached copy that does not load (cut short, another grid) is written
	// over: refusing it had every later block read the orography again.
	if cur, err := loadOrography(ctx, s, m); err == nil && equalInt16(cur, elev) {
		return nil
	}
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	zw.Write(int16Bytes(elev))
	if err := zw.Close(); err != nil {
		return err
	}
	return s.Put(ctx, OrographyKey(m), buf.Bytes(), "application/gzip")
}

func equalInt16(a, b []int16) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// fetchOrography reads the orography from the run's first hour group
// (Météo-France's SP2, ECMWF's step 0), stopping as soon as it is found.
func fetchOrography(ctx context.Context, m *Model, run time.Time, o IngestOptions) ([]int16, error) {
	var oro want
	for _, w := range wants(m) {
		if w.static {
			oro = w
		}
	}
	first := m.Blocks(run)[0]
	cube := NewCube(m, run, first)
	found := errors.New("found")
	take := func(msg []byte, off int64) error {
		fields, err := grib2.Parse(msg, off)
		if err != nil {
			return err
		}
		for _, f := range fields {
			if fieldKey(f) != oro.key() {
				continue
			}
			// The grid before the values: a message's stated grid sizes
			// what Values allocates.
			if err := checkGrid(m, f.Grid); err != nil {
				return err
			}
			vals := make([]float32, f.Grid.Points())
			if err := f.Values(vals); err != nil {
				return err
			}
			if err := cube.Set(VarElevation, 0, vals, oro.conv); err != nil {
				return err
			}
			return found
		}
		return nil
	}
	var err error
	switch m.Source {
	case MeteoFrance:
		_, err = o.Fetcher.Messages(ctx, mfURL(o.MFBase, MFKey(m, run, "SP2", m.mfLabels(first)[0])), take)
	case ECMWF:
		err = errors.New("no ECMWF mirror answered")
		for _, base := range o.ECMWF {
			raw, ierr := o.Fetcher.Bytes(ctx, ecmwfURL(base, run, 0, "index"), 0, 0)
			if ierr != nil {
				err = ierr
				continue
			}
			sc := bufio.NewScanner(bytes.NewReader(raw))
			sc.Buffer(make([]byte, 64<<10), 1<<20)
			for sc.Scan() {
				var e indexEntry
				if json.Unmarshal(sc.Bytes(), &e) == nil && e.Param == oro.ifs && e.Levtype == "sfc" {
					b, berr := o.Fetcher.Bytes(ctx, ecmwfURL(base, run, 0, "grib2"), e.Offset, e.Offset+e.Length)
					if berr != nil {
						err = berr
						break
					}
					err = messagesIn(b, e.Offset, take)
					break
				}
			}
			if errors.Is(err, found) {
				break
			}
		}
	}
	if !errors.Is(err, found) {
		if err == nil {
			err = errors.New("not in the source")
		}
		return nil, err
	}
	return cube.Grid(SegStatic, 0, 0), nil
}
