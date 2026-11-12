package main

import (
	"regexp"
	"sort"
	"strings"
)

// adPageRe finds the per-aerodrome page names in the eAIP menu
// (FR-AD-2.<ICAO>-fr-FR.html; AD 3 for the heliports). Only the -fr-FR
// variant exists; its content is bilingual.
var adPageRe = regexp.MustCompile(`FR-AD-([23])\.([A-Z]{4})-fr-FR\.html`)

// parseMenu extracts the unique aerodrome pages from the eAIP menu HTML,
// sorted by ICAO for a deterministic fetch order.
func parseMenu(html []byte) []adPage {
	seen := map[string]adPage{}
	for _, m := range adPageRe.FindAllSubmatch(html, -1) {
		icao := string(m[2])
		section := 2
		if string(m[1]) == "3" {
			section = 3
		}
		key := icao
		if _, ok := seen[key]; !ok {
			seen[key] = adPage{ICAO: icao, Section: section}
		}
	}
	pages := make([]adPage, 0, len(seen))
	for _, p := range seen {
		pages = append(pages, p)
	}
	sort.Slice(pages, func(i, j int) bool { return pages[i].ICAO < pages[j].ICAO })
	return pages
}

// aeroArrayTokenRe collects the quoted tokens of an Atlas VAC index array.
var aeroArrayTokenRe = regexp.MustCompile(`"([^"]+)"`)

// parseAeroArray reads the code list of one Atlas VAC index file. The atlas
// ships it as two parallel JavaScript arrays,
//
//	var vaerosoussection =new Array("LF001","LF236",...);
//	var vaeroportlong =new Array("ABBEVILLE CENTRE HOSPITALIER",...);
//
// and only the first is wanted, so the scan stops at the second's name; the
// long names are the atlas' own labels for the same rows, which the app
// already has from its airport datasets.
//
// The result is SORTED: the atlas emits the codes in aerodrome-name order,
// which would reshuffle the artifact whenever a name changes, and an
// unchanged cycle must produce a byte-identical file (the workflow's no-op
// commit gate).
func parseAeroArray(js []byte) []string {
	head, _, _ := strings.Cut(string(js), "vaeroportlong")
	_, list, found := strings.Cut(head, "vaerosoussection")
	if !found {
		return nil
	}
	seen := map[string]bool{}
	var out []string
	for _, m := range aeroArrayTokenRe.FindAllStringSubmatch(list, -1) {
		code := strings.ToUpper(strings.TrimSpace(m[1]))
		if code == "" || seen[code] {
			continue
		}
		seen[code] = true
		out = append(out, code)
	}
	sort.Strings(out)
	return out
}

// chartHrefRe matches the chart-PDF links of an aerodrome page. Every
// chart sits under a Cartes/ subtree relative to html/eAIP/; the directory
// shape differs (Cartes/<ICAO>/ for AD 2, Cartes/VAC_HEL/<ICAO>/<ICAO>/
// for the AD 3 heliports), so the whole relative path is captured.
var chartHrefRe = regexp.MustCompile(`href="(Cartes/[A-Za-z0-9_./-]+\.pdf)"`)

// chartNameRe splits a chart filename into the leading AD_<n>_<ICAO>_
// scheme and the family + qualifier remainder.
var chartNameRe = regexp.MustCompile(`^AD_[23]_[A-Z0-9]{4}_(.+)\.pdf$`)

// familyRe accepts a filename family token (IAC, SID, DATA, ...).
var familyRe = regexp.MustCompile(`^[A-Z0-9]+$`)

// parseCharts extracts the chart references of one aerodrome page in
// publication order, deduplicated by path (the AD 2.24 list and inline
// figures may reference the same file).
func parseCharts(html []byte) []chartRef {
	var charts []chartRef
	seen := map[string]bool{}
	for _, m := range chartHrefRe.FindAllSubmatch(html, -1) {
		path := string(m[1])
		if seen[path] {
			continue
		}
		seen[path] = true
		code, title := splitChartName(path[strings.LastIndexByte(path, '/')+1:])
		charts = append(charts, chartRef{Code: code, Title: title, Path: path})
	}
	return charts
}

// splitChartName derives the family code and the human-readable qualifier
// from a chart filename. AD_2_LFPO_IAC_RWY02_FNA_RNP.pdf yields
// ("IAC", "RWY02 FNA RNP"); a name outside the scheme yields an empty
// code and the whole stem as title (the panel's "Other charts" bucket).
func splitChartName(base string) (code, title string) {
	m := chartNameRe.FindStringSubmatch(base)
	if m == nil {
		return "", strings.ReplaceAll(strings.TrimSuffix(base, ".pdf"), "_", " ")
	}
	rest := m[1]
	fam, qual, _ := strings.Cut(rest, "_")
	if !familyRe.MatchString(fam) {
		return "", strings.ReplaceAll(rest, "_", " ")
	}
	return fam, strings.ReplaceAll(qual, "_", " ")
}
