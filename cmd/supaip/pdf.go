// pdf.go: pure-Go PDF text extraction (rsc.io/pdf) with layout
// reconstruction. rsc.io/pdf yields positioned text fragments (X,Y
// baselines); we bucket them into visual rows by Y and, within a row, into
// cells split at the wide horizontal gaps. Keeping the per-cell X lets the
// geometry parser tell multi-column coordinate tables (one zone per column)
// apart from a single zone, which a flattened line cannot. No external binary.

package main

import (
	"bytes"
	"fmt"
	"math"
	"sort"
	"strings"

	"rsc.io/pdf"
)

// cell is one horizontal text run on a row, with the X it starts at.
type cell struct {
	x    float64
	text string
}

// prow is one visual row: a baseline Y and the cells left-to-right.
type prow struct {
	y     float64
	cells []cell
}

// text returns the row's cells joined with spaces, for the line-oriented
// parsers (arc prose, FIR/AD line, vertical limits).
func (r prow) text() string {
	parts := make([]string, len(r.cells))
	for i, c := range r.cells {
		parts[i] = c.text
	}
	return strings.Join(parts, " ")
}

// extractRows renders a PDF into reconstructed rows, top-to-bottom. rsc.io/pdf
// panics on some malformed or unsupported PDFs (older Acrobat-Distiller /
// scanned files, exotic font encodings); the panic is recovered into an error
// so the caller treats that supplement as geometry-less rather than crashing
// the whole build.
func extractRows(data []byte) (rows []prow, err error) {
	defer func() {
		if r := recover(); r != nil {
			rows = nil
			err = fmt.Errorf("pdf parse panic: %v", r)
		}
	}()
	rd, err := pdf.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, err
	}
	for i := 1; i <= rd.NumPage(); i++ {
		p := rd.Page(i)
		if p.V.IsNull() {
			continue
		}
		rows = append(rows, pageRows(p.Content().Text)...)
	}
	return rows, nil
}

// pageRows groups one page's fragments into rows of cells.
//
// The SIA mPDF files embed subset fonts with a two-byte encoding rsc.io/pdf
// renders byte-by-byte: a character arrives as a null high-byte fragment plus
// its low-byte fragment, every fragment of a text-show run reports the run's
// start X (W is always 0), space glyphs map to null, and glyphs the decoder
// can't map (the degree sign, accents) arrive as U+FFFD. We drop the null
// fragments, group the rest by baseline Y, and split each row into cells at
// the wide gaps. The degree sign lands as a reliable U+FFFD between digits,
// which the coordinate scanner treats as the degree separator.
func pageRows(text []pdf.Text) []prow {
	if len(text) == 0 {
		return nil
	}
	frags := make([]pdf.Text, len(text))
	copy(frags, text)
	// Top-to-bottom (Y descending; Y increases upward), then left-to-right by
	// run start X. The stable sort preserves emission order within a run.
	sort.SliceStable(frags, func(i, j int) bool {
		if math.Abs(frags[i].Y-frags[j].Y) > 1.0 {
			return frags[i].Y > frags[j].Y
		}
		return frags[i].X < frags[j].X
	})

	var rows []prow
	var line []pdf.Text
	var lineY float64

	flush := func() {
		if cells := splitCells(line); len(cells) > 0 {
			rows = append(rows, prow{y: lineY, cells: cells})
		}
		line = line[:0]
	}

	for _, t := range frags {
		if strings.ReplaceAll(t.S, "\x00", "") == "" {
			continue // null high-byte or unrenderable space glyph
		}
		tol := 0.6 * t.FontSize
		if tol < 2.0 {
			tol = 2.0
		}
		if len(line) > 0 && math.Abs(t.Y-lineY) > tol {
			flush()
		}
		if len(line) == 0 {
			lineY = t.Y
		}
		line = append(line, t)
	}
	flush()
	return rows
}

// splitCells groups a row's fragments into cells, breaking at horizontal gaps
// wider than ~2.5x the row's median fragment gap. mPDF shares one X across a
// whole run (median gap 0), so a break falls only at the wide column gaps;
// Word gives every glyph its own X (median gap is the glyph advance), so a
// break still falls only at the wider inter-column gaps and never inside a
// coordinate.
func splitCells(frags []pdf.Text) []cell {
	if len(frags) == 0 {
		return nil
	}
	// Order strictly left-to-right before measuring gaps. Two side-by-side
	// columns can be staggered in Y by a point or two (e.g. 211/2025's
	// CRUSOE / PEGOUD coordinate tables); the page-wide sort then interleaves
	// them by Y and hides the wide inter-column gap, jamming both coordinates
	// into one cell. A stable X sort restores column order; equal-X runs (the
	// mPDF run-start-X case) keep their emission order.
	frags = append([]pdf.Text(nil), frags...)
	sort.SliceStable(frags, func(i, j int) bool { return frags[i].X < frags[j].X })

	gaps := make([]float64, 0, len(frags))
	for i := 1; i < len(frags); i++ {
		g := frags[i].X - frags[i-1].X
		if g < 0 {
			g = 0
		}
		gaps = append(gaps, g)
	}
	thresh := 1.0
	if len(gaps) > 0 {
		sorted := append([]float64(nil), gaps...)
		sort.Float64s(sorted)
		thresh = sorted[len(sorted)/2]*2.5 + 1.0
	}

	var cells []cell
	var b strings.Builder
	startX := frags[0].X
	for i, t := range frags {
		if i > 0 && frags[i].X-frags[i-1].X > thresh {
			if s := strings.TrimSpace(b.String()); s != "" {
				cells = append(cells, cell{x: startX, text: s})
			}
			b.Reset()
			startX = t.X
		}
		b.WriteString(strings.ReplaceAll(t.S, "\x00", ""))
	}
	if s := strings.TrimSpace(b.String()); s != "" {
		cells = append(cells, cell{x: startX, text: s})
	}
	return cells
}
