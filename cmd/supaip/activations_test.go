package main

import (
	"reflect"
	"testing"
)

// row builds a prow from (x, text) cell pairs.
func row(y float64, cells ...cell) prow { return prow{y: y, cells: cells} }

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

	want1 := []activation{{"2026-06-11", "", "12:00", "18:00"}, {"2026-06-12", "", "06:00", "18:00"}}
	if got := actsFor(zones, "TMA 1 X Temporaire"); !reflect.DeepEqual(got, want1) {
		t.Errorf("TMA 1 = %v, want %v", got, want1)
	}
	want2 := []activation{{"2026-06-11", "", "09:00", "11:00"}, {"2026-06-12", "", "06:00", "08:00"}}
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

	want := []activation{{"2026-02-16", "2026-04-30", "08:15", "22:00"}}
	for _, n := range []string{"ZRT ARMANCON ALPHA", "ZRT SEINE", "ZRT ORNAIN ALPHA"} {
		if got := actsFor(zones, n); !reflect.DeepEqual(got, want) {
			t.Errorf("%s = %v, want %v", n, got, want)
		}
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

	want := []activation{{"2026-06-11", "", "12:00", "18:00"}}
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
		{"2026-06-11", "", "08:00", "12:00"},
		{"2026-06-11", "", "13:30", "17:00"},
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
		{"2026-06-11", "", "06:00", "08:00"},
		{"2026-06-11", "", "12:00", "18:00"},
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
		{"2026-06-11", "", "08:00", "09:00"}, {"2026-06-11", "", "10:00", "11:00"},
		{"2026-06-12", "", "10:00", "11:00"}, {"2026-06-12", "", "12:00", "13:00"},
	}
	if got := actsFor(zones, "ZRT A"); !reflect.DeepEqual(got, want) {
		t.Errorf("ZRT A = %v, want %v", got, want)
	}
}
