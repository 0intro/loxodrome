// Package terrain reads and writes the elevation tile the application
// samples the ground from: one 256x256 grid of metres per band, at a slippy
// z/x/y address, with the same reader written twice (here and in
// src/lib/map/terrainTile.ts) and pinned against a fixture this writer
// produced.
//
// The shape exists because the app asks the ground two different questions
// and a single value answers only one of them. "How high is the ground under
// me" wants the value at a point; "how high does it get around me" wants the
// extremes of a footprint, which is what the minimum-altitude corridor, the
// drawn profile and every AGL limit read (docs/vertical-limits.md). So a tile
// carries up to three bands, and a coarse tile carries the POOLED extremes of
// everything beneath it, which is what lets a corridor be answered exactly
// from a handful of coarse tiles instead of hundreds of fine ones.
//
//	0  : magic "LOXTERR1"        8 bytes
//	8  : zoom, uint8             1 byte
//	9  : bands, uint8            1 byte   1 = mean only, 3 = mean, max, min
//	10 : reserved                2 bytes  zero
//	12 : x, uint32 LE            4 bytes
//	16 : y, uint32 LE            4 bytes
//	20 : mean plane              Size*Size int16 LE
//	   : max - mean plane        (bands == 3)
//	   : mean - min plane        (bands == 3)
//
// The address is in the tile because an object fetched by URL should be able
// to say what it is: a misrouted or misfiled tile is then a decode error
// rather than terrain in the wrong place.
//
// The two upper bands are stored as RESIDUALS against the mean, and every
// plane is row-delta coded before compression, both because they shrink what
// the pilot downloads: measured over 60 real Alpine tiles, 101 KB of
// terrain-RGB PNG becomes 20 KB. Deltas are computed in wrapping int16
// arithmetic, so the NoData sentinel needs no special case on either side.
//
// The bytes are gzip, and the object is served as opaque bytes rather than
// with Content-Encoding, so the client keeps the COMPRESSED form: what the
// offline pin stores and what the service worker caches is 20 KB a tile and
// not the 128 KiB the browser would have handed back after decoding it for
// us. The client decompresses with DecompressionStream, which every target
// has; brotli would be 15 % smaller and is in neither the Go standard
// library nor DecompressionStream.
//
// A tile is byte-deterministic for a given grid: nothing in it records when
// it was built. A build stamp would roll the object's ETag on every run and
// tell every user an update was waiting for a tile identical to the one they
// hold.
package terrain

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"fmt"
	"io"
)

// Magic opens every tile, and is what tells a truncated or misrouted
// download from a real one before any plane is trusted.
const Magic = "LOXTERR1"

// Size is the tile edge in pixels, the slippy convention the whole app
// already projects in (map/terrain.ts TILE_SIZE).
const Size = 256

// HeaderSize is the magic, the zoom, the band count, the padding and the
// two coordinates.
const HeaderSize = len(Magic) + 1 + 1 + 2 + 4 + 4

// Pixels is the count in one band.
const Pixels = Size * Size

// NoData marks a pixel no source covered. It is a SENTINEL and not a low
// value on purpose: a void that reads as an elevation is a void that reads
// as ground, and a void in the Alps reading 0 m AMSL under a live aircraft
// would report the whole altitude as height above ground. Readers hand it
// back as "unknown" and every consumer already has that path.
const NoData int16 = -32768

// MaxCompressedBytes bounds what a reader will inflate, so a corrupt or
// hostile body cannot make it allocate wildly. Three bands come to 384 KiB
// raw; the cap is an order of magnitude above the worst tile measured.
const MaxCompressedBytes = 4 << 20

// Tile is one addressed grid. Mean is the value at the pixel, Max and Min
// the extremes of everything the pixel covers; a tile whose source has one
// value per pixel carries Mean alone and reads back with Max and Min nil.
type Tile struct {
	Z    int
	X    int
	Y    int
	Mean []int16
	Max  []int16
	Min  []int16
}

// Bands is 3 when the tile carries pooled extremes, else 1.
func (t *Tile) Bands() int {
	if t.Max != nil && t.Min != nil {
		return 3
	}
	return 1
}

// rowDelta replaces each row with its first value and the differences that
// follow, in place. Wrapping arithmetic, so a row crossing the NoData
// sentinel round-trips like any other.
func rowDelta(p []int16) {
	for r := 0; r < Size; r++ {
		row := p[r*Size : (r+1)*Size]
		for i := Size - 1; i > 0; i-- {
			row[i] = int16(uint16(row[i]) - uint16(row[i-1]))
		}
	}
}

// rowUndelta is its inverse.
func rowUndelta(p []int16) {
	for r := 0; r < Size; r++ {
		row := p[r*Size : (r+1)*Size]
		for i := 1; i < Size; i++ {
			row[i] = int16(uint16(row[i]) + uint16(row[i-1]))
		}
	}
}

// residual stores a band as its distance from the mean, hi - lo, which is
// max - mean above and mean - min below: both non-negative and small. Where
// the mean itself is unknown it stores zero, so the sentinel is carried once
// rather than three times (a pixel with no data has no extremes either).
func residual(hi, lo, mean []int16) []int16 {
	out := make([]int16, Pixels)
	for i, m := range mean {
		if m == NoData {
			continue
		}
		out[i] = int16(uint16(hi[i]) - uint16(lo[i]))
	}
	return out
}

func putPlane(w io.Writer, p []int16) error {
	buf := make([]byte, Pixels*2)
	for i, v := range p {
		binary.LittleEndian.PutUint16(buf[i*2:], uint16(v))
	}
	_, err := w.Write(buf)
	return err
}

func plane(b []byte) []int16 {
	out := make([]int16, Pixels)
	for i := range out {
		out[i] = int16(binary.LittleEndian.Uint16(b[i*2:]))
	}
	return out
}

// Encode writes the tile: header, then each plane residual-coded,
// row-delta coded and gzipped. The PAYLOAD (what Payload returns, and what a
// reader sees) is fully determined by the grid: no modification time, no
// name, no map iteration. The compressed framing around it is NOT, because
// Go's DEFLATE output has changed between toolchain releases, so nothing may
// take a tile's identity from its compressed bytes; that is what Payload is
// for, and why the upload receipts and the golden fixture both hash it.
func Encode(t *Tile) ([]byte, error) {
	body, err := Payload(t)
	if err != nil {
		return nil, err
	}
	var out bytes.Buffer
	zw, err := gzip.NewWriterLevel(&out, gzip.BestCompression)
	if err != nil {
		return nil, err
	}
	if _, err := zw.Write(body); err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

// Payload is the tile's canonical uncompressed bytes: its content, addressed
// and coded, with nothing about how it was stored. Two builds of the same
// ground produce the same payload on any toolchain.
func Payload(t *Tile) ([]byte, error) {
	if len(t.Mean) != Pixels {
		return nil, fmt.Errorf("terrain: mean band is %d pixels, want %d", len(t.Mean), Pixels)
	}
	bands := t.Bands()
	if bands == 3 && (len(t.Max) != Pixels || len(t.Min) != Pixels) {
		return nil, fmt.Errorf("terrain: max/min bands are %d/%d pixels, want %d", len(t.Max), len(t.Min), Pixels)
	}
	if t.Z < 0 || t.Z > 30 || t.X < 0 || t.Y < 0 {
		return nil, fmt.Errorf("terrain: address z%d/%d/%d out of range", t.Z, t.X, t.Y)
	}

	head := make([]byte, HeaderSize)
	copy(head, Magic)
	head[8] = byte(t.Z)
	head[9] = byte(bands)
	binary.LittleEndian.PutUint32(head[12:], uint32(t.X))
	binary.LittleEndian.PutUint32(head[16:], uint32(t.Y))

	planes := [][]int16{append([]int16(nil), t.Mean...)}
	if bands == 3 {
		// Two extra bands cost far less than two extra tiles: the residuals
		// correlate with the mean and compress to almost nothing.
		planes = append(planes, residual(t.Max, t.Mean, t.Mean), residual(t.Mean, t.Min, t.Mean))
	}

	var body bytes.Buffer
	body.Write(head)
	for _, p := range planes {
		rowDelta(p)
		if err := putPlane(&body, p); err != nil {
			return nil, err
		}
	}
	return body.Bytes(), nil
}

// PayloadOf returns the canonical payload of an ENCODED tile, so a caller
// holding bytes off disk can ask what they mean without re-encoding.
func PayloadOf(b []byte) ([]byte, error) {
	if len(b) > MaxCompressedBytes {
		return nil, fmt.Errorf("terrain: %d compressed bytes exceeds the cap", len(b))
	}
	zr, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		return nil, fmt.Errorf("terrain: gzip: %w", err)
	}
	raw, err := io.ReadAll(io.LimitReader(zr, int64(HeaderSize+3*Pixels*2)+1))
	if err != nil {
		return nil, fmt.Errorf("terrain: gzip: %w", err)
	}
	return raw, nil
}

// Decode reads a tile back. It returns an error rather than a partial tile
// for anything it cannot fully account for: a half-written or wrong object
// must read as "no tile", never as terrain.
func Decode(b []byte) (*Tile, error) {
	if len(b) > MaxCompressedBytes {
		return nil, fmt.Errorf("terrain: %d compressed bytes exceeds the cap", len(b))
	}
	zr, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		return nil, fmt.Errorf("terrain: gzip: %w", err)
	}
	raw, err := io.ReadAll(io.LimitReader(zr, int64(HeaderSize+3*Pixels*2)+1))
	if err != nil {
		return nil, fmt.Errorf("terrain: gzip: %w", err)
	}
	if len(raw) < HeaderSize {
		return nil, fmt.Errorf("terrain: %d bytes is shorter than the header", len(raw))
	}
	if string(raw[:len(Magic)]) != Magic {
		return nil, fmt.Errorf("terrain: not a tile")
	}
	bands := int(raw[9])
	if bands != 1 && bands != 3 {
		return nil, fmt.Errorf("terrain: %d bands", bands)
	}
	want := HeaderSize + bands*Pixels*2
	if len(raw) != want {
		return nil, fmt.Errorf("terrain: %d bytes, want %d for %d bands", len(raw), want, bands)
	}

	t := &Tile{
		Z: int(raw[8]),
		X: int(binary.LittleEndian.Uint32(raw[12:])),
		Y: int(binary.LittleEndian.Uint32(raw[16:])),
	}
	at := func(i int) []int16 {
		p := plane(raw[HeaderSize+i*Pixels*2:])
		rowUndelta(p)
		return p
	}
	t.Mean = at(0)
	if bands == 3 {
		hi, lo := at(1), at(2)
		t.Max = make([]int16, Pixels)
		t.Min = make([]int16, Pixels)
		for i, m := range t.Mean {
			if m == NoData {
				t.Max[i] = NoData
				t.Min[i] = NoData
				continue
			}
			t.Max[i] = int16(uint16(m) + uint16(hi[i]))
			t.Min[i] = int16(uint16(m) - uint16(lo[i]))
		}
	}
	return t, nil
}
