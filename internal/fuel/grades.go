// Package fuel reads the fuel grades a French aerodrome publishes out of the
// prose the AIP states them in, and merges what two sources say about the
// same field.
//
// There is no structured fuel field anywhere in the French AIP. The AIXM 4.5
// AD 2.4 service carries free text (txtDescrFac, and the hours and remark
// beside it), and the VAC plate carries the same information as item
// "10 - AVT" of its numbered Informations diverses list. Both are written for
// a human, mix the grades with the lubricants, the payment methods and the
// opening hours, and say the same thing twice in French and English.
//
// So this package is a grammar over that prose, and its governing rule is
// that a wrong assertion is worse than no assertion: a pilot told 100LL is
// on the field plans a fuel stop that is not there. Every rule below refuses
// rather than guesses, and what it refuses stays readable as the AIP's own
// words, which the dataset carries verbatim beside the grades.
package fuel

import (
	"regexp"
	"strings"
)

// Grade is one fuel grade an aerodrome publishes.
//
// The first four are spelled EXACTLY as the aircraft side spells them in
// FUEL_TYPE_INFO (src/lib/aircraft/schema.ts), which is what lets the app
// answer "can this aeroplane refuel here" with a plain membership test and
// no mapping table to drift. The rest have no aircraft counterpart and
// deliberately never match one.
type Grade = string

const (
	Grade100LL Grade = "100LL"       // AVGAS 100LL
	GradeUL91  Grade = "UL91"        // AVGAS UL91
	GradeSuper Grade = "SUPER AERO+" // UL Aero Super+, the TotalEnergies unleaded
	GradeJetA1 Grade = "JET A-1"     // Jet A-1, incl. its SAF blend and French TR.0
	GradeMogas Grade = "MOGAS"       // SP95 / SP98 car petrol, sold at a few fields
	GradeAvgas Grade = "AVGAS"       // avgas, grade unstated (incl. 100/130)

	// The NATO codes, kept as themselves. F-35 is chemically Jet A-1 and
	// F-18 is AVGAS 100/130, but a code is what the AIP prints where the
	// pump is the armed forces', and folding it into the civil grade would
	// tell a civil pilot they can uplift. They cannot.
	GradeF18 Grade = "F-18"
	GradeF34 Grade = "F-34"
	GradeF35 Grade = "F-35"
	GradeF40 Grade = "F-40"
	GradeF44 Grade = "F-44"
	GradeF54 Grade = "F-54"
	GradeF63 Grade = "F-63"
)

// Vocabulary is the closed grade set, in the order a row lists them: the
// piston grades a light aeroplane asks for first, then turbine, then the
// military codes. The dataset publishes this list in its sidecar, and
// tests/fuelGrades.spec.ts pins the app's own FUEL_TYPES against it.
var Vocabulary = []Grade{
	Grade100LL, GradeUL91, GradeSuper, GradeAvgas, GradeMogas, GradeJetA1,
	GradeF18, GradeF34, GradeF35, GradeF40, GradeF44, GradeF54, GradeF63,
}

var vocabRank = func() map[Grade]int {
	m := make(map[Grade]int, len(Vocabulary))
	for i, g := range Vocabulary {
		m[g] = i
	}
	return m
}()

// IsMilitaryCode reports whether a grade is a NATO fuel code, which is a
// military designation whatever the clause it sits in says.
func IsMilitaryCode(g Grade) bool {
	return strings.HasPrefix(g, "F-")
}

// natoCode maps the two digits of an F-nn code to the grade, and is the
// whitelist that keeps "F 15" (a Rafale, in a remark about the traffic) or a
// runway designator out of the vocabulary.
var natoCode = map[string]Grade{
	"18": GradeF18, "34": GradeF34, "35": GradeF35,
	"40": GradeF40, "44": GradeF44, "54": GradeF54, "63": GradeF63,
}

// trCode maps the French services' own kerosene designations. TR.0 is the
// civil Jet A-1 sold at Roissy and Le Bourget and is written that way in the
// civil AIP, so it resolves to the civil grade; TR.4 and TR.5 are the
// additive-carrying military fuels and keep their NATO codes.
var trCode = map[string]Grade{
	"0": GradeJetA1, "4": GradeF34, "5": GradeF44,
}

// gradePattern is one grade and every spelling the corpus actually uses.
// Order matters: the first match on a span wins, so SUPER AERO+ is tried
// before UL91 (both start "UL") and 100LL before the bare AVGAS.
type gradePattern struct {
	grade Grade
	re    *regexp.Regexp
}

// The patterns run over folded text: accents stripped, upper-cased. That is
// why they spell AERO and not AÉRO.
var gradePatterns = []gradePattern{
	// "UL AERO SUPER +", "UL AEROSUPER +", "UL Aero Super+", "AERO SUPER+".
	// A bare "Super" is NOT enough: at LFFB it sits beside 100LL and could
	// as easily be the car petrol, so it is refused (see parse.go).
	{GradeSuper, regexp.MustCompile(`\b(?:UL\s*)?AERO\s*SUPER\s*\+?`)},
	{GradeUL91, regexp.MustCompile(`\bUL\s*-?\s*91\b|\b91\s*UL\b`)},
	{Grade100LL, regexp.MustCompile(`\b(?:AVGAS\s*)?100\s*-?\s*LL\b`)},
	{GradeAvgas, regexp.MustCompile(`\b100\s*/\s*130\b`)},
	{GradeJetA1, regexp.MustCompile(`\bJET\s*-?\s*A\s*-?\s*1\b|\bTRO\b`)},
	{GradeMogas, regexp.MustCompile(`\bSP\s*-?\s*9[58]\b|\b9[58]\s*SP\b|\bMOGAS\b|\bSANS\s+PLOMB\b|\b9[58]\s+UNLEADED\b`)},
	// AVGAS with no grade beside it. Dropped afterwards when a specific
	// avgas was also read, "AVGAS 100LL" being one grade and not two.
	{GradeAvgas, regexp.MustCompile(`\bAVGAS\b`)},
}

// natoRe and trRe are matched separately because their digits are looked up
// in a whitelist rather than spelled out as alternatives.
var (
	natoRe = regexp.MustCompile(`\bF\s*-?\s*(\d{2})\b`)
	trRe   = regexp.MustCompile(`\bTR\s*[.\-]?\s*(\d)\b`)
)

// sortGrades puts a grade list in vocabulary order and drops duplicates,
// keeping the widest scope where the same grade was read twice (a grade
// offered to everyone is not narrowed by a second mention under MIL).
func sortGrades(in []Scoped) []Scoped {
	best := make(map[Grade]Scope, len(in))
	for _, s := range in {
		prev, seen := best[s.Grade]
		if !seen || widerScope(s.Scope, prev) {
			best[s.Grade] = s.Scope
		}
	}
	out := make([]Scoped, 0, len(best))
	for g, sc := range best {
		out = append(out, Scoped{Grade: g, Scope: sc})
	}
	// Insertion sort over a list that never exceeds the vocabulary length.
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && vocabRank[out[j].Grade] < vocabRank[out[j-1].Grade]; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

// widerScope reports whether a is the less restrictive of two scopes.
// Unstated is widest, then civil, then military.
func widerScope(a, b Scope) bool {
	return scopeRank(a) < scopeRank(b)
}

func scopeRank(s Scope) int {
	switch s {
	case ScopeCiv:
		return 1
	case ScopeMil:
		return 2
	default:
		return 0
	}
}
