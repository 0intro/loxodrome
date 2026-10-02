// enumerate.go decides WHICH plates this command reads, and takes that
// decision out of the committed fr-adcharts.json rather than off the SIA
// site or the plate cache's directory listing.
//
// It is the same membership column cmd/aipdocs packs from and the same one
// the app reads to decide whether an aerodrome has a plate at all, so the
// dataset, the offline pack and this georeference cannot disagree about
// which plates exist. The reader itself is aip.ReadVacRows, shared with the
// other two commands that walk the atlas.

package main

import (
	"github.com/0intro/loxodrome/internal/aip"
)

func loadVacRows(path string) ([]aip.VacRow, error) {
	return aip.ReadVacRows(path)
}
