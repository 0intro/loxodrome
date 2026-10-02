package pmtiles

import (
	"errors"
	"fmt"
)

// Verify checks an archive against the rules this package's writer keeps,
// which are stricter than the spec's minimum and than go-pmtiles' verify
// (whose clustered-order check never fires in v1.30.3: it records an
// offset before testing whether it has seen it). An archive every pilot
// downloads must be checked by something that can fail.
func Verify(rd *Reader) error {
	h := rd.h
	if h.RootOffset != HeaderLen {
		return fmt.Errorf("root at %d, want %d", h.RootOffset, HeaderLen)
	}
	if h.RootOffset+h.RootLength > rootLimit {
		return fmt.Errorf("root ends at %d, past the first %d bytes", h.RootOffset+h.RootLength, rootLimit)
	}
	// The sections follow one another with no gap and end the file.
	if h.MetadataOffset != h.RootOffset+h.RootLength ||
		h.LeafOffset != h.MetadataOffset+h.MetadataLength ||
		h.DataOffset != h.LeafOffset+h.LeafLength ||
		h.DataOffset+h.DataLength != uint64(rd.size) {
		return errors.New("sections are not contiguous to the end of the file")
	}
	if h.MetadataLength == 0 || h.DataLength == 0 {
		return errors.New("empty metadata or tile data")
	}
	if h.LeafOffset == 0 {
		return errors.New("leaf offset is zero")
	}
	if h.MaxZoom < h.MinZoom || h.CenterZoom < h.MinZoom || h.CenterZoom > h.MaxZoom {
		return fmt.Errorf("zooms min %d max %d center %d", h.MinZoom, h.MaxZoom, h.CenterZoom)
	}
	if h.MinLonE7 >= h.MaxLonE7 || h.MinLatE7 >= h.MaxLatE7 {
		return errors.New("bounds have no area")
	}
	var meta map[string]any
	if err := rd.Metadata(&meta); err != nil {
		return fmt.Errorf("metadata: %w", err)
	}

	// The leaves the root points at come one after the other, ascending.
	var leafEnd uint64
	for i, e := range rd.root {
		if e.Length == 0 {
			return fmt.Errorf("root entry %d has length 0", i)
		}
		if e.RunLength == 0 {
			if e.Offset != leafEnd {
				return fmt.Errorf("leaf %d at %d, want %d", i, e.Offset, leafEnd)
			}
			leafEnd += uint64(e.Length)
		}
	}
	if leafEnd != h.LeafLength {
		return fmt.Errorf("leaves cover %d of %d bytes", leafEnd, h.LeafLength)
	}

	var (
		n, addressed, dataEnd uint64
		next                  uint64 // the first TileID the next entry may take
		first, last           Entry
		contents              = map[uint64]bool{}
	)
	err := rd.Walk(func(e Entry) error {
		if e.Length == 0 {
			return fmt.Errorf("tile %d has length 0", e.TileID)
		}
		if n > 0 && e.TileID < next {
			return fmt.Errorf("tile %d overlaps the run before it", e.TileID)
		}
		if e.Offset+uint64(e.Length) > h.DataLength {
			return fmt.Errorf("tile %d past the tile data", e.TileID)
		}
		// Clustered: a new blob starts exactly where the data written so far
		// ends; anything else must point back at a blob already written.
		switch {
		case e.Offset == dataEnd:
			dataEnd += uint64(e.Length)
			contents[e.Offset] = true
		case e.Offset < dataEnd && contents[e.Offset]:
		default:
			return fmt.Errorf("tile %d at %d breaks the clustered order (data so far ends at %d)", e.TileID, e.Offset, dataEnd)
		}
		if n == 0 {
			first = e
		}
		last = e
		n++
		addressed += uint64(e.RunLength)
		next = e.TileID + uint64(e.RunLength)
		return nil
	})
	if err != nil {
		return err
	}
	if dataEnd != h.DataLength {
		return fmt.Errorf("blobs cover %d of %d data bytes", dataEnd, h.DataLength)
	}
	if n != h.TileEntries || addressed != h.AddressedTiles || uint64(len(contents)) != h.TileContents {
		return fmt.Errorf("counts entries %d/%d addressed %d/%d contents %d/%d",
			n, h.TileEntries, addressed, h.AddressedTiles, len(contents), h.TileContents)
	}
	if z, _, _ := IDToZxy(first.TileID); z != h.MinZoom {
		return fmt.Errorf("first tile at zoom %d, header says %d", z, h.MinZoom)
	}
	if z, _, _ := IDToZxy(last.TileID + uint64(last.RunLength) - 1); z != h.MaxZoom {
		return fmt.Errorf("last tile at zoom %d, header says %d", z, h.MaxZoom)
	}
	return nil
}
