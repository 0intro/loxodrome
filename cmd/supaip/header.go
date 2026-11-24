// header.go: the cover-page fields the listing used to supply.
//
// A supplement recovered from the media store has no listing row, so the two
// things only the listing carried, its subject and its validity, have to come
// from the document instead. Page 1 prints both:
//
//	Objet :        Création d'une zone interdite temporaire (ZIT) ...
//	En vigueur :   Du jeudi 09 juillet au mardi 14 juillet 2026
//
// The subject reuses enSubject's machinery, which already gathers a value that
// wraps above and below its own label. The validity is its own small parser
// because the start year is omitted whenever both ends fall in the same year.

package main

import (
	"regexp"
	"strconv"
	"strings"
)

var (
	// "1er mars": the ordinal marker sits between the day and the month, where
	// frDateRe expects whitespace.
	frOrdinalRe = regexp.MustCompile(`(?i)(\d{1,2})\s*(?:er|ère|re)\b`)
	// "Du 03 au 05 février 2026": the start states a bare day, borrowing the
	// month and year from the end.
	frBareStartRe = regexp.MustCompile(`(?i)\bdu\s+(\d{1,2})\s+au\b`)
	// The replacement clause, folded: "CE SUP AIP ANNULE ET REMPLACE LE SUP
	// AIP 240/2026." reads "cesupaipannuleetremplacelesupaip240/2026."
	// whichever reader rebuilt the line.
	replacesRe = regexp.MustCompile(`cesupaipannuleetremplacel(?:e|es)supaip`)
	// One folded reference: "240/2026", "165/25", or an AIRAC supplement's
	// "airac228/24".
	supRefRe = regexp.MustCompile(`^(?:airac)?(\d{1,3})/(\d{4}|\d{2})`)
)

// supRef is a supplement's number and year, as one supplement cites another.
type supRef struct {
	number, year int
}

// parseReplaces reads the supplements a successor cancels and replaces. Its
// cover page says so under the validity:
//
//	CE SUP AIP ANNULE ET REMPLACE LE SUP AIP 240/2026.
//
// A reference wrapped onto the next line is read there, and several joined
// by "ET" or a comma are read in turn. rsc.io/pdf hands some cover pages'
// header lines back reversed, so a line is also read backwards. 077/2026's
// clause reads
//
//	.52/561PIAPUSELECALPMERTEELUNNAPIAPUSEC
//
// The SIA's other replacements ("Ce tableau annule et remplace le tableau
// AD 2 NTMN DATA 01") change a page of the AIP and replace no supplement.
func parseReplaces(lines []string) []supRef {
	for i, l := range lines {
		f := fold(l)
		loc := replacesRe.FindStringIndex(f)
		next := i + 1
		if loc == nil {
			f = reverse(f)
			loc = replacesRe.FindStringIndex(f)
			next = len(lines)
		}
		if loc == nil {
			continue
		}
		rest := f[loc[1]:]
		if next < len(lines) {
			rest += fold(lines[next])
		}
		var refs []supRef
		for {
			m := supRefRe.FindStringSubmatch(rest)
			if m == nil {
				break
			}
			// supRefRe matched digits alone, which Atoi always reads.
			n, _ := strconv.Atoi(m[1])
			y, _ := strconv.Atoi(m[2])
			if y < 100 {
				y += 2000
			}
			refs = append(refs, supRef{n, y})
			rest = rest[len(m[0]):]
			rest = strings.TrimPrefix(rest, ",")
			rest = strings.TrimPrefix(rest, "et")
			rest = strings.TrimPrefix(rest, "lesupaip")
		}
		return refs
	}
	return nil
}

// reverse returns s with its bytes in reverse order, which is its runes'
// order too for the ASCII fold hands back.
func reverse(s string) string {
	b := []byte(s)
	for i, j := 0, len(b)-1; i < j; i, j = i+1, j-1 {
		b[i], b[j] = b[j], b[i]
	}
	return string(b)
}

// frSubject pulls the French subject from a supplement PDF, the value the
// listing table gave as descriptionFr.
func frSubject(data []byte) string {
	if len(data) == 0 {
		return ""
	}
	text, err := pdfTextFirstPage(data)
	if err != nil {
		return ""
	}
	return subjectForLabel(text, "Objet")
}

// frValidity pulls the "En vigueur : Du <date> au <date>" window as two
// YYYY-MM-DD dates, the values the listing table gave as validFrom / validTo.
// Both are empty when the line is missing or unreadable, which leaves the row
// open-ended rather than inventing a window for it.
func frValidity(data []byte) (string, string) {
	if len(data) == 0 {
		return "", ""
	}
	text, err := pdfTextFirstPage(data)
	if err != nil {
		return "", ""
	}
	return validityFromText(text)
}

// validityFromText is the layout-text half of frValidity, split out for
// testing.
func validityFromText(text string) (string, string) {
	for _, l := range strings.Split(text, "\n") {
		if !strings.Contains(l, "En vigueur") {
			continue
		}
		value := l
		if c := strings.Index(l, ":"); c >= 0 {
			value = l[c+1:]
		}
		value = frOrdinalRe.ReplaceAllString(value, "$1")
		ms := frDateRe.FindAllStringSubmatch(value, -1)
		if len(ms) == 0 {
			continue
		}
		// The END is read first on purpose. parseFrDate carries a year FORWARD
		// through its accumulator, and the document omits the start's year
		// whenever it matches the end's ("Du lundi 20 juillet au vendredi 31
		// juillet 2026"), so the end has to set it before the start is parsed.
		year := 0
		to := parseFrDate(ms[len(ms)-1], &year)
		if to == "" {
			continue
		}
		if len(ms) == 1 {
			// One date carries two grammars. "Du 03 au 05 février 2026" states
			// the start as a bare day sharing the end's month; "Le jeudi 09
			// juillet 2026" is a single day, and opens and closes on it.
			if d := frBareStartRe.FindStringSubmatch(value); d != nil {
				return withDay(to, d[1]), to
			}
			return to, to
		}
		from := parseFrDate(ms[0], &year)
		if from == "" {
			continue
		}
		return from, to
	}
	return "", ""
}

// withDay rewrites an ISO date's day, for a start that states only its own day
// and takes the month and year from the end of the window.
func withDay(iso, day string) string {
	if len(iso) != 10 || len(day) == 0 {
		return iso
	}
	if len(day) == 1 {
		day = "0" + day
	}
	return iso[:8] + day
}
