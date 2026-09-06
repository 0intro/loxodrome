// enumerate.go decides WHICH plates this command reads, and takes that
// decision out of the committed fr-adcharts.json rather than off the SIA
// site or the plate cache's directory listing.
//
// It is the same membership column cmd/aipdocs packs from and the same one
// the app reads to decide whether an aerodrome has a plate at all, so the
// dataset, the offline pack and this georeference cannot disagree about
// which plates exist.

package main

import (
	"fmt"

	"github.com/0intro/loxodrome/internal/aip"
)

// vacRow is the part of an fr-adcharts.json row this command reads.
type vacRow struct {
	Ident string
	Vac   aip.VacKind
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
