package nwp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

// Store is where archives, receipts and the cached orography go: a local
// directory, or the R2 bucket behind the Container's outbound handler.
type Store interface {
	// Get reads an object; fs.ErrNotExist when absent.
	Get(ctx context.Context, key string) ([]byte, error)
	// PutFile uploads a file.
	PutFile(ctx context.Context, key, path, contentType string) error
	// Put writes a small object.
	Put(ctx context.Context, key string, b []byte, contentType string) error
}

// DirStore keeps objects as files under Root.
type DirStore struct{ Root string }

func (d DirStore) path(key string) (string, error) {
	if !fs.ValidPath(key) {
		return "", fmt.Errorf("nwp: invalid key %q", key)
	}
	return filepath.Join(d.Root, filepath.FromSlash(key)), nil
}

func (d DirStore) Get(_ context.Context, key string) ([]byte, error) {
	p, err := d.path(key)
	if err != nil {
		return nil, err
	}
	return os.ReadFile(p)
}

func (d DirStore) PutFile(_ context.Context, key, path, _ string) error {
	p, err := d.path(key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	in, err := os.Open(path)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := p + ".tmp"
	out, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

func (d DirStore) Put(_ context.Context, key string, b []byte, _ string) error {
	p, err := d.path(key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

// PartSize is the multipart part an archive goes up in: R2 wants every
// part the same size but the last, at least 5 MiB, and each part is one
// request through the Container's outbound handler, so they stay small.
const PartSize = 8 << 20

// PartsInFlight is how many parts of an archive go up at once. One after
// another, a part was a round trip of 0.4-0.5 s through the outbound
// handler into R2 and an archive went up at about 18 MB/s, the longest
// step of a block once the encode had four cores (an ARPEGE block on
// 2026-10-08: 13.5 s for 242 MB), the Container's 2 Gbit/s link idle
// between parts. R2 takes a multipart upload's parts concurrently.
const PartsInFlight = 4

// HTTPStore speaks to the loxodrome-nwp Worker's outbound handler, which
// holds the R2 binding: the Container never sees a credential. GET and
// PUT of an object; a large one goes up in parts (POST ?uploads, PUT
// ?part=N&upload=ID, POST ?upload=ID with the parts).
type HTTPStore struct {
	Base     string // "http://r2.nwp"
	Client   *http.Client
	PartSize int64
	// InFlight is how many parts go up at once; PartsInFlight when 0.
	InFlight int
}

func (h HTTPStore) client() *http.Client {
	if h.Client != nil {
		return h.Client
	}
	return http.DefaultClient
}

func (h HTTPStore) url(key string, q url.Values) string {
	u := h.Base + "/" + key
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	return u
}

func (h HTTPStore) do(ctx context.Context, method, u string, body io.Reader, size int64, ct string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, u, body)
	if err != nil {
		return nil, err
	}
	if size >= 0 {
		req.ContentLength = size
	}
	if ct != "" {
		req.Header.Set("Content-Type", ct)
	}
	resp, err := h.client().Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode/100 != 2 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		resp.Body.Close()
		if resp.StatusCode == http.StatusNotFound && method == http.MethodGet {
			return nil, fs.ErrNotExist
		}
		return nil, &storeStatus{fmt.Sprintf("store %s %s: HTTP %d %s", method, u, resp.StatusCode, bytes.TrimSpace(b)), resp.StatusCode}
	}
	return resp, nil
}

// storeStatus is a refusal the store answered.
type storeStatus struct {
	msg    string
	status int
}

func (e *storeStatus) Error() string { return e.msg }

// storeAttempts and storeBackoff pace a write the store failed: a 5xx or
// a lost connection is asked again (1 s, 2 s, 4 s), a refusal (a 4xx: a
// key the handler will not take) is not. One transient failure of the
// receipt's PUT failed the block after its archive was stored, stopped the
// job and charged its later blocks an attempt; the parts' retries fired
// three times within 3 ms.
const storeAttempts = 4

var storeBackoff = func(attempt int) time.Duration { return time.Second << attempt }

func retried(ctx context.Context, fn func() error) error {
	var err error
	for attempt := 0; attempt < storeAttempts; attempt++ {
		if err = fn(); err == nil {
			return nil
		}
		var st *storeStatus
		if errors.As(err, &st) && st.status < 500 || ctx.Err() != nil {
			return err
		}
		if attempt+1 < storeAttempts {
			select {
			case <-time.After(storeBackoff(attempt)):
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	}
	return err
}

// Report hands a line to the Worker's own log through a bodiless GET, the
// last resort when the store will not take the job's log.
func (h HTTPStore) Report(ctx context.Context, msg string) {
	if len(msg) > 1500 {
		msg = msg[:1500]
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if r, err := h.do(ctx, http.MethodGet, h.url("__log", url.Values{"m": {msg}}), nil, -1, ""); err == nil {
		r.Body.Close()
	}
}

func (h HTTPStore) Get(ctx context.Context, key string) ([]byte, error) {
	resp, err := h.do(ctx, http.MethodGet, h.url(key, nil), nil, -1, "")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return io.ReadAll(resp.Body)
}

func (h HTTPStore) Put(ctx context.Context, key string, b []byte, ct string) error {
	return retried(ctx, func() error {
		resp, err := h.do(ctx, http.MethodPut, h.url(key, nil), bytes.NewReader(b), int64(len(b)), ct)
		if err != nil {
			return err
		}
		resp.Body.Close()
		return nil
	})
}

func (h HTTPStore) PutFile(ctx context.Context, key, path, ct string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return err
	}
	part := h.PartSize
	if part <= 0 {
		part = PartSize
	}
	if st.Size() <= part {
		return retried(ctx, func() error {
			resp, err := h.do(ctx, http.MethodPut, h.url(key, nil), io.NewSectionReader(f, 0, st.Size()), st.Size(), ct)
			if err != nil {
				return err
			}
			resp.Body.Close()
			return nil
		})
	}
	var start struct {
		UploadID string `json:"uploadId"`
	}
	err = retried(ctx, func() error {
		resp, err := h.do(ctx, http.MethodPost, h.url(key, url.Values{"uploads": {""}}), nil, 0, ct)
		if err != nil {
			return err
		}
		err = json.NewDecoder(resp.Body).Decode(&start)
		resp.Body.Close()
		if err != nil || start.UploadID == "" {
			return fmt.Errorf("store: multipart start for %s: %v", key, err)
		}
		return nil
	})
	if err != nil {
		return err
	}
	type part_ struct {
		PartNumber int    `json:"partNumber"`
		ETag       string `json:"etag"`
	}
	// Abandoned on a failure, whatever ended the job's context: the
	// bucket's lifecycle rule takes an upload left incomplete a day on.
	abort := func() {
		actx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer cancel()
		if r, err := h.do(actx, http.MethodDelete, h.url(key, url.Values{"upload": {start.UploadID}}), nil, 0, ""); err == nil {
			r.Body.Close()
		}
	}
	n := int((st.Size() + part - 1) / part)
	parts := make([]part_, n)
	inFlight := h.InFlight
	if inFlight <= 0 {
		inFlight = PartsInFlight
	}
	// The first part to fail ends the others: its error is the upload's,
	// and no part starts after it.
	pctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var (
		mu    sync.Mutex
		first error
		wg    sync.WaitGroup
	)
	fail := func(err error) {
		mu.Lock()
		if first == nil {
			first = err
		}
		mu.Unlock()
		cancel()
	}
	slots := make(chan struct{}, inFlight)
	for i := range n {
		select {
		case slots <- struct{}{}:
		case <-pctx.Done():
		}
		if pctx.Err() != nil {
			break
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() { <-slots }()
			num, off := i+1, int64(i)*part
			size := min(part, st.Size()-off)
			err := retried(pctx, func() error {
				q := url.Values{"part": {strconv.Itoa(num)}, "upload": {start.UploadID}}
				r, err := h.do(pctx, http.MethodPut, h.url(key, q), io.NewSectionReader(f, off, size), size, "")
				if err != nil {
					return err
				}
				var p part_
				err = json.NewDecoder(r.Body).Decode(&p)
				r.Body.Close()
				if err == nil && p.ETag == "" {
					err = errors.New("no etag")
				}
				parts[i] = part_{PartNumber: num, ETag: p.ETag}
				return err
			})
			if err != nil {
				fail(fmt.Errorf("store: part %d of %s: %w", num, key, err))
			}
		}()
	}
	// Every part ends before the upload is judged, the ones a failure
	// cancelled included: nothing writes after the return.
	wg.Wait()
	if first == nil && ctx.Err() != nil {
		first = fmt.Errorf("store: parts of %s: %w", key, ctx.Err())
	}
	if first != nil {
		abort()
		return first
	}
	body, _ := json.Marshal(map[string]any{"parts": parts})
	err = retried(ctx, func() error {
		resp, err := h.do(ctx, http.MethodPost, h.url(key, url.Values{"upload": {start.UploadID}}), bytes.NewReader(body), int64(len(body)), "application/json")
		if err != nil {
			return err
		}
		resp.Body.Close()
		return nil
	})
	if err != nil {
		abort()
		return err
	}
	return nil
}
