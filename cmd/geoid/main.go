// Command geoid turns the EGM96 geoid grid into the generated TypeScript
// module the SPA embeds (src/lib/nav/geoidData.ts): the geoid undulation N,
// the height of mean sea level above the WGS84 ellipsoid, which is what
// converts a GNSS altitude into an altitude a pilot can compare with a
// published one.
//
// EGM96 is a fixed model, so this is a one-off, hand-run generator with no
// workflow (the cmd/designators posture, more so: there is no new edition to
// track). The input is GeographicLib's egm96-15 distribution of the NGA grid,
// a 16-bit PGM carrying Offset / Scale in its header:
//
//	curl -L -o egm96-15.tar.bz2 \
//	    https://downloads.sourceforge.net/project/geographiclib/geoids-distrib/egm96-15.tar.bz2
//	tar xjf egm96-15.tar.bz2
//	go run ./cmd/geoid -in geoids/egm96-15.pgm
//
// EGM96 is a US Government work (NGA / NASA), public domain and freely
// redistributable, which is why the derived grid can ship in the bundle;
// About credits it.
//
// The output is subsampled to a whole-degree lattice and quantised to Int8
// metres, base64-encoded. Both choices are measured, not assumed: against the
// full 15-minute grid, whole-degree bilinear reconstruction lands at 0.49 m
// RMS worldwide (0.53 m over western Europe) with a 13.8 m worst case in the
// steepest ocean gradients, and metre quantisation contributes 0.04 m of
// that. The correction being made is around 50 m and GNSS vertical error is
// 10 to 15 m, so the grid is nowhere near the limiting term. Halving the step
// again would quadruple 87 kB of source for 0.5 m.
package main

import (
	"bufio"
	"encoding/base64"
	"encoding/binary"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// The emitted lattice: one node per degree, latitude +90 down to -90 and
// longitude -180 through +180 INCLUSIVE. The repeated antimeridian column
// costs 181 bytes and lets the reader interpolate without a wrap branch.
const (
	stepDeg = 1
	rows    = 180/stepDeg + 1
	cols    = 360/stepDeg + 1
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	in := flag.String("in", "", "EGM96 geoid grid, GeographicLib PGM (required)")
	out := flag.String("out", "src/lib/nav/geoidData.ts", "generated TypeScript module (run from the repo root)")
	flag.Parse()
	if *in == "" {
		return fmt.Errorf("-in is required")
	}
	g, err := readPGM(*in)
	if err != nil {
		return fmt.Errorf("%s: %w", *in, err)
	}
	grid := subsample(g)
	if err := os.MkdirAll(filepath.Dir(*out), 0o755); err != nil {
		return err
	}
	return os.WriteFile(*out, render(grid, g.description), 0o644)
}

// pgm is a GeographicLib geoid grid: 16-bit big-endian samples over the whole
// globe, value = offset + scale*sample, row 0 at 90N and column 0 at 0E.
type pgm struct {
	width, height int
	offset, scale float64
	description   string
	samples       []uint16
}

// at returns the undulation (m) at grid row/column, wrapping in longitude.
func (p *pgm) at(row, col int) float64 {
	col = ((col % p.width) + p.width) % p.width
	return p.offset + p.scale*float64(p.samples[row*p.width+col])
}

func readPGM(path string) (*pgm, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	h := &header{r: bufio.NewReaderSize(f, 1<<16)}

	magic, err := h.token()
	if err != nil {
		return nil, err
	}
	if magic != "P5" {
		return nil, fmt.Errorf("not a binary PGM (magic %q)", magic)
	}
	dims := make([]int, 0, 3)
	for len(dims) < 3 {
		t, err := h.token()
		if err != nil {
			return nil, err
		}
		n, err := strconv.Atoi(t)
		if err != nil {
			return nil, fmt.Errorf("bad header field %q", t)
		}
		dims = append(dims, n)
	}
	g := &pgm{width: dims[0], height: dims[1]}
	if dims[2] != 65535 {
		return nil, fmt.Errorf("expected a 16-bit grid, got maxval %d", dims[2])
	}
	// The header comments carry Offset and Scale, without which the samples
	// are meaningless; the tokeniser collected them as it skipped them.
	for _, c := range h.comments {
		switch {
		case strings.HasPrefix(c, "Offset "):
			g.offset, err = strconv.ParseFloat(strings.TrimSpace(c[len("Offset "):]), 64)
		case strings.HasPrefix(c, "Scale "):
			g.scale, err = strconv.ParseFloat(strings.TrimSpace(c[len("Scale "):]), 64)
		case strings.HasPrefix(c, "Description "):
			g.description = strings.TrimSpace(c[len("Description "):])
		}
		if err != nil {
			return nil, fmt.Errorf("bad header comment %q: %w", c, err)
		}
	}
	if g.scale == 0 {
		return nil, fmt.Errorf("header carries no Scale")
	}
	// The single whitespace byte separating the header from the raster is the
	// one the tokeniser consumed to terminate maxval, so the reader is already
	// positioned on the first sample.
	r := h.r
	raw := make([]byte, 2*g.width*g.height)
	if _, err := io.ReadFull(r, raw); err != nil {
		return nil, fmt.Errorf("short raster: %w", err)
	}
	g.samples = make([]uint16, g.width*g.height)
	for i := range g.samples {
		g.samples[i] = binary.BigEndian.Uint16(raw[2*i:])
	}
	return g, nil
}

// header tokenises the PGM header, keeping the '#' lines it skips: Offset and
// Scale live in them, and they are only wanted once the dimensions are known.
type header struct {
	r        *bufio.Reader
	comments []string
}

// token reads the next whitespace-delimited header token, skipping comments.
func (h *header) token() (string, error) {
	var b strings.Builder
	for {
		c, err := h.r.ReadByte()
		if err != nil {
			return "", err
		}
		if c == '#' {
			line, err := h.r.ReadString('\n')
			if err != nil {
				return "", err
			}
			h.comments = append(h.comments, strings.TrimSpace(line))
			continue
		}
		if c == ' ' || c == '\t' || c == '\r' || c == '\n' {
			if b.Len() > 0 {
				return b.String(), nil
			}
			continue
		}
		b.WriteByte(c)
	}
}

// subsample picks the whole-degree nodes out of the source grid. Every node
// falls exactly on a source sample (the source step divides a degree), so
// this is an exact subsample, never an interpolation of an interpolation.
func subsample(g *pgm) []int8 {
	out := make([]int8, rows*cols)
	latStep := float64(g.height-1) / 180 // source rows per degree of latitude
	lonStep := float64(g.width) / 360    // source columns per degree of longitude
	for i := 0; i < rows; i++ {
		lat := 90 - float64(i*stepDeg)
		row := int(((90 - lat) * latStep) + 0.5)
		if row > g.height-1 {
			row = g.height - 1
		}
		for j := 0; j < cols; j++ {
			lon := -180 + float64(j*stepDeg)
			col := int((((lon + 360) * lonStep) + 0.5))
			out[i*cols+j] = int8(roundHalfAway(g.at(row, col)))
		}
	}
	return out
}

func roundHalfAway(v float64) float64 {
	if v < 0 {
		return -float64(int(-v + 0.5))
	}
	return float64(int(v + 0.5))
}

func render(grid []int8, description string) []byte {
	raw := make([]byte, len(grid))
	for i, v := range grid {
		raw[i] = byte(v)
	}
	var b strings.Builder
	fmt.Fprintf(&b, `/* GENERATED by cmd/geoid; do not edit.
 *
 * EGM96 geoid undulation N (metres), the height of mean sea level above the
 * WGS84 ellipsoid, on a %d-degree lattice: %d rows from 90N to 90S, %d columns
 * from 180W to 180E inclusive (the antimeridian column is repeated so the
 * reader needs no wrap branch), one signed byte per node.
 *
 * Source: %s, NGA / NASA, a US Government work in the public domain,
 * via GeographicLib's egm96-15 distribution. Credited in About.
 *
 * Quantised to whole metres: against the full 15-minute grid this lattice
 * reconstructs to 0.49 m RMS worldwide (0.53 m over western Europe), which is
 * immaterial beside 10 to 15 m of GNSS vertical error. Read it through
 * nav/geoid.ts, never directly. */

export const GEOID_STEP_DEG = %d;
export const GEOID_ROWS = %d;
export const GEOID_COLS = %d;

/** Base64 of the row-major Int8 lattice, wrapped; nav/geoid.ts strips the
 *  whitespace and decodes it once. */
export const GEOID_B64 = `+"`"+`%s`+"`"+`;
`, stepDeg, rows, cols, description, stepDeg, rows, cols, wrap(base64.StdEncoding.EncodeToString(raw), 96))
	return []byte(b.String())
}

// wrap breaks a long string into newline-separated chunks, so the generated
// module stays a file a human can open.
func wrap(s string, width int) string {
	var b strings.Builder
	for i := 0; i < len(s); i += width {
		end := i + width
		if end > len(s) {
			end = len(s)
		}
		b.WriteByte('\n')
		b.WriteString(s[i:end])
	}
	b.WriteByte('\n')
	return b.String()
}
