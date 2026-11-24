package main

import (
	"reflect"
	"testing"
)

// TestStatusIn: the statuses the supplements print, spaced as poppler
// reads them and jammed as the native reader does, an accent then U+FFFD.
func TestStatusIn(t *testing.T) {
	for _, c := range []struct {
		text string
		want status
	}{
		// 153/2026, 185/2026, 212/2025.
		{"- Du 01 septembre 2026 au 24 décembre 2026 Activable de SR à SS-1HR", status{mode: modeActivable}},
		{"Du14septembre2026au25septembre2026ActivabledeSS+30�SR-30", status{mode: modeActivable}},
		{"Possible activation H24", status{mode: modeActivable}},
		{"Activables selon protocole.", status{mode: modeActivable}},
		{"1 seule ZRT pourra être activée à la fois", status{mode: modeActivable}},
		// Activated for part of a stretch only (BLOIS's first bullet,
		// 066/2026, 2 créneaux in TestActivationsStretch).
		{"- Du 20 juillet 2026 au 28 août 2026 de 0500 à 0700 - (1 activation quotidienne au maximum)", status{mode: modeActivable}},
		{"(activable chaque jour 1h max dans le créneau)", status{mode: modeActivable}},
		{"(activations de 2 heures max, 9 activations prévues en tout)", status{mode: modeActivable}},
		// Held while another zone is (241/2026, 095/2026's neighbour).
		{"Active : 2200 - 0500 (ETE -1HR) lorsque la CTR de Villacoublay est désactivée.", status{mode: modeActivable}},
		// 020/2026, 018/2026, 061/2026, 030/2026, 021/2026.
		{"par NOTAM avec préavis à J-4", status{mode: modeNotam, noticeMin: 4 * 1440}},
		{"ActivableparNOTAMavecpr�avis�J-4", status{mode: modeNotam, noticeMin: 4 * 1440}},
		{"ZRT activable par NOTAM avec un préavis minimum de 48 heures : 2100-0500 (ETE : -1HR).", status{mode: modeNotam, noticeMin: 48 * 60}},
		{"ZRT ISV AMBERIEU LOW et MEDIUM activables par NOTAM à J-2", status{mode: modeNotam, noticeMin: 2 * 1440}},
		{"ZRT activables simultanément tous les jours : 0800-1800 par Notam à J-7", status{mode: modeNotam, noticeMin: 7 * 1440}},
		// A day count of one figure, the next word's joined to it once
		// folded (061/2026, 106/2026).
		{"ZRTPARASVAMBERIEULOWetMEDIUMactivablesparNOTAM\uFFFDJ-21sautsdeparachutistes", status{mode: modeNotam, noticeMin: 2 * 1440}},
		{"Pr\uFFFDvisiond'activationconnueaupr\uFFFDsdel'AirspaceManager\uFFFDJ-115h00Z", status{noticeMin: 1440}},
		{"ZRT activable : Publication d’un NOTAM d’activation avec un préavis de 10 jours", status{mode: modeNotam, noticeMin: 10 * 1440}},
		// Six hours, or J-1: the shorter bounds the trust.
		{"Activables par NOTAM avec un préavis de 6h00 lorsque les ZRT sont activées pour raison de sûreté et à J-1 ouvré", status{mode: modeNotam, noticeMin: 360}},
		// 110/2026: the confirmation comes by NOTAM.
		{"Lacon�\x01rmationd'activationouannulationseferaparlavoiedeNOTAM�J-1ouvr�.", status{mode: modeNotam, noticeMin: 1440}},
		// 222/2026: the confirmation alone, its ligature a control byte.
		{"Con\uFFFD\x01rmationparNOTAM\uFFFDJ-1ouvr\uFFFDavant1100UTC", status{mode: modeNotam, noticeMin: 1440}},
		// 101/2026: activable within 30 minutes beside the NOTAM's J-1, a way
		// of its own, and 053/2026's protocol beside its NOTAM.
		{"Zones activables H24, avec un préavis de 30 minutes. Zones activables par NOTAM à J-1", status{mode: modeActivable, noticeMin: 30}},
		{"Activables selon protocole. Activables par NOTAM avec un préavis de 6h00", status{mode: modeActivable, noticeMin: 360}},
		// 005/2026: the NOTAM announces the forecast, a unit the real
		// activity, half an hour ahead.
		{"- ZRT activable H24 du mardi au jeudi, hors jours fériés ; - prévision d’activation annoncée par NOTAM avec un préavis de 24 heures ; - activité réelle annoncée avec un préavis de 30 minutes.", status{mode: modeActivable, noticeMin: 30}},
		// 142/2026: active days, and activable ones.
		{"ZIT CONCORDE, ZRT 1 et ZRT 2 actives les 09, 10 et 13", status{mode: modeFirm}},
		{"ZITCONCORDE,ZRT1etZRT2activesles09,10et13", status{mode: modeFirm}},
		{"ZRT 3, 4 et 5 activables les 09, 10 et 13", status{mode: modeActivable}},
		// A crane a NOTAM publishes, the RTBA's word for inactive, and a
		// notice alone.
		{"Présence de 2 grues fixe à tour : H24 7j/7, publiées par NOTAM obstacle.", status{}},
		{"ZRT inactives les 5, 6 et 10 juin", status{}},
		{"Activation des ZIT PLUGUFFAN et ZRT BISCARROSSE avec préavis de 48h:", status{noticeMin: 48 * 60}},
		{"- Du 02 mars 2026 au 27 mars 2026 de 0800 à 1700", status{}},
	} {
		if got := statusIn(c.text); got != c.want {
			t.Errorf("statusIn(%q) = %+v, want %+v", c.text, got, c.want)
		}
	}
}

// TestActivationsModes: whole sections, each period taking the status its
// own rows print, else its heading's or its section's, and firm where the
// section tells its periods apart.
func TestActivationsModes(t *testing.T) {
	for _, c := range []struct {
		name  string
		rows  []string
		zones map[string][]status
	}{
		{"153/2026", []string{
			"ZRT BLOIS",
			"- Du 20 juillet 2026 au 28 août 2026 de 0500 à 0700 tous les jours sauf Samedi, Dimanche et jours fériés - (1",
			"activation quotidienne au maximum)",
			"- Du 01 septembre 2026 au 24 décembre 2026 Activable de SR à SS-1HR - (activations de 2 heures max, 9",
			"activations prévues en tout)",
		}, map[string][]status{"ZRT BLOIS": {activable, activable}}},
		{"185/2026", []string{
			"ZRT ACTIVABLE",
			"1 seule ZRT pourra être activée à la fois",
			"TOUTES LES ZONES",
			"- Du 14 septembre 2026 au 25 septembre 2026 Activable de SS+30 à SR-30",
			"- Du 12 octobre 2026 au 23 octobre 2026 Activable de SS+30 à SR-30",
		}, map[string][]status{"ZRT ALLEVARD": {activable, activable}}},
		{"020/2026", []string{
			"ZRT AUCH-LECTOURE / ZRT AUCH-NOGARO / ZRT AUCH SUD",
			"Du 02 mars 2026 au 27 mars 2026 de 0800 à 1700 tous les jours sauf Samedi, Dimanche et jours fériés Activable",
			"par NOTAM avec préavis à J-4",
			"Du 30 mars 2026 au 11 septembre 2026 de 0800 à 1900 tous les jours sauf Samedi, Dimanche et jours fériés",
			"Activable par NOTAM avec préavis à J-4",
		}, map[string][]status{"ZRT AUCH SUD": {byNotam(4 * 1440), byNotam(4 * 1440)}}},
		{"074/2026", []string{
			"ZRT AUBIAT-SARDON 1",
			"- Du 04 mai 2026 à 0700 au 23 octobre 2026 à 1800 - Activable LUN-VEN sauf JF entre 0700 et 1800",
			"ZRT AUBIAT-SARDON 2",
			"- Du 01 mai 2026 au 30 avril 2027 H24 - Activable par NOTAM",
		}, map[string][]status{"ZRT AUBIAT-SARDON 1": {activable}, "ZRT AUBIAT-SARDON 2": {byNotam(0)}}},
		{"201/2026", []string{
			"ZRT TOLL ALPHA",
			"- Le 25 septembre 2026",
			"- Activable de 0700 à 1100",
			"- Activable de 1600 à 2200",
		}, map[string][]status{"ZRT TOLL ALPHA": {activable, activable}}},
		// A status wrapped onto the row after its bullet's separator, spaced
		// as poppler reads it and jammed as the native reader does.
		{"111/2026", []string{
			"ZRT FIRMINY",
			"- Du 08 juin 2026 au 23 octobre 2026 de 0630 à 1630 tous les jours sauf Samedi, Dimanche et jours fériés - ZRT",
			"activable",
			"- Du 26 octobre 2026 au 31 décembre 2026 de 0730 à 1730 tous les jours sauf Samedi, Dimanche et jours fériés -",
			"ZRT activable",
		}, map[string][]status{"ZRT FIRMINY": {activable, activable}}},
		{"111/2026 jammed", []string{
			"ZRTFIRMINY",
			"- Du08juin2026au23octobre2026de0630\uFFFD1630 touslesjourssaufSamedi,Dimancheetjoursf\uFFFDri\uFFFDs - ZRT",
			"activable",
			"- Du26octobre2026au31d\uFFFDcembre2026de0730\uFFFD1730 touslesjourssaufSamedi,Dimancheetjoursf\uFFFDri\uFFFDs -",
			"ZRTactivable",
		}, map[string][]status{"ZRT FIRMINY": {activable, activable}}},
		// The firm periods of a section telling its periods apart.
		{"a firm bullet beside an activable one", []string{
			"ZRT X",
			"- Du 02 mars 2026 au 27 mars 2026 de 0800 à 1700",
			"- Du 30 mars 2026 au 11 septembre 2026 de 0800 à 1900 - Activable",
		}, map[string][]status{"ZRT X": {{}, activable}}},
		// A row after a bullet is that bullet's, as 020/2026 prints its second
		// status, so a remark after the last bullet is the last bullet's, and
		// a bullet before it saying nothing stays firm.
		{"a remark after the last bullet", []string{
			"ZRT X",
			"- Le 02 mars 2026 de 0800 à 1700",
			"- Le 03 mars 2026 de 0800 à 1700",
			"Ces créneaux sont activables par NOTAM avec un préavis de 24 heures.",
		}, map[string][]status{"ZRT X": {{}, byNotam(1440)}}},
		// A remark no bullet takes reaches every bullet of a section whose
		// bullets say nothing of their own: here a deactivation note closes
		// the last bullet before it.
		{"a remark for the whole section", []string{
			"ZRT X",
			"- Le 02 mars 2026 de 0800 à 1700",
			"- Le 03 mars 2026 de 0800 à 1700",
			"- Le 04 mars 2026 inactif",
			"Ces créneaux sont activables par NOTAM avec un préavis de 24 heures.",
		}, map[string][]status{"ZRT X": {byNotam(1440), byNotam(1440)}}},
	} {
		rows := []prow{row(100, cell{0, "DATES ET HEURES D'ACTIVITÉ"})}
		for i, text := range c.rows {
			rows = append(rows, row(float64(99-i), cell{0, text}))
		}
		rows = append(rows, row(10, cell{0, "INFORMATION DES USAGERS"}))
		var zones []zone
		for n := range c.zones {
			zones = append(zones, zone{name: n})
		}
		named, unnamed := parseActivations(rows)
		attachActivations(zones, named, unnamed)
		for n, want := range c.zones {
			var got []status
			for _, a := range actsFor(zones, n) {
				got = append(got, a.status)
			}
			if !reflect.DeepEqual(got, want) {
				t.Errorf("%s: %s statuses = %+v, want %+v", c.name, n, got, want)
			}
		}
	}
}

// TestStatedStatuses: a sentence outside the schedule says a zone it names
// may be activated, and the zone's firm periods take its status: 162/2026
// prints SOTAME BRAVO's "H24" bare and its restriction in its DISPOSITIONS
// COMPLEMENTAIRES, here as the native reader rebuilds them.
func TestStatedStatuses(t *testing.T) {
	rows := []prow{}
	for i, text := range []string{
		"DATESETHEURESD'ACTIVIT\uFFFD",
		"ZRTSOTAMEALPHA",
		"- Du06ao\uFFFDt2026au12mai2027H24 ActivableparNOTAMavecpr\uFFFDavisde72h",
		"ZRTSOTAMEBRAVO",
		"- Du06ao\uFFFDt2026au12mai2027H24",
		"INFORMATIONDESUSAGERS",
		"DISPOSITIONSCOMPLEMENTAIRES",
		"Restrictionsd\x19activationdesZRTSOTAME:",
		"Cr\uFFFDneauxde2h,15\uFFFD20activationsparanleweek-end",
		"LaZRTSOTAMEBRAVOestactivableavecunpr\uFFFDavisd\x19uneheure,uniquementlorsquelaZRTSOTAMEALPHA",
		"estactive,etencasden\uFFFDcessit\uFFFDpourrejoindrelaZRT260LOWpubli\uFFFDeparSUPAIP065/25.",
	} {
		rows = append(rows, row(float64(100-i), cell{0, text}))
	}
	zones := []zone{{name: "ZRT SOTAME BRAVO"}, {name: "ZRT TEMOIN"}}
	named, unnamed := parseActivations(rows)
	attachActivations(zones, named, unnamed)
	want := []activation{{date: "2026-08-06", dateTo: "2027-05-12", status: status{mode: modeActivable, noticeMin: 60}}}
	if got := actsFor(zones, "ZRT SOTAME BRAVO"); !reflect.DeepEqual(got, want) {
		t.Errorf("ZRT SOTAME BRAVO = %+v, want %+v", got, want)
	}
	// A zone no sentence names keeps the schedule it reads.
	if got := actsFor(zones, "ZRT TEMOIN"); len(got) != 0 {
		t.Errorf("ZRT TEMOIN = %+v, want none", got)
	}
}
