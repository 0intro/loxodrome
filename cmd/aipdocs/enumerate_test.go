package main

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
)

// dataDir is the committed datasets, which the enumeration reads in
// production too: pinning against the real files is what catches a column
// rename in cmd/adcharts or cmd/supaip before a pack ships without it.
const dataDir = "../../public/data"

func TestVacDocsCoversBothProducts(t *testing.T) {
	effective := time.Date(2026, time.August, 6, 0, 0, 0, 0, time.UTC)
	rows := []vacRow{
		{Ident: "LFPN", Vac: aip.VacAD},
		{Ident: "LF075", Vac: aip.VacHel},
		{Ident: "LFPO", Vac: aip.VacBoth},
		{Ident: "LFXX", Vac: aip.VacNone},
	}
	docs := vacDocs(rows, effective)

	// "both" yields two plates, "none" yields none: 1 + 1 + 2 + 0.
	if len(docs) != 4 {
		t.Fatalf("got %d documents, want 4: %+v", len(docs), docs)
	}
	byName := map[string]string{}
	for _, d := range docs {
		byName[d.Name] = d.URL
	}
	for _, want := range []string{"AD-2.LFPN.pdf", "AD-3.LF075.pdf", "AD-2.LFPO.pdf", "AD-3.LFPO.pdf"} {
		if _, ok := byName[want]; !ok {
			t.Errorf("missing %s", want)
		}
	}
	// The URL carries the cycle and the product directory, which is what
	// makes a pack valid for exactly one AIRAC cycle.
	got := byName["AD-2.LFPN.pdf"]
	want := "https://www.sia.aviation-civile.gouv.fr/media/dvd/eAIP_06_AUG_2026/" +
		"Atlas-VAC/PDF_AIPparSSection/VAC/AD/AD-2.LFPN.pdf"
	if got != want {
		t.Errorf("plate URL\n got %s\nwant %s", got, want)
	}
	if hel := byName["AD-3.LF075.pdf"]; hel != "https://www.sia.aviation-civile.gouv.fr/media/dvd/"+
		"eAIP_06_AUG_2026/Atlas-VAC/PDF_AIPparSSection/VACH/AD/AD-3.LF075.pdf" {
		t.Errorf("helistation URL = %s", hel)
	}
}

// The committed dataset has to yield the plate count the app's own panel
// derives from the same column: 419 aerodrome plates and 237 helistation
// ones on the 2026-08-06 cycle.
func TestVacDocsAgainstCommittedDataset(t *testing.T) {
	rows, err := loadVacRows(filepath.Join(dataDir, "fr-adcharts.json"))
	if err != nil {
		t.Fatal(err)
	}
	effective, err := aip.ReadEffective(filepath.Join(dataDir, "fr-adcharts.meta.json"))
	if err != nil {
		t.Fatal(err)
	}
	docs := vacDocs(rows, effective)

	var ad, hel int
	seen := map[string]bool{}
	for _, d := range docs {
		if seen[d.Name] {
			t.Errorf("duplicate entry name %s", d.Name)
		}
		seen[d.Name] = true
		switch {
		case len(d.Name) > 4 && d.Name[:4] == "AD-2":
			ad++
		case len(d.Name) > 4 && d.Name[:4] == "AD-3":
			hel++
		default:
			t.Errorf("unexpected entry name %s", d.Name)
		}
	}
	if ad < 300 || hel < 150 {
		t.Errorf("got %d aerodrome and %d helistation plates, want at least the "+
			"sanity floors cmd/adcharts enforces (300 / 150)", ad, hel)
	}
	t.Logf("Atlas VAC: %d aerodrome + %d helistation = %d plates", ad, hel, len(docs))
}

func TestSupDocsSelection(t *testing.T) {
	rows := []supRow{
		{ID: "in-force", URLPdf: "https://x/a_fr.pdf", URLPdfEn: "https://x/a_en.pdf",
			ValidFrom: "2026-01-01", ValidTo: "2026-12-31"},
		{ID: "lapsed", URLPdf: "https://x/b_fr.pdf", ValidFrom: "2024-01-01", ValidTo: "2026-08-15"},
		{ID: "upcoming", URLPdf: "https://x/c_fr.pdf", ValidFrom: "2026-09-01", ValidTo: "2027-01-01"},
		{ID: "open-ended", URLPdf: "https://x/d_fr.pdf", ValidFrom: "2026-01-01", ValidTo: ""},
		{ID: "no-pdf", URLPdf: "", URLPdfEn: "", ValidTo: "2027-01-01"},
	}
	today := "2026-08-16"

	fr := supDocs(rows, "fr", today)
	var names []string
	for _, d := range fr {
		names = append(names, d.Name)
	}
	want := []string{"a_fr.pdf", "c_fr.pdf", "d_fr.pdf"}
	if len(names) != len(want) {
		t.Fatalf("french set = %v, want %v", names, want)
	}
	for i, n := range names {
		if n != want[i] {
			t.Errorf("french set = %v, want %v", names, want)
			break
		}
	}

	// A row with no translation falls back rather than dropping out: a
	// supplement in force is worth carrying in whichever language exists.
	en := supDocs(rows, "en", today)
	var enNames []string
	for _, d := range en {
		enNames = append(enNames, d.Name)
	}
	wantEn := []string{"a_en.pdf", "c_fr.pdf", "d_fr.pdf"}
	for i, n := range enNames {
		if i >= len(wantEn) || n != wantEn[i] {
			t.Errorf("english set = %v, want %v", enNames, wantEn)
			break
		}
	}
}

func TestSupDocsAgainstCommittedDataset(t *testing.T) {
	rows, err := loadSupRows(filepath.Join(dataDir, "fr-supaip.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) < 100 {
		t.Fatalf("only %d supplement rows, dataset looks wrong", len(rows))
	}
	today := time.Now().UTC().Format("2006-01-02")
	fr := supDocs(rows, "fr", today)
	if len(fr) == 0 || len(fr) >= len(rows) {
		t.Errorf("selected %d of %d supplements; the cumulative dataset must be "+
			"narrowed to the ones not lapsed", len(fr), len(rows))
	}
	seen := map[string]bool{}
	for _, d := range fr {
		if seen[d.Name] {
			t.Errorf("duplicate entry name %s", d.Name)
		}
		seen[d.Name] = true
	}
	t.Logf("SUP AIP: %d of %d supplements carried", len(fr), len(rows))
}

// A column read by position would shift silently the day cmd/supaip or
// cmd/adcharts inserts one; the loaders resolve by name, and a missing
// column is an error rather than an empty pack.
func TestLoadersRejectAnUnexpectedSchema(t *testing.T) {
	if _, err := loadVacRows(filepath.Join(dataDir, "fr-supaip.json")); err == nil {
		t.Error("loading the supplement artifact as VAC rows should fail")
	}
	if _, err := loadSupRows(filepath.Join(dataDir, "fr-adcharts.json")); err == nil {
		t.Error("loading the chart artifact as supplement rows should fail")
	}
}
