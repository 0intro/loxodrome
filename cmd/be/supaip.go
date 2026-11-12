// supaip.go emits be-supaip.json: the Belgian AIP Supplements from the
// eAIP's eSUP section, mirroring cmd/supaip's fr-supaip.json row schema
// exactly (api.go outputFields, 23 columns) so the SPA loader reads both
// with one decoder. Belgian supplements are HTML pages (no PDF twins):
// urlPdfEn carries the page URL (the publication is English), urlPdf stays
// empty. Geometry comes from the page body: "Position: DDMMSSN DDDMMSSE"
// (+ "Height: 126.0 M AGL") obstacle notices become small circles (a
// stated radius when present, else a 500 m floor so the map draw and
// hit-test stay usable), and coordinate-list paragraphs become polygons.

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"github.com/0intro/loxodrome/internal/eaip"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	defaultMinBeSup = 5
	defaultMaxBeSup = 500

	// supCircleFloorM keeps position-only supplements visible and
	// clickable (the supaip layer draws L.circle(radiusM) and hit-tests
	// distance <= radiusM; radius 0 would be invisible).
	supCircleFloorM = 500.0
)

// supOutputFields mirrors cmd/supaip/api.go's outputFields.
var supOutputFields = []string{
	"id", "title", "region", "descriptionFr", "descriptionEn", "lieu",
	"urlPdf", "validFrom", "validTo", "ifr", "vfr", "airac", "fir", "adhp",
	"zones", "bbox", "geometrySource", "parseConfidence", "warnings",
	"urlPdfEn",
	"contacts", "penetration", "manager",
}

// SupArtifact is the be-supaip.json document.
type SupArtifact struct {
	Fields []string `json:"fields"`
	Rows   []any    `json:"rows"`
}

// SupMeta is the be-supaip.meta.json document (the fr Meta's fields that
// apply to the HTML source).
type SupMeta struct {
	GeneratedAt   string         `json:"generatedAt"`
	Source        supSourceMeta  `json:"source"`
	Total         int            `json:"total"`
	WithGeometry  int            `json:"withGeometry"`
	Polygon       int            `json:"polygon"`
	Circle        int            `json:"circle"`
	Mixed         int            `json:"mixed"`
	None          int            `json:"none"`
	ByRegion      map[string]int `json:"byRegion"`
	ParserVersion int            `json:"parserVersion"`
}

type supSourceMeta struct {
	Site       string `json:"site"`
	ListingSha string `json:"listingSha,omitempty"`
}

// beSupParserVersion bumps when the eSUP extractor changes (the fr
// convention for tracking parse-coverage regressions).
const beSupParserVersion = 1

var (
	supNumYearRe  = regexp.MustCompile(`(\d{1,3})\s*/\s*(\d{4})`)
	supValidityRe = regexp.MustCompile(`(?i)from\s+(\d{1,2}) ([A-Z]{3}) (\d{4})(?:\s+to\s+(\d{1,2}) ([A-Z]{3}) (\d{4}))?`)
	supPosRe      = regexp.MustCompile(`(?i)position\s*:?\s*` + eaip.CoordPat)
	supHeightRe   = regexp.MustCompile(`(?i)height\s*:?\s*([\d.]+)\s*(M|FT)\s*(AGL|AMSL)?`)
	supRadiusRe   = regexp.MustCompile(`(?i)radius\s+(?:of\s+)?([\d.]+)\s*NM`)
	supIcaoRe     = regexp.MustCompile(`\bE[BL][A-Z]{2}\b`)
)

// supZone is one drawable sub-area of a supplement.
type supZone struct {
	name   string
	geom   map[string]any // polygon / circle JSON shape, nil for none
	bbox   []float64
	lower  any
	upper  any
	source string
}

// supRow is one supplement.
type supRow struct {
	id, title      string
	subject        string
	pageURL        string
	validFrom      string
	validTo        string
	adhp           []string
	zones          []supZone
	geometrySource string
}

// parseSupplements reads the eSUP listing + every supplement page of the
// tree. Each supplement is one <tbody> holding two rows: the
// NR/Affect/Period row (with the page link) and a full-width Subject row;
// the cells carry semantic classes (SupTable-NRYear-td, SupTable-Period-td,
// SupTable-Subject-td).
func parseSupplements(t *tree) []supRow {
	list := t.doc(supListPage)
	if list == nil {
		return nil
	}
	var out []supRow
	for _, tb := range eaip.Elems(list, "tbody") {
		var page string
		for _, a := range eaip.AnchorsIn(tb) {
			name := strings.SplitN(a.Href, "#", 2)[0]
			if supPageRe.MatchString(name) {
				page = name
				break
			}
		}
		if page == "" {
			continue
		}
		nm := supNumYearRe.FindStringSubmatch(textByClass(tb, "SupTable-NRYear-td"))
		if nm == nil {
			nm = supNumYearRe.FindStringSubmatch(eaip.NodeText(tb))
		}
		if nm == nil {
			continue
		}
		num, _ := strconv.Atoi(nm[1])
		year, _ := strconv.Atoi(nm[2])
		row := supRow{
			id:      fmt.Sprintf("be-%d-%03d", year, num),
			title:   fmt.Sprintf("%03d/%d", num, year),
			subject: textByClass(tb, "SupTable-Subject-td"),
			pageURL: eaipBase + slotMain + "/html/eSUP/" + page,
		}
		row.validFrom, row.validTo, _ = supValidity(textByClass(tb, "SupTable-Period-td"))
		if row.validFrom == "" {
			row.validFrom, row.validTo, _ = supValidity(eaip.NodeText(tb))
		}
		row.adhp = uniqueMatches(supIcaoRe, row.subject)
		fillSupZones(&row, t.doc("eSUP/"+page))
		out = append(out, row)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].id < out[j].id })
	return out
}

// textByClass returns the text of the first element under n carrying the
// class.
func textByClass(n *eaip.Node, class string) string {
	for _, e := range eaip.FindAll(n, func(x *eaip.Node) bool { return eaip.HasClass(x, class) }) {
		return eaip.NodeText(e)
	}
	return ""
}

// supValidity parses "From 10 JUL 2025 to 18 MAY 2027" (the "to" part
// optional) into ISO dates.
func supValidity(s string) (from, to string, ok bool) {
	m := supValidityRe.FindStringSubmatch(eaip.NormSpace(s))
	if m == nil {
		return "", "", false
	}
	from = isoDate(m[1], m[2], m[3])
	if m[4] != "" {
		to = isoDate(m[4], m[5], m[6])
	}
	return from, to, from != ""
}

func isoDate(day, mon, year string) string {
	mm, ok := monthNum[strings.ToUpper(mon)]
	if !ok {
		return ""
	}
	if len(day) == 1 {
		day = "0" + day
	}
	return year + "-" + mm + "-" + day
}

// fillSupZones extracts the drawable geometry from a supplement page:
// "Position:" circles first, else coordinate-list polygons.
func fillSupZones(row *supRow, doc *eaip.Node) {
	row.geometrySource = "none"
	if doc == nil {
		return
	}
	text := eaip.NodeText(doc)

	radiusM := supCircleFloorM
	if m := supRadiusRe.FindStringSubmatch(text); m != nil {
		if v, err := strconv.ParseFloat(m[1], 64); err == nil && v > 0 {
			radiusM = v * 1852
		}
	}
	var upper any
	if m := supHeightRe.FindStringSubmatch(text); m != nil {
		ref := "HEI"
		if strings.EqualFold(m[3], "AMSL") {
			ref = "ALT"
		}
		upper = []string{ref, m[1], strings.ToUpper(m[2])}
	}

	positions := supPosRe.FindAllStringSubmatch(text, -1)
	for i, m := range positions {
		lat, lon, ok := eaip.ParsePair(m[1], m[2])
		if !ok {
			continue
		}
		name := row.subject
		if len(positions) > 1 {
			name = fmt.Sprintf("%s (%d)", row.subject, i+1)
		}
		row.zones = append(row.zones, supZone{
			name: name,
			geom: map[string]any{
				"type":    "circle",
				"center":  [2]float64{lat, lon},
				"radiusM": radiusM,
			},
			bbox:   circleBbox(lat, lon, radiusM),
			lower:  []string{"HEI", "0", "FT"},
			upper:  upper,
			source: "html-position",
		})
	}
	if len(row.zones) > 0 {
		row.geometrySource = "html-position"
		return
	}

	// Polygons: any table cell or paragraph listing three or more
	// coordinate pairs.
	seen := map[string]bool{}
	for _, n := range eaip.Elems(doc, "td", "p") {
		cellText := eaip.NormSpace(eaip.NodeText(n))
		if len(eaip.CoordRe.FindAllString(cellText, -1)) < 3 {
			continue
		}
		if seen[cellText] {
			continue
		}
		seen[cellText] = true
		var st eaip.BoundaryStats
		ring := eaip.ParseBoundary(cellText, nil, &st)
		if len(ring) < 3 {
			continue
		}
		row.zones = append(row.zones, supZone{
			name:   row.subject,
			geom:   map[string]any{"type": "polygon", "ring": ring},
			bbox:   ringBbox(ring),
			source: "html-polygon",
		})
	}
	if len(row.zones) > 0 {
		row.geometrySource = "html-polygon"
	}
}

func circleBbox(lat, lon, radiusM float64) []float64 {
	dLat := radiusM / 111320.0
	dLon := radiusM / (111320.0 * cosDeg(lat))
	return []float64{eaip.Round5(lat - dLat), eaip.Round5(lon - dLon), eaip.Round5(lat + dLat), eaip.Round5(lon + dLon)}
}

func ringBbox(ring [][2]float64) []float64 {
	minLat, minLon := ring[0][0], ring[0][1]
	maxLat, maxLon := minLat, minLon
	for _, p := range ring {
		minLat, maxLat = minf(minLat, p[0]), maxf(maxLat, p[0])
		minLon, maxLon = minf(minLon, p[1]), maxf(maxLon, p[1])
	}
	return []float64{minLat, minLon, maxLat, maxLon}
}

func uniqueMatches(re *regexp.Regexp, s string) []string {
	seen := map[string]bool{}
	var out []string
	for _, m := range re.FindAllString(s, -1) {
		if !seen[m] {
			seen[m] = true
			out = append(out, m)
		}
	}
	if out == nil {
		out = []string{}
	}
	return out
}

// BuildSupaip emits the be-supaip artefact + meta.
func BuildSupaip(rows []supRow, listingSha string, now func() time.Time, minN, maxN int) (SupArtifact, SupMeta, error) {
	if now == nil {
		now = time.Now
	}
	if minN == 0 {
		minN = defaultMinBeSup
	}
	if maxN == 0 {
		maxN = defaultMaxBeSup
	}
	out := make([]any, 0, len(rows))
	meta := SupMeta{
		GeneratedAt:   now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Source:        supSourceMeta{Site: eaipBase + slotMain + "/html/eSUP/", ListingSha: listingSha},
		ByRegion:      map[string]int{},
		ParserVersion: beSupParserVersion,
	}
	for _, r := range rows {
		zones := make([]any, 0, len(r.zones))
		var bbox []float64
		for _, z := range r.zones {
			zones = append(zones, map[string]any{
				"name":           z.name,
				"geometry":       z.geom,
				"bbox":           z.bbox,
				"lower":          z.lower,
				"upper":          z.upper,
				"geometrySource": z.source,
			})
			bbox = unionBbox(bbox, z.bbox)
		}
		switch r.geometrySource {
		case "html-position":
			meta.Circle++
			meta.WithGeometry++
		case "html-polygon":
			meta.Polygon++
			meta.WithGeometry++
		default:
			meta.None++
		}
		meta.ByRegion["be"]++
		out = append(out, []any{
			r.id,      // id
			r.title,   // title
			"be",      // region
			"",        // descriptionFr (English-only publication)
			r.subject, // descriptionEn
			"",        // lieu
			"",        // urlPdf (no PDF twins exist)
			nullable(r.validFrom),
			nullable(r.validTo),
			true,             // ifr (the listing carries no flight-rule flags)
			true,             // vfr
			false,            // airac
			[]string{"EBBU"}, // fir
			r.adhp,           // adhp
			zones,            // zones
			bbox,             // bbox (nil marshals to null)
			r.geometrySource, // geometrySource
			"listing+html",   // parseConfidence
			[]string{},       // warnings
			r.pageURL,        // urlPdfEn: the English HTML page
			[]any{},          // contacts
			nil,              // penetration
			"",               // manager
		})
	}
	meta.Total = len(out)
	if n := len(out); n < minN || n > maxN {
		return SupArtifact{}, SupMeta{}, fmt.Errorf(
			"BE supplement count %d outside sanity window [%d, %d] - source format may have changed",
			n, minN, maxN)
	}
	return SupArtifact{Fields: supOutputFields, Rows: out}, meta, nil
}

func unionBbox(a, b []float64) []float64 {
	if len(b) != 4 {
		return a
	}
	if len(a) != 4 {
		return append([]float64(nil), b...)
	}
	return []float64{minf(a[0], b[0]), minf(a[1], b[1]), maxf(a[2], b[2]), maxf(a[3], b[3])}
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func minf(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}

func maxf(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}

func cosDeg(d float64) float64 {
	c := math.Cos(d * math.Pi / 180)
	if c < 0.1 {
		return 0.1
	}
	return c
}

func supListingSha(t *tree) string {
	data, ok := t.pages[supListPage]
	if !ok {
		return ""
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
