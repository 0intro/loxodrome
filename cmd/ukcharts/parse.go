// parse.go reads the NATS eAIP: the aerodrome menu, and each aerodrome
// page's "CHARTS RELATED TO AN AERODROME" (AD 2.24 / AD 3.23) table.
//
// The UK table lists each chart across two rows: a title-only row
// ("AERODROME CHART - ICAO") followed by a link-only row whose anchor
// text is the sheet reference and whose href is an opaque per-amendment
// PDF (graphics/487994.pdf). The families therefore come from the titles,
// mapped by keyword, not from the filenames (unlike the SIA's
// AD_2_<ICAO>_<FAMILY> scheme).

package main

import (
	"regexp"
	"sort"
	"strings"
)

// adPageRe finds the per-aerodrome page names in the eAIP menu
// (EG-AD-2.<ICAO>-en-GB.html; AD 3 for the heliports).
var adPageRe = regexp.MustCompile(`EG-AD-([23])\.([A-Z]{4})-en-GB\.html`)

// parseMenu extracts the unique aerodrome pages from the eAIP menu HTML,
// sorted by ICAO for a deterministic fetch order.
func parseMenu(html []byte) []adPage {
	seen := map[string]adPage{}
	for _, m := range adPageRe.FindAllSubmatch(html, -1) {
		icao := string(m[2])
		if _, ok := seen[icao]; ok {
			continue
		}
		section := 2
		if string(m[1]) == "3" {
			section = 3
		}
		seen[icao] = adPage{ICAO: icao, Section: section}
	}
	pages := make([]adPage, 0, len(seen))
	for _, p := range seen {
		pages = append(pages, p)
	}
	sort.Slice(pages, func(i, j int) bool { return pages[i].ICAO < pages[j].ICAO })
	return pages
}

var (
	// chartsSectionRe marks the start of the charts table: "AN AERODROME"
	// for AD 2, "A HELIPORT" for the AD 3 heliports.
	chartsSectionRe = regexp.MustCompile(`(?i)CHARTS RELATED TO A`)
	// rowRe splits the table into <tr> rows.
	rowRe = regexp.MustCompile(`(?is)<tr\b[^>]*>(.*?)</tr>`)
	// titleRe reads a title-only row's <p> text.
	titleRe = regexp.MustCompile(`(?is)<p\b[^>]*>(.*?)</p>`)
	// chartHrefRe reads a link-only row's chart PDF, relative to the eAIP
	// html directory ("../../graphics/487994.pdf"); the stored path is
	// normalised to "graphics/487994.pdf" against the AIRAC root.
	chartHrefRe = regexp.MustCompile(`(?i)href="[^"]*(graphics/\d+\.pdf)"`)
	tagRe       = regexp.MustCompile(`<[^>]+>`)
	wsRe        = regexp.MustCompile(`\s+`)
)

// parseCharts extracts one aerodrome's chart references in publication
// order. It walks the charts table pairing each title row with the link
// row that follows it; a title with no following link, or a link with no
// preceding title, is skipped.
func parseCharts(html []byte) []chartRef {
	s := string(html)
	i := chartsSectionRe.FindStringIndex(s)
	if i == nil {
		return nil
	}
	body := s[i[1]:]

	var charts []chartRef
	seen := map[string]bool{}
	pendingTitle := ""
	for _, m := range rowRe.FindAllStringSubmatch(body, -1) {
		row := m[1]
		href := chartHrefRe.FindStringSubmatch(row)
		if href == nil {
			if t := rowTitle(row); t != "" {
				pendingTitle = t
			}
			continue
		}
		path := href[1]
		if pendingTitle == "" || seen[path] {
			pendingTitle = ""
			continue
		}
		seen[path] = true
		charts = append(charts, chartRef{
			Code:  chartFamily(pendingTitle),
			Title: pendingTitle,
			Path:  path,
		})
		pendingTitle = ""
	}
	return charts
}

// rowTitle returns the collapsed text of a title-only row, or "" when the
// row carries no <p> title (a spacer or a heading row).
func rowTitle(row string) string {
	m := titleRe.FindStringSubmatch(row)
	if m == nil {
		return ""
	}
	return wsRe.ReplaceAllString(strings.TrimSpace(tagRe.ReplaceAllString(m[1], "")), " ")
}
