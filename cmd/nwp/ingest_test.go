package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"os/signal"
	"regexp"
	"slices"
	"strings"
	"sync"
	"syscall"
	"testing"
	"testing/synctest"
	"time"

	"github.com/0intro/loxodrome/internal/nwp"
)

// The last line a stopped job leaves, as the orchestrator matches it
// (loxodrome-nwp/src/plan.ts STOPPED_LINE).
var stoppedLine = regexp.MustCompile(`^\d{4}/\d\d/\d\d \d\d:\d\d:\d\d stopped: `)

func ifsBlocks(t *testing.T) []nwp.Block {
	t.Helper()
	m, err := nwp.ModelByID("ifs025")
	if err != nil {
		t.Fatal(err)
	}
	return m.Blocks(time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC))
}

func quiet(string, ...any) {}

// stages are a job's two fakes, recording the order of what they did.
type stages struct {
	mu     sync.Mutex
	events []string
	decode func(ctx context.Context, bi int) (int, error)
	store  func(ctx context.Context, bi int, c int, w stageWaits) error
}

func (s *stages) note(e string) {
	s.mu.Lock()
	s.events = append(s.events, e)
	s.mu.Unlock()
}

func (s *stages) log() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.events)
}

// run drives runBlocks through the fakes, defaulting a missing stage to
// one that only records itself.
func (s *stages) run(ctx context.Context, stop <-chan struct{}, all []nwp.Block, pick []int) (int, error) {
	decode := func(ctx context.Context, bi int) (int, error) {
		s.note(fmt.Sprintf("decode %d", bi))
		if s.decode != nil {
			return s.decode(ctx, bi)
		}
		return bi, nil
	}
	keep := func(ctx context.Context, bi int, c int, w stageWaits) error {
		if s.store != nil {
			if err := s.store(ctx, bi, c, w); err != nil {
				return err
			}
		}
		s.note(fmt.Sprintf("stored %d", bi))
		return nil
	}
	return runBlocks(ctx, stop, all, pick, decode, keep)
}

func TestAStopFinishesTheBlockInProgressAndStartsNoOther(t *testing.T) {
	all := ifsBlocks(t)
	sigs := make(chan os.Signal, 2)
	st := newStopper(sigs, time.Hour, quiet)
	defer st.release()
	s := &stages{decode: func(ctx context.Context, bi int) (int, error) {
		if bi == 0 {
			sigs <- syscall.SIGTERM
			<-st.stop
			if ctx.Err() != nil {
				t.Errorf("the block in progress lost its context to the first signal")
			}
		}
		return bi, nil
	}}
	n, err := s.run(st.ctx, st.stop, all, []int{0, 1, 2})
	err = st.classify(err)
	if got := s.log(); !slices.Equal(got, []string{"decode 0", "stored 0"}) || n != 1 {
		t.Fatalf("did %v (%d stored), want block 0 alone", got, n)
	}
	if got := statusLine(err); got != "stopped: before b015-024" {
		t.Fatalf("status %q", got)
	}
	if exitStatus(err) != exitStopped {
		t.Fatalf("exit status %d", exitStatus(err))
	}
}

func TestAStopBeforeTheFirstBlockBuildsNothing(t *testing.T) {
	all := ifsBlocks(t)
	sigs := make(chan os.Signal, 2)
	sigs <- syscall.SIGTERM
	st := newStopper(sigs, time.Hour, quiet)
	defer st.release()
	<-st.stop
	s := &stages{}
	_, err := s.run(st.ctx, st.stop, all, []int{0, 1})
	if got := s.log(); len(got) != 0 {
		t.Fatalf("did %v after the stop", got)
	}
	if got := statusLine(st.classify(err)); got != "stopped: before b000-012" {
		t.Fatalf("status %q", got)
	}
}

// A stop arriving while the next block decodes lets that block finish,
// stored after the one before it, and starts no other.
func TestAStopDuringTheNextDecodeStillStoresIt(t *testing.T) {
	all := ifsBlocks(t)
	sigs := make(chan os.Signal, 2)
	st := newStopper(sigs, time.Hour, quiet)
	defer st.release()
	s := &stages{decode: func(ctx context.Context, bi int) (int, error) {
		if bi == 1 {
			sigs <- syscall.SIGTERM
			<-st.stop
		}
		return bi, nil
	}}
	n, err := s.run(st.ctx, st.stop, all, []int{0, 1, 2, 3})
	got := s.log()
	if n != 2 || !slices.Contains(got, "stored 1") || slices.Contains(got, "decode 2") {
		t.Fatalf("did %v (%d stored), want blocks 0 and 1 stored and no other", got, n)
	}
	if got := statusLine(st.classify(err)); got != "stopped: before b027-036" {
		t.Fatalf("status %q", got)
	}
}

func TestASecondSignalAbandonsTheBlockInProgress(t *testing.T) {
	all := ifsBlocks(t)
	sigs := make(chan os.Signal, 2)
	st := newStopper(sigs, time.Hour, quiet)
	defer st.release()
	s := &stages{decode: func(ctx context.Context, bi int) (int, error) {
		sigs <- syscall.SIGTERM
		sigs <- syscall.SIGTERM
		<-ctx.Done()
		return 0, fmt.Errorf("ifs025 2026100612 b000-012: %w", ctx.Err())
	}}
	_, err := s.run(st.ctx, st.stop, all, []int{0, 1})
	err = st.classify(err)
	var se *stopError
	if !errors.As(err, &se) || !strings.Contains(se.detail, "terminated again") {
		t.Fatalf("got %v, want a stop abandoning the block to the second signal", err)
	}
	if exitStatus(err) != exitStopped {
		t.Fatalf("exit status %d", exitStatus(err))
	}
}

func TestTheGraceAbandonsTheBlockInProgress(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		all := ifsBlocks(t)
		sigs := make(chan os.Signal, 2)
		st := newStopper(sigs, stopGrace, quiet)
		defer st.release()
		var waited time.Duration
		s := &stages{decode: func(ctx context.Context, bi int) (int, error) {
			sigs <- syscall.SIGTERM
			<-st.stop
			start := time.Now()
			<-ctx.Done()
			waited = time.Since(start)
			return 0, ctx.Err()
		}}
		_, err := s.run(st.ctx, st.stop, all, []int{0, 1})
		err = st.classify(err)
		if waited != stopGrace {
			t.Fatalf("abandoned after %v, want %v", waited, stopGrace)
		}
		var se *stopError
		if !errors.As(err, &se) || !strings.Contains(se.detail, "after the stop") {
			t.Fatalf("got %v, want a stop abandoning the block to the grace", err)
		}
	})
}

// The grace running out while a block uploads abandons the upload, a stop
// and not a failure of the block.
func TestTheGraceDuringAStoreGivesAStop(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		all := ifsBlocks(t)
		sigs := make(chan os.Signal, 2)
		st := newStopper(sigs, stopGrace, quiet)
		defer st.release()
		s := &stages{store: func(ctx context.Context, bi int, c int, w stageWaits) error {
			sigs <- syscall.SIGTERM
			<-ctx.Done()
			return fmt.Errorf("storing blocks/x.pmtiles: %w", ctx.Err())
		}}
		_, err := s.run(st.ctx, st.stop, all, []int{0, 1})
		if exitStatus(st.classify(err)) != exitStopped {
			t.Fatalf("got %v, want a stop", err)
		}
	})
}

// The Fetcher cuts an idle download with a cancel of its own, so a block
// can fail with context.Canceled in its chain while the job is stopping
// and nothing cut it: a failure of the block, charged, not a stop.
func TestABlockThatFailsByItselfDuringAStopStaysAFailure(t *testing.T) {
	all := ifsBlocks(t)
	sigs := make(chan os.Signal, 2)
	st := newStopper(sigs, time.Hour, quiet)
	defer st.release()
	s := &stages{decode: func(context.Context, int) (int, error) {
		sigs <- syscall.SIGTERM
		<-st.stop
		return 0, fmt.Errorf("https://data.ecmwf.int/x.grib2: %w", context.Canceled)
	}}
	_, err := s.run(st.ctx, st.stop, all, []int{0, 1})
	err = st.classify(err)
	if exitStatus(err) != 1 || !strings.HasPrefix(statusLine(err), "error: ") {
		t.Fatalf("got %v (exit %d), want a failure", err, exitStatus(err))
	}
}

// Block N+1 is decoded while block N is stored, and no third block is in
// hand: block N+2 waits for N's store.
func TestTheNextBlockDecodesWhileThisOneIsStored(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		all := ifsBlocks(t)
		gate := make(chan struct{})
		s := &stages{store: func(ctx context.Context, bi int, c int, w stageWaits) error {
			if bi == 0 {
				<-gate
			}
			return nil
		}}
		var n int
		var err error
		done := make(chan struct{})
		go func() {
			n, err = s.run(context.Background(), nil, all, []int{0, 1, 2})
			close(done)
		}()
		synctest.Wait()
		if got := s.log(); !slices.Equal(got, []string{"decode 0", "decode 1"}) {
			t.Fatalf("with block 0 storing, did %v, want blocks 0 and 1 decoded and nothing more", got)
		}
		close(gate)
		<-done
		if err != nil || n != 3 {
			t.Fatalf("got %d stored, %v", n, err)
		}
		var stores []string
		for _, e := range s.log() {
			if strings.HasPrefix(e, "stored") {
				stores = append(stores, e)
			}
		}
		if !slices.Equal(stores, []string{"stored 0", "stored 1", "stored 2"}) {
			t.Fatalf("stores %v, want the job's order", stores)
		}
	})
}

// A decode that fails while the block before it is stored does not end
// the job before that store: its receipt still lands.
func TestRunBlocksNeverReturnsWithAStoreInFlight(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		all := ifsBlocks(t)
		gate := make(chan struct{})
		boom := errors.New("decoding b015-024: HTTP 404")
		s := &stages{
			decode: func(ctx context.Context, bi int) (int, error) {
				if bi == 1 {
					return 0, boom
				}
				return bi, nil
			},
			store: func(ctx context.Context, bi int, c int, w stageWaits) error {
				<-gate
				return nil
			},
		}
		var n int
		var err error
		done := make(chan struct{})
		go func() {
			n, err = s.run(context.Background(), nil, all, []int{0, 1, 2})
			close(done)
		}()
		synctest.Wait()
		select {
		case <-done:
			t.Fatal("returned with block 0 still storing")
		default:
		}
		close(gate)
		<-done
		if !errors.Is(err, boom) || n != 1 {
			t.Fatalf("got %d stored, %v; want block 0 stored and the decode's failure", n, err)
		}
	})
}

// A store that fails cancels the decode beside it with its own error, and
// that error is the job's, a failure even with a stop requested.
func TestAStoreFailureCancelsTheDecodeAndWins(t *testing.T) {
	all := ifsBlocks(t)
	sigs := make(chan os.Signal, 2)
	st := newStopper(sigs, time.Hour, quiet)
	defer st.release()
	refused := errors.New("store PUT receipts/x.json: HTTP 403")
	var cause error
	s := &stages{
		decode: func(ctx context.Context, bi int) (int, error) {
			if bi == 1 {
				sigs <- syscall.SIGTERM
				<-ctx.Done()
				cause = context.Cause(ctx)
				return 0, ctx.Err()
			}
			return bi, nil
		},
		store: func(ctx context.Context, bi int, c int, w stageWaits) error {
			<-st.stop
			return refused
		},
	}
	n, err := s.run(st.ctx, st.stop, all, []int{0, 1, 2})
	if cause != refused {
		t.Fatalf("the decode was cancelled by %v, want the store's failure", cause)
	}
	err = st.classify(err)
	if !errors.Is(err, refused) || exitStatus(err) != 1 || n != 0 {
		t.Fatalf("got %v (exit %d, %d stored), want the store's failure", err, exitStatus(err), n)
	}
}

// Two failures at once: the store's, the earlier block's, is the job's.
func TestBothFailingReturnsTheStoreFailure(t *testing.T) {
	all := ifsBlocks(t)
	refused := errors.New("store PUT blocks/b000.pmtiles: HTTP 500")
	broken := errors.New("b015-024: HTTP 404")
	stored := make(chan struct{})
	s := &stages{
		decode: func(ctx context.Context, bi int) (int, error) {
			if bi == 1 {
				<-stored
				return 0, broken
			}
			return bi, nil
		},
		store: func(ctx context.Context, bi int, c int, w stageWaits) error {
			close(stored)
			return refused
		},
	}
	if _, err := s.run(context.Background(), nil, all, []int{0, 1}); !errors.Is(err, refused) {
		t.Fatalf("got %v, want the store's failure", err)
	}
}

func TestAFailureInTheLastStoreIsReturned(t *testing.T) {
	all := ifsBlocks(t)
	refused := errors.New("store PUT blocks/b015.pmtiles: HTTP 500")
	s := &stages{store: func(ctx context.Context, bi int, c int, w stageWaits) error {
		if bi == 1 {
			return refused
		}
		return nil
	}}
	n, err := s.run(context.Background(), nil, all, []int{0, 1})
	if !errors.Is(err, refused) || n != 1 {
		t.Fatalf("got %v, %d stored", err, n)
	}
}

func TestASingleBlockJob(t *testing.T) {
	all := ifsBlocks(t)
	s := &stages{}
	n, err := s.run(context.Background(), nil, all, []int{4})
	if err != nil || n != 1 || !slices.Equal(s.log(), []string{"decode 4", "stored 4"}) {
		t.Fatalf("did %v, %d stored, %v", s.log(), n, err)
	}
}

// The waits between the stages say what bound the job: a decoded block
// waiting for the store before it, or the store stage idle until the next
// block was decoded.
func TestTheStageWaitsSayWhatBoundTheJob(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		all := ifsBlocks(t)
		decodes := map[int]time.Duration{0: 2 * time.Second, 1: time.Second, 2: 2 * time.Second}
		stores := map[int]time.Duration{0: 5 * time.Second, 1: time.Second, 2: time.Second}
		got := map[int]stageWaits{}
		var mu sync.Mutex
		s := &stages{
			decode: func(ctx context.Context, bi int) (int, error) {
				time.Sleep(decodes[bi])
				return bi, nil
			},
			store: func(ctx context.Context, bi int, c int, w stageWaits) error {
				mu.Lock()
				got[bi] = w
				mu.Unlock()
				time.Sleep(stores[bi])
				return nil
			},
		}
		if _, err := s.run(context.Background(), nil, all, []int{0, 1, 2}); err != nil {
			t.Fatal(err)
		}
		// Block 0: the stage idle while it decodes. Block 1, decoded at 3 s,
		// waits for block 0's store until 7 s. Block 2, decoded at 9 s, finds
		// the store stage idle since block 1's store ended at 8 s.
		want := map[int]stageWaits{
			0: {idle: 2 * time.Second},
			1: {waited: 4 * time.Second},
			2: {idle: time.Second},
		}
		for bi, w := range want {
			if got[bi] != w {
				t.Errorf("block %d: %+v, want %+v", bi, got[bi], w)
			}
		}
	})
}

// The signals the platform sends reach the stopper: a real SIGTERM to
// this process, heard through the job's own registration.
func TestTerminateIsHeard(t *testing.T) {
	sigs := listen()
	defer signal.Stop(sigs)
	st := newStopper(sigs, time.Hour, quiet)
	defer st.release()
	if err := syscall.Kill(os.Getpid(), syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	select {
	case <-st.stop:
	case <-time.After(10 * time.Second):
		t.Fatal("SIGTERM did not stop the job")
	}
}

// fakeStore records what the Worker's outbound handler would be sent.
type fakeStore struct {
	mu   sync.Mutex
	puts map[string]string
}

func (f *fakeStore) handler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		http.Error(w, "unexpected "+r.Method, http.StatusMethodNotAllowed)
		return
	}
	b, _ := io.ReadAll(r.Body)
	f.mu.Lock()
	f.puts[strings.TrimPrefix(r.URL.Path, "/")] = string(b)
	f.mu.Unlock()
}

// A stop that abandons its block cancels the job's context: the log still
// reaches the store, through the outbound handler's HTTP, with the stop as
// its last line whatever is logged after, the job's summary before it.
func TestAStoppedJobStillStoresItsLogStatusLast(t *testing.T) {
	all := ifsBlocks(t)
	fs := &fakeStore{puts: map[string]string{}}
	srv := httptest.NewServer(http.HandlerFunc(fs.handler))
	defer srv.Close()
	store := nwp.HTTPStore{Base: srv.URL, Client: srv.Client(), PartSize: nwp.PartSize}
	jl := &jobLog{w: io.Discard}
	logger := log.New(jl, "", log.LstdFlags|log.LUTC)
	sigs := make(chan os.Signal, 2)
	key := "logs/ifs025/2026100612/b000-012.log"
	decode := func(ctx context.Context, bi int) (int, error) {
		logger.Printf("ifs025 2026100612 %s: building", all[bi].Name())
		sigs <- syscall.SIGTERM
		sigs <- syscall.SIGTERM
		<-ctx.Done()
		return 0, fmt.Errorf("ifs025 2026100612 %s: %w", all[bi].Name(), ctx.Err())
	}
	keep := func(context.Context, int, int, stageWaits) error {
		t.Error("a block abandoned in its decode was stored")
		return nil
	}
	err := runJob(sigs, jobLimits{grace: time.Hour}, all, []int{0, 1}, decode, keep, store, key, "ifs025 2026100612", jl, logger)
	if exitStatus(err) != exitStopped {
		t.Fatalf("got %v (exit %d), want a stop", err, exitStatus(err))
	}
	logger.Printf("a late line")
	body, ok := fs.puts[key]
	if !ok {
		t.Fatalf("no log stored; puts %v", fs.puts)
	}
	lines := strings.Split(strings.TrimRight(body, "\n"), "\n")
	last := lines[len(lines)-1]
	if !stoppedLine.MatchString(last) {
		t.Fatalf("last line %q is not a stop", last)
	}
	for _, want := range []string{"building", "finishing the blocks in progress", "0 of 2 blocks in", "GOMAXPROCS"} {
		if !strings.Contains(body, want) {
			t.Fatalf("log lacks %q:\n%s", want, body)
		}
	}
	if got := jl.lines[len(jl.lines)-1]; got != last {
		t.Fatalf("a line logged after the status followed it: %q", got)
	}
}

func TestStatusLines(t *testing.T) {
	for _, c := range []struct {
		err  error
		want string
		exit int
	}{
		{nil, "ok", 0},
		{&stopError{"before b015-024"}, "stopped: before b015-024", exitStopped},
		{fmt.Errorf("wrapped: %w", &stopError{"before b015-024"}), "stopped: before b015-024", exitStopped},
		{errors.New("ifs025 2026100612 b000-012: HTTP 404"), "error: ifs025 2026100612 b000-012: HTTP 404", 1},
		{&deadlineError{defaultDeadline}, "error: ran past its 15m0s deadline", exitDeadline},
		{fmt.Errorf("wrapped: %w", &deadlineError{3 * time.Second}), "error: wrapped: ran past its 3s deadline", exitDeadline},
	} {
		if got := statusLine(c.err); got != c.want {
			t.Errorf("statusLine(%v) = %q, want %q", c.err, got, c.want)
		}
		if c.err != nil && exitStatus(c.err) != c.exit {
			t.Errorf("exitStatus(%v) = %d, want %d", c.err, exitStatus(c.err), c.exit)
		}
	}
	jl := &jobLog{w: io.Discard}
	lines := jl.finish(statusLine(&stopError{"before b015-024"}))
	if !stoppedLine.MatchString(lines[len(lines)-1]) {
		t.Fatalf("the stop's status line %q does not read as one", lines[len(lines)-1])
	}
}
