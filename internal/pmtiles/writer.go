package pmtiles

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
)

// Options describe the archive beyond its tiles.
type Options struct {
	TileType TileType
	// Bounds is west, south, east, north in degrees.
	Bounds [4]float64
	// Center is lon, lat in degrees, shown at CenterZoom. It must lie
	// within the archive's zooms.
	Center     [2]float64
	CenterZoom uint8
	// LeafSize forces leaf directories of this many entries when positive.
	// Zero lets the writer choose, which keeps a small archive root-only:
	// tests set it to exercise leaves on a handful of tiles.
	LeafSize int
}

type blob struct {
	offset uint64
	length uint32
}

// Writer assembles an archive. Tiles are added in strictly increasing
// TileID order; their bytes go to a spool file as they come, so the tile
// data never sits in memory, and Finish writes the header, directories and
// metadata ahead of a copy of the spool.
type Writer struct {
	spool    *os.File
	opts     Options
	entries  []Entry
	blobs    map[[sha256.Size]byte]blob
	lastHash [sha256.Size]byte
	dataLen  uint64
	address  uint64
	finished bool
}

// NewWriter writes the tile data to spool, which it owns until Finish
// returns: an empty, writable, seekable file the caller removes afterwards.
func NewWriter(spool *os.File, opts Options) *Writer {
	return &Writer{spool: spool, opts: opts, blobs: make(map[[sha256.Size]byte]blob)}
}

// Add appends one tile. A tile whose bytes were already stored points back
// at them; one continuing the previous tile's run with the same bytes only
// lengthens that entry.
func (w *Writer) Add(id uint64, data []byte) error {
	if w.finished {
		return errors.New("pmtiles: Add after Finish")
	}
	if len(data) == 0 {
		return fmt.Errorf("pmtiles: tile %d is empty", id)
	}
	if n := len(w.entries); n > 0 {
		last := &w.entries[n-1]
		if id < last.TileID+uint64(last.RunLength) {
			return fmt.Errorf("pmtiles: tile %d out of order after %d", id, last.TileID+uint64(last.RunLength)-1)
		}
	}
	h := sha256.Sum256(data)
	w.address++
	if n := len(w.entries); n > 0 {
		last := &w.entries[n-1]
		if id == last.TileID+uint64(last.RunLength) && h == w.lastHash {
			last.RunLength++
			return nil
		}
	}
	b, ok := w.blobs[h]
	if !ok {
		if _, err := w.spool.Write(data); err != nil {
			return err
		}
		b = blob{offset: w.dataLen, length: uint32(len(data))}
		w.blobs[h] = b
		w.dataLen += uint64(len(data))
	}
	w.entries = append(w.entries, Entry{TileID: id, Offset: b.offset, Length: b.length, RunLength: 1})
	w.lastHash = h
	return nil
}

// Finish writes the archive to out. meta must marshal to a JSON object;
// encoding/json orders a map's keys, so equal metadata gives equal bytes.
func (w *Writer) Finish(out io.Writer, meta any) (Header, error) {
	if w.finished {
		return Header{}, errors.New("pmtiles: Finish called twice")
	}
	w.finished = true
	if len(w.entries) == 0 {
		return Header{}, errors.New("pmtiles: no tiles")
	}
	metaJSON, err := json.Marshal(meta)
	if err != nil {
		return Header{}, fmt.Errorf("pmtiles: metadata: %w", err)
	}
	if len(metaJSON) == 0 || metaJSON[0] != '{' {
		return Header{}, errors.New("pmtiles: metadata must be a JSON object")
	}
	metaGz := gzipBytes(metaJSON)

	root, leaves := buildDirectories(w.entries, MaxRootLen, w.opts.LeafSize)
	minZ, _, _ := IDToZxy(w.entries[0].TileID)
	last := w.entries[len(w.entries)-1]
	maxZ, _, _ := IDToZxy(last.TileID + uint64(last.RunLength) - 1)
	if w.opts.CenterZoom < minZ || w.opts.CenterZoom > maxZ {
		return Header{}, fmt.Errorf("pmtiles: center zoom %d outside %d..%d", w.opts.CenterZoom, minZ, maxZ)
	}
	h := Header{
		RootOffset:          HeaderLen,
		RootLength:          uint64(len(root)),
		InternalCompression: CompressionGzip,
		TileCompression:     CompressionNone,
		TileType:            w.opts.TileType,
		Clustered:           true,
		AddressedTiles:      w.address,
		TileEntries:         uint64(len(w.entries)),
		TileContents:        uint64(len(w.blobs)),
		MinZoom:             minZ,
		MaxZoom:             maxZ,
		MinLonE7:            E7(w.opts.Bounds[0]),
		MinLatE7:            E7(w.opts.Bounds[1]),
		MaxLonE7:            E7(w.opts.Bounds[2]),
		MaxLatE7:            E7(w.opts.Bounds[3]),
		CenterZoom:          w.opts.CenterZoom,
		CenterLonE7:         E7(w.opts.Center[0]),
		CenterLatE7:         E7(w.opts.Center[1]),
	}
	h.MetadataOffset = h.RootOffset + h.RootLength
	h.MetadataLength = uint64(len(metaGz))
	// Never zero, even with no leaves: go-pmtiles' verify rejects a zero
	// offset, and the section simply has no length here.
	h.LeafOffset = h.MetadataOffset + h.MetadataLength
	h.LeafLength = uint64(len(leaves))
	h.DataOffset = h.LeafOffset + h.LeafLength
	h.DataLength = w.dataLen

	for _, part := range [][]byte{h.marshal(), root, metaGz, leaves} {
		if _, err := out.Write(part); err != nil {
			return Header{}, err
		}
	}
	if _, err := w.spool.Seek(0, io.SeekStart); err != nil {
		return Header{}, err
	}
	n, err := io.Copy(out, w.spool)
	if err != nil {
		return Header{}, err
	}
	if uint64(n) != w.dataLen {
		return Header{}, fmt.Errorf("pmtiles: spool held %d bytes, want %d", n, w.dataLen)
	}
	return h, nil
}
