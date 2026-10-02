package pmtiles

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"
)

const (
	// HeaderLen is the fixed header's length.
	HeaderLen = 127
	// rootLimit is the most bytes the header and root directory may take
	// together: a client reads the first 16 KiB once and must find the
	// whole root in it (pmtiles.js does exactly that).
	rootLimit = 16384
	// MaxRootLen is the largest compressed root directory that fits.
	MaxRootLen = rootLimit - HeaderLen
)

// Compression is the spec's compression enum.
type Compression uint8

const (
	CompressionUnknown Compression = 0
	CompressionNone    Compression = 1
	CompressionGzip    Compression = 2
)

// TileType is the spec's tile type enum.
type TileType uint8

const (
	TileTypeUnknown TileType = 0
	TileTypePNG     TileType = 2
	TileTypeJPEG    TileType = 3
	TileTypeWebP    TileType = 4
)

// Header is the decoded 127-byte header.
type Header struct {
	RootOffset, RootLength         uint64
	MetadataOffset, MetadataLength uint64
	LeafOffset, LeafLength         uint64
	DataOffset, DataLength         uint64
	AddressedTiles                 uint64
	TileEntries                    uint64
	TileContents                   uint64
	Clustered                      bool
	InternalCompression            Compression
	TileCompression                Compression
	TileType                       TileType
	MinZoom, MaxZoom               uint8
	MinLonE7, MinLatE7             int32
	MaxLonE7, MaxLatE7             int32
	CenterZoom                     uint8
	CenterLonE7, CenterLatE7       int32
}

var magic = []byte("PMTiles")

// E7 encodes a degree value the way positions are stored.
func E7(deg float64) int32 { return int32(math.Round(deg * 1e7)) }

func (h Header) marshal() []byte {
	b := make([]byte, HeaderLen)
	copy(b, magic)
	b[7] = 3
	le := binary.LittleEndian
	le.PutUint64(b[8:], h.RootOffset)
	le.PutUint64(b[16:], h.RootLength)
	le.PutUint64(b[24:], h.MetadataOffset)
	le.PutUint64(b[32:], h.MetadataLength)
	le.PutUint64(b[40:], h.LeafOffset)
	le.PutUint64(b[48:], h.LeafLength)
	le.PutUint64(b[56:], h.DataOffset)
	le.PutUint64(b[64:], h.DataLength)
	le.PutUint64(b[72:], h.AddressedTiles)
	le.PutUint64(b[80:], h.TileEntries)
	le.PutUint64(b[88:], h.TileContents)
	if h.Clustered {
		b[96] = 1
	}
	b[97] = byte(h.InternalCompression)
	b[98] = byte(h.TileCompression)
	b[99] = byte(h.TileType)
	b[100] = h.MinZoom
	b[101] = h.MaxZoom
	le.PutUint32(b[102:], uint32(h.MinLonE7))
	le.PutUint32(b[106:], uint32(h.MinLatE7))
	le.PutUint32(b[110:], uint32(h.MaxLonE7))
	le.PutUint32(b[114:], uint32(h.MaxLatE7))
	b[118] = h.CenterZoom
	le.PutUint32(b[119:], uint32(h.CenterLonE7))
	le.PutUint32(b[123:], uint32(h.CenterLatE7))
	return b
}

// parseHeader decodes the first HeaderLen bytes of an archive.
func parseHeader(b []byte) (Header, error) {
	if len(b) < HeaderLen {
		return Header{}, errors.New("pmtiles: short header")
	}
	if string(b[:7]) != string(magic) {
		return Header{}, errors.New("pmtiles: not a PMTiles archive")
	}
	if b[7] != 3 {
		return Header{}, fmt.Errorf("pmtiles: version %d, want 3", b[7])
	}
	le := binary.LittleEndian
	return Header{
		RootOffset:          le.Uint64(b[8:]),
		RootLength:          le.Uint64(b[16:]),
		MetadataOffset:      le.Uint64(b[24:]),
		MetadataLength:      le.Uint64(b[32:]),
		LeafOffset:          le.Uint64(b[40:]),
		LeafLength:          le.Uint64(b[48:]),
		DataOffset:          le.Uint64(b[56:]),
		DataLength:          le.Uint64(b[64:]),
		AddressedTiles:      le.Uint64(b[72:]),
		TileEntries:         le.Uint64(b[80:]),
		TileContents:        le.Uint64(b[88:]),
		Clustered:           b[96] == 1,
		InternalCompression: Compression(b[97]),
		TileCompression:     Compression(b[98]),
		TileType:            TileType(b[99]),
		MinZoom:             b[100],
		MaxZoom:             b[101],
		MinLonE7:            int32(le.Uint32(b[102:])),
		MinLatE7:            int32(le.Uint32(b[106:])),
		MaxLonE7:            int32(le.Uint32(b[110:])),
		MaxLatE7:            int32(le.Uint32(b[114:])),
		CenterZoom:          b[118],
		CenterLonE7:         int32(le.Uint32(b[119:])),
		CenterLatE7:         int32(le.Uint32(b[123:])),
	}, nil
}
