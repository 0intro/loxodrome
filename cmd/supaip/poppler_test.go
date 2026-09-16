package main

import (
	"strings"
	"testing"
)

// A minimal pdftotext -bbox-layout document: two pages, with two lines on the
// first (top above bottom) to exercise the Y flip, page grouping, and the
// no-space word join the downstream parsers expect.
const bboxFixture = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml"><body><doc>
  <page width="595.000000" height="842.000000">
    <flow><block>
      <line>
        <word xMin="50" yMin="100" xMax="80" yMax="112">ZRT</word>
        <word xMin="84" yMin="100" xMax="140" yMax="112">EXAMPLE</word>
      </line>
      <line>
        <word xMin="50" yMin="200" xMax="160" yMax="212">48&#176;42'14"N</word>
      </line>
    </block></flow>
  </page>
  <page width="595.000000" height="842.000000">
    <flow><block><line>
      <word xMin="50" yMin="80" xMax="160" yMax="92">SECONDPAGE</word>
    </line></block></flow>
  </page>
</doc></body></html>`

func TestParseBboxLayout(t *testing.T) {
	rows, err := parseBboxLayout([]byte(bboxFixture))
	if err != nil {
		t.Fatalf("parseBboxLayout: %v", err)
	}
	if len(rows) != 3 {
		t.Fatalf("rows = %d, want 3 (2 on page 1, 1 on page 2)", len(rows))
	}
	// Top-to-bottom within a page (Y flipped), then page order preserved.
	if got := rows[0].text(); got != "ZRTEXAMPLE" {
		t.Errorf("row 0 = %q, want %q (words joined without spaces)", got, "ZRTEXAMPLE")
	}
	if got := rows[1].text(); !strings.Contains(got, "°42'14\"N") {
		t.Errorf("row 1 = %q, want the degree-bearing coordinate preserved", got)
	}
	if got := rows[2].text(); got != "SECONDPAGE" {
		t.Errorf("row 2 = %q, want %q (second page)", got, "SECONDPAGE")
	}
}
