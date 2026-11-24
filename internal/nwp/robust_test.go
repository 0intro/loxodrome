package nwp

import (
	"context"
	"encoding/binary"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/0intro/loxodrome/internal/grib2"
)

// fakeMessage is a GRIB2 message by its framing alone, n bytes long:
// enough for the fetch and split paths, which never look inside.
func fakeMessage(n int, fill byte) []byte {
	m := make([]byte, n)
	copy(m, "GRIB")
	m[7] = 2
	binary.BigEndian.PutUint64(m[8:], uint64(n))
	for i := 16; i < n-4; i++ {
		m[i] = fill
	}
	copy(m[n-4:], "7777")
	return m
}

func quickRetries(t *testing.T) {
	t.Helper()
	b, sb := backoff, storeBackoff
	backoff = func(int) time.Duration { return time.Millisecond }
	storeBackoff = func(int) time.Duration { return time.Millisecond }
	t.Cleanup(func() { backoff, storeBackoff = b, sb })
}

func TestStoreRetriesWhatTheServerFailedNotWhatItRefused(t *testing.T) {
	quickRetries(t)
	var mu sync.Mutex
	calls := map[string]int{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		calls[r.URL.Path]++
		n := calls[r.URL.Path]
		mu.Unlock()
		switch {
		case strings.HasPrefix(r.URL.Path, "/receipts/") && n == 1:
			http.Error(w, "transient", http.StatusInternalServerError)
		case strings.HasPrefix(r.URL.Path, "/latest/"):
			http.Error(w, "bad key", http.StatusForbidden)
		default:
			w.WriteHeader(http.StatusOK)
		}
	}))
	defer srv.Close()
	s := HTTPStore{Base: srv.URL}
	ctx := context.Background()
	// One transient failure of a receipt's PUT used to fail the block after
	// its archive was stored.
	if err := s.Put(ctx, "receipts/x/2026100600/b000-006.json", []byte("{}"), "application/json"); err != nil {
		t.Fatalf("a 500 then a 200: %v", err)
	}
	if calls["/receipts/x/2026100600/b000-006.json"] != 2 {
		t.Errorf("%d requests, want 2", calls["/receipts/x/2026100600/b000-006.json"])
	}
	if err := s.Put(ctx, "latest/x.json", []byte("{}"), "application/json"); err == nil {
		t.Error("a refused key was taken")
	}
	if calls["/latest/x.json"] != 1 {
		t.Errorf("a refusal was asked %d times", calls["/latest/x.json"])
	}
}

func TestFetchFailsAFileReplacedWhileRead(t *testing.T) {
	quickRetries(t)
	a, b := fakeMessage(100, 1), fakeMessage(100, 2)
	file := append(append([]byte(nil), a...), b...)
	served := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		served++
		if served == 1 {
			// The first answer breaks off after the first message.
			w.Header().Set("ETag", `"v1"`)
			w.Header().Set("Content-Length", strconv.Itoa(len(file)))
			w.WriteHeader(http.StatusOK)
			w.Write(file[:150])
			return
		}
		// The resume finds another edition: If-Range fails, 200 whole.
		w.Header().Set("ETag", `"v2"`)
		w.WriteHeader(http.StatusOK)
		w.Write(file)
	}))
	defer srv.Close()
	f := &Fetcher{Retries: 2}
	var got int
	_, err := f.Messages(context.Background(), srv.URL+"/f.grib2", func([]byte, int64) error { got++; return nil })
	if err == nil || !strings.Contains(err.Error(), "replaced while being read") {
		t.Fatalf("err %v", err)
	}
	if got != 1 {
		t.Errorf("%d messages handed over, want the first alone", got)
	}
}

func TestFetchResumesAStalledDownload(t *testing.T) {
	quickRetries(t)
	a, b := fakeMessage(100, 1), fakeMessage(100, 2)
	file := append(append([]byte(nil), a...), b...)
	stall := make(chan struct{})
	defer close(stall)
	var ranges []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ranges = append(ranges, r.Header.Get("Range"))
		w.Header().Set("ETag", `"v1"`)
		if rng := r.Header.Get("Range"); rng != "" {
			from, _ := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(rng, "bytes="), "-"))
			w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", from, len(file)-1, len(file)))
			w.WriteHeader(http.StatusPartialContent)
			w.Write(file[from:])
			return
		}
		w.Header().Set("Content-Length", strconv.Itoa(len(file)))
		w.WriteHeader(http.StatusOK)
		w.Write(file[:120])
		w.(http.Flusher).Flush()
		// Then nothing more: a stall, not a reset.
		select {
		case <-stall:
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()
	f := &Fetcher{Retries: 2, Idle: 200 * time.Millisecond}
	var got int
	start := time.Now()
	if _, err := f.Messages(context.Background(), srv.URL+"/f.grib2", func([]byte, int64) error { got++; return nil }); err != nil {
		t.Fatal(err)
	}
	if got != 2 || len(ranges) != 2 || ranges[1] != "bytes=100-" {
		t.Errorf("%d messages, requests %q", got, ranges)
	}
	if time.Since(start) > 10*time.Second {
		t.Errorf("took %v", time.Since(start))
	}
}

// TestIFSStepAsksTheNextMirrorWhateverFailed: a byte range failing at the
// first mirror (or its index being no index) moves the whole step to the
// next mirror, and no message reaches the cube twice.
func TestIFSStepAsksTheNextMirrorWhateverFailed(t *testing.T) {
	quickRetries(t)
	ws := wants(Ifs)
	index := ifsIndex(t, 3, "10fg")
	n := strings.Count(string(index), "\n")
	var data []byte
	for i := 0; i < n; i++ {
		data = append(data, fakeMessage(100, byte(i))...)
	}
	mirror := func(failRanges, badIndex bool) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch {
			case strings.HasSuffix(r.URL.Path, ".index"):
				if badIndex {
					w.Write([]byte("<html>maintenance</html>"))
					return
				}
				w.Write(index)
			case failRanges:
				// The index answers, its data does not (AWS's SlowDown):
				// this returned at once, the next mirror never asked.
				http.Error(w, "SlowDown", http.StatusServiceUnavailable)
			default:
				var from, to int
				fmt.Sscanf(r.Header.Get("Range"), "bytes=%d-%d", &from, &to)
				w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", from, to, len(data)))
				w.WriteHeader(http.StatusPartialContent)
				w.Write(data[from : to+1])
			}
		}))
	}
	run := time.Date(2026, 10, 6, 0, 0, 0, 0, time.UTC)
	for _, c := range []struct {
		name               string
		failRanges, badIdx bool
	}{
		{"a data range refused", true, false},
		{"an index that is no index", false, true},
	} {
		bad, good := mirror(c.failRanges, c.badIdx), mirror(false, false)
		o := IngestOptions{Fetcher: &Fetcher{Retries: 1}, ECMWF: []string{bad.URL, good.URL}}
		seen := map[int64]int{}
		ref, err := ingestIFSStep(context.Background(), o, run, 3, ws, func(_ []byte, off int64, _ string) error {
			seen[off]++
			return nil
		})
		bad.Close()
		good.Close()
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if !strings.HasPrefix(ref.URL, good.URL) {
			t.Errorf("%s: read from %s", c.name, ref.URL)
		}
		if len(seen) != n {
			t.Errorf("%s: %d messages, want %d", c.name, len(seen), n)
		}
		for off, k := range seen {
			if k != 1 {
				t.Errorf("%s: the message at %d handed over %d times", c.name, off, k)
			}
		}
	}
}

func TestAMessageWeDoNotReadMayBeInAFormWeDoNotRead(t *testing.T) {
	idx := indexWants(wants(Arome))
	// u wind, wanted; visibility (0/19/0), not; a land-surface field (2/0/0)
	// shares temperature's category and number, but not its discipline.
	if !idx.mayHold(grib2.Identity{Discipline: 0, Category: 2, Number: 2, PDT: 1}) {
		t.Error("the u wind in another template is not ours")
	}
	if idx.mayHold(grib2.Identity{Discipline: 0, Category: 19, Number: 0, PDT: 1}) {
		t.Error("visibility is ours")
	}
	if idx.mayHold(grib2.Identity{Discipline: 2, Category: 0, Number: 0, PDT: 0}) {
		t.Error("a land-surface field is ours")
	}
}

func TestVersionedKey(t *testing.T) {
	sha := "3f2a9c1e5b7d00112233445566778899aabbccddeeff00112233445566778899"
	for _, c := range [][2]string{
		{"first/arome0025/2026100600.pmtiles", "first/arome0025/2026100600.3f2a9c1e5b7d.pmtiles"},
		{"blocks/ifs025/2026100612/b015-024.pmtiles", "blocks/ifs025/2026100612/b015-024.3f2a9c1e5b7d.pmtiles"},
	} {
		if got := VersionedKey(c[0], sha); got != c[1] {
			t.Errorf("%s: %s", c[0], got)
		}
	}
	if got := VersionedKey("first/x/1.pmtiles", ""); got != "first/x/1.pmtiles" {
		t.Errorf("no hash: %s", got)
	}
}

// TestIFSPicksOnRealIndexes reads ECMWF's own indexes (2026-10-06 12Z,
// kept to the lines of the parameters we read, verbatim): the gust is 10fg
// at +3 h, 10fg3 at +93 h and 10fg again at +150 h, and at the analysis the
// orography is picked and the gust is not. A test building its index from
// our own wants could never catch a name ECMWF changes.
func TestIFSPicksOnRealIndexes(t *testing.T) {
	ws := wants(Ifs)
	for _, c := range []struct {
		step int
		gust string
	}{{0, ""}, {3, "10fg"}, {93, "10fg3"}, {150, "10fg"}} {
		raw, err := os.ReadFile(filepath.Join("testdata", fmt.Sprintf("ifs-20261006120000-%dh.index", c.step)))
		if err != nil {
			t.Fatal(err)
		}
		picks, err := ifsPicks(raw, ws, c.step)
		if err != nil {
			t.Fatalf("+%d h: %v", c.step, err)
		}
		gusts, oro := []string{}, false
		for _, p := range picks {
			if strings.HasPrefix(p.Param, "10fg") {
				gusts = append(gusts, p.Param)
			}
			oro = oro || (p.Param == "z" && p.Levtype == "sfc")
		}
		if c.gust == "" && len(gusts) != 0 || c.gust != "" && (len(gusts) != 1 || gusts[0] != c.gust) {
			t.Errorf("+%d h: gust picked %v, want %q", c.step, gusts, c.gust)
		}
		if oro != (c.step == 0) {
			t.Errorf("+%d h: orography picked %v", c.step, oro)
		}
	}
}

// TestCoverageIntersectsDifferentMasks: a point any field leaves without a
// value is outside the block's domain for every field.
func TestCoverageIntersectsDifferentMasks(t *testing.T) {
	m := *miniModel
	run := time.Date(2026, 10, 6, 0, 0, 0, 0, time.UTC)
	c := NewCube(&m, run, m.Blocks(run)[0])
	n := m.Grid.Ni * m.Grid.Nj
	field := func(masked int) []float32 {
		v := make([]float32, n)
		for k := range v {
			v[k] = 1
		}
		v[masked] = float32(math.NaN())
		return v
	}
	if err := c.Set(VarMSLP, 1, field(3), nil); err != nil {
		t.Fatal(err)
	}
	if err := c.Set(VarT2, 1, field(7), nil); err != nil {
		t.Fatal(err)
	}
	if c.Covered(3) || c.Covered(7) || !c.Covered(5) {
		t.Errorf("covered 3 %v, 7 %v, 5 %v", c.Covered(3), c.Covered(7), c.Covered(5))
	}
	if got := c.CoveredCount(); got != n-2 {
		t.Errorf("covered %d of %d", got, n)
	}
}

// TestPlausibilityRefusesOutOfBoundsAndFrozen: a value past its bounds (a
// unit gone wrong) and a field that must vary standing still are refused.
func TestPlausibilityRefusesOutOfBoundsAndFrozen(t *testing.T) {
	c, _ := buildMini(t)
	_, vi, _ := c.Layout.Find(Var{Name: VarT, Level: 850}.Key())
	f := c.data[SegUVT][c.slot(SegUVT, vi, 0)]
	orig := append([]int16(nil), f...)
	for k := range f {
		if f[k] != Missing {
			// 273 too warm: kelvin read as Celsius.
			f[k] = int16(2730 + k%10)
			break
		}
	}
	if err := c.CheckPlausible(); err == nil || !strings.Contains(err.Error(), "temperature") {
		t.Errorf("a temperature 273 off passed: %v", err)
	}
	copy(f, orig)
	for k := range f {
		if f[k] != Missing {
			f[k] = 100
		}
	}
	if err := c.CheckPlausible(); err == nil {
		t.Error("a frozen temperature field passed")
	}
}
