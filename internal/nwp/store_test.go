package nwp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// multipartServer is the outbound handler's multipart protocol over a map:
// it keeps every part it was given, the completion's list and an abort, and
// counts the parts it is answering at once.
type multipartServer struct {
	mu          sync.Mutex
	parts       map[int][]byte
	attempts    map[int]int
	completed   []int
	aborted     bool
	inFlight    int
	maxInFlight int
	// hold, when set, keeps a part's answer until it returns.
	hold func(part int)
	// fail, when set, names the status a part attempt answers (0 for 200).
	fail func(part, attempt int) int
}

func newMultipartServer() *multipartServer {
	return &multipartServer{parts: map[int][]byte{}, attempts: map[int]int{}}
}

func (s *multipartServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	switch {
	case r.Method == http.MethodPost && q.Has("uploads"):
		fmt.Fprint(w, `{"uploadId":"u1"}`)
	case r.Method == http.MethodPut && q.Get("upload") == "u1":
		n, _ := strconv.Atoi(q.Get("part"))
		body, err := io.ReadAll(r.Body)
		if err != nil {
			return
		}
		s.mu.Lock()
		s.attempts[n]++
		attempt := s.attempts[n]
		s.inFlight++
		s.maxInFlight = max(s.maxInFlight, s.inFlight)
		s.mu.Unlock()
		defer func() {
			s.mu.Lock()
			s.inFlight--
			s.mu.Unlock()
		}()
		if s.hold != nil {
			s.hold(n)
		}
		if s.fail != nil {
			if st := s.fail(n, attempt); st != 0 {
				http.Error(w, "refused", st)
				return
			}
		}
		s.mu.Lock()
		s.parts[n] = body
		s.mu.Unlock()
		fmt.Fprintf(w, `{"partNumber":%d,"etag":"e%d"}`, n, n)
	case r.Method == http.MethodPost && q.Get("upload") == "u1":
		var c struct {
			Parts []struct {
				PartNumber int    `json:"partNumber"`
				ETag       string `json:"etag"`
			} `json:"parts"`
		}
		if err := json.NewDecoder(r.Body).Decode(&c); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		for _, p := range c.Parts {
			if p.ETag != "e"+strconv.Itoa(p.PartNumber) {
				http.Error(w, "etag "+p.ETag+" for part "+strconv.Itoa(p.PartNumber), http.StatusBadRequest)
				return
			}
			s.completed = append(s.completed, p.PartNumber)
		}
		fmt.Fprint(w, "ok")
	case r.Method == http.MethodDelete && q.Get("upload") == "u1":
		s.mu.Lock()
		s.aborted = true
		s.mu.Unlock()
		fmt.Fprint(w, "ok")
	default:
		http.Error(w, "unexpected "+r.Method+" "+r.URL.String(), http.StatusBadRequest)
	}
}

// multipartResult is what the server saw, read under its lock: the socket
// orders the handlers before the client's return for the test, not for the
// race detector.
type multipartResult struct {
	completed   []int
	aborted     bool
	maxInFlight int
	attempts    map[int]int
	// object is what the completion makes: the completed parts in the
	// order it lists them.
	object []byte
}

func (s *multipartServer) result() multipartResult {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := multipartResult{completed: s.completed, aborted: s.aborted, maxInFlight: s.maxInFlight, attempts: map[int]int{}}
	for k, v := range s.attempts {
		r.attempts[k] = v
	}
	var b bytes.Buffer
	for _, n := range s.completed {
		b.Write(s.parts[n])
	}
	r.object = b.Bytes()
	return r
}

// archiveFile writes n bytes no two parts share.
func archiveFile(t *testing.T, n int) (string, []byte) {
	t.Helper()
	b := make([]byte, n)
	for i := range b {
		b[i] = byte(i*7 + i/1000)
	}
	p := filepath.Join(t.TempDir(), "a.pmtiles")
	if err := os.WriteFile(p, b, 0o644); err != nil {
		t.Fatal(err)
	}
	return p, b
}

func TestPartsGoUpInParallelAndTheObjectIsTheFile(t *testing.T) {
	s := newMultipartServer()
	// Every part waits until the store answers four at once (or a while),
	// and the later ones of each group answer first.
	var mu sync.Mutex
	arrived := 0
	release := make(chan struct{})
	s.hold = func(n int) {
		mu.Lock()
		arrived++
		if arrived == PartsInFlight {
			close(release)
		}
		mu.Unlock()
		select {
		case <-release:
		case <-time.After(2 * time.Second):
		}
		time.Sleep(time.Duration(12-n) * time.Millisecond)
	}
	srv := httptest.NewServer(s)
	defer srv.Close()
	path, want := archiveFile(t, 10*1024+517) // 11 parts of 1 KiB, the last short
	st := HTTPStore{Base: srv.URL, Client: srv.Client(), PartSize: 1024}
	if err := st.PutFile(context.Background(), "first/m/2026100800.pmtiles", path, "application/vnd.pmtiles"); err != nil {
		t.Fatal(err)
	}
	r := s.result()
	if r.maxInFlight != PartsInFlight {
		t.Errorf("%d parts at once, want %d", r.maxInFlight, PartsInFlight)
	}
	if fmt.Sprint(r.completed) != "[1 2 3 4 5 6 7 8 9 10 11]" {
		t.Errorf("the completion listed %v", r.completed)
	}
	if !bytes.Equal(r.object, want) {
		t.Error("the object the parts make is not the file")
	}
	if r.aborted {
		t.Error("a whole upload was aborted")
	}
}

func TestOnePartAtATimeWhenAsked(t *testing.T) {
	s := newMultipartServer()
	srv := httptest.NewServer(s)
	defer srv.Close()
	path, want := archiveFile(t, 5*1024)
	st := HTTPStore{Base: srv.URL, Client: srv.Client(), PartSize: 1024, InFlight: 1}
	if err := st.PutFile(context.Background(), "first/m/2026100800.pmtiles", path, ""); err != nil {
		t.Fatal(err)
	}
	if r := s.result(); r.maxInFlight != 1 || !bytes.Equal(r.object, want) {
		t.Errorf("%d at once, the object right: %v", r.maxInFlight, bytes.Equal(r.object, want))
	}
}

func TestAPartTheStoreFailedIsAskedAgain(t *testing.T) {
	quickRetries(t)
	s := newMultipartServer()
	s.fail = func(part, attempt int) int {
		if part == 2 && attempt == 1 {
			return http.StatusInternalServerError
		}
		return 0
	}
	srv := httptest.NewServer(s)
	defer srv.Close()
	path, want := archiveFile(t, 6*1024)
	st := HTTPStore{Base: srv.URL, Client: srv.Client(), PartSize: 1024}
	if err := st.PutFile(context.Background(), "blocks/m/2026100800/b007-012.pmtiles", path, ""); err != nil {
		t.Fatal(err)
	}
	if r := s.result(); r.attempts[2] != 2 || !bytes.Equal(r.object, want) {
		t.Errorf("part 2 asked %d times, the object right: %v", r.attempts[2], bytes.Equal(r.object, want))
	}
}

func TestAPartRefusedEndsTheUploadAndAbortsIt(t *testing.T) {
	quickRetries(t)
	s := newMultipartServer()
	// Part 3 is refused; the parts in flight beside it are held a moment,
	// so they are still running when it fails.
	s.fail = func(part, _ int) int {
		if part == 3 {
			return http.StatusBadRequest
		}
		return 0
	}
	s.hold = func(n int) {
		if n != 3 {
			time.Sleep(50 * time.Millisecond)
		}
	}
	srv := httptest.NewServer(s)
	defer srv.Close()
	path, _ := archiveFile(t, 40*1024)
	st := HTTPStore{Base: srv.URL, Client: srv.Client(), PartSize: 1024}
	err := st.PutFile(context.Background(), "blocks/m/2026100800/b007-012.pmtiles", path, "")
	if err == nil || !strings.Contains(err.Error(), "part 3 of blocks/m/2026100800/b007-012.pmtiles") {
		t.Fatalf("the error does not name the refused part: %v", err)
	}
	var stErr *storeStatus
	if !errors.As(err, &stErr) || stErr.status != http.StatusBadRequest {
		t.Errorf("the refusal is not the error: %v", err)
	}
	r := s.result()
	if !r.aborted || r.completed != nil {
		t.Errorf("aborted %v, completed %v", r.aborted, r.completed)
	}
	if r.attempts[3] != 1 {
		t.Errorf("a refused part was asked %d times", r.attempts[3])
	}
	// No part starts once one has failed: of the 40, only those in flight
	// beside it were asked.
	if len(r.attempts) > PartsInFlight {
		t.Errorf("%d parts were asked, %v", len(r.attempts), r.attempts)
	}
}

func TestAnUploadTheJobAbandonsIsAbortedStill(t *testing.T) {
	s := newMultipartServer()
	ctx, cancel := context.WithCancel(context.Background())
	var once sync.Once
	s.hold = func(int) {
		once.Do(cancel)
		time.Sleep(20 * time.Millisecond)
	}
	srv := httptest.NewServer(s)
	defer srv.Close()
	path, _ := archiveFile(t, 20*1024)
	st := HTTPStore{Base: srv.URL, Client: srv.Client(), PartSize: 1024}
	err := st.PutFile(ctx, "blocks/m/2026100800/b007-012.pmtiles", path, "")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("got %v", err)
	}
	if r := s.result(); !r.aborted || r.completed != nil {
		t.Errorf("aborted %v, completed %v: the abort runs past the job's own context", r.aborted, r.completed)
	}
}
