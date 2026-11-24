package main

import (
	"bytes"
	"context"
	"errors"
	"flag"
	"io"
	"io/fs"
	"log"
	"os"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/0intro/loxodrome/internal/nwp"
)

// The last line a job past its deadline leaves, as the orchestrator
// matches it (loxodrome-nwp/src/plan.ts DEADLINE_LINE).
var deadlineLine = regexp.MustCompile(`^\d{4}/\d\d/\d\d \d\d:\d\d:\d\d error: ran past its \S+ deadline$`)

// A status line, whichever it is.
var statusLineRe = regexp.MustCompile(`^\d{4}/\d\d/\d\d \d\d:\d\d:\d\d (ok|stopped: .*|error: .*)$`)

const (
	deadlineKey  = "logs/ifs025/2026100612/b000-012.log"
	deadlineName = "ifs025 2026100612"
)

// memStore keeps a job's objects in memory: no socket, so a synctest
// bubble's clock moves while the job waits on its store.
type memStore struct {
	mu   sync.Mutex
	objs map[string][]byte
}

func newMemStore() *memStore { return &memStore{objs: map[string][]byte{}} }

func (m *memStore) Get(_ context.Context, key string) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	b, ok := m.objs[key]
	if !ok {
		return nil, fs.ErrNotExist
	}
	return b, nil
}

func (m *memStore) PutFile(ctx context.Context, key, path, contentType string) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return m.Put(ctx, key, b, contentType)
}

func (m *memStore) Put(_ context.Context, key string, b []byte, _ string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.objs[key] = append([]byte(nil), b...)
	return nil
}

func (m *memStore) lines(t *testing.T, key string) []string {
	t.Helper()
	b, err := m.Get(context.Background(), key)
	if err != nil {
		t.Fatalf("no log stored under %s", key)
	}
	return strings.Split(strings.TrimRight(string(b), "\n"), "\n")
}

func statuses(lines []string) int {
	n := 0
	for _, l := range lines {
		if statusLineRe.MatchString(l) {
			n++
		}
	}
	return n
}

// exits records how a job exited, and when, in place of os.Exit (which
// never returns; the recorder does, so the job's own path is seen to end
// too).
type exits struct {
	mu    sync.Mutex
	start time.Time
	codes []int
	at    []time.Duration
	seen  chan struct{}
}

func newExits() *exits { return &exits{start: time.Now(), seen: make(chan struct{}, 8)} }

func (e *exits) exit(code int) {
	e.mu.Lock()
	e.codes = append(e.codes, code)
	e.at = append(e.at, time.Since(e.start))
	e.mu.Unlock()
	e.seen <- struct{}{}
}

func (e *exits) record() ([]int, []time.Duration) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]int(nil), e.codes...), append([]time.Duration(nil), e.at...)
}

func noKeep(context.Context, int, int, stageWaits) error { return nil }

// deadlineJob runs a job of the given blocks under a deadline, its log
// written through w.
func deadlineJob(all []nwp.Block, w io.Writer, deadline time.Duration, ex *exits, store *memStore, pick []int, decode func(context.Context, int) (int, error)) error {
	jl := &jobLog{w: w}
	logger := log.New(jl, "", log.LstdFlags|log.LUTC)
	lim := jobLimits{grace: stopGrace, deadline: deadline, exit: ex.exit}
	return runJob(make(chan os.Signal), lim, all, pick, decode, noKeep, store, deadlineKey, deadlineName, jl, logger)
}

// A job hung in its decode ends at its deadline, from its own timer: its
// blocks cancelled by the deadline, its log stored with the deadline last,
// one exit, exitDeadline, and nothing more after.
func TestTheDeadlineEndsAHungJobWithItsLog(t *testing.T) {
	all := ifsBlocks(t)
	synctest.Test(t, func(t *testing.T) {
		store, ex := newMemStore(), newExits()
		var cause error
		err := deadlineJob(all, io.Discard, defaultDeadline, ex, store, []int{0, 1}, func(ctx context.Context, bi int) (int, error) {
			<-ctx.Done()
			cause = context.Cause(ctx)
			return 0, ctx.Err()
		})
		var de *deadlineError
		if !errors.As(err, &de) || exitStatus(err) != exitDeadline {
			t.Fatalf("runJob = %v, want the deadline's error", err)
		}
		if !errors.As(cause, &de) {
			t.Fatalf("the hung decode was cancelled by %v, not by the deadline", cause)
		}
		time.Sleep(time.Hour)
		codes, at := ex.record()
		if len(codes) != 1 || codes[0] != exitDeadline || at[0] != defaultDeadline {
			t.Fatalf("exits %v at %v, want one %d at %v", codes, at, exitDeadline, defaultDeadline)
		}
		lines := store.lines(t, deadlineKey)
		if last := lines[len(lines)-1]; !deadlineLine.MatchString(last) {
			t.Fatalf("last line %q is not the deadline's", last)
		}
		if !strings.HasSuffix(lines[0], deadlineName+": deadline 15m0s") {
			t.Fatalf("the log does not open on the deadline in force: %q", lines[0])
		}
		if statuses(lines) != 1 {
			t.Fatalf("%d status lines:\n%s", statuses(lines), strings.Join(lines, "\n"))
		}
	})
}

// A decode spinning on the only processor, deaf to its context, still
// meets the deadline: the timer runs beside it (asynchronous preemption),
// stores the log and exits. Real time: a synctest bubble's clock never
// moves while a goroutine spins.
func TestTheDeadlineEndsAJobSpinningOnTheOnlyProcessor(t *testing.T) {
	if strings.Contains(os.Getenv("GODEBUG"), "asyncpreemptoff=1") {
		t.Skip("the deadline preempts the spinning decode asynchronously")
	}
	var quit atomic.Bool
	prev := runtime.GOMAXPROCS(1)
	t.Cleanup(func() {
		quit.Store(true)
		runtime.GOMAXPROCS(prev)
	})
	all := ifsBlocks(t)
	store, ex := newMemStore(), newExits()
	done := make(chan error, 1)
	go func() {
		done <- deadlineJob(all, io.Discard, 50*time.Millisecond, ex, store, []int{0}, func(context.Context, int) (int, error) {
			for !quit.Load() {
			}
			return 0, nil
		})
	}()
	select {
	case <-ex.seen:
	case <-time.After(10 * time.Second):
		t.Fatal("a decode spinning on the only processor held the deadline off")
	}
	if codes, _ := ex.record(); codes[0] != exitDeadline {
		t.Fatalf("exit %d, want %d", codes[0], exitDeadline)
	}
	lines := store.lines(t, deadlineKey)
	if last := lines[len(lines)-1]; !deadlineLine.MatchString(last) {
		t.Fatalf("last line %q is not the deadline's", last)
	}
	quit.Store(true)
	if err := <-done; exitStatus(err) != exitDeadline {
		t.Fatalf("runJob = %v once the spin ended, want the deadline's error", err)
	}
}

// A job done in time keeps its own status, and its deadline never fires.
func TestAJobDoneBeforeItsDeadlineNeverExits(t *testing.T) {
	all := ifsBlocks(t)
	synctest.Test(t, func(t *testing.T) {
		store, ex := newMemStore(), newExits()
		err := deadlineJob(all, io.Discard, defaultDeadline, ex, store, []int{0, 1}, func(_ context.Context, bi int) (int, error) {
			time.Sleep(time.Minute)
			return bi, nil
		})
		if err != nil {
			t.Fatal(err)
		}
		time.Sleep(time.Hour)
		if codes, _ := ex.record(); len(codes) != 0 {
			t.Fatalf("a job done in time exited %v later", codes)
		}
		lines := store.lines(t, deadlineKey)
		if last := lines[len(lines)-1]; !strings.HasSuffix(last, " ok") || statuses(lines) != 1 {
			t.Fatalf("log:\n%s", strings.Join(lines, "\n"))
		}
	})
}

// A job ending at the very instant of its deadline is ended by one of the
// two, never both: one status line, and the exit, the last line and the
// returned error all name the same one.
func TestAJobEndingAtItsDeadlineWritesOneStatus(t *testing.T) {
	byDeadline, byJob := 0, 0
	for i := range 50 {
		synctest.Test(t, func(t *testing.T) {
			all := ifsBlocks(t)
			store, ex := newMemStore(), newExits()
			err := deadlineJob(all, io.Discard, defaultDeadline, ex, store, []int{0}, func(_ context.Context, bi int) (int, error) {
				time.Sleep(defaultDeadline)
				return bi, nil
			})
			time.Sleep(time.Hour)
			lines := store.lines(t, deadlineKey)
			codes, _ := ex.record()
			var de *deadlineError
			ended := errors.As(err, &de)
			last := deadlineLine.MatchString(lines[len(lines)-1])
			exited := len(codes) == 1 && codes[0] == exitDeadline
			if statuses(lines) != 1 || len(codes) > 1 || ended != last || ended != exited || (!ended && err != nil) {
				t.Fatalf("run %d: error %v, exits %v, log:\n%s", i, err, codes, strings.Join(lines, "\n"))
			}
			if ended {
				byDeadline++
			} else {
				byJob++
			}
		})
	}
	t.Logf("of 50 runs, %d ended by the deadline, %d by the job", byDeadline, byJob)
}

// wedge blocks the write of the deadline's status line (jobLog.finish
// writes it holding the log's lock) until released.
type wedge struct{ release chan struct{} }

func (w *wedge) Write(p []byte) (int, error) {
	if bytes.Contains(p, []byte("error: ran past its")) {
		<-w.release
	}
	return len(p), nil
}

// A deadline whose own way out wedges (its status line's write blocks) is
// exited by the backstop, which only exits, deadlineBackstop later; and
// the backstop outlasts the log's store at its slowest (a minute, then the
// Report's 30 s).
func TestTheBackstopExitsWhenTheLogWedges(t *testing.T) {
	if deadlineBackstop <= time.Minute+30*time.Second {
		t.Fatalf("deadlineBackstop %v does not outlast storeLog's worst", deadlineBackstop)
	}
	all := ifsBlocks(t)
	synctest.Test(t, func(t *testing.T) {
		store, ex := newMemStore(), newExits()
		w := &wedge{release: make(chan struct{})}
		done := make(chan error, 1)
		go func() {
			done <- deadlineJob(all, w, defaultDeadline, ex, store, []int{0}, func(ctx context.Context, bi int) (int, error) {
				<-ctx.Done()
				return 0, ctx.Err()
			})
		}()
		<-ex.seen
		codes, at := ex.record()
		if codes[0] != exitDeadline || at[0] != defaultDeadline+deadlineBackstop {
			t.Fatalf("first exit %d at %v, want %d at %v", codes[0], at[0], exitDeadline, defaultDeadline+deadlineBackstop)
		}
		close(w.release)
		<-done
	})
}

// The deadline is the Container's: given, it holds whatever the store;
// unsaid, -out r2 takes defaultDeadline and a directory none.
func TestTheDeadlineIsTheContainers(t *testing.T) {
	for _, c := range []struct {
		args []string
		want time.Duration
	}{
		{[]string{"-out", "r2"}, defaultDeadline},
		{[]string{"-out", "r2", "-deadline", "0"}, 0},
		{[]string{"-out", "r2", "-deadline", "-5m"}, 0},
		{[]string{"-out", "/tmp/store"}, 0},
		{[]string{"-out", "/tmp/store", "-deadline", "1h"}, time.Hour},
	} {
		fs := flag.NewFlagSet("ingest", flag.ContinueOnError)
		out := fs.String("out", "", "")
		d := fs.Duration("deadline", defaultDeadline, "")
		if err := fs.Parse(c.args); err != nil {
			t.Fatal(err)
		}
		if got := jobDeadline(fs, *out, *d); got != c.want {
			t.Errorf("%v: deadline %v, want %v", c.args, got, c.want)
		}
	}
}
