// phones.go: the telephone numbers a supplement prints, and whose they are.
// A zone's real activity is often known by telephone alone (191/2025's
// "Activité réelle connue de : Responsable des opérations : 06 62 83 60 48
// ou 06 30 32 20 97"), and the manager and the units to contact print theirs
// ("GAILLARD ASA : 07 59 93 49 49", 153/2026). Each number keeps the role of
// the section it is printed in, or of the clause over it ("Pendant
// l'activation des ZRT :", 062/2026), and the label printed beside it, or
// over a bare "Téléphone :" in its own column (106/2026's "DIREX CORSE").

package main

import (
	"regexp"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Roles of a telephone entry: the real activity of a zone is known from it,
// before the activity or during it, it is the manager's, or a contact's.
const (
	roleKnown   = "known"
	roleBefore  = "before"
	roleDuring  = "during"
	roleManager = "manager"
	roleContact = "contact"
)

// A phoneEntry is the telephone numbers one line of a column prints, each
// written "06 62 83 60 48", with the role of its section or clause and the
// lines of its label as printed, top to bottom.
type phoneEntry struct {
	role    string
	label   []string
	numbers []string
}

const (
	// columnMin is the least x a right column starts at: half an A4 page,
	// less a margin. A two-column section sets its right column at about
	// 300 pt (001/2026, 053/2026, 062/2026).
	columnMin = 280
	// columnSlack is how far left of its column a cell may start.
	columnSlack = 6
	// maxLabelLines is the most lines a label runs over. Text running over
	// more is prose.
	maxLabelLines = 3
	// maxLineLabel is the longest label a number's own line prints before
	// it, and maxLabelLine the longest line of a label above it. Longer text
	// is a sentence.
	maxLineLabel = 80
	maxLabelLine = 100
	// maxLabelHead is the longest label a line closing on a colon prints
	// over a number in a section that names no one to call.
	maxLabelHead = 40
	// minFigures is the fewest figures a line prints to hold a number:
	// PNIA's run nine or ten.
	minFigures = 8
)

var (
	// numberRe is a French telephone number, in figures grouped by spaces
	// or dots ("04 87.65.54.05", "02.97.12.90 .25") or written from abroad
	// ("+33 (0) 6 07 85 74 05", "+33 06 14 96 68 87", a_2026_056). It opens
	// on 0 and a figure other than 0: "00 30 02 97 50" is none.
	numberRe = regexp.MustCompile(`(?:\+\s?33\s?(?:\(0\)\s?|0)?|0)[1-9](?:[\s.]{0,2}\d\d){4}`)
	// cutRe is a number a line ends on before its last figures, after a
	// telephone word, a colon, a bracket or "ou", and restRe the figures
	// the next line opens on: "(Tél : 06 30 32 20 97 ou 06" over "32 09 54
	// 36)" (021/2026), "+33 (0)4 87 65" over "61 99" (213/2026).
	cutRe  = regexp.MustCompile(`(?i)(?:t[eé\x{FFFD}]?l[^a-z0-9]*|:|\(|ou)\s*((?:\+\s?33\s?(?:\(0\)\s?|0)?|0)[1-9](?:[\s.]{0,2}\d\d){0,3})[\s.]*$`)
	restRe = regexp.MustCompile(`^\s*\d\d(?:[\s.]{0,2}\d\d){0,3}`)
	// phoneWordRe is a telephone or mail word closing a label ("Tour de
	// Phalsbourg : Téléphone :", "Contact : PCE - Email"), its accents as
	// printed or lost, and phoneLeadRe one opening it ("Tél : P1", 094/2026).
	phoneWordRe = regexp.MustCompile(`(?i)(?:^|[\s:/,(–-]+)(?:t[eé\x{FFFD}]?l[eé\x{FFFD}]?phones?|t[eé\x{FFFD}]?l\.?|gsm|port(?:able)?\.?|mobile|fixe|fax|e-?mail|mail|courriel)\s*[:.]?\s*$`)
	phoneLeadRe = regexp.MustCompile(`(?i)^(?:t[eé\x{FFFD}]?l[eé\x{FFFD}]?phones?|t[eé\x{FFFD}]?l\.?)\s*:\s*`)
	// phoneInRe, folded, is a telephone word inside a text: a sentence
	// about calling ("Contact EDEIS Aéroport Le Mans Arnage par téléphone :
	// (France +33)", a_2026_072).
	phoneInRe = regexp.MustCompile(`t[e]?l[e]?phone`)
	// sentenceRe, folded, is a verb of a sentence telling whom to call
	// ("Les usagers peuvent contacter le gestionnaire au"), which no label
	// prints.
	sentenceRe = regexp.MustCompile(`contacter|joindre|appeler|peuvent|doivent|devront|pourront|sontinvit|joignable`)
	// mailRe is an address for mail, which a label leaves out.
	mailRe = regexp.MustCompile(`\S+@\S+`)
	// beforeRe and duringRe, folded, are a clause naming the time a number
	// answers in: "avant l'activité", "Hors activation des ZRT" (062/2026),
	// "Avant l'exercice" (029/2026), "Pendant l'opération" (053/2026),
	// "Pendant les heures d'activité". The apostrophe is any mark, the
	// native text rendering it as a control byte.
	beforeRe = regexp.MustCompile(`^-?(?:avant(?:l[^a-z]?|les?|la)?(?:activ|exercice|opration|vol|mission)|endehors|hors(?:des?)?(?:priodesd[^a-z]?)?(?:activ|exercice|opration))`)
	duringRe = regexp.MustCompile(`^-?(?:pendant|durant|lorsde)(?:l[^a-z]?|les?|la)?(?:(?:priodes?|heures?)d[^a-z]?)?(?:activ|exercice|opration|vol|mission)`)
	// otherLineRe, folded, is a line of a unit's block that labels nothing:
	// an internal military number ("PNIA : 861.428.31.82."), an address
	// for mail ("Mail : contact@rift.aero", 176/2025) or for the telegraph
	// ("SITA : NCEOPXH", a_2026_056).
	otherLineRe = regexp.MustCompile(`^-?(?:pnia|e-?mail|mail|courriel|fax|sita|aftn)|@`)
	// faxRe and telRe, folded, are the words before a number that make it a
	// fax's ("FAX : 04 97 11 74 21") or a telephone's as well ("Tél/Fax").
	faxRe = regexp.MustCompile(`fax`)
	telRe = regexp.MustCompile(`(?:^|[^a-z])t[e]?l(?:[^a-z]|$)|t[e]?l[e]?phone`)
	// addressRe, folded, is a postal address line ("95155 TAVERNY CEDEX"),
	// which the label walks past to the unit's name.
	addressRe = regexp.MustCompile(`(?:^|[^0-9])[0-9]{5}(?:[^0-9]|$)|cedex|^(?:bp|cs)[0-9]|^[0-9]+(?:bis|ter)?,?(?:rue|avenue|boulevard|bd|route|chemin|place|quai|impasse)`)
	// connectorRe, folded, is a word a sentence goes on after: a label
	// ending on one is cut from a sentence ("... Division Espaces ou").
	connectorRe = regexp.MustCompile(`(?:^|[^a-z])(?:avec|au|aux|le|la|les|du|de|des|par|pour|ou|et|sur|en|d'|l')$`)
)

// A phoneSection is what a heading says of the numbers printed under it:
// their role, and whether the section names whom to call. Such a section
// may set its contacts in two columns (001/2026, 053/2026, 062/2026) and
// print a number under its label. Any other section prints its numbers in
// sentences, each labelled on its own line or not at all: its rows read
// whole, a sentence across the page being no two columns (002/2026), and
// the lines over a number are the sentence it closes (144/2026).
type phoneSection struct {
	role     string
	contacts bool
}

// phoneHeading reports whether a row is a section heading, and what it
// says of the numbers under it. A heading is printed in capitals: a label
// opening on the same word ("Organisme de Contrôle d’Ajaccio", 106/2026)
// is none.
func phoneHeading(r prow) (phoneSection, bool) {
	t := r.text()
	if strings.ToUpper(t) != t {
		return phoneSection{}, false
	}
	f := fold(t)
	switch {
	case strings.HasPrefix(f, "organismesacontacter"), strings.HasPrefix(f, "organismeacontacter"),
		strings.HasPrefix(f, "informationdes"):
		return phoneSection{roleContact, true}, true
	case strings.HasPrefix(f, "gestionnaire"), strings.HasPrefix(f, "organismegestionnaire"), strings.HasPrefix(f, "organismesgestionnaires"):
		return phoneSection{roleManager, true}, true
	case isHeadingRow(t), strings.HasPrefix(f, "informations"):
		return phoneSection{roleContact, false}, true
	}
	return phoneSection{}, false
}

// phoneNoise reports whether a folded line is page furniture: the header
// ("SUP AIP N°150/25", "Date de publication"), the page number, the "©SIA"
// beside it. A line naming the supplement ("Questions relatives au SUP AIP
// - Commandement de la Défense", 150/2025) is a label.
func phoneNoise(f string) bool {
	switch f {
	case "", "fr", "sia":
		return true
	}
	return strings.HasPrefix(f, "supaip") || strings.HasPrefix(f, "page") ||
		strings.Contains(f, "datedepublication") || strings.Contains(f, "dateairac")
}

// phoneNumbers returns where a line prints its telephone numbers, each set
// apart from other figures.
func phoneNumbers(t string) [][]int {
	var out [][]int
	for _, l := range numberRe.FindAllStringIndex(t, -1) {
		if l[0] > 0 && isDigit(t[l[0]-1]) || l[1] < len(t) && isDigit(t[l[1]]) {
			continue
		}
		out = append(out, l)
	}
	return out
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }

// parsePhones reads every telephone number rows print, in document order,
// each once: a number printed again (the manager's, restated in the
// penetration rule) keeps its first role and label.
func parsePhones(rows []prow) []phoneEntry {
	p := phoneReader{seen: map[string]bool{}, sec: phoneSection{role: roleContact}}
	start := 0
	for i, r := range rows {
		sec, ok := phoneHeading(r)
		if !ok {
			continue
		}
		p.section(rows[start:i])
		p.sec = sec
		start = i + 1
	}
	p.section(rows[start:])
	return p.out
}

// A phoneReader collects the entries of a document, section by section.
type phoneReader struct {
	out  []phoneEntry
	seen map[string]bool
	sec  phoneSection // what the current section's heading says
}

// A phoneColumn is what one column of a section has printed so far: the
// lines since its last number, which label the next one, the roles its own
// lines set, its last entry, which a line opening on "ou" continues,
// whether its last line printed a number, and the start of a number its
// last line cut.
type phoneColumn struct {
	lines  []string
	known  bool
	when   string
	last   int
	number bool
	cut    string
}

// section reads a section's rows, a column at a time where it prints two.
func (p *phoneReader) section(rows []prow) {
	right := 0.0
	if p.sec.contacts {
		right = rightColumn(rows)
	}
	cols := [2]phoneColumn{{last: -1}, {last: -1}}
	for _, r := range rows {
		left, rt := splitColumns(r, right)
		p.line(&cols[0], left)
		p.line(&cols[1], rt)
	}
}

// rightColumn is the x a section's right column starts at: the least x at
// or past columnMin where cells of two rows start, or 0 for a section set in
// one column. Every row of a two-column section may open in its left column
// (053/2026).
func rightColumn(rows []prow) float64 {
	var xs []float64
	for _, r := range rows {
		for _, c := range r.cells {
			if c.x >= columnMin && !phoneNoise(fold(c.text)) {
				xs = append(xs, c.x)
			}
		}
	}
	slices.Sort(xs)
	for i := 0; i+1 < len(xs); i++ {
		if xs[i+1]-xs[i] <= columnSlack {
			return xs[i]
		}
	}
	return 0
}

// splitColumns returns the text a row prints in a section's left and right
// columns. A label closing on a colon and the number after it make one
// line, however far apart they are set.
func splitColumns(r prow, right float64) (string, string) {
	if right == 0 {
		return r.text(), ""
	}
	var l, rt []string
	for _, c := range r.cells {
		if c.x >= right-columnSlack {
			rt = append(rt, c.text)
		} else {
			l = append(l, c.text)
		}
	}
	left, rtext := strings.Join(l, " "), strings.Join(rt, " ")
	if locs := phoneNumbers(rtext); len(locs) > 0 && locs[0][0] == 0 && strings.HasSuffix(left, ":") {
		return left + " " + rtext, ""
	}
	return left, rtext
}

// line reads one line of a column.
func (p *phoneReader) line(c *phoneColumn, t string) {
	t = strings.TrimSpace(t)
	f := fold(t)
	if phoneNoise(f) {
		return
	}
	if cut := c.cut; cut != "" {
		c.cut = ""
		if r := restRe.FindString(t); r != "" {
			if whole := cut + " " + strings.TrimSpace(r); numberRe.FindString(whole) == whole {
				t = whole + t[len(r):]
				f = fold(t)
			}
		}
	}
	if m := cutRe.FindStringSubmatchIndex(t); m != nil {
		c.cut = t[m[2]:m[3]]
		t = strings.TrimSpace(t[:m[2]])
		f = fold(t)
	}
	switch {
	case beforeRe.MatchString(f):
		c.when = roleBefore
	case duringRe.MatchString(f):
		c.when = roleDuring
	}
	if knownTo(f) {
		c.known = true
	}
	locs := phoneNumbers(t)
	number := c.number
	c.number = len(locs) > 0
	if len(locs) == 0 {
		_, closes := unpairedMarks(t, '(', ')')
		switch {
		case figures(t) >= minFigures:
			// A number this reader leaves (PNIA, abroad: "+377 92 050
			// 050", a_2026_056) ends its entry.
			c.lines = nil
			c.last = -1
		case otherLineRe.MatchString(f):
			c.last = -1
		case number && len(closes) > 0:
			// The tail of the number's line ("contrôleur)" under "Téléphone
			// : 04 87 65 61 99 ou 04 87 65 55 21 (chef", 055/2026).
		default:
			c.lines = append(c.lines, t)
		}
		return
	}
	var numbers []string
	end := 0
	for _, l := range locs {
		lead := fold(t[end:l[0]])
		end = l[1]
		if faxRe.MatchString(lead) && !telRe.MatchString(lead) {
			continue
		}
		if n := phoneNumber(t[l[0]:l[1]]); !p.seen[n] {
			p.seen[n] = true
			numbers = append(numbers, n)
		}
	}
	above := c.lines
	c.lines = nil
	before := t[:locs[0][0]]
	s, kind := lineLabel(before)
	// A line printing no label of its own right under a number goes on
	// with it: "ou 01 48 16 65 37" (053/2026), "Port : 06 64 23 71 62"
	// under "Tel : 04 13 93 85 40" (175/2026).
	if (kind == labelBare || continues(before)) && len(above) == 0 && c.last >= 0 {
		p.out[c.last].numbers = append(p.out[c.last].numbers, numbers...)
		return
	}
	if len(numbers) == 0 {
		c.last = -1
		return
	}
	fresh := len(above) == 0
	if !p.sec.contacts {
		above = labelLine(above)
	}
	var label []string
	switch {
	case kind == labelBare:
		label = labelAbove(above)
	case kind == labelOwn && len(above) > 0 && joinsBelow(above[len(above)-1]):
		label = append(labelAbove(above), s)
	case kind == labelOwn:
		label = []string{s}
	case kind == labelRest && fresh && utf8.RuneCountInString(s) <= maxLabelHead:
		label = []string{s}
	case kind == labelRest:
		if l := labelAbove(above); l != nil {
			label = append(l, s)
		}
	}
	role := p.sec.role
	switch {
	case c.when != "":
		role = c.when
	case c.known:
		role = roleKnown
	}
	p.out = append(p.out, phoneEntry{role: role, label: label, numbers: numbers})
	c.last = len(p.out) - 1
}

// labelLine returns the line over a number in a section that names no one
// to call, when it is a label: short and closing on a colon ("-
// FINIST'AIR :" over "+33298846487", a_2026_193). A longer line there is
// the sentence the number closes.
func labelLine(above []string) []string {
	if len(above) == 0 {
		return nil
	}
	l := trimMarker(above[len(above)-1])
	if !strings.HasSuffix(l, ":") || utf8.RuneCountInString(l) > maxLabelHead {
		return nil
	}
	return []string{l}
}

// continues reports whether the text before a line's first number joins it
// to the line above: "ou 01 48 16 65 37" (053/2026).
func continues(before string) bool {
	switch fold(strings.TrimSpace(before)) {
	case "ou", "et", "/", ",":
		return true
	}
	return false
}

// figures counts the figures a line prints.
func figures(t string) int {
	n := 0
	for i := 0; i < len(t); i++ {
		if isDigit(t[i]) {
			n++
		}
	}
	return n
}

// phoneNumber writes a number as five pairs of figures, one written from
// abroad as it is dialled in France.
func phoneNumber(s string) string {
	var d []byte
	for i := 0; i < len(s); i++ {
		if isDigit(s[i]) {
			d = append(d, s[i])
		}
	}
	if strings.HasPrefix(s, "+") {
		// The country code, then the trunk 0 it may print.
		d = d[2:]
		if d[0] == '0' {
			d = d[1:]
		}
		d = append([]byte{'0'}, d...)
	}
	var b strings.Builder
	for i := 0; i+1 < len(d); i += 2 {
		if i > 0 {
			b.WriteByte(' ')
		}
		b.Write(d[i : i+2])
	}
	return b.String()
}

// What the text a line prints before its first number is to its label.
const (
	labelNone = iota // a sentence the number closes, which labels nothing
	labelBare        // nothing but a telephone word: the label is the lines above
	labelOwn         // the label
	labelRest        // the rest of a label the lines above begin
)

// lineLabel reads the text a line prints before its first number, and
// returns it cleaned with what it is to the number's label. A sentence the
// number closes runs long, leaves a parenthesis open, ends on a connector
// or speaks of the telephone. Text opening on a small letter goes on from
// the line above ("PPS au-dessus de Paris : Élément Air de Contrôle de"
// over "l'Aéroport Paris CDG (EACA) - Téléphone :", 053/2026), labels
// nothing where the line above is a sentence ("avec le responsable des
// activités (TEL :", 242/2026), and is the label of a short line opening
// its section ("direction des vols :", 170/2026).
func lineLabel(before string) (string, int) {
	s := trimMarker(before)
	// The clause naming its time, which its role says.
	if k := strings.Index(s, ":"); k > 0 {
		if f := fold(s[:k]); beforeRe.MatchString(f) || duringRe.MatchString(f) {
			s = strings.TrimSpace(s[k+1:])
		}
	}
	s = cleanLabel(s)
	switch {
	case s == "":
		return "", labelBare
	case utf8.RuneCountInString(s) > maxLineLabel, unclosed(s, '(', ')'),
		connectorRe.MatchString(fold(s)), phoneInRe.MatchString(fold(s)), sentenceRe.MatchString(fold(s)):
		return "", labelNone
	case opensSmall(s):
		return s, labelRest
	}
	return s, labelOwn
}

// trimMarker trims a line and the list marker it opens on: a dash, a
// bullet, or the "&f" a bullet glyph is read as (191/2026).
func trimMarker(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "&f")
	return strings.TrimLeft(s, "-–•·* ")
}

// joinsBelow reports whether a line's text goes on to the next: it ends on
// a connector ("... militaire (CDC) de" over "Cinq-Mars-la-Pile",
// 053/2026) or a word cut by a hyphen.
func joinsBelow(l string) bool {
	return connectorRe.MatchString(fold(l)) || wordHyphen(l)
}

// wordHyphen reports whether a line ends on a hyphen set against a letter
// ("de Mont-" over "de-Marsan.", 001/2026).
func wordHyphen(l string) bool {
	s, ok := strings.CutSuffix(l, "-")
	if !ok || s == "" {
		return false
	}
	r, _ := utf8.DecodeLastRuneInString(s)
	return unicode.IsLetter(r)
}

// opensSmall reports whether a text opens on a small letter. A figure
// opening it opens a name ("1er Régiment d’Artillerie", 038/2026).
func opensSmall(s string) bool {
	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			return unicode.IsLower(r)
		}
	}
	return false
}

// labelAbove returns the lines a column printed since its last number that
// name the next one: the nearest, up to maxLabelLines of them, back to a
// line closing on a colon above them. The nearest may close on its own
// colon ("Directeur des vols :", 041/2026), its first lines above it
// ("Centre de Détection et de Contrôle militaire (CDC)" over "de
// Cinq-Mars-La-Pile :", 059/2026). An address line or a bare telephone word
// is walked past, and a clause, a frequency ("Fréquence : 119.230 MHz",
// 186/2026), a sentence about calling ("... sur le numéro suivant",
// run_sup_2026_002) or a line of prose stops the walk. Of a block of more
// lines, the nearest two name the unit, the lines above them its commands
// (110/2026's "Dispositif Particulier de Sureté Aérienne / Base Aérienne 942
// de Lyon Mont-Verdun"). Lines that go on from a sentence above, opening
// on a small letter, are prose, which labels nothing.
func labelAbove(lines []string) []string {
	var out []string
	for i := len(lines) - 1; i >= 0; i-- {
		l := trimMarker(lines[i])
		f, cf := fold(l), fold(cleanLabel(l))
		if addressRe.MatchString(f) || cf == "" {
			continue
		}
		if beforeRe.MatchString(f) || duringRe.MatchString(f) || knownTo(f) ||
			strings.Contains(f, "mhz") || phoneInRe.MatchString(cf) || strings.Contains(cf, "numro") ||
			utf8.RuneCountInString(l) > maxLabelLine {
			break
		}
		if strings.HasSuffix(l, ":") && len(out) > 0 {
			break
		}
		if len(out) == maxLabelLines {
			out = out[:2]
			break
		}
		out = append(out, strings.TrimSpace(strings.TrimRight(l, ":")))
	}
	if len(out) == 0 || opensSmall(out[len(out)-1]) {
		return nil
	}
	slices.Reverse(out)
	return out
}

// labelText is an entry's label as one line, a word a hyphen cuts at the
// end of a line joined whole.
func (p phoneEntry) labelText() string {
	var b strings.Builder
	for i, l := range p.label {
		if i > 0 && !wordHyphen(p.label[i-1]) {
			b.WriteByte(' ')
		}
		b.WriteString(l)
	}
	return cleanLabel(b.String())
}

// cleanLabel takes the telephone words, the addresses for mail and the
// colons off a label: "Tour de Phalsbourg : Téléphone :" reads "Tour de
// Phalsbourg".
func cleanLabel(s string) string {
	s = mailRe.ReplaceAllString(s, "")
	for {
		t := phoneLeadRe.ReplaceAllString(phoneWordRe.ReplaceAllString(s, ""), "")
		t = strings.Trim(t, " :-–/.")
		if t == s {
			return collapseSpaces(t)
		}
		s = t
	}
}
