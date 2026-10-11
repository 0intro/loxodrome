package main

import (
	"bytes"
	"crypto/sha256"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"testing"

	"github.com/gen2brain/webp"
)

// pngTile builds a 256 x 256 PNG with a pattern, in the given color model,
// so the same pixels can arrive in two different PNG encodings.
func pngTile(t testing.TB, paletted bool) []byte {
	t.Helper()
	var img image.Image
	if paletted {
		pal := color.Palette{color.NRGBA{240, 236, 228, 255}, color.NRGBA{30, 90, 200, 255}}
		p := image.NewPaletted(image.Rect(0, 0, tileSize, tileSize), pal)
		for y := 0; y < tileSize; y++ {
			for x := 0; x < tileSize; x++ {
				if (x/16+y/16)%2 == 0 {
					p.SetColorIndex(x, y, 1)
				}
			}
		}
		img = p
	} else {
		r := image.NewNRGBA(image.Rect(0, 0, tileSize, tileSize))
		for y := 0; y < tileSize; y++ {
			for x := 0; x < tileSize; x++ {
				c := color.NRGBA{240, 236, 228, 255}
				if (x/16+y/16)%2 == 0 {
					c = color.NRGBA{30, 90, 200, 255}
				}
				r.SetNRGBA(x, y, c)
			}
		}
		img = r
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestEncodeOpaqueWebP(t *testing.T) {
	e, err := encodeTile(pngTile(t, false))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(e.webp, []byte("RIFF")) || !bytes.Equal(e.webp[8:12], []byte("WEBP")) {
		t.Fatalf("not a WebP: % x", e.webp[:16])
	}
	// Lossy VP8, and no alpha chunk: the tiles are opaque and a VP8X/ALPH
	// pair would cost bytes on every one of ninety thousand tiles.
	if got := string(e.webp[12:16]); got != "VP8 " {
		t.Fatalf("chunk %q, want lossy %q", got, "VP8 ")
	}
	img, err := webp.Decode(bytes.NewReader(e.webp))
	if err != nil {
		t.Fatal(err)
	}
	if b := img.Bounds(); b.Dx() != tileSize || b.Dy() != tileSize {
		t.Fatalf("decoded %v", b)
	}
}

func TestPixelHashIgnoresPNGEncoding(t *testing.T) {
	a, err := encodeTile(pngTile(t, false))
	if err != nil {
		t.Fatal(err)
	}
	b, err := encodeTile(pngTile(t, true))
	if err != nil {
		t.Fatal(err)
	}
	if a.pixels != b.pixels {
		t.Fatal("the same pixels in two PNG encodings hash apart")
	}
	// And a change of one pixel is a change.
	img, _ := decodeTile(pngTile(t, false))
	img.Pix[0] ^= 1
	if sha256.Sum256(img.Pix) == a.pixels {
		t.Fatal("a changed pixel kept the hash")
	}
}

func TestEncodeRefusesNonTiles(t *testing.T) {
	if _, err := encodeTile([]byte("<html>maintenance</html>")); err != errNotPNG {
		t.Fatalf("HTML: %v", err)
	}
	small := image.NewNRGBA(image.Rect(0, 0, 128, 128))
	var buf bytes.Buffer
	if err := png.Encode(&buf, small); err != nil {
		t.Fatal(err)
	}
	if _, err := encodeTile(buf.Bytes()); err == nil {
		t.Fatal("a 128 px tile was accepted")
	}
}

// BenchmarkEncodeTile measures the encoder on real Plan IGN tiles, which a
// synthetic pattern does not resemble. Point PLANIGN_SAMPLES at a directory
// of PNG tiles; skipped otherwise.
func BenchmarkEncodeTile(b *testing.B) {
	dir := os.Getenv("PLANIGN_SAMPLES")
	if dir == "" {
		b.Skip("PLANIGN_SAMPLES unset")
	}
	paths, _ := filepath.Glob(filepath.Join(dir, "*.png"))
	if len(paths) == 0 {
		b.Skip("no samples")
	}
	var tiles [][]byte
	var pngBytes int
	for _, p := range paths {
		body, err := os.ReadFile(p)
		if err != nil {
			b.Fatal(err)
		}
		tiles = append(tiles, body)
		pngBytes += len(body)
	}
	b.ResetTimer()
	webpBytes := 0
	for i := 0; i < b.N; i++ {
		e, err := encodeTile(tiles[i%len(tiles)])
		if err != nil {
			b.Fatal(err)
		}
		webpBytes += len(e.webp)
	}
	b.ReportMetric(float64(webpBytes)/float64(b.N)/1024, "KB/tile")
	b.ReportMetric(float64(pngBytes)/float64(len(tiles))/1024, "pngKB/tile")
}
