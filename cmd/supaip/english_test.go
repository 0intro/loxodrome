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
