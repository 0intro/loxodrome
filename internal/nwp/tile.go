package nwp

import (
	"bytes"
	"compress/flate"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// A tile's payload is its segments, each compressed alone so a request
// inflates only what it reads:
//
//	u8  n                  segment count (NumSegments)
//	u32 len[n]             little-endian compressed lengths
//	n segments             deflate-raw over int16 little-endian values in
//	                       [var][step][point] order, TileSize x TileSize
//	                       points row-major from the tile's north-west
//	                       corner, Missing where a point has no value
//
// The static segment has no step axis.

// deflateLevel is deflate's default. Level 9 wrote an AROME block in 153.9
// MB and 90 CPU-seconds against 150.9 MB in 35 (longer matches these int16
// planes do not repay). BestSpeed, deployed for a day on 2026-10-08,
// encoded an IFS block in 5-6 s where the default took 9-10 (two
// threads), but wrote 14.5 % more (ARPEGE's first block 21 %: 242.4 MB
// against 200.7), bytes every upload carries and every forecast read
// inflates: on the Container the upload then took what the encode saved.
// The canaries hash the uncompressed values, so the level changes no
// verdict.
const deflateLevel = flate.DefaultCompression

// TileData is one tile's values per segment, [var][step][point].
type TileData [NumSegments][]int16

// SegmentHash is a hash of a segment's UNCOMPRESSED values: deflate's
// bytes are not stable across Go releases, the values are.
type SegmentHash [sha256.Size]byte

func int16Bytes(v []int16) []byte {
	return appendInt16Bytes(make([]byte, 0, 2*len(v)), v)
}

func appendInt16Bytes(b []byte, v []int16) []byte {
	for _, x := range v {
		b = binary.LittleEndian.AppendUint16(b, uint16(x))
	}
	return b
}

// A tileEncoder compresses tiles with one deflate writer, reset for each
// segment, and one scratch buffer for the values' bytes: a writer per
// segment allocated and cleared about a megabyte some 33 000 times an IFS
// block. Reset is documented as NewWriter, so the bytes are the same. One
// goroutine uses an encoder at a time.
type tileEncoder struct {
	zw  *flate.Writer
	raw []byte
}

func newTileEncoder() (*tileEncoder, error) {
	zw, err := flate.NewWriter(io.Discard, deflateLevel)
	if err != nil {
		return nil, err
	}
	return &tileEncoder{zw: zw}, nil
}

// EncodeTile compresses a tile and hashes its segments.
func EncodeTile(t *TileData) ([]byte, [NumSegments]SegmentHash, error) {
	e, err := newTileEncoder()
	if err != nil {
		return nil, [NumSegments]SegmentHash{}, err
	}
	return e.encode(t)
}

func (e *tileEncoder) encode(t *TileData) ([]byte, [NumSegments]SegmentHash, error) {
	var hashes [NumSegments]SegmentHash
	var segs [NumSegments][]byte
	for s := range t {
		e.raw = appendInt16Bytes(e.raw[:0], t[s])
		hashes[s] = sha256.Sum256(e.raw)
		// A buffer of its own: its bytes become the segment.
		var buf bytes.Buffer
		e.zw.Reset(&buf)
		if _, err := e.zw.Write(e.raw); err != nil {
			return nil, hashes, err
		}
		if err := e.zw.Close(); err != nil {
			return nil, hashes, err
		}
		segs[s] = buf.Bytes()
	}
	out := make([]byte, 1+4*NumSegments)
	out[0] = byte(NumSegments)
	for s, b := range segs {
		binary.LittleEndian.PutUint32(out[1+4*s:], uint32(len(b)))
	}
	for _, b := range segs {
		out = append(out, b...)
	}
	return out, hashes, nil
}

// DecodeSegment inflates one segment of a tile payload.
func DecodeSegment(payload []byte, s Segment) ([]int16, error) {
	if len(payload) < 1 || int(payload[0]) <= int(s) {
		return nil, errors.New("nwp: tile payload lacks the segment")
	}
	n := int(payload[0])
	head := 1 + 4*n
	if len(payload) < head {
		return nil, errors.New("nwp: short tile header")
	}
	off := head
	for k := 0; k < int(s); k++ {
		off += int(binary.LittleEndian.Uint32(payload[1+4*k:]))
	}
	ln := int(binary.LittleEndian.Uint32(payload[1+4*int(s):]))
	if off+ln > len(payload) {
		return nil, fmt.Errorf("nwp: segment %s overruns the tile", s)
	}
	raw, err := io.ReadAll(flate.NewReader(bytes.NewReader(payload[off : off+ln])))
	if err != nil {
		return nil, fmt.Errorf("nwp: segment %s: %w", s, err)
	}
	if len(raw)%2 != 0 {
		return nil, fmt.Errorf("nwp: segment %s has an odd byte count", s)
	}
	v := make([]int16, len(raw)/2)
	for i := range v {
		v[i] = int16(binary.LittleEndian.Uint16(raw[2*i:]))
	}
	return v, nil
}
