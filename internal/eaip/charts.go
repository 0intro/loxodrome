// charts.go reads an aerodrome's chart list, the "CHARTS RELATED TO AN
// AERODROME" table of AD 2.24 (AD 3.23 for a heliport), into link-only
// rows: each chart's family, its title as published, and the publisher's
// own PDF. Nothing is copied: the app links the file where the publisher
// serves it (docs/aip-sources.md, "Chart links are not copies").
//
// Every package in the cohort prints the table, in three row shapes that
// one rule reads. Slovakia and Fintraffic put the title and the link in
// one row; SMATSA and NATS a title-only row and then a link-only row; and
// AirNav Ireland a title cell spanning two rows, the second holding the
// link. So a row's title is its own non-link cell where it has one, else
// the title row before it.

package eaip

import (
	"net/url"
	"path"
	"regexp"
	"strings"
)

// Chart is one chart an aerodrome's charts section lists.
type Chart struct {
	// Code is the chart family (ChartFamily), "MISC" when unknown.
	Code string
	// Title is the chart's name as the table prints it.
	Title string
	// URL is the PDF, absolute.
	URL string
}

// chartsHeadRe recognises the charts section's heading: ICAO's "CHARTS
// RELATED TO AN AERODROME" (AD 2.24) or "TO A HELIPORT" (AD 3.23), in
// whatever case a State prints it, Avians with no article and EANS with
// the aerodrome's name ("Charts Related to the Lennart Meri Tallinn
// Aerodrome"). Only headings and short rows are tested, so the words in
// a paragraph cannot open the section.
var chartsHeadRe = regexp.MustCompile(`(?i)\bCHARTS\s+RELATED\s+TO\b`)

// sectionHeadRe recognises an AD 2 / AD 3 subsection number, or a VFR
// package's AD 4; one other than the charts section's own is where that
// section ends. The charts' own number recurs inside it as a page
// reference ("BKPR AD 2.24-19").
var sectionHeadRe = regexp.MustCompile(`(?i)\bAD\s*([234])[\s.-]+(\d{1,2})\b`)

// endsCharts reports a heading opening a subsection other than the
// charts' own (AD 2.24, AD 3.23; an AD 3 may number it 3.24, and PANSA's
// AD 4 numbers it 4.13).
func endsCharts(heading string) bool {
	for _, m := range sectionHeadRe.FindAllStringSubmatch(heading, -1) {
		if !(m[1] == "2" && m[2] == "24") && !(m[1] == "3" && (m[2] == "23" || m[2] == "24")) && !(m[1] == "4" && m[2] == "13") {
			return true
		}
	}
	return false
}

// ParseAerodromeCharts reads the charts section of an aerodrome page,
// resolving each link against the page's own URL. text is how a cell is
// read (NodeText, or EnglishText for a bilingual publisher).
func ParseAerodromeCharts(doc *Node, pageURL string, text func(*Node) string) []Chart {
	base, err := url.Parse(pageURL)
	if err != nil {
		return nil
	}
	// Walk the document in order: headings and table rows, the section
	// starting at its heading and ending at the next subsection's. A
	// heading may be an h4 (EUROCONTROL) or a row of the table itself
	// (IDS AIRNAV), so both are tested.
	rows := expandedRows(doc)
	var out []Chart
	seen := map[string]bool{}
	in := false
	pending := ""
	for _, r := range rows {
		if r.heading != "" {
			switch {
			case chartsHeadRe.MatchString(r.heading):
				in = true
				pending = ""
				continue
			case in && endsCharts(r.heading):
				// The section ends, but the walk goes on: a table of
				// contents at the head of the page names the heading too,
				// and the real table comes later.
				in = false
				continue
			}
			if r.cells == nil {
				continue
			}
		}
		if !in {
			continue
		}
		if r.anchor != nil {
			// A link standing outside any row, labelled by the text before
			// it: KANS lists its chart titles in the table and gives each
			// file as "AERODROME_HELIPORT_CHART_ICAO <link>" below it.
			if u, err := base.Parse(strings.TrimSpace(Attr(r.anchor, "href"))); err == nil && !seen[u.String()] {
				seen[u.String()] = true
				title := r.label
				if title == "" {
					title = pending
				}
				title = cleanTitle(title)
				out = append(out, Chart{Code: ChartFamily(title, path.Base(u.Path)), Title: title, URL: u.String()})
			}
			continue
		}
		if r.cells == nil {
			continue
		}
		links := pdfLinks(r.cells)
		if len(links) == 0 {
			if t := rowTitle(r.cells, text); t != "" {
				pending = t
			}
			continue
		}
		for _, a := range links {
			href := strings.TrimSpace(Attr(a.node, "href"))
			u, err := base.Parse(href)
			if err != nil || seen[u.String()] {
				continue
			}
			seen[u.String()] = true
			// The title: another cell of the row (Slovakia, Ireland), else
			// the link's own cell unless all it prints is the file's path
			// (Fintraffic's "ADC", KANS's heading), else the title row
			// before it (SMATSA), else the file's name.
			title := titleBeside(r.cells, a.cell, text)
			if title == "" {
				// The link's own cell, less the links' texts: LGS sets the
				// title and every version's link in one cell.
				if t := cellTitle(a.cell, text); t != "" {
					title = t
				} else if t := NormSpace(strings.TrimSpace(text(a.node))); t != "" && !looksLikePath(t) {
					title = t
				}
			}
			if title == "" {
				title = pending
			}
			if title == "" {
				title = strings.TrimSuffix(path.Base(u.Path), path.Ext(u.Path))
			}
			title = cleanTitle(title)
			out = append(out, Chart{
				Code:  ChartFamily(title, path.Base(u.Path)),
				Title: title,
				URL:   u.String(),
			})
		}
		// The title row stays in force over the rows under it: Slovenia
		// Control gives a chart's second sheet a link row and no title.
	}
	return out
}

// docRow is one step of the document walk: a heading, a table row
// expanded against its table's spans, both (a row whose text is a
// heading), or a PDF link outside any row read as one, with its label.
type docRow struct {
	heading string
	cells   []*Node
	anchor  *Node
	label   string
}

// expandedRows lists the headings and table rows of a document in order.
// A row holding a nested table is not a row of charts (a layout wrapper),
// so its nested rows are listed instead.
func expandedRows(doc *Node) []docRow {
	grids := map[*Node][]*Node{}
	var out []docRow
	var rec func(n *Node)
	rec = func(n *Node) {
		if skipSubtree(n) {
			return
		}
		if IsElem(n) {
			switch {
			case isHeadingTag(n.Data):
				out = append(out, docRow{heading: NormSpace(NodeText(n))})
				return
			case n.Data == "table":
				cells := ExpandCells(n)
				for i, tr := range TableRows(n) {
					if i < len(cells) {
						grids[tr] = cells[i]
					}
				}
			case n.Data == "tr":
				if len(NestedTables(n)) == 0 {
					cells := grids[n]
					row := docRow{cells: cells}
					if t := NormSpace(NodeText(n)); len(t) < 160 && (chartsHeadRe.MatchString(t) || sectionHeadRe.MatchString(t)) && len(pdfLinks(cells)) == 0 {
						row.heading = t
					}
					out = append(out, row)
					return
				}
			case n.Data == "a" && isPDFHref(Attr(n, "href")):
				out = append(out, docRow{anchor: n, label: anchorLabel(n)})
				return
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			rec(c)
		}
	}
	rec(doc)
	return out
}

type pdfLink struct {
	node, cell *Node
}

// cellTitle is a cell's text less the texts of the PDF links in it.
func cellTitle(cell *Node, text func(*Node) string) string {
	full := NormSpace(strings.TrimSpace(text(cell)))
	for _, a := range Elems(cell, "a") {
		if isPDFHref(Attr(a, "href")) {
			if t := NormSpace(strings.TrimSpace(NodeText(a))); t != "" {
				full = strings.Replace(full, t, " ", 1)
			}
		}
	}
	full = strings.Join(strings.Fields(full), " ")
	if looksLikePath(full) || crossRefRe.MatchString(full) {
		return ""
	}
	return full
}

// crossRefRe is what a cross-reference leaves once its link is taken
// out: LFV points a field at a chart another aerodrome publishes, "See
// <Area Chart - ICAO STOCKHOLM TMA> (ESSA STOCKHOLM-ARLANDA 5)", and the
// page it names is no title.
var crossRefRe = regexp.MustCompile(`(?i)^(?:see\s*)?(?:\([^()]*\))?\s*\.?$`)

// looksLikePath reports a cell printing a file's path or name rather
// than a title ("../graphics/eAIP/7116087_LY_AD_2_LYBE_01-1-1_en.pdf").
func looksLikePath(s string) bool {
	return strings.Contains(s, "/") || strings.HasSuffix(strings.ToLower(s), ".pdf")
}

// cleanTitle reads a title as words: KANS names its charts after their
// files ("AIRCRAFT_PARKING_DOCKING_CHART_ICAO"), and LGS numbers them
// after ICAO Annex 4 ("14. Visual Approach Chart - ICAO").
func cleanTitle(s string) string {
	s = strings.Join(strings.Fields(NormSpace(strings.ReplaceAll(s, "_", " "))), " ")
	return seePrefixRe.ReplaceAllString(annexNumberRe.ReplaceAllString(s, ""), "")
}

// annexNumberRe is the chart number an LGS title opens with.
var annexNumberRe = regexp.MustCompile(`^\d{1,2}\.\s+`)

// seePrefixRe is the "See" of a cross-reference whose link is the whole
// sentence ("See ESGG Area Chart - ICAO GÖTEBORG TMA").
var seePrefixRe = regexp.MustCompile(`(?i)^see\s+`)

// isPDFHref reports a link to a PDF file.
func isPDFHref(href string) bool {
	href = strings.ToLower(strings.TrimSpace(href))
	if i := strings.IndexAny(href, "?#"); i >= 0 {
		href = href[:i]
	}
	return strings.HasSuffix(href, ".pdf")
}

// anchorLabel is the text its parent prints before a link, underscores
// read as spaces ("AERODROME_HELIPORT_CHART_ICAO").
func anchorLabel(a *Node) string {
	if a.Parent == nil {
		return ""
	}
	var b strings.Builder
	for c := a.Parent.FirstChild; c != nil && c != a; c = c.NextSibling {
		b.WriteString(NodeText(c))
		b.WriteByte(' ')
	}
	return NormSpace(strings.Join(strings.Fields(strings.ReplaceAll(b.String(), "_", " ")), " "))
}

// pdfLinks returns a row's links to PDF files, each with the cell holding
// it, once per cell however many columns the cell spans.
func pdfLinks(cells []*Node) []pdfLink {
	var out []pdfLink
	seen := map[*Node]bool{}
	for _, c := range cells {
		if c == nil || seen[c] {
			continue
		}
		seen[c] = true
		for _, a := range Elems(c, "a") {
			if isPDFHref(Attr(a, "href")) {
				out = append(out, pdfLink{node: a, cell: c})
			}
		}
	}
	return out
}

// rowTitle is the text of a title-only row, its cells joined once each.
func rowTitle(cells []*Node, text func(*Node) string) string {
	var parts []string
	seen := map[*Node]bool{}
	for _, c := range cells {
		if c == nil || seen[c] {
			continue
		}
		seen[c] = true
		// Slovenia Control and BHANSA set the page reference before the
		// title ("LJCE AD 2.24.01-1 | Aerodrome Chart - ICAO").
		if t := NormSpace(strings.TrimSpace(text(c))); t != "" && !pageRefRe.MatchString(t) {
			parts = append(parts, t)
		}
	}
	if len(parts) == 0 {
		return ""
	}
	// ICAO's column heads ("Name", "Page", "Charts") are no title.
	joined := strings.Join(parts, " ")
	if chartColumnHeadRe.MatchString(joined) {
		return ""
	}
	return parts[0]
}

// chartColumnHeadRe is the head row of the charts table.
var chartColumnHeadRe = regexp.MustCompile(`(?i)^(?:chart\s+name|name|charts?)(?:\s+(?:page|pages))?$`)

// titleBeside is the first non-empty cell of the row other than the one
// holding the link: the title in Slovakia's and Ireland's shapes.
func titleBeside(cells []*Node, linkCell *Node, text func(*Node) string) string {
	seen := map[*Node]bool{linkCell: true}
	for _, c := range cells {
		if c == nil || seen[c] {
			continue
		}
		seen[c] = true
		t := NormSpace(strings.TrimSpace(text(c)))
		if t != "" && !pageRefRe.MatchString(t) {
			return t
		}
	}
	return ""
}

// pageRefRe is a page reference printed beside a title, which is no
// title: "AD 2-LZIB-2-1", "AD 2.EIWT-24-1", "LQBK AD 2.24.01-1".
var pageRefRe = regexp.MustCompile(`(?i)^(?:[A-Z0-9]{4}\s+)?AD\s*[23][\s.-]`)

// chartFamilyRule is one keyword test of ChartFamily. The first rule
// whose pattern the upper-cased title matches wins, so the specific come
// before the general.
type chartFamilyRule struct {
	re   *regexp.Regexp
	code string
}

func familyRule(pattern, code string) chartFamilyRule {
	return chartFamilyRule{re: regexp.MustCompile(pattern), code: code}
}

// chartFamilyRules map a title onto the families the app labels and
// orders (CHART_FAMILY_ORDER in src/lib/data/airports.ts, chartFamilies in
// the i18n catalogs). Descriptive titles first, as NATS and most of the
// cohort print them, then the abbreviations Fintraffic heads its rows
// with ("ADC", "AOC RWY 12/30", "ILS Z or LOC Z RWY 30").
var chartFamilyRules = []chartFamilyRule{
	// Coding tables and data blocks are text, whatever procedure they
	// annex.
	familyRule(`CODING|\bCODES\b|FAS DATA|DATA BLOCK|WAYPOINTS? AND FIXES|WAYPOINT (?:LIST|COORDINATES)|\bWPT\b`, "DATA"),
	// The VFR family before the aerodrome chart: "VISUAL APPROACH CHART",
	// "CHART FOR VFR FLIGHTS", "VFR ARRIVAL/DEPARTURE", "VISUAL REFERENCE
	// POINTS", a helicopter's "LANDING CHART".
	familyRule(`VISUAL APPROACH|\bVFR\b|VISUAL (?:REFERENCE|ROUTE|OPERATION)|\bVAC\b|LANDING CHART|HELICOPTER (?:ROUTE|APPROACH)`, "VAC"),
	// An "AERODROME CHART ..." is the aerodrome chart family even when its
	// title mentions ground movement (the A380 / code E / F variants).
	familyRule(`AERODROME CHART|HELIPORT CHART|\bADC\b`, "ADC"),
	familyRule(`GROUND MOVEMENT|\bA?GMC\b|\bTAXI(?:ING)? ROUTES?\b|\bTAXI\b`, "GMC"),
	familyRule(`PARKING|DOCKING|\bA?PDC\b`, "APDC"),
	// "ATC ... MINIMUM ALTITUDE" whatever the middle word's spelling
	// (ROMATSA prints "Surveillnace" at one aerodrome).
	familyRule(`SURVEILLANCE MINIMUM|ATC\s*SMAC|\bSMAC\b|\bATC\b.*\bMINIMUM ALTITUDE`, "ATCSMAC"),
	familyRule(`OBSTACLE|\bAOC[AB]?\b`, "AOC"),
	familyRule(`PRECISION APPROACH TERRAIN|\bPATC\b`, "PATC"),
	familyRule(`OMNI[\s-]?DIRECTIONAL (?:AND VISUAL )?DEPARTURE`, "DEP"),
	// A departure or arrival chart is a SID or a STAR however the title
	// qualifies it (ROMATSA's "RNAV Departure Chart RWY 27", which the
	// approach rule below would otherwise take for its RNAV); the visual
	// ones were taken by the VFR rule above.
	familyRule(`STANDARD DEPARTURE|STANDARD INSTRUMENT DEPARTURE|\(SID\)|\bSID\b|\bDEPARTURE CHART`, "SID"),
	familyRule(`STANDARD ARRIVAL|STANDARD INSTRUMENT ARRIVAL|\(STAR\)|\bSTAR\b|\bARRIVAL CHART`, "STAR"),
	familyRule(`INSTRUMENT APPROACH|INITIAL APPROACH|APPROACH TRANSITION|APPROACH CHART|\bIAC\b|\b(?:ILS|LOC|VOR|NDB|RNP|RNAV|GNSS|GLS|LNAV|DME|TACAN|PAR|SRA)\b`, "IAC"),
	familyRule(`AREA CHART|\bARC\b|\b(?:TMA|TIA|CTA) CHART\b`, "ARC"),
}

// fileFamilyRe reads the family some publishers type into the file name
// ("EF_AD_2_EFJY_VAC.pdf"), the fallback when the title says nothing.
var fileFamilyRe = regexp.MustCompile(`(?i)[_-](VAC|ADC|AOC|GMC|APDC|PATC|SID|STAR|IAC|ATCSMAC|ARC)(?:[_-]|\.pdf$)`)

// ChartFamily resolves a chart to its family from its title, then from
// its file name, "MISC" when neither says (control-zone charts, noise
// routeings, local flying areas and the like).
func ChartFamily(title, file string) string {
	u := strings.ToUpper(cleanTitle(title))
	for _, r := range chartFamilyRules {
		if r.re.MatchString(u) {
			return r.code
		}
	}
	if m := fileFamilyRe.FindStringSubmatch(file); m != nil {
		return strings.ToUpper(m[1])
	}
	return "MISC"
}
