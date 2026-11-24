package main

import "testing"

func TestRespaceName(t *testing.T) {
	// A scrap of pdftotext -layout output: properly spaced, wide gaps, quotes.
	layout := "        \"Baie de Somme Sud\" Tempo          \"Baie de Somme Nord\" Tempo\n" +
		"   Les zones ZRT/ZDT RADE DE CAPELLE et ZRT 108 E4 sont actives.\n" +
		"        LF-R17 A tempo « AVEL »                 LF-R17 C tempo « CORSEN »\n" +
		"   Les zones (ZRT) « AUBIAT-SARDON 1 and 2 » sont créées.\n" +
		"   Cinq zones réglementées (ZRT 7, 8 et 9) sont mises en œuvre.\n" +
		"                ZRT 7                  ZRT 8                  ZRT 9\n" +
		// The "Objet" sentence, where the SIA parenthesises the zone it is
		// creating. It precedes the table that names the zone plainly, so it is
		// the occurrence the alphanumeric search lands on.
		"A l'occasion des cérémonies du 14 juillet,une zone interdite (ZIT CONCORDE) et cinq zones\n" +
		"   Création d'une Zone Réglementée Temporaire (ZRT) 'FIRMINY' au profit de vols\n" +
		"Objet :   Création d'une zone interdite temporaire (ZIT) ORANGE (84)\n" +
		"                ZIT CONCORDE                 ZRT 'FIRMINY'\n" +
		// Accented letters at a name's ends, which the alphanumeric search
		// drops (232/2026, 186/2026, 053/2026).
		"   ZRT CHARITÉ             Responsable d’activité : 07 59 67 03 86\n" +
		// A unit's note in the radio table (001/2026).
		"Brest CTL :                   fréquences de contrôle\n" +
		"BORDEAUX ACC :                      Fréquences de contrôle\n" +
		"   Élément Air de Contrôle de l'Aéroport Paris CDG (EACA)\n"
	norm, pos := normWithIndex(layout)
	cases := []struct {
		jammed, want string
	}{
		// space-jammed -> spaced, with the surrounding quotes re-attached
		{`"Baiede Somme Sud"Tempo`, `"Baie de Somme Sud" Tempo`},
		{`ZRT/ZDTRADEDECAPELLE`, `ZRT/ZDT RADE DE CAPELLE`},
		// trailing closing guillemet (multi-byte, space-separated) re-attached
		{`LF-R17Atempo«AVEL»`, `LF-R17 A tempo « AVEL »`},
		// a jammed name that does open on a ( keeps it, and a zone sliced from a
		// "« A and B »" group label drops its orphan «. The jammed form here is
		// synthetic: 074/2026's own cell reads ZRT AUBIAT-SARDON 1, so this
		// pins the pass-through branch rather than that supplement's name.
		{`(ZRT)«AUBIAT-SARDON1`, `(ZRT) AUBIAT-SARDON 1`},
		// no leading mark in the jammed name means no absorption, however the
		// occurrence the search lands on is punctuated: the first mention of
		// these is the parenthesised list "(ZRT 7, 8 et 9)", and the Objet
		// sentence for the three below (142/2026, 111/2026, 013/2026)
		{`ZRT7`, `ZRT 7`},
		{`ZITCONCORDE`, `ZIT CONCORDE`},
		{`ZRTFIRMINY`, `ZRT 'FIRMINY'`},
		// the ) of the "(ZIT)" prefix goes, the (84) it never opened is closed
		// past the span's end and stays: pairing must be positional, so this is
		// the case that fails if leadMark lands without it
		{`ZITORANGE(84)`, `ZIT ORANGE (84)`},
		// the accented letters at the ends come back with the span
		{"ZRTCHARIT\uFFFD", `ZRT CHARITÉ`},
		{"Responsabled’activit\uFFFD", `Responsable d’activité`},
		{"\uFFFDl\uFFFDmentAirdeContr\uFFFDle", `Élément Air de Contrôle`},
		// A note is matched case-folded like a name, so it takes the casing
		// of the first line printing it.
		{"fréquencesdecontrôle", `fréquences de contrôle`},
		{"Fréquencesdecontrôle", `fréquences de contrôle`},
		{`ZRT 108 E4`, `ZRT 108 E4`}, // already spaced -> unchanged
		{`ZRT INCONNU`, ``},          // absent -> empty (keep prettifyName)
		{`AB`, ``},                   // too short to match safely
	}
	for _, c := range cases {
		if got := respaceName(c.jammed, layout, norm, pos); got != c.want {
			t.Errorf("respaceName(%q) = %q, want %q", c.jammed, got, c.want)
		}
	}
}

func TestDropOrphanMarks(t *testing.T) {
	cases := map[string]string{
		// Pairing is positional, not by count: this span holds one ( and one )
		// and only the inner pair is real (013/2026).
		`ZIT) ORANGE (84)`: `ZIT ORANGE (84)`,
		`(ZRT 7`:           `ZRT 7`,
		`ZRT) 'FIRMINY'`:   `ZRT 'FIRMINY'`,
		// Marks that pair are part of the name.
		`« A » et « B »`:        `« A » et « B »`,
		`(ZRT) AUBIAT-SARDON 1`: `(ZRT) AUBIAT-SARDON 1`,
		// A French name's own apostrophe is never a mark to balance.
		`ZRT LA GRAND'COMBE ALPHA`: `ZRT LA GRAND'COMBE ALPHA`,
	}
	for in, want := range cases {
		if got := dropOrphanMarks(in); got != want {
			t.Errorf("dropOrphanMarks(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestRespaceContacts(t *testing.T) {
	// 001/2026's radio table, as pdftotext -layout prints it.
	layout := "Brest CTL :                   fréquences de contrôle\n" +
		"MARINA (CDC de Mont de Marsan) : 143.550 MHz / 317.500 MHz\n"
	norm, pos := normWithIndex(layout)
	respace := func(s string) string {
		if r := respaceName(s, layout, norm, pos); r != "" {
			return r
		}
		return s
	}
	cs := []contactFreq{
		{unit: "BrestCTL", note: "fréquencesdecontrôle"},
		{unit: "MARINA(CDCdeMontdeMarsan)", freqs: []string{"143.550", "317.500"}},
	}
	respaceContacts(cs, respace)
	if cs[0].unit != "Brest CTL" || cs[0].note != "fréquences de contrôle" {
		t.Errorf("contact 0 = %q, %q, want Brest CTL, fréquences de contrôle", cs[0].unit, cs[0].note)
	}
	if cs[1].unit != "MARINA (CDC de Mont de Marsan)" || cs[1].note != "" {
		t.Errorf("contact 1 = %q, %q, want MARINA (CDC de Mont de Marsan) and no note", cs[1].unit, cs[1].note)
	}
}
