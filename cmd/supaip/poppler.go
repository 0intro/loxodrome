// poppler.go: a fallback PDF text extractor using the external `pdftotext`
// (poppler-utils) for the supplements rsc.io/pdf cannot read, chiefly the
// Acrobat-Distiller files where the pure-Go reader panics. `pdftotext
// -bbox-layout` emits every word with its bounding box; we turn each word into
// a positioned fragment and run it through the SAME row/cell reconstruction as
// the native path (pageRows / splitCells), so the geometry and activation
// parsers are unchanged. When pdftotext is absent or fails, the caller treats
// the supplement as geometry-less, exactly as before this fallback existed.

package main

import (
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
	"strings"

	"github.com/0intro/loxodrome/internal/pdftext"
	"rsc.io/pdf"
)

// runPdftotext runs pdftotext with the given arguments, feeding data on
// stdin and returning its stdout. The exec itself (and its timeout) lives
// in internal/pdftext, shared with cmd/es: two copies of the kill/WaitDelay
// semantics would drift.
func runPdftotext(data []byte, args ...string) ([]byte, error) {
	return pdftext.Run(data, args...)
}

// bboxWord is one <word> from pdftotext -bbox-layout, with its bounding box.
type bboxWord struct {
	XMin float64 `xml:"xMin,attr"`
	YMin float64 `xml:"yMin,attr"`
	XMax float64 `xml:"xMax,attr"`
	YMax float64 `xml:"yMax,attr"`
	Text string  `xml:",chardata"`
}

// pdftotextRows extracts rows with poppler's pdftotext as a fallback. It reads
// the PDF on stdin and parses the -bbox-layout XML, grouping words into the
// same prow / cell structure the native extractor produces. Returns an error
// when pdftotext is unavailable or fails (a missing binary degrades to "no
// geometry", never a crash).
func pdftotextRows(data []byte) ([]prow, error) {
	out, err := runPdftotext(data, "-bbox-layout", "-", "-")
	if err != nil {
		return nil, err
	}
	return parseBboxLayout(out)
}

// parseBboxLayout turns pdftotext -bbox-layout XHTML into reconstructed rows,
// one page at a time (each page's words are reconstructed independently, as in
// the native path). The XHTML carries a namespace and a doctype, so we stream
// tokens by local name rather than unmarshalling a fixed tree.
func parseBboxLayout(xmlData []byte) ([]prow, error) {
	dec := xml.NewDecoder(bytes.NewReader(xmlData))
	dec.Strict = false // tolerate the XHTML doctype / HTML entities

	var rows []prow
	var frags []pdf.Text
	flushPage := func() {
		if len(frags) > 0 {
			rows = append(rows, pageRows(frags)...)
			frags = frags[:0]
		}
	}
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("pdftotext xml: %w", err)
		}
		se, ok := tok.(xml.StartElement)
		if !ok {
			continue
		}
		switch se.Name.Local {
		case "page":
			flushPage() // start of a new page: emit the previous page's rows
		case "word":
			var w bboxWord
			if err := dec.DecodeElement(&w, &se); err != nil {
				return nil, fmt.Errorf("pdftotext xml: %w", err)
			}
			s := strings.TrimSpace(w.Text)
			if s == "" {
				continue
			}
			// pdftotext is top-origin (smaller yMin is higher); negate so the
			// reconstruction's top-to-bottom (Y descending) ordering holds. The
			// word height feeds the row-grouping tolerance.
			frags = append(frags, pdf.Text{X: w.XMin, Y: -w.YMin, FontSize: w.YMax - w.YMin, S: s})
		}
	}
	flushPage()
	return rows, nil
}
