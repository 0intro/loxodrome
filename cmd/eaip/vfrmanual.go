// vfrmanual.go reads ANS CR's VFR Manual (aim.rlp.cz/vfrmanual), which
// replaced AIP CR VOL III (AD 4) on 1 May 2014 and is where Czechia's
// small aerodromes and heliports publish their charts: one page per
// field, whose "Charts" PDF holds every sheet the page shows as a tab (the
// visual operation chart, the aerodrome chart, and at the larger fields
// the parking chart and the hot spots). A heliport prints its text and
// sheets as one PDF instead ("PDF/Print", "pdf/LKBD_en.pdf").
//
// The landing page names the editions: the one in force under the fixed
// alias actual/, the next under a dated directory ("20261001_1"). The
// current slot stores the alias, so its links follow the manual's own
// editions, which run off the AIRAC grid.

package main

import (
	"context"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/eaip"
)

// vfrManual is one publisher's VFR manual, in this format.
type vfrManual struct {
	label string
	s     *eaip.Site
	// lang is the page suffix read, "en".
	lang string
	// dir is the edition's directory under the site's base, set by open.
	dir string
}

func (m *vfrManual) name() string { return m.label }

func (m *vfrManual) site() *eaip.Site { return m.s }

func (m *vfrManual) open(ctx context.Context, next bool) (string, error) {
	landing := strings.TrimSuffix(m.s.Base, "/") + "/index_" + m.lang + ".html"
	body, err := m.s.Get(ctx, landing)
	if err != nil {
		return "", fmt.Errorf("landing page %s: %w", landing, err)
	}
	eds := manualEditions(string(body), m.lang)
	dir, label := pickManualEdition(eds, time.Now(), next)
	if dir == "" {
		if next {
			return "", nil
		}
		return "", fmt.Errorf("landing page %s names no edition in force", landing)
	}
	m.dir = dir
	return label, nil
}

func (m *vfrManual) root() string {
	return strings.TrimSuffix(m.s.Base, "/") + "/" + m.dir + "/"
}

func (m *vfrManual) aerodromes(ctx context.Context) ([]eaip.Aerodrome, error) {
	first := m.root() + "gen_1_" + m.lang + ".html"
	body, err := m.s.Get(ctx, first)
	if err != nil {
		return nil, fmt.Errorf("menu %s: %w", first, err)
	}
	var out []eaip.Aerodrome
	for _, f := range manualAerodromes(string(body), m.lang) {
		out = append(out, eaip.Aerodrome{
			ICAO:    strings.ToUpper(f.code),
			Section: f.section,
			URL:     m.root() + f.code + "_text_" + m.lang + ".html",
		})
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("menu %s lists no aerodrome", first)
	}
	return out, nil
}

func (m *vfrManual) read(ctx context.Context, ad eaip.Aerodrome, _ func(*eaip.Node) string) (pageRead, error) {
	body, err := m.s.Get(ctx, ad.URL)
	if err != nil {
		return pageRead{}, err
	}
	c, ok := manualCharts(string(body), ad.URL)
	if !ok {
		return pageRead{}, nil
	}
	return pageRead{charts: []eaip.Chart{c}}, nil
}

// manualEdition is one edition the landing page lists.
type manualEdition struct {
	dir   string
	label string
	day   time.Time
}

// manualEditionRe reads an edition's entry on the landing page: its
// directory, the alias or a dated one, and the date and serial it is
// named by ("17 SEP 2026 (1)").
var manualEditionRe = regexp.MustCompile(`href="(actual|\d{8}_\d+)/gen_1_([a-z]{2})\.html"[^>]*>\s*(\d{1,2} [A-Z]{3} \d{4}) \((\d+)\)`)

// manualEditions lists the editions the landing page links in one
// language.
func manualEditions(page, lang string) []manualEdition {
	var out []manualEdition
	seen := map[string]bool{}
	for _, m := range manualEditionRe.FindAllStringSubmatch(page, -1) {
		if m[2] != lang || seen[m[1]] {
			continue
		}
		day, err := time.Parse("2 Jan 2006", titleMonth(m[3]))
		if err != nil {
			continue
		}
		seen[m[1]] = true
		out = append(out, manualEdition{dir: m[1], label: m[3] + " (" + m[4] + ")", day: day})
	}
	return out
}

// titleMonth spells "17 SEP 2026" the way time.Parse reads a month.
func titleMonth(s string) string {
	f := strings.Fields(s)
	if len(f) == 3 && len(f[1]) == 3 {
		f[1] = f[1][:1] + strings.ToLower(f[1][1:])
	}
	return strings.Join(f, " ")
}

// pickManualEdition picks the edition serving a slot: the alias for the
// current one, the soonest edition not yet in force for the next.
func pickManualEdition(eds []manualEdition, now time.Time, next bool) (dir, label string) {
	if !next {
		for _, e := range eds {
			if e.dir == "actual" {
				return e.dir, e.label
			}
		}
		return "", ""
	}
	today := now.UTC().Truncate(24 * time.Hour)
	var ahead []manualEdition
	for _, e := range eds {
		if e.dir != "actual" && e.day.After(today) {
			ahead = append(ahead, e)
		}
	}
	if len(ahead) == 0 {
		return "", ""
	}
	sort.Slice(ahead, func(i, j int) bool { return ahead[i].day.Before(ahead[j].day) })
	return ahead[0].dir, ahead[0].label
}

// manualMenuRe walks the menu every page carries: a part's heading
// ("VFR-AD", "VFR-SLZ", "VFR-HEL"), whose own link is consumed with it,
// or a field's page ("lkbu_text_en.html"). A four-letter code is an ICAO
// location indicator; the SLZ fields' longer local codes ("lkbole") name
// nothing an airport row can carry, so they are left out.
var manualMenuRe = regexp.MustCompile(`<a href="[^"]*">VFR-(AD|HEL|SLZ) <span>|href="(lk[a-z]{2})_text_([a-z]{2})\.html"`)

// manualField is one field the menu lists: its code, and 3 for a
// heliport, 4 for an aerodrome (the manual replaced the AIP's AD 4).
type manualField struct {
	code    string
	section int
}

// manualAerodromes lists the fields the menu links, sorted by code.
func manualAerodromes(page, lang string) []manualField {
	seen := map[string]bool{}
	var out []manualField
	part := ""
	for _, m := range manualMenuRe.FindAllStringSubmatch(page, -1) {
		if m[1] != "" {
			part = m[1]
			continue
		}
		if m[3] != lang || seen[m[2]] {
			continue
		}
		seen[m[2]] = true
		section := 4
		if part == "HEL" {
			section = 3
		}
		out = append(out, manualField{code: m[2], section: section})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].code < out[j].code })
	return out
}

// manualChartsLinkRe is the page's "Charts" PDF ("pdf/ad-lkbu_map_en.pdf"),
// and manualWholeLinkRe a heliport's one PDF of text and sheets
// ("pdf/LKBD_en.pdf").
var (
	manualChartsLinkRe = regexp.MustCompile(`href="([^"]*_map_[a-z]{2}\.pdf)"`)
	manualWholeLinkRe  = regexp.MustCompile(`href="(pdf/[A-Za-z0-9]{4}_[a-z]{2}\.pdf)"`)
)

// manualSheetRe is one tab of the chart view, a sheet image and its name
// (`<img src="ad/lkbu_voc.jpg" alt="VOC">`).
var manualSheetRe = regexp.MustCompile(`<img src="ad/[a-z]+_[a-z0-9]+\.jpg" alt="([^"]+)"`)

// manualCharts reads an aerodrome page's chart PDF, titled by the sheets
// it holds ("VOC, ADC"): a VAC when the visual operation chart is among
// them, the first sheet's family otherwise.
func manualCharts(page, pageURL string) (eaip.Chart, bool) {
	m := manualChartsLinkRe.FindStringSubmatch(page)
	if m == nil {
		m = manualWholeLinkRe.FindStringSubmatch(page)
	}
	if m == nil {
		return eaip.Chart{}, false
	}
	base, err := url.Parse(pageURL)
	if err != nil {
		return eaip.Chart{}, false
	}
	u, err := base.Parse(m[1])
	if err != nil {
		return eaip.Chart{}, false
	}
	var sheets []string
	code := ""
	for _, s := range manualSheetRe.FindAllStringSubmatch(page, -1) {
		name := strings.TrimSpace(s[1])
		if name == "" || contains(sheets, name) {
			continue
		}
		sheets = append(sheets, name)
		switch {
		case name == "VOC":
			// The visual operation chart, ANS CR's VAC.
			code = "VAC"
		case code == "":
			code = eaip.ChartFamily(name, "")
		}
	}
	if len(sheets) == 0 {
		// A PDF whose sheets the page does not name is not guessed at.
		return eaip.Chart{Code: "MISC", Title: "Charts", URL: u.String()}, true
	}
	title := strings.Join(sheets, ", ")
	return eaip.Chart{Code: code, Title: title, URL: u.String()}, true
}
