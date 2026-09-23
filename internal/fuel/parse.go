// parse.go is the grammar. It reads one aerodrome's fuel prose, from either
// source, and says which grades are on the field.
//
// The prose is written as LABELLED CLAUSES: "Carburant / Fuel : 100 LL,
// Lubrifiant / Lubricant : 80 D - 100 D (CIV) HJ." Reading grades by
// scanning the whole entry for tokens fails on exactly that line, where a
// fuel grade and an oil grade have nearly the same shape and only the label
// tells them apart. So the parser finds the labels first and reads grades
// only out of a fuel clause. Where an entry carries no label at all, the
// whole of it is the fuel clause, minus whatever other clauses it does have.
//
// Everything runs over a FOLDED copy of the text (accents stripped, upper
// cased), which is what makes one set of patterns read the French half and
// the English half alike. The verbatim text is carried beside the result and
// never rewritten.

package fuel

import (
	"regexp"
	"strings"
)

// fold strips the accents French uses and upper-cases, so one pattern reads
// "UL Aero Super +" and "UL AÉRO SUPER +" alike.
func fold(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		switch r {
		case 'à', 'á', 'â', 'ä', 'À', 'Á', 'Â', 'Ä':
			r = 'A'
		case 'ç', 'Ç':
			r = 'C'
		case 'è', 'é', 'ê', 'ë', 'È', 'É', 'Ê', 'Ë':
			r = 'E'
		case 'ì', 'í', 'î', 'ï', 'Ì', 'Í', 'Î', 'Ï':
			r = 'I'
		case 'ò', 'ó', 'ô', 'ö', 'Ò', 'Ó', 'Ô', 'Ö':
			r = 'O'
		case 'ù', 'ú', 'û', 'ü', 'Ù', 'Ú', 'Û', 'Ü':
			r = 'U'
		case 'ÿ', 'Ý':
			r = 'Y'
		case '’', '‘', 'ʼ':
			r = '\''
		case ' ', ' ', ' ':
			r = ' '
		}
		b.WriteRune(r)
	}
	return strings.ToUpper(b.String())
}

// A clause head is a run of letters before a colon, and it has to START
// somewhere. Requiring a clause boundary in front of it is what stops the
// run reaching back into the previous clause's VALUE: without it,
// "Carburant / Fuel : 100 LL - Lubrifiant / Lubricant : 80" is read with a
// head of " LL - Lubrifiant / Lubricant", because the L of LL is as much a
// letter as the rest, and the fuel clause then ends at "100" with the grade
// lost. That cost 54 aerodromes their grades.
//
// It is scanned by hand rather than by a regexp because the boundary is
// most often the PREVIOUS head's own colon, and a pattern that consumes the
// boundary cannot then offer it to the head that follows. RE2 has no
// lookbehind.

// labelChar reports whether a rune may appear inside a clause head. No digit
// and no full stop, so a head can span neither a grade nor a sentence.
func labelChar(c byte) bool {
	return c >= 'A' && c <= 'Z' || c == ' ' || c == '/' || c == '-' || c == '\''
}

// boundaryBefore reports whether a head may start at k: at the beginning of
// the entry, or after one of the marks the AIP separates its clauses with.
func boundaryBefore(f string, k int) bool {
	p := k - 1
	for p >= 0 && (f[p] == ' ' || f[p] == '\t') {
		p--
	}
	if p < 0 {
		return true
	}
	switch f[p] {
	case '.', '#', ',', ';', ':', ')', '\n', '\\':
		return true
	case '-':
		// " - " between two clauses, not the hyphen inside "CIV-MIL".
		return p == 0 || f[p-1] == ' '
	}
	return false
}

// findHeads locates every clause head, longest first: the earliest start
// that a boundary allows is the whole label, so "Fuel : x - Lubrifiant /
// Lubricant : y" reads the second head as "Lubrifiant / Lubricant" and not
// as "Lubricant".
func findHeads(f string) []head {
	var out []head
	for i := 0; i < len(f); i++ {
		if f[i] != ':' {
			continue
		}
		j := i
		for j > 0 && labelChar(f[j-1]) {
			j--
		}
		for k := j; k < i; k++ {
			if !boundaryBefore(f, k) {
				continue
			}
			if lab := strings.TrimSpace(f[k:i]); len(lab) >= 2 {
				out = append(out, head{start: k, valueStart: i + 1, kind: classifyLabel(lab)})
			}
			break
		}
	}
	return out
}

// head is one clause head: where its label starts, where its value starts,
// and what it introduces.
type head struct {
	start, valueStart int
	kind              labelKind
}

type labelKind int

const (
	// labelUnknown: a head we do not recognise. It does NOT end a clause.
	// The AIP heads plenty of things that are not clauses of their own: a
	// supplier ("TOTAL :", "Station TOTAL :"), a day range ("MAR-SAM :"),
	// a customer ("Aviation d'affaires :"). Treating every head as a
	// terminator ends the fuel clause at the supplier's name and loses the
	// grade behind it. Only a head whose subject we know can end one, and
	// the subject that matters is the lubricants, whose grades look like
	// fuel grades and are the reason the clause grammar exists at all.
	labelUnknown labelKind = iota
	labelOther
	labelFuel
	labelScope
)

// classifyLabel says what a clause head introduces. Only three answers
// matter: a fuel clause (read it), a scope marker (it does not open a new
// clause, it narrows the one it sits in), and everything else (skip its
// value, and let it terminate a fuel clause).
func classifyLabel(lab string) labelKind {
	// The class that finds a label head also admits the ' - ' the AIP puts
	// BETWEEN grades, so a run reaches back over it: "F34 - CIV : 100 LL"
	// yields the head " - CIV ", which unless trimmed reads as some other
	// clause and cuts the fuel clause off at the dash. Dax loses its two
	// civil grades that way.
	l := strings.Trim(lab, " -/.")
	switch l {
	case "MIL", "CIV", "CIV-MIL", "MIL-CIV":
		return labelScope
	}
	// A lubricant clause names grades of nearly the fuel grades' shape, so
	// it is tested FIRST: "Carburants / Fuel : ... Lubrifiants / Oil : ..."
	// would otherwise read the oils as fuel on a line that names both.
	if containsAny(l, "LUBRIFIANT", "LUBRICANT", "HUILE", "OIL") {
		return labelOther
	}
	if containsAny(l, "CARBURANT", "FUEL", "AVITAILLEMENT") {
		return labelFuel
	}
	// The rest of the AD 2.4 furniture: what it costs, when, and who to
	// ring. None of it names a fuel, and all of it ends the fuel clause.
	if containsAny(l, "PAIEMENT", "PAYMENT", "PRIX", "FACTURATION",
		"TEL", "FAX", "MAIL", "SITA", "AFS", "ADRESSE", "ADDRESS",
		"HOR", "SKED", "HORAIRE",
		"EXPLOITANT", "OPERATOR", "FOURNISSEUR", "PROVIDER", "GESTIONNAIRE") {
		return labelOther
	}
	return labelUnknown
}

func containsAny(s string, subs ...string) bool {
	for _, sub := range subs {
		if strings.Contains(s, sub) {
			return true
		}
	}
	return false
}

// span is one clause: where its value starts and ends in the folded text.
type span struct{ start, end int }

// fuelSpans returns the parts of the entry that state fuel grades.
//
// With at least one fuel label, those are that label's values, each running
// to the next clause head. With none, the whole entry is one fuel clause,
// with every other clause (its head and its value) cut out of it: that is
// what lets "AVGAS 100 LL et UL 91 H24 par carte TOTAL ... HOR / SKED :
// 0900-1600." read its grades without reading the hours as one.
func fuelSpans(f string) []span {
	heads := findHeads(f)
	// A clause ends at the next head that opens one. A scope marker does
	// not: it narrows the clause it sits in.
	opens := func(k labelKind) bool { return k == labelFuel || k == labelOther }
	end := func(i int) int {
		for j := i + 1; j < len(heads); j++ {
			if opens(heads[j].kind) {
				return heads[j].start
			}
		}
		return len(f)
	}

	var fuel []span
	for i, h := range heads {
		if h.kind == labelFuel {
			fuel = append(fuel, span{h.valueStart, end(i)})
		}
	}
	if len(fuel) > 0 {
		return fuel
	}

	// No fuel label: everything that is not another clause.
	var cut []span
	for i, h := range heads {
		if opens(h.kind) {
			cut = append(cut, span{h.start, end(i)})
		}
	}
	var out []span
	pos := 0
	for _, c := range cut {
		if c.start > pos {
			out = append(out, span{pos, c.start})
		}
		if c.end > pos {
			pos = c.end
		}
	}
	if pos < len(f) {
		out = append(out, span{pos, len(f)})
	}
	return out
}

var (
	// nilRe is the whole of a fuel clause saying there is none. Anchored on
	// both ends on purpose: "Carburant / Fuel : NIL. Pas de fourniture de
	// lubrifiant" is a no, while "Lubrifiant : NIL" beside a grade is not,
	// and a clause merely CONTAINING the word is neither.
	nilRe = regexp.MustCompile(`^[\s.:;,/-]*(?:NIL|NEANT|NONE)[\s.:;,/-]*$`)

	// negRe is a grade withdrawn in the same breath as it is named, which
	// the corpus does at Orly: "Jet A1 (CIV-MIL), 100 LL non disponible".
	negRe = regexp.MustCompile(`NON\s+DISPONIBLE|NOT\s+AVAILABLE|INDISPONIBLE|HORS\s+SERVICE|\bU/S\b|NON\s+DELIVRE`)

	// scopeRe is a MIL / CIV marker inside a clause.
	scopeRe = regexp.MustCompile(`\b(MIL|CIV)\s*:`)

	// parenScopeRe is the other way the corpus scopes a grade, as a suffix.
	parenCivMil = regexp.MustCompile(`\(\s*(?:CIV\s*-\s*MIL|MIL\s*-\s*CIV)\s*\)`)
	parenMil    = regexp.MustCompile(`\(\s*MIL\s*\)`)
	parenCiv    = regexp.MustCompile(`\(\s*CIV\s*\)`)

	// natoGlossRe is a NATO code the AIP glosses with its civil equivalent,
	// "F34 - F35 (JetA1) - F18 (100LL)" at Istres. The gloss names the
	// PRODUCT, not a second thing on offer, and reading it as one would put
	// 100LL and Jet A-1 on the civil list at an air base. Dropped.
	natoGlossRe = regexp.MustCompile(`(\bF\s*-?\s*\d{2}\b)\s*\([^)]*\)`)

	// itemSep splits a clause value into the things it names. The AIP uses
	// all of these between grades, and '#' is the line break both sources
	// carry.
	itemSep = regexp.MustCompile(`[,;#\n]|\s-\s|\\\\`)

	condH24Re   = regexp.MustCompile(`\bH\s*24\b`)
	condHXRe    = regexp.MustCompile(`\bHX\b`)
	condORRe    = regexp.MustCompile(`\bO\s*/\s*R\b|SUR\s+DEMANDE|ON\s+REQUEST|\bPPR\b|\bPN\s+(?:DE\s+)?\d`)
	condBasedRe = regexp.MustCompile(`\bRESERVE(?:D|E|ES|S)?\b[^.#]{0,40}?\b(?:ACB|BASE|BASES|BASED)\b|HOME\s*-?\s*BASED|AERONEFS\s+BASES`)
)

// Parse reads one fuel entry. `text` is the source's prose, verbatim and in
// whatever bilingual form it arrived in; the returned Statement carries it
// back untouched.
//
// An entry with nothing in it returns the zero Statement, which the caller
// reads as "this source says nothing" and does not turn into a row.
func Parse(text string) Statement {
	if strings.TrimSpace(text) == "" {
		return Statement{}
	}
	f := fold(text)
	spans := fuelSpans(f)

	var grades []Scoped
	sawNil, sawContent := false, false
	for _, sp := range spans {
		v := f[sp.start:sp.end]
		if strings.TrimSpace(strings.Trim(v, " .:;,/-")) == "" {
			continue
		}
		// The NIL test reads the clause's FIRST SENTENCE, not all of it.
		// Toussus-le-Noble writes "Carburant / Fuel : NIL. Pas de
		// fourniture de lubrifiant ...", where the clause runs on past the
		// answer into a second statement about the oils; a test over the
		// whole clause would miss the no, and a test over the whole ENTRY
		// would read "Lubrifiant : NIL" beside a grade as one.
		if nilRe.MatchString(firstSentence(v)) {
			sawNil = true
			continue
		}
		sawContent = true
		grades = append(grades, gradesIn(v)...)
	}

	st := Statement{
		Text:   text,
		Grades: sortGrades(dropBareAvgas(grades)),
		Cond:   conditionsIn(f),
	}
	// The source said SOMETHING, so there is a row. It reads "no fuel" only
	// where a fuel clause is exactly NIL and nothing else was read: an entry
	// we could not parse is not an entry saying the field is dry, and the
	// caller shows the AIP's own words for it.
	st.Avail = AvailYes
	if sawNil && !sawContent && len(st.Grades) == 0 {
		st.Avail = AvailNo
	}
	return st
}

// firstSentence cuts a clause at its first full stop or line break, which is
// where the AIP ends one statement and starts another inside what the label
// grammar sees as a single clause.
func firstSentence(v string) string {
	if i := strings.IndexAny(v, ".#\n"); i >= 0 {
		return v[:i]
	}
	return v
}

// gradesIn reads the grades of one fuel clause, honouring the MIL / CIV
// markers that narrow parts of it.
func gradesIn(v string) []Scoped {
	var out []Scoped
	for _, seg := range scopeSegments(v) {
		for _, item := range itemSep.Split(seg.text, -1) {
			if negRe.MatchString(item) {
				// Named and withdrawn in the same clause. Where the scope
				// of a negation is unclear the answer is to drop: telling a
				// pilot 100LL is here when it is not is the dangerous
				// direction, and the verbatim text still says what the AIP
				// said.
				continue
			}
			for _, g := range matchGrades(item) {
				out = append(out, Scoped{Grade: g, Scope: itemScope(item, seg.scope, g)})
			}
		}
	}
	return out
}

type scopeSeg struct {
	text  string
	scope Scope
}

// scopeSegments cuts a clause at its MIL : / CIV : markers. A marker holds
// until the next one or the end of the line, which is how Dax states
// "MIL : F34#CIV : 100 LL - UL 91".
func scopeSegments(v string) []scopeSeg {
	marks := scopeRe.FindAllStringSubmatchIndex(v, -1)
	if len(marks) == 0 {
		return []scopeSeg{{text: v, scope: ScopeAny}}
	}
	var out []scopeSeg
	if marks[0][0] > 0 {
		out = append(out, scopeSeg{text: v[:marks[0][0]], scope: ScopeAny})
	}
	for i, m := range marks {
		sc := ScopeMil
		if v[m[2]:m[3]] == "CIV" {
			sc = ScopeCiv
		}
		end := len(v)
		if i+1 < len(marks) {
			end = marks[i+1][0]
		}
		body := v[m[1]:end]
		// A line break ends the marker's reach, so a later line is not
		// silently charged to a scope stated above it.
		if k := strings.IndexAny(body, "#\n"); k >= 0 {
			out = append(out, scopeSeg{text: body[:k], scope: sc})
			body = body[k:]
			sc = ScopeAny
		}
		out = append(out, scopeSeg{text: body, scope: sc})
	}
	return out
}

// matchGrades reads the grade tokens of one item.
func matchGrades(item string) []Grade {
	item = natoGlossRe.ReplaceAllString(item, "$1")
	var out []Grade
	for _, p := range gradePatterns {
		if p.re.MatchString(item) {
			out = append(out, p.grade)
		}
	}
	for _, m := range natoRe.FindAllStringSubmatch(item, -1) {
		if g, ok := natoCode[m[1]]; ok {
			out = append(out, g)
		}
	}
	for _, m := range trRe.FindAllStringSubmatch(item, -1) {
		if g, ok := trCode[m[1]]; ok {
			out = append(out, g)
		}
	}
	return out
}

// itemScope narrows one grade by the parenthesis the AIP puts after it, the
// enclosing marker otherwise. A NATO code is military whatever either says.
func itemScope(item string, enclosing Scope, g Grade) Scope {
	if IsMilitaryCode(g) {
		return ScopeMil
	}
	switch {
	case parenCivMil.MatchString(item):
		return ScopeAny
	case parenMil.MatchString(item):
		return ScopeMil
	case parenCiv.MatchString(item):
		return ScopeCiv
	}
	return enclosing
}

// dropBareAvgas removes the unqualified AVGAS a clause carries as a heading
// over the grade it then names: "AVGAS 100 LL - JET A1" offers one avgas,
// not two.
func dropBareAvgas(in []Scoped) []Scoped {
	specific := false
	for _, s := range in {
		if s.Grade == Grade100LL || s.Grade == GradeUL91 || s.Grade == GradeSuper {
			specific = true
		}
	}
	if !specific {
		return in
	}
	// A fresh slice, not in[:0]: writing back over the argument would leave
	// a caller's own list quietly shortened, and Merge hands this one the
	// concatenation of two statements' grades.
	out := make([]Scoped, 0, len(in))
	for _, s := range in {
		if s.Grade != GradeAvgas {
			out = append(out, s)
		}
	}
	return out
}

// conditionsIn reads the fixed phrases off the WHOLE entry, the hours clause
// included: "HOR / SKED : H24" is where a field states its pump is always
// available, and that is not a fuel clause.
func conditionsIn(f string) []Condition {
	var out []Condition
	if condH24Re.MatchString(f) {
		out = append(out, CondH24)
	}
	if condORRe.MatchString(f) {
		out = append(out, CondOR)
	}
	if condHXRe.MatchString(f) {
		out = append(out, CondHX)
	}
	if condBasedRe.MatchString(f) {
		out = append(out, CondBased)
	}
	return out
}
