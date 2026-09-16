package overlay

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// shrinkBackoff drops the retry backoff to a millisecond for the duration
// of a test so the retry path runs in well under a second, then restores
// the production default.
func shrinkBackoff(t *testing.T) {
	t.Helper()
	prev := backoffBase
	backoffBase = time.Millisecond
	t.Cleanup(func() { backoffBase = prev })
}

func TestHTTPGetAllSuccessFirstTry(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		_, _ = w.Write([]byte("payload"))
	}))
	defer srv.Close()

	body, err := HTTPGetAll(context.Background(), srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "payload" {
		t.Errorf("body = %q, want %q", body, "payload")
	}
	if got := hits.Load(); got != 1 {
		t.Errorf("server hit %d times, want 1", got)
	}
}

func TestHTTPGetAllRetriesThenSucceeds(t *testing.T) {
	shrinkBackoff(t)
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		// Two 503s, then a 200 on the third attempt.
		if hits.Add(1) < 3 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write([]byte("ok-after-retry"))
	}))
	defer srv.Close()

	body, err := HTTPGetAll(context.Background(), srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "ok-after-retry" {
		t.Errorf("body = %q, want %q", body, "ok-after-retry")
	}
	if got := hits.Load(); got != 3 {
		t.Errorf("server hit %d times, want 3", got)
	}
}

func TestHTTPGetAllExhaustsRetries(t *testing.T) {
	shrinkBackoff(t)
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	_, err := HTTPGetAll(context.Background(), srv.URL)
	if err == nil {
		t.Fatal("want an error after exhausting retries")
	}
	if !strings.Contains(err.Error(), "HTTP 503") {
		t.Errorf("error %q does not mention HTTP 503", err)
	}
	if got := hits.Load(); got != int32(maxAttempts) {
		t.Errorf("server hit %d times, want %d (one per attempt)", got, maxAttempts)
	}
}

func TestHTTPGetAllNonRetryableStops(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	_, err := HTTPGetAll(context.Background(), srv.URL)
	if err == nil {
		t.Fatal("want an error on 404")
	}
	if !strings.Contains(err.Error(), "HTTP 404") {
		t.Errorf("error %q does not mention HTTP 404", err)
	}
	if got := hits.Load(); got != 1 {
		t.Errorf("server hit %d times, want 1 (404 is not retryable)", got)
	}
}

func TestHTTPGetAllContextCancelled(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancelled before the call, so the first attempt aborts

	if _, err := HTTPGetAll(ctx, srv.URL); !errors.Is(err, context.Canceled) {
		t.Errorf("error = %v, want context.Canceled", err)
	}
}
