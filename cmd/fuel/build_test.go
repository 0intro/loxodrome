package main

import (
	"testing"
	"time"

	"github.com/0intro/loxodrome/internal/fuel"
)

// A merged row shows every chip over the words that state it. Toussus's
// plate names 100LL and Jet A-1, and its AD 2.4 entry names UL Aero Super+
// as well (AIRAC 2026-10-29): the union offers all three, so the AD 2.4
// words travel with the row.
func TestMergeKeepsTheWordsOfEveryChip(t *testing.T) {
	plate := "Carburants / Fuel : 100 LL - JET A1.#0600-2000."
	ad24 := `Carburants : 100 LL - JET A1 - JET SAF - UL AERO SUPER +#0600-2000.\\Fuel : 100 LL - JET A1 - JET SAF - UL AERO SUPER +`
	rows := mergeSources([]plateItem{{Ident: "LFPN", Body: plate}}, []aixmItem{{Ident: "LFPN", Avail: "yes", Body: ad24}})
	if len(rows) != 1 || rows[0].src != "both" || !rows[0].st.Has(fuel.GradeSuper) {
		t.Fatalf("rows = %+v, want one row from both sources with SUPER AERO+", rows)
	}
	if r := rows[0]; r.st.Text != plate || r.aipText != ad24 {
		t.Errorf("text %q, aipText %q, want the plate's words and the AD 2.4's", r.st.Text, r.aipText)
	}

	cases := []struct {
		name, plate, ad24 string
		want              bool
	}{
		{"the two agree", "Carburant / Fuel : 100 LL.", "Carburant : 100LL", false},
		{"the plate says more", "Carburant / Fuel : 100 LL - JET A1. H24.", "Carburant : 100LL", false},
		{"the AD 2.4 names a condition", "Carburant / Fuel : 100 LL.", "Carburant : 100LL#H24", true},
		{"the plate names no grade", "H24 7/7 via My Handling PPR PN 24HR.", "Carburants : 100LL - JET A1", true},
	}
	for _, c := range cases {
		rows := mergeSources([]plateItem{{Ident: "LFOT", Body: c.plate}}, []aixmItem{{Ident: "LFOT", Avail: "yes", Body: c.ad24}})
		if got := rows[0].aipText != ""; got != c.want {
			t.Errorf("%s: aipText %q, want it carried %v", c.name, rows[0].aipText, c.want)
		}
	}

	// A helistation sheet naming more than the aerodrome sheet joins its
	// words to the aerodrome sheet's.
	rows = mergeSources([]plateItem{
		{Ident: "LFXX", Body: "Carburant / Fuel : 100 LL."},
		{Ident: "LFXX", Body: "Carburant / Fuel : JET A1."},
	}, nil)
	if r := rows[0]; r.st.Text != "Carburant / Fuel : 100 LL.#Carburant / Fuel : JET A1." {
		t.Errorf("text %q, want both sheets' words", r.st.Text)
	}

	art, _ := buildArtifact(rows, plateStats{}, time.Now(), "", "", "")
	if n := len(art.Fields); n != 7 || art.Fields[6] != "aipText" {
		t.Fatalf("fields = %q, want aipText seventh", art.Fields)
	}
	if r := art.Rows[0].([]any); len(r) != len(art.Fields) || r[6] != "" {
		t.Errorf("row = %q, want %d columns, aipText empty", r, len(art.Fields))
	}
}
