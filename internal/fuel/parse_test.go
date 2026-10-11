package fuel

import (
	"strings"
	"testing"
)

// Every fixture below is a VERBATIM entry from the 2026-09-03 cycle, quoted
// from the source named beside it. They are the cases that decide the
// grammar: each one broke a simpler reader.
type parseCase struct {
	name   string
	text   string
	avail  Availability
	grades []Scoped
	cond   []Condition
}

var parseCases = []parseCase{
	{
		// Orly names a grade and withdraws it in the same clause. Reading
		// the tokens alone would send a piston aeroplane to a field that
		// stopped selling 100LL.
		name:   "LFPO withdraws a grade it names (VAC)",
		text:   "Carburants / Fuel : Jet A1 (CIV-MIL), 100 LL non disponible / 100 LL not available. Lubrifiants : tous lubrifiants pour ACFT courant (CIV-MIL) / lubricants for every ACFT (CIV-MIL).",
		avail:  AvailYes,
		grades: []Scoped{{GradeJetA1, ScopeAny}},
	},
	{
		name:   "LFPO withdraws a grade it names (AIXM)",
		text:   "Carburants / Fuel grades: JET A1 (CIV-MIL).# 100LL non disponible / 100LL not available.#Lubrifiants / Oil grades: tous lubrifiants pour ACFT courants / Oil for every ACFT",
		avail:  AvailYes,
		grades: []Scoped{{GradeJetA1, ScopeAny}},
	},
	{
		// Dax splits its pump between the armed forces and everyone else.
		// A civil pilot must not be offered the F-34.
		name:   "LFBY scopes MIL and CIV apart (AIXM)",
		text:   "MIL : F34#CIV : 100 LL - UL 91 sur demande/on request",
		avail:  AvailYes,
		grades: []Scoped{{Grade100LL, ScopeCiv}, {GradeUL91, ScopeCiv}, {GradeF34, ScopeMil}},
		cond:   []Condition{CondOR},
	},
	{
		// The plate's own wording of the same split, and the case that
		// showed the label run reaching back over the " - " between two
		// grades: read as a clause head, it cut Dax off after the F-34.
		name:   "LFBY scopes MIL and CIV apart (VAC)",
		text:   "C  arburants sur demande / Fuel on request : MIL : F34 - CIV : 100 LL - UL 91 Paiement / Payment : - MIL : Carte SCALP / SCALP Card 05 58 35 93 34",
		avail:  AvailYes,
		grades: []Scoped{{Grade100LL, ScopeCiv}, {GradeUL91, ScopeCiv}, {GradeF34, ScopeMil}},
		cond:   []Condition{CondOR},
	},
	{
		// A fuel grade and an oil grade of nearly the same shape, on one
		// line, told apart only by their labels.
		name:   "LFAW keeps the oil grades out",
		text:   "Carburants / Fuel : 100/130 - Lubrifiant / Lubricant : 100/120 (CIV). Réservé aux aéronefs basés / Reserved for home-based ACFT.",
		avail:  AvailYes,
		grades: []Scoped{{GradeAvgas, ScopeAny}},
		cond:   []Condition{CondBased},
	},
	{
		name:   "LFAI keeps the oil grades out (AIXM, bilingual)",
		text:   `Carburant : 100LL#Lubrifiants : 80 D - 100 D (CIV)\\Fuel : 100LL#Lubricant : 80 D - 100 D (CIV)`,
		avail:  AvailYes,
		grades: []Scoped{{Grade100LL, ScopeAny}},
	},
	{
		// The commonest shape in the corpus, and the one that showed a head
		// reaching back over the grade's own letters: with " LL - Lubrifiant
		// / Lubricant" read as the next head, the fuel clause ended at
		// "100" and the grade vanished. 54 aerodromes read this way.
		name:   "LFET keeps the grade the next label reaches for",
		text:   "Carburant / Fuel : 100 LL - Lubrifiant / Lubricant : 80-100.",
		avail:  AvailYes,
		grades: []Scoped{{Grade100LL, ScopeAny}},
	},
	{
		// The same, with a comma where the corpus usually puts a dash.
		name:   "LFAI keeps it across a comma too",
		text:   "Carburant / Fuel : 100 LL, Lubrifiant / Lubricant : 80 D - 100 D (CIV) HJ.",
		avail:  AvailYes,
		grades: []Scoped{{Grade100LL, ScopeAny}},
	},
	{
		// A grade IS the head here, so there is no head at all and the whole
		// entry is the fuel clause.
		name:   "LFCF names its grade where a label would go",
		text:   "100 LL : HX. Paiement par chèque, espèces. Payment by cheques, cash.",
		avail:  AvailYes,
		grades: []Scoped{{Grade100LL, ScopeAny}},
		cond:   []Condition{CondHX},
	},
	{
		// The clause runs on past its own answer into a second statement.
		name:  "LFCT says NIL and keeps talking",
		text:  "Carburant / Fuel : NIL. Pas de fourniture de lubrifiant / No supply of lubricant (CIV-MIL) HX. O/R ACB.",
		avail: AvailNo,
		cond:  []Condition{CondOR, CondHX},
	},
	{
		// A seasonal closure is not "no fuel here".
		name:   "LFEA is seasonal, not dry",
		text:   "Carburant / Fuel : 100 LL. Lubrifiant / Lubricant : NIL. Uniquement en dehors des HOR ATS / only outside ATS SKED . Paiement comptant / Cash payment . Pas d’avitaillement entre le 15/11 et le 01/03",
		avail:  AvailYes,
		grades: []Scoped{{Grade100LL, ScopeAny}},
	},
	{
		// Fuel exists and is not for the visitor. Saying so is worth more
		// than saying nothing.
		name:  "LFEP has fuel, but not for you",
		text:  "Réservé / Reserved ACB.",
		avail: AvailYes,
		cond:  []Condition{CondBased},
	},
	{
		// "Super" alone is car petrol or unleaded avgas depending on who
		// wrote the plate. Refused.
		name:   "LFFB refuses a bare Super",
		text:   "Carburant / Fuel : 100LL, Super - Lubrifiants / Lubricants : 80 - 100 - 120. Réservé ACB / Reserved for ACB .",
		avail:  AvailYes,
		grades: []Scoped{{Grade100LL, ScopeAny}},
		cond:   []Condition{CondBased},
	},
	{
		// No label at all: the whole entry is the fuel clause, minus the
		// hours clause it does carry.
		name:   "LFHS carries its grades with no fuel label",
		text:   "AVGAS 100 LL et UL 91 H24 par carte TOTAL, ou bureau de piste par chèque, espèces et CB. AVGAS 100 LL and UL 91 H24 by TOTAL card, or cheque, cash or credit card in reporting office. HOR / SKED : 0900-1600.",
		avail:  AvailYes,
		grades: []Scoped{{Grade100LL, ScopeAny}, {GradeUL91, ScopeAny}},
		cond:   []Condition{CondH24},
	},
	{
		// Istres glosses each NATO code with its civil product. The gloss
		// names the fuel, not a second thing on offer: reading it would put
		// 100LL on the civil list at an air base.
		name:   "LFMI does not offer the gloss",
		text:   "Carburants / Fuel : F34 - F35 (JetA1) - F18 (100LL). Hors HOR / Out of HOR : PN 1 HR Lubrifiants / Oil : NIL",
		avail:  AvailYes,
		grades: []Scoped{{GradeF18, ScopeMil}, {GradeF34, ScopeMil}, {GradeF35, ScopeMil}},
		cond:   []Condition{CondOR},
	},
	{
		// The French services' own designations, at a civil airport.
		name:   "LFPG reads TR.0 as Jet A-1 and TR.4 as F-34",
		text:   "Carburants / Fuel : TR.0 ; TR.4. Lubrifiant / Lubricant : tous indices / any grade (CIV) H24.",
		avail:  AvailYes,
		grades: []Scoped{{GradeJetA1, ScopeAny}, {GradeF34, ScopeMil}},
		cond:   []Condition{CondH24},
	},
	{
		name:   "LFQJ reads UL AEROSUPER with no space",
		text:   "Carburants / Fuel : 100LL - UL AEROSUPER + . Pompe automatique. Paiement comptant - CB / Cash payment - credit card.",
		avail:  AvailYes,
		grades: []Scoped{{Grade100LL, ScopeAny}, {GradeSuper, ScopeAny}},
	},
	{
		// Lognes, the case that started this: three grades the app shows
		// none of today.
		name:   "LFPL reads the plate's three grades",
		text:   "Carburants / Fuel : 100 LL - JET A1 - UL AERO SUPER +. Lubrifiants / Lubricants : NIL. Paiement / Payment : Carte TOTAL / TOTAL card H24.",
		avail:  AvailYes,
		grades: []Scoped{{Grade100LL, ScopeAny}, {GradeSuper, ScopeAny}, {GradeJetA1, ScopeAny}},
		cond:   []Condition{CondH24},
	},
	{
		name:   "LFLP reads a SAF blend as Jet A-1 (AIXM, bilingual)",
		text:   "Carburants : marque TOTALENERGIES. 100 LL, UL Aéro Super +, JET A1 (CIV-MIL ), JET A1 SAF, électricité.",
		avail:  AvailYes,
		grades: []Scoped{{Grade100LL, ScopeAny}, {GradeSuper, ScopeAny}, {GradeJetA1, ScopeAny}},
	},
	{
		// Pontoise nests its clauses two deep, one branch per operator, and
		// sells 100LL on the south apron as well as the Jet A-1 read here.
		// The under-claim is deliberate: the entry's own words are shown
		// beside the chips, and a grammar that reached further into a
		// layout this loose would start reading the oils. What is asserted
		// is true; it is not everything that is true.
		name:   "LFPT is read only as far as its layout allows",
		text:   "Carburant / Fuel : Aviation d'affaires / Business aviation : Lubrifiants / Lubricants - JET A1 : E-mail : ameridair@ameridair.com TEL : +33 (0)9 62 61 19 36",
		avail:  AvailYes,
		grades: []Scoped{{GradeJetA1, ScopeAny}},
	},
	{
		// A supplier is not a clause. Reading "TOTAL :" as one ends the
		// fuel clause at the brand and drops the grade behind it.
		name:   "LFEH reads past the supplier's name",
		text:   "Carburant / Fuel : TOTAL : 100 LL O/R PN 1 HR TEL : ACB. PPR 24 HR E-mail.",
		avail:  AvailYes,
		grades: []Scoped{{Grade100LL, ScopeAny}},
		cond:   []Condition{CondOR},
	},
	{
		// An hours-only entry: the AIXM slot Lognes fills with its opening
		// times and no grade at all.
		name:  "LFPL AIXM carries hours and no grade",
		text:  "ETE : 0730-1030, 1200-1600.#HIV : 0830-1130, 1300-1600.",
		avail: AvailYes,
	},
	{
		name:  "a bare NIL is a field with no fuel",
		text:  "NIL.",
		avail: AvailNo,
	},
	{
		name:  "an empty entry is not a row",
		text:  "   ",
		avail: "",
	},
}

func TestParse(t *testing.T) {
	for _, c := range parseCases {
		t.Run(c.name, func(t *testing.T) {
			got := Parse(c.text)
			if got.Avail != c.avail {
				t.Errorf("avail = %q, want %q", got.Avail, c.avail)
			}
			if !sameGrades(got.Grades, c.grades) {
				t.Errorf("grades = %v, want %v", got.Grades, c.grades)
			}
			if !sameConds(got.Cond, c.cond) {
				t.Errorf("conditions = %v, want %v", got.Cond, c.cond)
			}
			if c.avail != "" && got.Text != c.text {
				t.Errorf("the source's own words must come back untouched")
			}
		})
	}
}

// The two halves of a bilingual entry state the same thing, so reading
// either alone must give the same grades. A pattern that only matched the
// French would silently empty every English-only plate; the app's other
// extractors are pinned the same way (tests/bilingual.spec.ts).
func TestParseIsLanguageInvariant(t *testing.T) {
	pairs := [][2]string{
		{"Carburants : 100LL - JET A1 (CIV-MIL)", "Fuel grades : 100LL - JET A1 (CIV-MIL)"},
		{"Carburant : 100LL#Lubrifiants : 80 D - 100 D", "Fuel : 100LL#Lubricant : 80 D - 100 D"},
		{"Carburants : 100 LL, UL Aéro Super +", "Fuel : 100 LL, UL Aero Super +"},
		{"Carburant / Fuel : NIL. Pas de fourniture de lubrifiant", "Carburant / Fuel : NIL. No supply of lubricant"},
		{"Carburants : Jet A1, 100 LL non disponible", "Fuel : Jet A1, 100 LL not available"},
		{"Carburant : 100 LL. Réservé aux aéronefs basés", "Fuel : 100 LL. Reserved for home-based ACFT"},
	}
	for _, p := range pairs {
		fr, en := Parse(p[0]), Parse(p[1])
		if !sameGrades(fr.Grades, en.Grades) {
			t.Errorf("%q -> %v but %q -> %v", p[0], fr.Grades, p[1], en.Grades)
		}
		if fr.Avail != en.Avail {
			t.Errorf("%q avail %q but %q avail %q", p[0], fr.Avail, p[1], en.Avail)
		}
		if !sameConds(fr.Cond, en.Cond) {
			t.Errorf("%q cond %v but %q cond %v", p[0], fr.Cond, p[1], en.Cond)
		}
	}
}

func TestMergeUnionsTheTwoSources(t *testing.T) {
	// Lognes: the AIXM slot has the hours, the plate has the grades.
	aixm := Parse("ETE : 0730-1030, 1200-1600.#HIV : 0830-1130, 1300-1600.")
	vac := Parse("Carburants / Fuel : 100 LL - JET A1 - UL AERO SUPER +. Paiement / Payment : Carte TOTAL H24.")
	got := Merge(vac, aixm)
	if got.Avail != AvailYes || len(got.Grades) != 3 {
		t.Fatalf("merged = %+v", got)
	}
	if !strings.Contains(got.Text, "100 LL - JET A1") {
		t.Errorf("the merge must keep the richer source's words, got %q", got.Text)
	}

	// A source naming grades outweighs a source saying NIL: a stale NIL is
	// how an unrevised entry reads, while a named grade had to be written.
	if m := Merge(Parse("Carburant / Fuel : 100 LL."), Parse("NIL.")); m.Avail != AvailYes || !m.Has(Grade100LL) {
		t.Errorf("a named grade must outweigh a NIL, got %+v", m)
	}
	// NIL wins when it is all there is.
	if m := Merge(Parse("NIL."), Statement{}); m.Avail != AvailNo {
		t.Errorf("a lone NIL must stay a no, got %+v", m)
	}
	// But two silences stay silence: neither source said the field is dry.
	if m := Merge(Statement{}, Statement{}); m.Avail != "" {
		t.Errorf("merging two silences must say nothing, got %+v", m)
	}
	// One source names the grade, the other only the family: the union
	// offers one avgas, not two.
	if m := Merge(Parse("Carburant : AVGAS - JET A1"), Parse("Carburant : AVGAS 100LL - JET A1")); m.Has(GradeAvgas) {
		t.Errorf("the unqualified AVGAS must not survive beside 100LL, got %+v", m.Grades)
	}
	// The wider scope survives a grade read twice.
	m := Merge(Parse("Carburant / Fuel : 100 LL"), Parse("CIV : 100 LL"))
	if len(m.Grades) != 1 || m.Grades[0].Scope != ScopeAny {
		t.Errorf("merged scope = %+v, want the wider one", m.Grades)
	}
}

func TestCompareClassifiesTheTwoSources(t *testing.T) {
	a := Parse("Carburant : 100 LL - JET A1")
	b := Parse("Carburant : JET A1")
	if got := Compare(a, b); got != AgreeARicher {
		t.Errorf("Compare = %q, want %q", got, AgreeARicher)
	}
	if got := Compare(b, a); got != AgreeBRicher {
		t.Errorf("Compare = %q, want %q", got, AgreeBRicher)
	}
	if got := Compare(a, a); got != AgreeSame {
		t.Errorf("Compare = %q, want %q", got, AgreeSame)
	}
	if got := Compare(Parse("Carburant : 100 LL"), Parse("Carburant : JET A1")); got != AgreeDiverge {
		t.Errorf("Compare = %q, want %q", got, AgreeDiverge)
	}
	// The AD 2.4 entry names the avgas, the plate names only the family.
	// Four aerodromes read that way, and none of them is a contradiction:
	// one source simply knows which avgas it is.
	if got := Compare(Parse("Carburant : AVGAS 100LL - JET A1"), Parse("Carburant : AVGAS - JET A1")); got != AgreeARicher {
		t.Errorf("Compare = %q, want %q", got, AgreeARicher)
	}
}

// The first four grades are spelled exactly as the aircraft data sheets
// spell them, which is what lets the app match a plane to a pump without a
// mapping table. tests/fuelGrades.spec.ts pins the other side of it.
func TestVocabularyMatchesTheAircraftSpellings(t *testing.T) {
	for _, want := range []Grade{"100LL", "UL91", "SUPER AERO+", "JET A-1"} {
		found := false
		for _, g := range Vocabulary {
			if g == want {
				found = true
			}
		}
		if !found {
			t.Errorf("%q is a FUEL_TYPE_INFO key and must be in the vocabulary", want)
		}
	}
}

func sameGrades(a, b []Scoped) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func sameConds(a, b []Condition) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
