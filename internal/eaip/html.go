// htmltext.go: minimal helpers over golang.org/x/net/html for the
// Eurocontrol-eAIP markup skeyes publishes. Text extraction skips <del>
// subtrees (the eAIP amendment styling keeps the superseded value in the
// document next to the <ins> replacement) and footnote-reference
// superscripts, and normalizes the eAIP's typographic characters (NBSP,
// narrow NBSP, thin space, non-breaking hyphen) so downstream regexes see
// plain ASCII.

package eaip

import (
	"bytes"
	"strconv"
	"strings"

	"golang.org/x/net/html"
)

// htmlNode aliases the x/net/html node type so the per-section parsers
// stay import-free.
type htmlNode = html.Node

// IsElem reports whether n is an element node (guards manual walks: text
// nodes carry their content in Data, so a bare Data comparison would match
// prose).
// Node is the parsed HTML node type, aliased so a caller need not
// import golang.org/x/net/html for a signature.
type Node = html.Node

func IsElem(n *html.Node) bool { return n.Type == html.ElementNode }

func ParseHTML(data []byte) (*html.Node, error) {
	return html.Parse(bytes.NewReader(data))
}

// FindAll returns every element under n (document order, n included) for
// which match returns true.
func FindAll(n *html.Node, match func(*html.Node) bool) []*html.Node {
	var out []*html.Node
	var rec func(*html.Node)
	rec = func(x *html.Node) {
		if x.Type == html.ElementNode && match(x) {
			out = append(out, x)
		}
		for c := x.FirstChild; c != nil; c = c.NextSibling {
			rec(c)
		}
	}
	rec(n)
	return out
}

// Elems returns the elements whose tag is one of names.
func Elems(n *html.Node, names ...string) []*html.Node {
	return FindAll(n, func(x *html.Node) bool {
		for _, w := range names {
			if x.Data == w {
				return true
			}
		}
		return false
	})
}

func Attr(n *html.Node, key string) string {
	for _, a := range n.Attr {
		if a.Key == key {
			return a.Val
		}
	}
	return ""
}

func HasClass(n *html.Node, class string) bool {
	for _, c := range strings.Fields(Attr(n, "class")) {
		if c == class {
			return true
		}
	}
	return false
}

// skipSubtree reports whether text extraction must not descend into n:
// <del> holds the pre-amendment value, Super-script spans are footnote
// references ("(1)"), script/style are code, and anything the document
// hides is not part of the published text.
//
// The hidden rule matters more than it looks. The EUROCONTROL generator
// emits the structured-data parameters behind each value as hidden
// spans, so a Czech zone's cell reads "LKP1 TAIRSPACE;CODE_ID;2860
// PRAZSKY HRAD ... 500552.95N TAIRSPACE;GEO_LAT;2860 0142400.00E" on
// paper only if they are kept: the injected token sits BETWEEN a
// coordinate's latitude and longitude, so keeping it does not merely add
// noise, it stops the pair being read as a coordinate at all.
func skipSubtree(n *html.Node) bool {
	if n.Type != html.ElementNode {
		return false
	}
	if isHidden(n) {
		return true
	}
	switch n.Data {
	case "del", "script", "style":
		return true
	case "span":
		return HasClass(n, "Super-script")
	}
	return false
}

// isHidden reports whether an element is hidden from the reader, either
// by the HTML attribute or by an inline display:none.
func isHidden(n *html.Node) bool {
	for _, a := range n.Attr {
		switch a.Key {
		case "hidden":
			return true
		case "style":
			if strings.Contains(strings.ToLower(strings.ReplaceAll(a.Val, " ", "")), "display:none") {
				return true
			}
		}
	}
	return false
}

// NormSpace maps the eAIP's typographic characters onto ASCII: Unicode
// space variants to ' ', the non-breaking hyphen (ENR 2.1 writes
// "Belgian‑Dutch border") and dashes to '-'.
func NormSpace(s string) string {
	return strings.Map(func(r rune) rune {
		switch r {
		case ' ', ' ', ' ', ' ':
			return ' '
		case '‑', '‒', '–', '—':
			return '-'
		}
		return r
	}, s)
}

// NodeText returns the whitespace-collapsed visible text of a subtree.
func NodeText(n *html.Node) string {
	var b strings.Builder
	var rec func(*html.Node)
	rec = func(x *html.Node) {
		if skipSubtree(x) {
			return
		}
		if x.Type == html.TextNode {
			b.WriteString(x.Data)
			b.WriteByte(' ')
		}
		for c := x.FirstChild; c != nil; c = c.NextSibling {
			rec(c)
		}
	}
	rec(n)
	return strings.Join(strings.Fields(NormSpace(b.String())), " ")
}

// PageTitle returns the <title> text of a parsed document.
func PageTitle(doc *html.Node) string {
	for _, t := range Elems(doc, "title") {
		return NodeText(t)
	}
	return ""
}

// TableCaption returns the table's caption text (footnote refs stripped by
// NodeText), or "".
func TableCaption(table *html.Node) string {
	for _, c := range Elems(table, "caption") {
		return NodeText(c)
	}
	return ""
}

// TableRows returns the table's own <tr> elements in document order
// (thead + tbody merged), without descending into nested tables or into
// the rows themselves.
func TableRows(table *html.Node) []*html.Node {
	var out []*html.Node
	var rec func(*html.Node)
	rec = func(x *html.Node) {
		for c := x.FirstChild; c != nil; c = c.NextSibling {
			if c.Type != html.ElementNode {
				continue
			}
			switch c.Data {
			case "table":
				continue
			case "tr":
				out = append(out, c)
			default:
				rec(c)
			}
		}
	}
	rec(table)
	return out
}

// RowCells returns the direct td / th children of a row.
func RowCells(tr *html.Node) []*html.Node {
	var out []*html.Node
	for c := tr.FirstChild; c != nil; c = c.NextSibling {
		if c.Type == html.ElementNode && (c.Data == "td" || c.Data == "th") {
			out = append(out, c)
		}
	}
	return out
}

// LabelledCell returns the text of the cell that follows the (header) cell
// whose text equals label, anywhere in the table. "" when absent.
func LabelledCell(table *html.Node, label string) string {
	for _, tr := range TableRows(table) {
		cells := RowCells(tr)
		for i, c := range cells {
			if strings.EqualFold(NodeText(c), label) && i+1 < len(cells) {
				return NodeText(cells[i+1])
			}
		}
	}
	return ""
}

// ExpandTable flattens a table into a matrix of cell texts, expanding
// rowspan / colspan so every logical position holds its cell's text (the
// AD 2.18 COM tables span the service cell over its frequency rows).
func ExpandTable(table *html.Node) [][]string {
	return TextMatrix(ExpandCells(table), NodeText)
}

// ExpandCells is ExpandTable's grid of CELLS rather than texts: every
// position a span covers holds the one cell, so a reader can look inside
// a cell (a table nested in it) and tell the continuation of a span from
// a new cell that happens to carry the same text.
func ExpandCells(table *html.Node) [][]*html.Node {
	rows := TableRows(table)
	grid := map[[2]int]*html.Node{}
	maxCol := 0
	for ri, tr := range rows {
		ci := 0
		for _, c := range RowCells(tr) {
			for grid[[2]int{ri, ci}] != nil {
				ci++
			}
			rs := atoiDefault(Attr(c, "rowspan"), 1)
			cs := atoiDefault(Attr(c, "colspan"), 1)
			for dr := 0; dr < rs; dr++ {
				for dc := 0; dc < cs; dc++ {
					grid[[2]int{ri + dr, ci + dc}] = c
				}
			}
			ci += cs
			if ci > maxCol {
				maxCol = ci
			}
		}
	}
	out := make([][]*html.Node, len(rows))
	for ri := range rows {
		row := make([]*html.Node, maxCol)
		for ci := 0; ci < maxCol; ci++ {
			row[ci] = grid[[2]int{ri, ci}]
		}
		out[ri] = row
	}
	return out
}

// TextMatrix reads a grid of cells as text, once per cell however many
// positions it spans.
func TextMatrix(cells [][]*html.Node, text func(*html.Node) string) [][]string {
	memo := map[*html.Node]string{}
	out := make([][]string, len(cells))
	for ri, row := range cells {
		out[ri] = make([]string, len(row))
		for ci, c := range row {
			if c == nil {
				continue
			}
			t, ok := memo[c]
			if !ok {
				t = text(c)
				memo[c] = t
			}
			out[ri][ci] = t
		}
	}
	return out
}

// EnglishText is NodeText for a publisher printing each statement twice
// in one cell, in the national language set bold and then in English:
// Avians' "Efri mörk: FL 245" above "Upper Limit: FL 245". Where a cell
// holds both a bold and a plain statement the plain one is kept, and a
// cell holding only one (a designator, a coordinate list, "H24") is read
// whole. A table nested in the cell is decided cell by cell, each of its
// cells being a statement of its own.
func EnglishText(n *html.Node) string {
	return cellText(n, true, false)
}

// OwnText is a cell's text without the tables nested in it.
func OwnText(n *html.Node, bilingual bool) string {
	return cellText(n, bilingual, true)
}

func cellText(cell *html.Node, bilingual, own bool) string {
	type piece struct {
		text         string
		bold, nested bool
	}
	var pieces []piece
	var rec func(x *html.Node, bold bool)
	rec = func(x *html.Node, bold bool) {
		if skipSubtree(x) {
			return
		}
		if x != cell && x.Type == html.ElementNode {
			switch {
			case own && x.Data == "table":
				return
			case bilingual && (x.Data == "td" || x.Data == "th"):
				pieces = append(pieces, piece{text: cellText(x, true, false), nested: true})
				return
			case x.Data == "strong" || x.Data == "b" || HasClass(x, "bold"):
				bold = true
			}
		}
		if x.Type == html.TextNode {
			pieces = append(pieces, piece{text: x.Data, bold: bold})
		}
		for c := x.FirstChild; c != nil; c = c.NextSibling {
			rec(c, bold)
		}
	}
	rec(cell, false)
	dropBold := false
	if bilingual {
		var hasBold, hasPlain bool
		for _, p := range pieces {
			if p.nested || strings.TrimSpace(p.text) == "" {
				continue
			}
			if p.bold {
				hasBold = true
			} else {
				hasPlain = true
			}
		}
		dropBold = hasBold && hasPlain
	}
	var b strings.Builder
	for _, p := range pieces {
		if p.bold && dropBold {
			continue
		}
		b.WriteString(p.text)
		b.WriteByte(' ')
	}
	s := strings.Join(strings.Fields(NormSpace(b.String())), " ")
	if dropBold {
		// The slash closing the national half can land at the start of
		// the English one: "/ Circle with 60 NM radius centered on ...".
		s = strings.TrimSpace(strings.TrimPrefix(s, "/"))
	}
	return s
}

// NestedTables returns the tables nested in a cell, outermost only.
func NestedTables(cell *html.Node) []*html.Node {
	var out []*html.Node
	var rec func(*html.Node)
	rec = func(x *html.Node) {
		for c := x.FirstChild; c != nil; c = c.NextSibling {
			if skipSubtree(c) {
				continue
			}
			if c.Type == html.ElementNode && c.Data == "table" {
				out = append(out, c)
				continue
			}
			rec(c)
		}
	}
	rec(cell)
	return out
}

func atoiDefault(s string, def int) int {
	n, err := strconv.Atoi(strings.TrimSpace(s))
	if err != nil || n < 1 {
		return def
	}
	return n
}

// Anchor is one <a href> with its visible text.
type Anchor struct {
	Href, Text string
}

// AnchorsIn returns the anchors under n in document order.
func AnchorsIn(n *html.Node) []Anchor {
	var out []Anchor
	for _, a := range Elems(n, "a") {
		if href := Attr(a, "href"); href != "" {
			out = append(out, Anchor{Href: href, Text: NodeText(a)})
		}
	}
	return out
}
