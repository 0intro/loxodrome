// enr.go: the ENR airspace sections → aixm5.Airspace features.
//
//   - ENR 2.1: captioned <table class="FirUirTma"> with labelled rows
//     (Lateral limits / Vertical limits / Airspace class). FIR and UIR are
//     SKIPPED on purpose: pruatlas-firs.json already ships the EBBU row
//     with true border geometry, while the eAIP text would only yield
//     border approximations (see boundary.go).
//   - ENR 2.2 / 5.1 / 5.2 / 5.3 / 5.5: captioned zone tables, either
//     columnar (thead Lateral limits | Vertical limits | Type of
//     restriction | Time of activity, one zone per data row) or labelled
//     like ENR 2.1. A multi-row table emits one feature per row sharing
//     the designator (the SPA keys same-id rows separately, the MOA
//     sub-ring precedent).
//
// CTRs are parsed from the per-aerodrome AD 2.17 tables (airports_parse.go),
// not from ENR.

package main

import (
	"github.com/0intro/loxodrome/internal/eaip"
	"regexp"
	"strings"

	"github.com/0intro/loxodrome/internal/aixm5"
)

// enrStats aggregates parse events for the meta sidecar.
type enrStats struct {
	boundary     eaip.BoundaryStats
	skippedTypes map[string]int // skipped table captions by reason/type
	multiRow     int            // zone tables emitting more than one row
	firRings     int            // "The FIR boundary." rows borrowing the EBBU ring
	pointCircles int            // single-point zones drawn as 1 NM circles
}

func newEnrStats() *enrStats {
	return &enrStats{skippedTypes: map[string]int{}}
}

// zoneSections are the captioned zone-table pages and the section key that
// drives type derivation.
var zoneSections = []struct{ page, section string }{
	{"eAIP/EB-ENR-2.2-en-GB.html", "2.2"},
	{"eAIP/EB-ENR-5.1-en-GB.html", "5.1"},
	{"eAIP/EB-ENR-5.2-en-GB.html", "5.2"},
	{"eAIP/EB-ENR-5.3-en-GB.html", "5.3"},
	{"eAIP/EB-ENR-5.5-en-GB.html", "5.5"},
}

// parseEnrAirspaces walks every ENR airspace section of the tree.
func parseEnrAirspaces(t *tree, border *eaip.BorderRing, st *enrStats) []aixm5.Airspace {
	var out []aixm5.Airspace
	if doc := t.doc("eAIP/EB-ENR-2.1-en-GB.html"); doc != nil {
		tables := eaip.FindAll(doc, func(n *eaip.Node) bool {
			return n.Data == "table" && eaip.HasClass(n, "FirUirTma")
		})
		for _, table := range tables {
			cap := eaip.TableCaption(table)
			typ := enr21Type(cap)
			if typ == "" {
				st.skippedTypes[skipKey(cap)]++
				continue
			}
			upper, lower := eaip.ParseVerticalPair(labelledPrefix(table, "VERTICAL LIMITS"))
			out = append(out, aixm5.Airspace{
				ID:         "BE-" + slug(cap),
				Designator: "BE-" + slug(cap),
				Name:       cap,
				Type:       typ,
				ClassCode:  classLetter(labelledPrefix(table, "AIRSPACE CLASS")),
				UpperLimit: upper,
				LowerLimit: lower,
				Ring:       zoneRing(labelledPrefix(table, "LATERAL LIMITS"), border, st),
			})
		}
	}
	for _, sec := range zoneSections {
		doc := t.doc(sec.page)
		if doc == nil {
			continue
		}
		for _, table := range eaip.Elems(doc, "table") {
			cap := eaip.TableCaption(table)
			if cap == "" {
				continue
			}
			out = append(out, parseZoneTable(table, cap, sec.section, border, st)...)
		}
	}
	return out
}

// enr21Type classifies an ENR 2.1 caption. "" = skip the table.
func enr21Type(cap string) string {
	up := " " + strings.ToUpper(cap) + " "
	switch {
	case strings.Contains(up, " FIR ") || strings.Contains(up, " UIR "):
		return "" // pruatlas ships the EBBU FIR ring; UIR rides the same ident
	case strings.Contains(up, "AIRWAYS"):
		return ""
	case strings.Contains(up, "AREA CONTROL"):
		return "" // the ACC / FIC frequency table, not an airspace
	case strings.Contains(up, " UTA "):
		return "UTA"
	case strings.Contains(up, "LOWER CONTROL AREA"):
		return "CTA"
	case strings.Contains(up, " TMA "):
		return "TMA"
	case strings.Contains(up, " CTR "):
		return "CTR"
	case strings.Contains(up, " CTA "):
		return "CTA"
	}
	return ""
}

// sua51Re matches a compact SUA designator caption ("EBR04", "EBD07A").
// LF is included: ENR 2.2 republishes French zones delegated over Belgium
// (LFR616L); keeping their true designator lets the SPA's cross-dataset id
// dedup drop the copy when fr-airspaces already ships the zone.
var (
	sua51Re    = regexp.MustCompile(`^(EB|EL|LF)([PRD])[0-9]+[A-Z]*(?:\.[0-9]+)?$`)
	classABCRe = regexp.MustCompile(`\b([A-G])\b`)
	// cbaRe matches a Cross Border Area designator token, bare or with a
	// national prefix: "CBA1L", "CBA1MZ" (the FBZ twin), "LFCBA16B".
	// Anchored to the full token so prose can never match.
	cbaRe = regexp.MustCompile(`^[A-Z]{0,2}CBA[0-9]+[A-Z]*$`)
)

// isCrossBorderArea reports whether a zone caption titles a Cross Border
// Area (the ENR 5.2 CBA1 volumes + their FBZ twins, the ENR 2.2
// republished French LFCBA16B): its designator token has the CBA form, or
// its name half spells out "CROSS BORDER AREA". Anchored on the caption
// only, so a zone merely citing a CBA in a restriction or remark cell
// keeps its section type.
func isCrossBorderArea(cap string) bool {
	left, name := cap, cap
	if i := strings.Index(cap, " - "); i > 0 {
		left, name = strings.TrimSpace(cap[:i]), strings.TrimSpace(cap[i+3:])
	}
	if cbaRe.MatchString(strings.Join(strings.Fields(strings.ToUpper(left)), "")) {
		return true
	}
	return strings.Contains(strings.ToUpper(name), "CROSS BORDER AREA")
}

// parseZoneTable parses one captioned zone table into zero or more
// airspaces.
func parseZoneTable(table *eaip.Node, cap, section string, border *eaip.BorderRing, st *enrStats) []aixm5.Airspace {
	desig, name := splitZoneCaption(cap, section)
	typ := zoneType(section, desig, cap)
	if typ == "" {
		st.skippedTypes[skipKey(cap)]++
		return nil
	}
	id := desig
	if id == "" {
		id = "BE-" + slug(name)
	}

	var out []aixm5.Airspace
	// Labelled layout first: a "Lateral limits" header cell whose SAME-ROW
	// value carries the geometry (the ENR 2.2 / FirUirTma shape). In the
	// columnar layout the cell right of "Lateral limits" is the next
	// header ("Vertical limits"), which never parses as geometry.
	if lat := labelledPrefix(table, "LATERAL LIMITS"); geometryText(lat) {
		upper, lower := eaip.ParseVerticalPair(labelledPrefix(table, "VERTICAL LIMITS"))
		out = append(out, aixm5.Airspace{
			ID:         id,
			Designator: id,
			Name:       name,
			Type:       typ,
			ClassCode:  classLetter(labelledPrefix(table, "AIRSPACE CLASS")),
			UpperLimit: upper,
			LowerLimit: lower,
			Ring:       zoneRing(lat, border, st),
			WorkHr:     labelledPrefix(table, "TIME OF ACTIVITY"),
			Rmk:        labelledPrefix(table, "TYPE OF RESTRICTION"),
		})
	} else if matrix := eaip.ExpandTable(table); true {
		hi := zoneHeaderRow(matrix)
		if hi < 0 {
			return nil
		}
		cols := zoneColumns(matrix[hi])
		for ri := hi + 1; ri < len(matrix); ri++ {
			row := matrix[ri]
			if len(row) == 0 || !geometryText(zCell(row, cols.lateral)) {
				continue
			}
			upper, lower := eaip.ParseVerticalPair(zCell(row, cols.vertical))
			out = append(out, aixm5.Airspace{
				ID:         id,
				Designator: id,
				Name:       name,
				Type:       typ,
				ClassCode:  classLetter(zCell(row, cols.class)),
				UpperLimit: upper,
				LowerLimit: lower,
				Ring:       zoneRing(zCell(row, cols.lateral), border, st),
				WorkHr:     zCell(row, cols.time),
				Rmk:        zCell(row, cols.restriction),
			})
		}
	}
	if len(out) > 1 {
		st.multiRow++
	}
	return out
}

// geometryText reports whether a cell plausibly carries zone geometry
// (a coordinate pair, in either the full or the short minutes-only form).
func geometryText(s string) bool {
	s = eaip.NormSpace(s)
	return eaip.CoordRe.MatchString(s) || eaip.ShortCoordRe.MatchString(s)
}

// zoneRing parses a lateral-limits cell, with two eAIP special cases: a
// bare "The FIR boundary." reference borrows the whole EBBU ring, and a
// single published point (the ENR 5.3 weather-balloon sites) becomes a
// 1 NM circle so the zone stays visible and clickable.
func zoneRing(lat string, border *eaip.BorderRing, st *enrStats) [][2]float64 {
	ring := eaip.ParseBoundary(lat, border, &st.boundary)
	if len(ring) == 0 && strings.Contains(strings.ToUpper(lat), "FIR") && border != nil {
		st.firRings++
		return append([][2]float64(nil), border.Pts...)
	}
	if len(ring) == 0 {
		if pt, ok := eaip.ShortCoord(lat); ok {
			ring = [][2]float64{pt}
		}
	}
	if len(ring) >= 1 && len(ring) <= 2 {
		st.pointCircles++
		return eaip.CircleRingAround(ring[0], 1852)
	}
	return ring
}

// zoneCols maps the zone-table columns of interest. -1 = absent.
type zoneCols struct {
	lateral, vertical, restriction, time, class int
}

// zoneHeaderRow finds the header row whose first cell starts with
// "Lateral limits" (ENR 5.3 titles the column "Lateral limits /
// coordinates").
func zoneHeaderRow(matrix [][]string) int {
	for i, row := range matrix {
		if len(row) > 0 && strings.HasPrefix(strings.ToUpper(strings.TrimSpace(row[0])), "LATERAL LIMITS") {
			return i
		}
	}
	return -1
}

func zoneColumns(header []string) zoneCols {
	cols := zoneCols{lateral: -1, vertical: -1, restriction: -1, time: -1, class: -1}
	for i, h := range header {
		hu := strings.ToUpper(h)
		switch {
		case strings.HasPrefix(hu, "LATERAL"):
			cols.lateral = i
		case strings.HasPrefix(hu, "VERTICAL"):
			cols.vertical = i
		case strings.Contains(hu, "RESTRICTION") || strings.Contains(hu, "HAZARD") || strings.Contains(hu, "ACTIVITY TYPE") || strings.Contains(hu, "TYPE OF"):
			cols.restriction = i
		case strings.Contains(hu, "TIME"):
			cols.time = i
		case strings.Contains(hu, "CLASS"):
			cols.class = i
		}
	}
	return cols
}

func zCell(row []string, i int) string {
	if i < 0 || i >= len(row) {
		return ""
	}
	return row[i]
}

// splitZoneCaption splits "EBR04 - ELSENBORN 01" into designator + name.
// Sections without compact designators keep the whole caption as the name.
func splitZoneCaption(cap, section string) (desig, name string) {
	left, right := cap, ""
	if i := strings.Index(cap, " - "); i > 0 {
		left, right = strings.TrimSpace(cap[:i]), strings.TrimSpace(cap[i+3:])
	}
	switch section {
	case "5.1", "2.2":
		// ENR 2.2 also republishes designatored zones delegated across the
		// border ("EBR18A - FLORENNES").
		if sua51Re.MatchString(left) {
			if right == "" {
				right = left
			}
			return left, right
		}
	case "5.2":
		lu := strings.ToUpper(left)
		if strings.Contains(lu, "TRA") || strings.Contains(lu, "TSA") {
			if right == "" {
				right = left
			}
			return strings.Join(strings.Fields(left), " "), right
		}
	}
	return "", cap
}

// zoneType derives the SPA airspace type for a zone table.
func zoneType(section, desig, cap string) string {
	if isCrossBorderArea(cap) {
		// AIXM codeAirspaceType CBA, overriding the section defaults:
		// ENR 5.2 files the CBA1 volumes among the TRAs, and ENR 2.2's
		// LFCBA16B would fall through to the W default.
		return "CBA"
	}
	up := " " + strings.ToUpper(cap) + " "
	switch section {
	case "5.1":
		if m := sua51Re.FindStringSubmatch(desig); m != nil {
			return m[2] // P / R / D
		}
		return ""
	case "5.2":
		if strings.Contains(strings.ToUpper(desig), "TSA") {
			return "TSA"
		}
		return "TRA"
	case "5.3":
		return "W" // other dangerous activities: the warning family
	case "5.5":
		// The SPA's activity family (green pictogram zones), not the
		// R-hatch "A" alias: these are glider / sporting areas.
		return "ACTIVITY"
	case "2.2":
		switch {
		case sua51Re.MatchString(desig):
			return sua51Re.FindStringSubmatch(desig)[2]
		case strings.Contains(up, " CTR "):
			return "CTR"
		case strings.Contains(up, " TMA "):
			return "TMA"
		case strings.Contains(up, " RMZ "):
			return "RMZ"
		case strings.Contains(up, " TMZ "):
			return "TMZ"
		default:
			return "W" // EIJSDEN / ZEELAND / SASKI style special areas
		}
	}
	return ""
}

// classLetter extracts the airspace class (A-G) from a cell like "C (1)".
func classLetter(s string) string {
	m := classABCRe.FindStringSubmatch(strings.ToUpper(s))
	if m == nil {
		return ""
	}
	return m[1]
}

// slug uppercases and dash-folds a caption into a stable id fragment:
// "Brussels TMA One" -> "BRUSSELS-TMA-ONE".
func slug(s string) string {
	var b strings.Builder
	dash := true // suppress a leading dash
	for _, r := range strings.ToUpper(s) {
		switch {
		case r >= 'A' && r <= 'Z' || r >= '0' && r <= '9':
			b.WriteRune(r)
			dash = false
		default:
			if !dash {
				b.WriteByte('-')
				dash = true
			}
		}
	}
	return strings.TrimRight(b.String(), "-")
}

func skipKey(cap string) string {
	k := slug(cap)
	if len(k) > 40 {
		k = k[:40]
	}
	return k
}
