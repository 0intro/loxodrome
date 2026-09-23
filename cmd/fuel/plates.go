// plates.go reads the Atlas VAC plates.
//
// Which plates exist is aip.ReadVacRows' answer, out of the committed
// fr-adcharts.json, so this command, the offline pack and the georeference
// cannot disagree about the atlas. The bytes come from the cache
// cmd/aipdocs already filled; nothing here fetches.
//
// The text comes from poppler's pdftotext and NOT from the walker
// cmd/vacgeo carries. Seventeen of the 419 aerodrome plates embed
// Identity-H CID fonts (LFBG LFBY LFJA LFMC LFMI LFMY LFOJ LFPR LFQE LFQP
// LFRH LFTF LFTH LFXA LFXB LFYR LFYS), sixteen of them on the very page
// holding item 10, and rsc.io/pdf maps that encoding to a nop decoder;
// worse, the walker advances the text matrix one byte at a time, so a
// two-byte font breaks the run positions as well as the glyphs. Those
// seventeen are the military and state fields, which is to say the F-34 /
// F-35 / TR.0 rows: precisely the ones worth getting right.

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/pdftext"
)

// plateItem is one plate's avitaillement entry.
type plateItem struct {
	Ident   string
	Section int
	Body    string
	End     itemEnd
}

// plateStats is what the sidecar reports about the reading pass.
type plateStats struct {
	Plates    int `json:"plates"`    // plates the atlas lists and the cache holds
	Missing   int `json:"missing"`   // listed but absent from the cache
	WithItem  int `json:"withItem"`  // carrying a "10 - AVT" entry
	NoItem    int `json:"noItem"`    // no numbered list at all
	CutByPage int `json:"cutByPage"` // entry terminated by a page break
}

// readPlates extracts the avitaillement entry from every plate of the
// cycle. A missing pdftotext is fatal rather than degraded: without it this
// command would quietly write a dataset holding only the AIXM half, and the
// app would forget some three hundred aerodromes with nothing to say so.
// That is the opposite of internal/pdftext's own fail-open posture, and the
// difference is deliberate.
func readPlates(dir string, rows []aip.VacRow, keep func(string) bool) ([]plateItem, plateStats, error) {
	var out []plateItem
	var st plateStats
	checked := false
	for _, r := range rows {
		if !keep(r.Ident) {
			continue
		}
		for _, section := range aip.SIAVacSections(r.Vac) {
			path := filepath.Join(dir, aip.SIAVacPlateName(r.Ident, section))
			data, err := os.ReadFile(path)
			if err != nil {
				st.Missing++
				continue
			}
			st.Plates++
			text, err := pdftext.Run(data, "-layout", "-", "-")
			if err != nil {
				if !checked {
					return nil, st, fmt.Errorf("reading %s: %w (poppler-utils is required; "+
						"without it this command would write the AIXM half alone)", path, err)
				}
				return nil, st, fmt.Errorf("reading %s: %w", path, err)
			}
			checked = true
			body, end, ok := avtItem(string(text))
			if !ok {
				st.NoItem++
				continue
			}
			st.WithItem++
			if end == endPage {
				st.CutByPage++
			}
			out = append(out, plateItem{Ident: r.Ident, Section: section, Body: body, End: end})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Ident != out[j].Ident {
			return out[i].Ident < out[j].Ident
		}
		return out[i].Section < out[j].Section
	})
	return out, st, nil
}
