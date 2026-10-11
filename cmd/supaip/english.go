// english.go: extract a supplement's English subject line from its EN PDF.
// The English description isn't on the (French) listing page; it lives only in
// the parallel lf_sup_..._en.pdf. poppler's pdftotext preserves the word
// spaces rsc.io/pdf drops, so the human-readable subject comes from there. When
// pdftotext is unavailable or the EN PDF is absent, the description is left
// empty (the SPA falls back to French).

package main

import (
	"strings"
)

// enFilename is the English sibling of a French PDF filename
// (lf_sup_2026_079_fr.pdf -> lf_sup_2026_079_en.pdf).
func enFilename(fr string) string {
	return strings.Replace(fr, "_fr.pdf", "_en.pdf", 1)
}

// pdfTextFirstPage returns the first page's text (word-spaced, layout-preserved)
// via pdftotext. -layout keeps each field's value on/around its label line.
func pdfTextFirstPage(data []byte) (string, error) {
	out, err := runPdftotext(data, "-layout", "-f", "1", "-l", "1", "-", "-")
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// fixLigatures restores the ff/fi/fl ligatures poppler keeps as single glyphs
// ("With eﬀect", "traﬃc"), so the stored text is plain ASCII-friendly.
var ligatures = strings.NewReplacer("ﬀ", "ff", "ﬁ", "fi", "ﬂ", "fl", "ﬃ", "ffi", "ﬄ", "ffl")

// enSubject pulls the English subject from an EN supplement PDF. In -layout
// the value may sit after the subject head on the same line, or (when it
// wraps) on the lines directly above and below the head, which floats at the
// value block's vertical centre; subjectForLabel gathers all three and states
// what bounds them.
func enSubject(data []byte) string {
	if len(data) == 0 {
		return ""
	}
	text, err := pdfTextFirstPage(data)
	if err != nil {
		return ""
	}
	return subjectFromText(text)
}

// enSubjectLabels are the heads the SIA's English template prints the subject
// under, tried in order. 252 of the 253 supplements in the corpus print
// "Subject"; 159/2025 prints "Object", the word-for-word rendering of the
// French "Objet", and was the one row in the whole dataset carrying no English
// subject at all. No document in the corpus prints both, so the fallback never
// contends with a head that already read.
var enSubjectLabels = []string{"Subject", "Object"}

// subjectFromText is the layout-text half of enSubject, split out for testing.
func subjectFromText(text string) string {
	for _, label := range enSubjectLabels {
		if s := subjectForLabel(text, label); s != "" {
			return s
		}
	}
	return ""
}

// subjectForLabel is the same gather over any label, so the French cover page's
// "Objet" reads exactly like the English "Subject" (header.go). The value may
// sit after the label on its own line, or wrap above and below it, the label
// floating at the value block's vertical centre.
//
// TWO templates are in use and they disagree about punctuation. Most cover
// pages print "Objet :" / "Subject :", and the next "<Label> :" field is what
// bounds the value. A minority print every head BARE ("Subject" alone on its
// line, "With effect From 04th September 2025 to 25th November 2026" under
// it), and there a colon-seeking bound cannot see the next field at all: it
// reads straight through and glues the validity onto the subject, which is
// what 147/2025 carried into the dataset. Only that template needs the COLUMN
// as its bound, its wraps being indented past the head while the next head
// returns to the head's own column, so the bound is taken ONLY where the
// colon is missing: 009/2026 wraps its subject back to the head's own column
// under a perfectly ordinary "Objet :", and a column bound applied there
// would cut the aerodrome's name off the end of it.
func subjectForLabel(text, label string) string {
	lines := strings.Split(ligatures.Replace(text), "\n")
	const maxWrap = 4 // a subject is at most a few wrapped lines per side
	for i, l := range lines {
		if !labelHead(l, label) {
			continue
		}
		v, bare := headParts(l, label)
		col := noColumnBound
		if bare {
			col = indentOf(l)
		}
		var up, down []string
		if v != "" {
			down = append(down, v)
		}
		for j := i - 1; j >= 0 && len(up) < maxWrap; j-- {
			if !isWrapLine(lines[j], col) {
				break
			}
			up = append(up, strings.TrimSpace(lines[j]))
		}
		for j := i + 1; j < len(lines) && len(down) < maxWrap; j++ {
			if !isWrapLine(lines[j], col) {
				break
			}
			down = append(down, strings.TrimSpace(lines[j]))
		}
		for a, b := 0, len(up)-1; a < b; a, b = a+1, b-1 {
			up[a], up[b] = up[b], up[a] // collected bottom-to-top
		}
		return strings.TrimSpace(strings.Join(append(up, down...), " "))
	}
	return ""
}

// labelHead reports whether line prints label as a field head: the label is
// the line's first word, with or without the colon the bare template drops.
// Reading the word anywhere on the line is what the "Object" fallback cannot
// afford, since "Objective", "Objects" and any prose "Object" contain it, and
// a subject read off a sentence is worse than the French one the SPA falls
// back to when there is none.
func labelHead(line, label string) bool {
	rest, ok := strings.CutPrefix(strings.TrimLeft(line, " \t"), label)
	if !ok {
		return false
	}
	return rest == "" || strings.HasPrefix(rest, ":") ||
		strings.HasPrefix(rest, " ") || strings.HasPrefix(rest, "\t")
}

// headParts splits a head line into the value it carries after the label, the
// whole subject in the one-line template and nothing in the floating one, and
// whether the head was printed BARE, with no colon to announce the field.
func headParts(line, label string) (value string, bare bool) {
	rest := strings.TrimSpace(strings.TrimPrefix(strings.TrimLeft(line, " \t"), label))
	if v, ok := strings.CutPrefix(rest, ":"); ok {
		return strings.TrimSpace(v), false
	}
	return rest, true
}

// noColumnBound disables isWrapLine's column test, every line being indented
// past it. It is what a head with a colon uses, the next field announcing
// itself there.
const noColumnBound = -1

// isWrapLine reports whether a line continues the value of a head printed at
// column col: it must carry text, be indented past the head, and be neither
// the next field nor page furniture.
func isWrapLine(line string, col int) bool {
	t := strings.TrimSpace(line)
	return t != "" && indentOf(line) > col && !isFieldLabel(t) && !isHeaderNoise(t)
}

// indentOf is a line's leading-whitespace width, the column pdftotext -layout
// prints it at. Leading whitespace is ASCII, so the byte index is the column.
func indentOf(line string) int {
	for i := 0; i < len(line); i++ {
		if line[i] != ' ' && line[i] != '\t' {
			return i
		}
	}
	return len(line)
}

// isHeaderNoise reports page furniture that must not be read as subject text.
func isHeaderNoise(t string) bool {
	return strings.Contains(t, "AIP SUP") || strings.Contains(t, "Page ") || strings.Contains(t, "SIA")
}

// isFieldLabel reports whether a line is the next "<Label> :" field (e.g.
// "With effect :", "Locations :"), which bounds the subject value.
func isFieldLabel(line string) bool {
	i := strings.Index(line, ":")
	if i <= 0 || i > 24 {
		return false
	}
	label := strings.TrimSpace(line[:i])
	return label != "" && len(strings.Fields(label)) <= 3
}
