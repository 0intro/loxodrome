package terrain

// The other two source formats the mosaic ingests, both trivial beside the
// GeoTIFF: a raw grid of posts (SRTM / NASADEM HGT) and a text grid (the
// ESRI ASCII format IGN, and several other national agencies, ship).

import (
	"bufio"
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"
)

// ReadHGT decodes an SRTM / NASADEM tile: nothing but big-endian int16
// metres, one post per sample, square, with the file NAME carrying the
// position of its south-west post. -32768 is the void marker the format has
// always used.
//
//	N45E006.hgt  1201x1201 (3 arc-second) or 3601x3601 (1 arc-second)
func ReadHGT(r io.Reader, name string) (*Grid, error) {
	lat, lon, err := hgtCorner(name)
	if err != nil {
		return nil, err
	}
	raw, err := io.ReadAll(io.LimitReader(r, 3601*3601*2+1))
	if err != nil {
		return nil, fmt.Errorf("hgt: %w", err)
	}
	n := int(math.Round(math.Sqrt(float64(len(raw) / 2))))
	if n*n*2 != len(raw) || n < 2 {
		return nil, fmt.Errorf("hgt: %d bytes is not a square grid", len(raw))
	}
	g := &Grid{
		W: n, H: n,
		// The posts span the whole degree inclusive of both edges, so the
		// step is one degree over the INTERVALS, not over the posts.
		Lon0: lon, Lat0: lat + 1,
		StepLon: 1 / float64(n-1), StepLat: 1 / float64(n-1),
		Data:      make([]float32, n*n),
		NoData:    -32768,
		HasNoData: true,
	}
	for i := range g.Data {
		g.Data[i] = float32(int16(uint16(raw[i*2])<<8 | uint16(raw[i*2+1])))
	}
	return g, nil
}

// hgtCorner reads the south-west post out of an HGT file name, which is the
// only place it is recorded.
func hgtCorner(name string) (lat, lon float64, err error) {
	s := strings.ToUpper(name)
	if i := strings.LastIndexAny(s, "/\\"); i >= 0 {
		s = s[i+1:]
	}
	if len(s) < 7 {
		return 0, 0, fmt.Errorf("hgt: %q does not name a position", name)
	}
	var ns, ew byte
	var la, lo int
	if _, err := fmt.Sscanf(s[:7], "%c%2d%c%3d", &ns, &la, &ew, &lo); err != nil {
		return 0, 0, fmt.Errorf("hgt: %q does not name a position", name)
	}
	lat, lon = float64(la), float64(lo)
	if ns == 'S' {
		lat = -lat
	} else if ns != 'N' {
		return 0, 0, fmt.Errorf("hgt: %q: hemisphere %q", name, string(ns))
	}
	if ew == 'W' {
		lon = -lon
	} else if ew != 'E' {
		return 0, 0, fmt.Errorf("hgt: %q: meridian %q", name, string(ew))
	}
	return lat, lon, nil
}

// AsciiGrid is an ESRI ASCII grid: a six-line header and then the rows, north
// to south. `xllcorner` ties the grid's outer corner and `xllcenter` its
// first post, which is a half-cell difference and the one thing to get right.
//
// The values are in the file's own projected CRS, so the caller hands the
// inverse projection that turns them into longitude and latitude; the grid
// this returns is therefore a PROJECTED one, and only ProjectedGrid reads it.
func ReadAsciiGrid(r io.Reader) (*ProjectedGrid, error) {
	br := bufio.NewReaderSize(r, 1<<20)
	head := map[string]float64{}
	var cols, rows int
	for len(head) < 6 {
		line, err := br.ReadString('\n')
		if err != nil {
			return nil, fmt.Errorf("asc: header: %w", err)
		}
		f := strings.Fields(line)
		if len(f) != 2 {
			return nil, fmt.Errorf("asc: header line %q", strings.TrimSpace(line))
		}
		v, err := strconv.ParseFloat(f[1], 64)
		if err != nil {
			return nil, fmt.Errorf("asc: header %q: %w", f[0], err)
		}
		head[strings.ToLower(f[0])] = v
		if len(head) == 6 {
			break
		}
	}
	cols, rows = int(head["ncols"]), int(head["nrows"])
	size := head["cellsize"]
	if cols <= 0 || rows <= 0 || size <= 0 {
		return nil, fmt.Errorf("asc: %d x %d cells of %g", cols, rows, size)
	}
	x0, okX := head["xllcenter"]
	y0, okY := head["yllcenter"]
	if !okX || !okY {
		// Corner-tied: the first post sits half a cell inside it.
		x0, okX = head["xllcorner"]
		y0, okY = head["yllcorner"]
		if !okX || !okY {
			return nil, fmt.Errorf("asc: no xll/yll origin")
		}
		x0 += size / 2
		y0 += size / 2
	}
	nodata, hasNoData := head["nodata_value"]

	g := &ProjectedGrid{
		W: cols, H: rows,
		X0: x0, Y0: y0 + float64(rows-1)*size, // row 0 is the NORTH row
		Step:      size,
		Data:      make([]float32, cols*rows),
		NoData:    float32(nodata),
		HasNoData: hasNoData,
	}
	sc := bufio.NewScanner(br)
	sc.Buffer(make([]byte, 1<<20), 1<<26)
	sc.Split(splitFields)
	for i := 0; i < cols*rows; i++ {
		if !sc.Scan() {
			return nil, fmt.Errorf("asc: %d values, want %d", i, cols*rows)
		}
		v, err := strconv.ParseFloat(sc.Text(), 64)
		if err != nil {
			return nil, fmt.Errorf("asc: value %d: %w", i, err)
		}
		g.Data[i] = float32(v)
	}
	return g, sc.Err()
}

// splitFields is bufio.ScanWords without its rune decoding: the grids are
// millions of ASCII numbers and this is the whole cost of reading one.
func splitFields(data []byte, atEOF bool) (advance int, token []byte, err error) {
	i := 0
	for i < len(data) && isSpaceByte(data[i]) {
		i++
	}
	j := i
	for j < len(data) && !isSpaceByte(data[j]) {
		j++
	}
	if j < len(data) || atEOF {
		if j == i {
			return i, nil, nil
		}
		return j, data[i:j], nil
	}
	return i, nil, nil
}

func isSpaceByte(c byte) bool {
	return c == ' ' || c == '\t' || c == '\n' || c == '\r'
}
