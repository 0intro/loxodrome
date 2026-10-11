package nwp

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/grib2"
)

// Fetcher reads the source files over HTTP, retrying with backoff and
// resuming a broken download at the next message boundary.
type Fetcher struct {
	Client  *http.Client
	Retries int
	// UserAgent identifies us to the publishers.
	UserAgent string
	Log       func(format string, args ...any)
	// Mirror is a local directory read in place of the network for the
	// files it holds, by base name (a test corpus).
	Mirror string
	// Idle cuts a connection no byte has come down for this long, which
	// is then resumed like a broken one (default IdleTimeout). The client's
	// own timeout outlasted the job's cap, so a stall rather than a reset
	// ran the job into it with nothing resumed.
	Idle time.Duration
}

// IdleTimeout is how long a download may stand still before it is cut
// and resumed.
const IdleTimeout = 60 * time.Second

// idleReader cancels its request when no read returns bytes for idle.
type idleReader struct {
	r     io.Reader
	idle  time.Duration
	timer *time.Timer
}

func (ir *idleReader) Read(p []byte) (int, error) {
	n, err := ir.r.Read(p)
	if n > 0 {
		ir.timer.Reset(ir.idle)
	}
	return n, err
}

func (f *Fetcher) logf(format string, args ...any) {
	if f.Log != nil {
		f.Log(format, args...)
	}
}

func (f *Fetcher) client() *http.Client {
	if f.Client != nil {
		return f.Client
	}
	return http.DefaultClient
}

func (f *Fetcher) retries() int {
	if f.Retries > 0 {
		return f.Retries
	}
	return 4
}

var backoff = func(attempt int) time.Duration {
	return time.Duration(1<<min(attempt, 5)) * time.Second
}

// ErrNotFound reports a source file the publisher does not (yet) have.
var ErrNotFound = errors.New("nwp: source file not found")

// mirrored answers a request from the local mirror, nil when the mirror
// lacks the file.
func (f *Fetcher) mirrored(url, rng string) *http.Response {
	if f.Mirror == "" {
		return nil
	}
	fh, err := os.Open(filepath.Join(f.Mirror, path.Base(url)))
	if err != nil {
		return nil
	}
	st, err := fh.Stat()
	if err != nil {
		fh.Close()
		return nil
	}
	size := st.Size()
	resp := &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Etag": {`"mirror"`}}, ContentLength: size}
	from, to := int64(0), size
	if rng != "" {
		var a, b int64 = 0, -1
		if n, _ := fmt.Sscanf(rng, "bytes=%d-%d", &a, &b); n == 2 {
			to = b + 1
		} else {
			fmt.Sscanf(rng, "bytes=%d-", &a)
		}
		from = a
		resp.StatusCode = http.StatusPartialContent
		resp.ContentLength = to - from
		resp.Header.Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", from, to-1, size))
	}
	resp.Body = struct {
		io.Reader
		io.Closer
	}{io.NewSectionReader(fh, from, to-from), fh}
	return resp
}

func (f *Fetcher) get(ctx context.Context, url string, rng string, ifRange string) (*http.Response, error) {
	if resp := f.mirrored(url, rng); resp != nil {
		return resp, nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	if f.UserAgent != "" {
		req.Header.Set("User-Agent", f.UserAgent)
	}
	if rng != "" {
		req.Header.Set("Range", rng)
		if ifRange != "" {
			req.Header.Set("If-Range", ifRange)
		}
	}
	return f.client().Do(req)
}

// Messages streams a whole GRIB2 file and hands each message to fn with
// its offset. A connection lost or idle midway is resumed with a ranged
// request from the first message not yet handed over, guarded by the
// file's ETag: a file replaced meanwhile fails the read, since its first
// messages have already been handed over and two editions of one file
// must not be spliced (the block is built again later, from the new one).
func (f *Fetcher) Messages(ctx context.Context, url string, fn func(msg []byte, off int64) error) (SourceRef, error) {
	ref := SourceRef{URL: url}
	var next int64
	idle := f.Idle
	if idle <= 0 {
		idle = IdleTimeout
	}
	for attempt := 0; ; attempt++ {
		rng := ""
		if next > 0 {
			rng = fmt.Sprintf("bytes=%d-", next)
		}
		rctx, cancel := context.WithCancel(ctx)
		resp, err := f.get(rctx, url, rng, ref.ETag)
		if err == nil {
			switch {
			case resp.StatusCode == http.StatusNotFound:
				resp.Body.Close()
				cancel()
				return ref, fmt.Errorf("%w: %s", ErrNotFound, url)
			case next > 0 && resp.StatusCode == http.StatusOK:
				// The file changed under us (If-Range failed).
				resp.Body.Close()
				cancel()
				return ref, fmt.Errorf("%s was replaced while being read", url)
			case resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPartialContent:
				resp.Body.Close()
				err = fmt.Errorf("%s: HTTP %d", url, resp.StatusCode)
			default:
				if next == 0 {
					ref.ETag = resp.Header.Get("ETag")
					ref.Size = resp.ContentLength
				}
				body := &idleReader{r: resp.Body, idle: idle, timer: time.AfterFunc(idle, cancel)}
				err = f.readMessages(body, next, func(msg []byte, off int64) error {
					if err := fn(msg, off); err != nil {
						return &fatal{err}
					}
					next = off + int64(len(msg))
					return nil
				})
				body.timer.Stop()
				resp.Body.Close()
				cancel()
				if err == nil {
					if ref.Size > 0 && next != ref.Size {
						return ref, fmt.Errorf("%s: read %d bytes of %d", url, next, ref.Size)
					}
					return ref, nil
				}
			}
		}
		cancel()
		var fe *fatal
		if errors.As(err, &fe) {
			return ref, fe.err
		}
		if ctx.Err() != nil {
			return ref, ctx.Err()
		}
		if attempt >= f.retries() {
			return ref, fmt.Errorf("%s: %w", url, err)
		}
		f.logf("%s: %v; retrying from byte %d", url, err, next)
		select {
		case <-time.After(backoff(attempt)):
		case <-ctx.Done():
			return ref, ctx.Err()
		}
	}
}

// fatal wraps an error of the consumer, which no retry heals.
type fatal struct{ err error }

func (e *fatal) Error() string { return e.err.Error() }

func (f *Fetcher) readMessages(r io.Reader, base int64, fn func(msg []byte, off int64) error) error {
	gr := grib2.NewReader(r)
	for {
		msg, off, err := gr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		if err := fn(msg, base+off); err != nil {
			return err
		}
	}
}

// Bytes reads a whole small file (an ECMWF .index) or one byte range of a
// file, retrying.
func (f *Fetcher) Bytes(ctx context.Context, url string, from, to int64) ([]byte, error) {
	rng := ""
	if to > 0 {
		rng = fmt.Sprintf("bytes=%d-%d", from, to-1)
	}
	for attempt := 0; ; attempt++ {
		resp, err := f.get(ctx, url, rng, "")
		if err == nil {
			if resp.StatusCode == http.StatusNotFound {
				resp.Body.Close()
				return nil, fmt.Errorf("%w: %s", ErrNotFound, url)
			}
			ok := resp.StatusCode == http.StatusOK || (rng != "" && resp.StatusCode == http.StatusPartialContent)
			if !ok {
				err = fmt.Errorf("%s: HTTP %d", url, resp.StatusCode)
				resp.Body.Close()
			} else {
				var b []byte
				b, err = io.ReadAll(resp.Body)
				resp.Body.Close()
				if err == nil && rng != "" {
					if resp.StatusCode == http.StatusOK {
						// A server ignoring Range sends the whole file.
						if int64(len(b)) < to {
							err = fmt.Errorf("%s: %d bytes, range ends at %d", url, len(b), to)
						} else {
							b = b[from:to]
						}
					} else if cr := resp.Header.Get("Content-Range"); !strings.HasPrefix(cr, "bytes "+strconv.FormatInt(from, 10)+"-") {
						err = fmt.Errorf("%s: Content-Range %q for %s", url, cr, rng)
					}
					if err == nil && int64(len(b)) != to-from {
						err = fmt.Errorf("%s: %d bytes for %s", url, len(b), rng)
					}
				}
				if err == nil {
					return b, nil
				}
			}
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if attempt >= f.retries() {
			return nil, fmt.Errorf("%s: %w", url, err)
		}
		f.logf("%s: %v; retrying", url, err)
		select {
		case <-time.After(backoff(attempt)):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

// messagesIn splits a buffer holding whole messages.
func messagesIn(b []byte, base int64, fn func(msg []byte, off int64) error) error {
	r := grib2.NewReader(bytes.NewReader(b))
	for {
		msg, off, err := r.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		if err := fn(msg, base+off); err != nil {
			return err
		}
	}
}
