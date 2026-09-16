package main

import (
	"reflect"
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
	if res.penetration.kind != "circumvent" || res.penetration.text != "" {
		t.Errorf("penetration = %+v, want kind kept and text blanked", res.penetration)
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
