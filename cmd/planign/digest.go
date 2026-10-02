// digest.go names an edition by what it shows.
//
// The archive's bytes are no use for deciding whether an edition changed:
// they carry the harvest date, gzip's output has changed between Go
// releases, and a WebP encoder upgrade would re-encode the same pixels into
// other bytes. Any of those would publish a 1.1 GB "update" to every pilot
// holding the tiles they already have. So the digest is over the tiles'
// PIXELS (cache.go stores their hash beside each WebP) and the parameters
// that shape the pack, and nothing else.

package main

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"hash"

	"github.com/0intro/loxodrome/internal/pmtiles"
)

// digestTag opens every digest; changing the digest's own layout changes it.
const digestTag = "loxodrome-planign-digest/1\n"

// metaRevision is bumped when the archive's descriptive metadata changes
// (its name, description or attribution), the only metadata the pixels do
// not already determine.
const metaRevision = 1

// contentParams are the parameters that change what a pilot downloads.
// The encoder's version is deliberately not here: a library upgrade that
// re-encodes identical pixels is not a new map. Ship one with -force.
type contentParams struct {
	Layer        string   `json:"layer"`
	Style        string   `json:"style"`
	MatrixSet    string   `json:"matrixSet"`
	MinZoom      int      `json:"minZoom"`
	MaxZoom      int      `json:"maxZoom"`
	WorldMaxZoom int      `json:"worldMaxZoom"`
	Regions      []region `json:"regions"`
	Margin       int      `json:"margin"`
	MarginMax    int      `json:"marginMaxZoom"`
	TileType     string   `json:"tileType"`
	Quality      int      `json:"quality"`
	Method       int      `json:"method"`
	MetaRevision int      `json:"metaRevision"`
}

// digester accumulates the digest as tiles are assembled in TileID order.
type digester struct {
	h hash.Hash
}

func newDigester(p contentParams) (*digester, error) {
	b, err := json.Marshal(p)
	if err != nil {
		return nil, err
	}
	h := sha256.New()
	h.Write([]byte(digestTag))
	h.Write(b)
	h.Write([]byte{'\n'})
	return &digester{h: h}, nil
}

// add folds in one present tile.
func (d *digester) add(t tile, pixels [sha256.Size]byte) {
	var buf [binary.MaxVarintLen64]byte
	n := binary.PutUvarint(buf[:], pmtiles.ZxyToID(t.z, t.x, t.y))
	d.h.Write(buf[:n])
	d.h.Write(pixels[:])
}

func (d *digester) sum() string { return hex.EncodeToString(d.h.Sum(nil)) }
