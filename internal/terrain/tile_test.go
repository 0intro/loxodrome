package terrain

import (
	"bytes"
	"compress/gzip"
	"flag"
	"io"
	"os"
	"testing"
)

// -update rewrites tests/fixtures/terrain-12-2125-1464.tile, the tile the
// TypeScript reader is pinned against (tests/terrainTile.spec.ts). The
// fixture is written by THIS writer on purpose: it is what makes the two
// halves of the format a cross-language pin rather than each side agreeing
// with itself.
//
//	go test ./internal/terrain -run TestFixture -update
var update = flag.Bool("update", false, "rewrite the shared tile fixture")

const (
	fixturePath = "../../tests/fixtures/terrain-12-2125-1464.tile"
	// The real Alpine grid tests/terrainCorridor.spec.ts already reads: the
	// ridge between Albertville and Bourg-Saint-Maurice, 1212 to 3550 m in
	// one tile. Building the fixture from it keeps the two fixtures the
	// same ground.
	sourcePath = "../../tests/fixtures/alpine-12-2125-1464.i16.gz"
)

// realGrid is the committed Alpine tile as metres.
func realGrid(t *testing.T) []int16 {
	t.Helper()
	f, err := os.Open(sourcePath)
	if err != nil {
		t.Fatalf("open %s: %v", sourcePath, err)
	}
	defer f.Close()
	zr, err := gzip.NewReader(f)
	if err != nil {
		t.Fatalf("gzip %s: %v", sourcePath, err)
	}
	raw, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("read %s: %v", sourcePath, err)
	}
	if len(raw) != Pixels*2 {
		t.Fatalf("%s is %d bytes, want %d", sourcePath, len(raw), Pixels*2)
	}
	return plane(raw)
}

// fixtureTile is the real grid as the mean band, with the extremes of each
// pixel's 3x3 neighbourhood standing in for the pooled bands, and a NoData
// patch so the sentinel is pinned across the language boundary too.
func fixtureTile(t *testing.T) *Tile {
	t.Helper()
	mean := realGrid(t)
	max := make([]int16, Pixels)
	min := make([]int16, Pixels)
	at := func(x, y int) int16 {
		if x < 0 {
			x = 0
		}
		if y < 0 {
			y = 0
		}
		if x >= Size {
			x = Size - 1
		}
		if y >= Size {
			y = Size - 1
		}
		return mean[y*Size+x]
	}
	for y := 0; y < Size; y++ {
		for x := 0; x < Size; x++ {
			hi, lo := at(x, y), at(x, y)
			for dy := -1; dy <= 1; dy++ {
				for dx := -1; dx <= 1; dx++ {
					v := at(x+dx, y+dy)
					if v > hi {
						hi = v
					}
					if v < lo {
						lo = v
					}
				}
			}
			max[y*Size+x] = hi
			min[y*Size+x] = lo
		}
	}
	// A 4x4 void at (10,10): every band reads back unknown there.
	for y := 10; y < 14; y++ {
		for x := 10; x < 14; x++ {
			mean[y*Size+x] = NoData
			max[y*Size+x] = NoData
			min[y*Size+x] = NoData
		}
	}
	return &Tile{Z: 12, X: 2125, Y: 1464, Mean: mean, Max: max, Min: min}
}

// The fixture is compared by PAYLOAD, not by file bytes. Go's DEFLATE output
// has changed between toolchain releases (the same tile is 110 606 bytes
// under go1.28-devel and 109 128 under go1.26.5), so a byte comparison would
// fail on any machine whose Go differs from the one that last wrote the
// fixture, while saying "stale" about a tile describing identical ground.
// What the TypeScript reader has to agree with is the content.
func TestFixtureIsCurrent(t *testing.T) {
	encoded, err := Encode(fixtureTile(t))
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if *update {
		if err := os.WriteFile(fixturePath, encoded, 0o644); err != nil {
			t.Fatalf("write %s: %v", fixturePath, err)
		}
		t.Logf("wrote %s (%d bytes)", fixturePath, len(encoded))
		return
	}
	stored, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatalf("read %s: %v (regenerate with: go test ./internal/terrain -run TestFixture -update)", fixturePath, err)
	}
	got, err := PayloadOf(stored)
	if err != nil {
		t.Fatalf("read %s: %v", fixturePath, err)
	}
	want, err := Payload(fixtureTile(t))
	if err != nil {
		t.Fatalf("payload: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("%s is stale; regenerate with: go test ./internal/terrain -run TestFixture -update", fixturePath)
	}
}

// The claim the receipts rest on, stated where the format is: the same ground
// yields the same payload, whatever the stored bytes look like.
func TestPayloadIsTheTilesIdentity(t *testing.T) {
	tile := fixtureTile(t)
	a, err := Payload(tile)
	if err != nil {
		t.Fatal(err)
	}
	enc, err := Encode(tile)
	if err != nil {
		t.Fatal(err)
	}
	b, err := PayloadOf(enc)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(a, b) {
		t.Fatal("a tile's payload does not survive its own encoding")
	}
	// And a fixture written by a DIFFERENT compressor still reads as the same
	// tile, which is exactly the toolchain case.
	var loose bytes.Buffer
	zw, err := gzip.NewWriterLevel(&loose, gzip.NoCompression)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := zw.Write(a); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(loose.Bytes(), enc) {
		t.Fatal("the two compressions produced identical bytes; the test proves nothing")
	}
	c, err := PayloadOf(loose.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(a, c) {
		t.Fatal("the same tile stored under another compression read as different content")
	}
}

func TestRoundTripThreeBands(t *testing.T) {
	in := fixtureTile(t)
	b, err := Encode(in)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	out, err := Decode(b)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.Z != in.Z || out.X != in.X || out.Y != in.Y {
		t.Fatalf("address z%d/%d/%d, want z%d/%d/%d", out.Z, out.X, out.Y, in.Z, in.X, in.Y)
	}
	for i := range in.Mean {
		if out.Mean[i] != in.Mean[i] || out.Max[i] != in.Max[i] || out.Min[i] != in.Min[i] {
			t.Fatalf("pixel %d: got %d/%d/%d, want %d/%d/%d", i,
				out.Min[i], out.Mean[i], out.Max[i], in.Min[i], in.Mean[i], in.Max[i])
		}
	}
}

func TestRoundTripOneBand(t *testing.T) {
	in := &Tile{Z: 9, X: 1, Y: 2, Mean: realGrid(t)}
	if in.Bands() != 1 {
		t.Fatalf("bands %d, want 1", in.Bands())
	}
	b, err := Encode(in)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	out, err := Decode(b)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.Max != nil || out.Min != nil {
		t.Fatal("a single-band tile must read back with no extremes")
	}
	for i := range in.Mean {
		if out.Mean[i] != in.Mean[i] {
			t.Fatalf("pixel %d: got %d, want %d", i, out.Mean[i], in.Mean[i])
		}
	}
}

func TestNoDataSurvivesEveryBand(t *testing.T) {
	out, err := Decode(mustEncode(t, fixtureTile(t)))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	i := 10*Size + 10
	if out.Mean[i] != NoData || out.Max[i] != NoData || out.Min[i] != NoData {
		t.Fatalf("void pixel read back %d/%d/%d, want the sentinel on every band",
			out.Min[i], out.Mean[i], out.Max[i])
	}
	// Its neighbour is ordinary ground, so the sentinel is a value and not a
	// region: the row delta crosses it and comes back.
	j := 10*Size + 14
	if out.Mean[j] == NoData {
		t.Fatal("the pixel after the void must be ground")
	}
}

func TestExtremesBracketTheMean(t *testing.T) {
	out, err := Decode(mustEncode(t, fixtureTile(t)))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	for i, m := range out.Mean {
		if m == NoData {
			continue
		}
		if out.Min[i] > m || out.Max[i] < m {
			t.Fatalf("pixel %d: %d..%d does not bracket %d", i, out.Min[i], out.Max[i], m)
		}
	}
}

func TestEncodeIsDeterministic(t *testing.T) {
	a := mustEncode(t, fixtureTile(t))
	b := mustEncode(t, fixtureTile(t))
	if !bytes.Equal(a, b) {
		t.Fatal("two encodes of the same grid differ; the object's ETag would roll on every build")
	}
}

func TestCodingBeatsTheRawGrid(t *testing.T) {
	// A deliberately hard case: the bands here are the extremes of each
	// pixel's 3x3 neighbourhood at NATIVE resolution over Alpine ground, so
	// the residuals carry a whole pixel of slope and barely correlate. A real
	// pooled level, where the extremes come from four children, measured
	// about 16 KB for the same three bands.
	b := mustEncode(t, fixtureTile(t))
	raw := 3 * Pixels * 2
	if len(b) >= raw/2 {
		t.Fatalf("three bands came to %d bytes against %d raw; "+
			"the residual and delta coding is not working", len(b), raw)
	}
}

func TestDecodeRefusesWhatItCannotAccountFor(t *testing.T) {
	good := mustEncode(t, fixtureTile(t))
	cases := []struct {
		name string
		body []byte
	}{
		{"empty", nil},
		{"not gzip", []byte("LOXTERR1 and then some")},
		{"truncated gzip", good[:len(good)/2]},
		{"wrong magic", regzip(t, func(b []byte) { copy(b, "LOXDOCS1") }, good)},
		{"impossible band count", regzip(t, func(b []byte) { b[9] = 2 }, good)},
		{"short body", regzip(t, func(b []byte) {}, good, true)},
	}
	for _, c := range cases {
		if _, err := Decode(c.body); err == nil {
			t.Errorf("%s: decoded without error", c.name)
		}
	}
}

func mustEncode(t *testing.T, tile *Tile) []byte {
	t.Helper()
	b, err := Encode(tile)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	return b
}

// regzip inflates an encoded tile, lets fn corrupt the plain bytes, and
// deflates it again, optionally truncating the body so the length check
// fires rather than the magic.
func regzip(t *testing.T, fn func([]byte), enc []byte, truncate ...bool) []byte {
	t.Helper()
	zr, err := gzip.NewReader(bytes.NewReader(enc))
	if err != nil {
		t.Fatalf("gzip: %v", err)
	}
	raw, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("gzip: %v", err)
	}
	fn(raw)
	if len(truncate) > 0 && truncate[0] {
		raw = raw[:HeaderSize+100]
	}
	var out bytes.Buffer
	zw := gzip.NewWriter(&out)
	if _, err := zw.Write(raw); err != nil {
		t.Fatalf("gzip: %v", err)
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("gzip: %v", err)
	}
	return out.Bytes()
}
