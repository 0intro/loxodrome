package pdfcontent

import (
	"errors"
	"fmt"
	"io"

	"rsc.io/pdf"
)

// MaxStream bounds one decoded stream, and PageBudget everything one
// page's walk decodes, its forms included. A form drawn many times over is
// read each time, and a form drawing itself multiplies the reads by its
// fan-out at every level its caller allows, so a recursion bound alone
// counts reads and not bytes. An AIP page decodes tens of kilobytes, a VAC
// plate's chart form a few megabytes.
const (
	MaxStream  = 32 << 20
	PageBudget = 64 << 20
)

// ErrBudget reports a page decoding more than its budget.
var ErrBudget = errors.New("pdfcontent: the page decodes more than its budget")

// Streams decodes the streams one page's walk reads, each bounded by
// MaxStream and all charged to the page's budget. rsc.io/pdf finds the
// objects and applies the filters; nothing here lexes.
type Streams struct {
	left int
}

// NewStreams returns the reader for one page, allowed budget bytes in all.
func NewStreams(budget int) *Streams {
	return &Streams{left: budget}
}

// Stream decodes one stream.
func (s *Streams) Stream(v pdf.Value) ([]byte, error) {
	if v.Kind() != pdf.Stream {
		return nil, errors.New("pdfcontent: not a stream")
	}
	rc := v.Reader()
	defer rc.Close()
	b, err := io.ReadAll(io.LimitReader(rc, MaxStream+1))
	if err != nil {
		return nil, err
	}
	if len(b) > MaxStream {
		return nil, fmt.Errorf("pdfcontent: a stream decodes past %d bytes", MaxStream)
	}
	if s.left -= len(b); s.left < 0 {
		return nil, ErrBudget
	}
	return b, nil
}

// Contents reads a page's /Contents: one stream, or an array of streams
// that is one logical stream (ISO 32000-1 7.8.2), cut anywhere between two
// tokens, "[" included. So the parts are joined, a newline between them
// keeping the last token of one apart from the first of the next, and the
// result is lexed once.
func (s *Streams) Contents(c pdf.Value) ([]byte, error) {
	if c.Kind() != pdf.Array {
		return s.Stream(c)
	}
	var data []byte
	for i := 0; i < c.Len(); i++ {
		b, err := s.Stream(c.Index(i))
		if err != nil {
			return nil, err
		}
		data = append(append(data, b...), '\n')
	}
	return data, nil
}
