// Package pdftable rebuilds the ruled tables of an AIP published as PDF
// into the HTML the eAIP readers already read (internal/eaip), so a State
// whose AIP is a set of PDF sections, Romania's, goes through the same
// grammar as the generated packages.
//
// A table in these files is drawn, not marked up: its rules are thin
// filled rectangles or stroked lines in the page's content stream, and its
// text is placed words. So the two are read apart and put back together:
//
//   - the rules come from the content stream (the path operators only,
//     through q / Q / cm and Form XObjects), a rule being a filled
//     rectangle thin in one direction or a stroked straight segment; the
//     amendment highlights are filled rectangles too, and thick, so they
//     drop out. The stream is lexed by internal/pdfcontent, never by
//     rsc.io/pdf's interpreter, which loops forever on a stream ending
//     inside an array: that is how a page split into parts reads when the
//     parts are read one at a time, and it took a probe of Romania's ENR 2.2
//     to 40 GB (docs/ro-aip.md);
//   - the words come from poppler's pdftotext -bbox-layout;
//   - the rules touching each other make a table, their distinct
//     positions its grid, and two neighbouring grid cells with no rule
//     between them are one cell, a span;
//   - a word goes to the cell holding its centre, a cell's words are read
//     line by line.
//
// A section's tables that share their columns are one table: the file
// breaks it at every page and at every group of zones, repeating the column
// legend ("1 2 3 4 5") but not the header the readers look for.
package pdftable

import (
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"html"
	"math"
	"sort"
	"strconv"
	"strings"

	"github.com/0intro/loxodrome/internal/pdfcontent"
	"rsc.io/pdf"
)

// Word is one placed word, in points from the page's top left.
type Word struct {
	Text           string
	X0, Y0, X1, Y1 float64
}

func (w Word) cx() float64 { return (w.X0 + w.X1) / 2 }
func (w Word) cy() float64 { return (w.Y0 + w.Y1) / 2 }

// Rule is one drawn rule, in points from the page's top left: horizontal
// when Y0 == Y1, vertical when X0 == X1.
type Rule struct {
	X0, Y0, X1, Y1 float64
}

func (r Rule) horizontal() bool { return r.Y0 == r.Y1 }

// Page is one page's words and rules.
type Page struct {
	W, H  float64
	Words []Word
	Rules []Rule
}

// ParseWords reads pdftotext -bbox-layout's XHTML into pages of words.
func ParseWords(bbox []byte) ([]Page, error) {
	var doc struct {
		Pages []struct {
			W     float64 `xml:"width,attr"`
			H     float64 `xml:"height,attr"`
			Words []struct {
				X0   float64 `xml:"xMin,attr"`
				Y0   float64 `xml:"yMin,attr"`
				X1   float64 `xml:"xMax,attr"`
				Y1   float64 `xml:"yMax,attr"`
				Text string  `xml:",chardata"`
			} `xml:"flow>block>line>word"`
		} `xml:"body>doc>page"`
	}
	// pdftotext passes a glyph it cannot map through as a control
	// character, which XML forbids: it reads as a space.
	bbox = bytes.Map(func(r rune) rune {
		if r < 0x20 && r != '\t' && r != '\n' && r != '\r' {
			return ' '
		}
		return r
	}, bbox)
	d := xml.NewDecoder(bytes.NewReader(bbox))
	d.Strict = false
	d.Entity = xml.HTMLEntity
	if err := d.Decode(&doc); err != nil {
		return nil, fmt.Errorf("pdftable: bbox layout: %w", err)
	}
	out := make([]Page, len(doc.Pages))
	for i, p := range doc.Pages {
		out[i].W, out[i].H = p.W, p.H
		for _, w := range p.Words {
			t := strings.TrimSpace(w.Text)
			if t == "" {
				continue
			}
			out[i].Words = append(out[i].Words, Word{Text: t, X0: w.X0, Y0: w.Y0, X1: w.X1, Y1: w.Y1})
		}
	}
	return out, nil
}

// maxRule is how thick a filled rectangle may be and still be a rule, and
// minRule how long.
const (
	maxRule = 2.0
	minRule = 3.0
)

// maxFormDepth bounds Form XObject recursion; the bytes the recursion
// may decode are pdfcontent's page budget.
const maxFormDepth = 8

// mat is a PDF transformation matrix [a b c d e f].
type mat [6]float64

func (m mat) mul(n mat) mat {
	return mat{
		m[0]*n[0] + m[1]*n[2],
		m[0]*n[1] + m[1]*n[3],
		m[2]*n[0] + m[3]*n[2],
		m[2]*n[1] + m[3]*n[3],
		m[4]*n[0] + m[5]*n[2] + n[4],
		m[4]*n[1] + m[5]*n[3] + n[5],
	}
}

func (m mat) apply(x, y float64) (float64, float64) {
	return m[0]*x + m[2]*y + m[4], m[1]*x + m[3]*y + m[5]
}

// PageRules reads the rules page n (1-based) draws, in points from the top
// left of the page box pdftotext measures from (the crop box, else the
// media box). A stream ending inside a string or an array is malformed
// but its drawing up to there is not: the rules read are returned with
// the pdfcontent.ErrOpen describing it.
func PageRules(r *pdf.Reader, n int) (rules []Rule, err error) {
	defer func() {
		// rsc.io/pdf panics on malformed input rather than returning an
		// error; one bad page must not take the build down.
		if e := recover(); e != nil {
			rules, err = nil, fmt.Errorf("pdftable: page %d: %v", n, e)
		}
	}()
	p := r.Page(n)
	if p.V.IsNull() {
		return nil, fmt.Errorf("pdftable: no page %d", n)
	}
	x0, y1 := pageOrigin(p)
	w := walker{streams: pdfcontent.NewStreams(pdfcontent.PageBudget)}
	w.gs = []mat{{1, 0, 0, 1, 0, 0}}
	data, err := w.streams.Contents(p.V.Key("Contents"))
	if err != nil {
		return nil, fmt.Errorf("pdftable: page %d: %w", n, err)
	}
	err = w.interpret(data, p.Resources(), 0)
	if err == nil {
		err = w.err
	}
	if err != nil {
		err = fmt.Errorf("pdftable: page %d: %w", n, err)
	}
	for _, s := range w.out {
		// Page space, origin bottom left, to pdftotext's: top left.
		rules = append(rules, Rule{X0: s.X0 - x0, Y0: y1 - s.Y0, X1: s.X1 - x0, Y1: y1 - s.Y1})
	}
	return rules, err
}

// pageOrigin is the left and top of the box pdftotext measures from.
func pageOrigin(p pdf.Page) (x0, y1 float64) {
	box := inherited(p.V, "CropBox")
	if box.IsNull() {
		box = inherited(p.V, "MediaBox")
	}
	if box.Len() == 4 {
		x0 = math.Min(box.Index(0).Float64(), box.Index(2).Float64())
		y1 = math.Max(box.Index(1).Float64(), box.Index(3).Float64())
	}
	return x0, y1
}

// inherited reads a page attribute a page may inherit from the page tree
// (PDF 32000-1 7.7.3.4).
func inherited(v pdf.Value, key string) pdf.Value {
	for ; !v.IsNull(); v = v.Key("Parent") {
		if r := v.Key(key); !r.IsNull() {
			return r
		}
	}
	return pdf.Value{}
}

type walker struct {
	gs      []mat     // the CTM stack, top last
	subs    []subpath // the path under construction, in user space
	rect    [][4]float64
	out     []Rule
	streams *pdfcontent.Streams // the page's decoded streams, budgeted
	err     error               // the first form that could not be read
}

// subpath is one piece of the path under construction: its points, and
// for each whether a curve reached it rather than a line.
type subpath struct {
	pts   [][2]float64
	curve []bool
}

// to extends the current subpath to p.
func (w *walker) to(p [2]float64, curve bool) {
	n := len(w.subs)
	if n == 0 {
		return // a line with no current point is malformed: nothing to draw from
	}
	w.subs[n-1].pts = append(w.subs[n-1].pts, p)
	w.subs[n-1].curve = append(w.subs[n-1].curve, curve)
}

// closeSub closes the current subpath back to its first point.
func (w *walker) closeSub() {
	if n := len(w.subs); n > 0 && len(w.subs[n-1].pts) > 1 {
		w.to(w.subs[n-1].pts[0], false)
	}
}

func (w *walker) ctm() mat { return w.gs[len(w.gs)-1] }

func (w *walker) interpret(data []byte, res pdf.Value, depth int) error {
	return pdfcontent.Interpret(data, func(op string, args []pdfcontent.Operand) {
		w.do(op, args, res, depth)
	})
}

func num(args []pdfcontent.Operand, i int) float64 {
	if i < len(args) {
		return args[i].Float64()
	}
	return 0
}

func (w *walker) do(op string, args []pdfcontent.Operand, res pdf.Value, depth int) {
	switch op {
	case "q":
		w.gs = append(w.gs, w.ctm())
	case "Q":
		if len(w.gs) > 1 {
			w.gs = w.gs[:len(w.gs)-1]
		}
	case "cm":
		m := mat{num(args, 0), num(args, 1), num(args, 2), num(args, 3), num(args, 4), num(args, 5)}
		w.gs[len(w.gs)-1] = m.mul(w.ctm())
	case "m":
		w.subs = append(w.subs, subpath{pts: [][2]float64{{num(args, 0), num(args, 1)}}, curve: []bool{false}})
	case "l":
		w.to([2]float64{num(args, 0), num(args, 1)}, false)
	case "c":
		// A curve is no rule, but it moves the current point: a line
		// drawn after it starts where it ended.
		w.to([2]float64{num(args, 4), num(args, 5)}, true)
	case "v", "y":
		w.to([2]float64{num(args, 2), num(args, 3)}, true)
	case "h":
		w.closeSub()
	case "re":
		w.rect = append(w.rect, [4]float64{num(args, 0), num(args, 1), num(args, 2), num(args, 3)})
	case "S", "s", "f", "F", "f*", "B", "B*", "b", "b*":
		if op == "s" || op == "b" || op == "b*" {
			w.closeSub()
		}
		if op != "f" && op != "F" && op != "f*" {
			w.strokeSegments()
		}
		if op != "S" && op != "s" {
			w.fillRects()
			w.fillPaths()
		}
		w.subs, w.rect = nil, nil
	case "n":
		w.subs, w.rect = nil, nil
	case "Do":
		if depth >= maxFormDepth || len(args) == 0 {
			return
		}
		xo := res.Key("XObject").Key(args[0].Name())
		if xo.Key("Subtype").Name() != "Form" || w.err != nil {
			return
		}
		data, err := w.streams.Stream(xo)
		if err != nil {
			w.err = err
			return
		}
		m := mat{1, 0, 0, 1, 0, 0}
		if fm := xo.Key("Matrix"); fm.Len() == 6 {
			for i := range m {
				m[i] = fm.Index(i).Float64()
			}
		}
		w.gs = append(w.gs, m.mul(w.ctm()))
		fres := xo.Key("Resources")
		if fres.IsNull() {
			fres = res
		}
		if err := w.interpret(data, fres, depth+1); err != nil && w.err == nil {
			w.err = err
		}
		w.gs = w.gs[:len(w.gs)-1]
	}
}

// strokeSegments keeps the straight axis-aligned segments of a stroked
// path, and the four sides of a stroked rectangle.
func (w *walker) strokeSegments() {
	m := w.ctm()
	add := func(ax, ay, bx, by float64) {
		x0, y0 := m.apply(ax, ay)
		x1, y1 := m.apply(bx, by)
		switch {
		case math.Abs(y1-y0) < 0.5 && math.Abs(x1-x0) >= minRule:
			y := (y0 + y1) / 2
			w.out = append(w.out, Rule{X0: math.Min(x0, x1), Y0: y, X1: math.Max(x0, x1), Y1: y})
		case math.Abs(x1-x0) < 0.5 && math.Abs(y1-y0) >= minRule:
			x := (x0 + x1) / 2
			w.out = append(w.out, Rule{X0: x, Y0: math.Max(y0, y1), X1: x, Y1: math.Min(y0, y1)})
		}
	}
	for _, sp := range w.subs {
		for i := 1; i < len(sp.pts); i++ {
			if !sp.curve[i] {
				add(sp.pts[i-1][0], sp.pts[i-1][1], sp.pts[i][0], sp.pts[i][1])
			}
		}
	}
	for _, r := range w.rect {
		x, y, rw, rh := r[0], r[1], r[2], r[3]
		add(x, y, x+rw, y)
		add(x, y+rh, x+rw, y+rh)
		add(x, y, x, y+rh)
		add(x+rw, y, x+rw, y+rh)
	}
}

// fillRects keeps the filled rectangles thin enough to be rules, as the
// line along their middle.
func (w *walker) fillRects() {
	m := w.ctm()
	for _, r := range w.rect {
		ax, ay := m.apply(r[0], r[1])
		bx, by := m.apply(r[0]+r[2], r[1]+r[3])
		w.thinBox(math.Min(ax, bx), math.Min(ay, by), math.Max(ax, bx), math.Max(ay, by))
	}
}

// fillPaths keeps the filled subpaths that are rectangles drawn as paths,
// every edge horizontal or vertical, the closing one included: ROMATSA
// draws the row rules of a table's last column so on every other page of
// ENR 5.1 ("0 0 m 168 0 l 168 -.24 l 0 -.24 l f" under a translation), and
// missed, the column's verticals touched nothing and the column fell out
// of the table with its words.
func (w *walker) fillPaths() {
	m := w.ctm()
	for _, sp := range w.subs {
		if len(sp.pts) < 3 {
			continue
		}
		pts := make([][2]float64, len(sp.pts))
		for i, p := range sp.pts {
			if sp.curve[i] {
				pts = nil
				break
			}
			pts[i][0], pts[i][1] = m.apply(p[0], p[1])
		}
		if pts == nil {
			continue
		}
		x0, y0, x1, y1 := pts[0][0], pts[0][1], pts[0][0], pts[0][1]
		axial := true
		for i, p := range pts {
			q := pts[(i+1)%len(pts)]
			if math.Abs(p[0]-q[0]) > 0.01 && math.Abs(p[1]-q[1]) > 0.01 {
				axial = false
				break
			}
			x0, y0 = math.Min(x0, p[0]), math.Min(y0, p[1])
			x1, y1 = math.Max(x1, p[0]), math.Max(y1, p[1])
		}
		if axial {
			w.thinBox(x0, y0, x1, y1)
		}
	}
}

// thinBox keeps a filled box thin enough to be a rule, as the line along
// its middle.
func (w *walker) thinBox(x0, y0, x1, y1 float64) {
	switch {
	case y1-y0 <= maxRule && x1-x0 >= minRule:
		y := (y0 + y1) / 2
		w.out = append(w.out, Rule{X0: x0, Y0: y, X1: x1, Y1: y})
	case x1-x0 <= maxRule && y1-y0 >= minRule:
		x := (x0 + x1) / 2
		w.out = append(w.out, Rule{X0: x, Y0: y1, X1: x, Y1: y0})
	}
}

// Cell is one cell of a rebuilt table: its lines of text and its span.
type Cell struct {
	Lines            []string
	RowSpan, ColSpan int
}

// Table is one rebuilt table: a row of cells per grid row, a nil cell
// where a span above or to the left covers the position.
type Table struct {
	Xs, Ys []float64
	Rows   [][]*Cell
	page   int
	top    float64
}

// tol is how far apart two rule positions may be and still be one.
const tol = 1.5

// cluster sorts values and merges those within tol, returning the means.
func cluster(v []float64) []float64 {
	sort.Float64s(v)
	var out []float64
	var sum float64
	n := 0
	for i, x := range v {
		if n > 0 && x-v[i-1] > tol {
			out = append(out, sum/float64(n))
			sum, n = 0, 0
		}
		sum += x
		n++
	}
	if n > 0 {
		out = append(out, sum/float64(n))
	}
	return out
}

// gap is the largest break in a line that is still one rule: a file may
// draw a rule in pieces, stopping it short wherever another crosses it.
const gap = 2.0

// joinCollinear rejoins the pieces of a rule: segments on one line whose
// ends are within gap of each other.
func joinCollinear(rs []Rule, horizontal bool) []Rule {
	pos := func(r Rule) float64 {
		if horizontal {
			return r.Y0
		}
		return r.X0
	}
	from := func(r Rule) (float64, float64) {
		if horizontal {
			return r.X0, r.X1
		}
		return r.Y0, r.Y1
	}
	sort.Slice(rs, func(i, j int) bool {
		if math.Abs(pos(rs[i])-pos(rs[j])) > tol {
			return pos(rs[i]) < pos(rs[j])
		}
		a, _ := from(rs[i])
		b, _ := from(rs[j])
		return a < b
	})
	var out []Rule
	for _, r := range rs {
		if n := len(out); n > 0 && math.Abs(pos(out[n-1])-pos(r)) <= tol {
			_, end := from(out[n-1])
			a, b := from(r)
			if a-end <= gap {
				if b > end {
					if horizontal {
						out[n-1].X1 = b
					} else {
						out[n-1].Y1 = b
					}
				}
				continue
			}
		}
		out = append(out, r)
	}
	return out
}

// Options asks for readings a document needs and another must not have.
type Options struct {
	// Heading accepts the lines outside the tables kept as headings (see
	// DocumentWith).
	Heading func(string) bool
	// AlignedRows splits a band setting several records in one ruled row
	// (see alignedRows). An aerodrome's AD 2 tables need it; an ENR zone
	// table must not have it, a two-line zone cell able to stand beside
	// its two limits.
	AlignedRows bool
}

// Tables rebuilds a page's ruled tables, top to bottom.
func Tables(p Page) []Table {
	return TablesWith(p, Options{})
}

// TablesWith is Tables with the readings opt asks for.
func TablesWith(p Page, opt Options) []Table {
	var hs, vs []Rule
	for _, r := range p.Rules {
		if r.horizontal() {
			if r.X0 > r.X1 {
				r.X0, r.X1 = r.X1, r.X0
			}
			hs = append(hs, r)
		} else {
			if r.Y0 > r.Y1 {
				r.Y0, r.Y1 = r.Y1, r.Y0
			}
			vs = append(vs, r)
		}
	}
	joints := ruleJoints(hs)
	hs, vs = joinCollinear(hs, true), joinCollinear(vs, false)
	// The rules touching one another make one table.
	all := append(append([]Rule(nil), hs...), vs...)
	parent := make([]int, len(all))
	for i := range parent {
		parent[i] = i
	}
	var find func(int) int
	find = func(i int) int {
		for parent[i] != i {
			parent[i] = parent[parent[i]]
			i = parent[i]
		}
		return i
	}
	for i := range hs {
		for j := range vs {
			h, v := hs[i], vs[j]
			if v.X0 >= h.X0-tol && v.X0 <= h.X1+tol && h.Y0 >= v.Y0-tol && h.Y0 <= v.Y1+tol {
				parent[find(i)] = find(len(hs) + j)
			}
		}
	}
	groups := map[int][]Rule{}
	for i, r := range all {
		groups[find(i)] = append(groups[find(i)], r)
	}
	var out []Table
	for _, g := range groups {
		if t, ok := grid(g, p.Words, joints, opt); ok {
			out = append(out, t)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].top < out[j].top })
	return out
}

// joint is where two pieces of one horizontal rule meet: ROMATSA draws a
// rule a piece per column, the joints standing where the separators it
// does not draw would be.
type joint struct{ x, y float64 }

// ruleJoints finds the joints of the horizontal rules, before joinCollinear
// merges the pieces into one rule.
func ruleJoints(hs []Rule) []joint {
	rs := append([]Rule(nil), hs...)
	sort.Slice(rs, func(i, j int) bool {
		if math.Abs(rs[i].Y0-rs[j].Y0) > tol {
			return rs[i].Y0 < rs[j].Y0
		}
		return rs[i].X0 < rs[j].X0
	})
	var out []joint
	for i := 1; i < len(rs); i++ {
		a, b := rs[i-1], rs[i]
		if math.Abs(a.Y0-b.Y0) > tol {
			continue
		}
		if d := b.X0 - a.X1; d >= -1 && d <= gap {
			out = append(out, joint{x: (a.X1 + b.X0) / 2, y: a.Y0})
		}
	}
	return out
}

// blankLineRows finds where a band of a table without row rules divides:
// every column blank for more than a line's height, the blank line
// ROMATSA's ENR 4.1 leaves between two navaids, where the line below opens
// a record, its first column written. A gap the first column is blank
// below is inside a record: Brașov's AD 2.18 sets its emergency channel
// apart under the tower's two. It returns the middle of each such gap.
func blankLineRows(words []Word, X, Y []float64) []float64 {
	var out []float64
	for i := 0; i+1 < len(Y); i++ {
		var ws []Word
		for _, w := range words {
			if cx, cy := w.cx(), w.cy(); cx >= X[0] && cx <= X[len(X)-1] && cy > Y[i] && cy < Y[i+1] {
				ws = append(ws, w)
			}
		}
		if len(ws) < 2 {
			continue
		}
		sort.Slice(ws, func(a, b int) bool { return ws[a].cy() < ws[b].cy() })
		// The band's lines, top and bottom, and whether the first column
		// holds a word on them.
		type line struct {
			top, bottom, cy float64
			first           bool
		}
		var ls []line
		for _, w := range ws {
			first := w.cx() < X[1]
			if n := len(ls); n > 0 && math.Abs(w.cy()-ls[n-1].cy) <= 0.5*(w.Y1-w.Y0) {
				ls[n-1].top = math.Min(ls[n-1].top, w.Y0)
				ls[n-1].bottom = math.Max(ls[n-1].bottom, w.Y1)
				ls[n-1].first = ls[n-1].first || first
				continue
			}
			ls = append(ls, line{top: w.Y0, bottom: w.Y1, cy: w.cy(), first: first})
		}
		heights := make([]float64, len(ls))
		for k, l := range ls {
			heights[k] = l.bottom - l.top
		}
		sort.Float64s(heights)
		lineH := heights[len(heights)/2]
		for k := 1; k < len(ls); k++ {
			if g := ls[k].top - ls[k-1].bottom; g > lineH && ls[k].first {
				out = append(out, (ls[k].top+ls[k-1].bottom)/2)
			}
		}
	}
	return out
}

// alignedRows finds where a band sets several records in one ruled row:
// its first column lists two or more keys, each on a line of its own, and
// every one of them stands beside a line in at least two other columns
// (AD 2.12's "09" and "27", AD 2.18's "TWR" and "APP"). A first-column
// line no two other columns stand beside continues the key above it, a
// service designation that wraps (Timişoara's "Ground" over "control"),
// but the band must open on a key, and lines running on that outnumber
// the keys, a zone's geometry say, leave it whole. It returns a boundary
// above each key but the first, below everything the record before it
// holds.
func alignedRows(words []Word, X, Y []float64) []float64 {
	type line struct{ cy, top, bottom float64 }
	linesOf := func(ws []Word) []line {
		sort.Slice(ws, func(a, b int) bool { return ws[a].cy() < ws[b].cy() })
		var ls []line
		for _, w := range ws {
			if n := len(ls); n > 0 && math.Abs(w.cy()-ls[n-1].cy) <= 0.5*(w.Y1-w.Y0) {
				ls[n-1].top = math.Min(ls[n-1].top, w.Y0)
				ls[n-1].bottom = math.Max(ls[n-1].bottom, w.Y1)
				continue
			}
			ls = append(ls, line{cy: w.cy(), top: w.Y0, bottom: w.Y1})
		}
		return ls
	}
	var out []float64
	for i := 0; i+1 < len(Y); i++ {
		cols := make([][]line, len(X)-1)
		for j := range cols {
			var ws []Word
			for _, w := range words {
				if cx, cy := w.cx(), w.cy(); cx >= X[j] && cx < X[j+1] && cy > Y[i] && cy < Y[i+1] {
					ws = append(ws, w)
				}
			}
			cols[j] = linesOf(ws)
		}
		var keys []line
		runOn := 0
		for n, k := range cols[0] {
			beside := 0
			for _, c := range cols[1:] {
				for _, l := range c {
					if math.Abs(l.cy-k.cy) <= 0.5*math.Min(l.bottom-l.top, k.bottom-k.top) {
						beside++
						break
					}
				}
			}
			switch {
			case beside >= 2:
				keys = append(keys, k)
			case n == 0:
				runOn = len(cols[0]) // the band opens on no key
			default:
				runOn++
			}
		}
		if len(keys) < 2 || runOn > len(keys) {
			continue
		}
		for n := 1; n < len(keys); n++ {
			above := Y[i]
			for _, c := range cols {
				for _, l := range c {
					if l.cy < keys[n].cy-0.5*(keys[n].bottom-keys[n].top) {
						above = math.Max(above, l.bottom)
					}
				}
			}
			out = append(out, (above+keys[n].top)/2)
		}
	}
	return out
}

// grid builds one table from its rules and places the words in it.
func grid(rules []Rule, words []Word, joints []joint, opt Options) (Table, bool) {
	var xs, ys []float64
	var hs, vs []Rule
	for _, r := range rules {
		if r.horizontal() {
			ys = append(ys, r.Y0)
			hs = append(hs, r)
		} else {
			xs = append(xs, r.X0)
			vs = append(vs, r)
		}
	}
	X, Y := cluster(xs), cluster(ys)
	if len(X) < 2 || len(Y) < 2 {
		return Table{}, false
	}
	// A table drawing no column separator at all, its two borders the
	// only verticals, takes its columns from its rules' joints, and its
	// rows, which it does not rule either, from the blank lines between
	// them. A table that draws its separators is left as it draws them.
	if len(X) == 2 {
		var jx []float64
		for _, j := range joints {
			if j.x > X[0]+tol && j.x < X[1]-tol && j.y >= Y[0]-tol && j.y <= Y[len(Y)-1]+tol {
				jx = append(jx, j.x)
			}
		}
		if len(jx) > 0 {
			for _, x := range cluster(jx) {
				vs = append(vs, Rule{X0: x, Y0: Y[0], X1: x, Y1: Y[len(Y)-1]})
				xs = append(xs, x)
			}
			X = cluster(xs)
			for _, y := range blankLineRows(words, X, Y) {
				hs = append(hs, Rule{X0: X[0], Y0: y, X1: X[len(X)-1], Y1: y})
				ys = append(ys, y)
			}
			Y = cluster(ys)
		}
	}
	if opt.AlignedRows {
		for _, y := range alignedRows(words, X, Y) {
			hs = append(hs, Rule{X0: X[0], Y0: y, X1: X[len(X)-1], Y1: y})
			ys = append(ys, y)
		}
		Y = cluster(ys)
	}
	nr, nc := len(Y)-1, len(X)-1
	// covered reports whether a rule of the set lies along the line at pos
	// between a and b, over their middle.
	covered := func(set []Rule, pos, a, b float64, horizontal bool) bool {
		mid := (a + b) / 2
		for _, r := range set {
			if horizontal {
				if math.Abs(r.Y0-pos) <= tol && r.X0 <= mid && r.X1 >= mid {
					return true
				}
			} else if math.Abs(r.X0-pos) <= tol && r.Y0 <= mid && r.Y1 >= mid {
				return true
			}
		}
		return false
	}
	parent := make([]int, nr*nc)
	for i := range parent {
		parent[i] = i
	}
	var find func(int) int
	find = func(i int) int {
		for parent[i] != i {
			parent[i] = parent[parent[i]]
			i = parent[i]
		}
		return i
	}
	for i := 0; i < nr; i++ {
		for j := 0; j < nc; j++ {
			if j+1 < nc && !covered(vs, X[j+1], Y[i], Y[i+1], false) {
				parent[find(i*nc+j)] = find(i*nc + j + 1)
			}
			if i+1 < nr && !covered(hs, Y[i+1], X[j], X[j+1], true) {
				parent[find(i*nc+j)] = find((i+1)*nc + j)
			}
		}
	}
	// Each merged group spans its bounding rows and columns.
	type span struct{ r0, r1, c0, c1 int }
	spans := map[int]*span{}
	for i := 0; i < nr; i++ {
		for j := 0; j < nc; j++ {
			root := find(i*nc + j)
			s := spans[root]
			if s == nil {
				spans[root] = &span{i, i, j, j}
				continue
			}
			s.r0, s.r1 = min(s.r0, i), max(s.r1, i)
			s.c0, s.c1 = min(s.c0, j), max(s.c1, j)
		}
	}
	t := Table{Xs: X, Ys: Y, Rows: make([][]*Cell, nr), top: Y[0]}
	for i := range t.Rows {
		t.Rows[i] = make([]*Cell, nc)
	}
	owner := make([]*Cell, nr*nc)
	for i := 0; i < nr; i++ {
		for j := 0; j < nc; j++ {
			s := spans[find(i*nc+j)]
			if s.r0 == i && s.c0 == j {
				c := &Cell{RowSpan: s.r1 - s.r0 + 1, ColSpan: s.c1 - s.c0 + 1}
				t.Rows[i][j] = c
				for a := s.r0; a <= s.r1; a++ {
					for b := s.c0; b <= s.c1; b++ {
						if owner[a*nc+b] == nil {
							owner[a*nc+b] = c
						}
					}
				}
			}
		}
	}
	// A word goes to the cell holding its centre.
	placed := map[*Cell][]Word{}
	for _, w := range words {
		cx, cy := w.cx(), w.cy()
		if cx < X[0] || cx > X[nc] || cy < Y[0] || cy > Y[nr] {
			continue
		}
		i := sort.SearchFloat64s(Y, cy) - 1
		j := sort.SearchFloat64s(X, cx) - 1
		if i < 0 || j < 0 || i >= nr || j >= nc {
			continue
		}
		if c := owner[i*nc+j]; c != nil {
			placed[c] = append(placed[c], w)
		}
	}
	for c, ws := range placed {
		c.Lines = lines(ws)
	}
	return t, true
}

// lines reads a cell's words line by line: a word joins the line whose
// middle is within half its height of its own.
func lines(ws []Word) []string {
	sort.Slice(ws, func(i, j int) bool {
		if math.Abs(ws[i].cy()-ws[j].cy()) > 0.5*math.Min(ws[i].Y1-ws[i].Y0, ws[j].Y1-ws[j].Y0) {
			return ws[i].cy() < ws[j].cy()
		}
		return ws[i].X0 < ws[j].X0
	})
	var out []string
	var cur []Word
	flush := func() {
		if len(cur) == 0 {
			return
		}
		sort.Slice(cur, func(i, j int) bool { return cur[i].X0 < cur[j].X0 })
		parts := make([]string, len(cur))
		for i, w := range cur {
			parts[i] = w.Text
		}
		out = append(out, strings.Join(parts, " "))
		cur = nil
	}
	for _, w := range ws {
		if len(cur) > 0 {
			last := cur[len(cur)-1]
			if math.Abs(w.cy()-last.cy()) > 0.5*math.Min(w.Y1-w.Y0, last.Y1-last.Y0) {
				flush()
			}
		}
		cur = append(cur, w)
	}
	flush()
	return out
}

// sameColumns reports whether two tables share their columns, by their
// widths: an AIP's pages alternate their binding margin, so one table
// continued overleaf stands a few points further left or right.
func sameColumns(a, b Table) bool {
	if len(a.Xs) != len(b.Xs) {
		return false
	}
	for i := range a.Xs {
		if math.Abs((a.Xs[i]-a.Xs[0])-(b.Xs[i]-b.Xs[0])) > 2*tol {
			return false
		}
	}
	return true
}

// Join merges each table into the one before it when they share their
// columns: the file breaks one table at every page and every group of
// zones, and only the first piece carries the header.
func Join(tables []Table) []Table {
	var out []Table
	for _, t := range tables {
		if n := len(out); n > 0 && sameColumns(out[n-1], t) {
			out[n-1].Rows = append(out[n-1].Rows, t.Rows...)
			continue
		}
		out = append(out, t)
	}
	return out
}

// HTML writes the tables as one document the eAIP readers parse, each
// cell's lines a paragraph of their own.
func HTML(title string, tables []Table) []byte {
	var b strings.Builder
	b.WriteString("<!DOCTYPE html><html><head><title>")
	b.WriteString(html.EscapeString(title))
	b.WriteString("</title></head><body>\n")
	for _, t := range tables {
		writeTable(&b, t)
	}
	b.WriteString("</body></html>\n")
	return []byte(b.String())
}

// writeTable writes one table, each cell's lines a paragraph of their own.
func writeTable(b *strings.Builder, t Table) {
	b.WriteString("<table>\n")
	for _, row := range t.Rows {
		b.WriteString("<tr>")
		for _, c := range row {
			if c == nil {
				continue
			}
			b.WriteString("<td")
			if c.RowSpan > 1 {
				b.WriteString(` rowspan="` + strconv.Itoa(c.RowSpan) + `"`)
			}
			if c.ColSpan > 1 {
				b.WriteString(` colspan="` + strconv.Itoa(c.ColSpan) + `"`)
			}
			b.WriteString(">")
			for _, l := range c.Lines {
				b.WriteString("<p>")
				b.WriteString(html.EscapeString(l))
				b.WriteString("</p>")
			}
			b.WriteString("</td>")
		}
		b.WriteString("</tr>\n")
	}
	b.WriteString("</table>\n")
}

// Document rebuilds every ruled table of a PDF, given its bytes and
// pdftotext -bbox-layout's reading of them, joined across pages.
func Document(data, bbox []byte, title string) ([]byte, error) {
	return DocumentWith(data, bbox, title, Options{})
}

// DocumentWith is Document with the readings opt asks for: kept as
// headings in page order, the lines outside the tables opt.Heading accepts. An AIP's AD 2 pages set each
// section's tables under such a line ("LRAR AD 2.2 AERODROME GEOGRAPHICAL
// AND ADMINISTRATIVE DATA"), which is how the aerodrome readers tell the
// sections apart; and a heading parts two tables Join would otherwise take
// for one continued, the sections' tables all being one shape.
func DocumentWith(data, bbox []byte, title string, opt Options) ([]byte, error) {
	pages, err := ParseWords(bbox)
	if err != nil {
		return nil, err
	}
	r, err := pdf.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, fmt.Errorf("pdftable: %w", err)
	}
	for i := range pages {
		rules, err := PageRules(r, i+1)
		if err != nil && !errors.Is(err, pdfcontent.ErrOpen) {
			return nil, err
		}
		pages[i].Rules = rules
	}
	return render(pages, title, opt), nil
}

// item is a table or a heading line, in document order.
type item struct {
	table   *Table
	heading string
	y       float64
}

// render lays the pages' tables and accepted headings out in page order,
// joins each table into the one before it when they share their columns
// and no heading stands between them, and writes the HTML.
func render(pages []Page, title string, opt Options) []byte {
	var items []item
	for i, p := range pages {
		tables := TablesWith(p, opt)
		var page []item
		for k := range tables {
			tables[k].page = i
			page = append(page, item{table: &tables[k], y: tables[k].top})
		}
		if opt.Heading != nil {
			for _, l := range freeLines(p, tables) {
				if opt.Heading(l.text) {
					page = append(page, item{heading: l.text, y: l.y})
				}
			}
		}
		sort.SliceStable(page, func(a, b int) bool { return page[a].y < page[b].y })
		items = append(items, page...)
	}
	var out []item
	for _, it := range items {
		if n := len(out); it.table != nil && n > 0 && out[n-1].table != nil && sameColumns(*out[n-1].table, *it.table) {
			out[n-1].table.Rows = append(out[n-1].table.Rows, it.table.Rows...)
			continue
		}
		out = append(out, it)
	}
	var b strings.Builder
	b.WriteString("<!DOCTYPE html><html><head><title>")
	b.WriteString(html.EscapeString(title))
	b.WriteString("</title></head><body>\n")
	for _, it := range out {
		if it.table == nil {
			b.WriteString("<h4>" + html.EscapeString(it.heading) + "</h4>\n")
			continue
		}
		writeTable(&b, *it.table)
	}
	b.WriteString("</body></html>\n")
	return []byte(b.String())
}

// textLine is one line of words, its text and its top.
type textLine struct {
	text string
	y    float64
}

// freeLines reads a page's lines outside every table, top to bottom.
func freeLines(p Page, tables []Table) []textLine {
	var ws []Word
	for _, w := range p.Words {
		cx, cy := w.cx(), w.cy()
		inside := false
		for _, t := range tables {
			if cx >= t.Xs[0] && cx <= t.Xs[len(t.Xs)-1] && cy >= t.Ys[0] && cy <= t.Ys[len(t.Ys)-1] {
				inside = true
				break
			}
		}
		if !inside {
			ws = append(ws, w)
		}
	}
	sort.SliceStable(ws, func(i, j int) bool { return ws[i].cy() < ws[j].cy() })
	var out []textLine
	var cur []Word
	flush := func() {
		if len(cur) == 0 {
			return
		}
		sort.Slice(cur, func(i, j int) bool { return cur[i].X0 < cur[j].X0 })
		parts := make([]string, len(cur))
		top := cur[0].Y0
		for i, w := range cur {
			parts[i] = w.Text
			top = math.Min(top, w.Y0)
		}
		out = append(out, textLine{text: strings.Join(parts, " "), y: top})
		cur = nil
	}
	for _, w := range ws {
		if n := len(cur); n > 0 && math.Abs(w.cy()-cur[n-1].cy()) > 0.5*math.Min(w.Y1-w.Y0, cur[n-1].Y1-cur[n-1].Y0) {
			flush()
		}
		cur = append(cur, w)
	}
	flush()
	return out
}
