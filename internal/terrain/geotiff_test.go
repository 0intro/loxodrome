package terrain

import (
	"bytes"
	"compress/zlib"
	"encoding/binary"
	"math"
	"testing"
)

/* Every metre of ground this application serves came through ReadGeoTIFF, and
 * it had no test. The bug it did have was the worst kind: the floating-point
 * predictor was undifferenced with a stride of the sample WIDTH instead of the
 * sample COUNT, which decodes to plausible-looking rubbish rather than to an
 * error. Mont Blanc read 0 m and a third of a tile read as void, and nothing
 * in the pipeline objected.
 *
 * These build the two shapes the mosaic actually reads: NASADEM's int16 tiles
 * and Copernicus's float32 ones with predictor 3. */

const (
	step = 1.0 / (tW - 1) // posts, not areas: N samples span N-1 intervals
	tW   = 64             // image and tile are one block, which is all the reader needs to
	tH   = 64             // be shown; a real COG has many and the loop is the same.
)

type tiffTag struct {
	tag, typ uint16
	count    uint32
	value    uint32
}

// buildTIFF writes a minimal little-endian tiled TIFF around one block of
// already-encoded pixel bytes.
func buildTIFF(t *testing.T, bps uint16, fmtCode uint16, predictor uint16, block []byte,
	scale, tie []float64) []byte {
	t.Helper()
	var comp bytes.Buffer
	zw := zlib.NewWriter(&comp)
	if _, err := zw.Write(block); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	data := comp.Bytes()

	// Layout: header (8) | IFD | out-of-line values | pixel data.
	tags := []tiffTag{
		{256, 3, 1, uint32(tW)},  // ImageWidth
		{257, 3, 1, uint32(tH)},  // ImageLength
		{258, 3, 1, uint32(bps)}, // BitsPerSample
		{259, 3, 1, 8},           // Compression: Adobe deflate
		{262, 3, 1, 1},           // Photometric: black is zero
		{277, 3, 1, 1},           // SamplesPerPixel
		{284, 3, 1, 1},           // PlanarConfig: chunky
		{317, 3, 1, uint32(predictor)},
		{322, 3, 1, uint32(tW)}, // TileWidth
		{323, 3, 1, uint32(tH)}, // TileLength
		{324, 4, 1, 0},          // TileOffsets, patched below
		{325, 4, 1, uint32(len(data))},
		{339, 3, 1, uint32(fmtCode)}, // SampleFormat
		{33550, 12, 3, 0},            // ModelPixelScale, patched
		{33922, 12, 6, 0},            // ModelTiepoint, patched
	}
	ifdOff := 8
	ifdLen := 2 + len(tags)*12 + 4
	valOff := ifdOff + ifdLen
	scaleOff := valOff
	tieOff := scaleOff + len(scale)*8
	pixOff := tieOff + len(tie)*8
	for i := range tags {
		switch tags[i].tag {
		case 324:
			tags[i].value = uint32(pixOff)
		case 33550:
			tags[i].value = uint32(scaleOff)
		case 33922:
			tags[i].value = uint32(tieOff)
		}
	}

	buf := &bytes.Buffer{}
	buf.WriteString("II")
	binary.Write(buf, binary.LittleEndian, uint16(42))
	binary.Write(buf, binary.LittleEndian, uint32(ifdOff))
	binary.Write(buf, binary.LittleEndian, uint16(len(tags)))
	for _, g := range tags {
		binary.Write(buf, binary.LittleEndian, g.tag)
		binary.Write(buf, binary.LittleEndian, g.typ)
		binary.Write(buf, binary.LittleEndian, g.count)
		binary.Write(buf, binary.LittleEndian, g.value)
	}
	binary.Write(buf, binary.LittleEndian, uint32(0)) // no next IFD
	for _, v := range scale {
		binary.Write(buf, binary.LittleEndian, v)
	}
	for _, v := range tie {
		binary.Write(buf, binary.LittleEndian, v)
	}
	buf.Write(data)
	return buf.Bytes()
}

// ground is the surface both encodings carry: a ramp with a spike, so a
// mis-decoded predictor cannot accidentally agree.
func ground(x, y int) float64 {
	v := float64(100 + x*7 + y*3)
	if x == 40 && y == 20 {
		v = 4808
	}
	return v
}

func TestReadGeoTIFFInt16Uncompressed(t *testing.T) {
	block := make([]byte, tW*tH*2)
	for y := 0; y < tH; y++ {
		for x := 0; x < tW; x++ {
			binary.LittleEndian.PutUint16(block[(y*tW+x)*2:], uint16(int16(ground(x, y))))
		}
	}
	g, err := ReadGeoTIFF(bytes.NewReader(buildTIFF(t, 16, 2, 1, block,
		[]float64{step, step, 0}, []float64{0, 0, 0, 6, 46, 0})), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if g.W != tW || g.H != tH {
		t.Fatalf("grid %dx%d", g.W, g.H)
	}
	for y := 0; y < tH; y++ {
		for x := 0; x < tW; x++ {
			if got, want := float64(g.Data[y*tW+x]), ground(x, y); got != want {
				t.Fatalf("int16 pixel %d,%d = %v, want %v", x, y, got, want)
			}
		}
	}
	// The tie point is the first POST, and 64 posts span 63 intervals, so a
	// step of 1/63 covers exactly one degree. This is the semantics the real
	// sources rely on: a 3601-post NASADEM tile is one degree, not 3601/3600.
	w, s, e, n := g.Bounds()
	const eps = 1e-9
	if math.Abs(w-6) > eps || math.Abs(n-46) > eps ||
		math.Abs(e-7) > eps || math.Abs(s-45) > eps {
		t.Fatalf("bounds %v,%v,%v,%v want 6,45,7,46", w, s, e, n)
	}
}

// The one that had the bug. Predictor 3 shuffles each row into byte planes
// (all the most significant bytes, then all the seconds, ...) and then
// differences ACROSS THE WHOLE SHUFFLED ROW, byte by byte. Undifferencing with
// any other stride yields numbers, not an error.
func TestReadGeoTIFFFloat32WithTheFloatingPointPredictor(t *testing.T) {
	const n = 4 // bytes per sample
	block := make([]byte, tW*tH*n)
	for y := 0; y < tH; y++ {
		row := make([]byte, tW*n)
		for x := 0; x < tW; x++ {
			bits := math.Float32bits(float32(ground(x, y)))
			// Big-endian across the planes, whatever the file's byte order.
			for p := 0; p < n; p++ {
				row[p*tW+x] = byte(bits >> (8 * uint(n-1-p)))
			}
		}
		for i := len(row) - 1; i > 0; i-- {
			row[i] -= row[i-1]
		}
		copy(block[y*tW*n:], row)
	}
	g, err := ReadGeoTIFF(bytes.NewReader(buildTIFF(t, 32, 3, 3, block,
		[]float64{step, step, 0}, []float64{0, 0, 0, 6, 46, 0})), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	for y := 0; y < tH; y++ {
		for x := 0; x < tW; x++ {
			if got, want := float64(g.Data[y*tW+x]), ground(x, y); got != want {
				t.Fatalf("float32 pixel %d,%d = %v, want %v", x, y, got, want)
			}
		}
	}
	// The spike specifically: a smoothed or mis-strided decode loses it.
	if v, ok := g.Nearest(6+40*step, 46-20*step); !ok || v != 4808 {
		t.Fatalf("the summit read %v (ok=%v), want 4808", v, ok)
	}
}

func TestReadGeoTIFFRefusesAPredictorItCannotUndo(t *testing.T) {
	block := make([]byte, tW*tH*2)
	if _, err := ReadGeoTIFF(bytes.NewReader(buildTIFF(t, 16, 2, 9, block,
		[]float64{1, 1, 0}, []float64{0, 0, 0, 0, 0, 0})), 1<<20); err == nil {
		t.Fatal("an unknown predictor decoded silently")
	}
}
