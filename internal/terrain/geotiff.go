package terrain

// A GeoTIFF reader for the elevation products this builder ingests, and for
// nothing else. It reads what Copernicus GLO actually ships (classic TIFF,
// one 32-bit float sample, Adobe deflate, the floating-point predictor,
// tiled, EPSG:4326, RasterPixelIsPoint) plus the 16-bit integer variant
// several national products use, and REFUSES anything else by name rather
// than guessing: a DEM decoded on a wrong assumption is terrain in the wrong
// place, and there is no downstream check that would catch it.
//
// It is written here rather than taken as a dependency for the reason the
// rest of this repository's parsers are: golang.org/x/image/tiff decodes to
// an image.Image, which is 8 or 16 bits per channel, and elevation is
// neither. The module has two dependencies and this is 300 lines.

import (
	"bytes"
	"compress/zlib"
	"encoding/binary"
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"
)

const (
	tagImageWidth      = 256
	tagImageLength     = 257
	tagBitsPerSample   = 258
	tagCompression     = 259
	tagStripOffsets    = 273
	tagSamplesPerPixel = 277
	tagRowsPerStrip    = 278
	tagStripByteCounts = 279
	tagPlanarConfig    = 284
	tagPredictor       = 317
	tagTileWidth       = 322
	tagTileLength      = 323
	tagTileOffsets     = 324
	tagTileByteCounts  = 325
	tagSampleFormat    = 339
	tagModelPixelScale = 33550
	tagModelTiepoint   = 33922
	tagGeoKeyDirectory = 34735
	tagGDALNoData      = 42113
)

type ifdEntry struct {
	typ    uint16
	count  uint64
	offset uint64
	inline [4]byte
}

type tiffReader struct {
	r    io.ReaderAt
	ord  binary.ByteOrder
	tags map[uint16]ifdEntry
}

func typeSize(t uint16) int {
	switch t {
	case 1, 2, 6, 7: // BYTE, ASCII, SBYTE, UNDEFINED
		return 1
	case 3, 8: // SHORT, SSHORT
		return 2
	case 4, 9, 11: // LONG, SLONG, FLOAT
		return 4
	case 5, 10, 12: // RATIONAL, SRATIONAL, DOUBLE
		return 8
	}
	return 0
}

func (t *tiffReader) bytesAt(off uint64, n int) ([]byte, error) {
	b := make([]byte, n)
	if _, err := t.r.ReadAt(b, int64(off)); err != nil {
		return nil, err
	}
	return b, nil
}

// uints reads a tag's values as unsigned integers, which is what every tag
// this reader cares about except the doubles and the nodata string is.
func (t *tiffReader) uints(tag uint16) ([]uint64, error) {
	e, ok := t.tags[tag]
	if !ok {
		return nil, nil
	}
	size := typeSize(e.typ)
	if size == 0 {
		return nil, fmt.Errorf("tag %d: type %d", tag, e.typ)
	}
	total := int(e.count) * size
	var raw []byte
	if total <= 4 {
		raw = e.inline[:total]
	} else {
		var err error
		if raw, err = t.bytesAt(e.offset, total); err != nil {
			return nil, err
		}
	}
	out := make([]uint64, e.count)
	for i := range out {
		switch size {
		case 1:
			out[i] = uint64(raw[i])
		case 2:
			out[i] = uint64(t.ord.Uint16(raw[i*2:]))
		case 4:
			out[i] = uint64(t.ord.Uint32(raw[i*4:]))
		case 8:
			out[i] = t.ord.Uint64(raw[i*8:])
		}
	}
	return out, nil
}

func (t *tiffReader) doubles(tag uint16) ([]float64, error) {
	e, ok := t.tags[tag]
	if !ok {
		return nil, nil
	}
	if e.typ != 12 {
		return nil, fmt.Errorf("tag %d: type %d, want DOUBLE", tag, e.typ)
	}
	raw, err := t.bytesAt(e.offset, int(e.count)*8)
	if err != nil {
		return nil, err
	}
	out := make([]float64, e.count)
	for i := range out {
		out[i] = math.Float64frombits(t.ord.Uint64(raw[i*8:]))
	}
	return out, nil
}

func (t *tiffReader) ascii(tag uint16) (string, error) {
	e, ok := t.tags[tag]
	if !ok {
		return "", nil
	}
	var raw []byte
	if e.count <= 4 {
		raw = e.inline[:e.count]
	} else {
		var err error
		if raw, err = t.bytesAt(e.offset, int(e.count)); err != nil {
			return "", err
		}
	}
	return strings.TrimRight(string(raw), "\x00"), nil
}

func first(v []uint64, def uint64) uint64 {
	if len(v) == 0 {
		return def
	}
	return v[0]
}

// GeoTIFFBounds reads only the tags, so a directory of rasters can be indexed
// by extent without decoding a pixel of any of them.
func GeoTIFFBounds(r io.ReaderAt) (west, south, east, north float64, err error) {
	t, w, h, err := openTIFF(r)
	if err != nil {
		return 0, 0, 0, 0, err
	}
	g := &Grid{W: w, H: h}
	if err := t.geoTransform(g); err != nil {
		return 0, 0, 0, 0, err
	}
	west, south, east, north = g.Bounds()
	return west, south, east, north, nil
}

// openTIFF parses the header and the first IFD.
func openTIFF(r io.ReaderAt) (*tiffReader, int, int, error) {
	head := make([]byte, 8)
	if _, err := r.ReadAt(head, 0); err != nil {
		return nil, 0, 0, fmt.Errorf("tiff: header: %w", err)
	}
	var ord binary.ByteOrder
	switch string(head[:2]) {
	case "II":
		ord = binary.LittleEndian
	case "MM":
		ord = binary.BigEndian
	default:
		return nil, 0, 0, fmt.Errorf("tiff: not a TIFF (%q)", head[:2])
	}
	switch ord.Uint16(head[2:]) {
	case 42:
	case 43:
		return nil, 0, 0, fmt.Errorf("tiff: BigTIFF is not read here")
	default:
		return nil, 0, 0, fmt.Errorf("tiff: magic %d", ord.Uint16(head[2:]))
	}
	t := &tiffReader{r: r, ord: ord, tags: map[uint16]ifdEntry{}}
	ifd := int64(ord.Uint32(head[4:]))
	cntBuf := make([]byte, 2)
	if _, err := r.ReadAt(cntBuf, ifd); err != nil {
		return nil, 0, 0, fmt.Errorf("tiff: ifd: %w", err)
	}
	n := int(ord.Uint16(cntBuf))
	entries := make([]byte, n*12)
	if _, err := r.ReadAt(entries, ifd+2); err != nil {
		return nil, 0, 0, fmt.Errorf("tiff: ifd entries: %w", err)
	}
	for i := 0; i < n; i++ {
		b := entries[i*12:]
		e := ifdEntry{typ: ord.Uint16(b[2:]), count: uint64(ord.Uint32(b[4:]))}
		copy(e.inline[:], b[8:12])
		e.offset = uint64(ord.Uint32(b[8:]))
		t.tags[ord.Uint16(b)] = e
	}
	w, err := t.uints(tagImageWidth)
	if err != nil {
		return nil, 0, 0, err
	}
	h, err := t.uints(tagImageLength)
	if err != nil {
		return nil, 0, 0, err
	}
	if len(w) == 0 || len(h) == 0 {
		return nil, 0, 0, fmt.Errorf("tiff: no size")
	}
	width, height := int(w[0]), int(h[0])
	if width <= 0 || height <= 0 || int64(width)*int64(height) > 200<<20 {
		return nil, 0, 0, fmt.Errorf("tiff: %dx%d", width, height)
	}
	return t, width, height, nil
}

// geoTransform fills a grid's geographic placement from the model tags.
func (t *tiffReader) geoTransform(g *Grid) error {
	scale, err := t.doubles(tagModelPixelScale)
	if err != nil {
		return err
	}
	tie, err := t.doubles(tagModelTiepoint)
	if err != nil {
		return err
	}
	if len(scale) < 2 || len(tie) < 6 {
		return fmt.Errorf("tiff: no geographic transform")
	}
	g.StepLon, g.StepLat = scale[0], scale[1]
	// The tiepoint maps a raster point to a model one; these products tie
	// raster (0,0).
	g.Lon0 = tie[3] - tie[0]*scale[0]
	g.Lat0 = tie[4] + tie[1]*scale[1]
	if keys, err := t.uints(tagGeoKeyDirectory); err == nil && len(keys) >= 4 {
		for i := 4; i+3 < len(keys); i += 4 {
			// 1025 GTRasterTypeGeoKey: 1 = area, 2 = point. An area raster
			// ties the CORNER, so its samples sit half a cell inside.
			if keys[i] == 1025 && keys[i+3] == 1 {
				g.Lon0 += scale[0] / 2
				g.Lat0 -= scale[1] / 2
			}
			if keys[i] == 2048 && keys[i+3] != 4326 {
				return fmt.Errorf("tiff: geographic CRS %d, want 4326", keys[i+3])
			}
		}
	}
	if g.StepLon <= 0 || g.StepLat <= 0 {
		return fmt.Errorf("tiff: pixel scale %v", scale[:2])
	}
	return nil
}

// ReadGeoTIFF decodes one elevation raster. `size` is the file's length, so a
// truncated download is refused rather than read as a short grid.
func ReadGeoTIFF(r io.ReaderAt, size int64) (*Grid, error) {
	t, width, height, err := openTIFF(r)
	if err != nil {
		return nil, err
	}
	ord := t.ord

	samples, _ := t.uints(tagSamplesPerPixel)
	if first(samples, 1) != 1 {
		return nil, fmt.Errorf("tiff: %d samples per pixel, want 1", first(samples, 1))
	}
	if planar, _ := t.uints(tagPlanarConfig); first(planar, 1) != 1 {
		return nil, fmt.Errorf("tiff: planar configuration %d", first(planar, 1))
	}
	bits, _ := t.uints(tagBitsPerSample)
	format, _ := t.uints(tagSampleFormat)
	bps := int(first(bits, 0))
	fmtCode := first(format, 1)
	switch {
	case bps == 32 && fmtCode == 3: // IEEE float
	case bps == 16 && (fmtCode == 2 || fmtCode == 1): // signed / unsigned int
	default:
		return nil, fmt.Errorf("tiff: %d-bit sample format %d", bps, fmtCode)
	}
	comp, _ := t.uints(tagCompression)
	compression := first(comp, 1)
	if compression != 1 && compression != 8 && compression != 32946 {
		return nil, fmt.Errorf("tiff: compression %d (only none and deflate)", compression)
	}
	pred, _ := t.uints(tagPredictor)
	predictor := first(pred, 1)
	if predictor != 1 && predictor != 2 && predictor != 3 {
		return nil, fmt.Errorf("tiff: predictor %d", predictor)
	}

	// Tiles or strips: one code path, since a strip is a tile as wide as the
	// image.
	tw, _ := t.uints(tagTileWidth)
	th, _ := t.uints(tagTileLength)
	var blockW, blockH int
	var offsets, counts []uint64
	if len(tw) > 0 && len(th) > 0 {
		blockW, blockH = int(tw[0]), int(th[0])
		if offsets, err = t.uints(tagTileOffsets); err != nil {
			return nil, err
		}
		if counts, err = t.uints(tagTileByteCounts); err != nil {
			return nil, err
		}
	} else {
		rows, _ := t.uints(tagRowsPerStrip)
		blockW, blockH = width, int(first(rows, uint64(height)))
		if offsets, err = t.uints(tagStripOffsets); err != nil {
			return nil, err
		}
		if counts, err = t.uints(tagStripByteCounts); err != nil {
			return nil, err
		}
	}
	if blockW <= 0 || blockH <= 0 || len(offsets) == 0 || len(offsets) != len(counts) {
		return nil, fmt.Errorf("tiff: %d blocks of %dx%d", len(offsets), blockW, blockH)
	}

	g := &Grid{W: width, H: height, Data: make([]float32, width*height)}
	if s, err := t.ascii(tagGDALNoData); err == nil && s != "" {
		if v, err := strconv.ParseFloat(strings.TrimSpace(s), 64); err == nil {
			g.NoData = float32(v)
			g.HasNoData = true
		}
	}

	across := (width + blockW - 1) / blockW
	sampleBytes := bps / 8
	rowBytes := blockW * sampleBytes
	for i, off := range offsets {
		if int64(off)+int64(counts[i]) > size {
			return nil, fmt.Errorf("tiff: block %d runs past the file", i)
		}
		raw, err := t.bytesAt(off, int(counts[i]))
		if err != nil {
			return nil, err
		}
		if compression != 1 {
			zr, err := zlib.NewReader(bytes.NewReader(raw))
			if err != nil {
				return nil, fmt.Errorf("tiff: block %d: %w", i, err)
			}
			raw, err = io.ReadAll(io.LimitReader(zr, int64(rowBytes)*int64(blockH)+1))
			if err != nil {
				return nil, fmt.Errorf("tiff: block %d: %w", i, err)
			}
			_ = zr.Close()
		}
		if len(raw) < rowBytes*blockH {
			return nil, fmt.Errorf("tiff: block %d is %d bytes, want %d", i, len(raw), rowBytes*blockH)
		}
		bx, by := (i%across)*blockW, (i/across)*blockH
		for r := 0; r < blockH; r++ {
			row := raw[r*rowBytes : (r+1)*rowBytes]
			y := by + r
			if y >= height {
				break
			}
			undoPredictor(row, predictor, sampleBytes, blockW, ord)
			for c := 0; c < blockW; c++ {
				x := bx + c
				if x >= width {
					break
				}
				g.Data[y*width+x] = sampleAt(row, c, bps, fmtCode, predictor, blockW, ord)
			}
		}
	}

	if err := t.geoTransform(g); err != nil {
		return nil, err
	}
	return g, nil
}

// undoPredictor reverses the differencing a writer applied along each row.
// Predictor 2 differences the SAMPLES; predictor 3 (TIFF Technical Note 3)
// differences the BYTES after splitting each sample into byte planes, so a
// float's exponent bytes sit together and compress.
func undoPredictor(row []byte, predictor uint64, sampleBytes, count int, ord binary.ByteOrder) {
	switch predictor {
	case 2:
		for c := 1; c < count; c++ {
			switch sampleBytes {
			case 2:
				v := ord.Uint16(row[c*2:]) + ord.Uint16(row[(c-1)*2:])
				ord.PutUint16(row[c*2:], v)
			case 4:
				v := ord.Uint32(row[c*4:]) + ord.Uint32(row[(c-1)*4:])
				ord.PutUint32(row[c*4:], v)
			}
		}
	case 3:
		// Stride is the SAMPLE count per pixel (one here), not the sample's
		// width: the bytes were shuffled into planes before differencing, so
		// consecutive bytes are the same significance of neighbouring
		// samples. libtiff's fpAcc does exactly this and then de-shuffles.
		for i := 1; i < len(row); i++ {
			row[i] += row[i-1]
		}
	}
}

// sampleAt reads one value out of a decoded row. Under predictor 3 the row is
// still in byte planes: all the most significant bytes of every sample, then
// all the seconds, and so on, with each sample big-endian across the planes
// whatever the file's own byte order is.
func sampleAt(row []byte, c, bps int, fmtCode, predictor uint64, count int, ord binary.ByteOrder) float32 {
	if predictor == 3 {
		var bits uint32
		n := bps / 8
		for p := 0; p < n; p++ {
			bits = bits<<8 | uint32(row[p*count+c])
		}
		if bps == 32 {
			return math.Float32frombits(bits)
		}
		if fmtCode == 2 {
			return float32(int16(uint16(bits)))
		}
		return float32(uint16(bits))
	}
	switch {
	case bps == 32:
		return math.Float32frombits(ord.Uint32(row[c*4:]))
	case fmtCode == 2:
		return float32(int16(ord.Uint16(row[c*2:])))
	default:
		return float32(ord.Uint16(row[c*2:]))
	}
}
