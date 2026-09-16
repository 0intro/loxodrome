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
