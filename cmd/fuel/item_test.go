package main

import "testing"

// The plates print their services as a fixed numbered list, and item 10 is
// the fuel. These are the shapes the corpus actually has.
func TestAvtItem(t *testing.T) {
	cases := []struct {
		name string
		page string
		body string
		end  itemEnd
		ok   bool
	}{
		{
			name: "the commonest form, ended by the next item",
			page: "  9 - Douanes : NIL.\n  10 - AVT : Carburant / Fuel : 100 LL.\n  11 - RFFS : Niveau 1 / Level 1.\n",
			body: "Carburant / Fuel : 100 LL.",
			end:  endNextItem,
			ok:   true,
		},
		{
			// The change-bar arrow the SIA prints beside an amended line,
			// and a plate that omits the colon after AVT.
			name: "an amended line with no colon",
			page: "← 10 - AVT Carburant / Fuel : 100 LL.\n  11 - RFFS : Niveau 1.\n",
			body: "Carburant / Fuel : 100 LL.",
			end:  endNextItem,
			ok:   true,
		},
		{
			// Florac's entry sits at the foot of a page and the next item
			// resumes overleaf, with the footer and the next header between.
			// The reader stops at the furniture and says that it did.
			name: "cut by a page break",
			page: "10 - AVT : NIL.\n\nAMDT 04/22    © Service de l'Information Aéronautique, France\n" +
				"  AIP FRANCE                        AD 2 LFNO TXT 02\n  11 - RFFS : Niveau 1.\n",
			body: "NIL.",
			end:  endPage,
			ok:   true,
		},
		{
			// Several lines, glued with the AIP's own separator.
			name: "a multi-line entry",
			page: "10 - AVT : Carburants / Fuel : 100 LL - JET A1.\n     Paiement / Payment : Carte TOTAL.\n11 - RFFS : Niveau 2.\n",
			body: "Carburants / Fuel : 100 LL - JET A1.#Paiement / Payment : Carte TOTAL.",
			end:  endNextItem,
			ok:   true,
		},
		{
			// Le Havre's plate of 2026-10-01: an item above withdrawn, the
			// fuel is item 9 and the fire service item 10.
			name: "a renumbered list",
			page: "  8 - Hangars : OUI.\n\u2190 9 - AVT : JET A1 : HOR RFFS niveau 2.\n     AVGAS 100LL : Automate H24.\n  10 - RFFS : Niveau 2.\n",
			body: "JET A1 : HOR RFFS niveau 2.#AVGAS 100LL : Automate H24.",
			end:  endNextItem,
			ok:   true,
		},
		{
			// A numbered line inside the entry is the entry's own.
			name: "a numbered line inside the entry",
			page: "10 - AVT : Carburants / Fuel :\n 1 - JET A1 : camion.\n 2 - AVGAS 100LL : pompe.\n11 - RFFS : Niveau 1.\n",
			body: "Carburants / Fuel :#1 - JET A1 : camion.#2 - AVGAS 100LL : pompe.",
			end:  endNextItem,
			ok:   true,
		},
		{
			// A helistation plate's own list, its second column running on
			// beside the entry: not the aerodrome list's item.
			name: "a helistation list",
			page: "3 - AVT : NIL                    8 - Type de surface / Surface : Aluminium\n4 - RFFS : Extincteurs\n",
			ok:   false,
		},
		{
			// The two naval air stations publish no numbered list at all.
			name: "no such item",
			page: "AD 2 LFRJ TXT 01\nLANDIVISIAU\nNothing numbered here.\n",
			ok:   false,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			body, end, ok := avtItem(c.page)
			if ok != c.ok {
				t.Fatalf("ok = %v, want %v", ok, c.ok)
			}
			if !ok {
				return
			}
			if body != c.body {
				t.Errorf("body\n got %q\nwant %q", body, c.body)
			}
			if end != c.end {
				t.Errorf("end = %q, want %q", end, c.end)
			}
		})
	}
}

// A glyph the extractor cannot resolve comes back as a control byte or a
// private-use code point, in the middle of the AIP's own words.
func TestCleanDropsUnmappedGlyphs(t *testing.T) {
	if got := clean("C \aarburants"); got != "C arburants" {
		t.Errorf("clean = %q", got)
	}
	if got := clean("SCALP Card  05 58"); got != "SCALP Card 05 58" {
		t.Errorf("clean = %q", got)
	}
	if got := clean("100 LL� JET A1"); got != "100 LL JET A1" {
		t.Errorf("clean = %q", got)
	}
	// Dax carries a U+F028 in the middle of a telephone number.
	if got := clean("Card  05 58"); got != "Card 05 58" {
		t.Errorf("clean = %q", got)
	}
	// The AIP's own line separator is not whitespace and survives.
	if got := clean("a#b"); got != "a#b" {
		t.Errorf("clean = %q", got)
	}
}
