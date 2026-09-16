// airports_parse.go: the per-aerodrome AD 2 pages and per-heliport AD 3
// pages → aixm5.Airport features, the CTR airspaces their AD x.17 "ATS
// Airspace" tables publish, and the chart links their AD 2.24 / AD 3.23
// tables list.
//
// Section scoping rides the eAIP eaip.Anchor convention: every section heading
// carries an id like "EBAW-AD-2.17"; each table belongs to the section
// whose eaip.Anchor precedes it in document order.

package main

import (
	"github.com/0intro/loxodrome/internal/eaip"
	"regexp"
	"strconv"
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
func parseAirportPages(t *tree, border *eaip.BorderRing, st *enrStats) adParse {
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
		secs := adSectionTables(doc, icao)

		ap := aixm5.Airport{
			ID:         icao,
			Designator: icao,
			Type:       adType,
			Name:       adName(doc, icao),
		}
		mil := milNameRe.MatchString(strings.ToUpper(ap.Name))
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
		arp := docLabelled(doc, "ARP COORDINATES")
		if arp == "" {
			arp = docLabelled(doc, "COORDINATES")
		}
		if lat, lon, ok := eaip.FirstCoord(arp); ok {
			ap.Lat, ap.Lon = lat, lon
		}
		if v := docLabelled(doc, "ELEVATION"); v != "" {
			if ft, ok := eaip.ParseFtInt(v); ok {
				elev := eaip.FtToM(float64(ft))
				ap.ElevM = &elev
			}
		}
		if v := docLabelled(doc, "TYPES OF TRAFFIC PERMITTED"); v != "" {
			up := strings.ToUpper(v)
			ap.VFR = strings.Contains(up, "VFR")
			ap.IFR = strings.Contains(up, "IFR")
		}
		if v := docLabelled(doc, "TRANSITION ALTITUDE"); v != "" {
			if ft, ok := eaip.ParseFtInt(v); ok {
				ta := eaip.FtToM(float64(ft))
				ap.TransitionAltM = &ta
			}
		}
		if ap.Lat == 0 && ap.Lon == 0 {
			continue // a page without an ARP is a stub
		}

		parseFacilityDetail(doc, &ap)
		ap.Runways = parseRunways(secs["12"], secs["13"])
		ap.Radio = parseComTable(secs["18"])
		res.ctrs = append(res.ctrs, parseAtsAirspace(secs["17"], border, st)...)
		if charts := parseChartTable(secs[chartSec]); len(charts) > 0 {
			res.charts[icao] = charts
		}
		res.airports = append(res.airports, ap)
	}
	return res
}

// adSectionTables groups a page's tables by the AD section eaip.Anchor
// ("EBAW-AD-2.17" → key "17") that precedes them in document order.
func adSectionTables(doc *eaip.Node, icao string) map[string][]*eaip.Node {
	secRe := regexp.MustCompile(`^` + icao + `-AD-[23]\.(\d+)$`)
	out := map[string][]*eaip.Node{}
	current := ""
	var rec func(*eaip.Node)
	rec = func(n *eaip.Node) {
		if eaip.IsElem(n) {
			if m := secRe.FindStringSubmatch(eaip.Attr(n, "id")); m != nil {
				current = m[1]
			}
			if n.Data == "table" && current != "" {
				out[current] = append(out[current], n)
				return // tables never nest sections
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			rec(c)
		}
	}
	rec(doc)
	return out
}

// milNameRe spots the "(MIL)" marker in an aerodrome name; eaip.NodeText's
// per-node spacing can print it "( MIL )".
var milNameRe = regexp.MustCompile(`\(\s*MIL\s*\)`)

// adName extracts the aerodrome name from the page's ADName heading
// ("EBSP — SPA (LA SAUVENIERE)" → "SPA (LA SAUVENIERE)").
func adName(doc *eaip.Node, icao string) string {
	for _, n := range eaip.FindAll(doc, func(x *eaip.Node) bool { return eaip.HasClass(x, "ADName") }) {
		name := eaip.NodeText(n)
		name = strings.TrimSpace(strings.TrimPrefix(name, icao))
		name = strings.TrimSpace(strings.TrimLeft(name, "-— "))
		name = strings.ReplaceAll(name, "( ", "(")
		name = strings.ReplaceAll(name, " )", ")")
		if name != "" {
			return name
		}
	}
	return icao
}

// docLabelled returns the first cell following a cell whose text begins
// with label (case-insensitive), across every table of the page in
// document order.
func docLabelled(doc *eaip.Node, label string) string {
	for _, table := range eaip.Elems(doc, "table") {
		if v := labelledPrefix(table, label); v != "" {
			return v
		}
	}
	return ""
}

// labelledPrefix is eaip.LabelledCell with prefix matching.
func labelledPrefix(table *eaip.Node, label string) string {
	for _, tr := range eaip.TableRows(table) {
		cells := eaip.RowCells(tr)
		for i, c := range cells {
			if strings.HasPrefix(strings.ToUpper(eaip.NodeText(c)), label) && i+1 < len(cells) {
				return eaip.NodeText(cells[i+1])
			}
		}
	}
	return ""
}

// --- runways ----------------------------------------------------------------

var (
	rwyDesigRe = regexp.MustCompile(`^(\d{2})([LRC]?)$`)
	// dimRe tolerates the eAIP's grouped thousands ("1 510 x 45").
	dimRe = regexp.MustCompile(`(\d[\d ]*)\s*[xX]\s*(\d[\d ]*)`)
)

// rwyEnd is one AD 2.12 direction row.
type rwyEnd struct {
	desig   string
	lengthM *float64
	widthM  *float64
	surface string
	tora    *float64
	toda    *float64
	asda    *float64
	lda     *float64
}

// parseRunways joins AD 2.12 (physical characteristics, one row per
// direction) with AD 2.13 (declared distances) into aixm5 runways.
func parseRunways(physTables, declTables []*eaip.Node) []aixm5.Runway {
	ends := map[string]*rwyEnd{}
	var order []string
	for _, table := range physTables {
		for _, row := range eaip.ExpandTable(table) {
			if len(row) < 3 {
				continue
			}
			desig := strings.TrimSpace(row[0])
			if !rwyDesigRe.MatchString(desig) {
				continue
			}
			e := ends[desig]
			if e == nil {
				e = &rwyEnd{desig: desig}
				ends[desig] = e
				order = append(order, desig)
			}
			joined := eaip.NormSpace(strings.Join(row[1:], " | "))
			if m := dimRe.FindStringSubmatch(joined); m != nil && e.lengthM == nil {
				if l, err := strconv.ParseFloat(ungroup(m[1]), 64); err == nil {
					e.lengthM = &l
				}
				if w, err := strconv.ParseFloat(ungroup(m[2]), 64); err == nil {
					e.widthM = &w
				}
			}
			if e.surface == "" {
				e.surface = surfaceToken(joined)
			}
		}
	}
	for _, table := range declTables {
		matrix := eaip.ExpandTable(table)
		// Only the full declared-distances table qualifies; the sibling
		// intersection-TORA tables (ELLX "RWY | From | TORA") would
		// otherwise overwrite the full-length figures.
		if !declaredHeader(matrix) {
			continue
		}
		seen := map[string]bool{}
		for _, row := range matrix {
			if len(row) < 2 {
				continue
			}
			desig := strings.TrimSpace(row[0])
			e := ends[desig]
			if e == nil || !rwyDesigRe.MatchString(desig) || seen[desig] {
				continue
			}
			seen[desig] = true
			vals := make([]*float64, 0, 4)
			for _, cell := range row[1:] {
				vals = append(vals, metresVal(cell))
				if len(vals) == 4 {
					break
				}
			}
			for len(vals) < 4 {
				vals = append(vals, nil)
			}
			// AD 2.13 column order: TORA, TODA, ASDA, LDA.
			e.tora, e.toda, e.asda, e.lda = vals[0], vals[1], vals[2], vals[3]
		}
	}

	used := map[string]bool{}
	var out []aixm5.Runway
	for _, d := range order {
		if used[d] {
			continue
		}
		le := ends[d]
		// Stray designator-looking cells elsewhere in the section (sub-row
		// numbering, strip tables) carry no data: skip them.
		if le.lengthM == nil && le.surface == "" && le.tora == nil && le.lda == nil {
			used[d] = true
			continue
		}
		used[d] = true
		r := aixm5.Runway{
			Designator: le.desig,
			Le:         le.desig,
			LengthM:    le.lengthM,
			WidthM:     le.widthM,
			Surface:    le.surface,
			LeToraM:    le.tora,
			LeTodaM:    le.toda,
			LeAsdaM:    le.asda,
			LeLdaM:     le.lda,
		}
		if he := ends[reciprocal(le.desig)]; he != nil && !used[he.desig] {
			used[he.desig] = true
			r.He = he.desig
			r.Designator = le.desig + "/" + he.desig
			r.HeToraM, r.HeTodaM, r.HeAsdaM, r.HeLdaM = he.tora, he.toda, he.asda, he.lda
			if r.LengthM == nil {
				r.LengthM = he.lengthM
			}
			if r.Surface == "" {
				r.Surface = he.surface
			}
		}
		out = append(out, r)
	}
	return out
}

// reciprocal returns the opposite runway designator ("08" → "26",
// "07L" → "25R").
func reciprocal(d string) string {
	m := rwyDesigRe.FindStringSubmatch(d)
	if m == nil {
		return ""
	}
	n, _ := strconv.Atoi(m[1])
	n = (n+17)%36 + 1
	side := m[2]
	switch side {
	case "L":
		side = "R"
	case "R":
		side = "L"
	}
	return twoDigits(n) + side
}

func twoDigits(n int) string {
	if n < 10 {
		return "0" + strconv.Itoa(n)
	}
	return strconv.Itoa(n)
}

// declaredHeader reports whether a matrix is the full AD 2.13 table
// (TORA + LDA columns present).
func declaredHeader(matrix [][]string) bool {
	for _, row := range matrix {
		joined := strings.ToUpper(strings.Join(row, " "))
		if strings.Contains(joined, "TORA") && strings.Contains(joined, "LDA") {
			return true
		}
	}
	return false
}

// ungroup strips the grouped-thousands spaces from a digit run.
func ungroup(s string) string {
	return strings.ReplaceAll(strings.TrimSpace(s), " ", "")
}

// metresVal parses one declared-distance cell (metres). nil for "NU",
// dashes, footnoted values, or blanks.
func metresVal(s string) *float64 {
	v, err := strconv.ParseFloat(ungroup(eaip.NormSpace(s)), 64)
	if err != nil || v <= 0 {
		return nil
	}
	return &v
}

// surfaceToken maps the AD 2.12 strength-and-surface prose onto the AIXM
// composition tokens the SPA's formatSurface / isHardSurface understand.
func surfaceToken(s string) string {
	up := strings.ToUpper(s)
	switch {
	case strings.Contains(up, "ASPH"):
		return "ASPH"
	case strings.Contains(up, "CONC"):
		return "CONC"
	case strings.Contains(up, "GRASS"):
		return "GRASS"
	case strings.Contains(up, "PAVED"):
		return "ASPH"
	case strings.Contains(up, "SAND"):
		return "SAND"
	case strings.Contains(up, "WATER"):
		return "WATER"
	case strings.Contains(up, "GRAVEL"):
		return "GRAVE"
	}
	return ""
}

// --- COM (AD 2.18) ------------------------------------------------------

// parseComTable reads the ATS Communication Facilities table into raw
// RadioChannels: Unit carries the normalized AIXM 5.1 service-type code so
// aixm5.CurateAirportRadios' allowlist applies unchanged.
func parseComTable(tables []*eaip.Node) []aixm5.RadioChannel {
	var out []aixm5.RadioChannel
	for _, table := range tables {
		matrix := eaip.ExpandTable(table)
		for _, row := range matrix {
			if len(row) < 3 {
				continue
			}
			service := strings.TrimSpace(row[0])
			if service == "" || strings.EqualFold(service, "Service designation") || service == "1" {
				continue
			}
			callSign := strings.TrimSpace(row[1])
			for _, freq := range eaip.FreqsComVHF(row[2]) {
				out = append(out, aixm5.RadioChannel{
					Freq:     freq,
					Unit:     serviceCode(service),
					CallSign: callSign,
				})
			}
		}
	}
	return out
}

// serviceCode normalizes a Belgian AD 2.18 service designation onto the
// AIXM 5.1 service-type vocabulary CurateAirportRadios curates
// (airportradio.go's allowlist). Unknown designations map to OTHER, which
// the curator keeps only for air-ground "... RADIO" call signs.
func serviceCode(designation string) string {
	up := strings.ToUpper(designation)
	switch {
	case strings.Contains(up, "ATIS"):
		return "ATIS"
	case strings.Contains(up, "AFIS"):
		return "AFIS"
	case strings.Contains(up, "APP") || strings.Contains(up, "APPROACH") || strings.Contains(up, "ARRIVAL") || strings.Contains(up, "RADAR"):
		return "APP"
	case strings.Contains(up, "TWR") || strings.Contains(up, "TOWER"):
		return "TWR"
	case strings.Contains(up, "GND") || strings.Contains(up, "GROUND"):
		return "GND"
	case strings.Contains(up, "DEL") || strings.Contains(up, "DELIVERY") || strings.Contains(up, "CLEARANCE"):
		return "DEL"
	case strings.Contains(up, "FIS") || strings.Contains(up, "INFO"):
		return "FIS"
	case strings.Contains(up, "ACS") || strings.Contains(up, "ACC") || strings.Contains(up, "CTL") || strings.Contains(up, "CONTROL"):
		return "ACS"
	}
	return "OTHER"
}

// --- ATS airspace (AD x.17) ----------------------------------------------

// parseAtsAirspace reads the AD 2.17 table(s): the CTR (occasionally
// several volumes) an aerodrome publishes.
func parseAtsAirspace(tables []*eaip.Node, border *eaip.BorderRing, st *enrStats) []aixm5.Airspace {
	var out []aixm5.Airspace
	for _, table := range tables {
		desig := labelledPrefix(table, "DESIGNATION")
		lat := labelledPrefix(table, "LATERAL LIMITS")
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
			st.skippedTypes[skipKey(desig)]++
			continue
		}
		upper, lower := eaip.ParseVerticalPair(labelledPrefix(table, "VERTICAL LIMITS"))
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
			ClassCode:  classLetter(labelledPrefix(table, "AIRSPACE CLASS")),
			UpperLimit: upper,
			LowerLimit: lower,
			Ring:       eaip.ParseBoundary(lat, border, &st.boundary),
			WorkHr:     labelledPrefix(table, "HOURS OF ACTIVATION"),
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
