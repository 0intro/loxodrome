// geom.go: parse a SUP AIP area's geometry out of the reconstructed PDF
// text. The supported constructs, in order of frequency: a DMS vertex table
// (polygon), an arc spliced into a boundary ("arc horaire de R NM ... centré
// sur <DMS>"), a circle ("cercle de R NM de rayon centré sur <DMS>"), and
// best-effort radial/DME fixes ("RDL 238 / 5.5 NM TNO"). Coordinates are
// normalised into the packed AIXM form and decoded by internal/aip; arcs and
// circles are tessellated by internal/geodesy. Whatever cannot be parsed
// leaves the supplement with no geometry rather than failing the build.

package main

import (
	"fmt"
	"math"
	"reflect"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"unicode"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/geodesy"
)

type latlon = [2]float64

// geometry is a parsed SUP area: a single polygon ring, several rings
// (multipolygon, for multi-zone supplements), or a circle.
type geometry struct {
	kind    string // "polygon" | "multipolygon" | "circle"
	ring    []latlon
	rings   [][]latlon
	center  latlon
	radiusM float64
}

// zone is one named sub-area of a supplement (e.g. "CTR LE MANS Temporaire"),
// with its own geometry and vertical limits but sharing the supplement's id,
// dates, and region.
type zone struct {
	name        string
	geom        *geometry
	bbox        []float64 // [minLat, minLon, maxLat, maxLon]
	lower       []string  // VerticalLimit triple [code, value, uom] or nil
	upper       []string
	source      string       // pdf-polygon | pdf-circle | pdf-mixed | none (sameAs)
	activations []activation // scheduled windows from "DATES ET HEURES D'ACTIVITÉ"
	// sameAs carries the designators of the published airspaces whose lateral
	// limits the zone adopts ("Identiques à celles de la zone LF-D5",
	// 099/2026): the supplement prints no coordinates for such a zone, so the
	// reference IS the geometry statement.
	sameAs string
}

// geomResult is everything parseGeometry recovers from one supplement's PDF.
type geomResult struct {
	zones      []zone
	bbox       []float64 // union over all zones, or nil
	fir        []string
	adhp       []string
	source     string // pdf-polygon | pdf-circle | pdf-mixed | none
	confidence string // high | medium | low | none
	warnings   []string

	// SUP-level coordination block (contacts.go): the "Activité réelle connue
	// de" radio table, the CONDITIONS DE PÉNÉTRATION rule, and the ORGANISME
	// GESTIONNAIRE unit. Populated regardless of geometry; respaced by
	// respaceDoc.
	contacts    []contactFreq
	penetration *penetrationRule
	manager     string
}

// navaidTable maps a navaid ident to its position, for radial/DME fixes.
type navaidTable map[string]latlon

// A coordinate token. The degree sign is °, º, or U+FFFD (the SIA fonts'
// unmapped-glyph stand-in); minutes use ' or ′, or a raw C0 byte, which is
// where a font's unmapped prime lands when the stand-in isn't U+FFFD
// (142/2026 prints its circle centres as 48�51\x1930\x19\x19N while its
// polygon vertices print 49�11\x2726\x27\x27N); seconds may be decimal and are
// followed by an optional second mark and the hemisphere letter. A row's text
// joins its cells with single spaces and never holds a newline, so accepting
// the whole C0 range cannot run a coordinate past its own line.
var coordRe = regexp.MustCompile(`(\d{1,3})[°º\x{FFFD}](\d{1,2})['′‘’\x00-\x1f](\d{1,2}(?:[.,]\d+)?)["'″‘’\x{FFFD} \x00-\x1f]*([NSEW])`)

// The packed DDMMSS form ("490158N 0025711W") a few supplements print
// instead of the °-form (030/2026's ZRT tables). Latitude is exactly six
// digits, longitude exactly seven; the scanner rejects a match preceded by a
// digit by hand, since a consuming guard would swallow the hemisphere letter
// that separates a jammed pair ("490158N0025711W") and lose the longitude.
var (
	packedLatRe = regexp.MustCompile(`(\d{6}(?:[.,]\d+)?)([NS])`)
	packedLonRe = regexp.MustCompile(`(\d{7}(?:[.,]\d+)?)([EW])`)
)

// A radius such as "3 Nm", "3NM", "0.5 km". No trailing word boundary: the
// reconstructed text jams the unit into the next word ("3Nmderayon").
var radiusRe = regexp.MustCompile(`(?i)(\d+(?:[.,]\d+)?)\s*(NM|KM)`)

// The 045/2026 layout splits each vertex across two rows: a bare DMS with no
// hemisphere at all, then a row opening with the hemisphere letters and the
// longitude:
//
//	43°31'30.00''
//	N,006°30'29.00''E
//
// bareDMSRe recognises the first row (the whole cell, nothing else on it) and
// hemiPrefixRe the second row's lead-in.
var (
	bareDMSRe    = regexp.MustCompile(`^\(?(\d{1,3})[°º\x{FFFD}](\d{1,2})['′‘’\x00-\x1f](\d{1,2}(?:[.,]\d+)?)\s*["'″‘’\x{FFFD}]*[,;]?\)?$`)
	hemiPrefixRe = regexp.MustCompile(`^\s*\(?([NS])\s*[,;.]?\s*`)
)

// A trailing longitude that lost its hemisphere letter to an SIA typo
// ("44°23'20.00"N,006°02'09.00"", 047/2026): the latitude's hemisphere and
// the comma are there, the final E/W is not. Three degree digits keep it
// longitude-shaped.
var trailingBareLonRe = regexp.MustCompile(`[NS]\s*[,;]\s*\(?(\d{3})[°º\x{FFFD}](\d{1,2})['′‘’\x00-\x1f](\d{1,2}(?:[.,]\d+)?)\s*["'″‘’\x{FFFD}]*\)?\s*$`)

// continuityStart picks the column window a fused cell's vertices belong to
// by ring continuity: each candidate start assigns vertex i to column
// start+i, scored by the distance to that column's LAST vertex; a column
// with no vertices yet takes a large penalty. No candidate window touching
// any started column means no evidence, and the caller keeps its X anchor.
func continuityStart(colXs []float64, vs []latlon, out map[float64]*colGeom) (int, bool) {
	maxS := len(colXs) - len(vs)
	best, bestScore := -1, math.Inf(1)
	for s := 0; s <= maxS; s++ {
		score := 0.0
		anyPrior := false
		for i, v := range vs {
			g := out[colXs[s+i]]
			if len(g.verts) == 0 {
				score += 100
				continue
			}
			anyPrior = true
			last := g.verts[len(g.verts)-1]
			score += math.Abs(v[0]-last[0]) + math.Abs(v[1]-last[1])
		}
		if anyPrior && score < bestScore {
			best, bestScore = s, score
		}
	}
	return best, best >= 0
}

// allAxis reports whether every token is a latitude (lat=true) or every one a
// longitude (lat=false).
func allAxis(toks []coordTok, lat bool) bool {
	for _, t := range toks {
		if t.isLat != lat {
			return false
		}
	}
	return true
}

// pendingsAwait reports whether EVERY column holds a pending arc at the given
// stage: hasLat=false (awaiting its centre latitude) or true (awaiting the
// longitude).
func pendingsAwait(colXs []float64, pending map[float64]*arcCell, hasLat bool) bool {
	for _, cx := range colXs {
		p := pending[cx]
		if p == nil || p.hasLat != hasLat {
			return false
		}
	}
	return true
}

// refDesignatorRe matches the airspace designators a by-reference lateral
// limit cites: LF-D5, LF-D12G, LF-R146A/B, TRA6, CBA25. Uppercase-only so the
// jammed French prose around them cannot match.
var refDesignatorRe = regexp.MustCompile(`(LF\s*-?\s*[RDPT]\s*\d+[A-Z]?\d?(?:/[A-Z0-9]{1,2})?|TRA\s*\d+[A-Z]?|CBA\s*\d+[A-Z]?)`)

// extractRefDesignators pulls the cited designators out of an "Identiques à
// celles de la zone ..." reference's accumulated text (C0 bytes and the
// unmapped-glyph stand-in stripped first, so a designator wrapped across rows
// reads whole), normalised to the LF-XN form, deduplicated, order kept.
func extractRefDesignators(s string) string {
	if s == "" {
		return ""
	}
	clean := strings.Map(func(r rune) rune {
		if r < 0x20 || r == '\uFFFD' {
			return -1
		}
		return r
	}, s)
	var out []string
	seen := map[string]bool{}
	for _, m := range refDesignatorRe.FindAllString(clean, -1) {
		d := strings.ReplaceAll(strings.ReplaceAll(m, " ", ""), "\t", "")
		if strings.HasPrefix(d, "LF") && !strings.HasPrefix(d, "LF-") {
			d = "LF-" + d[2:]
		}
		if !seen[d] {
			seen[d] = true
			out = append(out, d)
		}
	}
	return strings.Join(out, ", ")
}

// resolveLonSign signs a hemisphere-less longitude magnitude from the
// longitudes its own column has already resolved: unanimous sign and at
// least one prior within a degree, else no answer (a NOTAM viewer must not
// draw wrong airspace on a guess).
func resolveLonSign(mag float64, seen []float64) (float64, bool) {
	if len(seen) == 0 {
		return 0, false
	}
	neg := seen[0] < 0
	for _, s := range seen[1:] {
		if (s < 0) != neg {
			return 0, false
		}
	}
	v := mag
	if neg {
		v = -mag
	}
	for _, s := range seen {
		if math.Abs(v-s) <= 1.0 {
			return v, true
		}
	}
	return 0, false
}

// A radial/DME fix: bearing (deg), distance + unit, navaid ident. Tolerates
// the jammed text ("RDL238°TSU/5.5NM DME ILS TNO").
var radialRe = regexp.MustCompile(`RDL\s*(\d{1,3})\s*[°º\x{FFFD}][^/]*?/\s*(\d+(?:[.,]\d+)?)\s*(NM|Nm|nm)\b[^A-Z]*(?:DME\s*)?(?:ILS\s*)?([A-Z]{2,4})`)

// Altitude tokens for the vertical-limit envelope. ftRe is case-insensitive
// (Word PDFs print "FT") and accepts 1-5 digits; the captured reference is
// uppercased before use. aglProseRe normalizes the French prose forms of
// "above the surface" ("2 500 ft au-dessus du sol", "1000 ft/sol") to the
// ASFC token ftRe already understands.
var (
	flRe       = regexp.MustCompile(`FL\s*(\d{2,3})`)
	ftRe       = regexp.MustCompile(`(?i)(\d{1,5})\s*ft\s*(ASFC|AGL|AMSL|SFC)?`)
	aglProseRe = regexp.MustCompile(`(?i)/\s*SOL\b|AU[ \-]DESSUS\s+(?:DU\s+SOL|DE\s+LA\s+SURFACE)`)
	identRe    = regexp.MustCompile(`(LF[A-Z]{2})(?:[^A-Z]|$)`)
	adMarkerRe = regexp.MustCompile(`[ \-:](AD|HP)\b`)
)

type coordTok struct {
	val   float64
	isLat bool
	pos   int // byte offset of the token in its line
}

// ptv is a parsed coordinate vertex with the cell X and row Y it came from,
// so multi-column tables (one zone per column) can be separated.
type ptv struct {
	x, y float64
	v    latlon
}

// segment is a contiguous run of geometry rows (vertex rows and/or arc lines)
// bounded by non-geometry rows: one boundary group, or a standalone circle.
type segment struct {
	points []ptv
	arcs   []arcSpec // non-circle arcs forming part of the boundary
	circ   *arcSpec  // a full circle
}

// parseGeometry turns reconstructed PDF rows into a geometry result: a list
// of named zones (each its own area + vertical limits), plus the
// supplement-level FIR / aerodrome idents and a union bounding box. nav (may
// be empty) resolves radial/DME-only fixes in the fallback path.
func parseGeometry(rows []prow, nav navaidTable) geomResult {
	res := geomResult{source: "none", confidence: "none"}
	lines := make([]string, len(rows))
	for i, r := range rows {
		lines[i] = r.text()
	}
	res.fir, res.adhp = parseLieu(lines)

	// SUP-level coordination block, independent of geometry (a zone-less
	// supplement can still carry contact frequencies / a penetration rule).
	res.contacts = parseContacts(rows)
	res.penetration = parsePenetration(rows)
	res.manager = parseManager(rows)

	// Primary: named zones from the "LIMITES LATÉRALES / VERTICALES" markers,
	// one zone per column. Fallback: no markers -> one unnamed zone built from
	// the whole document.
	zones, warns := parseZones(rows)
	if len(zones) == 0 && !isReportingPointDoc(lines) {
		if z, w, ok := fallbackZone(rows, lines, nav); ok {
			zones = []zone{z}
			warns = append(warns, w...)
		}
	}
	// A supplement that prints its zone tables twice (010/2026 repeats the
	// whole block per activation period) would otherwise draw every zone
	// doubled; identical rows collapse, differing verticals stay distinct.
	if deduped := dedupZones(&zones); deduped {
		warns = append(warns, "deduped-zones")
	}
	if dropped := dropUnnamedAmidNamed(&zones); dropped {
		warns = append(warns, "dropped-unnamed-zone")
	}
	// A single-zone supplement's marker-derived name is often a section heading
	// (rejected by plausibleName) or blank, while the real name is the heading at
	// the top of the document; fall back to it.
	if len(zones) == 1 && zones[0].name == "" {
		if t := prettifyName(documentTitle(lines)); t != "" {
			zones[0].name = t
		}
	}
	if len(zones) == 0 {
		return res
	}

	named, unnamed := parseActivations(rows)
	attachActivations(zones, named, unnamed)

	res.zones = zones
	res.warnings = warns
	mixed, allCircle, hasGeom := false, true, false
	for _, z := range zones {
		if z.bbox != nil {
			if res.bbox == nil {
				res.bbox = append([]float64(nil), z.bbox...)
			} else {
				res.bbox = mergeBbox(res.bbox, z.bbox)
			}
		}
		if z.geom == nil {
			continue // a by-reference zone says nothing about the row's source
		}
		hasGeom = true
		if z.source == "pdf-mixed" {
			mixed = true
		}
		if z.source != "pdf-circle" {
			allCircle = false
		}
	}
	switch {
	case !hasGeom:
		// Only by-reference zones: the row carries zones but no drawable
		// geometry of its own.
	case mixed:
		res.source = "pdf-mixed"
	case allCircle:
		res.source = "pdf-circle"
	default:
		res.source = "pdf-polygon"
	}
	res.confidence = confidenceFor(res.source, res.warnings)
	if len(zones) > 1 && res.confidence == "high" {
		res.confidence = "medium"
	}
	sort.Strings(res.warnings)
	res.warnings = slices.Compact(res.warnings)
	return res
}

// dedupZones removes exact duplicates (name, geometry, limits, source),
// keeping the first occurrence and the zone order. Activations attach later
// by name, so the survivor carries every window either copy would have.
func dedupZones(zones *[]zone) bool {
	kept := (*zones)[:0]
	dropped := false
	for _, z := range *zones {
		dup := false
		for _, k := range kept {
			if k.name == z.name && k.source == z.source &&
				reflect.DeepEqual(k.geom, z.geom) &&
				reflect.DeepEqual(k.lower, z.lower) &&
				reflect.DeepEqual(k.upper, z.upper) {
				dup = true
				break
			}
		}
		if dup {
			dropped = true
			continue
		}
		kept = append(kept, z)
	}
	*zones = kept
	return dropped
}

// dropUnnamedAmidNamed removes zones that have no name when the supplement has
// at least one named zone. An unnamed column among named ones is almost always
// a parse artifact (leftover vertices clustered into a phantom zone, e.g. the
// LF-D blocks in 077/2026), and it renders as a garbage polygon. The single-
// zone fallback (no markers, so no names at all) is left untouched. Returns
// whether anything was dropped.
func dropUnnamedAmidNamed(zones *[]zone) bool {
	hasNamed := false
	for _, z := range *zones {
		if z.name != "" {
			hasNamed = true
			break
		}
	}
	if !hasNamed {
		return false
	}
	kept := (*zones)[:0]
	dropped := false
	for _, z := range *zones {
		if z.name == "" {
			dropped = true
			continue
		}
		kept = append(kept, z)
	}
	*zones = kept
	return dropped
}

// fallbackZone derives a single unnamed zone from the whole document when no
// zone markers are present: cluster coordinates into columns, split stacked
// zones at large gaps, splice arcs, fold in circles, else a radial-DME ring.
func fallbackZone(rows []prow, lines []string, nav navaidTable) (zone, []string, bool) {
	var segs []segment
	var cur *segment
	endSeg := func() {
		if cur != nil {
			segs = append(segs, *cur)
			cur = nil
		}
	}
	for _, row := range rows {
		line := row.text()
		folded := fold(line)
		if isArcLine(folded) {
			if a, ok := parseArc(line, folded); ok {
				if cur == nil {
					cur = &segment{}
				}
				if a.circle {
					cur.circ = &a
				} else {
					cur.arcs = append(cur.arcs, a)
				}
			}
			continue
		}
		var pts []ptv
		for _, c := range row.cells {
			for _, v := range lineVertices(c.text) {
				pts = append(pts, ptv{x: c.x, y: row.y, v: v})
			}
		}
		if len(pts) > 0 {
			if cur == nil {
				cur = &segment{}
			}
			cur.points = append(cur.points, pts...)
			continue
		}
		endSeg()
	}
	endSeg()

	var rings [][]latlon
	var circles []arcSpec
	spliced, arcOrphan := false, false
	for _, s := range segs {
		segSpliced := false
		for _, col := range clusterColumns(s.points) {
			for _, sub := range splitRings(dedupeRing(col)) {
				r := append([]latlon(nil), sub...)
				if len(r) >= 3 {
					if spliceArcs(&r, s.arcs) > 0 {
						segSpliced = true
					}
					rings = append(rings, r)
				} else if len(r) == 2 && len(s.arcs) > 0 {
					if spliceArcs(&r, s.arcs) > 0 && len(r) >= 3 {
						rings = append(rings, r)
						segSpliced = true
					}
				}
			}
		}
		if s.circ != nil {
			circles = append(circles, *s.circ)
		}
		if len(s.arcs) > 0 && !segSpliced {
			arcOrphan = true
		}
		spliced = spliced || segSpliced
	}
	ringsDropped := 0
	if len(rings) > 0 {
		rings, ringsDropped = keepSimpleRings(rings)
	}
	if len(rings) > 0 {
		for _, c := range circles {
			rings = append(rings, circleRingPts(c))
		}
	}

	lower, upper := parseVerticals(lines)
	var warns []string
	if arcOrphan {
		warns = append(warns, "arc-not-anchored")
	}
	if ringsDropped > 0 {
		warns = append(warns, "dropped-self-intersecting")
	}
	switch {
	case len(rings) > 0:
		src := "pdf-polygon"
		if spliced {
			src = "pdf-mixed"
		}
		return zone{geom: ringsGeometry(rings), bbox: ringsBbox(rings), lower: lower, upper: upper, source: src}, warns, true
	case len(circles) == 1:
		c := circles[0]
		g := &geometry{kind: "circle", center: roundPt(c.center), radiusM: math.Round(c.radiusM)}
		return zone{geom: g, bbox: circleBbox(c.center, c.radiusM), lower: lower, upper: upper, source: "pdf-circle"}, warns, true
	case len(circles) > 1:
		cr := make([][]latlon, len(circles))
		for i, c := range circles {
			cr[i] = circleRingPts(c)
		}
		return zone{geom: ringsGeometry(cr), bbox: ringsBbox(cr), lower: lower, upper: upper, source: "pdf-circle"}, warns, true
	default:
		if pts := resolveRadials(lines, nav); len(pts) >= 3 {
			return zone{geom: &geometry{kind: "polygon", ring: roundRing(pts)}, bbox: ringBbox(pts), lower: lower, upper: upper, source: "pdf-polygon"}, append(warns, "radial-magnetic-bearing"), true
		}
	}
	return zone{}, nil, false
}

// --- marker-driven named zones -------------------------------------------

const colTol = 40.0 // X tolerance for matching a cell to a column anchor

// isLatMarker matches a "LIMITES LATÉRALES" sub-marker row (the accented É
// comes through as U+FFFD, so we match a prefix), excluding the combined
// "LIMITES LATÉRALES ET VERTICALES" section header.
func isLatMarker(r prow) bool {
	f := fold(r.text())
	return strings.Contains(f, "limiteslat") && !strings.Contains(f, "vert")
}

func isVertMarker(r prow) bool {
	return strings.Contains(fold(r.text()), "limitesvert")
}

// markerColumns returns the X anchor of each marker cell on a marker row (the
// per-zone columns); falls back to every cell's X.
func markerColumns(r prow) []float64 {
	var xs []float64
	for _, c := range r.cells {
		if strings.Contains(fold(c.text), "limiteslat") {
			xs = append(xs, c.x)
		}
	}
	if len(xs) == 0 {
		for _, c := range r.cells {
			xs = append(xs, c.x)
		}
	}
	return xs
}

// jammedMarkerColumns recovers the per-zone columns when the marker row's
// cells fused into one ("LIMITESLATÉRALESLIMITESLATÉRALES…", 052/2026): the
// marker text says how many columns there are, and the zone-name row above
// still carries one cell per column, so its Xs stand in. Returns nil when the
// row is not a fused multi-marker or no matching name row is found.
func jammedMarkerColumns(rows []prow, markerIdx int) []float64 {
	n := strings.Count(fold(rows[markerIdx].text()), "limiteslat")
	if n < 2 || len(markerColumns(rows[markerIdx])) != 1 {
		return nil
	}
	for k := markerIdx - 1; k >= 0 && k >= markerIdx-3; k-- {
		r := rows[k]
		if len(r.cells) != n || !looksLikeZoneNames(r.text()) {
			continue
		}
		xs := make([]float64, n)
		for i, c := range r.cells {
			xs[i] = c.x
		}
		return xs
	}
	return nil
}

// parseZones extracts named sub-zones using the LIMITES LATÉRALES / LIMITES
// VERTICALES markers; one zone per column, matched to its name (the row above)
// and vertical limits (the rows below the vertical marker) by cell X.
func parseZones(rows []prow) ([]zone, []string) {
	var zones []zone
	var warns []string
	for i := 0; i < len(rows); i++ {
		if !isLatMarker(rows[i]) {
			continue
		}
		colXs := markerColumns(rows[i])
		if xs := jammedMarkerColumns(rows, i); xs != nil {
			colXs = xs
		}
		names := zoneNames(rows, i, colXs)
		j := i + 1
		var coordRows []prow
		for j < len(rows) && !isVertMarker(rows[j]) && !isLatMarker(rows[j]) {
			coordRows = append(coordRows, rows[j])
			j++
		}
		var vertRows []prow
		if j < len(rows) && isVertMarker(rows[j]) {
			j++
			for j < len(rows) && !isLatMarker(rows[j]) && !sectionEnd(rows[j]) {
				vertRows = append(vertRows, rows[j])
				j++
			}
		}
		var block []zone
		if len(colXs) == 1 && countInterleavedNames(coordRows) >= 2 {
			// The big exercise supplements (053/2026's 95 zones) stack every
			// zone in ONE lateral column, each zone's name and vertical band
			// on a row beside its vertices; the generic per-column walk reads
			// that as one garbled column.
			block = interleavedZones(coordRows, colXs[0])
		} else {
			cols := collectColumns(coordRows, colXs)
			for _, cx := range colXs {
				g := cols[cx]
				z, w, ok := buildZone(names[cx], g.verts, g.arcs, g.circles, extractRefDesignators(g.sameAs), vertRows, colXs, cx)
				// The warnings surface even when the zone fails to build: a
				// ring dropped as self-intersecting is exactly the parse
				// defect the meta must count.
				warns = append(warns, w...)
				if ok {
					block = append(block, z)
				}
			}
		}
		if inheritSoleVertical(block) {
			warns = append(warns, "inherited-vertical")
		}
		// One lateral area carrying several named vertical bands (a "Low" and a
		// "High" sharing the same circle, 147/2025) is really several
		// vertically-stacked zones; split it so each band is its own zone.
		if bands := namedVerticalBands(vertRows); len(block) == 1 && len(bands) >= 2 {
			block = splitVerticalBands(block[0], bands)
			warns = append(warns, "split-vertical-bands")
		}
		zones = append(zones, block...)
		i = j - 1
	}
	return zones, warns
}

// inheritSoleVertical fills in the vertical limits of a block's no-vertical
// zones from the block's single stated one. Some supplements (048/2025) print
// "Limites verticales" once, under one column, intending it for every zone in
// the group; with exactly one vertical present we copy it to the rest. Zero, or
// several (an ambiguous per-zone table), are left alone. Returns whether it
// copied anything.
func inheritSoleVertical(block []zone) bool {
	var lo, hi []string
	n := 0
	for _, z := range block {
		if z.lower != nil || z.upper != nil {
			n++
			lo, hi = z.lower, z.upper
		}
	}
	if n != 1 {
		return false
	}
	copied := false
	for i := range block {
		if block[i].lower == nil && block[i].upper == nil {
			block[i].lower, block[i].upper = lo, hi
			copied = true
		}
	}
	return copied
}

// buildZone assembles one column's vertices (+ block arcs / circles) into a
// named zone with its own geometry, bounding box, and vertical limits.
func buildZone(name string, verts []latlon, arcs, circles []arcSpec, sameAs string, vertRows []prow, colXs []float64, cx float64) (zone, []string, bool) {
	verts = dedupeRing(verts)
	buildRings := func(arcs []arcSpec) ([][]latlon, bool) {
		var rings [][]latlon
		spliced := false
		if len(verts) >= 3 {
			for _, sub := range splitRings(verts) {
				r := append([]latlon(nil), sub...)
				if spliceArcs(&r, arcs) > 0 {
					spliced = true
				}
				rings = append(rings, r)
			}
		} else if len(verts) == 2 && len(arcs) > 0 {
			r := append([]latlon(nil), verts...)
			if spliceArcs(&r, arcs) > 0 && len(r) >= 3 {
				rings = append(rings, r)
				spliced = true
			}
		}
		return rings, spliced
	}
	rings, spliced := buildRings(arcs)

	var warns []string
	if len(rings) > 0 {
		var dropped int
		if rings, dropped = keepSimpleRings(rings); dropped > 0 {
			// An arc whose sense the text does not state defaults to
			// anti-clockwise, and the wrong sense bulges across the zone
			// into a self-intersection (167/2025's "arc de 5 NM de rayon
			// centré sur"). The printed boundary is simple by definition,
			// so retry once with every unstated sense flipped before
			// giving the ring up.
			flipped := false
			retry := make([]arcSpec, len(arcs))
			for i, a := range arcs {
				if !a.senseStated && !a.circle {
					a.clockwise = !a.clockwise
					flipped = true
				}
				retry[i] = a
			}
			if flipped {
				if r2, s2 := buildRings(retry); len(r2) > 0 {
					if r2, _ = keepSimpleRings(r2); len(r2) > 0 {
						rings, spliced = r2, s2
						warns = append(warns, "arc-sense-inferred")
						dropped = 0
					}
				}
			}
			if dropped > 0 {
				warns = append(warns, "dropped-self-intersecting")
			}
		}
	}

	var g *geometry
	src := "pdf-polygon"
	switch {
	case len(rings) > 0:
		for _, c := range circles {
			rings = append(rings, circleRingPts(c))
		}
		g = ringsGeometry(rings)
		if spliced {
			src = "pdf-mixed"
		}
	case len(circles) == 1:
		c := circles[0]
		g = &geometry{kind: "circle", center: roundPt(c.center), radiusM: math.Round(c.radiusM)}
		src = "pdf-circle"
	case len(circles) > 1:
		cr := make([][]latlon, len(circles))
		for i, c := range circles {
			cr[i] = circleRingPts(c)
		}
		g = ringsGeometry(cr)
		src = "pdf-circle"
	}
	if g == nil {
		// A zone published by reference alone still exists: it keeps its
		// name, verticals and the referenced designators, geometry-less.
		if sameAs != "" {
			lower, upper := columnVertical(vertRows, colXs, cx)
			return zone{name: prettifyName(name), lower: lower, upper: upper, source: "none", sameAs: sameAs}, warns, true
		}
		return zone{}, warns, false
	}
	lower, upper := columnVertical(vertRows, colXs, cx)
	return zone{name: prettifyName(name), geom: g, bbox: geomBbox(g), lower: lower, upper: upper, source: src, sameAs: sameAs}, warns, true
}

// columnVertical returns the lower/upper limits for a column from the cells
// near cx in the vertical-limit rows.
func columnVertical(vertRows []prow, colXs []float64, cx float64) ([]string, []string) {
	var toks [][]string
	for _, r := range vertRows {
		for _, c := range r.cells {
			// Assign each cell to its nearest column, not a fixed tolerance: a
			// "FLxxx / FLyyy" pair spans wider than colTol, so the tight test
			// dropped the second limit and left lower nil (023/2026, 055/2026).
			if len(colXs) == 0 || nearestX(colXs, c.x) == cx {
				toks = append(toks, altTokens(c.text)...)
			}
		}
	}
	switch len(toks) {
	case 0:
		return nil, nil
	case 1:
		// A single stated limit is the ceiling, EXCEPT the surface, which
		// can only be a floor (a lone "SFC" used to come back as an upper
		// limit of 0 ft, e.g. ZRT BUCK ALPHA 1).
		if toks[0][0] == "HEI" && toks[0][1] == "0" {
			return toks[0], nil
		}
		return nil, toks[0]
	default:
		return minMaxVertical(toks)
	}
}

type vband struct {
	name         string
	lower, upper []string
}

// namedVerticalBands reads vertical-limit rows that each NAME a zone and give
// its own band: "ZRT 'Low' X : SFC / 1400ft", "ZRT 'High' X : 1400ft / 1700ft".
// Two or more such rows mean a single lateral area split into vertically
// stacked zones, each its own band (147/2025). A plain per-column limit cell
// ("FL 65", "SFC / 2000ft") has no leading zone-name token and is ignored.
func namedVerticalBands(vertRows []prow) []vband {
	var bands []vband
	for _, r := range vertRows {
		for _, c := range r.cells {
			txt := strings.TrimSpace(c.text)
			colon := strings.IndexByte(txt, ':')
			if colon < 0 || !looksLikeZoneNames(txt[:colon]) {
				continue
			}
			toks := altTokens(txt[colon+1:])
			if len(toks) < 2 {
				continue
			}
			bands = append(bands, vband{
				name:  strings.TrimSpace(txt[:colon]),
				lower: toks[0],
				upper: toks[len(toks)-1],
			})
		}
	}
	return bands
}

// splitVerticalBands clones z's geometry into one zone per named band, each
// carrying that band's name and vertical limits. The shared *geometry / bbox
// are read-only downstream, so the clones may alias them.
func splitVerticalBands(z zone, bands []vband) []zone {
	out := make([]zone, 0, len(bands))
	for _, b := range bands {
		nz := z
		nz.name = prettifyName(b.name)
		nz.lower, nz.upper = b.lower, b.upper
		out = append(out, nz)
	}
	return out
}

// vertFeet converts a [code, value, uom] vertical-limit triple to feet for
// ordering (FL is hundreds of feet); SFC -> 0, UNL -> +Inf.
func vertFeet(t []string) float64 {
	if t[0] == "UNL" {
		return math.Inf(1)
	}
	v, _ := strconv.Atoi(t[1])
	if len(t) >= 3 && t[2] == "FL" {
		return float64(v) * 100
	}
	return float64(v)
}

// minMaxVertical picks the lowest and highest of several altitude triples by
// feet, so the returned lower/upper pair is correct whatever order the limits
// were printed in. Caller guarantees len(toks) >= 1.
func minMaxVertical(toks [][]string) (lower, upper []string) {
	lo, hi := toks[0], toks[0]
	for _, t := range toks[1:] {
		if vertFeet(t) < vertFeet(lo) {
			lo = t
		}
		if vertFeet(t) > vertFeet(hi) {
			hi = t
		}
	}
	return lo, hi
}

// zoneNameRe matches the area-type tokens that mark a row as the zone-name
// row (as opposed to an intervening "(Zone identification: ...)" sub-header).
var zoneNameRe = regexp.MustCompile(`(?i)\b(ZRT|ZIT|ZDT|ZRTA|TMA|CTR|CTA|TRA|CBA|SIV|LF-?[RD])`)

func looksLikeZoneNames(s string) bool {
	return zoneNameRe.MatchString(s) || strings.Contains(strings.ToLower(s), "tempo")
}

// zoneNames finds the name row above a lat-marker and matches a name to each
// column by nearest X. It scans up a few rows and prefers a row that looks
// like zone names over an intervening identification / sub-header row (which
// the SIA fonts often garble), falling back to the nearest plausible row.
// Unparseable names are left blank so the UI shows "Zone N" rather than the
// garbled run of a mis-decoded font.
func zoneNames(rows []prow, markerIdx int, colXs []float64) map[float64]string {
	var fallback *prow
	for k := markerIdx - 1; k >= 0 && k >= markerIdx-5; k-- {
		r := rows[k]
		f := fold(r.text())
		if strings.Contains(f, "limites") || strings.Contains(f, "identi") ||
			isPageNoise(f) || rowHasCoord(r) {
			continue
		}
		if looksLikeZoneNames(r.text()) {
			return columnNames(r, colXs)
		}
		if fallback == nil && rowHasPlausibleName(r) {
			rr := r
			fallback = &rr
		}
	}
	if fallback != nil {
		return columnNames(*fallback, colXs)
	}
	return map[float64]string{}
}

func columnNames(r prow, colXs []float64) map[float64]string {
	out := map[float64]string{}
	// A fused name row jams every column's name into one cell
	// ("ZRT/ZDTKRYPTONALPHA1.1ZDTKRYPTONALPHA1.2…", 001/2026); when the
	// whole row is one cell and it splits into exactly one name per column,
	// they distribute in order.
	if len(colXs) >= 2 && len(r.cells) == 1 {
		if parts := splitFusedNames(stripC0(r.cells[0].text), len(colXs)); parts != nil {
			for i, cx := range colXs {
				if plausibleName(parts[i]) {
					out[cx] = parts[i]
				}
			}
			return out
		}
	}
	for _, cx := range colXs {
		// The SIA fonts render typographic quotes as raw C0 bytes ("ZRT
		// \x18SAINT-BRIEUC MER\x19", 030/2026); strip those before judging,
		// else the whole name is rejected as garbled.
		if n := stripC0(nearestCell(r, cx)); plausibleName(n) {
			out[cx] = n
		}
	}
	return out
}

// fusedNameStartRe finds where a zone name can begin inside a fused name row:
// a ZRT/ZDT/ZIT/TRA/CBA token. Starts preceded by '/' or '-' are the second
// half of a compound kind ("ZRT/ZDT") and never a boundary.
var fusedNameStartRe = regexp.MustCompile(`ZRT|ZDT|ZIT|TRA\d|CBA\d`)

// splitFusedNames cuts a fused name row into exactly n names, or nil when the
// boundaries do not line up.
func splitFusedNames(s string, n int) []string {
	locs := fusedNameStartRe.FindAllStringIndex(s, -1)
	var starts []int
	for _, l := range locs {
		if l[0] > 0 {
			prev := s[l[0]-1]
			if prev == '/' || prev == '-' {
				continue
			}
		}
		starts = append(starts, l[0])
	}
	// More starts than columns happens when a column's own marker row is
	// displaced and its name rides this row anyway (001/2026's CORRIDOR 34B):
	// the first n names are the columns'; each slice ends at the NEXT
	// boundary so the surplus name never contaminates the last column.
	if len(starts) < n || n == 0 || starts[0] > 3 {
		return nil
	}
	out := make([]string, n)
	for i := 0; i < n; i++ {
		end := len(s)
		if i+1 < len(starts) {
			end = starts[i+1]
		}
		out[i] = strings.TrimSpace(s[starts[i]:end])
	}
	return out
}

// stripC0 removes C0 control runes (unmapped font glyphs, usually quote or
// prime marks) from a name candidate.
func stripC0(s string) string {
	return strings.Map(func(r rune) rune {
		if r < 0x20 {
			return -1
		}
		return r
	}, s)
}

func rowHasPlausibleName(r prow) bool {
	for _, c := range r.cells {
		if plausibleName(c.text) {
			return true
		}
	}
	return false
}

// French SUP-section heading words (folded). A name cell that contains one is a
// document heading mis-read as a zone name; e.g. "SERVICES RENDUS" sits right
// above the LIMITES marker, inside the row-scan window, so it was taken as the
// name of the single zone below it.
var nameHeadingWords = []string{
	"servicesrendus", "conditionsde", "generalites", "remarques",
	"dispositions", "organismes", "gestionnaires", "informationdes",
	"datesetheures", "statut",
}

// reportingPointWords (folded) head a VFR reporting-point table: the "POINTS DE
// REPORT" / "Points de compte-rendu" section a supplement amending a VAC chart
// publishes. Its rows are named single points, so a supplement whose only
// coordinates are those points describes no area at all (158/2026 and its
// successor 165/2026 move Courchevel's helicopter reporting points).
var reportingPointWords = []string{"pointsdereport", "pointsdecompte"}

// isReportingPointDoc reports whether a supplement's coordinates are a
// reporting-point table, which the whole-document fallback must not cluster
// into a ring; the marker path is unaffected, so a supplement that both creates
// a zone and lists its reporting points keeps the zone.
func isReportingPointDoc(lines []string) bool {
	for _, l := range lines {
		f := fold(l)
		for _, w := range reportingPointWords {
			if strings.Contains(f, w) {
				return true
			}
		}
	}
	return false
}

// isSectionHeading reports whether a candidate name is one of the supplement's
// section headings rather than a zone name.
func isSectionHeading(s string) bool {
	f := fold(s)
	for _, w := range nameHeadingWords {
		if strings.Contains(f, w) {
			return true
		}
	}
	return false
}

// plausibleName rejects the cell texts that are clearly not a zone name: empty,
// a section heading, over-long (a wrapped sentence), ending in a period (a
// sentence), control chars, heavily garbled (3+ U+FFFD), or all-lowercase
// (prose).
func plausibleName(s string) bool {
	s = strings.TrimSpace(s)
	if s == "" || len([]rune(s)) > 50 || strings.HasSuffix(s, ".") || isSectionHeading(s) {
		return false
	}
	fffd, upper := 0, false
	for _, r := range s {
		if r < 0x20 {
			return false
		}
		if r == '�' {
			fffd++
		}
		if unicode.IsUpper(r) {
			upper = true
		}
	}
	return upper && fffd <= 2
}

// titleAltRe rejects a candidate title carrying a vertical limit or a label
// colon (a "ZRT 'Low' X : SFC / 1400ft" row is a limits line, not the heading).
var titleAltRe = regexp.MustCompile(`(?i)\d\s*ft|\bfl\d|amsl|asfc|:`)

// documentTitle returns the supplement's main heading: the first prominent
// area-name row near the top of the document (a standalone "ZRT/ZIT/ZDT ..."
// title). It names a single-zone supplement whose marker-derived name came out
// a section heading or blank, the real name being the heading up top, far above
// the LIMITES row-scan window. Skips page noise, section headings, the
// "Objet" / "Lieu" / "En vigueur" label rows, and rows carrying a vertical
// limit; returns "" when none is found.
func documentTitle(lines []string) string {
	for i, line := range lines {
		if i >= 30 {
			break
		}
		f := fold(line)
		if isPageNoise(f) || isSectionHeading(line) ||
			strings.Contains(f, "objet") || strings.Contains(f, "lieu") ||
			strings.Contains(f, "envigueur") {
			continue
		}
		if t := titleCandidate(strings.TrimSpace(line)); t != "" {
			return t
		}
	}
	return ""
}

// titleCandidate returns s (or its reverse) when it reads as a short zone-name
// heading carrying no vertical limit. Some SIA title runs are stored reversed
// (")48(EGNAROTIZ" for "ZIT ORANGE (84)"), so either orientation is accepted.
func titleCandidate(s string) string {
	if len([]rune(s)) > 40 || titleAltRe.MatchString(s) {
		return ""
	}
	if looksLikeZoneNames(s) {
		return s
	}
	if rev := reverseRunes(s); looksLikeZoneNames(rev) {
		return rev
	}
	return ""
}

func reverseRunes(s string) string {
	r := []rune(s)
	for i, j := 0, len(r)-1; i < j; i, j = i+1, j-1 {
		r[i], r[j] = r[j], r[i]
	}
	return string(r)
}

func isPageNoise(f string) bool {
	return f == "" || f == "fr" || strings.Contains(f, "page") ||
		strings.Contains(f, "supaip") || strings.Contains(f, "datepublication") ||
		strings.Contains(f, "dateairac")
}

func sectionEnd(r prow) bool {
	f := fold(r.text())
	if isPageNoise(f) {
		return true
	}
	for _, w := range []string{"dispositions", "organismes", "serial", "gestionnaires", "informationdes", "dateset", "conditions"} {
		if strings.Contains(f, w) {
			return true
		}
	}
	return false
}

func rowHasCoord(r prow) bool {
	for _, c := range r.cells {
		if len(lineVertices(c.text)) > 0 {
			return true
		}
	}
	return false
}

func nearestCell(r prow, cx float64) string {
	best := ""
	bestD := math.Inf(1)
	for _, c := range r.cells {
		if d := math.Abs(c.x - cx); d < bestD {
			bestD, best = d, c.text
		}
	}
	return best
}

var (
	namePrefixRe = regexp.MustCompile(`(?i)^(ZRT|ZIT|ZDT|TMA|CTR|CTA|TRA|CBA)([A-Za-z])`)
	natoSuffixRe = regexp.MustCompile(`(?i)([A-Za-z])(ALPHA|BRAVO|CHARLIE|DELTA|ECHO|FOXTROT|GOLF|HOTEL|INDIA)$`)
)

// prettifyName re-inserts the spaces the mPDF run dropped: an area-type prefix
// ("ZRTYONNE" -> "ZRT YONNE"), a trailing NATO designator ("ARMANCONALPHA" ->
// "ARMANCON ALPHA"), and letter/digit + camel-case boundaries
// ("TMA1LEMANSTemporaire" -> "TMA 1 LEMANS Temporaire"). Runs of capitals with
// no other signal stay joined, but the common cases read cleanly.
func prettifyName(s string) string {
	s = namePrefixRe.ReplaceAllString(s, "$1 $2")
	s = natoSuffixRe.ReplaceAllString(s, "$1 $2")
	rs := []rune(s)
	var b strings.Builder
	for i, r := range rs {
		if i > 0 {
			p := rs[i-1]
			letterDigit := (unicode.IsDigit(r) && unicode.IsLetter(p)) ||
				(unicode.IsLetter(r) && unicode.IsDigit(p))
			camel := unicode.IsLetter(p) && unicode.IsUpper(r) &&
				i+1 < len(rs) && unicode.IsLower(rs[i+1])
			if letterDigit || camel {
				b.WriteRune(' ')
			}
		}
		b.WriteRune(r)
	}
	return strings.Join(strings.Fields(b.String()), " ")
}

// geomBbox returns the bounding box of any geometry kind.
func geomBbox(g *geometry) []float64 {
	switch g.kind {
	case "circle":
		return circleBbox(g.center, g.radiusM)
	case "multipolygon":
		return ringsBbox(g.rings)
	default:
		return ringBbox(g.ring)
	}
}

func mergeBbox(a, b []float64) []float64 {
	return []float64{
		math.Min(a[0], b[0]), math.Min(a[1], b[1]),
		math.Max(a[2], b[2]), math.Max(a[3], b[3]),
	}
}

// clusterColumns groups coordinate points into columns by X (one zone per
// column in a multi-column table) and returns each column's vertices ordered
// top-to-bottom. A single-column table yields one ring.
func clusterColumns(points []ptv) [][]latlon {
	if len(points) == 0 {
		return nil
	}
	const tol = 40.0 // a point within 40pt of a column's span joins it
	xs := make([]float64, len(points))
	for i, p := range points {
		xs[i] = p.x
	}
	sort.Float64s(xs)
	// Column X-ranges: break the sorted Xs wherever the gap exceeds tol.
	type rng struct{ lo, hi float64 }
	var ranges []rng
	lo, hi := xs[0], xs[0]
	for _, x := range xs[1:] {
		if x-hi > tol {
			ranges = append(ranges, rng{lo, hi})
			lo = x
		}
		hi = x
	}
	ranges = append(ranges, rng{lo, hi})

	cols := make([][]ptv, len(ranges))
	for _, p := range points {
		for i, r := range ranges {
			if p.x >= r.lo-0.5 && p.x <= r.hi+0.5 {
				cols[i] = append(cols[i], p)
				break
			}
		}
	}
	out := make([][]latlon, 0, len(cols))
	for _, col := range cols {
		// Top-to-bottom: PDF Y increases upward, so the highest Y is row one.
		sort.SliceStable(col, func(a, b int) bool { return col[a].y > col[b].y })
		ring := make([]latlon, len(col))
		for i, p := range col {
			ring[i] = p.v
		}
		out = append(out, ring)
	}
	return out
}

// ringsGeometry wraps one or more rings as a polygon or multipolygon, each
// ring rounded for diff-stability.
// ccw reports the orientation of p->q->r (used for segment crossing tests).
func ccw(p, q, r latlon) bool {
	return (r[1]-p[1])*(q[0]-p[0]) > (q[1]-p[1])*(r[0]-p[0])
}

// segmentsCross reports whether segment ab properly crosses segment cd.
func segmentsCross(a, b, c, d latlon) bool {
	return ccw(a, c, d) != ccw(b, c, d) && ccw(a, b, c) != ccw(a, b, d)
}

// selfIntersects reports whether the closed polygon through ring has two
// non-adjacent edges crossing. That happens when the vertices are out of
// boundary order, which the column parser produces for the supplements whose
// PDF jams several coordinate columns into one cell (e.g. 207/2025's 4-wide
// tables): the zone then renders as a scrambled star rather than its area.
func selfIntersects(ring []latlon) bool {
	n := len(ring)
	if n < 4 {
		return false
	}
	for i := 0; i < n; i++ {
		a, b := ring[i], ring[(i+1)%n]
		for j := i + 2; j < n; j++ {
			if i == 0 && j == n-1 {
				continue // edges 0 and n-1 share a vertex
			}
			if segmentsCross(a, b, ring[j], ring[(j+1)%n]) {
				return true
			}
		}
	}
	return false
}

// keepSimpleRings drops the self-intersecting rings (unreliable geometry we
// would rather not draw at all than draw wrong) and reports how many went.
func keepSimpleRings(rings [][]latlon) ([][]latlon, int) {
	kept := rings[:0]
	dropped := 0
	for _, r := range rings {
		if selfIntersects(r) {
			dropped++
			continue
		}
		kept = append(kept, r)
	}
	return kept, dropped
}

func ringsGeometry(rings [][]latlon) *geometry {
	if len(rings) == 1 {
		return &geometry{kind: "polygon", ring: roundRing(rings[0])}
	}
	out := make([][]latlon, len(rings))
	for i, r := range rings {
		out[i] = roundRing(r)
	}
	return &geometry{kind: "multipolygon", rings: out}
}

// splitRings breaks a vertex run into separate zones at edges that are far
// longer than the run's typical edge (the jumps between distinct sub-areas of
// a multi-zone supplement). A single zone returns one ring unchanged.
func splitRings(verts []latlon) [][]latlon {
	if len(verts) < 3 {
		return [][]latlon{verts}
	}
	edges := make([]float64, len(verts)-1)
	for i := 1; i < len(verts); i++ {
		edges[i-1] = haversineM(verts[i-1][0], verts[i-1][1], verts[i][0], verts[i][1])
	}
	sorted := append([]float64(nil), edges...)
	sort.Float64s(sorted)
	med := sorted[len(sorted)/2]
	if med <= 0 {
		return [][]latlon{verts}
	}
	thresh := med * 8
	var rings [][]latlon
	cur := []latlon{verts[0]}
	for i := 1; i < len(verts); i++ {
		// A separator is both relatively huge and absolutely far (> 3 km), so
		// an elongated single zone isn't split at its longest edge.
		if edges[i-1] > thresh && edges[i-1] > 3000 {
			if len(cur) >= 3 {
				rings = append(rings, cur)
			}
			cur = []latlon{verts[i]}
		} else {
			cur = append(cur, verts[i])
		}
	}
	if len(cur) >= 3 {
		rings = append(rings, cur)
	}
	if len(rings) == 0 {
		return [][]latlon{verts}
	}
	return rings
}

// lineVertices returns every lat+lon vertex on a line, pairing each latitude
// with the longitude that follows it. This handles both one-vertex-per-line
// tables and multi-column tables (several vertices per row); a dangling
// hemisphere with no partner is dropped. Vertex order within a multi-column
// row is best-effort, but the bounding box (the primary product) is order
// independent.
func lineVertices(line string) []latlon {
	return verticesFrom(scanCoords(line))
}

// verticesFrom pairs a run of coordinate tokens into vertices, each latitude
// with the longitude that follows it.
func verticesFrom(toks []coordTok) []latlon {
	var out []latlon
	var lat float64
	haveLat := false
	for _, t := range toks {
		if t.isLat {
			lat, haveLat = t.val, true
		} else if haveLat {
			out = append(out, latlon{lat, t.val})
			haveLat = false
		}
	}
	return out
}

// scanCoords extracts every DMS coordinate token on a line, in order: the
// °-form first, then the packed DDMMSS form, merged by position.
func scanCoords(line string) []coordTok {
	matches := coordRe.FindAllStringSubmatchIndex(line, -1)
	out := make([]coordTok, 0, len(matches))
	for _, m := range matches {
		val, isLat, ok := convertDMS(line[m[2]:m[3]], line[m[4]:m[5]], line[m[6]:m[7]], line[m[8]:m[9]])
		if ok {
			out = append(out, coordTok{val: val, isLat: isLat, pos: m[0]})
		}
	}
	for _, m := range packedLatRe.FindAllStringSubmatchIndex(line, -1) {
		if m[2] > 0 && line[m[2]-1] >= '0' && line[m[2]-1] <= '9' {
			continue
		}
		digits := line[m[2]:m[3]]
		if v, _, ok := convertDMS(digits[:2], digits[2:4], digits[4:], line[m[4]:m[5]]); ok {
			out = append(out, coordTok{val: v, isLat: true, pos: m[2]})
		}
	}
	for _, m := range packedLonRe.FindAllStringSubmatchIndex(line, -1) {
		if m[2] > 0 && line[m[2]-1] >= '0' && line[m[2]-1] <= '9' {
			continue
		}
		digits := line[m[2]:m[3]]
		if v, _, ok := convertDMS(digits[:3], digits[3:5], digits[5:], line[m[4]:m[5]]); ok {
			out = append(out, coordTok{val: v, isLat: false, pos: m[2]})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].pos < out[j].pos })
	return out
}

// convertDMS normalises a scanned DMS token into the packed AIXM form and
// delegates to internal/aip for the float, range check, and rounding.
func convertDMS(deg, min, sec, hemi string) (float64, bool, bool) {
	d, err1 := strconv.Atoi(deg)
	m, err2 := strconv.Atoi(min)
	if err1 != nil || err2 != nil {
		return 0, false, false
	}
	sp := padSec(strings.ReplaceAll(sec, ",", "."))
	switch hemi {
	case "N", "S":
		if d >= 100 {
			return 0, true, false
		}
		v, ok := aip.ParseLat(fmt.Sprintf("%02d%02d%s%s", d, m, sp, hemi))
		return v, true, ok
	case "E", "W":
		if d >= 1000 {
			return 0, false, false
		}
		v, ok := aip.ParseLon(fmt.Sprintf("%03d%02d%s%s", d, m, sp, hemi))
		return v, false, ok
	}
	return 0, false, false
}

// padSec zero-pads the integer part of a seconds string to two digits,
// preserving any decimal fraction: "5"->"05", "5.5"->"05.5", "31.79" stays.
func padSec(sec string) string {
	intPart, frac, hasFrac := strings.Cut(sec, ".")
	if len(intPart) < 2 {
		intPart = strings.Repeat("0", 2-len(intPart)) + intPart
	}
	if hasFrac {
		return intPart + "." + frac
	}
	return intPart
}

type arcSpec struct {
	center    latlon
	radiusM   float64
	clockwise bool
	// senseStated records whether the text names the sense ("horaire" /
	// "anti-horaire"); an unstated arc ("arc de 5 NM de rayon centré sur",
	// 167/2025) may have its sense inferred from ring simplicity.
	senseStated bool
	circle      bool // a full circle ("cercle") rather than an arc
}

// isArcLine reports whether a folded line describes a circle or arc. The
// "horaire" + radius form catches an arc phrase split across rows ("arc
// horaire de 10.00nm de" / "rayon centré sur", 160/2026), where neither
// "rayon" nor "centré" shares the radius's row; "horaire" is specific enough
// that prose cannot carry it beside a bare radius inside a zone block.
func isArcLine(folded string) bool {
	if strings.Contains(folded, "cercle") {
		return true
	}
	if strings.Contains(folded, "rayon") &&
		(strings.Contains(folded, "centr") || strings.Contains(folded, "arc")) {
		return true
	}
	return strings.Contains(folded, "horaire") && radiusRe.MatchString(folded)
}

// arcKeywordRe locates where a cell's arc phrase begins. The phrase is what
// separates the two roles a coordinate can play on such a line: what comes
// before it is still the boundary, what comes after is the arc's centre.
var arcKeywordRe = regexp.MustCompile(`(?i)cercle|arc|rayon`)

// arcCell is what one arc/circle line yields: the arc itself, the boundary
// vertices printed ahead of the arc phrase, and the centre when the line
// carries it whole.
type arcCell struct {
	spec      arcSpec
	lead      []latlon // vertices printed before the arc phrase
	hasCenter bool
	centerLat float64 // a centre whose longitude wrapped to the next row
	hasLat    bool
}

// arcFromCell parses an arc/circle line's radius and sense, and its centre if
// present on the line. SIA arcs often wrap as "arc horaire de 6 NM de rayon
// centré" / "sur" / "<DMS>", so the centre may live on a following row;
// hasCenter is false then and the caller supplies the next coordinate as the
// centre (keeping it out of the vertex list). The wrap can also fall between
// the centre's own latitude and longitude ("centré sur 49°17'40N-" / "000°
// 07'00W", SUP AIP 170/2026), which leaves the latitude here in centerLat.
//
// A coordinate BEFORE the arc phrase is a boundary vertex, not the centre:
// 170/2026 prints its ZRT's first vertex and then "arc horaire de 6 Nm de
// rayon", with "centré sur <DMS>" on the next row, so reading the first
// coordinate on the line as the centre both lost that vertex and pulled the
// boundary in to the centre of the arc.
func arcFromCell(line, folded string) (arcCell, bool) {
	rm := radiusRe.FindStringSubmatch(line)
	if rm == nil {
		return arcCell{}, false
	}
	radiusM, err := geodesy.RadiusMeters(strings.ReplaceAll(rm[1], ",", "."), rm[2])
	if err != nil {
		return arcCell{}, false
	}
	out := arcCell{spec: arcSpec{
		radiusM: radiusM,
		// "anti-horaire" keeps its hyphen after folding, so test for "anti".
		clockwise:   strings.Contains(folded, "horaire") && !strings.Contains(folded, "anti"),
		senseStated: strings.Contains(folded, "horaire"),
		circle:      strings.Contains(folded, "cercle"),
	}}

	toks := scanCoords(line)
	split := 0
	if loc := arcKeywordRe.FindStringIndex(line); loc != nil {
		for split < len(toks) && toks[split].pos < loc[0] {
			split++
		}
	}
	out.lead = verticesFrom(toks[:split])
	rest := toks[split:]
	for i := 0; i+1 < len(rest); i++ {
		if rest[i].isLat && !rest[i+1].isLat {
			out.spec.center = latlon{rest[i].val, rest[i+1].val}
			out.hasCenter = true
			return out, true
		}
	}
	if n := len(rest); n > 0 && rest[n-1].isLat {
		out.centerLat, out.hasLat = rest[n-1].val, true
	}
	return out, true
}

// parseArc extracts a single-line circle/arc (centre present on the line).
func parseArc(line, folded string) (arcSpec, bool) {
	a, ok := arcFromCell(line, folded)
	if !ok || !a.hasCenter {
		return arcSpec{}, false
	}
	return a.spec, true
}

// colGeom accumulates one column's boundary vertices and its arcs / circles.
type colGeom struct {
	verts   []latlon
	arcs    []arcSpec
	circles []arcSpec
	sameAs  string
	refRows int // rows still allowed to continue a wrapped reference
}

// collectColumns assigns every cell in a zone block to a column and returns
// each column's geometry. Vertices join a column only within colTol (so the
// columns stay separate); arcs/circles attach to the NEAREST column whatever
// the distance, because an arc's "...rayon centré sur" text is often outdented
// to the left of its coordinate column. Per-column "pending" handles the
// wrapped form where the centre is on a following row. An "exclusion" cell
// ends its column's boundary so an excluded sub-area isn't merged in.
func collectColumns(coordRows []prow, colXs []float64) map[float64]*colGeom {
	out := make(map[float64]*colGeom, len(colXs))
	for _, cx := range colXs {
		out[cx] = &colGeom{}
	}
	nearestCol := func(x float64) float64 {
		best, bd := colXs[0], math.Abs(x-colXs[0])
		for _, c := range colXs[1:] {
			if d := math.Abs(x - c); d < bd {
				best, bd = c, d
			}
		}
		return best
	}

	type fcell struct {
		x, y float64
		text string
	}
	var cells []fcell
	for _, r := range coordRows {
		for _, c := range r.cells {
			cells = append(cells, fcell{c.x, r.y, c.text})
		}
	}
	sort.SliceStable(cells, func(i, j int) bool {
		if cells[i].y != cells[j].y {
			return cells[i].y > cells[j].y
		}
		return cells[i].x < cells[j].x
	})

	pending := map[float64]*arcCell{}
	pendingLat := map[float64]float64{} // 045/2026: a bare DMS latitude whose hemisphere opens the NEXT row
	lonSeen := map[float64][]float64{}  // every longitude a column has resolved (sign evidence)
	done := map[float64]bool{}
	addArc := func(col float64, a arcSpec) {
		lonSeen[col] = append(lonSeen[col], a.center[1])
		if a.circle {
			out[col].circles = append(out[col].circles, a)
		} else {
			out[col].arcs = append(out[col].arcs, a)
		}
	}
	// A vertex cell's left edge drifts with the length of its prose suffix
	// ("48°25’12’’N–006°00’46’’EVandeléville" starts well left of its bare
	// sibling rows, 159/2026), so a flat colTol drops real vertices. A cell
	// joins its nearest column when it is within colTol, OR decisively on
	// that column's side of the midline to the neighbouring column (capped,
	// so a stray full-width cell still stays out).
	acceptTol := func(col float64) float64 {
		tol := 2 * colTol
		for _, c := range colXs {
			if c != col {
				if half := math.Abs(c-col) / 2; half < tol {
					tol = half
				}
			}
		}
		return math.Max(tol, colTol)
	}
	addVerts := func(col, x float64, vs []latlon) {
		if len(vs) > 0 && !done[col] && math.Abs(x-col) <= acceptTol(col) {
			out[col].verts = append(out[col].verts, vs...)
			for _, v := range vs {
				lonSeen[col] = append(lonSeen[col], v[1])
			}
		}
	}
	for _, c := range cells {
		folded := fold(c.text)
		col := nearestCol(c.x)
		if strings.Contains(folded, "exclusion") {
			done[col] = true
			continue
		}
		// "Identiques à celles de la zone LF-D5" publishes the lateral limits
		// BY REFERENCE (099/2026 and the exercise supplements): capture the
		// designators; the reference commonly wraps ("...zone LF-" / "D12G"),
		// so the next couple of coordinate-less rows extend it.
		if strings.Contains(folded, "identiques") {
			out[col].sameAs += c.text
			out[col].refRows = 2
			continue
		}
		if out[col].refRows > 0 && !isArcLine(folded) && len(scanCoords(c.text)) == 0 {
			out[col].sameAs += c.text
			out[col].refRows--
			continue
		}
		if isArcLine(folded) {
			a, ok := arcFromCell(c.text, folded)
			if ok {
				addVerts(col, c.x, a.lead)
				if a.hasCenter {
					addArc(col, a.spec)
				} else {
					a.lead = nil
					pending[col] = &a
				}
				continue
			}
			// A radius-less continuation of a split arc phrase ("rayon centré
			// sur", 160/2026): fall through so any coordinate it carries can
			// complete the pending arc; with no pending there is nothing to
			// complete.
			if pending[col] == nil {
				continue
			}
		}
		text := c.text
		toks := scanCoords(text)
		// A vertex whose hemisphere letters open THIS row ("43°31'30.00''" /
		// "N,006°30'29.00''E", 045/2026): the held latitude completes here.
		if lat, held := pendingLat[col]; held {
			delete(pendingLat, col)
			if hm := hemiPrefixRe.FindStringSubmatch(text); hm != nil && len(toks) > 0 {
				if hm[1] == "S" {
					lat = -lat
				}
				toks = append([]coordTok{{val: lat, isLat: true, pos: -1}}, toks...)
			}
		}
		// A jammed row carrying one centre latitude (or longitude) per column
		// in a single cell ("CENTRESUR42°15′36.6″NCENTRESUR42°30′57.9″N…",
		// 052/2026): the jam preserves left-to-right column order, so the
		// tokens distribute across the pending arcs in X order.
		if n := len(toks); n >= 2 && n == len(colXs) {
			if allAxis(toks, true) && pendingsAwait(colXs, pending, false) {
				for k, cx := range colXs {
					pending[cx].centerLat, pending[cx].hasLat = toks[k].val, true
				}
				continue
			}
			if allAxis(toks, false) && pendingsAwait(colXs, pending, true) {
				for k, cx := range colXs {
					p := pending[cx]
					p.spec.center = latlon{p.centerLat, toks[k].val}
					addArc(cx, p.spec)
					delete(pending, cx)
				}
				continue
			}
		}
		// A centre split across the row break: its latitude came with the arc
		// phrase, its longitude opens this cell.
		if p := pending[col]; p != nil && p.hasLat && len(toks) > 0 && !toks[0].isLat {
			p.spec.center = latlon{p.centerLat, toks[0].val}
			addArc(col, p.spec)
			delete(pending, col)
			toks = toks[1:]
		}
		// A pending arc whose centre's latitude stands alone on this row, the
		// longitude following on the next ("centré sur 45°14'29'' N," /
		// "000°05'41'' W", 160/2026 and 052/2026's circle grid).
		if p := pending[col]; p != nil && !p.hasLat && len(toks) == 1 && toks[0].isLat {
			p.centerLat, p.hasLat = toks[0].val, true
			continue
		}
		// A bare DMS with no hemisphere at all is a latitude whose "N," starts
		// the next row (045/2026); hold it for that row.
		if len(toks) == 0 {
			if bm := bareDMSRe.FindStringSubmatch(strings.TrimSpace(text)); bm != nil {
				if v, isLat, ok := convertDMS(bm[1], bm[2], bm[3], "N"); ok && isLat {
					pendingLat[col] = v
				}
			}
			continue
		}
		vs := verticesFrom(toks)
		// A fused row jams NEIGHBOURING columns' vertices into a single cell:
		// the whole row for 001/2026's KRYPTON tables
		// ("47°06'45"N,006°34'04"W47°29'17"N,006°50'37"W…"), two of three
		// columns for one row of 159/2025
		// ("49°00'00''N,005°31'20''E48°24'30"N,005°17'35"E", which used to
		// hand ZRT JOINVILLE's vertex to ZRT SAINT-DIZIER as a spike). The
		// jam preserves left-to-right layout, so the vertices distribute over
		// CONSECUTIVE columns starting at the cell's own, any surplus staying
		// on the last; these tables never print two vertices of one zone on
		// one row.
		if len(colXs) >= 2 && len(vs) >= 2 {
			start := 0
			if len(vs) < len(colXs) {
				for k, cx := range colXs {
					if cx == col {
						start = k
						break
					}
				}
				// A fused cell whose text begins with anything other than
				// its first coordinate (083/2026 merges a stray ':' fragment
				// or the neighbouring arc prose in front) has a left edge
				// that misrepresents the first vertex's column; ring
				// continuity anchors it instead, each candidate window
				// scored against the columns' previous vertices. A clean
				// coordinate-first cell (159/2025) keeps its X anchor.
				if toks[0].pos > 0 {
					if s, ok := continuityStart(colXs, vs, out); ok {
						start = s
					}
				}
			}
			for k, v := range vs {
				idx := start + k
				if idx >= len(colXs) {
					idx = len(colXs) - 1
				}
				addVerts(colXs[idx], colXs[idx], []latlon{v})
			}
			continue
		}
		// A trailing longitude missing its hemisphere letter (the SIA's own
		// typo in 047/2026's "…N,006°02'09.00"" ) recovers its sign from the
		// longitudes its column has already resolved; without unanimous
		// nearby evidence it stays dropped, never guessed.
		if last := toks[len(toks)-1]; last.isLat {
			if bm := trailingBareLonRe.FindStringSubmatch(text); bm != nil {
				if v, isLat, ok := convertDMS(bm[1], bm[2], bm[3], "E"); ok && !isLat {
					if sv, ok := resolveLonSign(v, lonSeen[col]); ok {
						vs = append(vs, latlon{last.val, sv})
					}
				}
			}
		}
		if len(vs) == 0 {
			continue
		}
		if p := pending[col]; p != nil {
			p.spec.center = vs[0]
			addArc(col, p.spec)
			delete(pending, col)
			vs = vs[1:]
		}
		addVerts(col, c.x, vs)
	}
	return out
}

// interleavedNameCells finds, on one row, a zone-name cell (a designator
// token, no coordinates) beside a vertical-band cell (two altitude tokens):
// the row shape that names each zone inside an interleaved single-column
// table (053/2026):
//
//	ZRT PARTHENAY | 46°40'00''N- | FL125/FL135 | Poitiers INFO ...
//
// The row usually ALSO carries one of the zone's own vertices, so its
// coordinate cells stay in the vertex stream.
func interleavedNameCells(r prow) (name string, lower, upper []string, ok bool) {
	var flToks [][]string
	for _, c := range r.cells {
		if len(scanCoords(c.text)) > 0 {
			continue
		}
		if zoneNameRe.MatchString(c.text) {
			n := stripC0(c.text)
			if m := zoneNameRe.FindStringIndex(n); m != nil {
				n = strings.TrimSpace(n[m[0]:])
			}
			if plausibleName(n) && name == "" {
				name = n
			}
			continue
		}
		if toks := altTokens(c.text); len(toks) >= 2 {
			flToks = toks
		}
	}
	if name == "" || len(flToks) < 2 {
		return "", nil, nil, false
	}
	lower, upper = minMaxVertical(flToks)
	return name, lower, upper, true
}

func countInterleavedNames(coordRows []prow) int {
	n := 0
	for _, r := range coordRows {
		if _, _, _, ok := interleavedNameCells(r); ok {
			n++
		}
	}
	return n
}

// interleavedZones parses the one-column exercise layout (053/2026): a single
// "Limites latérales" column carrying every zone's vertices in a stack, one
// axis per row, each zone's name + band on a row lying WITHIN its own vertex
// run. Rings are cut at their printed closure (the SIA repeats the first
// vertex); each ring takes the name row nearest in document order. Row
// indices, not Y, order everything: Y restarts on every page and these
// tables run for pages.
func interleavedZones(coordRows []prow, colX float64) []zone {
	type vrow struct {
		idx int
		v   latlon
	}
	type nrow struct {
		idx          int
		name         string
		lower, upper []string
	}
	var verts []vrow
	var names []nrow
	var pendLat float64
	havePend := false
	for i, r := range coordRows {
		if nm, lo, hi, ok := interleavedNameCells(r); ok {
			names = append(names, nrow{idx: i, name: nm, lower: lo, upper: hi})
		}
		for _, c := range r.cells {
			if math.Abs(c.x-colX) > 6*colTol {
				continue
			}
			for _, tok := range scanCoords(c.text) {
				if tok.isLat {
					pendLat, havePend = tok.val, true
				} else if havePend {
					verts = append(verts, vrow{idx: i, v: latlon{pendLat, tok.val}})
					havePend = false
				}
			}
		}
	}
	if len(verts) < 3 {
		return nil
	}
	// Cut rings at the printed closure; a long row gap (page furniture aside,
	// vertex rows are consecutive) also separates.
	var runs [][]vrow
	cur := []vrow{verts[0]}
	for _, v := range verts[1:] {
		if len(cur) > 0 && v.idx-cur[len(cur)-1].idx > 8 {
			runs = append(runs, cur)
			cur = nil
		}
		cur = append(cur, v)
		if len(cur) >= 3 && v.v == cur[0].v {
			runs = append(runs, cur)
			cur = nil
		}
	}
	if len(cur) > 0 {
		runs = append(runs, cur)
	}
	var zones []zone
	for _, run := range runs {
		ring := make([]latlon, len(run))
		minI, maxI := run[0].idx, run[0].idx
		for i, v := range run {
			ring[i] = v.v
			minI = min(minI, v.idx)
			maxI = max(maxI, v.idx)
		}
		ring = dedupeRing(ring)
		if len(ring) < 3 || selfIntersects(ring) {
			continue
		}
		z := zone{geom: ringsGeometry([][]latlon{ring}), source: "pdf-polygon"}
		z.bbox = geomBbox(z.geom)
		best, bestD := -1, math.MaxInt
		for i, n := range names {
			d := 0
			if n.idx > maxI {
				d = n.idx - maxI
			} else if n.idx < minI {
				d = minI - n.idx
			}
			if d < bestD {
				best, bestD = i, d
			}
		}
		if best >= 0 && bestD <= 3 {
			z.name = prettifyName(names[best].name)
			z.lower, z.upper = names[best].lower, names[best].upper
		}
		zones = append(zones, z)
	}
	return zones
}

// spliceArcs replaces straight edges with tessellated arcs: for each arc, the
// consecutive vertex pair whose endpoints both sit ~radius from its centre is
// joined by the arc. A boundary can carry several arcs (e.g. two concave arc
// segments), so every arc is tried, re-scanning the ring after each splice.
// Returns the number of arcs spliced.
func spliceArcs(ring *[]latlon, arcs []arcSpec) int {
	count := 0
	for _, a := range arcs {
		r := *ring
		for i := 0; i < len(r); i++ {
			j := (i + 1) % len(r)
			di := haversineM(r[i][0], r[i][1], a.center[0], a.center[1])
			dj := haversineM(r[j][0], r[j][1], a.center[0], a.center[1])
			if within(di, a.radiusM, 0.1) && within(dj, a.radiusM, 0.1) {
				mid := geodesy.ArcPoints(r[i][0], r[i][1], r[j][0], r[j][1], a.center[0], a.center[1], a.radiusM, a.clockwise)
				spliced := append([]latlon{}, r[:i+1]...)
				for _, p := range mid {
					spliced = append(spliced, latlon{p[0], p[1]})
				}
				// On the closing edge the arc runs back to the first vertex, so
				// nothing follows it; r[j:] would be the whole ring over again,
				// and the doubled ring self-intersects and is dropped.
				if j > 0 {
					spliced = append(spliced, r[j:]...)
				}
				*ring = spliced
				count++
				break
			}
		}
	}
	return count
}

// resolveRadials turns radial/DME fixes into points when a navaid table is
// available. Best-effort; bearings are magnetic, treated here as true.
func resolveRadials(lines []string, nav navaidTable) []latlon {
	if len(nav) == 0 {
		return nil
	}
	var pts []latlon
	for _, ln := range lines {
		m := radialRe.FindStringSubmatch(ln)
		if m == nil {
			continue
		}
		brng, err1 := strconv.ParseFloat(m[1], 64)
		dist, err2 := strconv.ParseFloat(strings.ReplaceAll(m[2], ",", "."), 64)
		if err1 != nil || err2 != nil {
			continue
		}
		pos, ok := nav[m[4]]
		if !ok {
			continue
		}
		distM, _ := geodesy.ToMeters(dist, m[3])
		lat, lon := geodesy.DestPoint(pos[0], pos[1], brng, distM)
		pts = append(pts, latlon{lat, lon})
	}
	return pts
}

// parseVerticals scans for the lower/upper altitude envelope. Best-effort: a
// "<lower> / <upper>" pair on one line, else a single upper token.
func parseVerticals(lines []string) (lower, upper []string) {
	var single [][]string
	for _, ln := range lines {
		folded := fold(ln)
		if !strings.Contains(folded, "ft") && !strings.Contains(folded, "fl") &&
			!strings.Contains(folded, "sfc") && !strings.Contains(folded, "unl") {
			continue
		}
		toks := altTokens(ln)
		if len(toks) >= 2 {
			// Order by altitude (not print order): some fallback-path
			// supplements list the ceiling before the floor.
			return minMaxVertical(toks)
		}
		single = append(single, toks...)
	}
	if len(single) == 1 {
		// A single stated limit is the ceiling, except the surface, which
		// can only be a floor (mirrors columnVertical).
		if single[0][0] == "HEI" && single[0][1] == "0" {
			return single[0], nil
		}
		return nil, single[0]
	}
	return nil, nil
}

// altTokens returns the altitude triples on a line, left to right. UNL
// emits the explicit unlimited triple (it used to fabricate FL660); the
// French prose surface references normalize to ASFC before scanning.
func altTokens(line string) [][]string {
	type hit struct {
		pos    int
		triple []string
	}
	// Same-length-ish substitution keeps the left-to-right token order
	// stable; positions are only compared within this normalized string.
	line = aglProseRe.ReplaceAllString(line, " ASFC")
	var hits []hit
	up := strings.ToUpper(line)
	for _, idx := range indexAll(up, "SFC") {
		if idx > 0 && up[idx-1] == 'A' {
			continue // the suffix of "ASFC", not a surface limit
		}
		hits = append(hits, hit{idx, []string{"HEI", "0", "FT"}})
	}
	for _, idx := range indexAll(up, "UNL") {
		hits = append(hits, hit{idx, []string{"UNL", "", ""}})
	}
	for _, m := range flRe.FindAllStringSubmatchIndex(line, -1) {
		hits = append(hits, hit{m[0], []string{"STD", line[m[2]:m[3]], "FL"}})
	}
	for _, m := range ftRe.FindAllStringSubmatchIndex(line, -1) {
		ref := ""
		if m[4] >= 0 {
			ref = strings.ToUpper(line[m[4]:m[5]])
		}
		code := "ALT"
		if ref == "ASFC" || ref == "AGL" || ref == "SFC" {
			code = "HEI"
		}
		hits = append(hits, hit{m[0], []string{code, line[m[2]:m[3]], "FT"}})
	}
	sort.Slice(hits, func(i, j int) bool { return hits[i].pos < hits[j].pos })
	out := make([][]string, 0, len(hits))
	for _, h := range hits {
		out = append(out, h.triple)
	}
	return out
}

// parseLieu extracts FIR and aerodrome/heliport idents from the "Lieu" line,
// splitting the FIR section from the AD/HP section at the first AD/HP marker.
// Case folding goes through asciiUpper so the indexes found in the folded
// string can slice the original line: strings.ToUpper is not
// byte-length-preserving under Unicode case mapping, and pdftotext output for
// a malformed PDF can carry arbitrary runes.
func parseLieu(lines []string) (fir, adhp []string) {
	firSeen, adSeen := map[string]bool{}, map[string]bool{}
	for _, ln := range lines {
		up := asciiUpper(ln)
		fi := strings.Index(up, "FIR")
		if fi < 0 {
			continue
		}
		rest := ln[fi:]
		firPart, adPart := rest, ""
		if loc := adMarkerRe.FindStringIndex(up[fi:]); loc != nil {
			firPart, adPart = rest[:loc[0]], rest[loc[0]:]
		}
		for _, id := range findIdents(firPart) {
			if !firSeen[id] {
				firSeen[id] = true
				fir = append(fir, id)
			}
		}
		for _, id := range findIdents(adPart) {
			if !adSeen[id] {
				adSeen[id] = true
				adhp = append(adhp, id)
			}
		}
	}
	sort.Strings(fir)
	sort.Strings(adhp)
	return fir, adhp
}

// asciiUpper uppercases only the ASCII letters of s, leaving every other
// rune (and so every byte offset) untouched. Unlike strings.ToUpper the
// result is byte-for-byte alignable with s.
func asciiUpper(s string) string {
	return strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' {
			return r - ('a' - 'A')
		}
		return r
	}, s)
}

// findIdents returns the LFxx ICAO idents in s, tolerating jammed text
// ("BordeauxLFBB") by not requiring a leading word boundary.
func findIdents(s string) []string {
	var out []string
	for _, m := range identRe.FindAllStringSubmatch(s, -1) {
		out = append(out, m[1])
	}
	return out
}

// confidenceFor grades a parse: clean polygon/circle high, mixed medium, any
// approximation warning low.
func confidenceFor(src string, warnings []string) string {
	for _, w := range warnings {
		switch w {
		case "arc-not-anchored", "radial-magnetic-bearing":
			return "low"
		}
	}
	switch src {
	case "pdf-polygon", "pdf-circle":
		return "high"
	case "pdf-mixed":
		return "medium"
	}
	return "none"
}

// --- small geometry / string helpers -------------------------------------

func fold(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		if r < 128 && r != ' ' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// dedupeRing drops the closing duplicate and any consecutive duplicates: the
// SIA prints a vertex twice where a table cell wraps (045/2026's BERGEROL
// columns), and the zero-length edge such a duplicate makes reads as a
// self-intersection under the strict crossing test, dropping the whole ring.
func dedupeRing(r []latlon) []latlon {
	out := r[:0:0]
	for _, p := range r {
		if len(out) > 0 && out[len(out)-1] == p {
			continue
		}
		out = append(out, p)
	}
	if len(out) >= 2 && out[0] == out[len(out)-1] {
		out = out[:len(out)-1]
	}
	return out
}

func roundRing(r []latlon) []latlon {
	out := make([]latlon, len(r))
	for i, p := range r {
		out[i] = roundPt(p)
	}
	return out
}

func roundPt(p latlon) latlon { return latlon{aip.Round5(p[0]), aip.Round5(p[1])} }

func ringBbox(r []latlon) []float64 {
	return ringsBbox([][]latlon{r})
}

func ringsBbox(rings [][]latlon) []float64 {
	minLat, minLon := math.Inf(1), math.Inf(1)
	maxLat, maxLon := math.Inf(-1), math.Inf(-1)
	for _, r := range rings {
		for _, p := range r {
			minLat, maxLat = math.Min(minLat, p[0]), math.Max(maxLat, p[0])
			minLon, maxLon = math.Min(minLon, p[1]), math.Max(maxLon, p[1])
		}
	}
	return []float64{aip.Round5(minLat), aip.Round5(minLon), aip.Round5(maxLat), aip.Round5(maxLon)}
}

func circleRingPts(c arcSpec) []latlon {
	pts := geodesy.CircleRing(c.center[0], c.center[1], c.radiusM)
	r := make([]latlon, len(pts))
	for i, p := range pts {
		r[i] = latlon{p[0], p[1]}
	}
	return r
}

func circleBbox(c latlon, radiusM float64) []float64 {
	return ringBbox(circleRingPts(arcSpec{center: c, radiusM: radiusM}))
}

func haversineM(lat1, lon1, lat2, lon2 float64) float64 {
	const d = math.Pi / 180
	p1, p2 := lat1*d, lat2*d
	dp, dl := (lat2-lat1)*d, (lon2-lon1)*d
	a := math.Sin(dp/2)*math.Sin(dp/2) + math.Cos(p1)*math.Cos(p2)*math.Sin(dl/2)*math.Sin(dl/2)
	return 2 * geodesy.EarthRadiusM * math.Asin(math.Min(1, math.Sqrt(a)))
}

func within(a, b, frac float64) bool { return math.Abs(a-b) <= b*frac }

func indexAll(s, sub string) []int {
	var out []int
	for i := 0; ; {
		j := strings.Index(s[i:], sub)
		if j < 0 {
			break
		}
		out = append(out, i+j)
		i += j + len(sub)
	}
	return out
}
