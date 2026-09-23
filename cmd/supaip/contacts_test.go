package main

import (
	"fmt"
	"reflect"
	"strings"
	"testing"
)

// Rows mirror the pipeline's reconstruction (intra-run spaces lost, unit and
// frequencies in separate cells of one row), modelled on real SUPs 094 / 088 /
// 098. row()/cell{} come from activations_test.go.

func TestParseContacts(t *testing.T) {
	rows := []prow{
		row(20, cell{0, "INFORMATION DES USAGERS"}),
		row(19, cell{0, "Activitéréelleconnuede:"}),
		row(18, cell{0, "SeineINFO:"}, cell{200, "127.815MHz,134.300MHz,134.875MHz"}),
		row(17, cell{0, "ParisCTL:"}, cell{200, "125.450MHz,118.725MHz"}),
		row(16, cell{0, "BloisINFO:"}, cell{200, "118.455MHz(PendanthorairesATS)"}),
		row(15, cell{0, "RAKIouCDCderemplacement"}, cell{200, "119.700MHz,143.550MHzet317.500MHz"}),
		row(14, cell{0, "ORGANISMEGESTIONNAIRE"}), // terminator
		row(13, cell{0, "CDCdeCinqMarslaPile."}),
	}
	want := []contactFreq{
		{unit: "SeineINFO", freqs: []string{"127.815", "134.300", "134.875"}},
		{unit: "ParisCTL", freqs: []string{"125.450", "118.725"}},
		{unit: "BloisINFO", freqs: []string{"118.455"}},
		{unit: "RAKIouCDCderemplacement", freqs: []string{"119.700", "143.550", "317.500"}},
	}
	if got := parseContacts(rows); !reflect.DeepEqual(got, want) {
		t.Errorf("parseContacts =\n%+v\nwant\n%+v", got, want)
	}
}

// 098: a non-numeric value becomes a note; the decimal comma normalises to a
// dot; a bare "GESTIONNAIRES" heading terminates the block.
func TestParseContactsNoteAndCommaDecimal(t *testing.T) {
	rows := []prow{
		row(6, cell{0, "Activitéréelleconnuede:"}),
		row(5, cell{0, "ACCBORDEAUX:"}, cell{200, "fréquencesdecontrôle"}),
		row(4, cell{0, "MARINA(CDCdeMontdeMarsan):"}, cell{200, "143,550MHz317,500MHz"}),
		row(3, cell{0, "GESTIONNAIRES"}),
	}
	want := []contactFreq{
		{unit: "ACCBORDEAUX", note: "fréquencesdecontrôle"},
		{unit: "MARINA(CDCdeMontdeMarsan)", freqs: []string{"143.550", "317.500"}},
	}
	if got := parseContacts(rows); !reflect.DeepEqual(got, want) {
		t.Errorf("parseContacts =\n%+v\nwant\n%+v", got, want)
	}
}

// The forecast line ("Prévision d'activité connue de ...") is not a real-time
// table and must not seed a block.
func TestParseContactsExcludesPrevision(t *testing.T) {
	rows := []prow{
		row(3, cell{0, "Prévisiond'activitéconnuedeRaki(CDC)etBricyApproche."}),
		row(2, cell{0, "Bidon:119.700MHz"}), // would be captured if prevision seeded a block
		row(1, cell{0, "STATUT"}),
	}
	if got := parseContacts(rows); len(got) != 0 {
		t.Errorf("prevision line should yield no contacts, got %+v", got)
	}
}

func TestParsePenetration(t *testing.T) {
	cases := []struct {
		name string
		rule string
		want string
	}{
		{"circumvent", "CAG/CAM:contournementobligatoiresaufpour:", "circumvent"},
		{"forbidden", "Pénétrationinterditesaufdérogation.", "forbidden"},
		{"conditional", "Pénétrationsoumiseàautorisationdugestionnaire.", "conditional"},
		{"other", "Voirconsignesparticulièresci-dessous.", "other"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rows := []prow{
				row(3, cell{0, "CONDITIONSDEPÉNÉTRATION"}),
				row(2, cell{0, c.rule}),
				row(1, cell{0, "SERVICES RENDUS"}),
			}
			got := parsePenetration(rows)
			if got == nil {
				t.Fatalf("parsePenetration = nil, want kind %q", c.want)
			}
			if got.kind != c.want {
				t.Errorf("kind = %q, want %q (text %q)", got.kind, c.want, got.text)
			}
		})
	}
}

func TestParsePenetrationNone(t *testing.T) {
	rows := []prow{row(2, cell{0, "STATUT"}), row(1, cell{0, "blah"})}
	if got := parsePenetration(rows); got != nil {
		t.Errorf("parsePenetration = %+v, want nil", got)
	}
}

// When the "CAG/CAM :" prefix sits on its own line, the verdict is the next
// line, and that (clean) line is what text keeps.
func TestParsePenetrationVerdictLine(t *testing.T) {
	rows := []prow{
		row(4, cell{0, "CONDITIONSDEPÉNÉTRATION"}),
		row(3, cell{0, "CAG/CAM:"}),
		row(2, cell{0, "Pénétrationsoumiseàautorisation."}),
		row(1, cell{0, "SERVICES RENDUS"}),
	}
	got := parsePenetration(rows)
	if got == nil || got.kind != "conditional" {
		t.Fatalf("parsePenetration = %+v, want conditional", got)
	}
	if got.text != "Pénétrationsoumiseàautorisation." {
		t.Errorf("text = %q, want the verdict line", got.text)
	}
}

// Fields the native extractor mangled (U+FFFD / control chars) are dropped, not
// stored as mojibake; clean siblings and the penetration kind survive.
func TestSanitizeResult(t *testing.T) {
	res := &geomResult{
		contacts: []contactFreq{
			{unit: "Seine INFO", freqs: []string{"127.815"}},
			{unit: "�p\x03GDUQ", freqs: []string{"119.700"}},               // garbled
			{unit: "000°04'06'' W Cognac APP", freqs: []string{"132.450"}}, // coordinate fragment
		},
		manager:     "�p\x03GDUQWWLLOH",
		penetration: &penetrationRule{kind: "circumvent", text: "garbled�text"},
	}
	sanitizeResult(res)
	if len(res.contacts) != 1 || res.contacts[0].unit != "Seine INFO" {
		t.Errorf("contacts = %+v, want only Seine INFO", res.contacts)
	}
	if res.manager != "" {
		t.Errorf("manager = %q, want empty", res.manager)
	}
	if res.penetration.kind != "circumvent" || res.penetration.text != "" || !res.penetration.refused {
		t.Errorf("penetration = %+v, want kind kept, text blanked and refused", res.penetration)
	}
}

func TestParseManager(t *testing.T) {
	rows := []prow{
		row(5, cell{0, "ORGANISMEGESTIONNAIRE"}),
		row(4, cell{0, "CentredeDétection(CDC)deCinqMarslaPileouCDCdeRemplacement."}),
		row(3, cell{0, "STATUT"}),
	}
	want := "CentredeDétection(CDC)deCinqMarslaPileouCDCdeRemplacement."
	if got := parseManager(rows); got != want {
		t.Errorf("parseManager = %q, want %q", got, want)
	}
}

// A bare "GESTIONNAIRES" heading is recognised; phone lines are dropped; prose
// mentioning "gestionnaire" is not mistaken for the heading.
func TestParseManagerDropsPhonesAndProse(t *testing.T) {
	rows := []prow{
		row(6, cell{0, "lesaéronefsayantreçuuneautorisationdugestionnaire."}), // prose, not a heading
		row(5, cell{0, "GESTIONNAIRES"}),
		row(4, cell{0, "ExploitantdelADdeCOULOMMIERSVOISINS"}),
		row(3, cell{0, "Téléphone:0669580403"}),
		row(2, cell{0, "STATUT"}),
	}
	want := "ExploitantdelADdeCOULOMMIERSVOISINS"
	if got := parseManager(rows); got != want {
		t.Errorf("parseManager = %q, want %q", got, want)
	}
}

// A dotted phone number matches freqRe token-wise ("03.62", "94.21") but lies
// outside the airband window, so a phone line inside a contact block yields no
// entry, and a mixed line keeps only its real frequency.
func TestParseContactsAirbandWindow(t *testing.T) {
	rows := []prow{
		row(5, cell{0, "Activitéréelleconnuede:"}),
		row(4, cell{0, "PNIA:"}, cell{200, "03.62.94.21.30"}),
		row(3, cell{0, "SeineINFO:"}, cell{200, "127.815MHzTEL03.62.94.21.30"}),
		row(2, cell{0, "STATUT"}),
	}
	want := []contactFreq{
		{unit: "SeineINFO", freqs: []string{"127.815"}},
	}
	if got := parseContacts(rows); !reflect.DeepEqual(got, want) {
		t.Errorf("parseContacts =\n%+v\nwant\n%+v", got, want)
	}
}

// The rule is read off the layout text and re-flowed: the head closes on its
// colon, each item opens on its bullet, and a wrap rejoins the line above it.
// This is 172/2025, whose exception lines the native extractor scrambles.
func TestPenetrationBlock(t *testing.T) {
	layout := strings.Join([]string{
		"                                CONDITIONS DE PENETRATION",
		"CAG / CAM : Contournement obligatoire, sauf pour :",
		"    -   les aéronefs sans équipage à bord autorisés par le gestionnaire,",
		"    -   les aéronefs effectuant des activités de douane, de police, du transport médical",
		"        ayant à intervenir dans le cadre de leurs missions et lorsque celles-ci ne",
		"        permettent pas le contournement de la zone.",
		"",
		"",
		"                                    SERVICES RENDUS",
		"ZRT LANNION AERODROME : Information de vol rendue par LANNION INFO",
	}, "\n")
	read := readPenetration(layout)
	if !read.found || read.refused {
		t.Fatalf("readPenetration = %+v, want the section read", read)
	}
	got := read.text
	want := "CAG / CAM : Contournement obligatoire, sauf pour :\n" +
		"- les aéronefs sans équipage à bord autorisés par le gestionnaire,\n" +
		"- les aéronefs effectuant des activités de douane, de police, du transport médical " +
		"ayant à intervenir dans le cadre de leurs missions et lorsque celles-ci ne permettent " +
		"pas le contournement de la zone."
	if got != want {
		t.Errorf("readPenetration =\n%q\nwant\n%q", got, want)
	}
	if read.kind != "circumvent" {
		t.Errorf("kind = %q, want circumvent", read.kind)
	}
}

// A line that stops short of the section's own measure ended its statement:
// 167/2025 sets the CAG rule and the CAM rule on two lines, and reading them as
// one run-on invites a CAG pilot to read past their own.
func TestPenetrationBlockShortLineEndsStatement(t *testing.T) {
	layout := strings.Join([]string{
		"                         CONDITIONS DE PÉNÉTRATION",
		"CAG : contournement obligatoire",
		"CAM : contournement obligatoire, y compris pour les aéronefs sans équipage à bord",
		"",
		"",
		"                              SERVICES RENDUS",
	}, "\n")
	got := readPenetration(layout).text
	want := "CAG : contournement obligatoire\n" +
		"CAM : contournement obligatoire, y compris pour les aéronefs sans équipage à bord"
	if got != want {
		t.Errorf("readPenetration = %q, want %q", got, want)
	}
}

// The section 078/2026 sets in two columns is refused: -layout interleaves the
// rows, so reading it as prose would give Roanne's zone Clermont-Roanne's rule.
// The section IS found, and refused, which is what tells the panel to say the
// rule is in the supplement rather than let the tag stand for all of it.
func TestPenetrationBlockRefusesColumns(t *testing.T) {
	layout := strings.Join([]string{
		"                      CONDITIONS DE PÉNÉTRATION",
		"ZRT ROANNE :                                    ZRT CLERMONT-ROANNE 1 et 2 :",
		"Contournement obligatoire sauf pour :           CAG IFR, CAM I/T/V : contournement",
		"    - les planeurs participant à la             obligatoire sauf accord du gestionnaire.",
		"compétition ;",
		"",
		"",
		"                            SERVICES RENDUS",
	}, "\n")
	read := readPenetration(layout)
	if !read.found || !read.refused || read.text != "" {
		t.Errorf("readPenetration = %+v, want found, refused, no text", read)
	}
	if read.kind != "circumvent" {
		t.Errorf("kind = %q, want circumvent", read.kind)
	}
}

// An indented bullet list is not a column layout: what stands to the left of
// the gap is the item's own marker (159/2025).
func TestPenetrationBlockKeepsIndentedList(t *testing.T) {
	layout := strings.Join([]string{
		"                    CONDITIONS DE PENETRATION",
		"CAG / CAM : contournement obligatoire pendant l’activité réelle sauf pour :",
		"-          Les aéronefs participant aux missions programmées,",
		"-          Les aéronefs autorisés par Saint-Dizier APP.",
		"",
		"",
		"                         SERVICES RENDUS",
	}, "\n")
	got := readPenetration(layout).text
	want := "CAG / CAM : contournement obligatoire pendant l’activité réelle sauf pour :\n" +
		"- Les aéronefs participant aux missions programmées,\n" +
		"- Les aéronefs autorisés par Saint-Dizier APP."
	if got != want {
		t.Errorf("readPenetration = %q, want %q", got, want)
	}
}

// The next section closes the rule only where it is the SIA's own centred head:
// a rule line opening on "services" is prose (the CAR/SAM/NAM 001/2025
// supplement), and a drone rule folds to "quipage", which is not a page marker.
func TestPenetrationBlockReadsPastProseHeads(t *testing.T) {
	layout := strings.Join([]string{
		"                    CONDITIONS DE PÉNÉTRATION",
		"Pénétration interdite à tout aéronef sans équipage à bord, à l’exception des aéronefs assurant une mission au profit des",
		"services de l'État (défense, gendarmerie, douanes).",
		"",
		"",
		"                         SERVICES RENDUS",
	}, "\n")
	got := readPenetration(layout).text
	want := "Pénétration interdite à tout aéronef sans équipage à bord, à l’exception des aéronefs " +
		"assurant une mission au profit des services de l'État (défense, gendarmerie, douanes)."
	if got != want {
		t.Errorf("readPenetration = %q, want %q", got, want)
	}
}

// A section the native rows missed altogether still yields a rule, classified
// off the layout text's reading of it.
func TestResolvePenetrationFromLayoutAlone(t *testing.T) {
	layout := strings.Join([]string{
		"                    CONDITIONS DE PÉNÉTRATION",
		"Pénétration interdite à tout aéronef sans équipage à bord.",
		"",
		"",
		"                         SERVICES RENDUS",
	}, "\n")
	got := resolvePenetration(nil, layout, func(s string) string { return s })
	if got == nil || got.kind != "forbidden" {
		t.Fatalf("resolvePenetration = %+v, want forbidden", got)
	}
	if got.text != "Pénétration interdite à tout aéronef sans équipage à bord." {
		t.Errorf("text = %q", got.text)
	}
}

// With no readable section (poppler absent, so the layout text is empty) the
// native verdict line stands, and sanitizeResult is what keeps it from ending
// on the connector that opens the exception.
func TestPenetrationFallsBackToVerdictLine(t *testing.T) {
	rule := &penetrationRule{kind: "circumvent", text: "CAG / CAM : Contournement obligatoire, sauf pour"}
	got := resolvePenetration(rule, "", func(s string) string { return s })
	if got.text != "CAG / CAM : Contournement obligatoire, sauf pour" {
		t.Fatalf("text = %q, want the verdict line untouched", got.text)
	}
	res := &geomResult{penetration: got}
	sanitizeResult(res)
	if res.penetration.text != "CAG / CAM : Contournement obligatoire" {
		t.Errorf("text = %q, want the dangling clause cut", res.penetration.text)
	}
}

func TestTrimDanglingClause(t *testing.T) {
	cases := []struct{ in, want string }{
		{"CAG / CAM : contournement obligatoire sauf pour", "CAG / CAM : contournement obligatoire"},
		{"CAG / CAM : contournement obligatoire à l’exception des", "CAG / CAM : contournement obligatoire"},
		{"Contournement obligatoire durant l'activité sauf", "Contournement obligatoire durant l'activité"},
		// A stated condition is a complete answer and survives whole.
		{"Contournement obligatoire, sauf après contact radio avec LORIENT INFO 122.700 MHz pour",
			"Contournement obligatoire, sauf après contact radio avec LORIENT INFO 122.700 MHz"},
		// Nothing dangling: left alone, trailing full stop included.
		{"Pénétration interdite à tout aéronef sans équipage à bord.", "Pénétration interdite à tout aéronef sans équipage à bord."},
		// Only the last line is examined.
		{"Contournement obligatoire sauf pour :\n- les aéronefs basés ;\n- les aéronefs autorisés par",
			"Contournement obligatoire sauf pour :\n- les aéronefs basés ;\n- les aéronefs autorisés"},
		{"", ""},
		// French sets a space before the colon: the connector is looked past
		// it, never left exposed ("..., sauf pour").
		{"CAG / CAM : Contournement obligatoire, sauf pour :", "CAG / CAM : Contournement obligatoire"},
		// An elided article in CAPITALS folds like a lower-case one.
		{"PÉNÉTRATION INTERDITE A TOUT AÉRONEF, A L’EXCEPTION", "PÉNÉTRATION INTERDITE A TOUT AÉRONEF"},
		// A zone's own suffix is no preposition, however it is printed: cut,
		// the rule of LF-R 45 A would publish under LF-R 45's name.
		{"Contournement obligatoire de la LF-R 45 A", "Contournement obligatoire de la LF-R 45 A"},
		{"Contournement obligatoire de la LF-R 45 A.", "Contournement obligatoire de la LF-R 45 A."},
		{"Pénétration interdite dans la TSA 43A", "Pénétration interdite dans la TSA 43A"},
		{"Contournement obligatoire de la zone (A)", "Contournement obligatoire de la zone (A)"},
		// The capital preposition still dangles where no number precedes it.
		{"PÉNÉTRATION INTERDITE SAUF AUTORISATION ACCORDÉE A", "PÉNÉTRATION INTERDITE SAUF AUTORISATION ACCORDÉE"},
	}
	for _, c := range cases {
		if got := trimDanglingClause(c.in); got != c.want {
			t.Errorf("trimDanglingClause(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// The heading is the line that BEGINS with the heading words. 056/2026's
// summary mentions them mid-sentence, and a substring match published the
// fragment after it ("trajectoires spécifiques hélicoptère") as the rule.
func TestPenetrationHeadingIsAnchored(t *testing.T) {
	for _, h := range []string{
		"                  CONDITIONS DE PÉNÉTRATION",
		"CONDITIONS DE PENETRATION",
		"5. CONDITIONS DE PÉNÉTRATION",
		"\fCONDITIONS DE PÉNÉTRATION",
		"CONDITIONSDEP�N�TRATION", // the native rows' jammed form
	} {
		if !isPenetrationHeading(h) {
			t.Errorf("isPenetrationHeading(%q) = false, want true", h)
		}
	}
	summary := "   Publication d’un SUP AIP espace détaillant les conditions de pénétration dans la ZRT GPM., ainsi que les"
	if isPenetrationHeading(summary) {
		t.Errorf("isPenetrationHeading(summary) = true, want false")
	}
	layout := strings.Join([]string{
		summary,
		"   trajectoires spécifiques hélicoptère",
		"",
		"",
		"                         ASSISTANCE AÉROPORTUAIRE",
	}, "\n")
	if read := readPenetration(layout); read.found {
		t.Errorf("readPenetration = %+v, want no section", read)
	}
	rows := []prow{row(0, cell{0, "Publicationd’unSUPAIPespacedétaillantlesconditionsdepénétrationdanslaZRTGPM.,ainsiqueles"}), row(10, cell{0, "trajectoiresspécifiqueshélicoptère"})}
	if got := parsePenetration(rows); got != nil {
		t.Errorf("parsePenetration = %+v, want nil", got)
	}
}

// Two blank lines separate one zone's rule from the next, and do not end the
// section: 181/2026 read that way published ZRT 1's rule with its Monday cut
// off and never reached ZRT 2, 3 and 4. The paragraphs stay apart.
func TestPenetrationReadsAcrossParagraphs(t *testing.T) {
	layout := strings.Join([]string{
		"                    CONDITIONS DE PÉNÉTRATION",
		"ZRT 1 Air Legend :",
		"♦ Jeudi 3 : CAG / CAM : contournement obligatoire à l'exception des aéronefs basés.",
		"",
		"",
		"♦ Lundi 7 : CAG / CAM : contournement obligatoire à l'exception des aéronefs autorisés.",
		"",
		"",
		"ZRT 2, 3 et 4 Air Legend:",
		"CAG / CAM : contournement obligatoire à l'exception des aéronefs participants.",
		"",
		"",
		"                         SERVICES RENDUS",
		"CAM : services rendus par les organismes habituels.",
	}, "\n")
	read := readPenetration(layout)
	want := "ZRT 1 Air Legend :\n" +
		"♦ Jeudi 3 : CAG / CAM : contournement obligatoire à l'exception des aéronefs basés.\n\n" +
		"♦ Lundi 7 : CAG / CAM : contournement obligatoire à l'exception des aéronefs autorisés.\n\n" +
		"ZRT 2, 3 et 4 Air Legend:\n" +
		"CAG / CAM : contournement obligatoire à l'exception des aéronefs participants."
	if read.refused || read.text != want {
		t.Errorf("readPenetration =\n%q (refused %v)\nwant\n%q", read.text, read.refused, want)
	}
	// A heading WORD after a paragraph break closes the section even when it
	// is not set at the centred indent sectionHead wants.
	left := strings.Replace(layout, "                         SERVICES RENDUS", "SERVICES RENDUS", 1)
	if got := readPenetration(left).text; got != want {
		t.Errorf("left-set head: text =\n%q\nwant\n%q", got, want)
	}
}

// A rule carries on over a page break (099/2026's "Partie ZDT" opens the next
// page), and ends where the next page is a heading or a FIGURE: 001/2026's
// rule ends at the foot of its page and a map extract follows.
func TestPenetrationAcrossPageBreak(t *testing.T) {
	foot := []string{"", "", "                                    FR", "                  Page 7/13     © SIA", "\fSUP AIP AIRAC 099/26            Date de publication : 07 MAY 2026", ""}
	head := []string{
		"                    CONDITIONS DE PÉNÉTRATION",
		"Partie ZRT :",
		"CAG VFR/CAM, contournement obligatoire, sauf pour les aéronefs participant à l’exercice.",
	}
	prose := "L’attention des navigateurs aériens est attirée sur le caractère particulièrement dangereux des activités se déroulant dans ces zones, où il est fortement recommandé de ne pas pénétrer pendant les créneaux d’activité publiés par NOTAM."
	cont := append(append(append([]string{}, head...), foot...),
		"Partie ZDT :",
		"CAG/CAM : se conformer aux instructions des organismes habituels de la circulation aérienne.",
		prose,
		"",
		"",
		"                         SERVICES RENDUS",
	)
	read := readPenetration(strings.Join(cont, "\n"))
	if read.refused || !strings.Contains(read.text, "Partie ZDT :") ||
		!strings.Contains(read.text, "\n\nPartie ZDT :") {
		t.Errorf("continued page: text = %q (refused %v), want the ZDT part as its own paragraph", read.text, read.refused)
	}
	figure := append(append(append([]string{}, head...), foot...),
		"                VUE GENERALE Région Atlantique, Gascogne et Centre",
		"",
		"                Extrait carte au 1 / 1 000 000 SIA – Édition 1-2025",
		"",
		"                                    FR",
	)
	if got := readPenetration(strings.Join(figure, "\n")).text; strings.Contains(got, "VUE GENERALE") {
		t.Errorf("figure page read into the rule: %q", got)
	}
	heading := append(append(append([]string{}, head...), foot...), "                         SERVICES RENDUS", "CAM : Les services de contrôle sont rendus.")
	if got := readPenetration(strings.Join(heading, "\n")).text; strings.Contains(got, "CAM : Les services") {
		t.Errorf("next section read into the rule: %q", got)
	}
	// A page opening on a heading ends the rule whatever the page carries
	// after it: this one is prose, well past a figure's few words.
	long := append(append(append([]string{}, head...), foot...), "INFORMATION DES USAGERS", prose, prose)
	if got := readPenetration(strings.Join(long, "\n")).text; strings.Contains(got, "INFORMATION DES USAGERS") || strings.Contains(got, "navigateurs") {
		t.Errorf("next section, a page of prose, read into the rule: %q", got)
	}
}

// Several sections publish as one union when every one names its own zone;
// exact repeats appear once. One that names no zone, or one heading that
// carries two different rules, refuses the whole text: the zones it is about
// are printed elsewhere in the document, where this reader cannot see them.
func TestPenetrationSectionsUnion(t *testing.T) {
	sec := func(lines ...string) string {
		return strings.Join(append(append([]string{"                    CONDITIONS DE PÉNÉTRATION"}, lines...), "", "", "                         SERVICES RENDUS", "CAM : rendus par les organismes habituels."), "\n")
	}
	a := sec("ZRT ALPHA :", "CAG/CAM : contournement obligatoire sauf pour les aéronefs participant à l’exercice.")
	b := sec("ZIT BRAVO :", "Pénétration interdite à tout aéronef.")
	read := readPenetration(a + "\n" + b + "\n" + a)
	want := "ZRT ALPHA :\nCAG/CAM : contournement obligatoire sauf pour les aéronefs participant à l’exercice.\n\n" +
		"ZIT BRAVO :\nPénétration interdite à tout aéronef."
	if read.refused || read.text != want {
		t.Errorf("union = %q (refused %v), want\n%q", read.text, read.refused, want)
	}
	// The strictest section's kind is the supplement's tag.
	if read.kind != "forbidden" {
		t.Errorf("kind = %q, want forbidden", read.kind)
	}
	unheaded := sec("Partie ZRT : CAG/CAM, contournement obligatoire sauf pour les aéronefs de l’exercice.")
	if r := readPenetration(a + "\n" + unheaded); !r.refused || r.text != "" || r.kind != "circumvent" {
		t.Errorf("unattributable union = %+v, want refused, graded circumvent", r)
	}
	a2 := sec("ZRT ALPHA :", "CAG/CAM : contournement obligatoire, sans exception.")
	if r := readPenetration(a + "\n" + a2); !r.refused {
		t.Errorf("one heading, two rules = %+v, want refused", r)
	}
	// A single section needs no zone heading: it is the supplement's own.
	if r := readPenetration(unheaded); r.refused || r.text == "" {
		t.Errorf("single unheaded section = %+v, want published", r)
	}
}

// The kind is recomputed from what the layout text reads, never kept from the
// native three-row guess (052/2026 wore "See rule" above PÉNÉTRATION
// INTERDITE). A refused section is graded on its strictest line: 110/2026's
// interleaved row carries both INTERDITE and OBLIGATOIRE, and the prohibition
// must win.
func TestPenetrationKindRecomputed(t *testing.T) {
	native := &penetrationRule{kind: "other", text: "PÉNÉTRATIONINTERDITEATOUTAÉRONEF"}
	layout := strings.Join([]string{
		"                    CONDITIONS DE PÉNÉTRATION",
		"PÉNÉTRATION INTERDITE A TOUT AÉRONEF SANS ÉQUIPAGE A BORD, A L'EXCEPTION DES AÉRONEFS AUTORISÉS.",
		"",
		"",
		"                         SERVICES RENDUS",
	}, "\n")
	got := resolvePenetration(native, layout, func(s string) string { return s })
	if got.kind != "forbidden" || got.refused {
		t.Errorf("resolvePenetration = %+v, want forbidden, published", got)
	}
	matrix := strings.Join([]string{
		"                    CONDITIONS DE PÉNÉTRATION",
		"ZIT LAC                 PENETRATION INTERDITE sauf     CONTOURNEMENT OBLIGATOIRE sauf",
		"ZRT SAVOIE              dans les cas ci-dessous        dans les cas ci-dessous",
		"",
		"",
		"                         SERVICES RENDUS",
	}, "\n")
	got = resolvePenetration(&penetrationRule{kind: "circumvent", text: "INTERDITEsaufdansOBLIGATOIRE"}, matrix, func(s string) string { return s })
	if got.kind != "forbidden" || !got.refused || got.text != "" {
		t.Errorf("resolvePenetration(matrix) = %+v, want forbidden, refused, no text", got)
	}
}

// One section setting out two zones is graded on the stricter, as a union of
// two sections is. 213/2026's zones with each rule in prose: ZRT REAPER
// LOURDES's own paragraph verbatim, then ZIT PAPE's prohibition, which the real
// document sets in a column matrix (refused). Graded on its opening, the
// prohibition published under the circumvention's tag.
func TestPenetrationGradedPerZone(t *testing.T) {
	layout := strings.Join([]string{
		"                                           CONDITIONS DE PÉNÉTRATION",
		"       ZRT REAPER LOURDES",
		"CAG / CAM, contournement obligatoire sauf pour :",
		"- les aéronefs participant au dispositif particulier de sûreté aérienne",
		"- les aéronefs effectuant des activités militaires, de douane, de police, de recherche et sauvetage, de lutte contre les",
		"incendies, du transport médical ayant à intervenir dans le cadre de l’exécution de leurs missions et lorsque celles-ci",
		"ne permettent pas le contournement de la zone, après coordination avec le gestionnaire.",
		"",
		"",
		"       ZIT PAPE",
		"Pénétration interdite à tout aéronef sauf autorisation de la cellule de coordination de l’activité aérienne (C2A2).",
		"",
		"",
		"                                                  SERVICES RENDUS",
	}, "\n")
	read := readPenetration(layout)
	if read.refused || !strings.Contains(read.text, "ZIT PAPE\nPénétration interdite") {
		t.Fatalf("readPenetration = %+v, want both zones published", read)
	}
	if read.kind != "forbidden" {
		t.Errorf("kind = %q, want forbidden", read.kind)
	}
}

// A prohibition is graded a prohibition whatever its exceptions say: 079/2026's
// ZIT CANNES opens "pénétration interdite", and an exception carrying "contact
// radio obligatoire" beside the usual "ne permettent pas le contournement"
// graded it a circumvention, both words of one standing in its first three
// statements.
func TestPenetrationProhibitionFirst(t *testing.T) {
	layout := strings.Join([]string{
		"                    CONDITIONS DE PÉNÉTRATION",
		"CAG/CAM : pénétration interdite à tous les aéronefs, y compris aux aéronefs télépilotés sans personne à bord, à l’exception :",
		"- des aéronefs effectuant des activités militaires, de douane, de police, de recherche et sauvetage, de lutte contre les",
		"incendies, du transport médical ayant à intervenir dans le cadre de l’exécution de leurs missions et lorsque celles-ci ne",
		"permettent pas le contournement de la zone,",
		"- des aéronefs effectuant des missions EVASAN, contact radio obligatoire avec NICE APP.",
		"",
		"",
		"                         SERVICES RENDUS",
	}, "\n")
	if read := readPenetration(layout); read.refused || read.kind != "forbidden" {
		t.Errorf("readPenetration = %+v, want forbidden, published", read)
	}
	// The native rows' window asks in the same order.
	if got := classifyPenetration("PÉNÉTRATION INTERDITE sauf dans les cas où le contournement est obligatoire"); got != "forbidden" {
		t.Errorf("classifyPenetration = %q, want forbidden", got)
	}
}

// A zone designation CITED inside a rule is no heading: two sections naming no
// zone of their own, each citing where its exempted traffic goes (100/2026's
// shape, one rule per exercise), cannot be told apart and are refused.
func TestPenetrationUnionHeadingAnchored(t *testing.T) {
	sec := func(lines ...string) string {
		return strings.Join(append(append([]string{"                    CONDITIONS DE PÉNÉTRATION"}, lines...), "", "", "                         SERVICES RENDUS", "CAM : rendus par les organismes habituels."), "\n")
	}
	a := sec("CAG/CAM : contournement obligatoire sauf pour les aéronefs participant à l’exercice et les aéronefs en transit vers la TRA 43 NORD.")
	b := sec("CAG/CAM : contournement obligatoire sauf pour les aéronefs en IFR au départ de Laval, après coordination avec la LF-R 45.")
	if read := readPenetration(a + "\n" + b); !read.refused || read.text != "" || read.kind != "circumvent" {
		t.Errorf("readPenetration = %+v, want refused, graded circumvent", read)
	}
	// A bulleted zone still opens its own rule.
	c := sec("- ZRT ALPHA : contournement obligatoire.")
	d := sec("- ZIT BRAVO : pénétration interdite.")
	if read := readPenetration(c + "\n" + d); read.refused || read.kind != "forbidden" {
		t.Errorf("bulleted union = %+v, want published, forbidden", read)
	}
}

// A rule ending on its zone's own name is closed: the digits and the suffix
// letter bared to "a" and read as the preposition, which refused the section.
func TestPenetrationEndsOnDesignator(t *testing.T) {
	for _, last := range []string{
		"CAG/CAM : contournement obligatoire, y compris dans la partie interférente avec la LF-D 226A.",
		"CAG/CAM : contournement obligatoire de la LF-R 45 A.",
	} {
		layout := strings.Join([]string{
			"                    CONDITIONS DE PÉNÉTRATION",
			last,
			"",
			"",
			"                         SERVICES RENDUS",
		}, "\n")
		if read := readPenetration(layout); read.refused || read.text != last {
			t.Errorf("readPenetration(%q) = %+v, want published whole", last, read)
		}
	}
}

// A section longer than the cap is refused rather than cut: the rest of the
// document, or the rest of the rule, lies past it.
func TestPenetrationOverflowRefused(t *testing.T) {
	lines := []string{"                    CONDITIONS DE PÉNÉTRATION", "CAG / CAM : contournement obligatoire sauf pour :"}
	for i := 0; i < maxRuleLines+5; i++ {
		lines = append(lines, "- les aéronefs autorisés par le gestionnaire,")
	}
	read := readPenetration(strings.Join(lines, "\n"))
	if !read.found || !read.refused || read.text != "" || read.kind != "circumvent" {
		t.Errorf("readPenetration = %+v, want found, refused, graded circumvent", read)
	}
}

// A section that ends OPEN, on the list head or a dangling connector, lost the
// rest of its statement, and trimming it back to the verdict would publish the
// prohibition without whoever it spares. It is still graded: the tag is then
// all the panel shows.
func TestPenetrationEndsOpenRefused(t *testing.T) {
	for _, c := range []struct{ last, kind string }{
		{"CAG / CAM : contournement obligatoire sauf pour :", "circumvent"},
		{"CAG / CAM : contournement obligatoire, à l’exception des", "circumvent"},
		// Only the colon says this list never arrived: "suivants" holds
		// nothing open.
		{"CAG / CAM : pénétration interdite, à l’exception des aéronefs suivants :", "forbidden"},
	} {
		layout := strings.Join([]string{
			"                    CONDITIONS DE PÉNÉTRATION",
			c.last,
			"",
			"",
			"                         SERVICES RENDUS",
		}, "\n")
		if read := readPenetration(layout); !read.refused || read.text != "" || read.kind != c.kind {
			t.Errorf("readPenetration(%q) = %+v, want refused, graded %s", c.last, read, c.kind)
		}
	}
}

// Symbol-font bullets come back as private-use code points; the ones the
// corpus carries are mapped and open an item, and any other is garbage.
func TestPenetrationPrivateUseBullets(t *testing.T) {
	layout := strings.Join([]string{
		"                    CONDITIONS DE PENETRATION",
		"Partie ZRT :",
		" CAG VFR/CAM aéronef sans équipage à bord, contournement obligatoire, sauf pour les aéronefs de l’exercice,",
		" les vols opérationnels ordonnés par CECLANT.",
		"",
		"",
		"                         SERVICES RENDUS",
	}, "\n")
	got := readPenetration(layout).text
	want := "Partie ZRT :\n− CAG VFR/CAM aéronef sans équipage à bord, contournement obligatoire, sauf pour les aéronefs de l’exercice,\n• les vols opérationnels ordonnés par CECLANT."
	if got != want {
		t.Errorf("text =\n%q\nwant\n%q", got, want)
	}
	if !isGarbled(" les aéronefs") {
		t.Errorf("isGarbled(unmapped private-use) = false, want true")
	}
	if isGarbled("− les aéronefs") {
		t.Errorf("isGarbled(mapped bullet) = true, want false")
	}
}

// The refusal reaches the JSON only when it is true, so a published rule's
// object is unchanged.
func TestPenetrationJSONRefused(t *testing.T) {
	if got := penetrationOrNull(&penetrationRule{kind: "forbidden", refused: true}); got != (penetrationJSON{Kind: "forbidden", Refused: true}) {
		t.Errorf("penetrationOrNull(refused) = %+v", got)
	}
	if got := penetrationOrNull(&penetrationRule{kind: "circumvent", text: "x"}); got != (penetrationJSON{Kind: "circumvent", Text: "x"}) {
		t.Errorf("penetrationOrNull(published) = %+v", got)
	}
}

// penSec wraps rule lines in one CONDITIONS DE PENETRATION section closed by
// the next centred head, the way the layout text prints it.
func penSec(lines ...string) string {
	head := []string{"                    CONDITIONS DE PÉNÉTRATION"}
	foot := []string{"", "", "                         SERVICES RENDUS", "CAM : services rendus par les organismes habituels."}
	return strings.Join(append(append(head, lines...), foot...), "\n")
}

// A published section is graded on EVERY statement it makes, the strictest
// winning. Graded on each zone's first three statements, a rule set out per
// traffic category, per day or per part put its verdict past the window and
// published a prohibition under a circumvention's tag, or under no tag at all.
func TestPenetrationGradedOnEveryStatement(t *testing.T) {
	// 142/2026's first section, ZRT PARA, verbatim: the IFR category first,
	// the VFR verdict fifth.
	para := []string{
		"Activités vélivoles suspendues à l’intérieur",
		"",
		"CAG IFR / CAM I / CAM T :",
		"suivre les instructions de l'organisme habituel de contrôle.",
		"",
		"CAG VFR / CAM V :",
		"Contournement OBLIGATOIRE sauf pour les cas suivants, après autorisation de l’organisme habituel de contrôle :",
		"       aéronefs largueurs",
		"       aéronefs eﬀectuant des activités militaires, de douane, de police, de recherche et sauvetage, de lutte contre",
		"       les incendies, du transport médical ayant à intervenir dans le cadre de l’exécution de leur mission et lorsque",
		"       leur mission ne permet pas le contournement de la ZRT.",
	}
	if read := readPenetration(penSec(para...)); read.refused || read.kind != "circumvent" {
		t.Errorf("142 ZRT PARA: %+v, want circumvent, published", read)
	}
	// The same section with the VFR rule 142's matrix states for ZIT CONCORDE.
	zit := append([]string{}, para...)
	zit[6] = strings.Replace(zit[6], "Contournement OBLIGATOIRE", "Pénétration interdite", 1)
	if read := readPenetration(penSec(zit...)); read.refused || read.kind != "forbidden" {
		t.Errorf("per category, VFR prohibited: %+v, want forbidden, published", read)
	}
	// 181/2026's ZRT 1 set out per day, the Monday prohibited, each day with
	// its own exception items.
	items := []string{
		"aéronefs participant aux répétitions de la manifestation aérienne ;",
		"aéronefs basés, après accord préalable de la direction des vols ;",
		"aéronefs autorisés par la direction des vols ;",
	}
	days := []string{"ZRT 1 Air Legend :", "♦ Jeudi 3 et vendredi 4 : CAG / CAM : contournement obligatoire à l'exception des :"}
	days = append(days, items...)
	days = append(days, "", "", "♦ Lundi 7 : CAG / CAM : pénétration interdite à l'exception des :")
	days = append(days, items...)
	if read := readPenetration(penSec(days...)); read.refused || read.kind != "forbidden" {
		t.Errorf("per day, Monday prohibited: %+v, want forbidden, published", read)
	}
	// A zone set out by PART (002/2026 and 099/2026's convention), and zones
	// headed by the bare type: no zone heading either way.
	parts := []string{
		"ZRT/ZIT CONCORDE",
		"",
		"Partie ZRT :",
		"CAG VFR/CAM, contournement obligatoire, sauf pour :",
		"- les aéronefs participant à l’exercice,",
		"- les aéronefs effectuant des activités militaires, de douane, de police, de recherche et sauvetage, de lutte contre les",
		"incendies, du transport médical ayant à intervenir dans le cadre de l’exécution de leurs missions et lorsque celles-ci",
		"ne permettent pas le contournement de la zone, après coordination avec la C2A2.",
		"",
		"Partie ZIT :",
		"CAG/CAM : pénétration interdite à tout aéronef sauf autorisation de la C2A2.",
	}
	if read := readPenetration(penSec(parts...)); read.refused || read.kind != "forbidden" {
		t.Errorf("by part, the ZIT prohibited: %+v, want forbidden, published", read)
	}
	bare := []string{
		"ZRT : CAG/CAM, contournement obligatoire sauf pour :",
		"- les aéronefs participant à l’exercice,",
		"- les aéronefs autorisés par la C2A2.",
		"ZIT : pénétration interdite à tout aéronef.",
	}
	if read := readPenetration(penSec(bare...)); read.refused || read.kind != "forbidden" {
		t.Errorf("bare type heads: %+v, want forbidden, published", read)
	}
	// A union this reader refuses shows the tag alone, so it must not
	// understate the prohibition the second section sets out per category
	// (100/2026's shape: neither section names its zones).
	a := penSec("CAG/CAM : contournement obligatoire sauf pour les aéronefs participant à l’exercice.")
	b := penSec(
		"CAG IFR / CAM I / CAM T :",
		"suivre les instructions de l'organisme habituel de contrôle.",
		"",
		"CAG VFR / CAM V :",
		"Pénétration interdite sauf autorisation de la C2A2.",
	)
	if read := readPenetration(a + "\n" + b); !read.refused || read.kind != "forbidden" {
		t.Errorf("refused union: %+v, want refused, forbidden", read)
	}
}

// Page furniture is known by its SHAPE and its PLACE: the foot just above a
// form feed ("FR", "Page 7/13", "© SIA") and the next page's header on the
// feed line itself. A prefix test on folded text took a rule line that wraps
// onto "SUP AIP", "Page", "Péage" or "SIA" for furniture and dropped it, the
// verdict with it.
func TestPenetrationFurnitureByShape(t *testing.T) {
	verdict := penSec(
		"Pendant les créneaux d’activation publiés par NOTAM et dans les limites latérales et verticales définies par le présent",
		"SUP AIP, la pénétration est interdite à tout aéronef, à l’exception :",
		"- des aéronefs effectuant des missions EVASAN, après autorisation de NICE APP ;",
		"- des aéronefs d’État autorisés par la C2A2.",
	)
	read := readPenetration(verdict)
	if read.refused || read.kind != "forbidden" || !strings.Contains(read.text, "présent SUP AIP, la pénétration est interdite") {
		t.Errorf("verdict wrapped onto \"SUP AIP\": %+v, want it published, forbidden", read)
	}
	prose := penSec(
		"CAG / CAM : contournement obligatoire sauf pour :",
		"- les aéronefs effectuant des activités militaires, de douane, de police, de recherche et sauvetage, de lutte contre les",
		"incendies, du transport médical, dans les conditions du protocole d’accord publié en annexe au présent",
		"SUP AIP, après coordination avec le Centre de Coordination et de contrôle de la Marine de l'Atlantique,",
		"- les aéronefs en transit par le point d’entrée situé à la verticale du",
		"Péage A10 de Saint Arnoult, après contact radio avec PARIS INFO,",
		"- les aéronefs autorisés par la cellule du",
		"SIA de Bordeaux.",
	)
	read = readPenetration(prose)
	for _, want := range []string{"présent SUP AIP, après coordination", "Péage A10 de Saint Arnoult", "SIA de Bordeaux."} {
		if read.refused || !strings.Contains(read.text, want) {
			t.Errorf("rule line dropped: %q missing from %+v", want, read)
		}
	}
	// The real thing between two pages: the three-line foot and the 13
	// documents' "AIRAC SUP AIP N°" header go, and the rule carries on.
	turn := penSec(
		"CAG / CAM : contournement obligatoire sauf pour :",
		"- les aéronefs participant à l’exercice,",
		"",
		"                                    FR",
		"                  Page 3/9",
		"                                  © SIA",
		"\fAIRAC SUP AIP N° 207/25          Date AIRAC : 22 JAN 2026       Date de publication : 11 DEC 2025",
		"",
		"- les aéronefs autorisés par la C2A2.",
		"L’attention des navigateurs aériens est attirée sur le caractère particulièrement dangereux des activités se déroulant dans ces zones, où il est fortement recommandé de ne pas pénétrer pendant les créneaux d’activité publiés par NOTAM.",
	)
	read = readPenetration(turn)
	if read.refused || strings.Contains(read.text, "SIA") || strings.Contains(read.text, "Page") ||
		strings.Contains(read.text, "Date AIRAC") || !strings.Contains(read.text, "autorisés par la C2A2") {
		t.Errorf("page turn: %+v, want the furniture gone and the rule whole", read)
	}
}

// The furniture marker takes the foot above a form feed and the header on it,
// and nothing that merely looks like them anywhere else.
func TestPageFurnitureLines(t *testing.T) {
	lines := []string{
		"FR",
		"CAG / CAM : contournement obligatoire.",
		"",
		"                                    FR",
		"                  Page 2/3",
		"                                  © SIA",
		"\fSUP AIP 012/26          Date de publication : 29 JAN 2026",
		"Page 2/3",
		"- les aéronefs basés.",
		"\fINFORMATION DES USAGERS",
	}
	want := []bool{false, false, false, true, true, true, true, false, false, false}
	if got := pageFurnitureLines(lines); !reflect.DeepEqual(got, want) {
		t.Errorf("pageFurnitureLines = %v, want %v", got, want)
	}
}

// A second heading ends the section it interrupts, set flush left as well as
// centred: each section is read on its own and the two publish as a union.
func TestPenetrationSecondHeadingEndsSection(t *testing.T) {
	layout := strings.Join([]string{
		"CONDITIONS DE PÉNÉTRATION",
		"ZRT ALPHA : contournement obligatoire.",
		"CONDITIONS DE PÉNÉTRATION",
		"ZIT BRAVO : pénétration interdite.",
		"",
		"",
		"                         SERVICES RENDUS",
	}, "\n")
	read := readPenetration(layout)
	if want := "ZRT ALPHA : contournement obligatoire.\n\nZIT BRAVO : pénétration interdite."; read.refused || read.text != want || read.kind != "forbidden" {
		t.Errorf("readPenetration = %+v, want the two sections published, forbidden", read)
	}
}

// A union too long for the panel is refused whole: past the cap, the text is
// read wrong somewhere, and a rule a pilot takes for the whole rule is the
// thing this reader exists not to publish.
func TestPenetrationTextCapRefused(t *testing.T) {
	var secs []string
	for z := 1; z <= 6; z++ {
		lines := []string{fmt.Sprintf("ZRT A%d : contournement obligatoire sauf pour :", z)}
		for i := 0; i < 70; i++ {
			lines = append(lines, fmt.Sprintf("- les aéronefs de l’escadrille %d-%d,", z, i))
		}
		secs = append(secs, penSec(lines...))
	}
	read := readPenetration(strings.Join(secs, "\n"))
	if !read.found || !read.refused || read.text != "" || read.kind != "circumvent" {
		t.Errorf("readPenetration = found %v refused %v kind %q, %d bytes of text; want refused, graded circumvent", read.found, read.refused, read.kind, len(read.text))
	}
}

// A rule ending on its zone's own name is closed, the name ending on a letter
// after a WORD as well as after a number: the corpus names 23 zones that way
// ("ZRT OLONNE A", "ZRT GERGOVIE A"). Read as the preposition, the suffix
// refused the section as cut open, or was cut off and named another zone.
func TestPenetrationEndsOnZoneName(t *testing.T) {
	last := "- les aéronefs en transit vers la ZRT OLONNE A."
	if read := readPenetration(penSec("CAG / CAM : contournement obligatoire sauf pour :", "- les aéronefs participant à l’exercice,", last)); read.refused {
		t.Errorf("rule ending on ZRT OLONNE A refused as cut open: %+v", read)
	}
	for _, s := range []string{"Contournement obligatoire de la ZRT GERGOVIE A", "PÉNÉTRATION INTERDITE DANS LA ZRT BAGOT A"} {
		if got := trimDanglingClause(s); got != s {
			t.Errorf("trimDanglingClause(%q) = %q, want it whole", s, got)
		}
	}
}

// What holds a clause open is found through the brackets and elisions around
// it, and a capital set for "à" after a time or a date is the preposition.
func TestDanglingConnectors(t *testing.T) {
	cases := []struct{ in, want string }{
		// An OPENING bracket leaves its connector open; a closing one is a
		// designation's.
		{"CAG/CAM : contournement obligatoire (sauf", "CAG/CAM : contournement obligatoire"},
		{"CAG / CAM : contournement obligatoire (à l’exception", "CAG / CAM : contournement obligatoire"},
		{"Contournement obligatoire de la zone (A)", "Contournement obligatoire de la zone (A)"},
		// Rules printed in capitals write "A" for "à".
		{"PÉNÉTRATION INTERDITE LE 14 JUILLET DE 0800 A", "PÉNÉTRATION INTERDITE LE 14 JUILLET DE 0800"},
		{"PÉNÉTRATION INTERDITE DU 12 A", "PÉNÉTRATION INTERDITE DU 12"},
		// An elision announces the word after it.
		{"CAG/CAM : contournement obligatoire de la surface jusqu’au", "CAG/CAM : contournement obligatoire de la surface"},
		{"CAG/CAM : contournement obligatoire de la surface jusqu'à", "CAG/CAM : contournement obligatoire de la surface"},
		{"CAG/CAM : contournement obligatoire, à l’", "CAG/CAM : contournement obligatoire"},
		{"CAG/CAM : contournement obligatoire lorsqu’", "CAG/CAM : contournement obligatoire"},
		// A word after an elision that holds nothing open stays.
		{"Contournement obligatoire de la zone d’Abbeville", "Contournement obligatoire de la zone d’Abbeville"},
	}
	for _, c := range cases {
		if got := trimDanglingClause(c.in); got != c.want {
			t.Errorf("trimDanglingClause(%q) = %q, want %q", c.in, got, c.want)
		}
		if open := c.in != c.want; endsOpen(c.in) != open {
			t.Errorf("endsOpen(%q) = %v, want %v", c.in, !open, open)
		}
	}
}

// A zone heading is a type followed by its designation, never a capitals
// WORD that happens to begin with a type: TRANSFERT, TRAFIC and TRANSIT once
// passed for TRA headings, and two sections naming no zone of their own
// published as a union.
func TestZoneHeadingNeedsADesignation(t *testing.T) {
	for _, s := range []string{"TRANSFERT", "TRAFIC CAG/CAM : CONTOURNEMENT OBLIGATOIRE", "TRANSIT : PÉNÉTRATION INTERDITE", "TRANSPONDEUR MODE S OBLIGATOIRE", "CBAS", "TSAR"} {
		if zoneHeading.MatchString(s) {
			t.Errorf("zoneHeading(%q) = true, want false", s)
		}
	}
	for _, s := range []string{"ZRT LIMA 1", "ZRT/ZDT BRAVO 1 et BRAVO 2 :", "ZIT PLUGUFFAN - ZIT HOURTIN", "ZRT 'Low' Coulommiers", "LF-R 45 A", "LF-R45", "TSA 43A", "- ZRT ALPHA :"} {
		if !zoneHeading.MatchString(s) {
			t.Errorf("zoneHeading(%q) = false, want true", s)
		}
	}
	a := penSec("TRAFIC CAG/CAM : CONTOURNEMENT OBLIGATOIRE SAUF POUR LES AÉRONEFS PARTICIPANT A L'EXERCICE.")
	b := penSec("TRAFIC CAG/CAM : CONTOURNEMENT OBLIGATOIRE SAUF POUR LES AÉRONEFS EN IFR AU DÉPART DE LAVAL ET DU MANS.")
	if read := readPenetration(a + "\n" + b); !read.refused {
		t.Errorf("two sections naming no zone published as a union: %+v", read)
	}
}

// Columns are measured on the printed line, before its ligatures are spelt
// out: each one left of a column boundary pushed that row's far side a
// column right ("ﬃ" two), and two rows whose left cells differ by four no
// longer lined up.
func TestPenetrationColumnsMeasuredAsPrinted(t *testing.T) {
	layout := penSec(
		"ZRT ALPHA : contournement obligatoire sauf pour les          ZIT BRAVO : pénétration interdite sauf",
		"aéronefs eﬀectuant des vols oﬃciels aﬁn de déﬁler.           autorisation de la C2A2.",
	)
	if read := readPenetration(layout); !read.refused || read.kind != "forbidden" {
		t.Errorf("two columns: %+v, want refused, forbidden", read)
	}
}

// On the native rows the text is the row carrying the verdict the kind
// states, never merely the first row that classifies: that stood a ZRT's
// circumvention under the ZIT's prohibition.
func TestParsePenetrationTextIsTheVerdict(t *testing.T) {
	rows := []prow{
		row(5, cell{0, "CONDITIONSDEPÉNÉTRATION"}),
		row(4, cell{0, "ZRTALPHA:CAG/CAM:contournementobligatoiresaufpour:"}),
		row(3, cell{0, "-lesaéronefsdel'exercice;"}),
		row(2, cell{0, "ZITBRAVO:pénétrationinterditeàtoutaéronef."}),
		row(1, cell{0, "SERVICES RENDUS"}),
	}
	got := parsePenetration(rows)
	if got == nil || got.kind != "forbidden" || got.text != "ZITBRAVO:pénétrationinterditeàtoutaéronef." {
		t.Errorf("parsePenetration = %+v, want forbidden over the ZIT's own row", got)
	}
}

// One blank line inside a paragraph ends a statement, whatever the width of
// the line before it: the CAG rule and the CAM rule stay two statements.
func TestPenetrationSingleBlankLineEndsStatement(t *testing.T) {
	read := readPenetration(penSec(
		"CAG : contournement obligatoire de la zone pendant toute la durée de l’activité publiée par NOTAM, sans exception,",
		"",
		"CAM : se conformer aux instructions de l’organisme de contrôle.",
	))
	want := "CAG : contournement obligatoire de la zone pendant toute la durée de l’activité publiée par NOTAM, sans exception,\n" +
		"CAM : se conformer aux instructions de l’organisme de contrôle."
	if read.refused || read.text != want {
		t.Errorf("text = %q (refused %v), want\n%q", read.text, read.refused, want)
	}
}
