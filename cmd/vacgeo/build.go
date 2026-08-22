// build.go enumerates the Atlas VAC, reads each plate's panels and gates
// them against the aerodrome's own published position.
//
// The gate is the safety property of this command. A panel's graticule can
// be read perfectly and still be placed wrong: the comb says how big an
// arcminute is, the labels say WHICH arcminute, and a misread label moves
// the whole panel by a whole minute or a whole degree with no sign that
// anything went wrong. Measured over the 2026-08-06 corpus, about one page
// in six fits with a residual near zero and lands tens to hundreds of
// nautical miles away.
//
// Every plate prints its own ARP in its header and we hold the same
// aerodrome in fr-airports.json, so the two together are a free, absolute
// check that owes nothing to the fit: the aerodrome must fall inside the
// panel that claims to show it. A panel that fails is not corrected, it is
// dropped. A VAC drawn over the wrong ground is worse than no VAC.

package main

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"rsc.io/pdf"

	"github.com/0intro/loxodrome/internal/aip"
)

// parserVersion stamps the meta with the extractor that wrote the rows, so
// a dataset can be told apart from one built by an older reader. Bump it
// whenever the walk, the label grammar or the fit changes what a panel
// resolves to. It gates nothing.
const parserVersion = 2

// arpRe reads the ARP a plate prints in its own header, "LAT : 48 49 19 N"
// followed within a few characters by "LONG : 002 37 22 E". The separator
// between the numbers is loose because the SIA sets these fields with
// varying spacing and the degree marks are absent here.
var arpRe = regexp.MustCompile(
	`LAT\s*:?\s*(\d{2})\s+(\d{2})\s+(\d{2}(?:\.\d+)?)\s*([NS]).{0,120}?LONG\s*:?\s*(\d{3})\s+(\d{2})\s+(\d{2}(?:\.\d+)?)\s*([EW])`)

// kindRe reads the chart family out of a page header. The aerodrome plates
// set it as "AD 2 LFPL APP 01"; the helistation ones drop the ident and
// print "AD 3 ATT 01", which is why the indicator is optional. The AD
// prefix is not: a page can mention another chart in passing ("HS Hot spot,
// see GMC 01"), and reading that as the page's own family would
// georeference an aerodrome diagram as a landing chart.
var kindRe = regexp.MustCompile(`\bAD\s*(\d)\s+(?:[A-Z0-9]{3,5}\s+)?(APP|ATT|GMC|APDC|ARC|ENV|VAT|TXT)\s*0?(\d)`)

// geoKinds are the families this command tries to georeference. APDC is a
// parking chart and TXT a text page; neither is a map.
var geoKinds = map[string]bool{"APP": true, "ATT": true, "GMC": true}

type latLon struct{ lat, lon float64 }

// dist returns the distance between two positions in metres, close enough
// over the few kilometres a gate ever measures.
func (a latLon) dist(b latLon) float64 {
	const mPerDeg = 111320.0
	dy := (b.lat - a.lat) * mPerDeg
	dx := (b.lon - a.lon) * mPerDeg * math.Cos((a.lat+b.lat)/2*math.Pi/180)
	return math.Hypot(dx, dy)
}

// plate is one Atlas VAC document to read.
type plate struct {
	ident   string
	section int
	path    string
}

// panelRow is one emitted panel.
type panelRow struct {
	ident   string
	section int
	page    int
	kind    string
	fit     *panelFit
	q       quality
}

// stats counts what one build did, for the meta and the log line.
type stats struct {
	plates, panels           int
	noGraticule, gateReject  int
	missingPlate, overridden int
	byKind                   map[string]int
	byReason                 map[string]int
	byMethod                 map[string]int
}

// report is set by -report to print one line per page that yielded nothing,
// which is how the residue gets worked through.
var report = func(ident string, section, page int, kind, why string, fit *panelFit) {}

// pageLines reconstructs the text lines of a page from the show runs, the
// way pdftotext would: group by baseline, order by x, and insert a space
// where the pen jumped. The header and the ARP block are read off these.
func pageLines(runs []textRun) []string {
	rs := dedupeRuns(runs)
	sort.Slice(rs, func(i, j int) bool {
		if math.Abs(rs[i].y-rs[j].y) > 1.5 {
			return rs[i].y > rs[j].y
		}
		return rs[i].x < rs[j].x
	})
	var out []string
	var line strings.Builder
	var lastY, lastEnd float64
	for i, r := range rs {
		if i > 0 && math.Abs(r.y-lastY) > 1.5 {
			out = append(out, line.String())
			line.Reset()
			lastEnd = 0
		}
		if line.Len() > 0 && r.x-lastEnd > 0.8 {
			line.WriteByte(' ')
		}
		line.WriteString(r.text)
		lastY, lastEnd = r.y, r.x+r.adv
	}
	if line.Len() > 0 {
		out = append(out, line.String())
	}
	return out
}

// pageKind names the chart family a page belongs to, read from its header.
func pageKind(lines []string) string {
	for _, l := range lines {
		if m := kindRe.FindStringSubmatch(l); m != nil {
			return m[2]
		}
	}
	return ""
}

// plateARP reads the aerodrome reference point out of a plate's own header.
func plateARP(lines []string) *latLon {
	joined := strings.Join(lines, " ")
	m := arpRe.FindStringSubmatch(joined)
	if m == nil {
		return nil
	}
	lat := atof(m[1]) + atof(m[2])/60 + atof(m[3])/3600
	lon := atof(m[5]) + atof(m[6])/60 + atof(m[7])/3600
	if m[4] == "S" {
		lat = -lat
	}
	if m[8] == "W" {
		lon = -lon
	}
	return &latLon{lat: lat, lon: lon}
}

// gateMargin is how far outside a panel the ARP may sit and still pass, as
// a fraction of the panel's own size. Zero would be the pure rule, but a
// handful of plates centre a panel on a runway threshold or a helipad a
// little outside the frame the SIA drew, and losing those to a hard edge
// buys nothing: the failure this gate exists to catch misses by whole
// arcminutes, never by a few percent of a panel.
const gateMargin = 0.05

// maxDevPct is how far the two axes may disagree with the projection before
// the fit is disowned. A conformal panel's scales differ by sec(phi) x M/N
// and nothing else, so a percent is drafting tolerance and five percent is
// a comb fitted to the wrong marks.
const maxDevPct = 2.0

// gate reports whether a panel may be published: the aerodrome it claims to
// show has to be on it, and the fit has to obey the projection.
func gate(f *panelFit, arp latLon) (float64, bool) {
	if math.Abs(f.DevPct) > maxDevPct {
		return 0, false
	}
	latLo, lonLo, latHi, lonHi := f.bounds()
	dLat, dLon := (latHi-latLo)*gateMargin, (lonHi-lonLo)*gateMargin
	centre := latLon{lat: (latLo + latHi) / 2, lon: (lonLo + lonHi) / 2}
	off := centre.dist(arp)
	ok := arp.lat >= latLo-dLat && arp.lat <= latHi+dLat &&
		arp.lon >= lonLo-dLon && arp.lon <= lonHi+dLon
	return off, ok
}

// readPlate reads every georeferenceable panel of one plate.
func readPlate(p plate, ref *airportRef, ov overrides, st *stats) ([]panelRow, error) {
	f, err := os.Open(p.path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	rd, err := pdf.NewReader(f, info.Size())
	if err != nil {
		return nil, fmt.Errorf("%s: %w", filepath.Base(p.path), err)
	}
	st.plates++

	type pageData struct {
		kind    string
		content *pageContent
		fit     *panelFit
		why     string
	}
	// Two passes over the pages, not one: the graticule labels carry no
	// hemisphere and the plate states it in the header ARP, which may be
	// on any page, so nothing can be fitted until every page has been
	// read. Only the geographic pages keep their content.
	pages := make([]pageData, 0, rd.NumPage())
	var arp *latLon
	for i := 1; i <= rd.NumPage(); i++ {
		c, err := walkPage(rd.Page(i))
		if err != nil {
			pages = append(pages, pageData{})
			continue
		}
		lines := pageLines(c.runs)
		kind := pageKind(lines)
		if arp == nil {
			arp = plateARP(lines)
		}
		if kind == "" {
			st.byReason["unclassified-page"]++
		}
		pg := pageData{kind: kind}
		if geoKinds[kind] {
			pg.content = &c
		}
		pages = append(pages, pg)
	}
	if arp == nil && ref != nil {
		arp = &ref.pos
	}
	if arp == nil {
		// Nothing to gate against. Publishing a panel we cannot place a
		// known point on is exactly the failure this command refuses.
		return nil, nil
	}
	if ref != nil && arp.dist(ref.pos) > 2000 {
		return nil, fmt.Errorf("%s: plate ARP %.5f,%.5f disagrees with the dataset by %.0f m",
			p.ident, arp.lat, arp.lon, arp.dist(ref.pos))
	}

	hemi := hemisphere{lat: 1, lon: 1}
	if arp.lat < 0 {
		hemi.lat = -1
	}
	if arp.lon < 0 {
		hemi.lon = -1
	}
	for i := range pages {
		c := pages[i].content
		if c == nil {
			continue
		}
		pages[i].fit, pages[i].why = fitPanel(*c, hemi)
		// A sheet with no grid to read is not necessarily unplaceable: a
		// ground-movement chart draws the runway, and the runway's own
		// ends are published (runway.go).
		if pages[i].fit == nil && ref != nil && len(ref.runways) > 0 {
			if fit, why := fitRunway(*c, ref.runways, *arp); fit != nil {
				pages[i].fit, pages[i].why = fit, ""
			} else if pages[i].why == "labels" {
				pages[i].why = "runway:" + why
			}
		} else if pages[i].fit != nil && ref != nil && len(ref.runways) > 0 {
			// A graticule fit that draws its own runway is checked against
			// it and moved onto it. The graticule's scale survives; only
			// where the panel sits is corrected, and a panel that still
			// misses after the move is disagreeing about the shape of the
			// ground, not its position, so it is dropped.
			if dLat, dLon, resid, ok := runwayAnchor(*c, pages[i].fit, ref.runways); ok {
				f := pages[i].fit
				f.AnchorM = latLon{f.Geo.F, f.Geo.E}.dist(latLon{f.Geo.F + dLat, f.Geo.E + dLon})
				f.AnchorResidM = resid
				f.Geo.F += dLat
				f.Geo.E += dLon
			}
		}
		pages[i].content = nil
	}

	var out []panelRow
	for i, pg := range pages {
		if !geoKinds[pg.kind] {
			continue
		}
		fit, src := pg.fit, ""
		if o, ok := ov.lookup(p.ident, p.section, i+1); ok {
			fit, src = o, "override"
		}
		if fit == nil {
			st.noGraticule++
			st.byReason[pg.why]++
			report(p.ident, p.section, i+1, pg.kind, pg.why, nil)
			continue
		}
		off, ok := gate(fit, *arp)
		if !ok {
			st.gateReject++
			st.byReason["gate"]++
			report(p.ident, p.section, i+1, pg.kind, fmt.Sprintf("gate off=%.0fm", off), fit)
			continue
		}
		if src == "override" {
			st.overridden++
		}
		// A panel says how it was placed, so a reader can weigh it and so
		// one method can be told from the other in the audit.
		method := fit.Method
		if method == "" {
			method = "graticule"
		}
		if src == "override" {
			method = "override"
		}
		out = append(out, panelRow{
			ident: p.ident, section: p.section, page: i + 1, kind: pg.kind, fit: fit,
			q: quality{
				Method: method, LatN: fit.LatN, LonN: fit.LonN,
				RMS:    aip.Round5(math.Max(fit.LatRMS, fit.LonRMS)),
				DevPct: aip.Round5(fit.DevPct), Forced: fit.Forced,
				Runways:      fit.Runways,
				ResidM:       math.Round(fit.ResidM*10) / 10,
				ScaleDev:     aip.Round5(fit.ScaleDev),
				AnchorM:      math.Round(fit.AnchorM),
				AnchorResidM: math.Round(fit.AnchorResidM),
				ARPm:         math.Round(off), Src: src,
			},
		})
		st.panels++
		st.byKind[pg.kind]++
		st.byMethod[method]++
	}
	return out, nil
}

// rowOf turns one panel into its artifact row.
func rowOf(r panelRow) []any {
	south, west, north, east := r.fit.bounds()
	cLat, cLon := r.fit.Geo.at((r.fit.Clip.x0+r.fit.Clip.x1)/2, (r.fit.Clip.y0+r.fit.Clip.y1)/2)
	g := r.fit.Geo
	return []any{
		r.ident, r.section, r.page, r.kind,
		[]float64{round2(r.fit.Clip.x0), round2(r.fit.Clip.y0), round2(r.fit.Clip.x1), round2(r.fit.Clip.y1)},
		[]float64{aip.Round5(south), aip.Round5(west)},
		[]float64{aip.Round5(north), aip.Round5(east)},
		aip.Round5(cLat), aip.Round5(cLon),
		[]float64{round9(g.A), round9(g.B), round9(g.C), round9(g.D), aip.Round5(g.E), aip.Round5(g.F)},
		r.q,
	}
}

// round9 keeps a degrees-per-point coefficient to nine places, which is a
// tenth of a millimetre on the ground over a sheet's own width.
func round9(x float64) float64 { return math.Round(x*1e9) / 1e9 }

func round2(x float64) float64 { return math.Round(x*100) / 100 }

// airportRef is what this command reads out of fr-airports.json: the
// aerodrome's own position, which gates every panel, and its runways with
// both physical ends, which place the sheets that have no graticule.
type airportRef struct {
	pos     latLon
	runways []runwayRef
}

// airportPositions indexes fr-airports.json by ident, the independent half
// of the gate.
func airportPositions(path string) (map[string]airportRef, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var doc struct {
		Fields       []string            `json:"fields"`
		RunwayFields []string            `json:"runwayFields"`
		Rows         [][]json.RawMessage `json:"rows"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	idx := map[string]int{}
	for i, f := range doc.Fields {
		idx[f] = i
	}
	for _, f := range []string{"ident", "lat", "lon"} {
		if _, ok := idx[f]; !ok {
			return nil, fmt.Errorf("%s: column %q missing", path, f)
		}
	}
	rwIdx := map[string]int{}
	for i, f := range doc.RunwayFields {
		rwIdx[f] = i
	}
	out := make(map[string]airportRef, len(doc.Rows))
	for _, row := range doc.Rows {
		if len(row) <= idx["lon"] {
			continue
		}
		var ident string
		var lat, lon float64
		if json.Unmarshal(row[idx["ident"]], &ident) != nil ||
			json.Unmarshal(row[idx["lat"]], &lat) != nil ||
			json.Unmarshal(row[idx["lon"]], &lon) != nil {
			continue
		}
		ref := airportRef{pos: latLon{lat: lat, lon: lon}}
		if i, ok := idx["runways"]; ok && i < len(row) {
			ref.runways = parseRunways(row[i], rwIdx)
		}
		out[strings.ToUpper(ident)] = ref
	}
	return out, nil
}

// parseRunways reads the runways column, keeping only the strips that
// state both physical ends and a width: a runway fit needs a length, a
// proportion and two anchors, and a strip missing any of them cannot
// contribute one.
func parseRunways(raw json.RawMessage, rwIdx map[string]int) []runwayRef {
	var rows [][]json.RawMessage
	if json.Unmarshal(raw, &rows) != nil {
		return nil
	}
	col := func(row []json.RawMessage, name string) (json.RawMessage, bool) {
		i, ok := rwIdx[name]
		if !ok || i >= len(row) {
			return nil, false
		}
		return row[i], true
	}
	pos := func(row []json.RawMessage, name string) (latLon, bool) {
		v, ok := col(row, name)
		if !ok {
			return latLon{}, false
		}
		var p []float64
		if json.Unmarshal(v, &p) != nil || len(p) != 2 {
			return latLon{}, false
		}
		return latLon{lat: p[0], lon: p[1]}, true
	}
	var out []runwayRef
	for _, row := range rows {
		lePos, ok1 := pos(row, "le_pos")
		hePos, ok2 := pos(row, "he_pos")
		if !ok1 || !ok2 {
			continue
		}
		var le, he string
		if v, ok := col(row, "le"); ok {
			_ = json.Unmarshal(v, &le)
		}
		if v, ok := col(row, "he"); ok {
			_ = json.Unmarshal(v, &he)
		}
		widthM := 0.0
		if v, ok := col(row, "width_ft"); ok {
			var ft float64
			if json.Unmarshal(v, &ft) == nil {
				widthM = ft * 0.3048
			}
		}
		if le == "" || he == "" || widthM <= 0 {
			continue
		}
		out = append(out, runwayRef{le: le, he: he, lePos: lePos, hePos: hePos, widthM: widthM})
	}
	return out
}
