// enumerate.go decides WHICH documents a pack holds, and reads that
// decision out of the committed datasets rather than off the SIA site.
//
// That is the whole point of sourcing it here: the app derives a plate's
// name from the same fr-adcharts.json membership column and a supplement's
// from the same fr-supaip.json row, so a pack and the panel that reads it
// cannot disagree about what exists. Scraping the site again would open
// exactly that gap.

package main

import (
	"fmt"
	"path"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
)

// docRef is one document to fetch and pack: the name it will answer to
// inside the pack, and where to get it.
type docRef struct {
	Name string
	URL  string
}

// vacRow is the part of an fr-adcharts.json row this command reads.
type vacRow struct {
	Ident string
	Vac   aip.VacKind
}

// supRow is the part of an fr-supaip.json row this command reads.
type supRow struct {
	ID        string
	URLPdf    string
	URLPdfEn  string
	ValidFrom string
	ValidTo   string
}

// vacDocs lists every Atlas VAC plate of one AIRAC cycle. An ident filed as
// "both" carries a plate in each product and yields two documents, which is
// why the count exceeds the number of rows that have any membership at all.
func vacDocs(rows []vacRow, effective time.Time) []docRef {
	var out []docRef
	for _, r := range rows {
		for _, section := range aip.SIAVacSections(r.Vac) {
			out = append(out, docRef{
				Name: aip.SIAVacPlateName(r.Ident, section),
				URL:  aip.SIAVacPlateURL(effective, r.Ident, section),
			})
		}
	}
	return out
}

// supDocs lists the AIP supplements worth carrying, in one language.
//
// The selection is "not lapsed": in force today, plus the ones that come
// into force later. A supplement published for next month is exactly what a
// pilot preparing that flight needs, and the dataset is cumulative, so
// without this clause the pack would also carry a decade of dead paper.
//
// A row with no PDF in the wanted language falls back to the other, which
// is what the panel's own FR / EN links do; seven metropolitan supplements
// have no English translation, and an English pack that silently omitted
// them would be missing live restrictions.
func supDocs(rows []supRow, lang string, today string) []docRef {
	var out []docRef
	for _, r := range rows {
		if r.ValidTo != "" && r.ValidTo < today {
			continue
		}
		url := r.URLPdf
		if lang == "en" {
			url = r.URLPdfEn
		}
		if url == "" {
			// The other language, since a supplement in force is worth
			// carrying in a language the pilot can read at all.
			if lang == "en" {
				url = r.URLPdf
			} else {
				url = r.URLPdfEn
			}
		}
		if url == "" {
			continue
		}
		out = append(out, docRef{Name: path.Base(url), URL: url})
	}
	return out
}

func loadVacRows(path string) ([]vacRow, error) {
	p, err := aip.ReadPositional(path)
	if err != nil {
		return nil, err
	}
	if err := p.Require("icao"); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	out := make([]vacRow, 0, len(p.Rows))
	for _, row := range p.Rows {
		ident := p.Str(row, "icao")
		vac := p.Str(row, "vac")
		if ident == "" || vac == aip.VacNone {
			continue
		}
		out = append(out, vacRow{Ident: ident, Vac: vac})
	}
	return out, nil
}

func loadSupRows(path string) ([]supRow, error) {
	p, err := aip.ReadPositional(path)
	if err != nil {
		return nil, err
	}
	if err := p.Require("id", "urlPdf", "validTo"); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	out := make([]supRow, 0, len(p.Rows))
	for _, row := range p.Rows {
		out = append(out, supRow{
			ID:        p.Str(row, "id"),
			URLPdf:    p.Str(row, "urlPdf"),
			URLPdfEn:  p.Str(row, "urlPdfEn"),
			ValidFrom: p.Str(row, "validFrom"),
			ValidTo:   p.Str(row, "validTo"),
		})
	}
	return out, nil
}
