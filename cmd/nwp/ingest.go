package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/0intro/loxodrome/internal/nwp"
)

// exitStopped is the status of a job stopped on request (the platform's
// SIGTERM before a rollout replaces its instance or a host's maintenance,
// an operator's interrupt): EX_TEMPFAIL, which the orchestrator charges
// nothing for (loxodrome-nwp/src/plan.ts EXIT_STOPPED, held to this value
// by its suite).
const exitStopped = 75

// stopGrace is how long the blocks in progress run on after the first
// signal before they are abandoned. A stop may still finish one block's
// store and the next block whole (blocks are pipelined, an AROME block
// taking up to a minute), so the job stores its log long before the
// platform's SIGKILL, 15 minutes after its SIGTERM.
const stopGrace = 5 * time.Minute

// exitDeadline is the status of a job that ran past its deadline, the
// coreutils timeout's: charged like any failure, and mailed, by the
// orchestrator (loxodrome-nwp/src/plan.ts EXIT_DEADLINE, held to this
// value by its suite).
const exitDeadline = 124

// defaultDeadline bounds a Container job (-out r2) by itself, whatever
// becomes of the orchestrator: Cloudflare puts no limit on how long a
// container runs. It lies past the orchestrator's cap (12 minutes, judged
// by a tick a minute), so it never fires while the orchestrator works, and
// with its backstop short of the rollout's grace (20 minutes) and of the
// library's inactivity timeout (30), all held together by the Worker's
// suite.
const defaultDeadline = 15 * time.Minute

// deadlineBackstop is how long the deadline's own way out may take (the
// log stored: a minute at most, and the Report's 30 s) before the process
// exits regardless, a job wedged in its log's writer included.
const deadlineBackstop = 2 * time.Minute

// memoryLimit is where the collector starts working harder: two blocks in
// flight hold about 2.5 GB live at most (AROME; AROME-OM's Indian Ocean
// about as much), and the instance has 12 GiB.
const memoryLimit = 6 << 30

// cmdIngest builds the archives of some blocks of one run and puts them,
// with their receipts, into the store: a directory, or R2 through the
// Worker's outbound handler (the Container's case, -out r2). A block is
// decoded while the one before it is stored. A SIGTERM or an interrupt
// stops it after the blocks in progress (exit 75); a second one, or
// stopGrace, abandons them. Past its deadline the job ends itself (exit
// 124).
func cmdIngest(args []string) error {
	// Heard before anything else and never released: a signal taking its
	// default action would end the job without its log or its status.
	sigs := listen()
	fs := flag.NewFlagSet("ingest", flag.ExitOnError)
	model := fs.String("model", "", modelIDs())
	runFlag := fs.String("run", "", "run, 2006-01-02T15")
	blocks := fs.String("blocks", "all", "block indexes (0,1,...) or all")
	out := fs.String("out", "", "a directory, or r2")
	storeURL := fs.String("store", envOr("NWP_STORE", "http://r2.nwp"), "the outbound store's base URL, for -out r2")
	mirror := fs.String("mirror", "", "a directory of source files read in place of the network")
	tmp := fs.String("tmp", os.TempDir(), "where archives are built")
	deadline := fs.Duration("deadline", defaultDeadline, "how long the job may run before it ends itself (exit 124): this for -out r2 unless given, none for a directory unless given")
	fs.Parse(args)
	m, err := nwp.ModelByID(*model)
	if err != nil {
		return err
	}
	run, err := m.RunTime(*runFlag)
	if err != nil {
		return err
	}
	var store nwp.Store
	switch *out {
	case "":
		return fmt.Errorf("ingest: -out is required")
	case "r2":
		// A connection kept for every part in flight, and one for the
		// orography the next block's decode reads meanwhile: the default
		// transport keeps two, and redialled the rest at every part.
		tr := http.DefaultTransport.(*http.Transport).Clone()
		tr.MaxIdleConnsPerHost = nwp.PartsInFlight + 1
		store = nwp.HTTPStore{Base: strings.TrimRight(*storeURL, "/"), Client: &http.Client{Timeout: 10 * time.Minute, Transport: tr}, PartSize: nwp.PartSize}
	default:
		store = nwp.DirStore{Root: *out}
	}
	all := m.Blocks(run)
	var pick []int
	if *blocks == "all" {
		for i := range all {
			pick = append(pick, i)
		}
	} else {
		for _, s := range strings.Split(*blocks, ",") {
			i, err := strconv.Atoi(strings.TrimSpace(s))
			if err != nil || i < 0 || i >= len(all) {
				return fmt.Errorf("ingest: block %q of %d", s, len(all))
			}
			pick = append(pick, i)
		}
	}
	jl := &jobLog{w: os.Stderr}
	logger := log.New(jl, "", log.LstdFlags|log.LUTC)
	fetcher := &nwp.Fetcher{
		Client:    &http.Client{Timeout: 15 * time.Minute},
		UserAgent: "loxodrome-nwp (+https://loxodrome.fr)",
		Log:       logger.Printf,
		Mirror:    *mirror,
	}
	debug.SetMemoryLimit(memoryLimit)
	// The orography the first block decodes serves the blocks after it:
	// decodes run one after another, so each finds the one before it's.
	var elev []int16
	decode := func(ctx context.Context, bi int) (*decodedBlock, error) {
		d, err := decodeBlock(ctx, m, run, all[bi], elev, store, fetcher, logger)
		if err == nil && elev == nil {
			elev = d.cube.Grid(nwp.SegStatic, 0, 0)
		}
		return d, err
	}
	keep := func(ctx context.Context, bi int, d *decodedBlock, w stageWaits) error {
		return storeBlock(ctx, m, run, all, bi, d, w, store, logger, *tmp)
	}
	logKey := fmt.Sprintf("logs/%s/%s/%s.log", m.ID, nwp.RunKey(run), all[pick[0]].Name())
	lim := jobLimits{grace: stopGrace, deadline: jobDeadline(fs, *out, *deadline), exit: os.Exit}
	return runJob(sigs, lim, all, pick, decode, keep, store, logKey, m.ID+" "+nwp.RunKey(run), jl, logger)
}

// jobDeadline is the job's deadline: the flag's when given, else the
// Container's (-out r2), and none for a directory, whose builds (a whole
// run) may be long. The Worker passes no flag for it: during a rollout a
// new Worker starts the image it replaces, which would refuse one.
func jobDeadline(fs *flag.FlagSet, out string, d time.Duration) time.Duration {
	given := false
	fs.Visit(func(f *flag.Flag) {
		if f.Name == "deadline" {
			given = true
		}
	})
	switch {
	case given:
		return max(d, 0)
	case out == "r2":
		return defaultDeadline
	default:
		return 0
	}
}

// jobLimits are a job's times: the grace a stop gives the blocks in
// progress, the deadline past which the job ends itself (0: none), and how
// it exits then (os.Exit, or a test's recorder).
type jobLimits struct {
	grace    time.Duration
	deadline time.Duration
	exit     func(int)
}

// listen hears the signals that stop a job.
func listen() chan os.Signal {
	sigs := make(chan os.Signal, 2)
	signal.Notify(sigs, syscall.SIGTERM, os.Interrupt)
	return sigs
}

// runJob runs the picked blocks under the stop signals and leaves the
// job's log, its status as the last line, beside what it built: the
// orchestrator reads it when a block is missing, the Container's own
// output being out of its reach.
//
// Past its deadline the job ends itself from a timer of its own, which
// runs whatever the blocks are doing (a decode spinning included): it
// cancels the blocks in progress, stores the log with the deadline as its
// status and exits exitDeadline. Whichever of the job and its deadline
// ends first writes the status; the other writes nothing. A backstop exits
// regardless once the deadline's way out has had deadlineBackstop, and
// only exits: logging could block where the deadline's own path blocked.
func runJob[C any](sigs <-chan os.Signal, lim jobLimits, all []nwp.Block, pick []int, decode func(context.Context, int) (C, error), keep func(context.Context, int, C, stageWaits) error, store nwp.Store, logKey, name string, jl *jobLog, logger *log.Logger) error {
	st := newStopper(sigs, lim.grace, logger.Printf)
	start := time.Now()
	var ended atomic.Bool
	expired := make(chan struct{})
	var past error
	if lim.deadline > 0 {
		past = &deadlineError{lim.deadline}
		logger.Printf("%s: deadline %v", name, lim.deadline)
		backstop := time.AfterFunc(lim.deadline+deadlineBackstop, func() { lim.exit(exitDeadline) })
		defer backstop.Stop()
		dl := time.AfterFunc(lim.deadline, func() {
			if !ended.CompareAndSwap(false, true) {
				return
			}
			defer close(expired)
			st.cancel(past)
			logger.Printf("%s: running past its %v deadline: ending the job", name, lim.deadline)
			status := statusLine(past)
			storeLog(store, logKey, jl.finish(status), name+": "+status)
			lim.exit(exitDeadline)
		})
		defer dl.Stop()
	}
	n, err := runBlocks(st.ctx, st.stop, all, pick, decode, keep)
	if !ended.CompareAndSwap(false, true) {
		// The deadline ended the job and has exited (a test's recorder
		// returns instead).
		<-expired
		st.release()
		return past
	}
	err = st.classify(err)
	st.release()
	logger.Printf("%s: %d of %d blocks in %s, GOMAXPROCS %d", name, n, len(pick), time.Since(start).Round(time.Second), runtime.GOMAXPROCS(0))
	status := statusLine(err)
	storeLog(store, logKey, jl.finish(status), name+": "+status)
	return err
}

// stageWaits are a block's waits between the two stages: its decoded cube
// waiting for the store before it (the job bound by its stores), and the
// store stage idle until this block was decoded (bound by the downloads).
type stageWaits struct{ waited, idle time.Duration }

// runBlocks builds the picked blocks in order, in two stages: block N+1 is
// decoded while block N is stored, so at most two blocks are in hand, and
// the stores keep the order, their receipts a prefix of the job. It stops
// at the first failure, a store's beating the decode after it (which it
// cancels), and never returns with a store in flight. Once stop is closed
// no decode starts: the blocks in progress finish, and the error names the
// first block left. It returns how many blocks were stored.
func runBlocks[C any](ctx context.Context, stop <-chan struct{}, all []nwp.Block, pick []int, decode func(context.Context, int) (C, error), keep func(context.Context, int, C, stageWaits) error) (int, error) {
	pctx, pcancel := context.WithCancelCause(ctx)
	defer pcancel(nil)
	type result struct {
		err error
		end time.Time
	}
	stored := 0
	var pending chan result // the store in flight
	storeEnded := time.Now()
	wait := func() error {
		if pending == nil {
			return nil
		}
		r := <-pending
		pending = nil
		storeEnded = r.end
		if r.err == nil {
			stored++
		}
		return r.err
	}
	for _, bi := range pick {
		select {
		case <-stop:
			if err := wait(); err != nil {
				return stored, err
			}
			return stored, &stopError{"before " + all[bi].Name()}
		default:
		}
		c, err := decode(pctx, bi)
		decoded := time.Now()
		if serr := wait(); serr != nil {
			return stored, serr
		}
		if err != nil {
			return stored, err
		}
		w := stageWaits{waited: max(0, storeEnded.Sub(decoded)), idle: max(0, decoded.Sub(storeEnded))}
		done := make(chan result, 1)
		go func() {
			err := keep(ctx, bi, c, w)
			if err != nil {
				pcancel(err)
			}
			done <- result{err, time.Now()}
		}()
		pending = done
	}
	return stored, wait()
}

// A decodedBlock is a block decoded and waiting for its store.
type decodedBlock struct {
	cube    *nwp.Cube
	sources []nwp.SourceRef
	took    time.Duration
}

// decodeBlock downloads and decodes one block.
func decodeBlock(ctx context.Context, m *nwp.Model, run time.Time, b nwp.Block, elev []int16, store nwp.Store, fetcher *nwp.Fetcher, logger *log.Logger) (*decodedBlock, error) {
	logger.Printf("%s %s %s: building", m.ID, nwp.RunKey(run), b.Name())
	start := time.Now()
	cube, sources, err := nwp.IngestBlock(ctx, m, run, b, nwp.IngestOptions{
		Fetcher: fetcher, Store: store, Log: logger.Printf, Elevation: elev,
	})
	if err != nil {
		return nil, fmt.Errorf("%s %s %s: %w", m.ID, nwp.RunKey(run), b.Name(), err)
	}
	return &decodedBlock{cube: cube, sources: sources, took: time.Since(start)}, nil
}

// storeBlock writes a decoded block's archive, stores it and then its
// receipt, and logs what it built.
func storeBlock(ctx context.Context, m *nwp.Model, run time.Time, all []nwp.Block, bi int, d *decodedBlock, w stageWaits, store nwp.Store, logger *log.Logger, tmp string) error {
	b := all[bi]
	name := fmt.Sprintf("%s %s %s", m.ID, nwp.RunKey(run), b.Name())
	start := time.Now()
	path := filepath.Join(tmp, fmt.Sprintf("%s-%s-%s.pmtiles", m.ID, nwp.RunKey(run), b.Name()))
	rec, err := d.cube.WriteArchive(path, d.sources)
	// The archive holds the cube now: let it go during the upload.
	d.cube = nil
	if err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	encoded := time.Since(start)
	key := nwp.VersionedKey(nwp.ArchiveKey(m, run, bi, b), rec.SHA256)
	upStart := time.Now()
	if err := store.PutFile(ctx, key, path, "application/vnd.pmtiles"); err != nil {
		return fmt.Errorf("%s: storing %s: %w", name, key, err)
	}
	uploaded := time.Since(upStart)
	os.Remove(path)
	rec.Key = key
	body, _ := json.MarshalIndent(rec, "", "\t")
	// The receipt follows its stored archive even when a stop's grace runs
	// out between them: a small write, given its own time.
	rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer cancel()
	if err := store.Put(rctx, nwp.ReceiptKey(m, run, b), body, "application/json"); err != nil {
		return fmt.Errorf("%s: storing the receipt: %w", name, err)
	}
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	const tenth = 100 * time.Millisecond
	logger.Printf("%s: %d tiles, %.1f MB, decoded %s, waited %s, encoded %s, uploaded %s, store idle %s, memory from the OS %d MB",
		name, rec.Tiles, float64(rec.Size)/1e6, d.took.Round(tenth), w.waited.Round(tenth),
		encoded.Round(tenth), uploaded.Round(tenth), w.idle.Round(tenth), ms.Sys>>20)
	return nil
}

// A stopError is a job stopped on request (exitStopped): no block started
// after the signal, or the block in progress was abandoned to it.
type stopError struct{ detail string }

func (e *stopError) Error() string { return "stopped " + e.detail }

// A deadlineError is a job that ran past its deadline (exitDeadline). Its
// status line is a failure's, `error: ran past its 15m0s deadline`
// (loxodrome-nwp/src/plan.ts DEADLINE_LINE).
type deadlineError struct{ after time.Duration }

func (e *deadlineError) Error() string { return fmt.Sprintf("ran past its %v deadline", e.after) }

// stopper turns the stop signals into the job's two moments. The first
// closes stop, after which no block starts, while the blocks in progress
// (one being stored, the next being decoded) run on under ctx, which only
// a second signal, or grace after the first, cancels. The signal itself
// never cancels a block: one that completed would fail to store its
// archive on a dead context.
type stopper struct {
	stop   chan struct{}
	ctx    context.Context
	cancel context.CancelCauseFunc
	done   chan struct{}
}

// errReleased ends a stopper whose job is over.
var errReleased = errors.New("the job is over")

func newStopper(sigs <-chan os.Signal, grace time.Duration, logf func(string, ...any)) *stopper {
	ctx, cancel := context.WithCancelCause(context.Background())
	s := &stopper{stop: make(chan struct{}), ctx: ctx, cancel: cancel, done: make(chan struct{})}
	go s.watch(sigs, grace, logf)
	return s
}

func (s *stopper) watch(sigs <-chan os.Signal, grace time.Duration, logf func(string, ...any)) {
	defer close(s.done)
	var sig os.Signal
	select {
	case sig = <-sigs:
	case <-s.ctx.Done():
		return
	}
	close(s.stop)
	logf("%v: finishing the blocks in progress, starting no other", sig)
	t := time.NewTimer(grace)
	defer t.Stop()
	select {
	case sig = <-sigs:
		logf("%v again: abandoning the blocks in progress", sig)
		s.cancel(fmt.Errorf("%v again", sig))
	case <-t.C:
		logf("still building %v after the stop: abandoning the blocks in progress", grace)
		s.cancel(fmt.Errorf("still building %v after the stop", grace))
	case <-s.ctx.Done():
	}
}

// requested reports whether a stop was asked for.
func (s *stopper) requested() bool {
	select {
	case <-s.stop:
		return true
	default:
		return false
	}
}

// classify names what a stop did to the job: a block the stop abandoned
// failed for the stop, not for itself. Judged by the stopper's own state,
// never by the error, whose chain can hold context.Canceled for other
// reasons (the Fetcher cuts an idle download with a cancel of its own), so
// a block that failed by itself while the job was stopping stays a
// failure, charged.
func (s *stopper) classify(err error) error {
	var se *stopError
	if err == nil || errors.As(err, &se) || !s.requested() || s.ctx.Err() == nil {
		return err
	}
	return &stopError{fmt.Sprintf("in a block abandoned (%v): %v", context.Cause(s.ctx), err)}
}

// release ends the stopper once its job is over, and waits for it, so it
// logs nothing after.
func (s *stopper) release() {
	s.cancel(errReleased)
	<-s.done
}

// statusLine is the log's last line, which the orchestrator reads: ok, a
// stop (loxodrome-nwp/src/plan.ts STOPPED_LINE), or the error.
func statusLine(err error) string {
	var se *stopError
	switch {
	case err == nil:
		return "ok"
	case errors.As(err, &se):
		return "stopped: " + se.detail
	default:
		return "error: " + err.Error()
	}
}

// storeLog stores the job's log under a context of its own: the job's may
// be spent (a stop that abandoned its block). Unstorable, the job's status
// still reaches the Worker's log by the one request every store answers.
func storeLog(store nwp.Store, key string, lines []string, report string) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if err := store.Put(ctx, key, []byte(strings.Join(lines, "\n")+"\n"), "text/plain; charset=utf-8"); err != nil {
		if hs, ok := store.(nwp.HTTPStore); ok {
			hs.Report(context.Background(), fmt.Sprintf("%s (and the log: %v)", report, err))
		}
	}
}

// jobLog keeps a job's last lines beside writing them through.
type jobLog struct {
	mu       sync.Mutex
	lines    []string
	w        io.Writer
	finished bool
}

func (j *jobLog) Write(p []byte) (int, error) {
	j.mu.Lock()
	if !j.finished {
		for _, l := range strings.Split(strings.TrimRight(string(p), "\n"), "\n") {
			j.lines = append(j.lines, l)
		}
		if n := len(j.lines) - 200; n > 0 {
			j.lines = j.lines[n:]
		}
	}
	j.mu.Unlock()
	return j.w.Write(p)
}

// finish appends the job's status as its last line, in the logger's own
// form, and returns the lines. Whatever is written after (a late signal)
// reaches the output only, so the status stays last, and a second status
// is not written at all.
func (j *jobLog) finish(status string) []string {
	line := time.Now().UTC().Format("2006/01/02 15:04:05") + " " + status
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.finished {
		return append([]string(nil), j.lines...)
	}
	j.finished = true
	j.lines = append(j.lines, line)
	fmt.Fprintln(j.w, line)
	return append([]string(nil), j.lines...)
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
