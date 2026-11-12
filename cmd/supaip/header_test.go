package main

import "testing"

func TestValidityFromText(t *testing.T) {
	cases := []struct {
		name, text, from, to string
	}{
		{
			// The start year is omitted whenever both ends share it, which is
			// why the end has to be parsed first.
			name: "start year omitted",
			text: "En vigueur :        Du lundi 20 juillet au vendredi 31 juillet 2026",
			from: "2026-07-20", to: "2026-07-31",
		},
		{
			name: "both years stated",
			text: "En vigueur :        Du jeudi 09 juillet 2026 au samedi 01 mai 2027",
			from: "2026-07-09", to: "2027-05-01",
		},
		{
			name: "no weekday, no leading zero",
			text: "En vigueur : Du 7 août 2025 au 31 juillet 2026",
			from: "2025-08-07", to: "2026-07-31",
		},
		{
			// The SIA fonts leave unmapped accents as U+FFFD; frDateRe already
			// tolerates it, and the validity line is no different.
			name: "accents garbled to U+FFFD",
			text: "En vigueur : Du 14 f�vrier 2026 au 3 d�cembre 2026",
			from: "2026-02-14", to: "2026-12-03",
		},
		{
			name: "the label may repeat elsewhere on the page",
			text: "SUP AIP 142/26\nObjet : quelque chose\nEn vigueur :   Du jeudi 09 juillet au mardi 14 juillet 2026\nLieux : FIR PARIS",
			from: "2026-07-09", to: "2026-07-14",
		},
		{
			// A single day opens and closes on itself.
			name: "single day",
			text: "En vigueur :      Le jeudi 09 juillet 2026",
			from: "2026-07-09", to: "2026-07-09",
		},
		{
			// The start states a bare day and takes the month and year from
			// the end.
			name: "bare start day",
			text: "En vigueur : Du 03 au 05 février 2026",
			from: "2026-02-03", to: "2026-02-05",
		},
		{
			name: "ordinal first of the month",
			text: "En vigueur : Du 23 février au 1er mars 2026",
			from: "2026-02-23", to: "2026-03-01",
		},
		{name: "absent", text: "SUP AIP 142/26\nObjet : rien", from: "", to: ""},
		{
			// "Du <date>" with no end reads as that single day rather than as
			// nothing, which is what the single-day grammar already means.
			name: "one date only",
			text: "En vigueur : Du 9 juillet 2026",
			from: "2026-07-09", to: "2026-07-09",
		},
	}
	for _, c := range cases {
		from, to := validityFromText(c.text)
		if from != c.from || to != c.to {
			t.Errorf("%s: got %q..%q, want %q..%q", c.name, from, to, c.from, c.to)
		}
	}
}

func TestSubjectForLabelFrench(t *testing.T) {
	// The 142/26 cover page: the value wraps above and below its own label,
	// which floats at the block's vertical centre.
	const page = `                                             SUP AIP 142/26
                                       Date de publication : 18 JUN 2026

           Création d’une zone interdite temporaire (ZIT) et de cinq zones réglementées temporaires
Objet :    (ZRT) pour le dispositif de sûreté aérienne et le défilé aérien liés aux cérémonies du 14
           juillet 2026 à Paris.

En vigueur :   Du jeudi 09 juillet au mardi 14 juillet 2026
`
	want := "Création d’une zone interdite temporaire (ZIT) et de cinq zones réglementées temporaires " +
		"(ZRT) pour le dispositif de sûreté aérienne et le défilé aérien liés aux cérémonies du 14 " +
		"juillet 2026 à Paris."
	if got := subjectForLabel(page, "Objet"); got != want {
		t.Errorf("subjectForLabel:\n got  %q\n want %q", got, want)
	}
	// The English gather is the same code and must keep working.
	if got := subjectForLabel("Subject :   A temporary restricted area", "Subject"); got != "A temporary restricted area" {
		t.Errorf("English label: got %q", got)
	}
}
