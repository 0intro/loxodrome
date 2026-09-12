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
	"strings"
)

var (
	// "1er mars": the ordinal marker sits between the day and the month, where
	// frDateRe expects whitespace.
	frOrdinalRe = regexp.MustCompile(`(?i)(\d{1,2})\s*(?:er|ère|re)\b`)
	// "Du 03 au 05 février 2026": the start states a bare day, borrowing the
	// month and year from the end.
	frBareStartRe = regexp.MustCompile(`(?i)\bdu\s+(\d{1,2})\s+au\b`)
)

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
