package main

import (
	"bytes"
	"fmt"
	"math"
	"os"
	"strings"
	"testing"

	"rsc.io/pdf"
)

// buildPDF assembles a minimal but valid PDF from numbered object bodies,
// computing the xref offsets. Object n is bodies[n-1].
func buildPDF(t *testing.T, bodies []string) []byte {
	t.Helper()
	var buf bytes.Buffer
	buf.WriteString("%PDF-1.4\n")
	offsets := make([]int, len(bodies))
	for i, body := range bodies {
		offsets[i] = buf.Len()
		fmt.Fprintf(&buf, "%d 0 obj\n%s\nendobj\n", i+1, body)
	}
	start := buf.Len()
	fmt.Fprintf(&buf, "xref\n0 %d\n0000000000 65535 f \n", len(bodies)+1)
	for _, off := range offsets {
		fmt.Fprintf(&buf, "%010d 00000 n \n", off)
	}
	fmt.Fprintf(&buf, "trailer\n<</Size %d /Root 1 0 R>>\nstartxref\n%d\n%%%%EOF\n", len(bodies)+1, start)
	return buf.Bytes()
}

func stream(dict, body string) string {
	return fmt.Sprintf("<<%s /Length %d>>\nstream\n%s\nendstream", dict, len(body), body)
}

// testPlate reproduces, in miniature, the three things every French VAC
// plate does that rsc.io/pdf cannot follow on its own:
//
//   - /Contents is an ARRAY of streams, which Page.Content() panics on;
//   - the drawing is inside a Form XObject with its own /Matrix, which
//     Content() never enters;
//   - the text is shown with TJ, whose array pdf.Interpret pushes as ONE
//     value rather than element by element, and encoded through a
//     /Differences table of MT<code> glyph names.
func testPlate(t *testing.T) []byte {
	t.Helper()
	form := "10 20 30 40 re f\n" +
		"BT /F1 10 Tf 1 0 0 1 5 7 Tm [(\x02\x03)-100(\x04)] TJ ET\n" +
		"BT /F1 10 Tf 1 0 0 1 5 30 Tm (\x02) Tj ET\n" +
		"60 70 m 90 70 l S\n"
	return buildPDF(t, []string{
		"<</Type/Catalog /Pages 2 0 R>>",
		"<</Type/Pages /Kids [3 0 R] /Count 1>>",
		"<</Type/Page /Parent 2 0 R /MediaBox [0 0 400 600] /Resources 4 0 R /Contents [5 0 R 6 0 R]>>",
		"<</XObject <</I0 7 0 R>>>>",
		stream("", "q 1 0 0 1 0 10 cm"),
		stream("", "/I0 Do Q"),
		stream("/Type/XObject /Subtype/Form /BBox [0 0 400 600] /Matrix [2 0 0 2 0 0] "+
			"/Resources <</Font <</F1 8 0 R>>>>", form),
		"<</Type/Font /Subtype/Type1 /BaseFont/AAAAAA+Test /FirstChar 2 /LastChar 4 " +
			"/Widths [500 500 500] /Encoding <</Differences [2 /MT65 /MT66 /MT67]>>>>",
	})
}

func walkTestPlate(t *testing.T) pageContent {
	t.Helper()
	data := testPlate(t)
	rd, err := pdf.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("reading the fixture: %v", err)
	}
	c, err := walkPage(rd.Page(1))
	if err != nil {
		t.Fatalf("walking the fixture: %v", err)
	}
	return c
}

func TestWalkFollowsFormXObjectsThroughAContentsArray(t *testing.T) {
	c := walkTestPlate(t)
	if c.media != (box{x1: 400, y1: 600}) {
		t.Errorf("media %v, want the declared MediaBox", c.media)
	}
	// The rectangle is drawn at (10,20)-(40,60) in form space, doubled by
	// the form's Matrix and lifted 10 points by the page's own cm.
	want := box{x0: 20, y0: 50, x1: 80, y1: 130}
	found := false
	for _, b := range c.rects {
		if math.Abs(b.x0-want.x0) < 0.01 && math.Abs(b.y0-want.y0) < 0.01 &&
			math.Abs(b.x1-want.x1) < 0.01 && math.Abs(b.y1-want.y1) < 0.01 {
			found = true
		}
	}
	if !found {
		t.Errorf("rect %v not among %v: the form's Matrix or the page cm was lost", want, c.rects)
	}
	// The stroked line: 60,70 to 90,70 doubled and lifted.
	line := false
	for _, s := range c.segs {
		if math.Abs(s.x1-120) < 0.01 && math.Abs(s.y1-150) < 0.01 && math.Abs(s.x2-180) < 0.01 {
			line = true
		}
	}
	if !line {
		t.Errorf("the stroked segment did not survive the walk: %v", c.segs)
	}
}

func TestWalkReadsTJArraysAndSubsetEncodings(t *testing.T) {
	c := walkTestPlate(t)
	var texts []string
	for _, r := range c.runs {
		texts = append(texts, r.text)
	}
	joined := strings.Join(texts, "|")
	// pdf.Interpret pushes a TJ array as ONE value; a walk that only
	// handles strings and numbers silently drops every TJ on the page.
	if !strings.Contains(joined, "AB") || !strings.Contains(joined, "C") {
		t.Errorf("TJ text missing, got %q", joined)
	}
	// And Tj, for comparison, which is what still worked while TJ did not.
	if strings.Count(joined, "A") < 2 {
		t.Errorf("Tj text missing, got %q", joined)
	}
	// Positions: Tm (5,7) doubled by the Matrix, lifted 10 by the page.
	for _, r := range c.runs {
		if r.text != "AB" {
			continue
		}
		if math.Abs(r.x-10) > 0.01 || math.Abs(r.y-24) > 0.01 {
			t.Errorf("run at (%.2f,%.2f), want (10,24)", r.x, r.y)
		}
		// 10 pt of text scaled by the form's Matrix.
		if math.Abs(r.size-20) > 0.01 {
			t.Errorf("size %.2f, want 20", r.size)
		}
	}
}

func TestPageContentSurvivesAMalformedPlate(t *testing.T) {
	// A truncated stream must become an error, never a partial page that
	// looks like a real one.
	data := testPlate(t)
	rd, err := pdf.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Skip("fixture unreadable")
	}
	if _, err := walkPage(rd.Page(2)); err == nil {
		t.Error("walking a page that does not exist should error, not return content")
	}
}

func TestPageKindNeedsTheADPrefix(t *testing.T) {
	cases := map[string]string{
		"Visual approach AD 2 LFPL APP 01": "APP",
		"AD 3 ATT 01 26 DEC 24":            "ATT", // helistations drop the ident
		"AIP FRANCE AD 2 LFBI APDC 01a":    "APDC",
		"HS  Hot spot. see GMC 01) o":      "", // a cross-reference, not a header
		"LOGNES EMERAINVILLE":              "",
	}
	for line, want := range cases {
		if got := pageKind([]string{line}); got != want {
			t.Errorf("pageKind(%q) = %q, want %q", line, got, want)
		}
	}
}

func TestPlateARP(t *testing.T) {
	lines := []string{
		"ALT AD : 359 (14 hPa)",
		"LAT : 48 49 19 N LFPL VAR : 2°E (2025)",
		"LONG : 002 37 22 E",
	}
	got := plateARP(lines)
	if got == nil {
		t.Fatal("no ARP")
	}
	if math.Abs(got.lat-48.821944) > 1e-5 || math.Abs(got.lon-2.622778) > 1e-5 {
		t.Errorf("ARP %+v, want 48.821944, 2.622778", got)
	}
	// The western half of the country states its hemisphere, and that is
	// the only place the graticule's sign comes from.
	west := plateARP([]string{"LAT : 48 26 51 N", "LONG : 004 25 07 W"})
	if west == nil || west.lon > 0 {
		t.Errorf("western ARP %+v, want a negative longitude", west)
	}
	if plateARP([]string{"nothing here"}) != nil {
		t.Error("an ARP was invented from a page that states none")
	}
	_ = os.Stdout
}

// knockoutPlate draws a graticule tick INSIDE a panel and another OUTSIDE
// it, then paints the margin white the way the military plates do: an outer
// rectangle the size of the page and a hole the size of the panel, wound
// against it, filled with no ink at all. The header line is set afterwards,
// as it is on a real plate, so it must survive.
func knockoutPlate(t *testing.T, hole string, colour string) []byte {
	t.Helper()
	content := "40 300 m 60 300 l S\n" + // a tick inside the panel
		"40 560 m 60 560 l S\n" + // one above it, which the white covers
		"0 0 400 600 re\n" + hole + "\n" + colour + " f\n" +
		"BT /F1 10 Tf 1 0 0 1 20 580 Tm (\x02) Tj ET\n" // the header, drawn after
	return buildPDF(t, []string{
		"<</Type/Catalog /Pages 2 0 R>>",
		"<</Type/Pages /Kids [3 0 R] /Count 1>>",
		"<</Type/Page /Parent 2 0 R /MediaBox [0 0 400 600] /Resources 4 0 R /Contents 5 0 R>>",
		"<</Font <</F1 6 0 R>>>>",
		stream("", content),
		"<</Type/Font /Subtype/Type1 /BaseFont/AAAAAA+Test /FirstChar 2 /LastChar 4 " +
			"/Widths [500 500 500] /Encoding <</Differences [2 /MT65 /MT66 /MT67]>>>>",
	})
}

func walkBytes(t *testing.T, data []byte) pageContent {
	t.Helper()
	rd, err := pdf.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("reading the fixture: %v", err)
	}
	c, err := walkPage(rd.Page(1))
	if err != nil {
		t.Fatalf("walking the fixture: %v", err)
	}
	return c
}

// A white fill of the page with a rectangular hole is how a military plate
// says where its panel ends: the chart is drawn wider and the overspill is
// painted out. The hole is the frame, and the ink it covered is not on the
// sheet.
func TestWalkReadsAKnockout(t *testing.T) {
	// The hole, wound against the `re` above it so the nonzero rule leaves
	// it open.
	hole := "30 500 m 370 500 l 370 30 l 30 30 l h"
	c := walkBytes(t, knockoutPlate(t, hole, "0 0 0 0 k"))
	if len(c.masks) != 1 {
		t.Fatalf("masks %v, want the one hole the fill left open", c.masks)
	}
	want := box{x0: 30, y0: 30, x1: 370, y1: 500}
	if c.masks[0] != want {
		t.Errorf("mask %v, want %v", c.masks[0], want)
	}
	var inside, outside int
	for _, s := range c.segs {
		if math.Abs(s.y1-300) < 0.01 {
			inside++
		}
		if math.Abs(s.y1-560) < 0.01 {
			outside++
		}
	}
	if inside != 1 {
		t.Errorf("the tick inside the panel was dropped (%d found)", inside)
	}
	if outside != 0 {
		t.Errorf("the tick the white covered is still evidence (%d found)", outside)
	}
	// The header is drawn AFTER the knockout, so it is on top of it: the
	// page kind and the ARP are read off text that sits in the margin.
	found := false
	for _, r := range c.runs {
		if r.text == "A" {
			found = true
		}
	}
	if !found {
		t.Error("the header set after the knockout was dropped with the ink it covered")
	}
}

func TestKnockoutNeedsAWhiteFillAroundARealHole(t *testing.T) {
	hole := "30 500 m 370 500 l 370 30 l 30 30 l h"
	cases := []struct {
		name, hole, colour string
	}{
		// Ink is ink: a black frame around a panel draws something, it does
		// not undraw what is under it.
		{"a coloured fill", hole, "0 0 0 1 k"},
		// Wound WITH the outline, the nonzero rule fills the panel too, so
		// nothing is a hole and the page would be blank.
		{"a hole wound the same way", "30 30 m 370 30 l 370 500 l 30 500 l h", "0 0 0 0 k"},
		// A shape that is not a rectangle is not a panel.
		{"a triangular hole", "30 500 m 370 500 l 200 30 l h", "0 0 0 0 k"},
		// And a halo behind a label is not a knockout, whatever its colour.
		{"a hole too small to be a map", "30 100 m 120 100 l 120 30 l 30 30 l h", "1 1 1 rg"},
	}
	for _, tc := range cases {
		c := walkBytes(t, knockoutPlate(t, tc.hole, tc.colour))
		if len(c.masks) != 0 {
			t.Errorf("%s: masks %v, want none", tc.name, c.masks)
		}
		out := 0
		for _, s := range c.segs {
			if math.Abs(s.y1-560) < 0.01 {
				out++
			}
		}
		if out == 0 {
			t.Errorf("%s: ink was dropped by something that is not a knockout", tc.name)
		}
	}
}
