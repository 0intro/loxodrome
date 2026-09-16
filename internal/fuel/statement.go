// statement.go declares what one aerodrome's fuel entry resolves to, and
// folds the two sources that state it into one answer.

package fuel

import "strings"

// Availability is what the AIP says about fuel being on the field at all.
//
// There is no "unknown" member on purpose: an aerodrome the AIP says nothing
// about carries no row, and the app shows nothing rather than a blank
// "unknown" line on every field in Europe.
type Availability = string

const (
	// AvailYes: the entry exists and is not a bare NIL. It does not promise
	// a grade was readable, nor that the pump is open today.
	AvailYes Availability = "yes"
	// AvailNo: the entry exists and its fuel clause is exactly NIL. This is
	// the AIP stating there is no fuel here, which is worth as much to a
	// pilot as a grade list and is why the NIL entries are kept.
	AvailNo Availability = "no"
)

// Scope is who a grade is published for. Unstated is the common case and
// means the AIP named no audience, which at a civil aerodrome means anyone.
type Scope = string

const (
	ScopeAny Scope = ""
	ScopeCiv Scope = "civ"
	ScopeMil Scope = "mil"
)

// Scoped is one grade and who may uplift it.
type Scoped struct {
	Grade Grade
	Scope Scope
}

// Condition is a fixed phrase the corpus states often enough to be worth
// typing. Everything else about when and how fuel is served stays in the
// verbatim text, because the AIP's hours are a grammar
// ("SAM, DIM, JF : O/R avant 1400 le VEN") that nothing else in the app
// parses and nothing here could verify.
type Condition = string

const (
	CondH24   Condition = "h24"   // a card-operated pump, available round the clock
	CondOR    Condition = "or"    // on request / PPR / prior notice
	CondHX    Condition = "hx"    // no specific working hours
	CondBased Condition = "based" // reserved for aircraft based on the field
)

// conditionOrder is the order a row lists its conditions, so the artifact is
// diff-stable.
var conditionOrder = []Condition{CondH24, CondOR, CondHX, CondBased}

// Statement is what one source says about one aerodrome's fuel.
type Statement struct {
	Avail Availability
	// Grades is empty when nothing could be read with confidence. That is a
	// real answer, not a failure: the caller shows the AIP's own words.
	Grades []Scoped
	Cond   []Condition
	// Text is the source's prose, verbatim, in whatever bilingual form it
	// arrived in. Never rewritten: it is the thing the typed fields are an
	// interpretation of, and the reader is entitled to it.
	Text string
}

// Has reports whether the statement offers a grade at all, whatever its
// scope.
func (s Statement) Has(g Grade) bool {
	for _, x := range s.Grades {
		if x.Grade == g {
			return true
		}
	}
	return false
}

// Merge folds what two sources say about one aerodrome into one statement.
//
// The rule is UNION, and it is chosen from the corpus rather than assumed:
// of the 150 aerodromes both the AIXM and the plate state, 89 % yield
// identical grade sets and the rest are one source knowing more than the
// other, never one contradicting the other. So a grade either source names
// is on the field, and neither source's silence subtracts.
//
// Availability follows from that: a source naming grades outweighs a source
// saying NIL, because a stale NIL is how an entry that has not been revised
// reads, while a named grade had to be written by someone. NIL wins only
// when nothing else was read at all.
//
// `primary` is the source whose prose is kept. The caller passes the plate's
// block there, it being the richer of the two: it carries the hours, the
// payment methods and the CIV / MIL split that the AD 2.4 slot often omits.
func Merge(primary, secondary Statement) Statement {
	// Two silences stay silence. Without this a caller merging what two
	// sources did not say would get "no fuel here", which neither of them
	// said and which the panel would print.
	if primary.Avail == "" && secondary.Avail == "" {
		return Statement{}
	}
	out := Statement{Text: primary.Text}
	if strings.TrimSpace(out.Text) == "" {
		out.Text = secondary.Text
	}

	grades := append(append([]Scoped{}, primary.Grades...), secondary.Grades...)
	// Through dropBareAvgas again: each source drops its own unqualified
	// AVGAS beside a grade it names, but one source can name the grade
	// while the other names only the family, and the union would then
	// offer both as if they were two things on the field.
	out.Grades = sortGrades(dropBareAvgas(grades))

	switch {
	case len(out.Grades) > 0:
		out.Avail = AvailYes
	case primary.Avail == AvailYes || secondary.Avail == AvailYes:
		out.Avail = AvailYes
	default:
		out.Avail = AvailNo
	}

	seen := map[Condition]bool{}
	for _, c := range append(append([]Condition{}, primary.Cond...), secondary.Cond...) {
		seen[c] = true
	}
	for _, c := range conditionOrder {
		if seen[c] {
			out.Cond = append(out.Cond, c)
		}
	}
	return out
}

// Agreement classifies how two sources' grade sets relate, for the sidecar
// counts that keep drift between the AIXM and the plates visible.
type Agreement = string

const (
	AgreeSame    Agreement = "agree"
	AgreeARicher Agreement = "aRicher"
	AgreeBRicher Agreement = "bRicher"
	// AgreeDiverge: neither set contains the other. The steady state is
	// none of these, so any is worth naming: where both sources speak they
	// agree, or one knows more than the other.
	AgreeDiverge Agreement = "diverge"
)

// Compare reports how two grade sets relate, ignoring scope.
func Compare(a, b Statement) Agreement {
	set := func(s Statement) map[Grade]bool {
		m := map[Grade]bool{}
		for _, g := range s.Grades {
			m[g.Grade] = true
		}
		return m
	}
	as, bs := set(a), set(b)
	// One source naming the avgas and the other naming only the family is
	// not a disagreement, and four aerodromes read that way: the AD 2.4
	// entry writes "AVGAS 100LL" where the plate writes "AVGAS". The
	// unqualified one is dropped where either side is specific, exactly as
	// the merge itself drops it.
	if as[Grade100LL] || as[GradeUL91] || as[GradeSuper] ||
		bs[Grade100LL] || bs[GradeUL91] || bs[GradeSuper] {
		delete(as, GradeAvgas)
		delete(bs, GradeAvgas)
	}
	subset := func(x, y map[Grade]bool) bool {
		for g := range x {
			if !y[g] {
				return false
			}
		}
		return true
	}
	switch {
	case subset(as, bs) && subset(bs, as):
		return AgreeSame
	case subset(bs, as):
		return AgreeARicher
	case subset(as, bs):
		return AgreeBRicher
	default:
		return AgreeDiverge
	}
}
