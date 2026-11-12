package pmtiles

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
)

// Reader reads an archive through an io.ReaderAt: a file, or a ranged
// HTTP source (cmd/planign reads the published edition that way).
type Reader struct {
	r    io.ReaderAt
	size int64
	h    Header
	root []Entry
}

// Open reads the header and the root directory.
func Open(r io.ReaderAt, size int64) (*Reader, error) {
	head := make([]byte, HeaderLen)
	if _, err := r.ReadAt(head, 0); err != nil {
		return nil, fmt.Errorf("pmtiles: header: %w", err)
	}
	h, err := parseHeader(head)
	if err != nil {
		return nil, err
	}
	if h.InternalCompression != CompressionGzip {
		return nil, fmt.Errorf("pmtiles: internal compression %d not supported", h.InternalCompression)
	}
	rd := &Reader{r: r, size: size, h: h}
	b, err := rd.section(h.RootOffset, h.RootLength)
	if err != nil {
		return nil, fmt.Errorf("pmtiles: root: %w", err)
	}
	if rd.root, err = decodeEntries(b); err != nil {
		return nil, err
	}
	return rd, nil
}

// Header is the archive's header.
func (rd *Reader) Header() Header { return rd.h }

func (rd *Reader) section(off, n uint64) ([]byte, error) {
	if n > uint64(rd.size) || off > uint64(rd.size)-n {
		return nil, fmt.Errorf("section %d+%d past the end (%d)", off, n, rd.size)
	}
	b := make([]byte, n)
	if _, err := rd.r.ReadAt(b, int64(off)); err != nil {
		return nil, err
	}
	return b, nil
}

// MetadataJSON is the decompressed metadata.
func (rd *Reader) MetadataJSON() ([]byte, error) {
	b, err := rd.section(rd.h.MetadataOffset, rd.h.MetadataLength)
	if err != nil {
		return nil, fmt.Errorf("pmtiles: metadata: %w", err)
	}
	zr, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		return nil, fmt.Errorf("pmtiles: metadata: %w", err)
	}
	return io.ReadAll(zr)
}

// Metadata decodes the metadata into v.
func (rd *Reader) Metadata(v any) error {
	b, err := rd.MetadataJSON()
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

// find returns the entry covering id in a directory, if any: the last entry
// starting at or before it.
func find(entries []Entry, id uint64) (Entry, bool) {
	i := sort.Search(len(entries), func(i int) bool { return entries[i].TileID > id }) - 1
	if i < 0 {
		return Entry{}, false
	}
	return entries[i], true
}

// Get returns tile z/x/y's bytes, or nil when the archive does not hold it.
func (rd *Reader) Get(z uint8, x, y uint32) ([]byte, error) {
	id := ZxyToID(z, x, y)
	dir := rd.root
	for depth := 0; depth < 3; depth++ {
		e, ok := find(dir, id)
		if !ok {
			return nil, nil
		}
		if e.RunLength > 0 {
			if id >= e.TileID+uint64(e.RunLength) {
				return nil, nil
			}
			return rd.section(rd.h.DataOffset+e.Offset, uint64(e.Length))
		}
		b, err := rd.section(rd.h.LeafOffset+e.Offset, uint64(e.Length))
		if err != nil {
			return nil, fmt.Errorf("pmtiles: leaf: %w", err)
		}
		if dir, err = decodeEntries(b); err != nil {
			return nil, err
		}
	}
	return nil, errors.New("pmtiles: directories nested too deep")
}

// Walk calls fn for every tile entry in TileID order, root and leaves.
func (rd *Reader) Walk(fn func(Entry) error) error {
	for _, e := range rd.root {
		if e.RunLength > 0 {
			if err := fn(e); err != nil {
				return err
			}
			continue
		}
		b, err := rd.section(rd.h.LeafOffset+e.Offset, uint64(e.Length))
		if err != nil {
			return fmt.Errorf("pmtiles: leaf: %w", err)
		}
		leaf, err := decodeEntries(b)
		if err != nil {
			return err
		}
		for _, le := range leaf {
			if le.RunLength == 0 {
				return errors.New("pmtiles: a second level of leaves")
			}
			if err := fn(le); err != nil {
				return err
			}
		}
	}
	return nil
}

// TileData reads an entry's bytes.
func (rd *Reader) TileData(e Entry) ([]byte, error) {
	return rd.section(rd.h.DataOffset+e.Offset, uint64(e.Length))
}
