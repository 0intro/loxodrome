package nwp

import (
	"context"
	"net/http"
	"net/http/httptest"
	"slices"
	"sort"
	"sync"
	"testing"
	"time"
)

func mfURLs(m *Model, run time.Time, b Block) []string {
	var out []string
	for _, f := range MFBlockFiles(m, run, b) {
		out = append(out, mfURL(MeteoFranceBase, f.Key))
	}
	return out
}

// The file names Météo-France publishes, literal: AROME's and ARPEGE's as
// the ingest has always read them.
func TestMeteoFranceFileNamesStand(t *testing.T) {
	run := time.Date(2026, 10, 6, 0, 0, 0, 0, time.UTC)
	const base = "https://meteofrance-pnt.s3.rbx.io.cloud.ovh.net/pnt/2026-10-06T00:00:00Z/"
	got := mfURLs(Arome, run, Arome.Blocks(run)[0])
	want := []string{
		base + "arome/0025/IP1/arome__0025__IP1__00H06H__2026-10-06T00:00:00Z.grib2",
		base + "arome/0025/IP2/arome__0025__IP2__00H06H__2026-10-06T00:00:00Z.grib2",
		base + "arome/0025/SP1/arome__0025__SP1__00H06H__2026-10-06T00:00:00Z.grib2",
		base + "arome/0025/SP2/arome__0025__SP2__00H06H__2026-10-06T00:00:00Z.grib2",
	}
	if !slices.Equal(got, want) {
		t.Errorf("AROME block 0:\n got  %q\n want %q", got, want)
	}
	got = mfURLs(Arpege, run, Arpege.Blocks(run)[4])
	if want := base + "arpege/01/IP3/arpege__01__IP3__049H060H__2026-10-06T00:00:00Z.grib2"; got[1] != want {
		t.Errorf("ARPEGE block 4's cloud package:\n got  %q\n want %q", got[1], want)
	}
}

// hourlyMini publishes a file per hour, like AROME-OM.
func hourlyMini() *Model {
	m := *miniModel
	m.ID = "minihourly"
	m.GroundFromColumn = true
	m.mfDir, m.mfStem, m.mfHourly, m.cloudPkg = "mini-om/DOM/0025", "mini-om-DOM__0025", true, "IP2"
	return &m
}

// gate holds every request it gets until released, counting how many it
// holds at once and recording each path.
type gate struct {
	mu       sync.Mutex
	held     int
	max      int
	paths    []string
	released chan struct{}
}

func (g *gate) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	g.mu.Lock()
	g.paths = append(g.paths, r.URL.Path)
	g.held++
	g.max = max(g.max, g.held)
	g.mu.Unlock()
	<-g.released
	g.mu.Lock()
	g.held--
	g.mu.Unlock()
	w.WriteHeader(http.StatusOK)
}

func (g *gate) holding() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.held
}

// readsAtOnce ingests one block against a gate, waits until `want`
// requests are held, checks no more arrive, then lets them all through. It
// returns the paths asked, sorted.
func readsAtOnce(t *testing.T, m *Model, b Block, want int) []string {
	t.Helper()
	g := &gate{released: make(chan struct{})}
	srv := httptest.NewServer(g)
	defer srv.Close()
	run := time.Date(2026, 10, 6, 0, 0, 0, 0, time.UTC)
	done := make(chan struct{})
	go func() {
		defer close(done)
		// Empty files: the block then lacks every field, as expected here.
		IngestBlock(context.Background(), m, run, b, IngestOptions{MFBase: srv.URL, Fetcher: &Fetcher{Retries: 1}})
	}()
	deadline := time.Now().Add(5 * time.Second)
	for g.holding() < want && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	time.Sleep(100 * time.Millisecond)
	if got := g.holding(); got != want {
		t.Errorf("%s reads %d files at once, want %d", m.ID, got, want)
	}
	close(g.released)
	<-done
	if g.max != want {
		t.Errorf("%s read up to %d files at once, want %d", m.ID, g.max, want)
	}
	sort.Strings(g.paths)
	return g.paths
}

// An hourly model reads its block's four files an hour eight at a time,
// every one of them, and a grouped model its four together, as always.
func TestBlockFilesAreReadAtOnceUpToTheirLimit(t *testing.T) {
	m := hourlyMini()
	run := time.Date(2026, 10, 6, 0, 0, 0, 0, time.UTC)
	b := Block{First: 0, Last: 6}
	files := MFBlockFiles(m, run, b)
	if len(files) != 28 {
		t.Fatalf("%d files for 7 hours, want 28", len(files))
	}
	if want := "pnt/2026-10-06T00:00:00Z/mini-om/DOM/0025/IP1/mini-om-DOM__0025__IP1__000H__2026-10-06T00:00:00Z.grib2"; files[0].Key != want || files[0].Pkg != "IP1" {
		t.Errorf("first file %+v, want IP1 %s", files[0], want)
	}
	if want := "pnt/2026-10-06T00:00:00Z/mini-om/DOM/0025/SP2/mini-om-DOM__0025__SP2__006H__2026-10-06T00:00:00Z.grib2"; files[27].Key != want {
		t.Errorf("last file %s, want %s", files[27].Key, want)
	}
	var keys []string
	for _, f := range files {
		keys = append(keys, "/"+f.Key)
	}
	sort.Strings(keys)
	if got := readsAtOnce(t, m, b, mfHourlyInFlight); !slices.Equal(got, keys) {
		t.Errorf("asked\n %q\nwant\n %q", got, keys)
	}

	grouped := *m
	grouped.mfHourly = false
	gb := Block{First: 0, Last: 6, Label: "00H06H"}
	if got := readsAtOnce(t, &grouped, gb, 4); len(got) != 4 {
		t.Errorf("a grouped block asked %d files, want 4", len(got))
	}
}
