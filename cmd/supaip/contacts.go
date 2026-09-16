// contacts.go: parse a supplement's coordination block into SUP-level fields:
//
//   - the "Activité réelle connue de" radio table (the units, and the
//     frequencies to reach them on, that hold a zone's real-time status) ->
//     []contactFreq;
//   - the "CONDITIONS DE PÉNÉTRATION" rule -> a kind + verbatim text;
//   - the "ORGANISME GESTIONNAIRE" managing unit -> a string.
//
// All three are parsed off the same reconstructed []prow the geometry and
// activation parsers use. The native extractor drops intra-run spaces, so the
// unit names / manager / rule text come out jammed ("SeineINFO"); respaceDoc
// (respace.go) lifts the spaced originals afterwards, exactly as for zone names.
//
// SUP-level for now: a NOTAM viewer that wants per-zone contacts (the big
// military SUPs repeat the table per zone in side-by-side columns) is a later
// phase; here every block in the document is unioned.

package main

import (
	"regexp"
	"strconv"
	"strings"
)

// contactFreq is one "real-activity known to" entry: a control unit and the
// frequencies to reach it on. note carries a non-numeric value ("fréquences de
// contrôle", "FREQ CTL") when the SUP gives one instead of figures.
type contactFreq struct {
	unit  string
	freqs []string
	note  string
}

// penetrationRule is the CONDITIONS DE PÉNÉTRATION classification + raw text.
type penetrationRule struct {
	kind string // circumvent | forbidden | conditional | other
	text string
}

// freqRe matches one VHF/UHF frequency: 2-3 integer digits, a dot or (overseas /
// military) decimal comma, 1-3 fractional digits. No word boundaries: the
// reconstructed text jams the unit and the "MHz" suffix onto the figure
// ("SeineINFO:127.815MHz").
var freqRe = regexp.MustCompile(`\d{2,3}[.,]\d{1,3}`)

// airbandFreq reports whether a figure is a plausible contact frequency:
// VHF 108-144 MHz (civil airband plus the military CDC extension; the SUPs
// publish e.g. 143.550) or military UHF 225-400 MHz. freqRe alone also
// matches dotted phone numbers ("PNIA : 03.62.94.21.30" yields "03.62",
// "94.21") and distances; a wrong frequency is better absent than stored.
func airbandFreq(tok string) bool {
	v, err := strconv.ParseFloat(strings.ReplaceAll(tok, ",", "."), 64)
	if err != nil {
		return false
	}
	return (v >= 108 && v <= 144) || (v >= 225 && v <= 400)
}

// phoneRe matches a French phone number (the manager block lists several).
var phoneRe = regexp.MustCompile(`0\d[\s.]?\d\d[\s.]?\d\d[\s.]?\d\d[\s.]?\d\d`)

// headingPrefixes are the SUP section headings (folded, accent- and
// space-stripped). A row whose folded text STARTS with one closes the block
// being read. Anchoring on the prefix, not a substring, is what separates a
// heading ("Organisme gestionnaire") from rule prose that mentions the same
// word ("autorisation du gestionnaire"): the prose starts with another word.
// fold drops accents entirely, so "Généralités" -> "gnralits".
var headingPrefixes = []string{
	"services", "statut", "limites", "dispositions", "gestionnaire",
	"organisme", "remarques", "gnralit", "informationdes",
	"datesetheures", "conditions",
}

func isHeadingRow(t string) bool {
	f := fold(t)
	for _, w := range headingPrefixes {
		if strings.HasPrefix(f, w) {
			return true
		}
	}
	return false
}

// parseContacts extracts every "Activité réelle connue de" entry across the
// document, unioned and deduped. The forecast line "Prévision d'activité connue
// de ..." (who knows the *forecast*, not the live status) is excluded.
func parseContacts(rows []prow) []contactFreq {
	var out []contactFreq
	seen := map[string]bool{}
	for i := 0; i < len(rows); i++ {
		f := fold(rows[i].text())
		// "Prévision d'activité connue de ..." (the forecast contacts, not the
		// live table) is excluded. fold drops the accents, so "Prévision" ->
		// "prvision".
		if !strings.Contains(f, "connuede") || strings.Contains(f, "prvision") || strings.Contains(f, "prevision") {
			continue
		}
		j := i + 1
		for ; j < len(rows) && j < i+30; j++ {
			t := rows[j].text()
			if isPageNoise(fold(t)) {
				continue
			}
			if isHeadingRow(t) {
				break
			}
			c, ok := parseContactLine(t)
			if !ok {
				continue
			}
			key := c.unit + "|" + strings.Join(c.freqs, ",") + "|" + c.note
			if seen[key] {
				continue
			}
			seen[key] = true
			out = append(out, c)
		}
		i = j // skip the block we just consumed
	}
	return out
}

// parseContactLine reads one "UNIT : freqs" row. The unit is the text before the
// first colon (or, colon-less, before the first frequency); freqs are every
// airband figure after it, comma normalised to a dot. A colon line whose value
// is non-numeric but frequency-ish ("FREQ CTL") becomes a note instead.
func parseContactLine(line string) (contactFreq, bool) {
	var freqs []string
	firstIdx := -1
	for _, loc := range freqRe.FindAllStringIndex(line, -1) {
		tok := line[loc[0]:loc[1]]
		if !airbandFreq(tok) {
			continue
		}
		if firstIdx < 0 {
			firstIdx = loc[0]
		}
		freqs = append(freqs, tok)
	}
	var unit, note string
	if colon := strings.Index(line, ":"); colon >= 0 {
		unit = cleanUnit(line[:colon])
		if len(freqs) == 0 {
			note = strings.TrimSpace(line[colon+1:])
			nf := fold(note)
			noteIsFreq := strings.Contains(nf, "freq") || strings.Contains(nf, "frqu") || strings.Contains(nf, "ctl")
			if unit == "" || note == "" || len(note) > 40 || !hasUpper(unit) || !noteIsFreq {
				return contactFreq{}, false
			}
		}
	} else {
		if len(freqs) == 0 {
			return contactFreq{}, false
		}
		unit = cleanUnit(line[:firstIdx])
	}
	if unit == "" {
		return contactFreq{}, false
	}
	return contactFreq{unit: unit, freqs: normFreqs(freqs), note: note}, true
}

// parsePenetration finds the CONDITIONS DE PÉNÉTRATION rule. Accents arrive
// garbled (U+FFFD) in the native extractor, so the header is matched on the
// accent-stripped fold ("conditionsdepntration").
func parsePenetration(rows []prow) *penetrationRule {
	for i := 0; i < len(rows); i++ {
		f := fold(rows[i].text())
		if !strings.Contains(f, "conditionsde") || !(strings.Contains(f, "pntration") || strings.Contains(f, "penetration")) {
			continue
		}
		var parts []string
		for j := i + 1; j < len(rows) && j < i+8 && len(parts) < 3; j++ {
			t := strings.TrimSpace(rows[j].text())
			if isPageNoise(fold(t)) {
				continue
			}
			if isHeadingRow(t) {
				break
			}
			parts = append(parts, t)
		}
		if len(parts) == 0 {
			return nil
		}
		kind := classifyPenetration(strings.Join(parts, " "))
		// text: the single line carrying the verdict (the cleanest line; the
		// exception lines that follow often garble), else the first line.
		text := parts[0]
		for _, p := range parts {
			if classifyPenetration(p) != "other" {
				text = p
				break
			}
		}
		return &penetrationRule{kind: kind, text: strings.TrimSpace(text)}
	}
	return nil
}

// classifyPenetration buckets the rule text (folded, accent-insensitive).
func classifyPenetration(text string) string {
	f := fold(text)
	switch {
	case strings.Contains(f, "contournement") && strings.Contains(f, "obligatoire"):
		return "circumvent"
	case strings.Contains(f, "interdit"):
		return "forbidden"
	case strings.Contains(f, "autorisation") || strings.Contains(f, "coordination") ||
		strings.Contains(f, "contactradio") || strings.Contains(f, "clairance"):
		return "conditional"
	default:
		return "other"
	}
}

// parseManager returns the ORGANISME GESTIONNAIRE text, phone lines dropped.
func parseManager(rows []prow) string {
	for i := 0; i < len(rows); i++ {
		if !isManagerHeading(rows[i]) {
			continue
		}
		var parts []string
		for j := i + 1; j < len(rows) && j < i+8 && len(parts) < 4; j++ {
			t := strings.TrimSpace(rows[j].text())
			if isPageNoise(fold(t)) {
				continue
			}
			if isHeadingRow(t) {
				break
			}
			if isPhoneLine(t) {
				continue
			}
			parts = append(parts, t)
		}
		if s := strings.TrimSpace(strings.Join(parts, " ")); s != "" {
			return s
		}
	}
	return ""
}

// isManagerHeading distinguishes the "ORGANISME GESTIONNAIRE(S)" heading (or a
// bare "GESTIONNAIRES") from prose that merely mentions "le gestionnaire".
func isManagerHeading(r prow) bool {
	f := fold(r.text())
	if f == "gestionnaire" || f == "gestionnaires" {
		return true
	}
	return strings.Contains(f, "organisme") && strings.Contains(f, "gestionnaire")
}

// isPhoneLine reports a line that is a phone number / phone label (Téléphone
// folds to "tlphone", so match on "phone"; PNIA / GSM too), so the manager text
// keeps only the organisation.
func isPhoneLine(t string) bool {
	f := fold(t)
	if strings.Contains(f, "phone") || strings.Contains(f, "pnia") || strings.Contains(f, "gsm") {
		return true
	}
	return phoneRe.MatchString(t) && len(strings.Fields(t)) <= 6
}

// normFreqs normalises decimal commas to dots and dedupes, order preserved.
func normFreqs(toks []string) []string {
	var out []string
	seen := map[string]bool{}
	for _, t := range toks {
		v := strings.ReplaceAll(t, ",", ".")
		if !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	return out
}

// cleanUnit trims a unit cell: bullets / dashes off the front, the trailing
// colon and whitespace off the back.
func cleanUnit(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimLeft(s, "-·•*♦ \t")
	s = strings.TrimRight(s, ": \t")
	return strings.TrimSpace(s)
}

func hasUpper(s string) bool {
	for _, r := range s {
		if r >= 'A' && r <= 'Z' {
			return true
		}
	}
	return false
}

// isGarbled reports text the native extractor mangled beyond what respacing can
// recover: a U+FFFD replacement char or an ASCII control char.
func isGarbled(s string) bool {
	for _, r := range s {
		if r == '�' || (r < 0x20 && r != '\t' && r != '\n') {
			return true
		}
	}
	return false
}

// coordUnitRe flags a "unit" that is really a coordinate-table fragment (a
// degree mark, or an FLnnn level). The big military SUPs lay the contact
// frequencies inside a per-zone coordinate table; until per-zone parsing
// (Phase 2) those rows yield units like "000°04'06” W Cognac APP", which are
// dropped rather than stored as noise.
var coordUnitRe = regexp.MustCompile(`[°º]|\bFL\d`)

// sanitizeResult drops coordination data respacing could not de-garble, and the
// coordinate-table fragments the multi-table SUPs leak: a wrong/garbled field is
// better absent than stored. Runs after respaceDoc (so degree marks are real).
func sanitizeResult(res *geomResult) {
	kept := res.contacts[:0]
	for _, c := range res.contacts {
		if isGarbled(c.unit) || isGarbled(c.note) || coordUnitRe.MatchString(c.unit) {
			continue
		}
		kept = append(kept, c)
	}
	res.contacts = kept
	if isGarbled(res.manager) {
		res.manager = ""
	}
	if res.penetration != nil && isGarbled(res.penetration.text) {
		res.penetration.text = ""
	}
}
