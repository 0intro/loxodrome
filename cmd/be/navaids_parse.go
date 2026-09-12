// navaids_parse.go: ENR 4.1 (radio navaids) and ENR 4.4 (name-code
// designated points) → aixm5.Navaid features. Belgian VFR reporting
// points are published on the VAC charts only (no machine-readable list),
// so every ENR 4.4 point emits as a WAYPOINT.

package main

import (
	"github.com/0intro/loxodrome/internal/eaip"
	"regexp"
	"strconv"
	"strings"

	"github.com/0intro/loxodrome/internal/aixm5"
)

// parseNavaids walks ENR 4.1 + 4.4.
func parseNavaids(t *tree) []aixm5.Navaid {
	var out []aixm5.Navaid
	if doc := t.doc("eAIP/EB-ENR-4.1-en-GB.html"); doc != nil {
		out = append(out, parseRadioNavaids(doc)...)
	}
	if doc := t.doc("eAIP/EB-ENR-4.4-en-GB.html"); doc != nil {
		out = append(out, parseDesignatedPoints(doc)...)
	}
	return out
}

// parseRadioNavaids reads the ENR 4.1 table: one row per navaid
// (tr id="SP-ANT-DVORDME"), columns name+type / ident / frequency+channel /
// hours / coordinates / elevation / remarks. Cells are matched by content,
// not position, to survive column drift.
func parseRadioNavaids(doc *eaip.Node) []aixm5.Navaid {
	var out []aixm5.Navaid
	for _, tr := range eaip.Elems(doc, "tr") {
		id := eaip.Attr(tr, "id")
		if !strings.HasPrefix(id, "SP-") {
			continue
		}
		cells := eaip.RowCells(tr)
		if len(cells) < 4 {
			continue
		}
		name, typeText := navaidNameType(cells[0])
		typ := navaidType(typeText)
		if typ == "" {
			continue
		}
		n := aixm5.Navaid{
			ID:   strings.TrimPrefix(id, "SP-"),
			Type: typ,
			Name: name,
		}
		for _, c := range cells[1:] {
			text := eaip.NodeText(c)
			up := strings.ToUpper(text)
			switch {
			case n.Designator == "" && identRe.MatchString(strings.TrimSpace(text)):
				n.Designator = strings.TrimSpace(text)
			case n.Lat == 0 && n.Lon == 0 && eaip.CoordRe.MatchString(up):
				if m := eaip.CoordRe.FindStringSubmatch(up); m != nil {
					if lat, lon, ok := eaip.ParsePair(m[1], m[2]); ok {
						n.Lat, n.Lon = lat, lon
					}
				}
			case strings.Contains(up, "MHZ") && n.FreqMHz == nil:
				if m := eaip.MhzRe.FindStringSubmatch(up); m != nil {
					if v, err := strconv.ParseFloat(m[1], 64); err == nil {
						n.FreqMHz = &v
						if cm := eaip.ChRe.FindStringSubmatch(up); cm != nil {
							n.Channel = cm[1]
						}
					}
				}
			case strings.Contains(up, "KHZ") && n.FreqKHz == nil:
				if m := eaip.KhzRe.FindStringSubmatch(up); m != nil {
					if v, err := strconv.ParseFloat(m[1], 64); err == nil {
						n.FreqKHz = &v
					}
				}
			case n.Channel == "":
				if cm := eaip.ChRe.FindStringSubmatch(up); cm != nil {
					n.Channel = cm[1]
				}
			}
			// Elevation: a bare "300 FT" / "300 FT AMSL" cell (not the DOC
			// remarks, which mention NM).
			if n.ElevM == nil && strings.Contains(up, "FT") && !strings.Contains(up, "NM") && !eaip.CoordRe.MatchString(up) {
				if ft, ok := eaip.ParseFtInt(up); ok {
					m := eaip.FtToM(float64(ft))
					n.ElevM = &m
				}
			}
		}
		if n.Lat == 0 && n.Lon == 0 {
			continue
		}
		if n.ID == "" {
			n.ID = n.Designator + "-" + typ
		}
		out = append(out, n)
	}
	return out
}

var identRe = regexp.MustCompile(`^[A-Z]{2,3}$`)

// navaidNameType splits the first ENR 4.1 cell into the station name and
// the equipment line ("Antwerpen" + "DVOR/DME (2°E/2025)"): the p.line
// children carry the equipment, the remaining text the name.
func navaidNameType(cell *eaip.Node) (name, typeText string) {
	full := eaip.NodeText(cell)
	for _, p := range eaip.Elems(cell, "p") {
		if !eaip.HasClass(p, "line") {
			continue
		}
		pt := eaip.NodeText(p)
		if typeText == "" {
			typeText = pt
		}
		full = strings.Replace(full, pt, "", 1)
	}
	return strings.Join(strings.Fields(full), " "), typeText
}

// navaidType maps the equipment line to the SPA navaid vocabulary.
func navaidType(s string) string {
	up := strings.ToUpper(s)
	hasVOR := strings.Contains(up, "VOR")
	hasDME := strings.Contains(up, "DME")
	hasTAC := strings.Contains(up, "TACAN")
	hasNDB := strings.Contains(up, "NDB") || strings.TrimSpace(up) == "L"
	switch {
	case hasVOR && hasTAC:
		return "VORTAC"
	case hasVOR && hasDME:
		return "VOR-DME"
	case hasVOR:
		return "VOR"
	case hasTAC:
		return "TACAN"
	case hasDME:
		return "DME"
	case hasNDB:
		return "NDB"
	}
	return ""
}

// parseDesignatedPoints reads ENR 4.4: name-code designators with their
// coordinates (tr id="SP-ABBUW", cells name / coordinates / routes).
func parseDesignatedPoints(doc *eaip.Node) []aixm5.Navaid {
	var out []aixm5.Navaid
	for _, tr := range eaip.Elems(doc, "tr") {
		id := eaip.Attr(tr, "id")
		if !strings.HasPrefix(id, "SP-") {
			continue
		}
		cells := eaip.RowCells(tr)
		if len(cells) < 2 {
			continue
		}
		name := strings.TrimSpace(eaip.NodeText(cells[0]))
		if !pointNameRe.MatchString(name) {
			continue
		}
		m := eaip.CoordRe.FindStringSubmatch(eaip.NodeText(cells[1]))
		if m == nil {
			continue
		}
		lat, lon, ok := eaip.ParsePair(m[1], m[2])
		if !ok {
			continue
		}
		out = append(out, aixm5.Navaid{
			ID:         name,
			Type:       "WAYPOINT",
			Designator: name,
			Lat:        lat,
			Lon:        lon,
		})
	}
	return out
}

var pointNameRe = regexp.MustCompile(`^[A-Z]{4,5}\d?$`)
