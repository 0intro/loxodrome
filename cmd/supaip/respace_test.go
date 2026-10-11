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
		"                ZIT CONCORDE                 ZRT 'FIRMINY'\n"
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
