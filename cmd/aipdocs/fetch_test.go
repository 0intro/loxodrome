package main

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// The fetch goroutines call progress one at a time, so a callback keeping
// its own count, as assemble's does, needs no lock of its own. Run it
// under -race: the documents are all in the cache, so no request is made.
func TestAllProgressSerialised(t *testing.T) {
	dir := t.TempDir()
	var refs []docRef
	for i := range 50 {
		name := fmt.Sprintf("AD-2.LF%02d.pdf", i)
		if err := os.WriteFile(filepath.Join(dir, name), []byte("%PDF-1.4"), 0o644); err != nil {
			t.Fatal(err)
		}
		refs = append(refs, docRef{Name: name, URL: "http://127.0.0.1:0/" + name})
	}
	f := &fetcher{dir: dir, concurrency: 6}
	calls, last := 0, 0
	res := f.all(t.Context(), refs, func(done, total int) {
		calls++
		if done > last {
			last = done
		}
	})
	if err := firstError(res); err != nil {
		t.Fatal(err)
	}
	if calls != len(refs) || last != len(refs) {
		t.Errorf("progress called %d times, last at %d, want %d and %d", calls, last, len(refs), len(refs))
	}
}
