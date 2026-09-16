// supaip_pdf.go: read the supplements ENAIRE publishes as a PDF with no
// HTML edition beside them.
//
// Five of the ~234 supplements in force are in that state, all of them
// old, and one of them (SUP 152/20, "MADRID FIR.- Corredor de Transito
// establecido") is a standing transit corridor with real geometry: a
// pipeline that skipped them would silently lose airspace that is in
// force. `pdftotext -layout` renders those files cleanly, and the layout
// text goes through the SAME grammar the HTML editions use.
//
// A missing pdftotext binary degrades the row to no geometry, exactly as
// cmd/supaip does, and never fails the build.

package main

import (
	"bytes"

	"github.com/0intro/loxodrome/internal/pdftext"
)

// isPDF reports whether the fetched bytes are a PDF rather than HTML.
func isPDF(data []byte) bool {
	return bytes.HasPrefix(bytes.TrimSpace(data), []byte("%PDF"))
}

// pdfLayoutText renders a supplement PDF to layout-preserving text.
func pdfLayoutText(data []byte) (string, error) {
	out, err := pdftext.Run(data, "-layout", "-", "-")
	if err != nil {
		return "", err
	}
	return string(out), nil
}
