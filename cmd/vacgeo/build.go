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
	"strconv"
	"strings"

	"rsc.io/pdf"

	"github.com/0intro/loxodrome/internal/aip"
)

// parserVersion stamps the meta with the extractor that wrote the rows, so
// a dataset can be told apart from one built by an older reader. Bump it
// whenever the walk, the label grammar or the fit changes what a panel
// resolves to. It gates nothing.
const parserVersion = 17

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

// dist returns the distance between two positions in metres, on the same
// ellipsoid the fits are built on, over the few kilometres a gate measures.
func (a latLon) dist(b latLon) float64 {
	mLat, mLon := metrePerDeg((a.lat + b.lat) / 2)
	return math.Hypot((b.lon-a.lon)*mLon, (b.lat-a.lat)*mLat)
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
	byAxes                   map[string]int
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
// show has to be on it, the fit has to obey the projection, and the sheet
// has to be the right way round.
func gate(f *panelFit, arp latLon) (float64, bool) {
	if !upright(f) {
		return 0, false
	}
	// The projection is a prior, not a measurement. It refuses a fit whose
	// two axes disagree with it, because five times out of six that is a
	// comb read off the wrong marks; but where the disagreeing axis is
	// backed by its OWN PRINTED LABELS, the sheet is drawn out of square
	// and the identity is the thing that is wrong about it. The exception
	// is narrow on purpose: fitPanel has to have said so, and both axes
	// have to be real combs rather than the two-pick phase fit a derived
	// axis can come back as.
	if math.Abs(f.DevPct) > maxDevPct && !(f.Axes == "stretched" && f.LatN >= 3 && f.LonN >= 3) {
		return 0, false
	}
	latLo, lonLo, latHi, lonHi := f.bounds()
	dLat, dLon := (latHi-latLo)*gateMargin, (lonHi-lonLo)*gateMargin
	centre := latLon{lat: (latLo + latHi) / 2, lon: (lonLo + lonHi) / 2}
	off := centre.dist(arp)
	ok := arp.lat >= latLo-dLat && arp.lat <= latHi+dLat &&
		arp.lon >= lonLo-dLon && arp.lon <= lonHi+dLon
	// A runway outranks the aerodrome reference point. This test asks
	// whether the panel is over the right ground and answers it to within
	// half a panel; a drawn runway lying along its own published
	// centreline answers the same question to tens of metres, and it does
	// it with the panel's own ink rather than with the size of a
	// rectangle. Where one has confirmed the panel, an ARP falling off a
	// tightly cut clip is a fact about the CLIP.
	if !ok && f.Anchored && f.AnchorResidM <= maxAnchorResidM {
		ok = true
	}
	// A pad panel is placed ON the published touchdown area, so asking
	// whether it contains the aerodrome reference point asks the wrong
	// question of the wrong size of panel: these are fifty metres across
	// and nineteen helistations state a pad that is not their own reference
	// point. What still has to hold is that the two are the same place,
	// which is the check the AIXM position and the plate's own printed
	// header make on each other.
	if !ok && f.Method == "helipad" && off <= maxPadArpM {
		ok = true
	}
	return off, ok
}

// How far a published touchdown area may lie from the aerodrome reference
// point the plate prints in its own header. They are the same point on 215
// of the 234 the AIP states, and a few hundred metres apart on the rest,
// where the helistation's reference point is the site's rather than the
// pad's. A pad kilometres away is not that: it is a record about somewhere
// else, and the panel drawn on it would be too.
const maxPadArpM = 600

// upright reports whether the panel reads the way a printed chart does:
// east to the right of west, north above south. The determinant is the
// test because a runway-fitted sheet is ROTATED, sometimes past 90 degrees,
// and a rotation keeps it positive where a mirror cannot.
//
// No printed VAC is mirrored, so this owes nothing to the fit and costs
// nothing to ask, and it catches a whole class the ARP gate cannot: a panel
// flipped about its own centre still contains its aerodrome. LFBT sits ON
// the prime meridian, its approach sheet labelled 10' 0' 10' 20' left to
// right, and the plate cannot say that the first of those is west; read
// with the ARP's own hemisphere throughout, the sheet fits perfectly
// backwards.
func upright(f *panelFit) bool {
	return f.Geo.A*f.Geo.D-f.Geo.B*f.Geo.C > 0
}

// gateWhy says which half of the panel the rejection is about: a fit that
// put the aerodrome nowhere near the page, or a CUT that trimmed a good fit
// until the aerodrome fell off it. The two are indistinguishable in the
// gate's verdict and want completely different repairs, so the report says
// which. Diagnostic only; nothing branches on it.
func gateWhy(f *panelFit, arp latLon) string {
	if math.Abs(f.DevPct) > maxDevPct {
		return "(projection, not position)"
	}
	if !upright(f) {
		return "(mirrored: the sheet reads backwards)"
	}
	whole := &panelFit{Clip: f.Frame, Geo: f.Geo}
	if _, ok := gate(whole, arp); ok {
		return "(ARP is inside the FRAME: the cut is what lost it)"
	}
	return "(ARP off the frame too: the fit is wrong)"
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
		// The readers that looked after the graticule did, in order. Each
		// knows more about the page than the one before it, so the LAST to
		// look is the one whose refusal means something.
		var tried []string
		// A sheet with no grid to read is not necessarily unplaceable: a
		// ground-movement chart draws the runway, and the runway's own
		// ends are published (runway.go).
		if pages[i].fit == nil && ref != nil && len(ref.runways) > 0 {
			if fit, why := fitRunway(*c, ref.runways, *arp); fit != nil {
				pages[i].fit, pages[i].why = fit, ""
			} else {
				tried = append(tried, "runway:"+why)
			}
		}
		// A helistation landing sheet draws neither, and is placed on its
		// pad instead (helipad.go).
		if pages[i].fit == nil && ref != nil && len(ref.pads) > 0 && pages[i].kind == "ATT" {
			if fit, why := fitHelipad(*c, ref.pads); fit != nil {
				pages[i].fit, pages[i].why = fit, ""
			} else {
				tried = append(tried, "helipad:"+why)
			}
		}
		// "labels" means the graticule reader found no grid at all, which
		// on these sheets is not news: they were never going to have one.
		// Anything else means it found a grid and failed on it, and that
		// is its own story, so it keeps the page.
		//
		// This used to be written as two separate "replace labels" tests,
		// one per reader, which meant a pad sheet at an aerodrome with a
		// runway could never report a pad reason: the runway reader ran
		// first, wrote its own, and the helipad test then no longer saw
		// "labels" to replace.
		if pages[i].fit == nil && len(tried) > 0 && pages[i].why == "labels" {
			pages[i].why = tried[len(tried)-1]
		}
		if pages[i].fit != nil && pages[i].fit.Method == "" && ref != nil && len(ref.runways) > 0 {
			// A graticule fit that draws its own runway is checked against
			// it and moved onto it. The graticule's scale survives; only
			// where the panel sits is corrected, and a panel that still
			// misses after the move is disagreeing about the shape of the
			// ground, not its position, so it is dropped.
			if dLat, dLon, resid, ok := runwayAnchor(*c, pages[i].fit, ref.runways); ok {
				f := pages[i].fit
				f.Anchored = true
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
			report(p.ident, p.section, i+1, pg.kind,
				fmt.Sprintf("gate off=%.0fm %s", off, gateWhy(fit, *arp)), fit)
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
				Axes:         fit.Axes,
				ForcedDevPct: aip.Round5(fit.ForcedDevPct),
				ForcedN:      fit.ForcedN,
				LabelDevPct:  aip.Round5(fit.LabelDevPct),
				Runways:      fit.Runways,
				ResidM:       math.Round(fit.ResidM*10) / 10,
				ScaleDev:     aip.Round5(fit.ScaleDev),
				AnchorM:      math.Round(fit.AnchorM),
				AnchorResidM: math.Round(fit.AnchorResidM),
				PadGridM:     aip.Round5(fit.PadGridM),
				North:        fit.North.From,
				ScaleFrom:    fit.ScaleFrom,
				NorthShaftPt: fit.North.ShaftPt,
				NorthGapDeg:  fit.North.DisagreeDeg,
				ARPm:         math.Round(off), Src: src,
			},
		})
		st.panels++
		st.byKind[pg.kind]++
		st.byMethod[method]++
		if fit.Axes != "" {
			st.byAxes[fit.Axes]++
		}
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
	pads    []padRef
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
		PadFields    []string            `json:"padFields"`
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
	padIdx := map[string]int{}
	for i, f := range doc.PadFields {
		padIdx[f] = i
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
		if i, ok := idx["pads"]; ok && i < len(row) {
			ref.pads = parsePads(row[i], padIdx)
		}
		out[strings.ToUpper(ident)] = ref
	}
	return out, nil
}

// padProseSizes reads the pad dimensions the AIP states as PROSE, in
// AD 1.3-2, which cmd/fr carries into the facilities dataset's directory
// column under the categories `fato` and `tlof`. Keyed by ident, in metres.
//
// This is the same statement as the AIXM Tla and Fto dimensions and it is
// routinely not the same FIGURES: 89 aerodromes carry a FATO string and 67
// a TLOF one, and for thirty of them the pair is a second size where the
// airports dataset holds only one. That matters because a sheet with no
// scale bar is placed on the RATIO of two published sizes (helipad.go), so
// an aerodrome the AIP sizes once cannot be placed at all, however plainly
// its plate draws its two squares.
//
// Nothing here is a fit to anything. It is one more thing the AIP says
// about the pad, read where it happens to be written down.
func padProseSizes(path string) (map[string][]float64, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var doc struct {
		Fields []string            `json:"fields"`
		Rows   [][]json.RawMessage `json:"rows"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	idx := map[string]int{}
	for i, f := range doc.Fields {
		idx[f] = i
	}
	iID, okID := idx["ident"]
	iDir, okDir := idx["directory"]
	if !okID || !okDir {
		return nil, fmt.Errorf("%s: ident or directory column missing", path)
	}
	out := map[string][]float64{}
	for _, row := range doc.Rows {
		if len(row) <= iDir {
			continue
		}
		var ident string
		if json.Unmarshal(row[iID], &ident) != nil {
			continue
		}
		var items [][2]string
		if json.Unmarshal(row[iDir], &items) != nil {
			continue
		}
		for _, it := range items {
			if it[0] != "fato" && it[0] != "tlof" {
				continue
			}
			out[strings.ToUpper(ident)] = append(out[strings.ToUpper(ident)],
				statedSizes(it[1])...)
		}
	}
	return out, nil
}

// statedSizes reads the metre figures out of one such string. The AIP
// writes them four ways: "20 x 20 m", "25x30", "11.4 X 11.4" and
// "Diametre 20", the last for a round pad, whose diameter is the extent of
// the same square the sheet draws around it. One of the 156 strings states
// no figure at all ("voir VAC"), and that is the plate's job.
func statedSizes(text string) []float64 {
	var out []float64
	keep := func(s string) {
		v, err := strconv.ParseFloat(strings.Replace(s, ",", ".", 1), 64)
		if err == nil && v >= minPadSizeM && v <= maxPadSizeM {
			out = append(out, v)
		}
	}
	for _, m := range padPairRe.FindAllStringSubmatch(text, -1) {
		keep(m[1])
		keep(m[2])
	}
	if len(out) == 0 {
		for _, m := range padDiaRe.FindAllStringSubmatch(text, -1) {
			keep(m[1])
		}
	}
	return out
}

// padGridM is how coarsely the AIP states this pad's position, as the rms
// radial error of the grid the coordinate sits on.
//
// It matters because it is the floor under every pad panel and no reader
// can go below it. The AIXM form is DDMMSS.ss and **71 per cent of the
// published pad coordinates sit exactly on a whole arcsecond**, which at 47
// north is 30.9 m of latitude and 21.1 of longitude: rounding both to the
// nearest second is 10.8 m rms on its own, against the 16 m these panels
// are measured to sit from the ground. A helistation pad is twenty to
// twenty-five metres across, so that is half a pad width, published.
//
// Where the AIP states hundredths the grid is a hundred times finer and
// this is a fraction of a metre, which is the honest answer for those too.
func padGridM(lat, lon float64) float64 {
	// The dataset carries five decimal places, which is 0.036 of an
	// arcsecond, so a coordinate the AIP stated as a whole second arrives
	// here a little off one. The tolerance is that rounding and not the
	// arithmetic's.
	const slack = 0.03
	unit := func(v float64) float64 {
		for _, u := range []float64{1, 0.1, 0.01} {
			if math.Abs(v*3600/u-math.Round(v*3600/u))*u < slack {
				return u
			}
		}
		return 0.01
	}
	u := math.Max(unit(lat), unit(lon))
	mLat, mLon := metrePerDeg(lat)
	dLat, dLon := mLat*u/3600, mLon*u/3600
	return math.Sqrt((dLat*dLat + dLon*dLon) / 12)
}

// parsePads reads the pads column: where a helistation's touchdown area is
// and the two squares the AIP states around it. A pad with no size still
// counts, since its position is what the panel is anchored on; the sizes
// are the check, and the sheet prints its own besides.
func parsePads(raw json.RawMessage, padIdx map[string]int) []padRef {
	var rows [][]json.RawMessage
	if json.Unmarshal(raw, &rows) != nil {
		return nil
	}
	num := func(row []json.RawMessage, name string) (float64, bool) {
		i, ok := padIdx[name]
		if !ok || i >= len(row) {
			return 0, false
		}
		var v float64
		if json.Unmarshal(row[i], &v) != nil {
			return 0, false
		}
		return v, true
	}
	var out []padRef
	for _, row := range rows {
		lat, ok1 := num(row, "lat")
		lon, ok2 := num(row, "lon")
		if !ok1 || !ok2 {
			continue
		}
		p := padRef{pos: latLon{lat: lat, lon: lon}}
		for _, f := range []string{"tlof_len_m", "tlof_wid_m", "fato_len_m", "fato_wid_m"} {
			if v, ok := num(row, f); ok && v > 0 {
				p.sizesM = append(p.sizesM, v)
			}
		}
		out = append(out, p)
	}
	return out
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
