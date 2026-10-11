package pmtiles

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// Entry is one directory entry: a tile run (RunLength >= 1) at Offset in
// the tile data, or a leaf directory (RunLength 0) at Offset in the leaf
// section.
type Entry struct {
	TileID    uint64
	Offset    uint64
	Length    uint32
	RunLength uint32
}

// encodeEntries serializes a directory, uncompressed. Each directory is
// encoded on its own, never sliced out of a larger encoding: the FIRST entry
// of every directory is written as offset+1, because a reader decodes a 0
// there as "contiguous with the previous entry" and pmtiles.js has no
// previous entry to add, reading offset -1.
func encodeEntries(entries []Entry) []byte {
	var b []byte
	b = binary.AppendUvarint(b, uint64(len(entries)))
	var last uint64
	for _, e := range entries {
		b = binary.AppendUvarint(b, e.TileID-last)
		last = e.TileID
	}
	for _, e := range entries {
		b = binary.AppendUvarint(b, uint64(e.RunLength))
	}
	for _, e := range entries {
		b = binary.AppendUvarint(b, uint64(e.Length))
	}
	for i, e := range entries {
		if i > 0 && e.Offset == entries[i-1].Offset+uint64(entries[i-1].Length) {
			b = binary.AppendUvarint(b, 0)
		} else {
			b = binary.AppendUvarint(b, e.Offset+1)
		}
	}
	return b
}

// gzipBytes compresses at the best level with an empty gzip header (no
// name, no time), so equal input gives equal output for a given Go.
func gzipBytes(b []byte) []byte {
	var out bytes.Buffer
	w, _ := gzip.NewWriterLevel(&out, gzip.BestCompression)
	_, _ = w.Write(b)
	_ = w.Close()
	return out.Bytes()
}

// decodeEntries reads a gzip-compressed directory.
func decodeEntries(b []byte) ([]Entry, error) {
	zr, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		return nil, fmt.Errorf("pmtiles: directory: %w", err)
	}
	raw, err := io.ReadAll(zr)
	if err != nil {
		return nil, fmt.Errorf("pmtiles: directory: %w", err)
	}
	r := bufio.NewReader(bytes.NewReader(raw))
	n, err := binary.ReadUvarint(r)
	if err != nil {
		return nil, fmt.Errorf("pmtiles: directory count: %w", err)
	}
	if n == 0 {
		return nil, errors.New("pmtiles: empty directory")
	}
	if n > uint64(len(raw)) {
		return nil, fmt.Errorf("pmtiles: directory claims %d entries in %d bytes", n, len(raw))
	}
	entries := make([]Entry, n)
	read := func() (uint64, error) { return binary.ReadUvarint(r) }
	var last uint64
	for i := range entries {
		d, err := read()
		if err != nil {
			return nil, err
		}
		last += d
		entries[i].TileID = last
	}
	for i := range entries {
		v, err := read()
		if err != nil {
			return nil, err
		}
		entries[i].RunLength = uint32(v)
	}
	for i := range entries {
		v, err := read()
		if err != nil {
			return nil, err
		}
		entries[i].Length = uint32(v)
	}
	for i := range entries {
		v, err := read()
		if err != nil {
			return nil, err
		}
		if v == 0 {
			if i == 0 {
				return nil, errors.New("pmtiles: first entry encoded as contiguous")
			}
			entries[i].Offset = entries[i-1].Offset + uint64(entries[i-1].Length)
		} else {
			entries[i].Offset = v - 1
		}
	}
	if _, err := r.ReadByte(); err != io.EOF {
		return nil, errors.New("pmtiles: trailing bytes after directory")
	}
	return entries, nil
}

// buildDirectories lays the tile entries out as go-pmtiles does: the whole
// list as the root when it fits, else leaves of leafSize entries (at least
// 4096, or a 3,500th of the list) grown by a fifth until the root of leaf
// pointers fits. One level of leaves only, as the spec asks. forceLeaf > 0
// skips the root-only case and starts from that size, so a test can reach
// leaves without a hundred thousand tiles.
func buildDirectories(entries []Entry, maxRoot int, forceLeaf int) (root, leaves []byte) {
	if forceLeaf == 0 && len(entries) < 16384 {
		if r := gzipBytes(encodeEntries(entries)); len(r) <= maxRoot {
			return r, nil
		}
	}
	leafSize := float64(len(entries)) / 3500
	if leafSize < 4096 {
		leafSize = 4096
	}
	if forceLeaf > 0 {
		leafSize = float64(forceLeaf)
	}
	for {
		size := int(leafSize)
		var pointers []Entry
		leaves = leaves[:0]
		for i := 0; i < len(entries); i += size {
			end := min(i+size, len(entries))
			leaf := gzipBytes(encodeEntries(entries[i:end]))
			pointers = append(pointers, Entry{
				TileID:    entries[i].TileID,
				Offset:    uint64(len(leaves)),
				Length:    uint32(len(leaf)),
				RunLength: 0,
			})
			leaves = append(leaves, leaf...)
		}
		root = gzipBytes(encodeEntries(pointers))
		if len(root) <= maxRoot {
			return root, leaves
		}
		leafSize *= 1.2
	}
}
