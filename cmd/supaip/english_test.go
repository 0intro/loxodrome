package main

import "testing"

func TestSubjectFromText(t *testing.T) {
	cases := []struct {
		name string
		text string
		want string
	}{
		{
			// Value on the same line as the label (079/2026 template).
			name: "same line",
			text: "AIP SUP 079/26\nInternet : www.sia.aviation-civile.gouv.fr\n\n" +
				"Subject :          Creation of one Temporary Prohibited Area (ZIT) over the city of Cannes\n\n" +
				"With effect : From Tuesday 12th May to Sunday 24th May 2026\n",
			want: "Creation of one Temporary Prohibited Area (ZIT) over the city of Cannes",
		},
		{
			// Value wraps above and below the floating label (057/2025 template).
			name: "wrapped around label",
			text: "AIP SUP 057/25\nInternet : www.sia.aviation-civile.gouv.fr\n\n" +
				"               Creation of 2 Temporary Restricted Areas (ZRT) for out-of-sight\n" +
				" Subject :\n" +
				"               flights in the Aigueperse sector (63)\n" +
				" With effect : From Thursday 1st May 2025\n",
			want: "Creation of 2 Temporary Restricted Areas (ZRT) for out-of-sight flights in the Aigueperse sector (63)",
		},
		{
			// ff ligature is restored.
			name: "ligature",
			text: "Subject :   Traﬃc study\n\nWith eﬀect : now\n",
			want: "Traffic study",
		},
		{
			// Bare template: no colon anywhere, the head alone on its line and
			// the next field under it (147/2025). The colon-seeking bound
			// cannot see "With effect" and used to glue the validity on.
			name: "bare head, value wrapped around it",
			text: "                                        AIP SUP 147/25\n" +
				"                                Publication date : 21 AUG 2025\n" +
				"                  Internet : www.sia.aviation-civile.gouv.fr\n" +
				"\n" +
				"              Creation of 2 Temporary Restricted Areas (ZRT) for specific activities in the vicinity of the\n" +
				"  Subject\n" +
				"              Coulommiers Voisins airfield (77) - LFPK\n" +
				"  With effect From 04th September 2025 to 25th November 2026\n" +
				"\n" +
				"Location : FIR : Paris LFFF - AD : Coulommiers Voisins LFPK\n",
			want: "Creation of 2 Temporary Restricted Areas (ZRT) for specific activities " +
				"in the vicinity of the Coulommiers Voisins airfield (77) - LFPK",
		},
		{
			// "Object", the word-for-word rendering of the French "Objet"
			// (159/2025): the one supplement in the corpus that does not say
			// "Subject", and the one row that carried no English subject.
			name: "Object head",
			text: "                                        AIP SUP 159/25\n" +
				"                  Email    : sia-qualite@aviation-civile.gouv.fr\n" +
				"                                Publication date: 04 SEP 2025\n" +
				"                  Internet : www.sia.aviation-civile.gouv.fr\n" +
				"\n" +
				"Object         : Creation of 3 temporary restricted areas (ZRT) in the Saint-Dizier region (52) on an experimental basis\n" +
				"Validity       : From Monday 22nd September 2025 to Wednesday 14th April 2027\n",
			want: "Creation of 3 temporary restricted areas (ZRT) in the Saint-Dizier region (52) on an experimental basis",
		},
		{
			// A sentence that merely contains the word is not the field, which
			// is what the fallback to "Object" turns on.
			name: "prose is not a head",
			text: "AIP SUP 001/26\n" +
				"The Object of this supplement is to inform crews.\n" +
				"Objective : none\n",
			want: "",
		},
		{
			// "Subject" is tried first, so a stray line further down cannot
			// take the field from a head that already read.
			name: "Subject outranks a later Object line",
			text: "Subject :   Creation of one Temporary Restricted Area (ZRT)\n" +
				"\n" +
				"Object of the exercise stated overleaf\n",
			want: "Creation of one Temporary Restricted Area (ZRT)",
		},
		{
			name: "no subject",
			text: "AIP SUP 001/26\nSome other text\n",
			want: "",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := subjectFromText(c.text); got != c.want {
				t.Errorf("subjectFromText = %q, want %q", got, c.want)
			}
		})
	}
}

// The French cover page reads through the same gather (header.go), and
// 009/2026 wraps its subject back to the head's OWN column under an ordinary
// "Objet :". Bounding every template by the column would cut the aerodrome's
// name off the end of it, which is why only a bare head takes that bound.
func TestSubjectForLabelFrenchWrapAtHeadColumn(t *testing.T) {
	text := "                                        SUP AIP 009/26\n" +
		"                                Date de publication : 08 JAN 2026\n" +
		"                  Internet : www.sia.aviation-civile.gouv.fr\n" +
		"\n" +
		" Objet : Exp\u00e9rimentation d\u2019itin\u00e9raires de vol VFR de nuit au d\u00e9part et \u00e0 l\u2019arriv\u00e9e des pistes de l\u2019a\u00e9rodrome de\n" +
		" Paris-Saclay-Versailles (ex Toussus-le-Noble) - LFPN\n" +
		" En vigueur : Du 15 janvier 2026 au 15 avril 2026\n" +
		"Lieu : FIR Paris LFFF - AD : Paris-Saclay-Versailles (ex Toussus le Noble) LFPN\n"
	want := "Exp\u00e9rimentation d\u2019itin\u00e9raires de vol VFR de nuit au d\u00e9part et \u00e0 l\u2019arriv\u00e9e " +
		"des pistes de l\u2019a\u00e9rodrome de Paris-Saclay-Versailles (ex Toussus-le-Noble) - LFPN"
	if got := subjectForLabel(text, "Objet"); got != want {
		t.Errorf("subjectForLabel(Objet) = %q, want %q", got, want)
	}
}
