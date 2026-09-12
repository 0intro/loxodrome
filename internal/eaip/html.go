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
	rows := TableRows(table)
	grid := map[[2]int]string{}
	occupied := map[[2]int]bool{}
	maxCol := 0
	for ri, tr := range rows {
		ci := 0
		for _, c := range RowCells(tr) {
			for occupied[[2]int{ri, ci}] {
				ci++
			}
			text := NodeText(c)
			rs := atoiDefault(Attr(c, "rowspan"), 1)
			cs := atoiDefault(Attr(c, "colspan"), 1)
			for dr := 0; dr < rs; dr++ {
				for dc := 0; dc < cs; dc++ {
					p := [2]int{ri + dr, ci + dc}
					grid[p] = text
					occupied[p] = true
				}
			}
			ci += cs
			if ci > maxCol {
				maxCol = ci
			}
		}
	}
	out := make([][]string, len(rows))
	for ri := range rows {
		row := make([]string, maxCol)
		for ci := 0; ci < maxCol; ci++ {
			row[ci] = grid[[2]int{ri, ci}]
		}
		out[ri] = row
	}
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
