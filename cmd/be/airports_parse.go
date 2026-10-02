// airports_parse.go: the per-aerodrome AD 2 pages and per-heliport AD 3
// pages → aixm5.Airport features, the CTR airspaces their AD x.17 "ATS
// Airspace" tables publish, and the chart links their AD 2.24 / AD 3.23
// tables list. The ICAO readers (the sections, the runways, the radios,
// the directory rows) are internal/eaip's ad2.go, lifted from here; what
// stays is Belgian: the page names, the AD x.17 volume ids and the chart
// links pinned to eAIP_Main.

package main

import (
	"github.com/0intro/loxodrome/internal/eaip"
	"regexp"
	"strings"

	"github.com/0intro/loxodrome/internal/aixm5"
)

// chartRef is one AD chart link (VAC / ADC / IAC / ...), emitted into the
// be-airports rows as the trailing "charts" column.
type chartRef struct {
	Code  string
	Title string
	URL   string
}

// adParse is the result of one publication tree's AD pages.
type adParse struct {
	airports []aixm5.Airport
	ctrs     []aixm5.Airspace
	charts   map[string][]chartRef
}

var adPageNameRe = regexp.MustCompile(`^EB-AD-([23])\.([A-Z0-9]{4})-en-GB\.html$`)

// parseAirportPages walks every AD 2 / AD 3 page of the tree.
func parseAirportPages(t *tree, border *eaip.BorderRing, st *eaip.ZoneStats) adParse {
	res := adParse{charts: map[string][]chartRef{}}
	for _, page := range t.adPages() {
		m := adPageNameRe.FindStringSubmatch(strings.TrimPrefix(page, "eAIP/"))
		if m == nil {
			continue
		}
		doc := t.doc(page)
		if doc == nil {
			continue
		}
		icao := m[2]
		adType := "AD"
		chartSec := "24"
		if m[1] == "3" {
			adType = "HP"
			chartSec = "23"
		}
		secs := eaip.ADSectionTables(doc, icao)

		ap := aixm5.Airport{
			ID:         icao,
			Designator: icao,
			Type:       adType,
			Name:       eaip.ADName(doc, icao),
		}
		mil := eaip.IsMilitaryName(ap.Name)
		ap.Military = mil
		if mil {
			ap.ControlType = "MILITARY"
			ap.Access = "restricted"
		} else {
			ap.ControlType = "CIVIL"
			ap.Access = "cap"
		}

		// "ARP coordinates" on the full AD 2 pages; the AD 3 heliport and
		// the reduced ULM AD 2 pages label the row plain "Coordinates".
		arp := eaip.DocLabelled(doc, "ARP COORDINATES")
		if arp == "" {
			arp = eaip.DocLabelled(doc, "COORDINATES")
		}
		if lat, lon, ok := eaip.FirstCoord(arp); ok {
			ap.Lat, ap.Lon = lat, lon
		}
		if v := eaip.DocLabelled(doc, "ELEVATION"); v != "" {
			if ft, ok := eaip.ParseFtInt(v); ok {
				elev := eaip.FtToM(float64(ft))
				ap.ElevM = &elev
			}
		}
		if v := eaip.DocLabelled(doc, "TYPES OF TRAFFIC PERMITTED"); v != "" {
			up := strings.ToUpper(v)
			ap.VFR = strings.Contains(up, "VFR")
			ap.IFR = strings.Contains(up, "IFR")
		}
		if v := eaip.DocLabelled(doc, "TRANSITION ALTITUDE"); v != "" {
			if ft, ok := eaip.ParseFtInt(v); ok {
				ta := eaip.FtToM(float64(ft))
				ap.TransitionAltM = &ta
			}
		}
		if ap.Lat == 0 && ap.Lon == 0 {
			continue // a page without an ARP is a stub
		}

		eaip.ParseFacilityDetail(doc, &ap)
		ap.Runways = eaip.ParseRunways(secs["12"], secs["13"])
		ap.Radio = eaip.ParseComTable(secs["18"])
		res.ctrs = append(res.ctrs, parseAtsAirspace(secs["17"], border, st)...)
		if charts := parseChartTable(secs[chartSec]); len(charts) > 0 {
			res.charts[icao] = charts
		}
		res.airports = append(res.airports, ap)
	}
	return res
}

// --- ATS airspace (AD x.17) ----------------------------------------------

// parseAtsAirspace reads the AD 2.17 table(s): the CTR (occasionally
// several volumes) an aerodrome publishes.
func parseAtsAirspace(tables []*eaip.Node, border *eaip.BorderRing, st *eaip.ZoneStats) []aixm5.Airspace {
	var out []aixm5.Airspace
	for _, table := range tables {
		desig := eaip.LabelledAfter(table, "DESIGNATION")
		lat := eaip.LabelledAfter(table, "LATERAL LIMITS")
		if desig == "" || lat == "" {
			continue
		}
		typ := ""
		up := " " + strings.ToUpper(desig) + " "
		switch {
		case strings.Contains(up, " CTR "):
			typ = "CTR"
		case strings.Contains(up, " ATZ "):
			typ = "ATZ"
		case strings.Contains(up, " RMZ "):
			typ = "RMZ"
		case strings.Contains(up, " TMZ "):
			typ = "TMZ"
		default:
			st.SkippedTypes[skipKey(desig)]++
			continue
		}
		upper, lower := eaip.ParseVerticalPair(eaip.LabelledAfter(table, "VERTICAL LIMITS"))
		if lower == nil {
			// The AD 2.17 tables print a single value ("2 500 FT AMSL"):
			// the ceiling of a surface-based volume.
			lower = &aixm5.VerticalLimit{Value: "GND"}
		}
		out = append(out, aixm5.Airspace{
			ID:         "BE-" + slug(desig),
			Designator: "BE-" + slug(desig),
			Name:       strings.TrimSpace(desig),
			Type:       typ,
			ClassCode:  classLetter(eaip.LabelledAfter(table, "AIRSPACE CLASS")),
			UpperLimit: upper,
			LowerLimit: lower,
			Ring:       eaip.ParseBoundary(lat, border, &st.Boundary),
			WorkHr:     eaip.LabelledAfter(table, "HOURS OF ACTIVATION"),
		})
	}
	return out
}

// --- charts (AD 2.24 / AD 3.23) -------------------------------------------

var chartFileRe = regexp.MustCompile(`graphics/eAIP/([A-Za-z0-9._-]+\.pdf)$`)

var (
	// Civil naming: EBAW_VAC01_v30.pdf. Military naming:
	// EB_AD_2_EBBE_ADC_01_en_v19.pdf.
	chartCodeCivRe = regexp.MustCompile(`^[A-Z0-9]{4}_([A-Za-z]+)`)
	chartCodeMilRe = regexp.MustCompile(`^EB_AD_[23]_[A-Z0-9]{4}_([A-Za-z]+)`)
)

// parseChartTable reads the "Charts related to ..." tables. Each chart is
// TWO rows (a rowspanned reference cell + the title cell, then the link
// row whose eaip.Anchor text is the raw relative path), so the title is carried
// from the preceding row when the eaip.Anchor row has none. URLs are
// absolutized onto the eAIP_Main base regardless of which tree served the
// page, so links stored in the .next dataset don't rot when the AIRAC
// flips.
func parseChartTable(tables []*eaip.Node) []chartRef {
	var out []chartRef
	seen := map[string]bool{}
	for _, table := range tables {
		prevTitle := ""
		for _, tr := range eaip.TableRows(table) {
			var file string
			for _, a := range eaip.AnchorsIn(tr) {
				if m := chartFileRe.FindStringSubmatch(a.Href); m != nil {
					file = m[1]
					break
				}
			}
			if file == "" {
				if title := chartTitle(tr); title != "" {
					prevTitle = title
				}
				continue
			}
			if seen[file] {
				continue
			}
			seen[file] = true
			title := chartTitle(tr)
			if title == "" {
				title = prevTitle
			}
			prevTitle = ""
			out = append(out, chartRef{
				Code:  chartCode(file),
				Title: title,
				URL:   eaipBase + slotMain + "/graphics/eAIP/" + file,
			})
		}
	}
	return out
}

// chartCode derives the chart family from the filename stem
// ("EBAW_VAC01_v30.pdf" / "EB_AD_2_EBBE_ADC_01_en_v19.pdf" → VAC / ADC).
func chartCode(file string) string {
	if m := chartCodeMilRe.FindStringSubmatch(file); m != nil {
		return strings.ToUpper(m[1])
	}
	if m := chartCodeCivRe.FindStringSubmatch(file); m != nil {
		return strings.ToUpper(m[1])
	}
	return ""
}

// chartTitle picks the descriptive cell of a chart row ("Visual Approach
// Chart - ICAO"): the longest cell that is neither a file path nor the
// "AD 2.XXXX-YYY.01" reference token. "" when the row has none (the
// link-only rows).
func chartTitle(tr *eaip.Node) string {
	best := ""
	for _, c := range eaip.RowCells(tr) {
		text := eaip.NodeText(c)
		if text == "" || strings.Contains(text, ".pdf") || strings.HasPrefix(text, "AD ") {
			continue
		}
		if len(text) > len(best) {
			best = text
		}
	}
	return best
}
