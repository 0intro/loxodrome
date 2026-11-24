package main

import (
	"reflect"
	"testing"
)

// TestActivationsStanding: the schedules that print no dates, rows as
// poppler reads them. Each is a standing rule of its zones, held over the
// validity, with its hours, its day rule, its status and its season note.
func TestActivationsStanding(t *testing.T) {
	weekdaysOff := dayRule{days: 1<<1 | 1<<2 | 1<<3 | 1<<4 | 1<<5, exceptHolidays: true}
	for _, c := range []struct {
		name  string
		rows  []string
		zones []string
		want  map[string][]activation
	}{
		{"191/2025, a zone line", []string{
			"ZRT activable par NOTAM avec un préavis minimum de 48 heures : 2030-0530 (ETE : -1HR).",
		}, []string{"ZRT DRONE COUBERT"}, map[string][]activation{
			"ZRT DRONE COUBERT": {{from: "20:30", to: "05:30", status: byNotam(48 * 60), season: summerEarlier}},
		}},
		{"088/2025, a weekly stretch", []string{
			"ZRT activables par NOTAM à J-7, du LUN 0500 au VEN 1100 sauf jours fériés. (SUM-1HR)",
		}, []string{"ZRT A"}, map[string][]activation{
			"ZRT A": {
				{from: "05:00", to: "24:00", dayRule: dayRule{days: 1 << 1, exceptHolidays: true}, status: byNotam(7 * 1440), season: summerEarlier, cuts: cutClose},
				{dayRule: dayRule{days: 1<<2 | 1<<3 | 1<<4, exceptHolidays: true}, status: byNotam(7 * 1440), season: summerEarlier, cuts: cutOpen | cutClose},
				{from: "00:00", to: "11:00", dayRule: dayRule{days: 1 << 5, exceptHolidays: true}, status: byNotam(7 * 1440), season: summerEarlier, cuts: cutOpen},
			},
		}},
		{"013/2026, H24", []string{"H24"}, []string{"ZRT A"}, map[string][]activation{
			"ZRT A": {{}},
		}},
		{"212/2025, possible activation H24", []string{"Possible activation H24"}, []string{"ZRT A"}, map[string][]activation{
			"ZRT A": {{status: activable}},
		}},
		{"232/2024, hours, and a NOTAM outside them", []string{
			"Activables du lundi au vendredi sauf JF, de 0700 à 1600 UTC (HIV +1HR).",
			"En dehors de ces horaires par NOTAM (préavis 48 heures).",
		}, []string{"ZRT A"}, map[string][]activation{
			"ZRT A": {
				{from: "07:00", to: "16:00", dayRule: weekdaysOff, status: status{mode: modeActivable, noticeMin: 48 * 60}, season: winterLater},
				{status: byNotam(48 * 60)},
			},
		}},
		{"053/2026, by protocol, and by NOTAM at six hours", []string{
			"Activables selon protocole.",
			"Activables par NOTAM avec un préavis de 6h00 lorsque les ZRT sont activées pour raison de sûreté et à J-1 ouvré",
			"avant 1100 UTC (été : - 1 HR) dans le cadre d'un exercice ou d'un entrainement.",
		}, []string{"ZRT PARTHENAY", "ZRT SAUMUR"}, map[string][]activation{
			"ZRT PARTHENAY": {{status: status{mode: modeActivable, noticeMin: 360}}},
			"ZRT SAUMUR":    {{status: status{mode: modeActivable, noticeMin: 360}}},
		}},
		{"150/2025, two headings and their rows", []string{
			"ZRT SOTAME ALPHA activable par NOTAM à J-1 :",
			"- Lundi-jeudi : 1600-0200 (sauf JF, HOR ETE -1H).",
			"- Vendredi : 1400-2300 (sauf JF, HOR ETE -1H).",
			"ZRT SOTAME BRAVO activable avec préavis d’une heure :",
			"- Lundi-jeudi : 1600-0200 (sauf JF, HOR ETE -1H).",
		}, []string{"ZRT SOTAME ALPHA", "ZRT SOTAME BRAVO"}, map[string][]activation{
			"ZRT SOTAME ALPHA": {
				{from: "16:00", to: "02:00", dayRule: dayRule{days: 1<<1 | 1<<2 | 1<<3 | 1<<4, exceptHolidays: true}, status: byNotam(1440), season: summerEarlier},
				{from: "14:00", to: "23:00", dayRule: dayRule{days: 1 << 5, exceptHolidays: true}, status: byNotam(1440), season: summerEarlier},
			},
			"ZRT SOTAME BRAVO": {
				{from: "16:00", to: "02:00", dayRule: dayRule{days: 1<<1 | 1<<2 | 1<<3 | 1<<4, exceptHolidays: true}, status: status{mode: modeActivable, noticeMin: 60}, season: summerEarlier},
			},
		}},
		{"147/2025, zone lines", []string{
			"ZRT activables par NOTAM avec un préavis de 48 heures.",
			"Du lundi au vendredi sauf JF :",
			"- ZRT 'Low' Coulommiers : 0800-1930 (ETE : -1HR)",
		}, []string{"ZRT 'Low' Coulommiers"}, map[string][]activation{
			"ZRT 'Low' Coulommiers": {{from: "08:00", to: "19:30", dayRule: weekdaysOff, status: byNotam(48 * 60), season: summerEarlier}},
		}},
		{"192/2025, held while a CTR is not", []string{
			"Active : 2200 - 0500 (ETE -1HR) lorsque la CTR de Villacoublay est désactivée.",
		}, []string{"ZRT A"}, map[string][]activation{
			"ZRT A": {{from: "22:00", to: "05:00", status: activable, season: summerEarlier}},
		}},
		{"067/2026, a heading naming no zone", []string{
			"ZRT activables par NOTAM",
			"Du lundi au vendredi sauf jours fériés : SR-30 à SS+30",
		}, []string{"ZRT A", "ZRT B"}, map[string][]activation{
			"ZRT A": {{sunFrom: "SR-30", sunTo: "SS+30", dayRule: weekdaysOff, status: byNotam(0)}},
			"ZRT B": {{sunFrom: "SR-30", sunTo: "SS+30", dayRule: weekdaysOff, status: byNotam(0)}},
		}},
		// Days of the month with no month to place them: unread, never a
		// rule of every day.
		{"001/2026, days without their month", []string{
			"ZRT KRYPTON ALPHA et KRYPTON BRAVO",
			"-8: 0800 -1100, 1300 -1600",
			"- 9, 10, 14, 15 : 0800 -1100",
		}, []string{"ZRT KRYPTON ALPHA", "ZRT KRYPTON BRAVO"}, map[string][]activation{
			"ZRT KRYPTON ALPHA": {{status: status{mode: modeUnread}}},
			"ZRT KRYPTON BRAVO": {{status: status{mode: modeUnread}}},
		}},
		// A section this reader places nothing from.
		{"129/2026, phases", []string{
			"Phasage",
			"• Phase 1 : Présence Grue G3 seule",
		}, []string{"ZRT A"}, map[string][]activation{
			"ZRT A": {{status: status{mode: modeUnread}}},
		}},
	} {
		rows := []prow{row(100, cell{0, "DATES ET HEURES D'ACTIVITÉ"})}
		for i, text := range c.rows {
			rows = append(rows, row(float64(99-i), cell{0, text}))
		}
		rows = append(rows, row(10, cell{0, "INFORMATION DES USAGERS"}))
		var zones []zone
		for _, n := range c.zones {
			zones = append(zones, zone{name: n})
		}
		named, unnamed := parseActivations(rows)
		attachActivations(zones, named, unnamed)
		for _, z := range zones {
			if len(z.activations) > 0 {
				t.Errorf("%s: %s dated = %+v, want none", c.name, z.name, z.activations)
			}
			if want := c.want[z.name]; !reflect.DeepEqual(z.standing, want) {
				t.Errorf("%s: %s standing =\n  %+v\nwant\n  %+v", c.name, z.name, z.standing, want)
			}
		}
	}
}

// TestStandingJSON: a standing rule as the app reads it, a rule printed in
// summer UTC written as its winter hours held earlier in summer.
func TestStandingJSON(t *testing.T) {
	got := standingsJSON([]activation{
		{from: "20:30", to: "05:30", status: byNotam(2880), season: summerEarlier},
		{from: "07:00", to: "16:00", dayRule: dayRule{days: 1<<1 | 1<<5}, status: activable, season: winterLater},
		{},
	})
	want := []standingJSON{
		{From: "20:30", To: "05:30", SummerEarlier: true, Mode: "notam", NoticeMin: 2880},
		{From: "08:00", To: "17:00", Days: []int{1, 5}, SummerEarlier: true, Mode: "activable"},
		{},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("standingsJSON =\n  %+v\nwant\n  %+v", got, want)
	}
}
