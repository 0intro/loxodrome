package pdftable

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/0intro/loxodrome/internal/pdfcontent"
	"rsc.io/pdf"
)

// seg is a vertical rule in top-left coordinates.
func vseg(x, y0, y1 float64) Rule { return Rule{X0: x, Y0: y0, X1: x, Y1: y1} }
func hseg(y, x0, x1 float64) Rule { return Rule{X0: x0, Y0: y, X1: x1, Y1: y} }

// ROMATSA's TMA table (ENR 2.1-9): the first column is divided per
// sub-zone, the other four run the full height, their vertical rules drawn
// in pieces with a gap wherever a horizontal rule crosses.
func TestSpansAcrossBrokenRules(t *testing.T) {
	X := []float64{70.89, 234.0, 297.72, 361.5, 496.2, 574.17}
	var rules []Rule
	for _, y := range []float64{69.84, 91.77, 103.05, 669.48} {
		rules = append(rules, hseg(y, X[0], X[5]))
	}
	for _, y := range []float64{214.59, 353.37, 455.31, 566.43} {
		rules = append(rules, hseg(y, X[0], X[1]))
	}
	pieces := [][2]float64{{92.52, 102.30}, {103.80, 214.20}, {214.98, 352.98}, {353.76, 454.92}, {455.70, 566.04}, {566.82, 667.98}}
	for _, x := range X {
		for _, p := range pieces {
			rules = append(rules, vseg(x, p[0], p[1]))
		}
	}
	rules = append(rules, vseg(X[0], 69.84, 91.02), vseg(X[5], 69.84, 91.02))
	tables := Tables(Page{Rules: rules, Words: []Word{
		{Text: "123.530", X0: 370, Y0: 120, X1: 400, Y1: 128},
		{Text: "See", X0: 500, Y0: 120, X1: 520, Y1: 128},
	}})
	if len(tables) != 1 {
		t.Fatalf("tables = %d", len(tables))
	}
	tb := tables[0]
	for i, row := range tb.Rows {
		for j, c := range row {
			if c != nil {
				t.Logf("(%d,%d) %dx%d %q", i, j, c.RowSpan, c.ColSpan, c.Lines)
			}
		}
	}
	if c := tb.Rows[2][3]; c == nil || c.ColSpan != 1 || c.RowSpan != 5 {
		t.Errorf("frequency cell = %+v, want one column over the five sub-zone rows", c)
	}
}

// onePagePDF builds a one-page PDF (100 x 100 points) whose /Contents is
// the given streams, an array of them when there are several, followed by
// the extra objects (numbered from 4 + len(parts)) the page's /Resources
// may name.
func onePagePDF(t *testing.T, resources string, parts []string, extra ...string) *pdf.Reader {
	t.Helper()
	var b bytes.Buffer
	var off []int
	obj := func(s string) {
		off = append(off, b.Len())
		fmt.Fprintf(&b, "%d 0 obj\n%s\nendobj\n", len(off), s)
	}
	b.WriteString("%PDF-1.4\n")
	var refs []string
	for i := range parts {
		refs = append(refs, fmt.Sprintf("%d 0 R", 4+i))
	}
	contents := strings.Join(refs, " ")
	if len(parts) > 1 {
		contents = "[" + contents + "]"
	}
	obj("<< /Type /Catalog /Pages 2 0 R >>")
	obj("<< /Type /Pages /Kids [3 0 R] /Count 1 >>")
	obj("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << " + resources + " >> /Contents " + contents + " >>")
	for _, p := range parts {
		obj(fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(p)+1, p))
	}
	for _, x := range extra {
		obj(x)
	}
	xref := b.Len()
	fmt.Fprintf(&b, "xref\n0 %d\n0000000000 65535 f \n", len(off)+1)
	for _, o := range off {
		fmt.Fprintf(&b, "%010d 00000 n \n", o)
	}
	fmt.Fprintf(&b, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(off)+1, xref)
	r, err := pdf.NewReader(bytes.NewReader(b.Bytes()), int64(b.Len()))
	if err != nil {
		t.Fatal(err)
	}
	return r
}

// pageRules runs PageRules under a watchdog. The failure this file pins
// does not fail: it allocates without end, at about 700 MB a second, and
// froze a 64 GB machine. So a run that has not returned in five seconds
// ends the whole test process before it can.
func pageRules(t *testing.T, r *pdf.Reader) ([]Rule, error) {
	t.Helper()
	type result struct {
		rules []Rule
		err   error
	}
	done := make(chan result, 1)
	go func() {
		rules, err := PageRules(r, 1)
		done <- result{rules, err}
	}()
	select {
	case res := <-done:
		return res.rules, res.err
	case <-time.After(5 * time.Second):
		fmt.Fprintf(os.Stderr, "%s: PageRules did not return: the content stream lexer is looping\n", t.Name())
		os.Exit(1)
		return nil, nil
	}
}

// Romania's ENR 2.2 cuts its pages' content into streams at arbitrary
// token boundaries, one of them right after a TJ array's "[". Read one
// part at a time, that part ended inside an array; joined, the page reads
// whole, the rule drawn after the split included.
func TestPageSplitInsideAnArray(t *testing.T) {
	r := onePagePDF(t, "", []string{
		"0 0 0 RG 0.5 w 10 90 m 90 90 l S BT /F1 1 Tf 0.0015 Tw\n[",
		"( -)-6.5( f)-13.5(o)] TJ ET 10 10 m 90 10 l S",
	})
	rules, err := pageRules(t, r)
	if err != nil {
		t.Fatal(err)
	}
	want := []Rule{{X0: 10, Y0: 10, X1: 90, Y1: 10}, {X0: 10, Y0: 90, X1: 90, Y1: 90}}
	if len(rules) != len(want) || rules[0] != want[0] || rules[1] != want[1] {
		t.Errorf("rules = %+v, want %+v", rules, want)
	}
}

// A page whose content ends inside an array is malformed: its drawing up
// to there is kept, and the error says where it stopped.
func TestPageEndingInsideAnArray(t *testing.T) {
	rules, err := pageRules(t, onePagePDF(t, "", []string{"10 50 m 90 50 l S [(unterminated) 2"}))
	if !errors.Is(err, pdfcontent.ErrOpen) {
		t.Errorf("error %v, want pdfcontent.ErrOpen", err)
	}
	if len(rules) != 1 {
		t.Errorf("rules = %+v, want the one drawn before the array", rules)
	}
}

// A form drawing itself twice doubles the reads at every level, which
// maxFormDepth stops at 255.
func TestSelfDrawingFormIsBounded(t *testing.T) {
	form := "<< /Type /XObject /Subtype /Form /BBox [0 0 100 100] /Resources << /XObject << /X 5 0 R >> >> /Length 30 >>\nstream\n10 20 m 90 20 l S /X Do /X Do\nendstream"
	rules, err := pageRules(t, onePagePDF(t, "/XObject << /X 5 0 R >>", []string{"/X Do"}, form))
	if err != nil {
		t.Fatal(err)
	}
	// 1 + 2 + ... + 2^7 forms read down to maxFormDepth: 255 copies of
	// the one rule, all bounded.
	if len(rules) != 255 {
		t.Errorf("rules = %d, want 255", len(rules))
	}
}

// The depth bound counts reads, not bytes: 255 reads of a 1 MB form are
// 255 MB. The page's byte budget stops it at pdfcontent.PageBudget.
func TestPageByteBudget(t *testing.T) {
	body := "% " + strings.Repeat("x", 1<<20) + "\n/X Do /X Do"
	form := fmt.Sprintf("<< /Type /XObject /Subtype /Form /BBox [0 0 100 100] /Resources << /XObject << /X 5 0 R >> >> /Length %d >>\nstream\n%s\nendstream", len(body)+1, body)
	_, err := pageRules(t, onePagePDF(t, "/XObject << /X 5 0 R >>", []string{"/X Do"}, form))
	if !errors.Is(err, pdfcontent.ErrBudget) {
		t.Errorf("error %v, want pdfcontent.ErrBudget", err)
	}
}

// ROMATSA draws the row rules of a table's last column, on every other
// page of ENR 5.1, as a filled path rather than a rectangle: "q 1 0 0 1
// 406.08 773.36 cm 0 0 m 168 0 l 168 -.24 l 0 -.24 l f". Kept only as
// rectangles, those rules were lost, the column's verticals then touched
// nothing, and the column fell out of the table with its words.
func TestRulesDrawnAsFilledPaths(t *testing.T) {
	var b strings.Builder
	for _, y := range []string{"80", "60", "40"} {
		fmt.Fprintf(&b, "10 %s 50 .24 re f\n", y)
		fmt.Fprintf(&b, "q 1 0 0 1 60 %s.24 cm 0 0 m 30 0 l 30 -.24 l 0 -.24 l f Q\n", y)
	}
	for _, x := range []string{"10", "35", "60", "90"} {
		fmt.Fprintf(&b, "%s 40 .24 40.24 re f\n", x)
	}
	rules, err := pageRules(t, onePagePDF(t, "", []string{b.String()}))
	if err != nil {
		t.Fatal(err)
	}
	tables := Tables(Page{Rules: rules, Words: []Word{
		{Text: "remark", X0: 70, Y0: 25, X1: 80, Y1: 30},
	}})
	if len(tables) != 1 {
		t.Fatalf("tables = %d, want 1", len(tables))
	}
	tb := tables[0]
	if len(tb.Xs) != 4 || len(tb.Rows) != 2 {
		t.Fatalf("grid %d x %d, want 2 rows x 3 columns (Xs %v)", len(tb.Rows), len(tb.Xs)-1, tb.Xs)
	}
	if c := tb.Rows[0][2]; c == nil || len(c.Lines) != 1 || c.Lines[0] != "remark" {
		t.Errorf("last column's cell = %+v, want its word", c)
	}
}

// A curve moves the current point: a line drawn after one starts where the
// curve ended, not where the path stood before it, or a rounded corner
// becomes a rule that is not there.
func TestCurvesMoveTheCurrentPoint(t *testing.T) {
	rules, err := pageRules(t, onePagePDF(t, "", []string{
		"10 50 m 20 60 30 60 40 50 c 60 50 l S",
	}))
	if err != nil {
		t.Fatal(err)
	}
	want := []Rule{{X0: 40, Y0: 50, X1: 60, Y1: 50}}
	if len(rules) != 1 || rules[0] != want[0] {
		t.Errorf("rules = %+v, want only the line after the curve, %+v", rules, want)
	}
}

// ROMATSA's ENR 4.1 draws no column separator at all: only the table's two
// outer borders, and each horizontal rule in one piece per column, the
// joints where the separators would be. Nor does it rule its rows: the
// navaids stand in one band, a blank line between them. The columns come
// from the joints and the rows from the blank lines.
func TestTableWithoutSeparators(t *testing.T) {
	// Three columns joined at x=40 and x=70; a header band and a body
	// band holding three records of two lines each.
	var rules []Rule
	for _, y := range []float64{10, 20, 90} {
		rules = append(rules, hseg(y, 10, 39.8), hseg(y, 40.2, 69.8), hseg(y, 70.2, 100))
	}
	rules = append(rules, vseg(10, 10, 90), vseg(100, 10, 90))
	var words []Word
	word := func(text string, x, y float64) {
		words = append(words, Word{Text: text, X0: x, Y0: y, X1: x + 8, Y1: y + 5})
	}
	word("Name", 12, 13)
	word("ID", 42, 13)
	word("FREQ", 72, 13)
	for i, rec := range [][3]string{{"ARAD", "ARD", "109.000"}, {"BACAU", "BCU", "109.400"}, {"CLUJ", "CLJ", "112.850"}} {
		y := 23.0 + float64(i)*20
		word(rec[0], 12, y)
		word("DVOR/DME", 12, y+6)
		word(rec[1], 42, y)
		word(rec[2], 72, y)
		word("MHz", 72, y+6)
	}
	tables := Tables(Page{Rules: rules, Words: words})
	if len(tables) != 1 {
		t.Fatalf("tables = %d, want 1", len(tables))
	}
	tb := tables[0]
	if len(tb.Xs) != 4 {
		t.Fatalf("columns at %v, want three", tb.Xs)
	}
	var got []string
	for _, row := range tb.Rows {
		var cells []string
		for _, c := range row {
			if c != nil {
				cells = append(cells, strings.Join(c.Lines, " "))
			}
		}
		got = append(got, strings.Join(cells, " | "))
	}
	want := []string{
		"Name | ID | FREQ",
		"ARAD DVOR/DME | ARD | 109.000 MHz",
		"BACAU DVOR/DME | BCU | 109.400 MHz",
		"CLUJ DVOR/DME | CLJ | 112.850 MHz",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("rows\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

// A blank line only parts two records when the line below it opens one,
// its first column written: Brașov's AD 2.18 sets the emergency channel
// apart under the tower's two, the first column blank beside it.
func TestTableWithoutSeparatorsBlankInsideRecord(t *testing.T) {
	var rules []Rule
	for _, y := range []float64{10, 20, 90} {
		rules = append(rules, hseg(y, 10, 39.8), hseg(y, 40.2, 69.8), hseg(y, 70.2, 100))
	}
	rules = append(rules, vseg(10, 10, 90), vseg(100, 10, 90))
	var words []Word
	word := func(text string, x, y float64) {
		words = append(words, Word{Text: text, X0: x, Y0: y, X1: x + 8, Y1: y + 5})
	}
	word("Service", 12, 13)
	word("Call", 42, 13)
	word("FREQ", 72, 13)
	word("TWR/APP", 12, 23)
	word("Tower", 42, 23)
	word("118.630", 72, 23)
	word("120.135", 72, 29)
	word("121.500", 72, 45) // a blank line above, the first column blank
	word("ATIS", 12, 62)    // a blank line above, a record opening
	word("ATIS", 42, 62)
	word("124.530", 72, 62)
	tables := Tables(Page{Rules: rules, Words: words})
	if len(tables) != 1 {
		t.Fatalf("tables = %d, want 1", len(tables))
	}
	var got []string
	for _, row := range tables[0].Rows {
		var cells []string
		for _, c := range row {
			if c != nil {
				cells = append(cells, strings.Join(c.Lines, " "))
			}
		}
		got = append(got, strings.Join(cells, " | "))
	}
	want := "Service | Call | FREQ\nTWR/APP | Tower | 118.630 120.135 121.500\nATIS | ATIS | 124.530"
	if strings.Join(got, "\n") != want {
		t.Errorf("rows\n%s\nwant\n%s", strings.Join(got, "\n"), want)
	}
}

// An AD 2 page sets each section's table under a line outside it ("LRAR
// AD 2.2 AERODROME GEOGRAPHICAL AND ADMINISTRATIVE DATA"), which is how
// the aerodrome readers tell the sections apart. Kept as headings in page
// order, the lines also part two sections' tables of one shape, which Join
// would otherwise take for one table continued.
func TestDocumentHeadings(t *testing.T) {
	table := func(y0 float64) string {
		var b strings.Builder
		for _, y := range []float64{y0, y0 - 10, y0 - 20} {
			fmt.Fprintf(&b, "10 %g 80 .24 re f\n", y)
		}
		for _, x := range []float64{10, 30, 90} {
			fmt.Fprintf(&b, "%g %g .24 20 re f\n", x, y0-20)
		}
		return b.String()
	}
	r := onePagePDF(t, "", []string{table(80) + table(40)})
	rules, err := PageRules(r, 1)
	if err != nil {
		t.Fatal(err)
	}
	words := []Word{
		{Text: "LRAR", X0: 12, Y0: 12, X1: 20, Y1: 16}, {Text: "AD", X0: 21, Y0: 12, X1: 24, Y1: 16},
		{Text: "2.2", X0: 25, Y0: 12, X1: 30, Y1: 16},
		{Text: "1", X0: 12, Y0: 22, X1: 14, Y1: 26}, {Text: "ARP", X0: 32, Y0: 22, X1: 40, Y1: 26},
		{Text: "LRAR", X0: 12, Y0: 52, X1: 20, Y1: 56}, {Text: "AD", X0: 21, Y0: 52, X1: 24, Y1: 56},
		{Text: "2.3", X0: 25, Y0: 52, X1: 30, Y1: 56},
		{Text: "1", X0: 12, Y0: 62, X1: 14, Y1: 66}, {Text: "H24", X0: 32, Y0: 62, X1: 40, Y1: 66},
		{Text: "AIP", X0: 12, Y0: 2, X1: 20, Y1: 6},
	}
	isHead := func(s string) bool { return strings.HasPrefix(s, "LRAR AD 2.") }
	html := string(render([]Page{{W: 100, H: 100, Words: words, Rules: rules}}, "AD 2", Options{Heading: isHead}))
	for _, want := range []string{"<h4>LRAR AD 2.2</h4>", "<h4>LRAR AD 2.3</h4>"} {
		if !strings.Contains(html, want) {
			t.Errorf("no %s in\n%s", want, html)
		}
	}
	if strings.Count(html, "<table>") != 2 {
		t.Errorf("tables = %d, want 2: a heading parts them\n%s", strings.Count(html, "<table>"), html)
	}
	if strings.Contains(html, "AIP") {
		t.Errorf("a line no predicate accepts was kept:\n%s", html)
	}
	if strings.Index(html, "LRAR AD 2.2") > strings.Index(html, "ARP") || strings.Index(html, "ARP") > strings.Index(html, "LRAR AD 2.3") {
		t.Errorf("headings out of page order:\n%s", html)
	}
}

// AD 2.12, 2.13 and 2.18 set two records in one ruled row: the first
// column lists the keys ("09", "27") on lines of their own and the other
// columns print each record beside its key. With AlignedRows the band
// splits at each key; without it, as in an ENR zone table, where a
// two-line zone cell can stand beside its two limits, it stays whole.
func TestAlignedRows(t *testing.T) {
	var rules []Rule
	for _, y := range []float64{10, 20, 60} {
		rules = append(rules, hseg(y, 10, 100))
	}
	for _, x := range []float64{10, 30, 60, 100} {
		rules = append(rules, vseg(x, 10, 60))
	}
	var words []Word
	word := func(text string, x, y float64) {
		words = append(words, Word{Text: text, X0: x, Y0: y, X1: x + 8, Y1: y + 5})
	}
	word("RWY", 12, 13)
	word("Dimensions", 32, 13)
	word("Surface", 62, 13)
	word("09", 12, 23)
	word("2000x45", 32, 23)
	word("41/R/C", 62, 23)
	word("Concrete", 62, 29)
	word("27", 12, 36)
	word("2000x45", 32, 36)
	word("41/R/C", 62, 36)
	word("Concrete", 62, 42)
	rows := func(opt Options) []string {
		tables := TablesWith(Page{Rules: rules, Words: words}, opt)
		if len(tables) != 1 {
			t.Fatalf("tables = %d", len(tables))
		}
		var out []string
		for _, row := range tables[0].Rows {
			var cells []string
			for _, c := range row {
				if c != nil {
					cells = append(cells, strings.Join(c.Lines, " "))
				}
			}
			out = append(out, strings.Join(cells, " | "))
		}
		return out
	}
	split := strings.Join(rows(Options{AlignedRows: true}), "\n")
	if want := "RWY | Dimensions | Surface\n09 | 2000x45 | 41/R/C Concrete\n27 | 2000x45 | 41/R/C Concrete"; split != want {
		t.Errorf("aligned rows:\n%s\nwant\n%s", split, want)
	}
	if whole := rows(Options{}); len(whole) != 2 {
		t.Errorf("without the option the band split: %q", whole)
	}
}

// A key may wrap: Timişoara's AD 2.18 designates its ground service
// "Ground" over "control", and the second line, beside the call sign's
// second line alone, is no record of its own. A first column running on
// for more lines than it has keys is left whole.
func TestAlignedRowsWrappedKey(t *testing.T) {
	var rules []Rule
	for _, y := range []float64{10, 20, 80} {
		rules = append(rules, hseg(y, 10, 100))
	}
	for _, x := range []float64{10, 30, 60, 100} {
		rules = append(rules, vseg(x, 10, 80))
	}
	var words []Word
	word := func(text string, x, y float64) {
		words = append(words, Word{Text: text, X0: x, Y0: y, X1: x + 8, Y1: y + 5})
	}
	word("Service", 12, 13)
	word("Call", 32, 13)
	word("Frequency", 62, 13)
	word("TWR", 12, 23)
	word("Tower", 32, 23)
	word("120.105", 62, 23)
	word("129.450", 62, 29)
	word("Ground", 12, 36)
	word("Timisoara", 32, 36)
	word("121.600", 62, 36)
	word("control", 12, 42)
	word("Ground", 32, 42)
	word("ATIS", 12, 55)
	word("ATIS", 32, 55)
	word("123.125", 62, 55)
	tables := TablesWith(Page{Rules: rules, Words: words}, Options{AlignedRows: true})
	if len(tables) != 1 {
		t.Fatalf("tables = %d", len(tables))
	}
	var got []string
	for _, row := range tables[0].Rows {
		var cells []string
		for _, c := range row {
			if c != nil {
				cells = append(cells, strings.Join(c.Lines, " "))
			}
		}
		got = append(got, strings.Join(cells, " | "))
	}
	want := "Service | Call | Frequency\nTWR | Tower | 120.105 129.450\nGround control | Timisoara Ground | 121.600\nATIS | ATIS | 123.125"
	if strings.Join(got, "\n") != want {
		t.Errorf("rows:\n%s\nwant\n%s", strings.Join(got, "\n"), want)
	}
}

// pdftotext passes a glyph it cannot map through as a control character,
// and XML forbids those: one U+0002 in Constanta's AD 2 pages stopped the
// whole document reading. They read as a space.
func TestParseWordsControlCharacter(t *testing.T) {
	bbox := []byte("<html><body><doc><page width=\"100\" height=\"100\"><flow><block><line>" +
		"<word xMin=\"1\" yMin=\"1\" xMax=\"9\" yMax=\"5\">RWY\x0203</word>" +
		"<word xMin=\"11\" yMin=\"1\" xMax=\"19\" yMax=\"5\">ARP</word>" +
		"</line></block></flow></page></doc></body></html>")
	pages, err := ParseWords(bbox)
	if err != nil {
		t.Fatal(err)
	}
	if len(pages) != 1 || len(pages[0].Words) != 2 || pages[0].Words[0].Text != "RWY 03" {
		t.Errorf("pages %+v", pages)
	}
}
