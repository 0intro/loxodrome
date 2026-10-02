// item.go finds the avitaillement entry on a VAC plate.
//
// The Atlas VAC prints an aerodrome's ground services as a fixed numbered
// list under "Informations diverses / Miscellaneous": 9 - Douanes,
// 10 - AVT, 11 - RFFS, and so on to 17. The numbering is what makes this
// readable at all; 417 of the 419 aerodrome plates of the 2026-09-03 cycle
// carry item 10 (the two that do not are the naval air stations LFRJ and
// LFRL, whose plate has no such list). An item withdrawn above it renumbers
// the rest: Le Havre's plate of 2026-10-01 prints "9 - AVT" and "10 -
// RFFS", so the head is item 10 or 9 and ends at the next item numbered
// after its own. Never another number: the helistation plates keep a list of
// their own (217 of the 237 carry "3 - AVT", set in two columns whose second
// runs on into the entry), which this reader leaves alone as it always has.
//
// The item ends at the next numbered item. It can also run into the bottom
// of a page, and the SIA's footer and the next page's header sit between it
// and its continuation, so the page furniture terminates it too and the
// reader records that it did: an entry cut by a page break is an entry we
// may have read only half of, and the count belongs in the sidecar rather
// than in a comment.

package main

import (
	"regexp"
	"strconv"
	"strings"
)

var (
	// avtHeadRe is the item's own head, item 10 or, renumbered, 9. The
	// leading class swallows the change-bar arrow the SIA prints beside an
	// amended line, and the colon is optional because a few plates print
	// "10 - AVT Carburant" with none.
	avtHeadRe = regexp.MustCompile(`^[^0-9A-Za-z]*(10|9)\s*-\s*AVT\b\s*:?\s*(.*)$`)

	// nextItemRe is a numbered item of the same list; avtItem takes only
	// one numbered after the fuel's own as its end.
	nextItemRe = regexp.MustCompile(`^[^0-9A-Za-z]*(\d{1,2})\s*-\s*[A-Za-zÀ-ÿ(]`)

	// furnitureRe is the page break: the SIA's footer, then the next
	// page's header.
	furnitureRe = regexp.MustCompile(`^\s*AMDT\b|©|^\s*AIP\s+FRANCE\b|\bAD\s+[23]\s+[A-Z0-9]{3,6}\s+(?:TXT|APP|ATT|GMC|APDC|ARC|ENV|VAT)\b`)
)

// itemEnd says what stopped the reader, which is the difference between a
// complete entry and one whose tail is on the next page.
type itemEnd string

const (
	endNextItem itemEnd = "next-item"
	endPage     itemEnd = "page"
	endDocument itemEnd = "document"
)

// avtItem returns the text of the AVT item and what terminated it. ok is
// false when the plate carries no such item.
func avtItem(text string) (body string, end itemEnd, ok bool) {
	lines := strings.Split(strings.ReplaceAll(text, "\f", "\n"), "\n")
	start, number := -1, 0
	var parts []string
	for i, ln := range lines {
		if start < 0 {
			if m := avtHeadRe.FindStringSubmatch(ln); m != nil {
				start = i
				number, _ = strconv.Atoi(m[1])
				if s := strings.TrimSpace(m[2]); s != "" {
					parts = append(parts, s)
				}
			}
			continue
		}
		switch {
		case laterItem(ln, number):
			return join(parts), endNextItem, true
		case furnitureRe.MatchString(ln):
			return join(parts), endPage, true
		}
		if s := strings.TrimSpace(ln); s != "" {
			parts = append(parts, s)
		}
	}
	if start < 0 {
		return "", "", false
	}
	return join(parts), endDocument, true
}

// laterItem reports a line opening the list's next item, numbered after
// the fuel's own: a numbered line inside the entry ("1 - JET A1 ...")
// counts from one and never ends it.
func laterItem(ln string, number int) bool {
	m := nextItemRe.FindStringSubmatch(ln)
	if m == nil {
		return false
	}
	n, err := strconv.Atoi(m[1])
	return err == nil && n > number
}

// join glues the item's lines back into one string. A '#' is the AIP's own
// line separator and the one the app's remark formatter renders as a break,
// so the entry reads on screen the way it reads on the plate.
func join(parts []string) string {
	return clean(strings.Join(parts, "#"))
}

// clean drops the characters a plate's own encoding leaves behind where a
// glyph could not be mapped, and squeezes the runs of spaces a column layout
// leaves between words.
//
// The SIA's producer subsets its fonts, and a glyph the extractor cannot
// resolve comes back either as a raw control byte or as a private-use code
// point: Dax prints "C\aarburants" where the plate reads "Carburants", and
// carries a U+F028 in the middle of a telephone number. cmd/supaip meets the
// same class of byte in the supplements. None of them carries meaning, and
// left in they reach the panel as stray unprintables in the middle of the
// AIP's own words. Line breaks are already carried as the AIP's own '#',
// which is what the app renders as one.
func clean(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		switch {
		case r < 0x20, r == 0x7f:
		case r >= 0xE000 && r <= 0xF8FF: // private use
		case r == 0xFFFD: // the decoder gave up on this one
		default:
			b.WriteRune(r)
		}
	}
	return strings.Join(strings.Fields(b.String()), " ")
}
