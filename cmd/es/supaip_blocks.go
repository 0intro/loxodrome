// supaip_blocks.go: one linear, kind-tagged view of a supplement body,
// shared by the HTML editions and the pdftotext fallback so ONE grammar
// (supaip_geom.go) serves both.
//
// The ENAIRE template writes the same supplement four ways. A zone
// heading is an <h4> ("ZONA 1: SFC - 4000 ft AMSL MAX:") in one
// supplement and a strong-only paragraph ("<p><strong>DFN-26 ZONA
// E:</strong></p>") in the next, and the "Limites laterales:" marker is
// itself a strong-only paragraph in a third. Vertices arrive as <ol>
// items, as one paragraph per line, or as a table row. Classifying each
// element once, here, is what keeps the state machine readable.
//
// The <tr> rule is load-bearing for correctness, not tidiness. An AIRAC
// supplement carries its instrument-procedure annexes as REAL tables
// whose cells hold coordinates: "DVOR/DME SIE (IAF) | 410906.1N |
// 0033616.8W" splits a pair across two cells that concatenate into a
// valid one, and a "WPT | COORD" table prints whole pairs. Emitting a
// row as cells (and never descending into it, so its inner <p>s stay
// invisible) is what lets the geometry pass read table rows ONLY in
// obstacle-table scope and ignore every annex.

package main

import (
	"strings"

	"github.com/0intro/loxodrome/internal/eaip"
	"golang.org/x/net/html"
)

// blockKind tags one body element.
type blockKind int

const (
	blockPara blockKind = iota
	blockHeading
	blockItem     // an <ol> item: an ORDERED vertex list
	blockBullet   // a <ul> item: a SET of positions, never a boundary
	blockTableRow // cells, never text-harvested outside obstacle scope
)

// esBlock is one element of a supplement body, in document order.
type esBlock struct {
	kind  blockKind
	text  string
	cells []string // blockTableRow only
}

// blocksFromHTML linearizes a parsed supplement page. It reads <main>
// when present (the ENAIRE template puts the subject and the zone
// definitions there, the validity block and the footer outside it) and
// falls back to <body> for pages that predate the template.
func blocksFromHTML(doc *eaip.Node) []esBlock {
	root := firstElem(doc, "main")
	if root == nil {
		root = firstElem(doc, "body")
	}
	if root == nil {
		root = doc
	}
	var out []esBlock
	var rec func(n *eaip.Node)
	rec = func(n *eaip.Node) {
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			if c.Type != html.ElementNode {
				continue
			}
			switch c.Data {
			case "h1", "h2", "h3", "h4", "h5", "h6":
				add(&out, esBlock{kind: blockHeading, text: eaip.NodeText(c)})
				continue
			case "pre":
				// The English editions set some phrases as preformatted
				// blocks ("Semicircle with a radius of 6 NM"), which are
				// prose the grammar must still see.
				add(&out, esBlock{kind: blockPara, text: eaip.NodeText(c)})
				continue
			case "p":
				k := blockPara
				text := eaip.NodeText(c)
				// The template's own zone headings and section markers:
				// bold text alone in a paragraph. A bold paragraph that
				// HOLDS coordinates is a vertex line set in bold (the text
				// path applies the same guard), and reading it as a heading
				// would cut one ring into two partial polygons.
				if strongOnly(c) && !eaip.CoordRe.MatchString(normCoordText(text)) {
					k = blockHeading
				}
				add(&out, esBlock{kind: k, text: text})
				continue
			case "li":
				// Ordered and unordered lists mean different things
				// here. "<ol type=\"a\">" is how the template writes a
				// boundary, vertex by lettered vertex; a "<ul>" is a set
				// of positions ("the beacons at the following
				// coordinates are out of service"), which is not a ring
				// and must never be joined into one.
				k := blockBullet
				if n.Data == "ol" {
					k = blockItem
				}
				add(&out, esBlock{kind: k, text: eaip.NodeText(c)})
				continue
			case "tr":
				var cells []string
				for _, td := range eaip.Elems(c, "td", "th") {
					cells = append(cells, eaip.NodeText(td))
				}
				out = append(out, esBlock{kind: blockTableRow, text: eaip.NodeText(c), cells: cells})
				continue
			}
			rec(c)
		}
	}
	rec(root)
	return out
}

// blocksFromText maps `pdftotext -layout` output onto the same view, for
// the handful of supplements published with no HTML edition. A line that
// ends in a colon, or is short and all-caps, reads as a heading; a line
// holding two or more runs of whitespace-separated columns cannot be
// told from prose here, so everything else is a paragraph (the geometry
// pass tolerates that: it keys on markers, not on layout).
func blocksFromText(text string) []esBlock {
	var out []esBlock
	for _, line := range strings.Split(text, "\n") {
		s := strings.Join(strings.Fields(eaip.NormSpace(line)), " ")
		if s == "" {
			continue
		}
		k := blockPara
		// A line carrying coordinates is never a heading, however it is
		// cased: "404130N 0043655W," is all upper case and short.
		if !eaip.CoordRe.MatchString(normCoordText(s)) &&
			(strings.HasSuffix(s, ":") ||
				(len(s) <= 60 && s == strings.ToUpper(s) && strings.ContainsAny(s, "ABCDEFGHIJKLMNOPQRSTUVWXYZ"))) {
			k = blockHeading
		}
		out = append(out, esBlock{kind: k, text: s})
	}
	return out
}

// add appends a block unless it carries no text (the template emits many
// empty spacing paragraphs).
func add(out *[]esBlock, b esBlock) {
	if strings.TrimSpace(b.text) == "" {
		return
	}
	*out = append(*out, b)
}

// strongOnly reports whether a paragraph's whole visible text comes from
// <strong>/<b> children: the template's way of writing a heading.
func strongOnly(p *eaip.Node) bool {
	full := strings.TrimSpace(eaip.NodeText(p))
	if full == "" {
		return false
	}
	var bold strings.Builder
	for _, s := range eaip.Elems(p, "strong", "b") {
		bold.WriteString(eaip.NodeText(s))
		bold.WriteByte(' ')
	}
	got := strings.Join(strings.Fields(bold.String()), " ")
	return got != "" && got == full
}

// firstElem returns the first element with the given tag, or nil.
func firstElem(n *eaip.Node, tag string) *eaip.Node {
	if els := eaip.Elems(n, tag); len(els) > 0 {
		return els[0]
	}
	return nil
}

// fold lowercases and strips the Spanish diacritics, so one marker table
// serves "Límites laterales", "LIMITES LATERALES" and "Lateral limits"
// alike. Deliberately a small explicit map rather than a normalization
// dependency: these are the only marks the corpus uses.
var foldRepl = strings.NewReplacer(
	"á", "a", "é", "e", "í", "i", "ó", "o", "ú", "u", "ü", "u", "ñ", "n",
	"Á", "a", "É", "e", "Í", "i", "Ó", "o", "Ú", "u", "Ü", "u", "Ñ", "n",
	"à", "a", "è", "e", "ì", "i", "ò", "o", "ù", "u",
	"º", "", "°", "",
)

func fold(s string) string {
	return foldRepl.Replace(strings.ToLower(strings.TrimSpace(s)))
}
