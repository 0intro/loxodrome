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

// enSubject pulls the English subject from an EN supplement PDF. In -layout the
// value may sit after the "Subject :" label on the same line, or (when it wraps)
// on the lines directly above and below the label, which floats at the value
// block's vertical centre. We gather all three, bounded by blank lines and the
// neighbouring "<label> :" fields. Templates vary, hence both directions.
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

// subjectFromText is the layout-text half of enSubject, split out for testing.
func subjectFromText(text string) string {
	return subjectForLabel(text, "Subject")
}

// subjectForLabel is the same gather over any label, so the French cover page's
// "Objet" reads exactly like the English "Subject" (header.go). The value may
// sit after the label on its own line, or wrap above and below it, the label
// floating at the value block's vertical centre.
func subjectForLabel(text, label string) string {
	lines := strings.Split(ligatures.Replace(text), "\n")
	const maxWrap = 4 // a subject is at most a few wrapped lines per side
	for i, l := range lines {
		if !strings.Contains(l, label) {
			continue
		}
		var up, down []string
		if c := strings.Index(l, ":"); c >= 0 {
			if v := strings.TrimSpace(l[c+1:]); v != "" {
				down = append(down, v)
			}
		}
		for j := i - 1; j >= 0 && len(up) < maxWrap; j-- {
			t := strings.TrimSpace(lines[j])
			if t == "" || isFieldLabel(t) || isHeaderNoise(t) {
				break
			}
			up = append(up, t)
		}
		for j := i + 1; j < len(lines) && len(down) < maxWrap; j++ {
			t := strings.TrimSpace(lines[j])
			if t == "" || isFieldLabel(t) || isHeaderNoise(t) {
				break
			}
			down = append(down, t)
		}
		for a, b := 0, len(up)-1; a < b; a, b = a+1, b-1 {
			up[a], up[b] = up[b], up[a] // collected bottom-to-top
		}
		return strings.TrimSpace(strings.Join(append(up, down...), " "))
	}
	return ""
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
