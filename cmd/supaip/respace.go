// respace.go: recover properly spaced zone names. The native rsc.io/pdf
// extractor drops intra-run spaces, so a zone name comes out jammed
// ("BaiedeSommeSud"Tempo); poppler's pdftotext -layout keeps the spaces
// ("Baie de Somme Sud" Tempo). We match a jammed name to its spaced form by
// reducing both to bare lower-case alphanumerics, then lift the original
// (spaced, accented) substring out of the layout text. No-op when poppler is
// unavailable or a name isn't found, so the heuristic prettifyName stands.

package main

import (
	"strings"
	"unicode/utf8"
)

// pdfTextAll returns the whole PDF as layout-preserved, word-spaced text.
func pdfTextAll(data []byte) (string, error) {
	out, err := runPdftotext(data, "-layout", "-", "-")
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// respaceZoneNames rewrites each zone's space-jammed name with its spaced form
// from pdftotext, matched on bare alphanumerics.
func respaceZoneNames(zones []zone, data []byte) {
	if len(zones) == 0 {
		return
	}
	text, err := pdfTextAll(data)
	if err != nil {
		return
	}
	norm, pos := normWithIndex(text)
	for i := range zones {
		if s := respaceName(zones[i].name, text, norm, pos); s != "" {
			zones[i].name = s
		}
	}
}

// respaceDoc respaces every jammed string in a result, zone names plus the
// coordination block (contact units, manager, penetration text), from a single
// pdftotext -layout pass. The build path uses it in place of respaceZoneNames
// so contacts come out word-spaced too; it no-ops when poppler is unavailable.
func respaceDoc(res *geomResult, data []byte) {
	text, err := pdfTextAll(data)
	if err != nil {
		return
	}
	norm, pos := normWithIndex(text)
	respace := func(s string) string {
		if r := respaceName(s, text, norm, pos); r != "" {
			return r
		}
		return s
	}
	for i := range res.zones {
		res.zones[i].name = respace(res.zones[i].name)
	}
	for i := range res.contacts {
		res.contacts[i].unit = respace(res.contacts[i].unit)
	}
	if res.manager != "" {
		res.manager = respace(res.manager)
	}
	if res.penetration != nil && res.penetration.text != "" {
		res.penetration.text = respace(res.penetration.text)
	}
}

// normWithIndex reduces text to lower-case alphanumerics and records, for each
// kept character, its byte offset in the original.
func normWithIndex(s string) (string, []int) {
	var b strings.Builder
	pos := make([]int, 0, len(s))
	for i, r := range s {
		switch {
		case r >= 'A' && r <= 'Z':
			b.WriteRune(r + 32)
			pos = append(pos, i)
		case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'):
			b.WriteRune(r)
			pos = append(pos, i)
		}
	}
	return b.String(), pos
}

// respaceName finds the spaced original of a jammed name in the layout text.
// Returns "" when the name is too short to match safely or is absent.
func respaceName(jammed, text, norm string, pos []int) string {
	needle := normalizeName(jammed)
	if len(needle) < 4 {
		return ""
	}
	k := strings.Index(norm, needle)
	if k < 0 {
		return ""
	}
	start, end := expandMarks(text, leadMark(jammed), pos[k], pos[k+len(needle)-1]+1)
	return collapseSpaces(dropOrphanMarks(ligatures.Replace(text[start:end])))
}

// leadMark returns the opening mark the jammed name itself starts with, or 0.
// Only that mark may be absorbed from the left of the span, which begins at the
// name's first letter: a mark in front of it belongs to the name only when the
// name carries one too. Ungated, a zone's first mention in the "Objet" sentence,
// where the SIA parenthesises it ("une zone interdite (ZIT CONCORDE) et cinq
// zones", 142/2026), hands the plain "ZITCONCORDE" cell parens it never had.
func leadMark(jammed string) rune {
	r, _ := utf8.DecodeRuneInString(jammed)
	switch r {
	case '"', '\'', '(', '«':
		return r
	}
	return 0
}

// unpairedMarks returns the byte offsets in s of the open and close marks the
// other side never matched, from a left-to-right scan in which each closer
// cancels the nearest opener before it. Counting cannot tell the two apart: the
// span lifted from the "Objet" line of 013/2026, `ZIT) ORANGE (84`, holds one of
// each and neither is paired. open and close must differ, so a quote, which is
// its own closer, is not a candidate.
func unpairedMarks(s string, open, close rune) (opens, closes []int) {
	for i, r := range s {
		switch r {
		case open:
			opens = append(opens, i)
		case close:
			if n := len(opens); n > 0 {
				opens = opens[:n-1]
			} else {
				closes = append(closes, i)
			}
		}
	}
	return opens, closes
}

// unclosed reports whether s opens a mark it never closes, the one case where
// expandMarks should look past the span's end for the closer.
func unclosed(s string, open, close rune) bool {
	opens, _ := unpairedMarks(s, open, close)
	return len(opens) > 0
}

// dropOrphanMarks removes the « » or ( ) marks the span could not pair, so a
// name never carries a lone bracket. A zone sliced out of a "« A and B »" group
// label keeps a dangling « (074/2026); a zone whose span starts inside the
// "Objet" sentence keeps the ) of the "(ZRT)" prefix in front of it (111/2026).
// Marks that do pair are part of the name and stay: "ZIT ORANGE (84)". Quotes
// are left alone, French names carrying an apostrophe of their own
// ("SAINT CYR L'ECOLE").
func dropOrphanMarks(s string) string {
	for _, m := range [...]struct{ open, close rune }{{'«', '»'}, {'(', ')'}} {
		opens, closes := unpairedMarks(s, m.open, m.close)
		// Every unpaired closer precedes every unpaired opener: an opener still
		// on the stack when a closer came would have paired with it. So the two
		// runs concatenate into one ascending list of offsets to cut.
		cut := append(closes, opens...)
		if len(cut) == 0 {
			continue
		}
		var b strings.Builder
		prev := 0
		for _, i := range cut {
			_, sz := utf8.DecodeRuneInString(s[i:])
			b.WriteString(s[prev:i])
			prev = i + sz
		}
		b.WriteString(s[prev:])
		s = b.String()
	}
	return s
}

// expandMarks re-includes the quotes / parens / guillemets the alphanumeric
// span dropped: an opening mark touching the start, but only the one the jammed
// name itself begins with (lead, see leadMark), and the closing mark (after any
// spaces) that balances an opener the span leaves unclosed, so `« AVEL` regains
// its trailing `»`. Multi-byte « » are handled.
func expandMarks(text string, lead rune, start, end int) (int, int) {
	if lead != 0 && start > 0 {
		if r, sz := utf8.DecodeLastRuneInString(text[:start]); r == lead {
			start -= sz
		}
	}
	span := text[start:end]
	var closer rune
	switch {
	case unclosed(span, '«', '»'):
		closer = '»'
	case unclosed(span, '(', ')'):
		closer = ')'
	case strings.Count(span, `"`)%2 == 1:
		closer = '"'
	case strings.Count(span, "'")%2 == 1:
		closer = '\''
	}
	if closer != 0 {
		j := end
		for j < len(text) && text[j] == ' ' {
			j++
		}
		if r, sz := utf8.DecodeRuneInString(text[j:]); r == closer {
			end = j + sz
		}
	}
	return start, end
}

// collapseSpaces trims and collapses any run of whitespace (incl. the wide gaps
// pdftotext -layout inserts, and a wrap newline) to a single space.
func collapseSpaces(s string) string {
	return strings.Join(strings.Fields(s), " ")
}
