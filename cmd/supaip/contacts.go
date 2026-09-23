// contacts.go: parse a supplement's coordination block into SUP-level fields:
//
//   - the "Activité réelle connue de" radio table (the units, and the
//     frequencies to reach them on, that hold a zone's real-time status) ->
//     []contactFreq;
//   - the "CONDITIONS DE PÉNÉTRATION" rule -> a kind + verbatim text;
//   - the "ORGANISME GESTIONNAIRE" managing unit -> a string.
//
// The radio table and the manager are parsed off the same reconstructed []prow
// the geometry and activation parsers use. The native extractor drops
// intra-run spaces, so the unit names and the manager come out jammed
// ("SeineINFO"); respaceDoc (respace.go) lifts the spaced originals
// afterwards, exactly as for zone names. The rule is READ off poppler's layout
// text wherever that text carries it (resolvePenetration), every section and
// every statement of it, its exceptions included; the native rows' three-row
// reading stands only where poppler is absent or its text holds no section.
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
// refused marks a rule the supplement prints and this reader will not publish
// (set in columns, cut open, garbled): text is then "", and the flag is what
// tells the panel to say so rather than show a tag that reads as the whole
// rule.
type penetrationRule struct {
	kind    string // circumvent | forbidden | conditional | other
	text    string
	refused bool
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
// accent-stripped fold ("conditionsdepntration"), and ANCHORED like the layout
// reader's (isPenetrationHeading): a sentence mentioning the heading words is
// not the heading.
func parsePenetration(rows []prow) *penetrationRule {
	for i := 0; i < len(rows); i++ {
		if !isPenetrationHeading(rows[i].text()) {
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
		// exception lines that follow often garble), the one stating the
		// verdict the kind does: the first row to classify at all stood a
		// ZRT's circumvention under the ZIT's prohibition two rows down. Then
		// the first row that classifies (a verdict split over two rows), else
		// the first line.
		text := parts[0]
		for _, p := range parts {
			if classifyPenetration(p) != "other" {
				text = p
				break
			}
		}
		for _, p := range parts {
			if classifyPenetration(p) == kind {
				text = p
				break
			}
		}
		return &penetrationRule{kind: kind, text: strings.TrimSpace(text)}
	}
	return nil
}

// classifyPenetration buckets the rule text (folded, accent-insensitive), the
// PROHIBITION FIRST. A prohibition's exception prose routinely carries both
// words of a circumvention ("lorsque celles-ci ne permettent pas le
// contournement de la zone", "contact radio obligatoire"), and asked in the
// other order 079/2026's ZIT CANNES, which opens "pénétration interdite à tous
// les aéronefs", read as a circumvention. A text stating both verdicts takes
// the stricter, which is the side this tag errs on everywhere.
func classifyPenetration(text string) string {
	f := fold(text)
	switch {
	case strings.Contains(f, "interdit"):
		return "forbidden"
	case strings.Contains(f, "contournement") && strings.Contains(f, "obligatoire"):
		return "circumvent"
	case strings.Contains(f, "autorisation") || strings.Contains(f, "coordination") ||
		strings.Contains(f, "contactradio") || strings.Contains(f, "clairance"):
		return "conditional"
	default:
		return "other"
	}
}

// --- the whole rule, read off the layout text -----------------------------

// resolvePenetration settles the CONDITIONS DE PENETRATION rule against
// poppler's layout text. rule is what the native rows found, and respace lifts
// a jammed string's spaced original out of that same text.
//
// Where the layout text carries the section, IT decides both halves of the
// rule, the kind as well as the text: the native kind is three jammed rows'
// guess, and six committed rows once wore a tag their own rule contradicted
// (052/2026 was "See rule" above PÉNÉTRATION INTERDITE). The native rule
// stands only where the layout text has no section at all, which is every
// document when poppler is absent.
//
// A section the native rows missed ENTIRELY still yields a rule here, which is
// how the CAR/SAM/NAM 001/2025 supplement regains one: its first line names the
// drones the prohibition is about and folds to "quipage", which isPageNoise
// reads as a page marker, and the second opens on "services", which
// isHeadingRow reads as the next section. Both tests answer on the line's own
// text, so both were free to fire inside the rule; between them the section
// read as empty and parsePenetration returned nil.
func resolvePenetration(rule *penetrationRule, layout string, respace func(string) string) *penetrationRule {
	read := readPenetration(layout)
	if !read.found {
		if rule != nil {
			rule.text = respace(rule.text)
		}
		return rule
	}
	return &penetrationRule{kind: read.kind, text: read.text, refused: read.refused}
}

// penetrationRead is what the layout text says about the rule: whether it
// prints the section at all, the kind, and the text it can publish, which is
// "" with refused set when a section is there and cannot be read safely.
type penetrationRead struct {
	found   bool
	kind    string
	text    string
	refused bool
}

// readPenetration reads EVERY CONDITIONS DE PENETRATION section the document
// prints, not just the first. Eleven documents in the corpus print two to
// twenty-nine, one per zone or group of zones (029/2026 has 27, 010/2026 heads
// its first "ZRT LIMA 1" in a ten-zone supplement), and the rule is published
// once for the whole supplement: taking the first showed ZRT/ZDT ALPHA's
// exceptions as 029's, and hid an IFR exemption for Bourges, Chateauroux and
// Limoges that only a later section carries.
//
// Several sections are published only as an unambiguous union: in document
// order, a blank line between them, exact repeats once, and EVERY one opening
// on the zone it is about (zoneHeading), with no two different rules under one
// heading. A section that names no zone takes its zone from the document
// around it, twenty or fifty lines up under GESTIONNAIRES and STATUT, which
// this reader cannot attribute: 100/2026 prints one rule per exercise and
// neither names its zones, and set side by side they would hand the Laval and
// Le Mans IFR exemption of the second to the zones of the first.
//
// Refusal is all or nothing: one section that cannot be read (set in columns,
// over the cap, cut open, or unattributable in a union) refuses the text for
// the whole supplement. A partial union would read as complete, and a rule a
// pilot takes for the whole rule is the thing this reader exists not to
// publish. The kind still comes from every section, refused or not.
func readPenetration(layout string) penetrationRead {
	var out penetrationRead
	rank := -1
	var texts []string
	seen := map[string]bool{}
	for _, sec := range penetrationSections(layout) {
		out.found = true
		kind, text, ok := judgeSection(sec)
		if r := kindRank(kind); r > rank {
			rank, out.kind = r, kind
		}
		if !ok {
			out.refused = true
			continue
		}
		if !seen[text] {
			seen[text] = true
			texts = append(texts, text)
		}
	}
	if !out.found || out.refused {
		return out
	}
	if len(texts) > 1 && !attributable(texts) {
		out.refused = true
		return out
	}
	out.text = strings.Join(texts, "\n\n")
	if strings.Count(out.text, "\n")+1 > maxRuleText {
		out.text, out.refused = "", true
	}
	return out
}

// zoneHeading matches a statement that OPENS on a zone, after at most an
// item's bullet: a zone type followed by the zone's own designation ("ZRT LIMA
// 1", "ZRT/ZDT BRAVO 1 et BRAVO 2 :", "ZIT PLUGUFFAN - ZIT HOURTIN", "ZRT 'Low'
// Coulommiers"). A type followed by punctuation names a PART of the zones
// instead ("Partie ZRT :", "Parties ZRT : CAG/CAM ..."), which is no
// attribution at all.
//
// Anchored, because a statement that merely CITES a zone is about another one:
// "sauf pour les aéronefs en transit vers la TRA 43 NORD" and "après
// coordination avec la LF-R 45" name where the exempted traffic goes, and read
// anywhere in the line they vouched for two rules that name no zone of their
// own, 100/2026's shape.
//
// The designation is a number, run on or spaced ("LF-R45", "TSA 43A"), or a
// word after a SPACE: run on, a capitals word that merely begins with a type
// passed for one, TRANSFERT and TRAFIC and TRANSIT for a TRA, CBAS for a CBA,
// and two sections opening "TRAFIC CAG/CAM : ..." published as a union.
var zoneHeading = regexp.MustCompile(`^[` + ruleBullets + `\s]*(?:ZRT|ZIT|ZDT|TSA|TRA|CBA|LF-[RDP])(?:/(?:ZRT|ZIT|ZDT))?(?:\s*[0-9]|\s+[A-Z0-9'’"«])`)

// attributable reports whether several published sections can stand side by
// side: each opens on its own zone, and no heading carries two rules. The
// second is 010/2026's shape, which prints its zones twice, once per phase of
// the exercise, where one heading with two different texts would leave the
// pilot to guess which phase each is.
func attributable(texts []string) bool {
	heads := map[string]bool{}
	for _, t := range texts {
		head := strings.TrimSpace(strings.SplitN(t, "\n", 2)[0])
		if !zoneHeading.MatchString(head) || heads[head] {
			return false
		}
		heads[head] = true
	}
	return true
}

// judgeSection grades one section and re-flows it into the statements the SIA
// wrote, reporting ok false when it must not be published. A section set in
// COLUMNS is refused whole: -layout interleaves them into one line per printed
// row, so 078/2026 reads out as Roanne's rule carrying Clermont-Roanne's
// clauses, and a column layout read as prose is wrong airspace advice. The
// columns are measured on the lines AS PRINTED, before their ligatures are
// spelt out: each ligature left of a column boundary pushed that row's far
// side a column right ("ﬃ" two), and rows whose left cells carry a different
// number of them no longer lined up. A published section is graded on its
// strictest statement (gradeRule); a REFUSED one on its most restrictive
// printed line, because its statements cannot be told apart and the tag is
// then all the panel shows: 110/2026 prints ZIT LAC, which is PROHIBITED,
// beside two ZRTs, and graded on its first row it read "contournement
// obligatoire". An over-restrictive tag beside "see the supplement" sends the
// pilot to the document; an under-restrictive one tells them they may fly
// through.
func judgeSection(sec penSection) (kind, text string, ok bool) {
	var printed, raw []string
	for _, para := range sec.paras {
		printed = append(printed, para...)
	}
	for _, para := range sec.raw {
		raw = append(raw, para...)
	}
	if sec.overflow || len(printed) == 0 || columnLaidOut(raw) {
		return strictestKind(printed), "", false
	}
	var paras []string
	for _, para := range sec.paras {
		if r := reflowRule(para); r != "" {
			paras = append(paras, r)
		}
	}
	text = strings.Join(paras, "\n\n")
	// A section that ENDS OPEN was cut short of its own statement: the list
	// its last head opens ("sauf pour :") or the clause its last word holds
	// open never arrived. Trimming it back to the verdict, which is what the
	// no-poppler path does to a lone verdict line, would publish the
	// prohibition and drop whoever the section spares; refusing says there is
	// more in the supplement.
	if endsOpen(text) {
		return strictestKind(printed), "", false
	}
	return gradeRule(text), text, true
}

// endsOpen reports a text whose last statement opens a list or holds a clause
// open: it ends on a colon, or on a connector danglingWords names, whatever
// punctuation trails it ("sauf pour :"). A last list item closing on ";"
// rather than "." is sloppy, not open, and is not caught.
func endsOpen(text string) bool {
	lines := strings.Split(strings.TrimSpace(text), "\n")
	last := strings.TrimSpace(lines[len(lines)-1])
	if strings.HasSuffix(last, ":") {
		return true
	}
	words := strings.Fields(strings.TrimRight(last, danglingPunct))
	return len(words) > 0 && danglingAt(words, len(words)-1)
}

// kindRank orders the kinds by how much they restrict: the most restrictive
// section is the one the supplement's single tag states.
func kindRank(kind string) int {
	switch kind {
	case "forbidden":
		return 3
	case "circumvent":
		return 2
	case "conditional":
		return 1
	}
	return 0
}

// strictestKind grades a section on its most restrictive printed line. An
// interleaved row reads "INTERDITE sauf dans OBLIGATOIRE ...", and
// classifyPenetration asks for the prohibition first, so it is the half that
// wins.
func strictestKind(lines []string) string {
	best := "other"
	for _, l := range lines {
		if k := classifyPenetration(l); kindRank(k) > kindRank(best) {
			best = k
		}
	}
	return best
}

// gradeRule grades a published section on its strictest STATEMENT, whichever
// zone, part, day or traffic category it sets out. It once graded each zone on
// its first three statements, the native rows' window, on the grounds that the
// rest of a zone's rule is its exceptions; but a rule set out per traffic
// category (142/2026's ZRT PARA, the VFR verdict its fifth statement), per day
// (181/2026's ZRT 1) or per part ("Partie ZRT :" then "Partie ZIT :", which
// names no zone of its own) puts its verdict past any window, and a
// prohibition published under a circumvention's tag, or under none. Since the
// classification asks for the prohibition first, the exception prose that
// window guarded against (079/2026's list carries both words of a
// circumvention under a prohibition) cannot lower a grade, only raise one, and
// an over-restrictive tag beside the published text sends the pilot to it.
func gradeRule(text string) string {
	var stmts []string
	for _, l := range strings.Split(text, "\n") {
		if strings.TrimSpace(l) != "" {
			stmts = append(stmts, l)
		}
	}
	return strictestKind(stmts)
}

// maxRuleLines bounds a section read, in printed lines, so a stop condition
// that fails cannot walk the rest of the document; a section that reaches it
// is refused. The longest read as prose is 099/2026 at 62 lines over a page
// break, five groups of zones each with its own rule; the two that reach the
// cap, 110/2026 and 142/2026, are exception matrices set in columns, refused
// either way.
const maxRuleLines = 80

// maxRuleText bounds the published text of a whole supplement, every section
// together, in statements. It is a guard and not a style limit: the longest
// text the corpus publishes, 099/2026's, runs to 42.
const maxRuleText = 400

// figurePageWords is how few words a page may carry and still be a FIGURE: a
// map extract under a caption ("VUE GENERALE Région Atlantique", "Extrait
// carte au 1 / 1 000 000"). 001/2026's rule ends at the foot of its page and
// the next is such a map; the pages a rule does continue onto are prose.
const figurePageWords = 40

// penSection is one CONDITIONS DE PENETRATION section as printed: its
// paragraphs, each a run of printed lines with their ligatures spelt out, the
// same lines as pdftotext set them (raw, what the columns are measured on),
// and whether the read ran into the cap before the section ended.
type penSection struct {
	paras    [][]string
	raw      [][]string
	overflow bool
}

// isPenetrationHeading reports the line that OPENS a section: its text BEGINS
// with the heading words, after at most a section number or a bullet. A
// substring match also opened one on 056/2026's summary line, "Publication
// d'un SUP AIP espace détaillant les conditions de pénétration dans la ZRT
// GPM., ainsi que les / trajectoires spécifiques hélicoptère", and published
// "trajectoires spécifiques hélicoptère" as the rule. The corpus prints the
// heading two ways, accented (302 times) and not (23), and both fold to one of
// these prefixes; works on the native rows' jammed text as well, whose accents
// fold away the same way.
func isPenetrationHeading(t string) bool {
	f := strings.TrimLeft(fold(t), "0123456789.)(-*:\f")
	return strings.HasPrefix(f, "conditionsdepntration") || strings.HasPrefix(f, "conditionsdepenetration")
}

// penetrationSections cuts every CONDITIONS DE PENETRATION section out of the
// layout text. A section runs from its heading to whichever comes first:
//
//   - the SIA's next centred section head, or another penetration heading;
//   - after a paragraph break, a line opening on a heading word, at any
//     indent;
//   - a page break onto a FIGURE page (a map extract), or onto a page opening
//     on a heading;
//   - the cap, which refuses the section.
//
// A paragraph break is NOT an end, however many blank lines it takes. The SIA
// sets one zone's rule after another's with two blank lines between them, and
// ending there published ZRT 1's rule for 181/2026's ZRT 2, 3 and 4 with its
// Monday cut off, and 213/2026's ZRT REAPER LOURDES exemptions without the ZIT
// PAPE prohibition that follows them. Nor is a page break, when the rule goes
// on over it: 099/2026's "Partie ZDT" and 200/2026's ZRT QUIMPER, ANDERNOS and
// BISCARROSSE rule both open the next page, and 142/2026's heading sits at the
// foot of one with its whole rule on the next.
//
// A run of two blank lines or more, which is how the SIA separates one zone's
// rule from the next, starts a new paragraph; so does a page break. One blank
// line stays inside the paragraph, where reflowRule reads it as the end of a
// statement.
func penetrationSections(layout string) []penSection {
	raw := strings.Split(puaGlyphs.Replace(layout), "\n")
	furn := pageFurnitureLines(raw)
	lines := make([]string, len(raw))
	for i, l := range raw {
		raw[i] = strings.ReplaceAll(l, "\f", "")
		lines[i] = ligatures.Replace(raw[i])
	}
	var out []penSection
	for i := 0; i < len(lines); {
		if !isPenetrationHeading(lines[i]) {
			i++
			continue
		}
		sec, next := readSection(lines, raw, furn, i+1)
		out = append(out, sec)
		i = next
	}
	return out
}

// readSection reads one section from lines[start], returning it and the index
// of the line that ended it. raw holds the same lines as printed, and furn
// which of them are page furniture.
func readSection(lines, raw []string, furn []bool, start int) (penSection, int) {
	var sec penSection
	var para, rawPara []string
	count := 0
	blanks := 0
	endPara := func() {
		if len(para) > 0 {
			sec.paras = append(sec.paras, para)
			sec.raw = append(sec.raw, rawPara)
			para, rawPara = nil, nil
		}
	}
	j := start
	for ; j < len(lines); j++ {
		l := lines[j]
		t := strings.TrimSpace(l)
		if t == "" {
			blanks++
			continue
		}
		if isPenetrationHeading(l) || sectionHead(l) ||
			(blanks >= 2 && (len(para) > 0 || len(sec.paras) > 0) && isHeadingRow(t)) {
			break
		}
		if furn[j] {
			k, cont := pageTurn(lines, furn, j)
			if !cont {
				j = k
				break
			}
			endPara()
			j = k - 1
			blanks = 0
			continue
		}
		switch {
		case blanks >= 2:
			endPara()
		case blanks == 1 && len(para) > 0:
			para = append(para, "")
			rawPara = append(rawPara, "")
		}
		blanks = 0
		if count >= maxRuleLines {
			sec.overflow = true
			break
		}
		para = append(para, strings.TrimRight(l, " \t\r"))
		rawPara = append(rawPara, strings.TrimRight(raw[j], " \t\r"))
		count++
	}
	endPara()
	return sec, j
}

// pageTurn skips the page furniture at lines[j] (the foot of one page, the
// head of the next, and the blank lines between them) and says whether the
// section carries on at the first content line past it, returning that line's
// index. It does not when that line is a section heading, and when the page it
// opens is a figure.
func pageTurn(lines []string, furn []bool, j int) (int, bool) {
	k := j
	for k < len(lines) {
		if strings.TrimSpace(lines[k]) != "" && !furn[k] {
			break
		}
		k++
	}
	if k >= len(lines) {
		return k, false
	}
	t := strings.TrimSpace(lines[k])
	if isPenetrationHeading(lines[k]) || isHeadingRow(t) {
		return k, false
	}
	words := 0
	for m := k; m < len(lines); m++ {
		if furn[m] {
			break
		}
		words += len(strings.Fields(lines[m]))
	}
	return k, words >= figurePageWords
}

// headIndent is how far the SIA's centred section heads sit from the left
// margin, at their narrowest ("LIMITES LATERALES ET VERTICALES" on the
// narrowest page in the corpus). The rule prose is set flush left or one bullet
// in, so the indent alone separates the two.
const headIndent = 20

// sectionHead reports the line that closes the rule: the SIA's next centred
// section head. The heading WORD is not evidence enough on its own, which is
// what isHeadingRow tests and why the CAR/SAM/NAM 001/2025 rule stopped one
// line in, on "services de l'Etat (defense, gendarmerie, ...)".
func sectionHead(l string) bool {
	return indentOf(l) >= headIndent && isHeadingRow(l)
}

// pageHeader is the head the SIA prints at the top of every sheet after the
// first: "SUP AIP 099/26 Date de publication : 07 MAY 2026", "SUP AIP AIRAC
// 099/26 Date AIRAC : 11 JUN 2026 Date de publication : ...", or, on 13
// sheets of the corpus, "AIRAC SUP AIP N° 207/25 Date AIRAC : ...".
var pageHeader = regexp.MustCompile(`^(?:AIRAC )?SUP AIP\b.*\b(?:Date de publication|Date AIRAC)\b`)

// pageFoot is a line of the foot at the bottom of every sheet: "FR", "Page
// 7/13", "© SIA", or the last two on one line.
var pageFoot = regexp.MustCompile(`^(?:FR|Page \d+ ?/ ?\d+(?: © SIA)?|© SIA)$`)

// pageFurnitureLines marks the page furniture in the layout text by its SHAPE
// and its PLACE: the head on the line that carries a page's form feed, and the
// run of foot lines just above it. pdftotext opens every sheet after the first
// with a form feed and ends the text on one, so the last sheet's foot has one
// under it too; over the 1 304 page breaks of the corpus the head is always the
// feed line itself (bar one sheet that opens on its own text) and the foot
// always the lines above it (bar two sheets that print none).
//
// A prefix test on the folded line did this once, and read a WRAPPED rule line
// the same way: "... définies par le présent" / "SUP AIP, la pénétration est
// interdite ..." lost the prohibition and published the exceptions under a
// conditional tag, and the corpus's own prose wraps onto "SUP AIP", "Page",
// "Péage" and "SIA" wherever the measure falls. A line is furniture here only
// beside a form feed, and only in the furniture's own words.
func pageFurnitureLines(lines []string) []bool {
	furn := make([]bool, len(lines))
	shape := func(l string) string {
		return strings.Join(strings.Fields(strings.ReplaceAll(l, "\f", "")), " ")
	}
	for i, l := range lines {
		if !strings.Contains(l, "\f") {
			continue
		}
		if head := shape(l); head == "" || pageHeader.MatchString(head) {
			furn[i] = true
		}
		for k := i - 1; k >= 0; k-- {
			foot := shape(lines[k])
			if foot == "" {
				continue
			}
			if !pageFoot.MatchString(foot) {
				break
			}
			furn[k] = true
		}
	}
	return furn
}

// gapJitter is how far two rows' gaps may start apart and still be the same
// column: pdftotext pads to whole character cells, and a proportional font's
// rows land a cell or two either side of the rule they are set against.
const gapJitter = 3

// columnLaidOut reports whether the section sets two or more columns side by
// side, which -layout renders as one interleaved line per printed row. The
// evidence is a gap of four spaces or more, text on both sides of it, whose FAR
// side recurs at the same column: one such gap on its own is the stretch a
// justified paragraph opens (190/2026 has two, at different columns), and a gap
// whose near side is only the item's bullet is an indentation (159/2025 prints
// "-          Les aeronefs ...").
//
// The far side is what is measured because only it is set against a rule: a
// column of ragged prose ends where each line's last word ends, so 078/2026's
// gaps OPEN at six different columns and all six close at the same one.
func columnLaidOut(block []string) bool {
	var cols []int
	for _, l := range block {
		cols = append(cols, gapColumns(l)...)
	}
	for _, a := range cols {
		n := 0
		for _, b := range cols {
			if b >= a-gapJitter && b <= a+gapJitter {
				n++
			}
		}
		if n >= 2 {
			return true
		}
	}
	return false
}

// minGapLead is how much text must stand to a gap's near side for it to be a
// column boundary. Below it the gap is an indentation: what precedes it is the
// item's own bullet.
const minGapLead = 3

// gapColumns returns the column each of l's inter-column gaps ENDS at: the
// first column of the text past a run of four spaces or more that has text on
// both sides of it.
func gapColumns(l string) []int {
	var out []int
	runes := []rune(l)
	for i := 0; i < len(runes); i++ {
		if runes[i] != ' ' || i == 0 || runes[i-1] == ' ' {
			continue
		}
		j := i
		for j < len(runes) && runes[j] == ' ' {
			j++
		}
		if j-i >= 4 && j < len(runes) {
			if near := strings.TrimSpace(string(runes[:i])); len([]rune(near)) >= minGapLead {
				out = append(out, j)
			}
		}
		i = j - 1
	}
	return out
}

// ruleBullets are the markers the SIA opens an exception item with: the hyphen
// (311 items in the corpus), the diamond (13) and the bullet (2), plus the two
// dashes and the asterisk a template may reach for, and the four glyphs
// puaGlyphs maps a symbol font's private-use bullets onto. A character class,
// so it is written in escapes rather than glyphs.
const ruleBullets = "-*\u2013\u2014\u2022\u25c6\u2666\u2212\u2713\u27a2\u25a1"

// puaGlyphs maps the private-use code points pdftotext hands back for the
// Symbol and Wingdings bullets onto the characters they draw. The corpus
// carries five, all as list markers: Symbol's bullet (U+F0B7) and minus
// (U+F02D, 002/2026's rule, which reached the panel as three tofu boxes and
// defeated the items' hanging indent), and Wingdings' check mark (U+F0FC),
// arrowhead (U+F0D8) and box (U+F0A8). isGarbled refuses any private-use code
// point left over, since nothing says what it draws.
var puaGlyphs = strings.NewReplacer(
	"\uf0b7", "\u2022", "\uf02d", "\u2212", "\uf0fc", "\u2713",
	"\uf0d8", "\u27a2", "\uf0a8", "\u25a1",
)

// startsRuleItem reports whether a printed line opens a new exception item.
func startsRuleItem(s string) bool {
	r := []rune(strings.TrimSpace(s))
	return len(r) > 0 && strings.ContainsRune(ruleBullets, r[0])
}

// shortLine is the share of the section's own measure a printed line must
// reach to be a WRAP. A line stops short of it because its statement ended
// there, not because the next word would not fit: 167/2025 sets the CAG rule
// and the CAM rule on two lines, the first a fifth of the measure, and reading
// them as one run-on invites a CAG pilot to read past their own.
const shortLine = 0.85

// reflowRule folds the printed lines back into the statements the SIA wrote.
// pdftotext wraps at the PDF's own column width, so a printed line is only
// sometimes a statement of its own: an item opens on a bullet, a head closes on
// a colon, a paragraph is bounded by a blank line or by a line that stops short
// of the measure, and anything else continues the line above it. A wrap inside
// a hyphenated or elided word rejoins with no space, "des LF-" + "R368." being
// one designator.
func reflowRule(block []string) string {
	measure := 0
	for _, l := range block {
		if n := len([]rune(l)); n > measure {
			measure = n
		}
	}
	var out []string
	cur := ""
	flush := func() {
		if s := collapseSpaces(cur); s != "" {
			out = append(out, s)
		}
		cur = ""
	}
	for _, l := range block {
		t := strings.TrimSpace(l)
		switch {
		case t == "":
			flush()
			continue
		case cur == "" || startsRuleItem(t):
			flush()
			cur = t
		case strings.HasSuffix(cur, "-"), strings.HasSuffix(cur, "’"), strings.HasSuffix(cur, "'"):
			cur += t
		default:
			cur += " " + t
		}
		if strings.HasSuffix(cur, ":") || float64(len([]rune(l))) < shortLine*float64(measure) {
			flush()
		}
	}
	flush()
	return strings.Join(out, "\n")
}

// danglingWords are the words a statement may not end on: an article, a
// preposition or a conjunction still holding open a clause that never arrived.
// "sauf", "exception", "hormis" and "excepte" are in it because they are what
// the truncated rules end on, and cutting back to before one is what makes the
// remainder honest: "contournement obligatoire sauf pour" names a prohibition
// and then hides who it does not apply to, while "contournement obligatoire" is
// the conservative reading, and the one the kind tag states anyway.
var danglingWords = map[string]bool{
	"a": true, "apres": true, "au": true, "aux": true, "avec": true,
	"dans": true, "de": true, "des": true, "du": true, "en": true,
	"entre": true, "et": true, "excepte": true, "exception": true,
	"hormis": true, "jusqu": true, "la": true, "le": true, "les": true,
	"lors": true, "lorsque": true, "ou": true, "par": true, "pour": true,
	"que": true, "qui": true, "sauf": true, "selon": true, "si": true,
	"sous": true, "sur": true, "un": true, "une": true, "vers": true,
}

// trimDanglingClause cuts a text back to its last complete statement: while the
// final word is a connector holding open a clause the extraction never reached,
// that word goes. Only the last LINE is examined, the ones above it being
// statements the section closed itself. sanitizeResult applies it to whatever
// the rule ends up being, so the invariant holds on the paths that never reach
// the layout text either.
//
// Trailing punctuation is looked PAST, not stopped at: French sets a space
// before ":" and ";", so "sauf pour :" ends on a word of its own, which bares
// to nothing and is no connector, and the loop used to stop there and leave
// the connector for TrimRight to expose ("..., sauf pour").
func trimDanglingClause(s string) string {
	lines := strings.Split(s, "\n")
	i := len(lines) - 1
	words := strings.Fields(strings.TrimRight(lines[i], danglingPunct))
	for len(words) > 0 && danglingAt(words, len(words)-1) {
		words = words[:len(words)-1]
	}
	lines[i] = strings.TrimRight(strings.Join(words, " "), danglingPunct)
	if lines[i] == "" {
		lines = lines[:i]
	}
	return strings.Join(lines, "\n")
}

// danglingPunct is the punctuation a cut statement may trail.
const danglingPunct = " ,;:/-\u2013"

// danglingAt reports whether words[i] is a connector holding a clause open.
//
// A word carrying a digit or a CLOSING bracket is a designation and never a
// connector: bareWord keeps the letters alone, so "226A." and "(A)" bared to
// "a", the preposition. An OPENING bracket is looked through instead, "(sauf"
// holding its clause as open as "sauf" does. A lone capital closing a zone's
// designation is the zone's suffix, not the preposition: after a number ("LF-R
// 45 A") as after a name ("ZRT OLONNE A", the way 23 zones of the corpus are
// named), where endsOpen once refused a rule for ending on its own zone's name
// and trimDanglingClause cut the suffix off, publishing the rule of one zone
// under another's name. Anywhere else it stays the preposition a rule printed
// in capitals writes for "à" ("DE 0800 A").
//
// An elision announces the word after it: the elided form alone ("l’", "d’",
// "lorsqu’") holds that word open, "jusqu’au" answers for "au", and an elided
// connector ("lorsqu’il", "qu’il") opens a clause whatever follows it.
func danglingAt(words []string, i int) bool {
	w := strings.TrimRight(words[i], danglingPunct+".")
	if strings.ContainsAny(w, "0123456789)]") {
		return false
	}
	w = strings.TrimLeft(w, "([")
	if len(w) == 1 && w[0] >= 'A' && w[0] <= 'Z' && namesZone(words[:i]) {
		return false
	}
	if pre, post, ok := elision(w); ok {
		return post == "" || elidedConnectors[pre] || danglingWords[bareWord(post)]
	}
	return danglingWords[bareWord(w)]
}

// elidedConnectors are the connectors French elides in front of a vowel, the
// part before the apostrophe as bareWord leaves it.
var elidedConnectors = map[string]bool{"jusqu": true, "lorsqu": true, "puisqu": true, "quoiqu": true, "qu": true}

// elision splits a word at an elision's apostrophe: the elided article or
// connector and the word it runs into ("l’exception" is "l" and "exception").
func elision(w string) (pre, post string, ok bool) {
	for _, ap := range []string{"’", "'"} {
		if k := strings.LastIndex(w, ap); k >= 0 {
			pre = bareWord(w[:k])
			switch pre {
			case "l", "d", "n", "s", "j", "m", "t", "c":
				return pre, w[k+len(ap):], true
			}
			if elidedConnectors[pre] {
				return pre, w[k+len(ap):], true
			}
		}
	}
	return "", "", false
}

// namesZone reports whether the words before a lone capital are a zone's
// designation back to its type ("ZRT OLONNE", "LF-R 45", "TSA 43"): every word
// between them in capitals or a number, none closing a clause, the type
// within a few words.
func namesZone(words []string) bool {
	for k := len(words) - 1; k >= 0 && k >= len(words)-6; k-- {
		x := words[k]
		if strings.ContainsAny(x, ",;:.") {
			return false
		}
		if zoneType.MatchString(x) {
			return true
		}
		if strings.ToUpper(x) != x {
			return false
		}
	}
	return false
}

// zoneType matches a zone type as printed ahead of a designation.
var zoneType = regexp.MustCompile(`^(?:(?:ZRT|ZIT|ZDT|TSA|TRA|CBA)(?:/(?:ZRT|ZIT|ZDT))?|LF-[RDP]\S*|[RDP])$`)

// deaccent folds the French accents onto their base letters. fold drops every
// non-ASCII rune outright, which leaves "a" with its grave accent EMPTY rather
// than folded, and "apres" spelled "aprs".
var deaccent = strings.NewReplacer(
	"à", "a", "â", "a", "ä", "a", "ç", "c", "é", "e", "è", "e", "ê", "e",
	"ë", "e", "î", "i", "ï", "i", "ô", "o", "ö", "o", "ù", "u", "û", "u",
	"ü", "u", "ÿ", "y",
)

// bareWord reduces a printed word to the vocabulary danglingWords is keyed on:
// lower case, unaccented ASCII letters only. It is asked of each side of an
// elision apart (elision), and on the LOWER-CASED word, the SIA printing some
// rules in capitals (052/2026, CAR/SAM/NAM 001/2025): "L’EXCEPTION" is "l"
// and "exception", never "lexception".
func bareWord(w string) string {
	var b strings.Builder
	for _, r := range fold(deaccent.Replace(strings.ToLower(w))) {
		if r >= 'a' && r <= 'z' {
			b.WriteRune(r)
		}
	}
	return b.String()
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
// recover: a U+FFFD replacement char, an ASCII control char, or a private-use
// code point puaGlyphs does not map, which a font draws as whatever it likes
// and a browser as a box.
func isGarbled(s string) bool {
	for _, r := range s {
		if r == '�' || (r < 0x20 && r != '\t' && r != '\n') || (r >= 0xe000 && r <= 0xf8ff) {
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
	if res.penetration != nil {
		if isGarbled(res.penetration.text) {
			res.penetration.text = ""
			res.penetration.refused = true
		}
		res.penetration.text = trimDanglingClause(res.penetration.text)
	}
}
