// sd.go reads the structured-data tags the EUROCONTROL eAIP generator
// hides in the pages of the packages built from an EAD-SDO database (the
// United Kingdom's, Czechia's and Norway's): every value the page prints
// from the database is a visible span followed by a hidden one naming
// where it came from,
//
//	<span class="SD">550000N</span><span class="sdParams" style="display: none;">TAIRSPACE_VERTEX;GEO_LAT;3732</span>
//
// in the AIXM 4.5 table and column vocabulary, with the record's key. The
// text readers never see the hidden half (NodeText skips what a page
// hides), so the tags are a truth independent of them, which is what the
// oracle in sd_oracle_test.go holds them against.

package eaip

import (
	"strings"

	"golang.org/x/net/html"
)

// SDValue is one tagged value.
type SDValue struct {
	// Table and Column are the database's names for the value
	// (TAIRSPACE_VERTEX, GEO_LAT), Record the row's key ("3732").
	Table, Column, Record string
	// Value is the text the page prints.
	Value string
}

// SDTags returns the tagged values under n, in document order.
func SDTags(n *Node) []SDValue {
	var out []SDValue
	for _, p := range FindAll(n, func(x *Node) bool { return IsElem(x) && x.Data == "span" && HasClass(x, "sdParams") }) {
		parts := strings.Split(strings.TrimSpace(rawText(p)), ";")
		if len(parts) != 3 {
			continue
		}
		v := SDValue{Table: parts[0], Column: parts[1], Record: parts[2]}
		// The value is the span just before the tag, skipping any text
		// the generator left between them.
		for s := p.PrevSibling; s != nil; s = s.PrevSibling {
			if IsElem(s) {
				if s.Data == "span" && HasClass(s, "SD") {
					v.Value = NormSpace(rawText(s))
				}
				break
			}
		}
		out = append(out, v)
	}
	return out
}

// rawText is a node's text, hidden or not.
func rawText(n *Node) string {
	var b strings.Builder
	var walk func(*Node)
	walk = func(x *Node) {
		if x.Type == html.TextNode {
			b.WriteString(x.Data)
		}
		for c := x.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(n)
	return b.String()
}
