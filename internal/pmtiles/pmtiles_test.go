package pmtiles

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"math/rand/v2"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestZxyToIDSpecTable(t *testing.T) {
	// The table in the v3 spec, section 4.1.
	for _, c := range []struct {
		z    uint8
		x, y uint32
		id   uint64
	}{
		{0, 0, 0, 0},
		{1, 0, 0, 1},
		{1, 0, 1, 2},
		{1, 1, 1, 3},
		{1, 1, 0, 4},
		{2, 0, 0, 5},
		{12, 3423, 1763, 19078479},
	} {
		if got := ZxyToID(c.z, c.x, c.y); got != c.id {
			t.Errorf("ZxyToID(%d,%d,%d) = %d, want %d", c.z, c.x, c.y, got, c.id)
		}
		if z, x, y := IDToZxy(c.id); z != c.z || x != c.x || y != c.y {
			t.Errorf("IDToZxy(%d) = %d/%d/%d", c.id, z, x, y)
		}
	}
}

func TestTileIDRoundTrip(t *testing.T) {
	r := rand.New(rand.NewPCG(1, 2))
	for z := uint8(0); z <= 20; z++ {
		n := uint32(1) << z
		for range 200 {
			x, y := r.Uint32N(n), r.Uint32N(n)
			if gz, gx, gy := IDToZxy(ZxyToID(z, x, y)); gz != z || gx != x || gy != y {
				t.Fatalf("%d/%d/%d round-trips to %d/%d/%d", z, x, y, gz, gx, gy)
			}
		}
	}
}

func TestEntriesEncodingVector(t *testing.T) {
	got := encodeEntries([]Entry{
		{TileID: 0, Offset: 0, Length: 10, RunLength: 1},
		{TileID: 1, Offset: 10, Length: 5, RunLength: 2},
		{TileID: 5, Offset: 0, Length: 10, RunLength: 1},
	})
	want := []byte{3, 0, 1, 4, 1, 2, 1, 10, 5, 10, 1, 0, 1}
	if !bytes.Equal(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestFirstEntryOffsetNeverZero(t *testing.T) {
	// A directory that is not the first (a leaf) starting at offset 0 of the
	// tile data, and one starting contiguous with nothing: both first
	// offsets must be written as offset+1.
	for _, first := range []Entry{
		{TileID: 7, Offset: 0, Length: 3, RunLength: 1},
		{TileID: 9, Offset: 12, Length: 3, RunLength: 1},
	} {
		// count, id delta, run length, length, offset+1
		want := []byte{1, byte(first.TileID), 1, 3, byte(first.Offset + 1)}
		if got := encodeEntries([]Entry{first}); !bytes.Equal(got, want) {
			t.Fatalf("encoded %v, want %v", got, want)
		}
	}
}

func TestEntriesRoundTrip(t *testing.T) {
	r := rand.New(rand.NewPCG(3, 4))
	var entries []Entry
	var id, off uint64
	for range 3000 {
		id += 1 + r.Uint64N(5)
		run := uint32(1 + r.IntN(3))
		length := uint32(1 + r.IntN(900))
		if r.IntN(4) == 0 && off > 0 {
			entries = append(entries, Entry{TileID: id, Offset: r.Uint64N(off), Length: length, RunLength: run})
		} else {
			entries = append(entries, Entry{TileID: id, Offset: off, Length: length, RunLength: run})
			off += uint64(length)
		}
		id += uint64(run)
	}
	got, err := decodeEntries(gzipBytes(encodeEntries(entries)))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != len(entries) {
		t.Fatalf("%d entries, want %d", len(got), len(entries))
	}
	for i := range got {
		if got[i] != entries[i] {
			t.Fatalf("entry %d: %+v, want %+v", i, got[i], entries[i])
		}
	}
}

func TestHeaderByteLayout(t *testing.T) {
	h := Header{
		RootOffset: 127, RootLength: 0x0102,
		MetadataOffset: 0x0203, MetadataLength: 0x0304,
		LeafOffset: 0x0405, LeafLength: 0x0506,
		DataOffset: 0x0607, DataLength: 0x0708,
		AddressedTiles: 9, TileEntries: 8, TileContents: 7,
		Clustered: true, InternalCompression: CompressionGzip, TileCompression: CompressionNone,
		TileType: TileTypeWebP, MinZoom: 0, MaxZoom: 13,
		MinLonE7: E7(-63.2), MinLatE7: E7(-21.45), MaxLonE7: E7(55.9), MaxLatE7: E7(51.2),
		CenterZoom: 6, CenterLonE7: E7(2.5), CenterLatE7: E7(46.6),
	}
	b := h.marshal()
	if len(b) != HeaderLen || string(b[:7]) != "PMTiles" || b[7] != 3 {
		t.Fatalf("magic/version % x", b[:8])
	}
	le := binary.LittleEndian
	if le.Uint64(b[16:]) != 0x0102 || le.Uint64(b[64:]) != 0x0708 || le.Uint64(b[88:]) != 7 {
		t.Fatal("u64 fields misplaced")
	}
	if b[96] != 1 || b[97] != 2 || b[98] != 1 || b[99] != 4 || b[100] != 0 || b[101] != 13 || b[118] != 6 {
		t.Fatalf("byte fields % x", b[96:102])
	}
	if int32(le.Uint32(b[102:])) != -632000000 || int32(le.Uint32(b[114:])) != 512000000 {
		t.Fatal("E7 positions misplaced")
	}
	back, err := parseHeader(b)
	if err != nil || back != h {
		t.Fatalf("round trip: %+v, %v", back, err)
	}
}

// archive writes tiles (id -> bytes, ids ascending) and opens the result.
func archive(t *testing.T, opts Options, ids []uint64, data func(uint64) []byte) (*Reader, []byte, Header) {
	t.Helper()
	spool, err := os.CreateTemp(t.TempDir(), "spool")
	if err != nil {
		t.Fatal(err)
	}
	defer spool.Close()
	w := NewWriter(spool, opts)
	for _, id := range ids {
		if err := w.Add(id, data(id)); err != nil {
			t.Fatal(err)
		}
	}
	var out bytes.Buffer
	h, err := w.Finish(&out, map[string]any{"name": "test", "version": "2026-10-01"})
	if err != nil {
		t.Fatal(err)
	}
	rd, err := Open(bytes.NewReader(out.Bytes()), int64(out.Len()))
	if err != nil {
		t.Fatal(err)
	}
	if err := Verify(rd); err != nil {
		t.Fatalf("Verify: %v", err)
	}
	return rd, out.Bytes(), h
}

var testOpts = Options{
	TileType: TileTypeWebP,
	Bounds:   [4]float64{-5, 41, 10, 51},
	Center:   [2]float64{2.5, 46.6},
}

func seq(from, to uint64) []uint64 {
	var out []uint64
	for i := from; i <= to; i++ {
		out = append(out, i)
	}
	return out
}

func TestWriterRunLengthAndDedup(t *testing.T) {
	// Tiles 1-4 identical (one run), 5 different, 6 the same as 1-4 but
	// after a different tile (a back-reference, not a run), 9 again new.
	content := map[uint64][]byte{
		1: []byte("sea"), 2: []byte("sea"), 3: []byte("sea"), 4: []byte("sea"),
		5: []byte("land"), 6: []byte("sea"), 9: []byte("coast"),
	}
	ids := []uint64{1, 2, 3, 4, 5, 6, 9}
	rd, _, h := archive(t, Options{TileType: TileTypeWebP, Bounds: testOpts.Bounds, Center: testOpts.Center, CenterZoom: 1},
		ids, func(id uint64) []byte { return content[id] })
	if h.AddressedTiles != 7 || h.TileEntries != 4 || h.TileContents != 3 {
		t.Fatalf("addressed %d entries %d contents %d, want 7 4 3", h.AddressedTiles, h.TileEntries, h.TileContents)
	}
	if h.DataLength != uint64(len("sea")+len("land")+len("coast")) {
		t.Fatalf("data length %d", h.DataLength)
	}
	var entries []Entry
	_ = rd.Walk(func(e Entry) error { entries = append(entries, e); return nil })
	if entries[0].RunLength != 4 || entries[2].Offset != entries[0].Offset {
		t.Fatalf("entries %+v", entries)
	}
	for _, id := range ids {
		z, x, y := IDToZxy(id)
		got, err := rd.Get(z, x, y)
		if err != nil || !bytes.Equal(got, content[id]) {
			t.Fatalf("tile %d: %q, %v", id, got, err)
		}
	}
	// Tiles the archive does not hold.
	for _, id := range []uint64{0, 7, 8, 10, 100} {
		z, x, y := IDToZxy(id)
		if got, err := rd.Get(z, x, y); got != nil || err != nil {
			t.Fatalf("tile %d: %q, %v", id, got, err)
		}
	}
}

func TestWriterRejects(t *testing.T) {
	newW := func() *Writer {
		spool, err := os.CreateTemp(t.TempDir(), "spool")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { spool.Close() })
		return NewWriter(spool, testOpts)
	}
	w := newW()
	if err := w.Add(5, []byte("a")); err != nil {
		t.Fatal(err)
	}
	if err := w.Add(5, []byte("b")); err == nil {
		t.Error("a duplicate id was accepted")
	}
	if err := w.Add(4, []byte("b")); err == nil {
		t.Error("an id out of order was accepted")
	}
	if err := w.Add(6, nil); err == nil {
		t.Error("an empty tile was accepted")
	}
	// A run covers its ids: after 7-8 identical, 8 again is out of order.
	w = newW()
	_ = w.Add(7, []byte("x"))
	_ = w.Add(8, []byte("x"))
	if err := w.Add(8, []byte("y")); err == nil {
		t.Error("an id inside the previous run was accepted")
	}
	if _, err := newW().Finish(&bytes.Buffer{}, map[string]any{}); err == nil {
		t.Error("an archive with no tiles was finished")
	}
	w = newW()
	_ = w.Add(0, []byte("x"))
	if _, err := w.Finish(&bytes.Buffer{}, []int{1}); err == nil {
		t.Error("metadata that is not an object was accepted")
	}
	w = newW()
	_ = w.Add(0, []byte("x"))
	if _, err := w.Finish(&bytes.Buffer{}, map[string]any{}); err != nil {
		t.Fatal(err)
	}
	if err := w.Add(1, []byte("y")); err == nil {
		t.Error("Add after Finish was accepted")
	}
}

func TestRootOnlySmallArchive(t *testing.T) {
	_, _, h := archive(t, testOpts, seq(0, 340), func(id uint64) []byte { return []byte(fmt.Sprint(id)) })
	if h.LeafLength != 0 || h.LeafOffset == 0 {
		t.Fatalf("leaf offset %d length %d, want a root-only archive with a non-zero offset", h.LeafOffset, h.LeafLength)
	}
}

func TestLeavesWhenRootOverflows(t *testing.T) {
	// More entries than a root may list: distinct contents so nothing merges.
	ids := seq(0, 20000)
	rd, _, h := archive(t, Options{TileType: TileTypeWebP, Bounds: testOpts.Bounds, Center: testOpts.Center, CenterZoom: 3},
		ids, func(id uint64) []byte { return []byte(fmt.Sprintf("t%d", id)) })
	if h.LeafLength == 0 {
		t.Fatal("no leaves for 20001 entries")
	}
	if h.RootOffset+h.RootLength > rootLimit {
		t.Fatalf("root ends at %d", h.RootOffset+h.RootLength)
	}
	for _, id := range []uint64{0, 1, 4095, 4096, 12345, 20000} {
		z, x, y := IDToZxy(id)
		got, err := rd.Get(z, x, y)
		if err != nil || string(got) != fmt.Sprintf("t%d", id) {
			t.Fatalf("tile %d: %q, %v", id, got, err)
		}
	}
}

func TestForcedLeafSize(t *testing.T) {
	rd, _, h := archive(t, Options{TileType: TileTypeWebP, Bounds: testOpts.Bounds, Center: testOpts.Center, CenterZoom: 1, LeafSize: 3},
		seq(1, 10), func(id uint64) []byte { return []byte(fmt.Sprintf("t%d", id)) })
	if h.LeafLength == 0 {
		t.Fatal("LeafSize 3 made no leaves")
	}
	n := 0
	for _, e := range rd.root {
		if e.RunLength != 0 {
			t.Fatal("a tile entry in a root of leaf pointers")
		}
		n++
	}
	if n != 4 {
		t.Fatalf("%d leaves, want 4 (3+3+3+1)", n)
	}
	for id := uint64(1); id <= 10; id++ {
		z, x, y := IDToZxy(id)
		if got, _ := rd.Get(z, x, y); string(got) != fmt.Sprintf("t%d", id) {
			t.Fatalf("tile %d: %q", id, got)
		}
	}
}

func TestMinMaxZoomFromEntries(t *testing.T) {
	ids := []uint64{ZxyToID(5, 3, 3), ZxyToID(6, 7, 7), ZxyToID(8, 1, 2)}
	for i := range ids {
		for j := i + 1; j < len(ids); j++ {
			if ids[j] < ids[i] {
				ids[i], ids[j] = ids[j], ids[i]
			}
		}
	}
	_, _, h := archive(t, Options{TileType: TileTypeWebP, Bounds: testOpts.Bounds, Center: testOpts.Center, CenterZoom: 6},
		ids, func(id uint64) []byte { return []byte(fmt.Sprint(id)) })
	if h.MinZoom != 5 || h.MaxZoom != 8 {
		t.Fatalf("zooms %d..%d, want 5..8", h.MinZoom, h.MaxZoom)
	}
}

func TestCenterZoomOutsideRefused(t *testing.T) {
	spool, _ := os.CreateTemp(t.TempDir(), "spool")
	defer spool.Close()
	w := NewWriter(spool, Options{TileType: TileTypeWebP, Bounds: testOpts.Bounds, CenterZoom: 9})
	_ = w.Add(ZxyToID(2, 1, 1), []byte("x"))
	if _, err := w.Finish(&bytes.Buffer{}, map[string]any{}); err == nil {
		t.Fatal("a center zoom outside the archive was accepted")
	}
}

func TestMetadataIsGzipJSONObject(t *testing.T) {
	rd, _, _ := archive(t, testOpts, seq(0, 4), func(id uint64) []byte { return []byte("x") })
	var meta map[string]any
	if err := rd.Metadata(&meta); err != nil {
		t.Fatal(err)
	}
	if meta["name"] != "test" || meta["version"] != "2026-10-01" {
		t.Fatalf("metadata %v", meta)
	}
}

func TestWriteIsDeterministic(t *testing.T) {
	data := func(id uint64) []byte { return []byte(fmt.Sprintf("t%d", id%37)) }
	_, a, _ := archive(t, Options{TileType: TileTypeWebP, Bounds: testOpts.Bounds, Center: testOpts.Center, CenterZoom: 3, LeafSize: 50}, seq(0, 1000), data)
	_, b, _ := archive(t, Options{TileType: TileTypeWebP, Bounds: testOpts.Bounds, Center: testOpts.Center, CenterZoom: 3, LeafSize: 50}, seq(0, 1000), data)
	if !bytes.Equal(a, b) {
		t.Fatal("the same tiles gave different bytes")
	}
}

func TestVerifyCatchesCorruption(t *testing.T) {
	_, good, _ := archive(t, Options{TileType: TileTypeWebP, Bounds: testOpts.Bounds, Center: testOpts.Center, CenterZoom: 2}, seq(0, 50),
		func(id uint64) []byte { return []byte(fmt.Sprintf("t%d", id%7)) })
	cases := map[string]func([]byte) []byte{
		"truncated data": func(b []byte) []byte { return b[:len(b)-1] },
		"wrong entry count": func(b []byte) []byte {
			binary.LittleEndian.PutUint64(b[80:], binary.LittleEndian.Uint64(b[80:])+1)
			return b
		},
		"wrong max zoom":   func(b []byte) []byte { b[101]++; return b },
		"leaf offset zero": func(b []byte) []byte { binary.LittleEndian.PutUint64(b[40:], 0); return b },
		"bounds flipped": func(b []byte) []byte {
			copy(b[102:110], b[110:118])
			return b
		},
	}
	for name, corrupt := range cases {
		b := corrupt(append([]byte(nil), good...))
		rd, err := Open(bytes.NewReader(b), int64(len(b)))
		if err == nil {
			err = Verify(rd)
		}
		if err == nil {
			t.Errorf("%s: not caught", name)
		}
	}
}

func TestReaderReadsGoPmtilesFixture(t *testing.T) {
	// tests/fixtures/mini.pmtiles was written by go-pmtiles, not by this
	// package: reading it checks the reader against the reference writer.
	b, err := os.ReadFile(filepath.Join("..", "..", "tests", "fixtures", "mini.pmtiles"))
	if err != nil {
		t.Fatal(err)
	}
	rd, err := Open(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		t.Fatal(err)
	}
	if h := rd.Header(); h.TileType != TileTypePNG || h.MinZoom != 0 || h.MaxZoom != 1 {
		t.Fatalf("header %+v", h)
	}
	t0, err := rd.Get(0, 0, 0)
	if err != nil || len(t0) == 0 {
		t.Fatalf("0/0/0: %d bytes, %v", len(t0), err)
	}
	if miss, _ := rd.Get(1, 0, 1); miss != nil {
		t.Fatal("1/0/1 should be absent")
	}
}

// TestGoPmtilesAgrees runs go-pmtiles' own verify and show on an archive
// written here, when PMTILES_CLI points at the binary (a development check;
// CI has no copy).
func TestGoPmtilesAgrees(t *testing.T) {
	cli := os.Getenv("PMTILES_CLI")
	if cli == "" {
		t.Skip("PMTILES_CLI unset")
	}
	_, b, _ := archive(t, Options{TileType: TileTypeWebP, Bounds: testOpts.Bounds, Center: testOpts.Center, CenterZoom: 6, LeafSize: 100},
		seq(ZxyToID(6, 0, 0), ZxyToID(6, 0, 0)+1500), func(id uint64) []byte { return []byte(fmt.Sprintf("t%d", id%101)) })
	path := filepath.Join(t.TempDir(), "a.pmtiles")
	if err := os.WriteFile(path, b, 0o644); err != nil {
		t.Fatal(err)
	}
	for _, cmd := range [][]string{{"verify", path}, {"show", path}} {
		out, err := exec.Command(cli, cmd...).CombinedOutput()
		if err != nil {
			t.Fatalf("go-pmtiles %s: %v\n%s", cmd[0], err, out)
		}
		if cmd[0] == "show" && !strings.Contains(string(out), "tile type: webp") {
			t.Fatalf("show:\n%s", out)
		}
	}
}
