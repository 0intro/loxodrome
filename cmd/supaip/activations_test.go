package main

import (
	"encoding/json"
	"reflect"
	"slices"
	"testing"
)

// workingDays is the rule "tous les jours sauf Samedi, Dimanche et jours
// fériés" prints: Monday to Friday, off the public holidays.
var workingDays = dayRule{days: 1<<1 | 1<<2 | 1<<3 | 1<<4 | 1<<5, exceptHolidays: true}

// row builds a prow from (x, text) cell pairs.
func row(y float64, cells ...cell) prow { return prow{y: y, cells: cells} }

// with returns acts holding st, the status their schedule's words print.
func with(st status, acts ...activation) []activation {
	out := slices.Clone(acts)
	for i := range out {
		out[i].status = st
	}
	return out
}

// activable is the status of a period the zone may be activated in, and
// byNotam that of one each activation of which a NOTAM announces, at a
// notice in minutes.
var activable = status{mode: modeActivable}

func byNotam(noticeMin int) status { return status{mode: modeNotam, noticeMin: noticeMin} }

func actsFor(zones []zone, name string) []activation {
	for _, z := range zones {
		if z.name == name {
			return z.activations
		}
	}
	return nil
}

// TestActivationsTable: a table whose columns are the zone names gives each
// zone its own schedule.
func TestActivationsTable(t *testing.T) {
	rows := []prow{
		row(5, cell{0, "DATES ET HEURES D'ACTIVITE"}),
		row(4, cell{0, "Dates"}, cell{100, "TMA 1 X Temporaire"}, cell{200, "TMA 2 X Temporaire"}),
		row(3, cell{0, "11 juin 2026"}, cell{100, "1200-1800"}, cell{200, "0900-1100"}),
		row(2, cell{0, "12 juin 2026"}, cell{100, "0600-1800"}, cell{200, "0600-0800"}),
		row(1, cell{0, "LIMITES LATERALES"}),
	}
	zones := []zone{{name: "TMA 1 X Temporaire"}, {name: "TMA 2 X Temporaire"}}
	named, unnamed := parseActivations(rows)
	attachActivations(zones, named, unnamed)

	want1 := []activation{{date: "2026-06-11", from: "12:00", to: "18:00"}, {date: "2026-06-12", from: "06:00", to: "18:00"}}
	if got := actsFor(zones, "TMA 1 X Temporaire"); !reflect.DeepEqual(got, want1) {
		t.Errorf("TMA 1 = %v, want %v", got, want1)
	}
	want2 := []activation{{date: "2026-06-11", from: "09:00", to: "11:00"}, {date: "2026-06-12", from: "06:00", to: "08:00"}}
	if got := actsFor(zones, "TMA 2 X Temporaire"); !reflect.DeepEqual(got, want2) {
		t.Errorf("TMA 2 = %v, want %v", got, want2)
	}
}

// TestActivationsNameList: a "ZONE A / ZONE B" heading (wrapped across rows)
// followed by one bullet shares the schedule, and a "Du ... au ..." range with
// a garbled accented month keeps both ends.
func TestActivationsNameList(t *testing.T) {
	rows := []prow{
		row(6, cell{0, "DATES ET HEURES D'ACTIVITE"}),
		row(5, cell{0, "ZRT ARMANCON ALPHA / ZRT SEINE / ZRT ORNAIN"}),
		row(4, cell{0, "ALPHA"}),
		row(3, cell{0, "- Du 16 f�vrier 2026 au 30 avril 2026 de 0815 � 2200"}),
		row(2, cell{0, "LIMITES LATERALES"}),
	}
	zones := []zone{{name: "ZRT ARMANCON ALPHA"}, {name: "ZRT SEINE"}, {name: "ZRT ORNAIN ALPHA"}}
	named, unnamed := parseActivations(rows)
	attachActivations(zones, named, unnamed)

	want := []activation{{date: "2026-02-16", dateTo: "2026-04-30", from: "08:15", to: "22:00"}}
	for _, n := range []string{"ZRT ARMANCON ALPHA", "ZRT SEINE", "ZRT ORNAIN ALPHA"} {
		if got := actsFor(zones, n); !reflect.DeepEqual(got, want) {
			t.Errorf("%s = %v, want %v", n, got, want)
		}
	}
}

// TestActivationsNameForms: the ways a schedule heading names its zones,
// each from a supplement whose zones lost their schedule to it, printed
// with its spaces and jammed as the native reader rebuilds it. A list joins
// its names with "et" (110/2026), a name printed without its type keeps the
// one before it (042/2026, 081/2026, 166/2026), text past the names is no
// name (200/2026), and a zone's own name can hold a "/" (107/2026). Each
// zone keeps a window once.
func TestActivationsNameForms(t *testing.T) {
	// A heading's status reaches the bullets under it: "activables" makes
	// their periods activable, a notice alone none.
	for _, c := range []struct {
		name    string
		heading []string
		zones   []string
		st      status
	}{
		{"et", []string{"ZRT SAVOIE et ZRT EVIAN :"}, []string{"ZRT SAVOIE", "ZRT EVIAN"}, status{}},
		{"et jammed", []string{"ZRTSAVOIEetZRTEVIAN:"}, []string{"ZRT SAVOIE", "ZRT EVIAN"}, status{}},
		{"prose", []string{"Activation des ZIT PLUGUFFAN, ZRT QUIMPER, ZIT EULALIE et ZRT BISCARROSSE avec", "préavis de 48h:"},
			[]string{"ZIT PLUGUFFAN", "ZRT QUIMPER", "ZIT EULALIE", "ZRT BISCARROSSE"}, status{}},
		{"prose jammed", []string{"ActivationdesZITPLUGUFFAN,ZRTQUIMPER,ZITEULALIEetZRTBISCARROSSEavec", "préavisde48h:"},
			[]string{"ZIT PLUGUFFAN", "ZRT QUIMPER", "ZIT EULALIE", "ZRT BISCARROSSE"}, status{}},
		{"letters", []string{"ZRT OLONNE A, B et C activables :"}, []string{"ZRT OLONNE A", "ZRT OLONNE B", "ZRT OLONNE C"}, activable},
		{"letters jammed", []string{"ZRTOLONNEA,BetCactivables:"}, []string{"ZRT OLONNE A", "ZRT OLONNE B", "ZRT OLONNE C"}, activable},
		{"phonetic", []string{"ZRT ST JEAN DE LUZ ALPHA et BRAVO activables :"}, []string{"ZRT ST JEAN DE LUZ ALPHA", "ZRT ST JEAN DE LUZ BRAVO"}, activable},
		{"numbered", []string{"Les ZRT BUCK ALPHA 1, ALPHA 2, BRAVO 1 et BRAVO 2 sont activables"},
			[]string{"ZRT BUCK ALPHA 1", "ZRT BUCK ALPHA 2", "ZRT BUCK BRAVO 1", "ZRT BUCK BRAVO 2"}, activable},
		{"numbers", []string{"ZRT 3, 4 et 5 activables :"}, []string{"ZRT 3", "ZRT 4", "ZRT 5"}, activable},
		{"slash in a name", []string{"ZRT AUBENAS ALPHA / BRAVO"}, []string{"ZRT AUBENAS ALPHA / BRAVO"}, status{}},
		{"et in a name", []string{"ZRT IVO BRETAGNE ALPHA et BRAVO activables :"}, []string{"ZRT IVO BRETAGNE ALPHA et BRAVO"}, activable},
		{"two types", []string{"ZRT/ZDT ROZ OUEST, ZRT ROZ EST et NORD, ZRT/ZDT BOX REAPER :"},
			[]string{"ZRT/ZDT ROZ OUEST", "ZRT ROZ EST", "ZRT ROZ NORD", "ZRT/ZDT BOX REAPER"}, status{}},
		{"no type", []string{"LFR343L / LFR343M / LFR343H"}, []string{"LFR343L", "LFR343M", "LFR343H"}, status{}},
		{"wrapped", []string{"ZRTactivable :", "1seuleZRTpourraêtreactivéeàlafoisentre1800et0600", "ZRTSEMNOZ/ZRTECOLE"},
			[]string{"ZRT SEMNOZ", "ZRT ECOLE"}, activable},
	} {
		t.Run(c.name, func(t *testing.T) {
			rows := []prow{row(9, cell{0, "DATES ET HEURES D'ACTIVITE"})}
			for i, h := range c.heading {
				rows = append(rows, row(float64(8-i), cell{0, h}))
			}
			rows = append(rows,
				row(5, cell{0, "- Le 21 septembre 2026 de 05h00 à 11h00"}),
				row(4, cell{0, "- Le 21 septembre 2026 de 05h00 à 11h00"}),
				row(3, cell{0, "LIMITES LATERALES"}))
			var zones []zone
			for _, n := range c.zones {
				zones = append(zones, zone{name: n})
			}
			named, unnamed := parseActivations(rows)
			attachActivations(zones, named, unnamed)
			want := with(c.st, activation{date: "2026-09-21", from: "05:00", to: "11:00"})
			for _, n := range c.zones {
				if got := actsFor(zones, n); !reflect.DeepEqual(got, want) {
					t.Errorf("%s = %v, want %v", n, got, want)
				}
			}
		})
	}
}

// TestActivationsAllZones: "TOUTES LES ZONES" gives its schedule to every
// zone, after a heading naming some of them as before none (200/2026), and
// "toutes les ZRT" to the ZRTs alone.
func TestActivationsAllZones(t *testing.T) {
	for _, all := range []string{"TOUTES LES ZONES", "TOUTESLESZONES"} {
		rows := []prow{
			row(9, cell{0, "DATES ET HEURES D'ACTIVITE"}),
			row(8, cell{0, "ZIT PLUGUFFAN et ZRT QUIMPER :"}),
			row(7, cell{0, "Le 21 septembre 2026 de 05h00 à 11h00."}),
			row(6, cell{0, all}),
			row(5, cell{0, "- Du 21 septembre 2026 au 28 octobre 2026 de 0500 à 1100 Activable par NOTAM"}),
			row(4, cell{0, "LIMITES LATERALES"}),
		}
		zones := []zone{{name: "ZIT PLUGUFFAN"}, {name: "ZRT QUIMPER"}, {name: "ZIT EULALIE"}}
		named, unnamed := parseActivations(rows)
		attachActivations(zones, named, unnamed)
		day := activation{date: "2026-09-21", from: "05:00", to: "11:00"}
		// "Activable par NOTAM", where the day before it states nothing.
		span := activation{date: "2026-09-21", dateTo: "2026-10-28", from: "05:00", to: "11:00", status: byNotam(0)}
		for n, want := range map[string][]activation{
			"ZIT PLUGUFFAN": {day, span},
			"ZRT QUIMPER":   {day, span},
			"ZIT EULALIE":   {span},
		} {
			if got := actsFor(zones, n); !reflect.DeepEqual(got, want) {
				t.Errorf("%q: %s = %v, want %v", all, n, got, want)
			}
		}
	}

	rows := []prow{
		row(9, cell{0, "DATES ET HEURES D'ACTIVITE"}),
		row(8, cell{0, "toutes les ZRT sont activables dans les horaires mentionnés ci-dessous."}),
		row(7, cell{0, "- Le 29 septembre 2026 de 0800 à 1200"}),
		row(6, cell{0, "LIMITES LATERALES"}),
	}
	zones := []zone{{name: "ZRT ALPHA"}, {name: "ZIT BRAVO"}}
	named, unnamed := parseActivations(rows)
	attachActivations(zones, named, unnamed)
	want := with(activable, activation{date: "2026-09-29", from: "08:00", to: "12:00"})
	if got := actsFor(zones, "ZRT ALPHA"); !reflect.DeepEqual(got, want) {
		t.Errorf("toutes les ZRT: ZRT ALPHA = %v, want %v", got, want)
	}
	if got := actsFor(zones, "ZIT BRAVO"); got != nil {
		t.Errorf("toutes les ZRT: ZIT BRAVO = %v, want none", got)
	}

	// A type with its status alone on its line names every zone of the
	// type, a zone of its name none: 225/2026 over numeric dates, and
	// 176/2026 over the zones' own headings.
	for _, c := range []struct {
		name  string
		lines []string
		want  []activation
	}{
		{"225/2026", []string{"ZRT activable :", "du 30/10/2026 au 15/11/2026 :", "0730-1600"},
			with(activable, activation{date: "2026-10-30", dateTo: "2026-11-15", from: "07:30", to: "16:00"})},
		{"176/2026", []string{"ZRT activables", "ZRT ALPHA", "- Le 02 septembre 2026 de 1700 à 2200"},
			with(activable, activation{date: "2026-09-02", from: "17:00", to: "22:00"})},
	} {
		rows := []prow{row(30, cell{0, "DATES ET HEURES D'ACTIVITÉ"})}
		for i, l := range c.lines {
			rows = append(rows, row(float64(28-i), cell{0, l}))
		}
		rows = append(rows, row(1, cell{0, "INFORMATION DES USAGERS"}))
		zones := []zone{{name: "ZRT ALPHA"}}
		named, unnamed := parseActivations(rows)
		attachActivations(zones, named, unnamed)
		if got := actsFor(zones, "ZRT ALPHA"); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: ZRT ALPHA = %v, want %v", c.name, got, c.want)
		}
	}
}

// TestActivationsUnplacedDays: 142/2026 lists the days of its rehearsals
// without their month ("actives les 09, 10 et 13 : 10h00-15h30"), which the
// one month of its section's dates places, and its ceremony's zone lines
// take the date of the row above them naming no zone. Days no single month
// places keep their zones from a partial schedule: they draw for the whole
// validity. ZRT PARA, named elsewhere only, keeps its own.
func TestActivationsUnplacedDays(t *testing.T) {
	section := func(rows ...prow) []prow {
		return append([]prow{row(20, cell{0, "DATES ET HEURES D'ACTIVITÉ"}),
			row(19, cell{0, "ZRT PARA"}),
			row(18, cell{0, "- Le 14 juillet 2026"}),
			row(17, cell{0, "- de 0330 à 0600"}),
			row(16, cell{0, "DATES ET HEURES D'ACTIVITÉ"}),
			row(15, cell{0, "Validation et répétition :"}),
			row(14, cell{0, "ZIT CONCORDE, ZRT 1 et ZRT 2 actives les 09, 10 et 13 : 10h00-15h30"}),
			row(13, cell{0, "ZRT 3, 4 et 5 activables les 09, 10 et 13 : 10h00-15h30"})}, rows...)
	}
	end := row(1, cell{0, "INFORMATION DES USAGERS"})
	zones := []zone{{name: "ZRT PARA"}, {name: "ZIT CONCORDE"}, {name: "ZRT 1"}, {name: "ZRT 5"}}
	named, unnamed := parseActivations(section(
		row(12, cell{0, "Cérémonies le 14 juillet :"}),
		row(11, cell{0, "ZIT CONCORDE active : 0600-1230"}),
		row(10, cell{0, "ZRT 1 active : 0600-1100"}),
		end))
	attachActivations(zones, named, unnamed)
	rehearsals := []activation{
		{date: "2026-07-09", from: "10:00", to: "15:30"},
		{date: "2026-07-10", from: "10:00", to: "15:30"},
		{date: "2026-07-13", from: "10:00", to: "15:30"},
	}
	for name, want := range map[string][]activation{
		"ZRT PARA":     {{date: "2026-07-14", from: "03:30", to: "06:00"}},
		"ZIT CONCORDE": append(slices.Clone(rehearsals), activation{date: "2026-07-14", from: "06:00", to: "12:30"}),
		"ZRT 1":        append(slices.Clone(rehearsals), activation{date: "2026-07-14", from: "06:00", to: "11:00"}),
		"ZRT 5":        with(activable, rehearsals...),
	} {
		if got := actsFor(zones, name); !reflect.DeepEqual(got, want) {
			t.Errorf("%s = %v, want %v", name, got, want)
		}
	}
	// A second month in the section: the rehearsal days place nowhere.
	zones = []zone{{name: "ZRT PARA"}, {name: "ZIT CONCORDE"}, {name: "ZRT 5"}}
	named, unnamed = parseActivations(section(row(12, cell{0, "- Le 2 août 2026 de 0800 à 0900"}), end))
	attachActivations(zones, named, unnamed)
	for _, n := range []string{"ZIT CONCORDE", "ZRT 5"} {
		if got := actsFor(zones, n); got != nil {
			t.Errorf("%s across two months = %v, want none", n, got)
		}
	}
}

// TestActivationsYearFromCover: 003/2026 prints its schedule's dates
// without their year, and they take the year of the cover's "En vigueur".
func TestActivationsYearFromCover(t *testing.T) {
	rows := []prow{
		row(20, cell{0, "En vigueur : Du lundi 23 février 2026 au dimanche 1er mars 2026"}),
		row(19, cell{0, "DATES ET HEURES D’ACTIVITE"}),
		row(18, cell{0, "ZRT COETQUIDAN ALPHA :"}),
		row(17, cell{0, "- lundi 23 février 0000 - 0500 : 1 créneau de 2h + 1 créneau de 3h"}),
		row(16, cell{0, "ORGANISMES A CONTACTER"}),
	}
	zones := []zone{{name: "ZRT COETQUIDAN ALPHA"}}
	named, unnamed := parseActivations(rows)
	attachActivations(zones, named, unnamed)
	want := []activation{{date: "2026-02-23", from: "00:00", to: "05:00"}}
	if got := actsFor(zones, "ZRT COETQUIDAN ALPHA"); !reflect.DeepEqual(got, want) {
		t.Errorf("ZRT COETQUIDAN ALPHA = %v, want %v", got, want)
	}
}

// TestActivationsUnnamed: a bullet block with no zone heading applies to the
// supplement's single zone.
func TestActivationsUnnamed(t *testing.T) {
	rows := []prow{
		row(4, cell{0, "DATES ET HEURES D'ACTIVITE"}),
		row(3, cell{0, "- Le 11 juin 2026 de 1200 � 1800"}),
		row(2, cell{0, "CONDITIONS"}),
	}
	zones := []zone{{name: "ZRT SOLO"}}
	named, unnamed := parseActivations(rows)
	attachActivations(zones, named, unnamed)

	want := []activation{{date: "2026-06-11", from: "12:00", to: "18:00"}}
	if got := actsFor(zones, "ZRT SOLO"); !reflect.DeepEqual(got, want) {
		t.Errorf("ZRT SOLO = %v, want %v", got, want)
	}
}

// TestActivationsMultipleWindows: a bullet (and a table cell) listing several
// HHMM-HHMM windows for one date yields one activation per window.
func TestActivationsMultipleWindows(t *testing.T) {
	rows := []prow{
		row(4, cell{0, "DATES ET HEURES D'ACTIVITE"}),
		row(3, cell{0, "- Le 11 juin 2026 : 0800-1200 et 1330-1700"}),
		row(2, cell{0, "CONDITIONS"}),
	}
	zones := []zone{{name: "ZRT SOLO"}}
	named, unnamed := parseActivations(rows)
	attachActivations(zones, named, unnamed)

	want := []activation{
		{date: "2026-06-11", from: "08:00", to: "12:00"},
		{date: "2026-06-11", from: "13:30", to: "17:00"},
	}
	if got := actsFor(zones, "ZRT SOLO"); !reflect.DeepEqual(got, want) {
		t.Errorf("ZRT SOLO = %v, want %v", got, want)
	}
}

func TestActivationsTableMultipleWindows(t *testing.T) {
	rows := []prow{
		row(4, cell{0, "DATES ET HEURES D'ACTIVITE"}),
		row(3, cell{0, "Dates"}, cell{100, "TMA 1 X Temporaire"}),
		row(2, cell{0, "11 juin 2026"}, cell{100, "0600-0800 et 1200-1800"}),
		row(1, cell{0, "LIMITES LATERALES"}),
	}
	zones := []zone{{name: "TMA 1 X Temporaire"}}
	named, unnamed := parseActivations(rows)
	attachActivations(zones, named, unnamed)

	want := []activation{
		{date: "2026-06-11", from: "06:00", to: "08:00"},
		{date: "2026-06-11", from: "12:00", to: "18:00"},
	}
	if got := actsFor(zones, "TMA 1 X Temporaire"); !reflect.DeepEqual(got, want) {
		t.Errorf("TMA 1 = %v, want %v", got, want)
	}
}

// TestAttachActivationsFoldOrder: two spellings of one zone name fold in the
// order the document names them. 110/2026 names ZIT LAC once in a list with
// ZRT SAVOIE and once on its own, and folding the two through a Go map put its
// two windows in a different order run to run, which rewrote the dataset on
// every rebuild.
func TestAttachActivationsFoldOrder(t *testing.T) {
	na := newNamedActs()
	na.add("ZIT LAC", activation{date: "2026-06-11", dateTo: "2026-06-12"})
	na.add("ZRT SAVOIE", activation{date: "2026-06-11", dateTo: "2026-06-12"})
	na.add("ZIT LAC :", activation{date: "2026-06-15", dateTo: "2026-06-18"})

	zones := []zone{{name: "ZIT LAC"}, {name: "ZRT SAVOIE"}}
	attachActivations(zones, na, nil)

	want := []activation{
		{date: "2026-06-11", dateTo: "2026-06-12"},
		{date: "2026-06-15", dateTo: "2026-06-18"},
	}
	if got := actsFor(zones, "ZIT LAC"); !reflect.DeepEqual(got, want) {
		t.Errorf("ZIT LAC = %v, want %v", got, want)
	}
}

// TestActivationsTableMultiLineCells: 216/2026's table, rows as the native
// reader rebuilds them. A cell sets its windows one per line, centred on the
// date row, so a window on a dateless row belongs to the nearest date; two
// header cells wrap their names onto the row below ("ZRT BELMONT -" over
// "TARN"). Reading the date's own row alone lost CENTRE's other windows and
// every one of TARN's and NORD's.
func TestActivationsTableMultiLineCells(t *testing.T) {
	rows := []prow{
		row(775.6, cell{230, "DATESETHEURESD'ACTIVIT�"}),
		row(738.0, cell{46, "ZRTBELMONT-TARN,BELMONTNORDetBELMONTSUDnonactivessimultan�ment"}),
		row(719.7, cell{71, "Dates"}, cell{134, "ZRTBELMONTCENTRE"}, cell{264, "ZRTBELMONT-"}, cell{369, "ZRTBELMONT"}, cell{457, "ZRTBELMONTSUD"}),
		row(708.5, cell{288, "TARN"}, cell{388, "NORD"}),
		row(692.0, cell{46, "14octobre2026"}, cell{162, "0900-1300"}),
		row(680.7, cell{162, "1400-1800"}),
		row(608.7, cell{162, "0900-1300"}, cell{275, "0900-1300"}),
		row(597.5, cell{46, "19octobre2026"}, cell{162, "1400-1800"}, cell{275, "1400-1800"}, cell{377, "1300-1800"}, cell{477, "1300-1800"}),
		row(586.2, cell{162, "1800-2100"}),
		row(569.7, cell{162, "0900-1300"}, cell{275, "0900-1300"}),
		row(558.5, cell{46, "20octobre2026"}, cell{162, "1400-1800"}, cell{275, "1400-1800"}, cell{377, "1300-1800"}, cell{477, "1300-1800"}),
		row(547.2, cell{162, "1800-2100"}),
		row(491.7, cell{46, "22octobre2026"}, cell{162, "0900-1300"}, cell{275, "0900-1300"}, cell{377, "1300-1800"}, cell{477, "1300-1800"}),
		row(480.5, cell{162, "1400-1800"}, cell{275, "1400-1800"}),
		row(452.0, cell{232, "INFORMATIONDESUSAGERS"}),
	}
	zones := []zone{{name: "ZRT BELMONT CENTRE"}, {name: "ZRT BELMONT - TARN"}, {name: "ZRT BELMONT NORD"}, {name: "ZRT BELMONT SUD"}}
	named, unnamed := parseActivations(rows)
	attachActivations(zones, named, unnamed)

	a := func(d, from, to string) activation { return activation{date: d, from: from, to: to} }
	want := map[string][]activation{
		"ZRT BELMONT CENTRE": {
			a("2026-10-14", "09:00", "13:00"), a("2026-10-14", "14:00", "18:00"),
			a("2026-10-19", "09:00", "13:00"), a("2026-10-19", "14:00", "18:00"), a("2026-10-19", "18:00", "21:00"),
			a("2026-10-20", "09:00", "13:00"), a("2026-10-20", "14:00", "18:00"), a("2026-10-20", "18:00", "21:00"),
			a("2026-10-22", "09:00", "13:00"), a("2026-10-22", "14:00", "18:00"),
		},
		"ZRT BELMONT - TARN": {
			a("2026-10-19", "09:00", "13:00"), a("2026-10-19", "14:00", "18:00"),
			a("2026-10-20", "09:00", "13:00"), a("2026-10-20", "14:00", "18:00"),
			a("2026-10-22", "09:00", "13:00"), a("2026-10-22", "14:00", "18:00"),
		},
		"ZRT BELMONT NORD": {
			a("2026-10-19", "13:00", "18:00"), a("2026-10-20", "13:00", "18:00"), a("2026-10-22", "13:00", "18:00"),
		},
		"ZRT BELMONT SUD": {
			a("2026-10-19", "13:00", "18:00"), a("2026-10-20", "13:00", "18:00"), a("2026-10-22", "13:00", "18:00"),
		},
	}
	for name, w := range want {
		if got := actsFor(zones, name); !reflect.DeepEqual(got, w) {
			t.Errorf("%s =\n  %v\nwant\n  %v", name, got, w)
		}
	}
}

// TestActivationsTableTie: a window exactly between two dates is drawn on
// both, never dropped.
func TestActivationsTableTie(t *testing.T) {
	rows := []prow{
		row(100, cell{0, "DATES ET HEURES D'ACTIVITE"}),
		row(90, cell{0, "Dates"}, cell{100, "ZRT A"}),
		row(80, cell{0, "11 juin 2026"}, cell{100, "0800-0900"}),
		row(70, cell{100, "1000-1100"}),
		row(60, cell{0, "12 juin 2026"}, cell{100, "1200-1300"}),
		row(50, cell{0, "LIMITES LATERALES"}),
	}
	zones := []zone{{name: "ZRT A"}}
	named, unnamed := parseActivations(rows)
	attachActivations(zones, named, unnamed)
	want := []activation{
		{date: "2026-06-11", from: "08:00", to: "09:00"}, {date: "2026-06-11", from: "10:00", to: "11:00"},
		{date: "2026-06-12", from: "10:00", to: "11:00"}, {date: "2026-06-12", from: "12:00", to: "13:00"},
	}
	if got := actsFor(zones, "ZRT A"); !reflect.DeepEqual(got, want) {
		t.Errorf("ZRT A = %v, want %v", got, want)
	}
}

// TestActivationsTableAcrossPages: 211/2026's RAPACE table, rows as the
// native reader rebuilds them, runs on over a page break, its header printed
// again on the second page. Ended at the foot, the table lost every date after
// 20 October, and both zones, scheduled to April 2027, left the map on it. A
// window belongs to a date on its own page: Y restarts at the top of each, and
// the second page's last window sits nearer the first page's first date.
func TestActivationsTableAcrossPages(t *testing.T) {
	rows := []prow{
		row(214.03, cell{229.6, "DATESETHEURESD'ACTIVIT�"}),
		row(200.04, cell{199.1, "ZRTRAPACEALPHAetBRAVOactivables:"}),
		row(158.14, cell{119.1, "Dates"}, cell{258.0, "ZRTRAPACEALPHA"}, cell{422.1, "ZRTRAPACEBRAVO"}),
		row(141.64, cell{94.0, "06octobre2026"}, cell{279.2, "0600-1400"}, cell{443.9, "0600-1400"}),
		row(130.39, cell{279.2, "1600-2359"}, cell{443.9, "1600-2359"}),
		row(113.89, cell{94.0, "08octobre2026"}, cell{279.2, "0600-1400"}, cell{443.9, "0600-1400"}),
		row(102.64, cell{279.2, "1600-2359"}, cell{443.9, "1600-2359"}),
		row(36.54, cell{544.0, "FR"}),
		row(30.99, cell{280.6, "Page1/3"}, cell{529.8, "�SIA"}),
		row(804.67, cell{42.5, "SUPAIP211/26"}, cell{391.1, "Datedepublication:17SEP2026"}),
		row(773.33, cell{119.1, "Dates"}, cell{258.0, "ZRTRAPACEALPHA"}, cell{422.1, "ZRTRAPACEBRAVO"}),
		row(673.58, cell{88.4, "17novembre2026"}, cell{279.2, "0700-1500"}, cell{443.9, "0700-1500"}),
		row(662.33, cell{279.2, "1700-2359"}, cell{443.9, "1700-2359"}),
		row(146.33, cell{101.8, "08avril2027"}, cell{279.2, "0600-1400"}, cell{443.9, "0600-1400"}),
		row(135.08, cell{279.2, "1600-2359"}, cell{443.9, "1600-2359"}),
		row(106.63, cell{231.8, "INFORMATIONDESUSAGERS"}),
	}
	zones := []zone{{name: "ZRT RAPACE ALPHA"}, {name: "ZRT RAPACE BRAVO"}}
	named, unnamed := parseActivations(rows)
	attachActivations(zones, named, unnamed)

	// The heading's "activables" reaches the table's dates.
	want := with(activable, []activation{
		{date: "2026-10-06", from: "06:00", to: "14:00"}, {date: "2026-10-06", from: "16:00", to: "23:59"},
		{date: "2026-10-08", from: "06:00", to: "14:00"}, {date: "2026-10-08", from: "16:00", to: "23:59"},
		{date: "2026-11-17", from: "07:00", to: "15:00"}, {date: "2026-11-17", from: "17:00", to: "23:59"},
		{date: "2027-04-08", from: "06:00", to: "14:00"}, {date: "2027-04-08", from: "16:00", to: "23:59"},
	}...)
	for _, z := range zones {
		if got := actsFor(zones, z.name); !reflect.DeepEqual(got, want) {
			t.Errorf("%s =\n  %v\nwant\n  %v", z.name, got, want)
		}
	}
}

// TestActivationsBulletAcrossPages: a bullet's hours rows go on past the page
// furniture, and a row is furniture by its shape and its place, never by its
// words: "équipage" folds to "quipage", which once ended the section.
func TestActivationsBulletAcrossPages(t *testing.T) {
	rows := []prow{
		row(100, cell{0, "DATESETHEURESD'ACTIVIT�"}),
		row(90, cell{0, "-Le11juin2026"}),
		row(80, cell{0, "- Activablede0800�1000pourlesa�ronefssans�quipage�bord"}),
		row(36.54, cell{544.0, "FR"}),
		row(30.99, cell{280.6, "Page1/2"}, cell{529.8, "�SIA"}),
		row(804.67, cell{42.5, "SUPAIP211/26"}, cell{391.1, "Datedepublication:17SEP2026"}),
		row(780, cell{0, "- Activablede1400�1600"}),
		row(770, cell{0, "INFORMATIONDESUSAGERS"}),
	}
	zones := []zone{{name: "ZRT SOLO"}}
	named, unnamed := parseActivations(rows)
	attachActivations(zones, named, unnamed)
	want := with(activable, activation{date: "2026-06-11", from: "08:00", to: "10:00"}, activation{date: "2026-06-11", from: "14:00", to: "16:00"})
	if got := actsFor(zones, "ZRT SOLO"); !reflect.DeepEqual(got, want) {
		t.Errorf("ZRT SOLO = %v, want %v", got, want)
	}
}

// TestPageFurniture: the head a page opens on and the run of foot rows that
// closes a page, in the native reader's coordinates (Y up from the foot) and
// in poppler's (Y down from the head, negated), and nothing else, whatever
// its words.
func TestPageFurniture(t *testing.T) {
	cases := []struct {
		name string
		rows []prow
		want []bool
	}{
		{
			name: "native",
			rows: []prow{
				row(700, cell{0, "Page1/2"}),
				row(690, cell{0, "- Activablede0800�1000pourlesa�ronefssans�quipage�bord"}),
				row(36.54, cell{544.0, "FR"}),
				row(30.99, cell{280.6, "Page1/2"}, cell{529.8, "�SIA"}),
				row(804.67, cell{42.5, "SUPAIP211/26"}, cell{391.1, "Datedepublication:17SEP2026"}),
				row(780, cell{0, "SUPAIP211/26Datedepublication:17SEP2026"}),
				row(770, cell{0, "FR"}),
				row(760, cell{0, "INFORMATIONDESUSAGERS"}),
				row(36.54, cell{544.0, "FR"}),
				row(30.99, cell{280.6, "Page2/2"}, cell{529.8, "�SIA"}),
			},
			want: []bool{false, false, true, true, true, false, false, false, true, true},
		},
		{
			name: "poppler",
			rows: []prow{
				row(-692.02, cell{59.8, "Du27janvier2026au11juin2026"}),
				row(-784.66, cell{278.0, "Page1/2FR"}),
				row(-797.38, cell{509.4, "©SIA"}),
				row(-37.13, cell{65.6, "SUPAIPN°005/26"}, cell{391.5, "Datedepublication:08JAN2026"}),
				row(-72.46, cell{245.5, "INFORMATIONDESUSAGERS"}),
			},
			want: []bool{false, true, true, true, false},
		},
	}
	for _, c := range cases {
		if got := pageFurniture(c.rows, pageNumbers(c.rows)); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: pageFurniture = %v, want %v", c.name, got, c.want)
		}
	}
}

// TestActivationsTwoRanges: 005/2026's bullet, rows as poppler rebuilds them,
// schedules ZRT « PLOUHARNEL » over two ranges. Read as one, from its first
// date to its second, the zone left the map on 11 June 2026, its second
// range running to January 2027.
func TestActivationsTwoRanges(t *testing.T) {
	rows := []prow{
		row(-678.34, cell{244.3, "DATESETHEURESD’ACTIVITÉ"}),
		row(-692.02, cell{59.8, "Du27janvier2026au11juin2026etdu15septembre"}, cell{241.9, "2026au21janvier2027:"}),
		row(-705.16, cell{59.8, "-ZRTactivableH24dumardiaujeudi,horsjoursfériés;"}),
		row(-718.30, cell{59.8, "-prévisiond’activationannoncéeparNOTAMavecunpréavisde24heures;"}),
		row(-784.66, cell{278.0, "Page1/2FR"}),
		row(-797.38, cell{509.4, "©SIA"}),
		row(-37.13, cell{65.6, "SUPAIPN°005/26"}, cell{391.5, "Datedepublication:08JAN2026"}),
		row(-72.46, cell{245.5, "INFORMATIONDESUSAGERS"}),
	}
	zones := []zone{{name: "ZRT « PLOUHARNEL »"}}
	named, unnamed := parseActivations(rows)
	attachActivations(zones, named, unnamed)
	// "ZRT activable H24" stands in its own clause beside the NOTAM that
	// announces the forecast: the zone may be activated.
	want := with(status{mode: modeActivable, noticeMin: 24 * 60}, activation{date: "2026-01-27", dateTo: "2026-06-11"}, activation{date: "2026-09-15", dateTo: "2027-01-21"})
	if got := actsFor(zones, zones[0].name); !reflect.DeepEqual(got, want) {
		t.Errorf("%s = %v, want %v", zones[0].name, got, want)
	}

	// A table's date cell reads the same way.
	rows = []prow{
		row(100, cell{0, "DATES ET HEURES D'ACTIVITE"}),
		row(90, cell{0, "Dates"}, cell{300, "ZRT A"}),
		row(80, cell{0, "Du 1 juin 2026 au 5 juin 2026 et du 10 juin 2026 au 12 juin 2026"}, cell{300, "0800-1200"}),
		row(70, cell{0, "INFORMATION DES USAGERS"}),
	}
	zones = []zone{{name: "ZRT A"}}
	named, unnamed = parseActivations(rows)
	attachActivations(zones, named, unnamed)
	want = []activation{{date: "2026-06-01", dateTo: "2026-06-05", from: "08:00", to: "12:00"}, {date: "2026-06-10", dateTo: "2026-06-12", from: "08:00", to: "12:00"}}
	if got := actsFor(zones, "ZRT A"); !reflect.DeepEqual(got, want) {
		t.Errorf("table: ZRT A = %v, want %v", got, want)
	}
}

// TestActivationsDaysWithoutMonth: 110/2026's schedule, rows as the native
// reader rebuilds them. "les 10 et 11 juin 2026" holds two days, each run
// of dates takes the hours printed after it, in the HHhMM form, and "du 15
// au 18 juin" is a range. Read as dates alone, the first row would draw 11
// and 12 June all day and miss 10 June, and ZRT EVIAN would hold 18 June
// alone. The stretch from 15 June 05:00 to 18 June 01:00 stays one block,
// its end days cut at its clock times: read as a window each day, ZIT LAC
// would leave the map from 01:00 to 05:00 on the nights between.
func TestActivationsDaysWithoutMonth(t *testing.T) {
	rows := []prow{
		row(307.19, cell{229.6, "DATESETHEURESD'ACTIVIT�"}),
		row(293.21, cell{45.5, "Validationetr�p�tition"}, cell{159.8, ":"}),
		row(281.40, cell{45.5, "ZITLAC,ZRTSAVOIE"}, cell{144.2, ":"}),
		row(269.58, cell{45.5, "Activablesles10et11juin2026de11h00�14h00etle12juinde07h00�10h00."}),
		row(257.77, cell{45.5, "Lacon�\x01rmationd'activationouannulationdel'ensembledeszonesseferaparlavoiedeNOTAM�J-1ouvr�."}),
		row(245.96, cell{45.5, "DPSAG7"}, cell{87.0, ":"}),
		row(234.15, cell{45.5, "ZITLAC:"}),
		row(222.33, cell{45.5, "Activabledu15juin05h00au18juin01h00."}),
		row(210.52, cell{45.5, "Lacon�\x01rmationd'activationouannulationseferaparlavoiedeNOTAM�J-1ouvr�."}),
		row(198.71, cell{45.5, "ZRTSAVOIEetZRTEVIAN:"}),
		row(186.90, cell{45.5, "Activablesdu15au18juinde05h00�01h00J+1."}),
		row(175.08, cell{45.5, "Lacon�\x01rmationd'activationouannulationdel'ensembledeszonesseferaparlavoiedeNOTAM�J-1ouvr�."}),
		row(145.61, cell{231.8, "INFORMATIONDESUSAGERS"}),
	}
	zones := []zone{{name: "ZIT LAC"}, {name: "ZRT SAVOIE"}, {name: "ZRT EVIAN"}}
	named, unnamed := parseActivations(rows)
	attachActivations(zones, named, unnamed)

	// Each bullet's remark confirms its activation by NOTAM at J-1.
	want := map[string][]activation{
		"ZIT LAC": with(byNotam(24*60), []activation{
			{date: "2026-06-10", from: "11:00", to: "14:00"},
			{date: "2026-06-11", from: "11:00", to: "14:00"},
			{date: "2026-06-12", from: "07:00", to: "10:00"},
			{date: "2026-06-15", from: "05:00", to: "24:00"},
			{date: "2026-06-16", dateTo: "2026-06-17"},
			{date: "2026-06-18", from: "00:00", to: "01:00"},
		}...),
		"ZRT EVIAN": with(byNotam(24*60), activation{date: "2026-06-15", dateTo: "2026-06-18", from: "05:00", to: "01:00"}),
	}
	for name, w := range want {
		if got := actsFor(zones, name); !reflect.DeepEqual(got, w) {
			t.Errorf("%s =\n  %v\nwant\n  %v", name, got, w)
		}
	}
}

// TestActivationsWrappedRemark: 031/2026's bullet, rows as the native reader
// rebuilds them. Its remark restates the range and wraps onto the next row,
// which opens without the list marker. Read as a bullet of its own, the
// second row would draw 13 March all day, and the remark's "Du 02 mars
// 2026" would add 2 March inside the range: the range reads once.
func TestActivationsWrappedRemark(t *testing.T) {
	rows := []prow{
		row(732.17, cell{229.6, "DATESETHEURESD'ACTIVIT�"}),
		row(718.18, cell{45.5, "ZRTactivable"}, cell{113.2, ":"}),
		row(706.37, cell{45.5, "1seuleZRTpourra�treactiv�e�lafoisentre1800et0600"}),
		row(676.56, cell{45.5, "ZRTSEMNOZ/ZRTCHALLESLESEAUX/ZRTALLEVARD/ZRTECOLE"}),
		row(661.56, cell{56.8, "-"}, cell{62.5, "Du02mars2026au13mars2026de0000�0000"}, cell{282.5, "-"}, cell{288.2, "Nepastenircomptedesheuresa�\x03ch�es:Du02mars2026"}),
		row(649.37, cell{56.8, "au13mars2026:SR/SS"}),
		row(618.96, cell{231.8, "INFORMATIONDESUSAGERS"}),
	}
	zones := []zone{{name: "ZRT SEMNOZ"}, {name: "ZRT CHALLES LES EAUX"}, {name: "ZRT ALLEVARD"}, {name: "ZRT ECOLE"}}
	named, unnamed := parseActivations(rows)
	attachActivations(zones, named, unnamed)

	want := with(activable, activation{date: "2026-03-02", dateTo: "2026-03-13", from: "00:00", to: "00:00"})
	for _, z := range zones {
		if got := actsFor(zones, z.name); !reflect.DeepEqual(got, want) {
			t.Errorf("%s =\n  %v\nwant\n  %v", z.name, got, want)
		}
	}
}

// TestDateGroups: each run of dates takes the windows printed after it, and
// a row that prints hours before its first date leaves every run without
// windows of its own, for each to take them all.
func TestDateGroups(t *testing.T) {
	// flat is a group as its dates and windows, the ranges' positions and
	// end times left out.
	type flat struct{ ranges, windows [][2]string }
	cases := []struct {
		text string
		want []flat
		all  [][2]string
	}{
		{
			"Activablesles10et11juin2026de11h00�14h00etle12juinde07h00�10h00.",
			[]flat{
				{[][2]string{{"2026-06-10", ""}, {"2026-06-11", ""}}, [][2]string{{"11:00", "14:00"}}},
				{[][2]string{{"2026-06-12", ""}}, [][2]string{{"07:00", "10:00"}}},
			},
			[][2]string{{"11:00", "14:00"}, {"07:00", "10:00"}},
		},
		{
			"1000-1430 : les 16 et 17 juin 2026 ; 0800-1200 : le 18 juin 2026",
			[]flat{
				{[][2]string{{"2026-06-16", ""}, {"2026-06-17", ""}}, nil},
				{[][2]string{{"2026-06-18", ""}}, nil},
			},
			[][2]string{{"10:00", "14:30"}, {"08:00", "12:00"}},
		},
	}
	for _, c := range cases {
		year := 2026
		groups, all, _ := dateGroups(c.text, &year)
		var got []flat
		for _, g := range groups {
			f := flat{windows: g.windows}
			for _, r := range g.ranges {
				f.ranges = append(f.ranges, [2]string{r.from, r.to})
			}
			got = append(got, f)
		}
		if !reflect.DeepEqual(got, c.want) || !reflect.DeepEqual(all, c.all) {
			t.Errorf("dateGroups(%q) =\n  %v %v\nwant\n  %v %v", c.text, got, all, c.want, c.all)
		}
	}
}

// TestDateRanges: a date and the next form a range when "au" joins them,
// across a time or a weekday ("Du 25 juin 2026 à 0700 au 26 juin", "au
// dimanche 21 février"), or the "et" of "entre ... et". Any other date is a
// day of its own, and a date without its year takes the last one read. A
// day printed without its month takes the month of the date closing its
// list, unless that date ends a range from the date before it.
func TestDateRanges(t *testing.T) {
	cases := []struct {
		text string
		want [][2]string
	}{
		{"- Le 11 juin 2026 de 1200 � 1800", [][2]string{{"2026-06-11", ""}}},
		{"- Du16f�vrier2026au30avril2026de0815�2200", [][2]string{{"2026-02-16", "2026-04-30"}}},
		{"Du27janvier2026au11juin2026etdu15septembre 2026au21janvier2027:", [][2]string{{"2026-01-27", "2026-06-11"}, {"2026-09-15", "2027-01-21"}}},
		{"Du25juin2026�0700au26juin2026�0100", [][2]string{{"2026-06-25", "2026-06-26"}}},
		{"etdusamedi6f�vrier2027audimanche21f�vrier2027inclus", [][2]string{{"2027-02-06", "2027-02-21"}}},
		{"- Du02mars2026au13mars2026 et le 20 mars 2026", [][2]string{{"2026-03-02", "2026-03-13"}, {"2026-03-20", ""}}},
		{"- Jeudi19mars2026etjeudi16avril2026exclus", [][2]string{{"2026-03-19", ""}, {"2026-04-16", ""}}},
		{"16,17,23,24,26juin;04,05,18,19aout", [][2]string{
			{"2026-06-16", ""}, {"2026-06-17", ""}, {"2026-06-23", ""}, {"2026-06-24", ""}, {"2026-06-26", ""},
			{"2026-08-04", ""}, {"2026-08-05", ""}, {"2026-08-18", ""}, {"2026-08-19", ""},
		}},
		{"- Le16novembre2026de1300�2359 - 1seulcr�neauentre16,17et18novembre", [][2]string{{"2026-11-16", "2026-11-18"}}},
		{"Du 1 juin au 5 juin 2026", [][2]string{{"2026-06-01", "2026-06-05"}}},
		{"Activablesles10et11juin2026de11h00�14h00etle12juinde07h00�10h00.", [][2]string{{"2026-06-10", ""}, {"2026-06-11", ""}, {"2026-06-12", ""}}},
		{"Activablesdu15au18juinde05h00�01h00J+1.", [][2]string{{"2026-06-15", "2026-06-18"}}},
		{"−mardi2,jeudi4,mardi16,jeudi18Décembre2025:0700-1500,1700-0000", [][2]string{{"2025-12-02", ""}, {"2025-12-04", ""}, {"2025-12-16", ""}, {"2025-12-18", ""}}},
		{"Du16octobre2026àSR-15au17octobre2026àSS+15", [][2]string{{"2026-10-16", "2026-10-17"}}},
		{"Activablede05h15au18juin2026", [][2]string{{"2026-06-18", ""}}},
		// 002/2026 prints February as "févier".
		{"du 16 févier 00h00 au 22 février 23h59", [][2]string{{"2026-02-16", "2026-02-22"}}},
		// A clock time after a date printed without its year is no year
		// (003/2026): 20:00 read as 2000 put the zone 26 years back.
		{"du lundi 23 février 2000 au mardi 24 février 2000 :", [][2]string{{"2026-02-23", "2026-02-24"}}},
		{"- lundi 23 février 0000 - 0500 :", [][2]string{{"2026-02-23", ""}}},
		// The first of a month is "1er" (003/2026, 222/2026).
		{"Du vendredi 27 février 0400 au dimanche1er mars 2200 :", [][2]string{{"2026-02-27", "2026-03-01"}}},
		{"Duvendredi 27février0400audimanche1 ermars2200:1créneaude2hmaximum.", [][2]string{{"2026-02-27", "2026-03-01"}}},
		{"à l'exception des 28, 30, 31 octobre et 1er novembre", [][2]string{
			{"2026-10-28", ""}, {"2026-10-30", ""}, {"2026-10-31", ""}, {"2026-11-01", ""},
		}},
	}
	for _, c := range cases {
		year := 2026
		if got := dateRanges(c.text, &year); !reflect.DeepEqual(got, c.want) {
			t.Errorf("dateRanges(%q) = %v, want %v", c.text, got, c.want)
		}
	}
}

// TestActivationsHoursRows: 243/2026's schedule, rows as the native reader
// rebuilds them. A date bullet's windows are the hours rows under it, and a
// date-only bullet with none of its own read as all day.
func TestActivationsHoursRows(t *testing.T) {
	rows := []prow{
		row(30, cell{0, "DATESETHEURESD'ACTIVIT�"}),
		row(29, cell{0, "ZRTBAMBARIALPHA"}),
		row(28, cell{0, "-Du07d�cembre2026au08d�cembre2026"}),
		row(27, cell{0, "- Activablede0000�0300"}),
		row(26, cell{0, "- Activablede0400�0700"}),
		row(25, cell{0, "ZRTBAMBARIECHO"}),
		row(24, cell{0, "-Le01d�cembre2026"}),
		row(23, cell{0, "- Activablede1700�2000"}),
		row(22, cell{0, "- Activablede2100�2300"}),
		row(21, cell{0, "-Le02d�cembre2026"}),
		row(20, cell{0, "- Activablede0000�0300"}),
		row(19, cell{0, "ZRTBAMBARIGOLF/ZRTBAMBARIHOTEL"}),
		row(18, cell{0, "-Du01d�cembre2026au05d�cembre2026"}),
		row(17, cell{0, "- Activablede0200�0400"}),
		row(16, cell{0, "- Activablede2230�2330"}),
		row(15, cell{0, "INFORMATIONDESUSAGERS"}),
	}
	zones := []zone{{name: "ZRT BAMBARI ALPHA"}, {name: "ZRT BAMBARI ECHO"}, {name: "ZRT BAMBARI GOLF"}, {name: "ZRT BAMBARI HOTEL"}}
	named, unnamed := parseActivations(rows)
	attachActivations(zones, named, unnamed)

	golf := with(activable, []activation{
		{date: "2026-12-01", dateTo: "2026-12-05", from: "02:00", to: "04:00"},
		{date: "2026-12-01", dateTo: "2026-12-05", from: "22:30", to: "23:30"},
	}...)
	want := map[string][]activation{
		"ZRT BAMBARI ALPHA": with(activable, []activation{
			{date: "2026-12-07", dateTo: "2026-12-08", from: "00:00", to: "03:00"},
			{date: "2026-12-07", dateTo: "2026-12-08", from: "04:00", to: "07:00"},
		}...),
		"ZRT BAMBARI ECHO": with(activable, []activation{
			{date: "2026-12-01", from: "17:00", to: "20:00"},
			{date: "2026-12-01", from: "21:00", to: "23:00"},
			{date: "2026-12-02", from: "00:00", to: "03:00"},
		}...),
		"ZRT BAMBARI GOLF":  golf,
		"ZRT BAMBARI HOTEL": golf,
	}
	for name, w := range want {
		if got := actsFor(zones, name); !reflect.DeepEqual(got, w) {
			t.Errorf("%s =\n  %v\nwant\n  %v", name, got, w)
		}
	}
}

// TestActivationsZoneLines: 242/2026 gives each zone its hours on a line of
// its own and the dates on one bullet for all of them. The hours stay out of
// the names, so both zones are found, and the summer note on each line moves
// that zone's summer days.
func TestActivationsZoneLines(t *testing.T) {
	rows := []prow{
		row(30, cell{0, "DATESETHEURESD'ACTIVIT�"}),
		row(29, cell{0, "ZRTactivablesparNOTAMavecunpr�avisde48heures."}),
		row(28, cell{0, "DulundiauvendredisaufJF:"}),
		row(27, cell{0, "-ZRT'Low'Coulommiers:0800-1930(ETE:-1HR)"}),
		row(26, cell{0, "-ZRT'High'Coulommiers:0800-CS+30,MAX1930(ETE:-1HR)"}),
		row(25, cell{0, "TOUTESLESZONES"}),
		row(24, cell{0, "- Du26novembre2026au14avril2027de0800�1930 touslesjourssaufSamedi,Dimancheetjoursf�ri�s"}),
		row(23, cell{0, "ActivableparNOTAMavecpr�avisde48h"}),
		row(22, cell{0, "INFORMATIONDESUSAGERS"}),
	}
	zones := []zone{{name: "ZRT 'High' Coulommiers"}, {name: "ZRT 'Low' Coulommiers"}}
	named, unnamed := parseActivations(rows)
	attachActivations(zones, named, unnamed)

	want := with(byNotam(48*60), []activation{
		{date: "2026-11-26", dateTo: "2027-03-27", from: "08:00", to: "19:30", dayRule: workingDays},
		{date: "2027-03-28", dateTo: "2027-04-14", from: "07:00", to: "18:30", dayRule: workingDays},
	}...)
	// 'High' closes at sunset plus 30 minutes, 19:30 at the latest.
	high := make([]activation, len(want))
	for i, a := range want {
		a.sunTo = "SS+30"
		high[i] = a
	}
	for z, w := range map[string][]activation{"ZRT 'Low' Coulommiers": want, "ZRT 'High' Coulommiers": high} {
		if got := actsFor(zones, z); !reflect.DeepEqual(got, w) {
			t.Errorf("%s =\n  %v\nwant\n  %v", z, got, w)
		}
	}
}

// TestActivationsSeasonNotes: AIP France's times are winter UTC, an hour
// earlier in summer where the supplement says so (GEN 2.1.2), on the bullet,
// on the row under it, wrapped across two rows, or once before the
// section's first date. A note on a deadline moves nothing, and the reverse
// note states summer times an hour later in winter.
func TestActivationsSeasonNotes(t *testing.T) {
	cases := []struct {
		name string
		rows []string
		want []activation
	}{
		{
			name: "on the bullet (241/2026)",
			rows: []string{"- Du26novembre2026au14avril2027de2200�0500 - (ETE-1HR)lorsquelaCTRdeVillacoublayestd�sactiv�e"},
			// Held while the CTR is deactivated: it may be active as the CTR
			// may be inactive.
			want: with(activable, []activation{
				{date: "2026-11-26", dateTo: "2027-03-26", from: "22:00", to: "05:00"},
				// The clocks change inside the night: the summer opening,
				// the winter close.
				{date: "2027-03-27", from: "21:00", to: "05:00"},
				{date: "2027-03-28", dateTo: "2027-04-14", from: "21:00", to: "04:00"},
			}...),
		},
		{
			name: "restated under the bullet (012/2026)",
			rows: []string{
				"Du16f�vrier2026au31juillet2026de0900�1600touslesjourssaufSamedi,Dimancheetjoursf�ri�s-",
				"0900-1600(ETE-1HR)",
			},
			want: []activation{
				{date: "2026-02-16", dateTo: "2026-03-28", from: "09:00", to: "16:00", dayRule: workingDays},
				{date: "2026-03-29", dateTo: "2026-07-31", from: "08:00", to: "15:00", dayRule: workingDays},
			},
		},
		{
			name: "wrapped (050/2026)",
			rows: []string{
				"- Du01avril2026au31mars2027de0700�2100 touslesjourssaufSamedi,Dimancheetjoursf�ri�s - (ETE:",
				"-1HR)",
			},
			want: []activation{
				{date: "2026-04-01", dateTo: "2026-10-24", from: "06:00", to: "20:00", dayRule: workingDays},
				{date: "2026-10-25", dateTo: "2027-03-27", from: "07:00", to: "21:00", dayRule: workingDays},
				{date: "2027-03-28", dateTo: "2027-03-31", from: "06:00", to: "20:00", dayRule: workingDays},
			},
		},
		{
			name: "before the first date (172/2026)",
			rows: []string{
				"Horaires�t�:-01H00",
				"- Du24ao�t2026au31mars2027",
				"- Activablede0700�0830touslesjourssaufSamedi,Dimancheetjoursf�ri�s",
			},
			want: with(activable, []activation{
				{date: "2026-08-24", dateTo: "2026-10-24", from: "06:00", to: "07:30", dayRule: workingDays},
				{date: "2026-10-25", dateTo: "2027-03-27", from: "07:00", to: "08:30", dayRule: workingDays},
				{date: "2027-03-28", dateTo: "2027-03-31", from: "06:00", to: "07:30", dayRule: workingDays},
			}...),
		},
		{
			name: "on a deadline",
			rows: []string{
				"- Du01ao�t2026au16ao�t2026de0600�1800",
				"ActivableparNOTAMavant1100UTC(�t�:-1HR)",
			},
			want: with(byNotam(0), activation{date: "2026-08-01", dateTo: "2026-08-16", from: "06:00", to: "18:00"}),
		},
		{
			name: "the reverse (095/2026)",
			rows: []string{
				"- Du18mai2026au31d�cembre2026de0700�1500touslesjours",
				"ActivableparNOTAMavecpr�avisde48h-HIV+1HR",
			},
			want: with(byNotam(48*60), []activation{
				{date: "2026-05-18", dateTo: "2026-10-24", from: "07:00", to: "15:00"},
				{date: "2026-10-25", dateTo: "2026-12-31", from: "08:00", to: "16:00"},
			}...),
		},
	}
	for _, c := range cases {
		rows := []prow{row(100, cell{0, "DATESETHEURESD'ACTIVIT�"})}
		for i, text := range c.rows {
			rows = append(rows, row(float64(99-i), cell{0, text}))
		}
		rows = append(rows, row(10, cell{0, "INFORMATIONDESUSAGERS"}))
		named, unnamed := parseActivations(rows)
		zones := []zone{{name: "ZRT SOLO"}}
		attachActivations(zones, named, unnamed)
		if got := actsFor(zones, "ZRT SOLO"); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s =\n  %v\nwant\n  %v", c.name, got, c.want)
		}
	}
}

// TestSummerSplit: the changes fall at 01:00 UTC on the last Sunday of March
// and of October, so a day's window opens in one season or the other, and a
// window the summer hour moves before midnight opens the evening before.
func TestSummerSplit(t *testing.T) {
	cases := []struct {
		in   activation
		want []activation
	}{
		{
			// The autumn night of 2026: summer opening, winter close.
			activation{date: "2026-10-23", dateTo: "2026-10-26", from: "22:00", to: "05:00"},
			[]activation{
				{date: "2026-10-23", from: "21:00", to: "04:00"},
				{date: "2026-10-24", from: "21:00", to: "05:00"},
				{date: "2026-10-25", dateTo: "2026-10-26", from: "22:00", to: "05:00"},
			},
		},
		{
			activation{date: "2027-06-01", dateTo: "2027-06-03", from: "00:30", to: "06:00"},
			[]activation{{date: "2027-05-31", dateTo: "2027-06-02", from: "23:30", to: "05:00", dayShift: -1}},
		},
		{
			// Its weekdays move with an opening on the evening before:
			// Monday to Friday 00:00-04:00 opens Sunday to Thursday.
			activation{date: "2027-06-01", dateTo: "2027-06-30", from: "00:00", to: "04:00", dayRule: dayRule{days: 1<<1 | 1<<2 | 1<<3 | 1<<4 | 1<<5}},
			[]activation{{date: "2027-05-31", dateTo: "2027-06-29", from: "23:00", to: "03:00", dayRule: dayRule{days: 1<<7 | 1<<1 | 1<<2 | 1<<3 | 1<<4}, dayShift: -1}},
		},
		{
			// A weekly stretch's first day keeps its close at midnight, and
			// its last day its opening: the spring of 2027, 166/2026's BUCK
			// BRAVO "du lundi 11h00 au vendredi 11h00 (horaires été : - 01h00)".
			activation{date: "2027-03-22", dateTo: "2027-04-05", from: "11:00", to: "24:00", dayRule: dayRule{days: 1 << 1}, cuts: cutClose},
			[]activation{
				{date: "2027-03-22", dateTo: "2027-03-27", from: "11:00", to: "00:00", dayRule: dayRule{days: 1 << 1}, cuts: cutClose},
				{date: "2027-03-28", dateTo: "2027-04-05", from: "10:00", to: "00:00", dayRule: dayRule{days: 1 << 1}, cuts: cutClose},
			},
		},
		{
			activation{date: "2027-03-26", dateTo: "2027-04-02", from: "00:00", to: "11:00", dayRule: dayRule{days: 1 << 5}, cuts: cutOpen},
			[]activation{
				{date: "2027-03-26", dateTo: "2027-03-28", from: "00:00", to: "11:00", dayRule: dayRule{days: 1 << 5}, cuts: cutOpen},
				{date: "2027-03-29", dateTo: "2027-04-02", from: "00:00", to: "10:00", dayRule: dayRule{days: 1 << 5}, cuts: cutOpen},
			},
		},
		{
			// The split keeps the status and the marks it read.
			activation{date: "2027-06-01", from: "08:00", to: "12:00", status: activable, envelope: true},
			[]activation{{date: "2027-06-01", from: "07:00", to: "11:00", status: activable, envelope: true}},
		},
		{
			// All day, or nearly: no hours to move.
			activation{date: "2027-06-01"},
			[]activation{{date: "2027-06-01"}},
		},
		{
			activation{date: "2027-06-01", from: "00:00", to: "23:30"},
			[]activation{{date: "2027-06-01", from: "00:00", to: "23:30"}},
		},
	}
	for _, c := range cases {
		if got := summerSplit(c.in); !reflect.DeepEqual(got, c.want) {
			t.Errorf("summerSplit(%v) =\n  %v\nwant\n  %v", c.in, got, c.want)
		}
	}
}

func TestHhmm(t *testing.T) {
	for in, want := range map[string]string{
		"0800": "08:00", "800": "08:00", "2400": "24:00", "2359": "23:59",
		"11h00": "11:00", "7h00": "07:00",
		// 205/2026's jammed "16:3026-27" reads as 3026 to 2710.
		"3026": "", "2710": "", "2460": "", "0860": "", "12": "",
	} {
		if got := hhmm(in); got != want {
			t.Errorf("hhmm(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestWindowsInSun: a window the sun bounds keeps the sun's end as a
// sunCode, the event and its offset in minutes, and the latest close it
// prints ("MAX 2000") beside it. 031/2026's "SR / SS" is a remark, no
// window.
func TestWindowsInSun(t *testing.T) {
	for _, c := range []struct {
		text string
		want [][2]string
	}{
		{"0800-1130, 1300-SS MAX 2000 (été -1HR)", [][2]string{{"08:00", "11:30"}, {"13:00", "SS 20:00"}}},
		{"0800-CS+30, MAX 1930 (ETE : -1HR)", [][2]string{{"08:00", "SS+30 19:30"}}},
		{"Activable de SS+30 à SR-30", [][2]string{{"SS+30", "SR-30"}}},
		{"ActivabledeSS+30\uFFFDSR-30", [][2]string{{"SS+30", "SR-30"}}},
		{"SR-15 à 0900", [][2]string{{"SR-15", "09:00"}}},
		{"0700 à SS+30", [][2]string{{"07:00", "SS+30"}}},
		{"activables de SS à 23h00", [][2]string{{"SS", "23:00"}}},
		{"Activable SR+2HR -SS selon protocole", [][2]string{{"SR+120", "SS"}}},
		{"- SS moins 02h00 - SS", [][2]string{{"SS-120", "SS"}}},
		{"- SR – SR plus 02h00", [][2]string{{"SR", "SR+120"}}},
		{"au13mars2026:SR/SS", nil},
		// A time printed with a colon (132/2026, 205/2026).
		{"- Tous les jours 08:00-18:00", [][2]string{{"08:00", "18:00"}}},
		{"de 07:30 à SS+30", [][2]string{{"07:30", "SS+30"}}},
	} {
		if got := windowsIn(c.text); !reflect.DeepEqual(got, c.want) {
			t.Errorf("windowsIn(%q) = %v, want %v", c.text, got, c.want)
		}
	}
}

// TestActivationsStretch: a range whose ends print clock times is the
// stretch between them, not whole days. With no window it is the stretch
// itself (107/2026's DENTELLES, CARPIAGNE and AUBENAS, 110/2026's ZIT LAC),
// a window across an end is cut there or goes (OMBLEZE's night past 5
// June 03:00), and windows inside it stand as printed (VELLERON).
func TestActivationsStretch(t *testing.T) {
	for _, c := range []struct {
		name, bullet string
		want         []activation
	}{
		// Two slots of three hours in the stretch: activated for part of it
		// only.
		{"dentelles", "- Du 01 juin 2026 à 2100 au 05 juin 2026 à 0300 - 2 créneaux de 3h max d'activation sur la période", with(activable, []activation{
			{date: "2026-06-01", from: "21:00", to: "24:00"},
			{date: "2026-06-02", dateTo: "2026-06-04"},
			{date: "2026-06-05", from: "00:00", to: "03:00"},
		}...)},
		{"omblezé", "- Du 01 juin 2026 à 2100 au 05 juin 2026 à 0300 - Activable chaque jour sur le créneau 21h00 - 03h00", with(activable,
			activation{date: "2026-06-01", dateTo: "2026-06-04", from: "21:00", to: "03:00"},
		)},
		{"carpiagne", "- Du 08 juin 2026 à 2100 au 09 juin 2026 à 0000", []activation{
			{date: "2026-06-08", from: "21:00", to: "24:00"},
		}},
		{"aubenas", "- Du 01 juin 2026 à 2100 au 02 juin 2026 à 0300", []activation{
			{date: "2026-06-01", from: "21:00", to: "03:00"},
		}},
		{"lac", "Activable du 15 juin 05h00 au 18 juin 01h00.", with(activable, []activation{
			{date: "2026-06-15", from: "05:00", to: "24:00"},
			{date: "2026-06-16", dateTo: "2026-06-17"},
			{date: "2026-06-18", from: "00:00", to: "01:00"},
		}...)},
		{"velleron", "- Du 30 mai 2026 à 1200 au 11 juin 2026 à 2330 - activation quotidienne d'1 créneau de 12h00 à 14h00 et d'1 créneau de 18h00 à 23h30", []activation{
			{date: "2026-05-30", dateTo: "2026-06-11", from: "12:00", to: "14:00"},
			{date: "2026-05-30", dateTo: "2026-06-11", from: "18:00", to: "23:30"},
		}},
		{"whole days", "- Du 01 mai 2026 à 0000 au 30 avril 2027 à 2359", []activation{
			{date: "2026-05-01", dateTo: "2027-04-30"},
		}},
		// The note moves the stretch's printed end, never the midnight its
		// cut makes (177/2026).
		{"rouen", "- Du 30 août 2026 à 0000 au 26 décembre 2026 à 0200 - Active (HIVER H+1)", []activation{
			{date: "2026-08-30", dateTo: "2026-12-25"},
			{date: "2026-12-26", from: "00:00", to: "03:00"},
		}},
		{"colons", "- Du 26 juin 2026 à 0800 au 28 juin 2026 à 1800 - Tous les jours 08:00-18:00", []activation{
			{date: "2026-06-26", dateTo: "2026-06-28", from: "08:00", to: "18:00"},
		}},
		{"coetquidan", "Du lundi 23 février 2000 au mardi 24 février 2000", []activation{
			{date: "2026-02-23", from: "20:00", to: "24:00"},
			{date: "2026-02-24", from: "00:00", to: "20:00"},
		}},
	} {
		rows := []prow{
			row(9, cell{0, "En vigueur : Du 30 mai 2026 au 11 juin 2026"}),
			row(8, cell{0, "DATES ET HEURES D'ACTIVITÉ"}),
			row(7, cell{0, "ZRT X"}),
			row(6, cell{0, c.bullet}),
			row(5, cell{0, "INFORMATION DES USAGERS"}),
		}
		zones := []zone{{name: "ZRT X"}}
		named, unnamed := parseActivations(rows)
		attachActivations(zones, named, unnamed)
		if got := actsFor(zones, "ZRT X"); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: %q =\n  %v\nwant\n  %v", c.name, c.bullet, got, c.want)
		}
	}
}

// TestActivationsProseNames: 125/2026 tells which zones work together in a
// sentence naming them in parentheses, and the names there are no
// heading's: read as one, ZRT RAVEN took ZRT PIA's windows.
func TestActivationsProseNames(t *testing.T) {
	rows := []prow{
		row(9, cell{0, "DATES ET HEURES D'ACTIVITÉ"}),
		row(8, cell{0, "Les ZRT ne seront pas toutes actives simultanément : activation par découpage géographique d'un bloc Ouest (ZRT"}),
		row(7, cell{0, "PIA et ZRT LUCKY), d'un bloc Centre (ZRT RAVEN, ZRT SAIKO NORD et SAÏKO SUD) et d'un bloc Est (ZRT NIET et ZRT"}),
		row(6, cell{0, "SLEEPY)"}),
		row(5, cell{0, "ZRT PIA / ZRT LUCKY"}),
		row(4, cell{0, "- Le 24 juin 2026 de 0700 à 1000"}),
		row(3, cell{0, "ZRT SAIKO NORD / ZRT RAVEN"}),
		row(2, cell{0, "- Le 24 juin 2026 de 0700 à 1400"}),
		row(1, cell{0, "INFORMATION DES USAGERS"}),
	}
	zones := []zone{{name: "ZRT PIA"}, {name: "ZRT RAVEN"}, {name: "ZRT NIET"}}
	named, unnamed := parseActivations(rows)
	attachActivations(zones, named, unnamed)
	for n, want := range map[string][]activation{
		"ZRT PIA":   {{date: "2026-06-24", from: "07:00", to: "10:00"}},
		"ZRT RAVEN": {{date: "2026-06-24", from: "07:00", to: "14:00"}},
		"ZRT NIET":  nil,
	} {
		if got := actsFor(zones, n); !reflect.DeepEqual(got, want) {
			t.Errorf("%s = %v, want %v", n, got, want)
		}
	}
}

// TestActivationsExclusions: the days a schedule takes off its ranges are
// none of its activity. 107/2026's ZRT SAINT CHRISTOL are "inactives les 5,
// 6 et 10 juin", 235/2026's ZRTs rest over the school holidays, 222/2026's
// BROMO "à l'exception des 28, 30, 31 octobre et 1er novembre", and
// 025/2026 prints its days off before "exclus". A clause about the
// postponement takes no day off (003/2026), and "Report possible de 24
// heures" holds each window a day more (237/2026).
func TestActivationsExclusions(t *testing.T) {
	for _, c := range []struct {
		name string
		rows []string
		want []activation
	}{
		{"inactives", []string{
			"- Du 30 mai 2026 à 1200 au 11 juin 2026 à 2330 - Sur toute la période, activation",
			"quotidienne d'1 créneau de 12h00 à 14h00 et d'1 créneau de 18h00 à 23h30, ZRT inactives les 5, 6 et 10 juin",
		}, []activation{
			{date: "2026-05-30", dateTo: "2026-06-04", from: "12:00", to: "14:00"},
			{date: "2026-05-30", dateTo: "2026-06-04", from: "18:00", to: "23:30"},
			{date: "2026-06-07", dateTo: "2026-06-09", from: "12:00", to: "14:00"},
			{date: "2026-06-07", dateTo: "2026-06-09", from: "18:00", to: "23:30"},
			{date: "2026-06-11", from: "12:00", to: "14:00"},
			{date: "2026-06-11", from: "18:00", to: "23:30"},
		}},
		{"hors", []string{
			"- Du 15 novembre 2026 au 01 avril 2027 H24 Activable par",
			"NOTAM avec préavis de 72 h - Hors vacances scolaires zone C : du samedi 19 décembre 2026 au dimanche 3",
			"janvier 2027 inclus, et du samedi 6 février 2027 au dimanche 21 février 2027 inclus",
		}, with(byNotam(72*60), []activation{
			{date: "2026-11-15", dateTo: "2026-12-18"},
			{date: "2027-01-04", dateTo: "2027-02-05"},
			{date: "2027-02-22", dateTo: "2027-04-01"},
		}...)},
		{"exception", []string{
			"- Du 27 octobre 2026 au 10 novembre 2026 de 2200 à 0400 - à l'exception des 28, 30, 31 octobre et 1er novembre",
		}, []activation{
			{date: "2026-10-27", from: "22:00", to: "04:00"},
			{date: "2026-10-29", from: "22:00", to: "04:00"},
			{date: "2026-11-02", dateTo: "2026-11-10", from: "22:00", to: "04:00"},
		}},
		{"exclus", []string{
			"- Du 09 mars 2026 au 30 avril 2026 de 2200 à 0400 Activable par NOTAM avec préavis de 48 h - Jeudi 19 mars 2026 et jeudi 16 avril 2026 exclus",
		}, with(byNotam(48*60), []activation{
			{date: "2026-03-09", dateTo: "2026-03-18", from: "22:00", to: "04:00"},
			{date: "2026-03-20", dateTo: "2026-04-15", from: "22:00", to: "04:00"},
			{date: "2026-04-17", dateTo: "2026-04-30", from: "22:00", to: "04:00"},
		}...)},
		{"report", []string{
			"- Du 15 décembre 2026 à 2015 au 16 décembre 2026 à 0030 (report possible 24h, mêmes horaires)",
		}, []activation{
			{date: "2026-12-15", dateTo: "2026-12-16", from: "20:15", to: "00:30"},
		}},
		{"no day off", []string{
			"- du 27 février 2026 au 1er mars 2026 : 1 créneau de 2h maximum, (report possible 24h, même horaire, sauf la journée du 1er",
			"mars qui ne sera pas reportée de 24h).",
		}, with(activable, activation{date: "2026-02-27", dateTo: "2026-03-02"})},
		{"a bullet's every date off", []string{
			"♦ 4 semaines / an à l'exclusion de la période du 01/07/2026 au 15/09/2026.",
		}, nil},
		{"a postponement's day alone", []string{
			"- Du 27 février 2026 au 1er mars 2026 : 1 créneau de 2h maximum.",
			"- Report possible de 24h même horaire (sauf la journée du 1er mars 2026 qui ne sera pas reportée de 24h).",
		}, with(activable, activation{date: "2026-02-27", dateTo: "2026-03-01"})},
	} {
		rows := []prow{
			row(20, cell{0, "En vigueur : Du 30 mai 2026 au 11 juin 2026"}),
			row(19, cell{0, "DATES ET HEURES D'ACTIVITÉ"}),
			row(18, cell{0, "ZRT X"}),
		}
		for i, r := range c.rows {
			rows = append(rows, row(float64(17-i), cell{0, r}))
		}
		rows = append(rows, row(1, cell{0, "INFORMATION DES USAGERS"}))
		zones := []zone{{name: "ZRT X"}}
		named, unnamed := parseActivations(rows)
		attachActivations(zones, named, unnamed)
		if got := actsFor(zones, "ZRT X"); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s =\n  %v\nwant\n  %v", c.name, got, c.want)
		}
	}
}

// TestExclusionSpans: a clause naming days takes them off, one naming a
// zone never does, spaced or jammed (126/2026).
func TestExclusionSpans(t *testing.T) {
	for _, c := range []struct {
		text string
		n    int
	}{
		{"ZRT inactives les 5, 6 et 10 juin", 1},
		{"Les ZRT sont activables, sauf la ZRT AEROTORSHOW ALPHA qui sera active du 27 au 29 juin", 0},
		{"LesZRTsontactivables,saufla ZRTAEROTORSHOWALPHAquiseraactivedu27au29juin", 0},
		{"tous les jours sauf travaux du 3 au 5 mai", 1},
	} {
		if got := exclusionSpans(c.text); len(got) != c.n {
			t.Errorf("exclusionSpans(%q) = %v, want %d spans", c.text, got, c.n)
		}
	}
}

// TestRuleIn: the day rules the schedules print, spaced and jammed.
func TestRuleIn(t *testing.T) {
	const (
		mon = 1 << (iota + 1)
		tue
		wed
		thu
		fri
		sat
		sun
	)
	for _, c := range []struct {
		text string
		want dayRule
		ok   bool
	}{
		{"tous les jours sauf Samedi, Dimanche et jours fériés", workingDays, true},
		{"de0900�1600touslesjourssaufSamedi,Dimancheetjoursf�ri�s-", workingDays, true},
		{"tous les jours sauf Vendredi, Samedi, Dimanche", dayRule{days: mon | tue | wed | thu}, true},
		{"tous les jours sauf Dimanche et jours fériés", dayRule{days: mon | tue | wed | thu | fri | sat, exceptHolidays: true}, true},
		{"tous les jours sauf jours fériés", dayRule{exceptHolidays: true}, true},
		{"- Activable LUN-VEN sauf JF entre 0700 et 1800", workingDays, true},
		{"Du lundi au vendredi sauf JF :", workingDays, true},
		{"Lun-ven : H24, sauf JF", workingDays, true},
		{"- Lundi-jeudi : 1600-0200 (sauf JF, HOR ETE -1H).", dayRule{days: mon | tue | wed | thu, exceptHolidays: true}, true},
		{"- ZRT activable H24 du mardi au jeudi, hors jours fériés ;", dayRule{days: tue | wed | thu, exceptHolidays: true}, true},
		{"Activable H24 sauf week-end et jours fériés", workingDays, true},
		{"- de 0830 à 1000 uniquement le Mardi, Mercredi, Jeudi hors jours fériés - et hors veilles de jours fériés",
			dayRule{days: tue | wed | thu, exceptHolidays: true, exceptEves: true}, true},
		{"du samedi 19 décembre 2026 au dimanche 3 janvier 2027 inclus", dayRule{}, false},
		{"Du lundi 10h00 au vendredi 10h00", dayRule{}, false},
		{"ZRT PORSPODER MER", dayRule{}, false},
		{"- Du 18 mai 2026 à 0630 au 22 mai 2026 à 1430 - Lundi-vendredi 0630-1430", dayRule{days: mon | tue | wed | thu | fri}, true},
		{"- de 0500 à 1400 uniquement le Samedi, Dimanche - (ETE : -1HR)", dayRule{days: sat | sun}, true},
		{"Du 30 août 2026 à 0000 au 26 décembre 2026 à 0200 - Active du dimanche soir au samedi matin", dayRule{}, true},
		{"du mardi au vendredi de SS+30 à SR-30", dayRule{days: tue | wed | thu | fri}, true},
		{"au dimanche1er mars 2200", dayRule{}, false},
	} {
		if got, ok := ruleIn(c.text); got != c.want || ok != c.ok {
			t.Errorf("ruleIn(%q) = %+v, %v, want %+v, %v", c.text, got, ok, c.want, c.ok)
		}
	}
}

// TestActivationsWeekdays: a schedule's day rules reach its activations, a
// window taking its own row's (062/2026), a bullet's covering it (235/2026),
// and a stretch held each week reading as windows on its weekdays
// (166/2026).
func TestActivationsWeekdays(t *testing.T) {
	const (
		mon = 1 << (iota + 1)
		tue
		wed
		thu
		fri
	)
	for _, c := range []struct {
		name string
		rows []string
		want []activation
	}{
		{"windows", []string{
			"- Du 23 avril 2026 au 25 mars 2027",
			"- de 0830 à 1000 uniquement le Mardi, Mercredi, Jeudi hors jours fériés - et hors veilles de jours fériés",
			"- de 1130 à 1300 uniquement le Mardi, Jeudi hors jours fériés - et hors veilles de jours fériés",
		}, []activation{
			{date: "2026-04-23", dateTo: "2027-03-25", from: "08:30", to: "10:00", dayRule: dayRule{days: tue | wed | thu, exceptHolidays: true, exceptEves: true}},
			{date: "2026-04-23", dateTo: "2027-03-25", from: "11:30", to: "13:00", dayRule: dayRule{days: tue | thu, exceptHolidays: true, exceptEves: true}},
		}},
		{"bullet", []string{
			"- Du 15 novembre 2026 au 01 avril 2027 H24 tous les jours sauf Samedi, Dimanche et jours fériés Activable par",
		}, with(activable, activation{date: "2026-11-15", dateTo: "2027-04-01", dayRule: workingDays})},
		{"weekly", []string{
			"Du 28 septembre 2026 au 23 octobre 2026 : du lundi 10h00 au vendredi 10h00",
		}, []activation{
			{date: "2026-09-28", dateTo: "2026-10-23", from: "10:00", to: "24:00", dayRule: dayRule{days: mon}, cuts: cutClose},
			{date: "2026-09-28", dateTo: "2026-10-23", dayRule: dayRule{days: tue | wed | thu}, cuts: cutOpen | cutClose},
			{date: "2026-09-28", dateTo: "2026-10-23", from: "00:00", to: "10:00", dayRule: dayRule{days: fri}, cuts: cutOpen},
		}},
	} {
		rows := []prow{row(20, cell{0, "DATES ET HEURES D'ACTIVITÉ"}), row(19, cell{0, "ZRT X"})}
		for i, r := range c.rows {
			rows = append(rows, row(float64(18-i), cell{0, r}))
		}
		rows = append(rows, row(1, cell{0, "INFORMATION DES USAGERS"}))
		zones := []zone{{name: "ZRT X"}}
		named, unnamed := parseActivations(rows)
		attachActivations(zones, named, unnamed)
		if got := actsFor(zones, "ZRT X"); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s =\n  %+v\nwant\n  %+v", c.name, got, c.want)
		}
	}
	got, _ := json.Marshal(activationsJSON([]activation{{date: "2026-11-15", dateTo: "2027-04-01", dayRule: workingDays}}))
	if want := `[{"date":"2026-11-15","dateTo":"2027-04-01","days":[1,2,3,4,5],"exceptHolidays":true}]`; string(got) != want {
		t.Errorf("activationsJSON = %s, want %s", got, want)
	}
}

// TestActivationsSun: a zone's sun ends reach its activations. The slots
// 166/2026 takes off ("et sauf pendant les créneaux horaires suivants")
// are no windows of activity, which read as its only windows would hold
// the zone to them. 108/2026 is "ACTIVABLE DE JOUR UNIQUEMENT": sunrise to
// sunset inside its stretch.
func TestActivationsSun(t *testing.T) {
	const (
		mon = 1 << (iota + 1)
		tue
		wed
		thu
		fri
	)
	for _, c := range []struct {
		name string
		rows []string
		want []activation
	}{
		{"slots off", []string{
			"Du 28 septembre 2026 au 23 octobre 2026 : du lundi 10h00 au vendredi 10h00 , et sauf pendant les créneaux",
			"horaires suivants :",
			"- SR – SR plus 02h00",
			"- SS moins 02h00 - SS",
		}, []activation{
			{date: "2026-09-28", dateTo: "2026-10-23", from: "10:00", to: "24:00", dayRule: dayRule{days: mon}, cuts: cutClose},
			{date: "2026-09-28", dateTo: "2026-10-23", dayRule: dayRule{days: tue | wed | thu}, cuts: cutOpen | cutClose},
			{date: "2026-09-28", dateTo: "2026-10-23", from: "00:00", to: "10:00", dayRule: dayRule{days: fri}, cuts: cutOpen},
		}},
		{"by day", []string{
			"- Du 01 juin 2026 à 0600 au 09 juin 2026 à 2259 - ACTIVABLE DE JOUR UNIQUEMENT",
		}, with(activable, []activation{
			{date: "2026-06-01", from: "06:00", to: "24:00", sunFrom: "SR", sunTo: "SS"},
			{date: "2026-06-02", dateTo: "2026-06-08", sunFrom: "SR", sunTo: "SS"},
			{date: "2026-06-09", from: "00:00", to: "22:59", sunFrom: "SR", sunTo: "SS"},
		}...)},
		{"night", []string{
			"- Du 14 septembre 2026 au 25 septembre 2026 Activable de SS+30 à SR-30",
		}, with(activable, activation{date: "2026-09-14", dateTo: "2026-09-25", sunFrom: "SS+30", sunTo: "SR-30"})},
	} {
		rows := []prow{row(20, cell{0, "DATES ET HEURES D'ACTIVITÉ"}), row(19, cell{0, "ZRT X"})}
		for i, r := range c.rows {
			rows = append(rows, row(float64(18-i), cell{0, r}))
		}
		rows = append(rows, row(1, cell{0, "INFORMATION DES USAGERS"}))
		zones := []zone{{name: "ZRT X"}}
		named, unnamed := parseActivations(rows)
		attachActivations(zones, named, unnamed)
		if got := actsFor(zones, "ZRT X"); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s =\n  %+v\nwant\n  %+v", c.name, got, c.want)
		}
	}
	if got := sunCode("SS moins 02h00"); got != "SS-120" {
		t.Errorf(`sunCode("SS moins 02h00") = %q, want "SS-120"`, got)
	}
}

// TestSpellDates: a date set in figures reads as frDateRe's, a page number,
// a fraction or a coordinate staying as printed.
func TestSpellDates(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"20/01/2026 de 1900 à 0300Z", "20 janvier 2026 de 1900 à 0300Z"},
		{"du 23 au 26/02", "du 23 au 26 fevrier"},
		{"Du 03/02/26 à 22h30", "Du 3 fevrier 2026 à 22h30"},
		{"Du03/02/2026à23h45au04/02/202603h30", "Du3 fevrier 2026à23h45au4 fevrier 2026 03h30"},
		{"Page 9/12", "Page 9/12"},
		{"créneau de 1/2 heure", "créneau de 1/2 heure"},
		{"FL 115/195", "FL 115/195"},
		{"31/13/2026", "31/13/2026"},
	} {
		if got := spellDates(c.in); got != c.want {
			t.Errorf("spellDates(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// TestActivationsColumnSchedule: zone names in cells of their own over the
// dates and hours of each column (010/2026, poppler's cells), and a
// dateless row holding for every column. Names over bullets set across the
// page head no columns.
func TestActivationsColumnSchedule(t *testing.T) {
	head := row(30, cell{240, "DATESETHEURESD’ACTIVITÉ"})
	end := row(1, cell{244, "INFORMATIONDESUSAGERS"})
	zones := []zone{{name: "ZRT LIMA 1"}, {name: "ZRT/ZDT LIMA 2"}}
	named, unnamed := parseActivations([]prow{head,
		row(29, cell{154, "ZRTLIMA1"}, cell{393, "ZRT/ZDTLIMA2"}),
		row(28, cell{97, "Du03/02/2026"}, cell{147, "à23h00au04/02/2026"}, cell{225, "à02h00"},
			cell{344, "Du03/02/2026"}, cell{394, "à22h30au04/02/2026"}, cell{472, "à01h45"}),
		row(27, cell{217, "Reportpossiblede24heuresmêmeshoraires"}),
		end})
	attachActivations(zones, named, unnamed)
	for i, want := range [][]activation{
		{{date: "2026-02-03", dateTo: "2026-02-04", from: "23:00", to: "02:00"}},
		{{date: "2026-02-03", dateTo: "2026-02-04", from: "22:30", to: "01:45"}},
	} {
		if got := zones[i].activations; !reflect.DeepEqual(got, want) {
			t.Errorf("%s = %+v, want %+v", zones[i].name, got, want)
		}
	}
	zones = []zone{{name: "ZRT A"}, {name: "ZRT B"}}
	named, unnamed = parseActivations([]prow{head,
		row(29, cell{150, "ZRT A"}, cell{390, "ZRT B"}),
		row(28, cell{60, "- Du 1 juin 2026 au 5 juin 2026 de 0800 à 1200"}),
		end})
	attachActivations(zones, named, unnamed)
	want := []activation{{date: "2026-06-01", dateTo: "2026-06-05", from: "08:00", to: "12:00"}}
	for _, z := range zones {
		if !reflect.DeepEqual(z.activations, want) {
			t.Errorf("%s under names across the page = %+v, want %+v", z.name, z.activations, want)
		}
	}
}

// TestActivationsEnvelope: a bullet sending the reader to the hours above
// holds a zone only when the zone has no schedule of its own (017/2026,
// 166/2026), and holds the hours a zone states with no dates within its
// days (166/2026's BUCK BRAVO 1).
func TestActivationsEnvelope(t *testing.T) {
	rows := []prow{
		row(20, cell{0, "DATES ET HEURES D'ACTIVITÉ"}),
		row(19, cell{0, "ZRT PARA CUERS"}),
		row(18, cell{0, "Du 19/02/2026 au 30/04/2026 : Activable par NOTAM - du mardi au vendredi de 22h00 UTC à SR-30"}),
		row(17, cell{0, "ZRT PARA CUERS"}),
		row(16, cell{0, "Du 19 février 2026 à 0000 au 16 janvier 2027 à 2359 - Voir détail des horaires ci-dessus"}),
		row(15, cell{0, "ZRT BUCK BRAVO 1 :"}),
		row(14, cell{0, "Du lundi 11h00 au vendredi 11h00"}),
		row(13, cell{0, "TOUTES LES ZONES"}),
		row(12, cell{0, "- Du 17 août 2026 au 14 avril 2027 H24 pendant les créneaux horaires détaillés ci-dessus"}),
		row(1, cell{0, "INFORMATION DES USAGERS"}),
	}
	zones := []zone{{name: "ZRT PARA CUERS"}, {name: "ZRT BUCK BRAVO 1"}}
	named, unnamed := parseActivations(rows)
	attachActivations(zones, named, unnamed)
	tueFri := dayRule{days: 1<<2 | 1<<3 | 1<<4 | 1<<5}
	// BUCK BRAVO 1's weekly stretch, printed with no dates, holds within the
	// envelope's days.
	in := func(a activation) activation {
		a.date, a.dateTo = "2026-08-17", "2027-04-14"
		return a
	}
	want := [][]activation{
		{{date: "2026-02-19", dateTo: "2026-04-30", from: "22:00", sunTo: "SR-30", dayRule: tueFri, status: byNotam(0)}},
		{
			in(activation{from: "11:00", to: "24:00", dayRule: dayRule{days: 1 << 1}, cuts: cutClose}),
			in(activation{dayRule: dayRule{days: 1<<2 | 1<<3 | 1<<4}, cuts: cutOpen | cutClose}),
			in(activation{from: "00:00", to: "11:00", dayRule: dayRule{days: 1 << 5}, cuts: cutOpen}),
		},
	}
	for i := range zones {
		if got := zones[i].activations; !reflect.DeepEqual(got, want[i]) {
			t.Errorf("%s = %+v, want %+v", zones[i].name, got, want[i])
		}
	}
}

// TestDateGroupsStretchForms: a stretch opening "de 23h15" (010/2026's
// second phase) and one closing on a time with no "à".
func TestDateGroupsStretchForms(t *testing.T) {
	for _, s := range []string{
		"Le 03/02/2026 de 23h15 au 04/02/2026 à 02h45",
		"Du 03/02/2026 à 23h15 au 04/02/2026 02h45",
	} {
		year := 2026
		groups, _, _ := dateGroups(spellDates(s), &year)
		if len(groups) != 1 || len(groups[0].ranges) != 1 {
			t.Errorf("dateGroups(%q) = %+v", s, groups)
			continue
		}
		r := groups[0].ranges[0]
		if r.from != "2026-02-03" || r.to != "2026-02-04" || r.fromTime != "23:15" || r.toTime != "02:45" {
			t.Errorf("dateGroups(%q) range = %+v, want 2026-02-03 23:15 to 2026-02-04 02:45", s, r)
		}
	}
}

// TestNameKeyOneS: a name one "s" from a single zone's is that zone's
// (003/2026's "LANDES D'OUEE" after "ZRT PENTHIEVRE et"). An exact name
// wins, two zones that close match neither, and a short name takes no
// liberty.
func TestNameKeyOneS(t *testing.T) {
	zones := []zone{{name: "ZRT PENTHIEVRE"}, {name: "ZRT LANDE D’OUEE"}, {name: "ZRT ALPES BETA"}, {name: "ZRT ALPE BETAS"}, {name: "ZRT ARES"}}
	byNorm := map[string][]int{}
	for i, z := range zones {
		byNorm[normalizeName(z.name)] = append(byNorm[normalizeName(z.name)], i)
	}
	for _, c := range []struct {
		key  nameKey
		want []int
	}{
		{nameKey{text: "LANDESD’OUEEactivables", after: "ZRTPENTHIEVRE"}, []int{1}},
		{nameKey{text: "ZRT LANDES D’OUEE"}, []int{1}},
		{nameKey{text: "ZRT ALPE BETA"}, nil},
		{nameKey{text: "ZRT ARES"}, []int{4}},
		{nameKey{text: "ZRT ARE"}, nil},
		{nameKey{text: "ZRT PENTHIEVRES ET"}, nil},
	} {
		if got := c.key.zones(zones, byNorm); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%+v.zones = %v, want %v", c.key, got, c.want)
		}
	}
}

// TestActivationsDayRangesInStretch: 205/2026 sets day ranges with their
// own hours inside a stretch, spaced or jammed: each range keeps its hours,
// within the stretch's clock ends.
func TestActivationsDayRangesInStretch(t *testing.T) {
	for _, text := range []string{
		"- Du 24 septembre 2026 à 0800 au 27 septembre 2026 à 1600 - 24-25 08:00-16:30 26-27 10:00-16:00 Créneau de",
		"- Du24septembre2026�0800au27septembre2026�1600 - 24-2508:00-16:3026-2710:00-16:00Cr�neaude",
	} {
		rows := []prow{
			row(20, cell{0, "DATES ET HEURES D'ACTIVITÉ"}),
			row(19, cell{0, "ZRT 2 (PAF)"}),
			row(18, cell{0, text}),
			row(1, cell{0, "INFORMATION DES USAGERS"}),
		}
		zones := []zone{{name: "ZRT 2 (PAF)"}}
		named, unnamed := parseActivations(rows)
		attachActivations(zones, named, unnamed)
		want := []activation{
			{date: "2026-09-24", dateTo: "2026-09-25", from: "08:00", to: "16:30"},
			{date: "2026-09-26", dateTo: "2026-09-27", from: "10:00", to: "16:00"},
		}
		if got := zones[0].activations; !reflect.DeepEqual(got, want) {
			t.Errorf("%q =\n  %+v\nwant\n  %+v", text, got, want)
		}
	}
	// A day number past the first date's time opens a range of its own, no
	// join of the two dates, while a sun end ("à SR-15 au") joins.
	for _, c := range []struct {
		text string
		want [][2]string
	}{
		{"Le 16 novembre 2026 de 1600 à 2300 - du 18 au 19 novembre", [][2]string{{"2026-11-16", ""}, {"2026-11-18", "2026-11-19"}}},
		{"Du 16 octobre 2026 à SR-15 au 17 octobre 2026 à SS+15", [][2]string{{"2026-10-16", "2026-10-17"}}},
	} {
		year := 2026
		if got := dateRanges(c.text, &year); !reflect.DeepEqual(got, c.want) {
			t.Errorf("dateRanges(%q) = %v, want %v", c.text, got, c.want)
		}
	}
}

// TestActivationsWrappedRule: a dated row's clause finished on the row
// under it ("... sauf Samedi, Dimanche et jours" over "fériés", 247/2026)
// is read with it, and a row holding none leaves the rule as printed.
func TestActivationsWrappedRule(t *testing.T) {
	rows := []prow{
		row(20, cell{0, "DATES ET HEURES D'ACTIVITÉ"}),
		row(19, cell{0, "ZRT CAHORS AD ALPHA"}),
		row(18, cell{0, "- Du 01 décembre 2026 au 31 mai 2027 Activable de 0700 à 2300 tous les jours sauf Samedi, Dimanche et jours"}),
		row(17, cell{0, "fériés"}),
		row(16, cell{0, "ZRT CAHORS AD BRAVO"}),
		row(15, cell{0, "- Du 01 décembre 2026 au 31 mai 2027 de 0700 à 2300 tous les jours sauf Samedi, Dimanche"}),
		row(14, cell{0, "Activable par NOTAM avec préavis de 72 h"}),
		row(1, cell{0, "INFORMATION DES USAGERS"}),
	}
	zones := []zone{{name: "ZRT CAHORS AD ALPHA"}, {name: "ZRT CAHORS AD BRAVO"}}
	named, unnamed := parseActivations(rows)
	attachActivations(zones, named, unnamed)
	for i, holidays := range []bool{true, false} {
		acts := zones[i].activations
		if len(acts) != 1 {
			t.Errorf("%s: %d activations, want 1: %+v", zones[i].name, len(acts), acts)
			continue
		}
		a := acts[0]
		if a.date != "2026-12-01" || a.dateTo != "2027-05-31" || a.from != "07:00" || a.to != "23:00" ||
			!reflect.DeepEqual(a.days.isoDays(), []int{1, 2, 3, 4, 5}) || a.exceptHolidays != holidays {
			t.Errorf("%s = %+v, want 2026-12-01 to 2027-05-31 07:00-23:00, Monday to Friday, exceptHolidays %v",
				zones[i].name, a, holidays)
		}
	}
}

// TestActivationSectionEnd: a schedule ends at a heading opening its row,
// past its number, and runs on past a sentence naming a heading's word.
func TestActivationSectionEnd(t *testing.T) {
	for _, c := range []struct {
		text string
		end  bool
	}{
		{"DISPOSITIONS COMPLÉMENTAIRES", true},
		{"7ORGANISMES ÀCONTACTER", true},
		{"GÉNÉRALITÉS", true},
		{"INFORMATION DES USAGERS", true},
		{"avec préavis de 48 h conformément aux dispositions complémentaires", false},
		{"Pas de report en cas de mauvaises conditions météorologiques", false},
		{"Activité connue et communiquée aux organismes listés en consignes hors publication à J-1.", false},
	} {
		if got := activationSectionEnd(row(0, cell{0, c.text})); got != c.end {
			t.Errorf("activationSectionEnd(%q) = %v, want %v", c.text, got, c.end)
		}
	}
}

// TestActivationsRunOn: the lines a schedule prints past a sentence naming
// a heading's word stay in it (178/2026's notice on its bullet's wrapped
// line), and an envelope printed before a zone's own range, on days that
// range leaves, holds on them (a_099/2026).
func TestActivationsRunOn(t *testing.T) {
	read := func(lines ...string) []activation {
		rows := []prow{row(30, cell{0, "DATES ET HEURES D'ACTIVITÉ"}), row(29, cell{0, "TOUTES LES ZONES"})}
		for i, l := range lines {
			rows = append(rows, row(float64(28-i), cell{0, l}))
		}
		rows = append(rows, row(1, cell{0, "INFORMATION DES USAGERS"}))
		zones := []zone{{name: "ZRT X"}}
		named, unnamed := parseActivations(rows)
		attachActivations(zones, named, unnamed)
		return zones[0].activations
	}
	for _, c := range []struct {
		name  string
		lines []string
		want  []activation
	}{
		{"178/2026", []string{
			"- Du 07 septembre 2026 au 25 septembre 2026 H24 tous les jours sauf Samedi, Dimanche Activable par NOTAM",
			"avec préavis de 48 h conformément aux dispositions complémentaires",
		}, []activation{{date: "2026-09-07", dateTo: "2026-09-25", dayRule: dayRule{days: 1<<1 | 1<<2 | 1<<3 | 1<<4 | 1<<5}, status: byNotam(48 * 60)}}},
		{"a_099/2026", []string{
			"- Du 16 juin 2026 à 1000 au 17 juin 2026 à 1430 - Détail des créneaux pour chaque zone dans le tableau ci-dessus",
			"- Le 18 juin 2026 de 1000 à 1430 Activable par NOTAM avec préavis de 24 h",
		}, []activation{
			{date: "2026-06-16", from: "10:00", to: "24:00", envelope: true},
			{date: "2026-06-17", from: "00:00", to: "14:30", envelope: true},
			{date: "2026-06-18", from: "10:00", to: "14:30", status: byNotam(24 * 60)},
		}},
	} {
		if got := read(c.lines...); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s =\n  %+v\nwant\n  %+v", c.name, got, c.want)
		}
	}
}

// TestHourLater: a time stated in summer UTC moves an hour later in
// winter, its days and weekdays with an opening past midnight.
func TestHourLater(t *testing.T) {
	in := activation{date: "2026-11-02", dateTo: "2026-11-30", from: "23:30", to: "01:00", dayRule: dayRule{days: 1 << 1}}
	want := activation{date: "2026-11-03", dateTo: "2026-12-01", from: "00:30", to: "02:00", dayRule: dayRule{days: 1 << 2}, dayShift: 1}
	if got := hourLater(in); got != want {
		t.Errorf("hourLater(%+v) = %+v, want %+v", in, got, want)
	}
}

// TestDaySetMoved: weekdays moved across the week's ends.
func TestDaySetMoved(t *testing.T) {
	for _, c := range []struct {
		in   daySet
		n    int
		want daySet
	}{
		{1<<1 | 1<<5, -1, 1<<7 | 1<<4},
		{1<<7 | 1<<6, 1, 1<<1 | 1<<7},
		{0, -1, 0},
		{1 << 3, 7, 1 << 3},
	} {
		if got := c.in.moved(c.n); got != c.want {
			t.Errorf("%07b.moved(%d) = %07b, want %07b", c.in>>1, c.n, got>>1, c.want>>1)
		}
	}
}

// TestActivationsSeasonMovesWeekdays: a bullet's window opening the evening
// before in summer opens on the weekdays before its own, and a weekly
// stretch it prints keeps its midnights.
func TestActivationsSeasonMovesWeekdays(t *testing.T) {
	for _, c := range []struct {
		name string
		row  string
		want []activation
	}{
		{"a night slot on weekdays", "- Du 01 juin 2027 au 30 juin 2027 de 0000 à 0400 du lundi au vendredi (ETE : -1HR)",
			[]activation{{date: "2027-05-31", dateTo: "2027-06-29", from: "23:00", to: "03:00", dayRule: dayRule{days: 1<<7 | 1<<1 | 1<<2 | 1<<3 | 1<<4}, dayShift: -1}}},
		{"a weekly stretch across the spring change", "- Du 22 mars 2027 au 05 avril 2027 du lundi 11h00 au vendredi 11h00 (ETE : -1HR)",
			[]activation{
				{date: "2027-03-22", dateTo: "2027-03-27", from: "11:00", to: "00:00", dayRule: dayRule{days: 1 << 1}, cuts: cutClose},
				{date: "2027-03-28", dateTo: "2027-04-05", from: "10:00", to: "00:00", dayRule: dayRule{days: 1 << 1}, cuts: cutClose},
				{date: "2027-03-22", dateTo: "2027-04-05", dayRule: dayRule{days: 1<<2 | 1<<3 | 1<<4}, cuts: cutOpen | cutClose},
				{date: "2027-03-22", dateTo: "2027-03-28", from: "00:00", to: "11:00", dayRule: dayRule{days: 1 << 5}, cuts: cutOpen},
				{date: "2027-03-29", dateTo: "2027-04-05", from: "00:00", to: "10:00", dayRule: dayRule{days: 1 << 5}, cuts: cutOpen},
			}},
	} {
		rows := []prow{
			row(30, cell{0, "DATES ET HEURES D'ACTIVITÉ"}),
			row(29, cell{0, "ZRT X"}),
			row(28, cell{0, c.row}),
			row(1, cell{0, "INFORMATION DES USAGERS"}),
		}
		zones := []zone{{name: "ZRT X"}}
		named, unnamed := parseActivations(rows)
		attachActivations(zones, named, unnamed)
		if got := actsFor(zones, "ZRT X"); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: ZRT X =\n  %+v\nwant\n  %+v", c.name, got, c.want)
		}
	}
}

// TestActivationsOnlyDaysOff: a row whose every date a clause takes off
// leaves the weekday hours above it standing. 094/2025 as poppler reads it,
// its cover giving the year.
func TestActivationsOnlyDaysOff(t *testing.T) {
	rows := []prow{row(200, cell{0, "Envigueur: Dujeudi05juin2025aumercredi14avril2027"})}
	for i, text := range []string{
		"DATESETHEURESD’ACTIVITÉ",
		"ZRTDSVROMORANTINALPHA,BRAVO,CHARLIE,DELTAactivables:",
		"Dulundiauvendredisauflesjoursfériés:",
		"-Soit0800-1100et1900-2359;ETE–1HR",
		"-Soit1200-1600et1900-2359;ETE–1HR",
		"Informationscomplémentaires:",
		"♦Levendrediestunejournéedereport.",
		"♦4semaines /anàl’exclusion delapériodedu01/07au15/09.",
		"♦Prévisiond’activitéparNOTAMavecunpréavisde48heures.",
		"INFORMATIONDESUSAGERS",
	} {
		rows = append(rows, row(float64(100-i), cell{0, text}))
	}
	zones := []zone{{name: "ZRT DSV ROMORANTIN ALPHA"}}
	named, unnamed := parseActivations(rows)
	attachActivations(zones, named, unnamed)
	weekdays := dayRule{days: 1<<1 | 1<<2 | 1<<3 | 1<<4 | 1<<5, exceptHolidays: true}
	st := status{mode: modeActivable, noticeMin: 48 * 60}
	want := []activation{
		{from: "08:00", to: "11:00", dayRule: weekdays, status: st, season: summerEarlier},
		{from: "19:00", to: "23:59", dayRule: weekdays, status: st, season: summerEarlier},
		{from: "12:00", to: "16:00", dayRule: weekdays, status: st, season: summerEarlier},
	}
	z := zones[0]
	if len(z.activations) > 0 || !reflect.DeepEqual(z.standing, want) {
		t.Errorf("ZRT DSV ROMORANTIN ALPHA: dated %+v, standing\n  %+v\nwant none and\n  %+v", z.activations, z.standing, want)
	}
}

// TestActivationsStretchInEnvelope: 166/2026 as the native reader rebuilds
// it. BUCK BRAVO's weekly stretch, held in the envelope's days, keeps the
// status "sont activables" gives every zone and its midnights in summer.
func TestActivationsStretchInEnvelope(t *testing.T) {
	rows := []prow{row(200, cell{0, "DATESETHEURESD'ACTIVIT\uFFFD"})}
	for i, text := range []string{
		"LesZRTBUCKALPHA1,ALPHA2,BRAVO1etBRAVO2sontactivables",
		"ZRTBUCKALPHA1:",
		"Du26octobre2026au26mars2027:dulundi11h00auvendredi11h00",
		"ZRTBUCKBRAVO1etBRAVO2:",
		"Dulundi11h00auvendredi11h00( horaires\uFFFDt\uFFFD:-01h00)",
		"TOUTESLESZONES",
		"- Du17ao\uFFFDt2026au14avril2027H24 touslesjourssaufSamedi,Dimancheetjoursf\uFFFDri\uFFFDs ActivableparNOTAM",
		"avecpr\uFFFDavisde72hpendantlescr\uFFFDneauxhorairesd\uFFFDtaill\uFFFDsci-dessus",
		"INFORMATIONDESUSAGERS",
	} {
		rows = append(rows, row(float64(199-i), cell{0, text}))
	}
	zones := []zone{{name: "ZRT BUCK ALPHA 1"}, {name: "ZRT BUCK BRAVO 1"}}
	named, unnamed := parseActivations(rows)
	attachActivations(zones, named, unnamed)
	st := status{mode: modeActivable, noticeMin: 72 * 60}
	mon, between, fri := dayRule{days: 1 << 1}, dayRule{days: 1<<2 | 1<<3 | 1<<4}, dayRule{days: 1 << 5}
	want := []activation{
		{date: "2026-08-17", dateTo: "2026-10-24", from: "10:00", to: "00:00", dayRule: mon, status: st, cuts: cutClose},
		{date: "2026-10-25", dateTo: "2027-03-27", from: "11:00", to: "00:00", dayRule: mon, status: st, cuts: cutClose},
		{date: "2027-03-28", dateTo: "2027-04-14", from: "10:00", to: "00:00", dayRule: mon, status: st, cuts: cutClose},
		{date: "2026-08-17", dateTo: "2027-04-14", dayRule: between, status: st, cuts: cutOpen | cutClose},
		{date: "2026-08-17", dateTo: "2026-10-24", from: "00:00", to: "10:00", dayRule: fri, status: st, cuts: cutOpen},
		{date: "2026-10-25", dateTo: "2027-03-28", from: "00:00", to: "11:00", dayRule: fri, status: st, cuts: cutOpen},
		{date: "2027-03-29", dateTo: "2027-04-14", from: "00:00", to: "10:00", dayRule: fri, status: st, cuts: cutOpen},
	}
	if got := actsFor(zones, "ZRT BUCK BRAVO 1"); !reflect.DeepEqual(got, want) {
		t.Errorf("ZRT BUCK BRAVO 1 =\n  %+v\nwant\n  %+v", got, want)
	}
	for _, a := range actsFor(zones, "ZRT BUCK ALPHA 1") {
		if a.status != st {
			t.Errorf("ZRT BUCK ALPHA 1 %s..%s status = %+v, want %+v", a.date, a.dateTo, a.status, st)
		}
	}
}
