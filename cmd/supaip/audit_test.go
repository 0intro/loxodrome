// Corpus audit over the committed dataset: every supplement of the audit
// years is re-parsed from its cached PDF with the current extractor and
// compared against the committed row (parity), then an independent
// pdftotext -layout census of the PDF's coordinate tokens is checked against
// the parsed geometry in both directions: census axis values missing from
// every parsed vertex reveal zones the parser dropped, and parsed vertices
// missing from the census reveal misdecoded coordinates (arc tessellation
// legitimately lowers that fraction, so it is reported, not asserted).
//
// Heavy and cache-bound, so it runs only when SUPAIP_AUDIT names a report
// directory: SUPAIP_AUDIT=/tmp/audit go test ./cmd/supaip -run TestAuditCorpus
// It needs local/supaip-cache (built by any live run) and poppler's pdftotext.
package main

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
)

const auditFromYear = 2025

// The independent census grammar: DMS with explicit degree/minute marks, as
// poppler renders the supplements' tables, plus the packed DDMMSS form a few
// annexes use. Deliberately NOT the parser's own coordRe, so the census does
// not inherit its blind spots.
var (
	censusDMS    = regexp.MustCompile(`(\d{1,3})\s*[°º]\s*(\d{1,2})\s*['’′]\s*(\d{1,2}(?:[.,]\d+)?)\s*(?:["”″]|''|’’)?\s*(N|S|E|W)`)
	censusPacked = regexp.MustCompile(`\b(\d{6}(?:[.,]\d+)?)\s*(N|S)\s*[,;/ ]\s*(\d{7}(?:[.,]\d+)?)\s*(E|W)`)
)

type auditRow struct {
	id, title, region string
	urlPdf            string
	source            string
	confidence        string
	warnings          []string
	zones             []map[string]any
}

type auditReport struct {
	ID        string   `json:"id"`
	Title     string   `json:"title"`
	Region    string   `json:"region"`
	Source    string   `json:"source"`
	Zones     int      `json:"zones"`
	CensusLat int      `json:"censusLat"`
	CensusLon int      `json:"censusLon"`
	CovLat    float64  `json:"covLat"` // census values found in parsed geometry
	CovLon    float64  `json:"covLon"`
	Fidelity  float64  `json:"fidelity"` // parsed axis values found in the census
	Parity    string   `json:"parity"`   // "ok" | a short diff note
	Warnings  []string `json:"warnings,omitempty"`
	CacheFile string   `json:"cacheFile"`
}

func loadDataset(t *testing.T) ([]string, [][]any) {
	t.Helper()
	data, err := os.ReadFile("../../public/data/fr-supaip.json")
	if err != nil {
		t.Skipf("committed dataset unavailable: %v", err)
	}
	var doc struct {
		Fields []string `json:"fields"`
		Rows   [][]any  `json:"rows"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatalf("fr-supaip.json: %v", err)
	}
	return doc.Fields, doc.Rows
}

func rowYear(title string) int {
	i := strings.IndexByte(title, '/')
	if i < 0 {
		return 0
	}
	y, _ := strconv.Atoi(title[i+1:])
	return y
}

func decodeRow(fields []string, r []any) auditRow {
	f := map[string]int{}
	for i, k := range fields {
		f[k] = i
	}
	str := func(k string) string {
		s, _ := r[f[k]].(string)
		return s
	}
	var warns []string
	if ws, ok := r[f["warnings"]].([]any); ok {
		for _, w := range ws {
			warns = append(warns, w.(string))
		}
	}
	var zones []map[string]any
	if zs, ok := r[f["zones"]].([]any); ok {
		for _, z := range zs {
			zones = append(zones, z.(map[string]any))
		}
	}
	return auditRow{
		id: str("id"), title: str("title"), region: str("region"),
		urlPdf: str("urlPdf"), source: str("geometrySource"),
		confidence: str("parseConfidence"), warnings: warns, zones: zones,
	}
}

// canonical round-trips a value through JSON so struct-emitted and
// map-decoded forms of the same zones compare equal.
func canonical(t *testing.T, v any) any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var out any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return out
}

// axisValues collects every latitude and longitude the committed zones state:
// ring vertices, multipolygon vertices and circle centres.
func axisValues(zones []map[string]any) (lats, lons []float64) {
	addPt := func(p []any) {
		lats = append(lats, p[0].(float64))
		lons = append(lons, p[1].(float64))
	}
	for _, z := range zones {
		g, _ := z["geometry"].(map[string]any)
		if g == nil {
			continue
		}
		switch g["type"] {
		case "polygon":
			for _, p := range g["ring"].([]any) {
				addPt(p.([]any))
			}
		case "multipolygon":
			for _, ring := range g["rings"].([]any) {
				for _, p := range ring.([]any) {
					addPt(p.([]any))
				}
			}
		case "circle":
			addPt(g["center"].([]any))
		}
	}
	return lats, lons
}

func dmsVal(deg, min, sec string) float64 {
	d, _ := strconv.ParseFloat(deg, 64)
	m, _ := strconv.ParseFloat(min, 64)
	s, _ := strconv.ParseFloat(strings.ReplaceAll(sec, ",", "."), 64)
	return d + m/60 + s/3600
}

// centreLeadRe marks a coordinate the supplement itself calls a CENTRE.
var centreLeadRe = regexp.MustCompile(`(?i)centr\S*\s*sur`)

// maskCentres blanks the coordinate pair following each "centré sur", so the
// census counts BOUNDARY coordinates alone. An arc's centre is not a point on
// the boundary, so no correctly parsed vertex can ever carry it, and counting
// it makes an exactly parsed arc zone look short: a supplement printing two
// vertices and one centre is capped at a coverage of 0.67 however right it
// is, which is what most of the verified low-coverage list below was. A
// circle's centre IS in the parsed geometry, so masking it only gives up a
// guaranteed hit and never invents one. Recognising the phrase reads the
// supplement's own vocabulary, not the parser's coordinate grammar, so the
// census stays independent of what it audits.
func maskCentres(text string) string {
	b := []byte(text)
	for _, lead := range centreLeadRe.FindAllStringIndex(text, -1) {
		at := lead[1]
		// Only a coordinate the document wrote RIGHT AFTER the phrase, with
		// nothing but spacing and punctuation between. A reach in characters
		// would cross columns on these wide tables and could blank a
		// NEIGHBOURING zone's vertex, which is the one direction an audit
		// must not move: it would hide a gap rather than report one.
		for n := 0; n < 2; n++ {
			m := censusDMS.FindStringIndex(text[at:])
			if m == nil || !onlyGap(text[at:at+m[0]]) {
				break
			}
			for i := at + m[0]; i < at+m[1]; i++ {
				b[i] = ' '
			}
			at += m[1]
		}
	}
	return string(b)
}

// onlyGap reports whether s separates a centre phrase from its coordinate:
// spacing and the punctuation these tables put between the two, nothing else.
func onlyGap(s string) bool {
	return strings.TrimLeft(s, " \t\r\n,;:.-\u2013\u2014()") == ""
}

// censusAxes scans the poppler layout text for coordinate tokens and returns
// the distinct latitude and longitude magnitudes it states (signed by
// hemisphere).
func censusAxes(text string) (lats, lons []float64) {
	text = maskCentres(text)
	seenLat := map[int64]bool{}
	seenLon := map[int64]bool{}
	add := func(v float64, hemi string) {
		if hemi == "S" || hemi == "W" {
			v = -v
		}
		key := int64(math.Round(v * 1e5))
		if hemi == "N" || hemi == "S" {
			if !seenLat[key] {
				seenLat[key] = true
				lats = append(lats, v)
			}
		} else if !seenLon[key] {
			seenLon[key] = true
			lons = append(lons, v)
		}
	}
	for _, m := range censusDMS.FindAllStringSubmatch(text, -1) {
		add(dmsVal(m[1], m[2], m[3]), m[4])
	}
	for _, m := range censusPacked.FindAllStringSubmatch(text, -1) {
		latS := strings.ReplaceAll(m[1], ",", ".")
		lonS := strings.ReplaceAll(m[3], ",", ".")
		add(dmsVal(latS[:2], latS[2:4], latS[4:]), m[2])
		add(dmsVal(lonS[:3], lonS[3:5], lonS[5:]), m[4])
	}
	return lats, lons
}

func coverage(census, parsed []float64, eps float64) float64 {
	if len(census) == 0 {
		return 1
	}
	hit := 0
	for _, c := range census {
		for _, p := range parsed {
			if math.Abs(c-p) <= eps {
				hit++
				break
			}
		}
	}
	return float64(hit) / float64(len(census))
}

func TestAuditCorpus(t *testing.T) {
	outDir := os.Getenv("SUPAIP_AUDIT")
	if outDir == "" {
		t.Skip("set SUPAIP_AUDIT=<report dir> to run the corpus audit")
	}
	cacheDir := "../../local/supaip-cache"
	if _, err := os.Stat(cacheDir); err != nil {
		t.Skipf("no PDF cache: %v", err)
	}
	nav, err := loadNavaids("../../public/data/fr-navaids.json")
	if err != nil {
		t.Fatalf("navaids: %v", err)
	}
	fields, rows := loadDataset(t)

	const eps = 1e-4
	var reports []auditReport
	parityFail := 0
	for _, raw := range rows {
		row := decodeRow(fields, raw)
		if rowYear(row.title) < auditFromYear {
			continue
		}
		cacheFile := filepath.Join(cacheDir, filepath.Base(row.urlPdf))
		data, err := os.ReadFile(cacheFile)
		if err != nil {
			// A lapsed supplement whose PDF the SIA no longer serves cannot
			// be re-verified; its committed row is the durable record.
			t.Logf("%s (%s): PDF unavailable, committed row stands: %v",
				row.title, row.region, err)
			reports = append(reports, auditReport{
				ID: row.id, Title: row.title, Region: row.region,
				Source: row.source, Zones: len(row.zones),
				CovLat: 1, CovLon: 1, Fidelity: 1,
				Parity: "no-pdf", Warnings: row.warnings,
			})
			continue
		}

		// Parity: the committed zones against a fresh parse of the same PDF.
		gr := parsePDF(data, nav)
		parity := "ok"
		fresh := canonical(t, zonesJSON(gr.zones))
		committed := canonical(t, row.zones)
		if committed == nil {
			committed = canonical(t, []zoneJSON{})
		}
		if !reflect.DeepEqual(fresh, committed) {
			parity = fmt.Sprintf("zones differ (committed %d, fresh %d, source %s -> %s)",
				len(row.zones), len(gr.zones), row.source, gr.source)
			parityFail++
		} else if gr.source != row.source {
			parity = fmt.Sprintf("source differs (%s -> %s)", row.source, gr.source)
			parityFail++
		}

		// Independent census over the poppler layout text.
		text, perr := runPdftotext(data, "-layout", "-", "-")
		if perr != nil {
			t.Errorf("%s: pdftotext: %v", row.title, perr)
			continue
		}
		cLat, cLon := censusAxes(string(text))
		pLat, pLon := axisValues(row.zones)
		rep := auditReport{
			ID: row.id, Title: row.title, Region: row.region,
			Source: row.source, Zones: len(row.zones),
			CensusLat: len(cLat), CensusLon: len(cLon),
			CovLat: coverage(cLat, pLat, eps), CovLon: coverage(cLon, pLon, eps),
			Fidelity: coverage(pLat, cLat, eps),
			Parity:   parity, Warnings: row.warnings,
			CacheFile: filepath.Base(cacheFile),
		}
		reports = append(reports, rep)
	}

	sort.Slice(reports, func(i, j int) bool {
		if reports[i].CovLat != reports[j].CovLat {
			return reports[i].CovLat < reports[j].CovLat
		}
		return reports[i].Title < reports[j].Title
	})
	var buf strings.Builder
	for _, r := range reports {
		b, _ := json.Marshal(r)
		buf.Write(b)
		buf.WriteByte('\n')
	}
	path := filepath.Join(outDir, "supaip-audit.jsonl")
	if err := os.WriteFile(path, []byte(buf.String()), 0o644); err != nil {
		t.Fatalf("write report: %v", err)
	}
	t.Logf("audited %d supplements; parity failures %d; report %s",
		len(reports), parityFail, path)

	// Every parity divergence is a regression once the committed dataset and
	// the parser agree (they were reconciled by the 2026-08 audit).
	for _, r := range reports {
		if r.Parity != "ok" && r.Parity != "no-pdf" {
			t.Errorf("%s: committed row diverges from the current parser: %s", r.Title, r.Parity)
		}
	}

	// KEYED BY ID, not by title: four 2026 titles are shared across regions
	// (001, 002, 003 and 004 each name a metropole supplement and one to
	// three overseas ones), so a title key lets a metropole row vouch for a
	// pac-n one. That is what hid New Caledonia's 001/2026 behind the
	// metropole entry of the same name.
	//
	// The rows with no geometry despite the PDF carrying >= 4 census
	// latitudes, each verified by hand against its PDF. None of them
	// describes airspace: what their coordinate tables state is a procedure,
	// a marking or a facility.
	//   140/2025, 208/2025  RNAV procedure waypoint tables (Bâle-Mulhouse)
	//   009/2026  VFR night itinerary waypoints (Paris-Saclay), not a zone
	//   043/2026  displaced-threshold table (runway ends), not a zone
	//   075/2026  a cable's deviation profile points (Gentilly), not a zone
	//   117/2026  helicopter transit itinerary points (Monaco GP), no zone
	//             coordinates of its own
	//   143/2026  RNP SID waypoint tables (Bâle-Mulhouse)
	//   158/2026, 165/2026  VFR reporting points (Courchevel)
	//   164/2026  RNAV SID waypoint tables (Beauvais)
	//   193/2026  Brest's apron redesign: parking-stand and INS
	//             check-point tables, which the whole-document fallback
	//             used to cluster into a ring over the taxiways
	//   pac-n 001/2026  the AMG sectors of New Caledonia's ADS-B Tier 1
	//             service, minimum vectoring altitudes an ATC unit works
	//             to, not an airspace a pilot is kept out of
	wantNoGeom := map[string]bool{
		"metropole-2025-140": true, "metropole-2025-208": true,
		"metropole-2026-009": true, "metropole-2026-043": true,
		"metropole-2026-075": true, "metropole-2026-117": true,
		"metropole-2026-143": true, "metropole-2026-158": true,
		"metropole-2026-164": true, "metropole-2026-165": true,
		"metropole-2026-193": true, "pac-n-2026-001": true,
	}
	// The rows whose census coverage stays below 0.7 with geometry present,
	// each verified. Three reasons, none of them a dropped boundary:
	//
	// The census counts coordinates the supplement prints OUTSIDE its zone
	// tables: annex chart-extract labels and per-zone reference points (023,
	// 025, 040, 062, 125, 127), and 182/2026's annex FBZ XWING table, a
	// flight buffer the supplement itself marks "pour les besoins de dépôt
	// de plan de vol uniquement" and which is therefore not airspace to draw.
	//
	// An arc's CENTRE is not a boundary point, and maskCentres only reaches
	// the ones printed right after their phrase; in a multi-column table the
	// centre sits on the row BELOW, past a neighbouring column's text, where
	// masking it could blank a real vertex instead (126, 160, 197). Those
	// three parse every zone exactly.
	//
	// And the partially recovered exercise supplements, whose remaining
	// zones are stated in prose or in blocks the extractors cannot read
	// (207/2025's staggered four-wide offshore tables, 006/2026's fused
	// mixed columns keeping only ZRT BIZERTE, 001, 053, 099, 176, and
	// pac-p 003's MARARA26).
	allowLowCov := map[string]bool{
		"metropole-2025-207": true, "metropole-2026-006": true,
		"metropole-2026-023": true, "metropole-2026-025": true,
		"metropole-2026-040": true, "metropole-2026-062": true,
		"metropole-2026-125": true, "metropole-2026-126": true,
		"metropole-2026-127": true, "metropole-2026-160": true,
		"metropole-2026-182": true, "metropole-2026-197": true,
		"metropole-2026-001": true, "metropole-2026-053": true,
		"metropole-2026-099": true, "metropole-2026-176": true,
		"pac-p-2026-003": true,
	}
	lowCov, noGeomWithCoords := 0, 0
	for _, r := range reports {
		if r.Zones > 0 && (r.CovLat < 0.7 || r.CovLon < 0.7) {
			lowCov++
			if !allowLowCov[r.ID] {
				t.Errorf("%s (%s): census coverage %.2f/%.2f with %d zones is not in the verified allowlist",
					r.Title, r.ID, r.CovLat, r.CovLon, r.Zones)
			}
		}
		if r.Zones == 0 && r.CensusLat >= 4 {
			noGeomWithCoords++
			if !wantNoGeom[r.ID] {
				t.Errorf("%s (%s): no geometry despite %d census latitudes and not in the verified list",
					r.Title, r.ID, r.CensusLat)
			}
		}
	}
	t.Logf("low census coverage with geometry: %d; no geometry but >=4 census lats: %d",
		lowCov, noGeomWithCoords)
}
