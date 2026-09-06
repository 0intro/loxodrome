// supaip_listing.go: read the ENAIRE supplement listings.
//
// https://aip.enaire.es/AIP/Suplementos-es.html and its -en twin are
// static tables, one <tr> per supplement in force or announced, with
// semantic cell classes (id / CM / wef1 / wef2 / desc / iconos). Both
// languages are read: the Spanish listing gives the subject the panel
// shows under a Spanish UI, the English one its twin, joined by number
// and year.
//
// Links are taken VERBATIM and never derived. The filenames carry the
// AIRAC infix on some supplements (LE_SUP_A_2026_149) and not on others,
// the number is zero-padded inconsistently (LE_SUP_2026_03 beside
// LE_SUP_2026_047), and a supplement whose Spanish edition was never
// published links its English one from the Spanish listing. Deriving a
// URL from the row's own number would 404 on all three.

package main

import (
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/0intro/loxodrome/internal/eaip"
)

const esAipBase = "https://aip.enaire.es/AIP/"

var (
	esSupNumYearRe = regexp.MustCompile(`(\d{1,3})\s*/\s*(\d{2,4})`)
	esSupWefRe     = regexp.MustCompile(`(?i)WEF\s+(\d{1,2})-([A-Z]{3})-(\d{2,4})`)
	esIcaoRe       = regexp.MustCompile(`\b(?:LE|GC)[A-Z]{2}\b`)
)

// esListingRow is one supplement as the listings describe it, before its
// body is read.
type esListingRow struct {
	number, year int
	subjectEs    string
	subjectEn    string
	urlEs        string // Spanish HTML edition, "" when none is published
	urlEn        string // English HTML edition
	pdfEs        string
	pdfEn        string
	inForce      bool
	airac        bool
	wef          string // ISO date from the FUTURO tooltip, "" when in force
}

// id is the dataset id: es-<year>-<NNN>.
func (r esListingRow) id() string {
	return "es-" + strconv.Itoa(r.year) + "-" + pad3(r.number)
}

func (r esListingRow) title() string {
	return pad3(r.number) + "/" + strconv.Itoa(r.year)
}

// bodyURL is the document the geometry is read from: the Spanish HTML
// edition, else the English one, else the English PDF (the five oldest
// supplements have no HTML edition at all).
func (r esListingRow) bodyURL() string {
	switch {
	case r.urlEs != "":
		return r.urlEs
	case r.urlEn != "":
		return r.urlEn
	case r.pdfEn != "":
		return r.pdfEn
	default:
		return r.pdfEs
	}
}

func pad3(n int) string {
	s := strconv.Itoa(n)
	for len(s) < 3 {
		s = "0" + s
	}
	return s
}

// parseEsListings reads both listings and joins them by number/year. A
// supplement present in only one listing still ships, with the other
// language's subject empty.
func parseEsListings(esDoc, enDoc *eaip.Node) ([]esListingRow, []string) {
	var warns []string
	byKey := map[[2]int]*esListingRow{}
	var order [][2]int

	take := func(doc *eaip.Node, spanish bool) {
		for _, row := range listingRows(doc) {
			key := [2]int{row.year, row.number}
			cur, ok := byKey[key]
			if !ok {
				cur = &esListingRow{number: row.number, year: row.year}
				byKey[key] = cur
				order = append(order, key)
			} else if spanish && cur.subjectEs != "" {
				warns = append(warns, "duplicate-row-"+cur.id())
				continue
			}
			if spanish {
				cur.subjectEs = row.subjectEs
				cur.inForce = row.inForce
				cur.airac = row.airac
				cur.wef = row.wef
			} else if cur.subjectEn == "" {
				cur.subjectEn = row.subjectEs
				if cur.subjectEs == "" {
					// English-only row: keep the listing state too.
					cur.inForce = row.inForce
					cur.airac = row.airac
					cur.wef = row.wef
				}
			}
			// Links from either listing, first non-empty wins.
			if cur.urlEs == "" {
				cur.urlEs = row.urlEs
			}
			if cur.urlEn == "" {
				cur.urlEn = row.urlEn
			}
			if cur.pdfEs == "" {
				cur.pdfEs = row.pdfEs
			}
			if cur.pdfEn == "" {
				cur.pdfEn = row.pdfEn
			}
		}
	}
	take(esDoc, true)
	take(enDoc, false)

	sort.Slice(order, func(i, j int) bool {
		if order[i][0] != order[j][0] {
			return order[i][0] < order[j][0]
		}
		return order[i][1] < order[j][1]
	})
	out := make([]esListingRow, 0, len(order))
	for _, k := range order {
		out = append(out, *byKey[k])
	}
	return out, warns
}

// listingRows reads one listing document. The subject cell of a row read
// from the English listing lands in subjectEs; the caller re-files it.
func listingRows(doc *eaip.Node) []esListingRow {
	if doc == nil {
		return nil
	}
	var out []esListingRow
	for _, tr := range eaip.Elems(doc, "tr") {
		var idCell, wef1, wef2, desc *eaip.Node
		for _, td := range eaip.Elems(tr, "td") {
			switch {
			case eaip.HasClass(td, "id"):
				idCell = td
			case eaip.HasClass(td, "wef1"):
				wef1 = td
			case eaip.HasClass(td, "wef2"):
				wef2 = td
			case eaip.HasClass(td, "desc"):
				desc = td
			}
		}
		if idCell == nil {
			continue
		}
		// NodeText flattens the NUEVO and change-marker spans.
		m := esSupNumYearRe.FindStringSubmatch(eaip.NodeText(idCell))
		if m == nil {
			continue
		}
		num, _ := strconv.Atoi(m[1])
		year := yearOf(m[2])
		if num == 0 || year == 0 {
			continue
		}
		row := esListingRow{number: num, year: year}
		if desc != nil {
			row.subjectEs = eaip.NodeText(desc)
		}
		if wef1 != nil {
			t := eaip.NodeText(wef1)
			row.inForce = !strings.Contains(fold(t), "futuro") && !strings.Contains(fold(t), "future")
			if w := esSupWefRe.FindStringSubmatch(t); w != nil {
				row.wef = isoFromDMY(w[1], w[2], w[3])
			}
		}
		if wef2 != nil {
			row.airac = strings.Contains(fold(eaip.NodeText(wef2)), "airac")
		}
		for _, a := range eaip.AnchorsIn(tr) {
			href := strings.TrimSpace(a.Href)
			if href == "" || !strings.Contains(href, "contenido_SUP/") {
				continue
			}
			abs := href
			if !strings.HasPrefix(abs, "http") {
				abs = esAipBase + strings.TrimPrefix(abs, "/")
			}
			english := strings.Contains(href, "_en.")
			switch {
			case strings.HasSuffix(href, ".pdf") && english:
				row.pdfEn = abs
			case strings.HasSuffix(href, ".pdf"):
				row.pdfEs = abs
			case strings.HasSuffix(href, ".html") && english:
				row.urlEn = abs
			case strings.HasSuffix(href, ".html"):
				row.urlEs = abs
			}
		}
		out = append(out, row)
	}
	return out
}

// yearOf expands the listing's two-digit years ("26" -> 2026).
func yearOf(s string) int {
	n, err := strconv.Atoi(s)
	if err != nil {
		return 0
	}
	if n < 100 {
		n += 2000
	}
	if n < 2000 || n > 2100 {
		return 0
	}
	return n
}

var esMonthNum = map[string]string{
	"JAN": "01", "FEB": "02", "MAR": "03", "APR": "04", "MAY": "05", "JUN": "06",
	"JUL": "07", "AUG": "08", "SEP": "09", "OCT": "10", "NOV": "11", "DEC": "12",
	// The Spanish editions print the month in Spanish.
	"ENE": "01", "ABR": "04", "AGO": "08", "DIC": "12",
}

// isoFromDMY builds YYYY-MM-DD from a "01", "OCT", "26" triple.
func isoFromDMY(day, mon, year string) string {
	mm, ok := esMonthNum[strings.ToUpper(mon)]
	if !ok {
		return ""
	}
	y := yearOf(year)
	if y == 0 {
		return ""
	}
	if len(day) == 1 {
		day = "0" + day
	}
	return strconv.Itoa(y) + "-" + mm + "-" + day
}
