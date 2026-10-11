package docpack

import (
	"bytes"
	"flag"
	"os"
	"path/filepath"
	"testing"
)

// -update rewrites tests/fixtures/mini-docs.pack, the two-entry pack the
// TypeScript reader is pinned against (tests/aipDocs.spec.ts). The fixture
// is written by THIS writer on purpose: it is what makes the two halves of
// the format a cross-language pin rather than each side agreeing with
// itself.
//
//	go test ./internal/docpack -run TestFixture -update
var update = flag.Bool("update", false, "rewrite the shared pack fixture")

const fixturePath = "../../tests/fixtures/mini-docs.pack"

func TestFixtureIsCurrent(t *testing.T) {
	docs := map[string]string{
		"AD-2.LFPN.pdf":  "%PDF-1.4\n% mini plate LFPN\n%%EOF\n",
		"AD-3.LF075.pdf": "%PDF-1.4\n% mini helistation plate\n%%EOF\n",
	}
	meta := Meta{
		Set:       "fr-vac",
		Cycle:     "06_AUG_2026",
		Effective: "2026-08-06",
		Missing:   []string{"AD-2.LFZZ.pdf"},
	}
	var buf bytes.Buffer
	if err := Write(&buf, meta, writeDocs(t, docs)); err != nil {
		t.Fatal(err)
	}
	if *update {
		if err := os.WriteFile(fixturePath, buf.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("wrote %s (%d bytes)", fixturePath, buf.Len())
		return
	}
	have, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatalf("%v (regenerate with: go test ./internal/docpack -run TestFixture -update)", err)
	}
	if !bytes.Equal(have, buf.Bytes()) {
		t.Errorf("%s is stale; regenerate with: go test ./internal/docpack -run TestFixture -update", fixturePath)
	}
}

// writeDocs drops n named files with distinct contents and returns them in
// an order deliberately NOT sorted, so a test that gets its bytes back in
// name order proves Write sorted them rather than luck.
func writeDocs(t *testing.T, contents map[string]string) []Doc {
	t.Helper()
	dir := t.TempDir()
	var docs []Doc
	for name, body := range contents {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		docs = append(docs, Doc{Name: name, Path: path})
	}
	return docs
}

func TestWriteReadRoundTrip(t *testing.T) {
	contents := map[string]string{
		"AD-2.LFPN.pdf":  "%PDF-1.4 lfpn",
		"AD-2.LFPG.pdf":  "%PDF-1.4 lfpg body is longer",
		"AD-3.LF075.pdf": "%PDF-1.4 heliport",
	}
	meta := Meta{
		Set:       "fr-vac",
		Cycle:     "06_AUG_2026",
		Effective: "2026-08-06",
		Missing:   []string{"AD-3.LF999.pdf"},
	}

	var buf bytes.Buffer
	if err := Write(&buf, meta, writeDocs(t, contents)); err != nil {
		t.Fatalf("Write: %v", err)
	}

	packed := buf.Bytes()
	index, base, err := ReadIndex(bytes.NewReader(packed))
	if err != nil {
		t.Fatalf("ReadIndex: %v", err)
	}
	if index.Set != "fr-vac" || index.Cycle != "06_AUG_2026" || index.Effective != "2026-08-06" {
		t.Errorf("meta round trip: %+v", index.Meta)
	}
	if len(index.Missing) != 1 || index.Missing[0] != "AD-3.LF999.pdf" {
		t.Errorf("missing round trip: %v", index.Missing)
	}
	if len(index.Entries) != len(contents) {
		t.Fatalf("entries = %d, want %d", len(index.Entries), len(contents))
	}

	// Every document slices back byte-exact at base + offset.
	for name, want := range contents {
		e, ok := index.Entries[name]
		if !ok {
			t.Fatalf("entry %s missing", name)
		}
		got := packed[base+e.Offset : base+e.Offset+e.Length]
		if string(got) != want {
			t.Errorf("%s = %q, want %q", name, got, want)
		}
	}

	// The payload area is exactly the documents, no padding and no gaps.
	var total int64
	for _, e := range index.Entries {
		total += e.Length
	}
	if int64(len(packed)) != base+total {
		t.Errorf("pack is %d bytes, want %d", len(packed), base+total)
	}
}

// The pack's ETag is what tells a user an update is waiting, so identical
// inputs have to produce identical bytes. A build stamp in the index, or an
// unsorted entry order, would announce an update on every rebuild.
func TestWriteIsDeterministic(t *testing.T) {
	contents := map[string]string{
		"b.pdf": "%PDF bravo",
		"a.pdf": "%PDF alpha",
		"c.pdf": "%PDF charlie",
	}
	meta := Meta{Set: "fr-sup", Lang: "fr"}

	var first, second bytes.Buffer
	if err := Write(&first, meta, writeDocs(t, contents)); err != nil {
		t.Fatal(err)
	}
	if err := Write(&second, meta, writeDocs(t, contents)); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(first.Bytes(), second.Bytes()) {
		t.Error("two builds of the same input differ")
	}

	// Sorted order is part of the guarantee: alpha precedes bravo in the
	// payload area whatever order the caller handed them over in.
	index, base, err := ReadIndex(bytes.NewReader(first.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	if index.Entries["a.pdf"].Offset != 0 {
		t.Errorf("a.pdf at offset %d, want 0", index.Entries["a.pdf"].Offset)
	}
	if got := index.Entries["b.pdf"].Offset; got != index.Entries["a.pdf"].Length {
		t.Errorf("b.pdf at offset %d, want %d", got, index.Entries["a.pdf"].Length)
	}
	if base <= int64(HeaderSize) {
		t.Errorf("payload base %d does not clear the header", base)
	}
}

func TestReadIndexRejectsGarbage(t *testing.T) {
	cases := map[string][]byte{
		"empty":        {},
		"short header": []byte("LOX"),
		"bad magic":    append([]byte("NOTAPACK"), 0x10, 0, 0, 0),
		"zero index":   append([]byte(Magic), 0, 0, 0, 0),
		"huge index":   append([]byte(Magic), 0xff, 0xff, 0xff, 0xff),
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			if _, _, err := ReadIndex(bytes.NewReader(body)); err == nil {
				t.Error("want an error, got none")
			}
		})
	}
}

// An empty set still produces a readable pack: the SIA can retire every
// supplement of a region, and a pack with no entries must not read as a
// corrupt one.
func TestWriteEmptySet(t *testing.T) {
	var buf bytes.Buffer
	if err := Write(&buf, Meta{Set: "fr-sup", Lang: "en"}, nil); err != nil {
		t.Fatalf("Write: %v", err)
	}
	index, base, err := ReadIndex(bytes.NewReader(buf.Bytes()))
	if err != nil {
		t.Fatalf("ReadIndex: %v", err)
	}
	if len(index.Entries) != 0 {
		t.Errorf("entries = %d, want 0", len(index.Entries))
	}
	if int64(buf.Len()) != base {
		t.Errorf("pack is %d bytes, want %d (head only)", buf.Len(), base)
	}
}
