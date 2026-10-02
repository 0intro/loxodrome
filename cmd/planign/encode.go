// encode.go turns one IGN tile into what the archive stores: a hash of its
// PIXELS, which is what the build compares from one edition to the next,
// and its WebP bytes, which is what a pilot downloads.

package main

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"image"
	"image/draw"
	"image/png"

	"github.com/gen2brain/webp"
)

// tileSize is the WMTS tile's edge in pixels. A tile of any other size is
// not a Plan IGN tile and is refused rather than stretched.
const tileSize = 256

const (
	// webpQuality is the lossy quality. Measured on 48 Plan IGN tiles at
	// z11-z13: q85 is about 26 % of the PNG, q75 19 %, lossless 75 %. Below
	// 85 the small labels start to smear, and the pack is a map pilots read.
	webpQuality = 85
	// webpMethod is libwebp's speed/size dial (0 fast, 6 slowest). Chosen
	// by BenchmarkEncodeTile; the harvest is bound by the network anyway.
	webpMethod = 6
)

// pngMagic opens every PNG. A 200 that is not one (an HTML error page, a
// portal) is a failed fetch, never a tile.
var pngMagic = []byte("\x89PNG\r\n\x1a\n")

var errNotPNG = errors.New("not a PNG")

// encoded is one present tile.
type encoded struct {
	// pixels is the SHA-256 of the decoded image, 256 x 256 NRGBA rows. It
	// is independent of how IGN compressed the PNG and of how this command
	// compresses the WebP, so a re-encode on either side is not a change.
	pixels [sha256.Size]byte
	webp   []byte
}

// decodeTile reads a WMTS answer into the canonical pixel layout.
func decodeTile(body []byte) (*image.NRGBA, error) {
	if !bytes.HasPrefix(body, pngMagic) {
		return nil, errNotPNG
	}
	img, err := png.Decode(bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("decode PNG: %w", err)
	}
	b := img.Bounds()
	if b.Dx() != tileSize || b.Dy() != tileSize {
		return nil, fmt.Errorf("tile is %dx%d, want %dx%d", b.Dx(), b.Dy(), tileSize, tileSize)
	}
	nrgba := image.NewNRGBA(image.Rect(0, 0, tileSize, tileSize))
	draw.Draw(nrgba, nrgba.Bounds(), img, b.Min, draw.Src)
	return nrgba, nil
}

// encodeTile decodes a PNG answer, hashes its pixels and encodes the WebP.
func encodeTile(body []byte) (encoded, error) {
	img, err := decodeTile(body)
	if err != nil {
		return encoded{}, err
	}
	var out bytes.Buffer
	if err := webp.Encode(&out, img, webp.Options{Quality: webpQuality, Method: webpMethod}); err != nil {
		return encoded{}, fmt.Errorf("encode WebP: %w", err)
	}
	return encoded{pixels: sha256.Sum256(img.Pix), webp: out.Bytes()}, nil
}

// checkEncoder refuses a system libwebp. The module tries one through purego
// before its own transpiled copy; another library version would encode the
// same pixels into other bytes on another machine, so every build is made
// with `-tags nodynamic`, which compiles the dynamic path out.
func checkEncoder() error {
	if webp.Dynamic() == nil {
		return errors.New("a system libwebp was loaded: build with -tags nodynamic")
	}
	return nil
}
