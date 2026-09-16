// navaids.go reads ICAO's ENR 4.1 table, the radio navigation aids
// serving the en-route phase.
//
// It is the same seven columns in every State of the cohort, which is
// what makes one reader enough:
//
//	| Name of station (VOR/VAR) | Id | Frequency (CH) | Hours of
//	| operation | Geographical coordinates | ELEV DME antenna | Remarks
//
//	| BEKES DVOR/DME (decl.: +6) | BKS | 115.8MHZ 105X | H24 |
//	| 464800N 0210426E | 92 M | Coverage: 100 NM ...
//
// The kind is read from the station NAME, because that is where ENR 4.1
// states it ("DVOR/DME", "NDB", "TACAN"); the Id column is the
// designator and the coordinate column the position. What the table does
// NOT carry is the true bearing or the service volume, which the AIXM
// publishers do; the app uses neither.

package eaip

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/0intro/loxodrome/internal/aixm5"
)

// NavaidStats counts what a run recognised, for the meta sidecar.
type NavaidStats struct {
	Tables int
	Rows   int
	// SkippedKinds counts the station names whose equipment could not be
	// named, keyed by the name, so a new wording is nameable.
	SkippedKinds map[string]int
	// SkippedNoPosition counts the rows whose coordinate cell did not
	// parse.
	SkippedNoPosition int
}

// NewNavaidStats returns stats with its map ready.
func NewNavaidStats() *NavaidStats {
	return &NavaidStats{SkippedKinds: map[string]int{}}
}

// navaidHeadWords identify the ENR 4.1 first column: ICAO's "Name of
// station", and the bare "STATION" Poland heads its bilingual column
// with ("STACJA STATION").
var navaidHeadWords = []string{"NAME OF STATION", "NAME OF THE STATION", "STATION"}

// ParseNavaidTables reads every ENR 4.1 table in a section document.
//
// idPrefix names a station whose Id column is empty, which happens for a
// locator published under its aerodrome's name.
func ParseNavaidTables(doc *Node, idPrefix string, st *NavaidStats) []aixm5.Navaid {
	tables := FindAll(doc, func(n *Node) bool {
		return IsElem(n) && n.Data == "table"
	})
	var out []aixm5.Navaid
	for _, t := range tables {
		matrix := ExpandTable(t)
		hi, cols := navaidHeaderRow(matrix)
		if hi < 0 {
			continue
		}
		st.Tables++
		for ri := hi + 1; ri < len(matrix); ri++ {
			row := matrix[ri]
			name := NormSpace(strings.TrimSpace(cell(row, cols.name)))
			if name == "" || isLegendRow(row) {
				continue
			}
			// The equipment is named in its own column where the State
			// gives it one (Poland's "POMOC / FACILITY"), and inside the
			// station name where it does not.
			kind := NavaidKind(cell(row, cols.kind))
			if kind == "" {
				kind = NavaidKind(name)
			}
			if kind == "" {
				st.SkippedKinds[skipKey(name)]++
				continue
			}
			lat, lon, ok := navaidPosition(cell(row, cols.pos))
			if !ok {
				st.SkippedNoPosition++
				continue
			}
			n := aixm5.Navaid{
				Type:       kind,
				Designator: strings.ToUpper(NormSpace(strings.TrimSpace(cell(row, cols.id)))),
				Name:       cleanStationName(name),
				Lat:        lat,
				Lon:        lon,
			}
			n.ID = n.Designator
			if n.ID == "" {
				n.ID = idPrefix + "-" + Slug(n.Name)
			}
			applyNavaidFreq(&n, cell(row, cols.freq))
			if m := elevMetres(cell(row, cols.elev)); m != nil {
				n.ElevM = m
			}
			out = append(out, n)
			st.Rows++
		}
	}
	return out
}

type navaidCols struct{ name, kind, id, freq, pos, elev int }

// navaidHeaderRow finds the ENR 4.1 header and its columns by name. The
// order is ICAO's in every State seen, but reading the header rather
// than the position costs nothing and survives a State inserting one.
func navaidHeaderRow(matrix [][]string) (int, navaidCols) {
	for i, row := range matrix {
		if len(row) < 4 {
			continue
		}
		head := strings.ToUpper(NormSpace(row[0]))
		named := false
		for _, w := range navaidHeadWords {
			if strings.Contains(head, w) {
				named = true
			}
		}
		if !named {
			continue
		}
		cols := navaidCols{name: 0, kind: -1, id: -1, freq: -1, pos: -1, elev: -1}
		for c, h := range row {
			hu := strings.ToUpper(NormSpace(h))
			switch {
			case c == 0:
			case cols.kind < 0 && (strings.Contains(hu, "FACILITY") || strings.Contains(hu, "TYPE OF")):
				cols.kind = c
			case cols.id < 0 && (hu == "ID" || strings.Contains(hu, "IDENT")):
				cols.id = c
			case cols.freq < 0 && strings.Contains(hu, "FREQUENCY"):
				cols.freq = c
			case cols.pos < 0 && (strings.Contains(hu, "COORDINATE") || strings.Contains(hu, "POSITION")):
				cols.pos = c
			case cols.elev < 0 && strings.Contains(hu, "ELEV"):
				cols.elev = c
			}
		}
		if cols.id < 0 || cols.pos < 0 {
			continue
		}
		return i, cols
	}
	return -1, navaidCols{}
}

// isLegendRow recognises the column-number row ICAO prints under the
// header ("1", "2", "3", ...).
func isLegendRow(row []string) bool {
	for _, c := range row {
		c = strings.TrimSpace(c)
		if c == "" {
			continue
		}
		if _, err := strconv.Atoi(c); err != nil {
			return false
		}
	}
	return true
}

// NavaidKind names the equipment from the station name, which is where
// ENR 4.1 states it. The order matters: a DVOR/DME must not match the
// bare VOR case, and a VORTAC is not a VOR beside a TACAN.
func NavaidKind(name string) string {
	u := strings.ToUpper(NormSpace(name))
	// Cut a parenthesised note first ("(decl.: +6)"), which may quote
	// another kind.
	if i := strings.IndexByte(u, '('); i > 0 {
		u = u[:i]
	}
	switch {
	case strings.Contains(u, "VORTAC"):
		return "VORTAC"
	case strings.Contains(u, "VOR") && strings.Contains(u, "DME"):
		return "VOR-DME"
	case strings.Contains(u, "TACAN"):
		return "TACAN"
	case strings.Contains(u, "VOR"):
		return "VOR"
	case strings.Contains(u, "NDB"), strings.Contains(u, "LOCATOR"), locatorRe.MatchString(u):
		// "GRACIOSA L" is ICAO's abbreviation for a locator, which is an
		// NDB serving an approach.
		return "NDB"
	case strings.Contains(u, "DME"):
		return "DME"
	}
	return ""
}

// locatorRe matches the bare "L" ENR 4.1 names a locator with, as its
// own word so a name merely containing the letter cannot match.
var locatorRe = regexp.MustCompile(`(^|\s)L(\s|$)`)

// stationNoteRe strips the parenthesised notes ENR 4.1 hangs off a
// station name ("BEKES DVOR/DME (decl.: +6)").
var stationNoteRe = regexp.MustCompile(`\s*\([^)]*\)`)

func cleanStationName(s string) string {
	return strings.TrimSpace(stationNoteRe.ReplaceAllString(NormSpace(s), ""))
}

// applyNavaidFreq reads the frequency cell, which carries a VHF value in
// MHz, an LF/MF value in kHz, and a DME channel, in any combination:
// "115.8MHZ 105X", "355 KHZ", "CH 105X".
func applyNavaidFreq(n *aixm5.Navaid, cell string) {
	s := strings.ToUpper(NormSpace(cell))
	if m := MhzRe.FindStringSubmatch(s); m != nil {
		if v, err := strconv.ParseFloat(m[1], 64); err == nil {
			n.FreqMHz = &v
		}
	}
	if m := KhzRe.FindStringSubmatch(s); m != nil {
		if v, err := strconv.ParseFloat(m[1], 64); err == nil {
			n.FreqKHz = &v
		}
	}
	if m := ChRe.FindStringSubmatch(s); m != nil {
		n.Channel = m[1]
	} else if m := bareChannelRe.FindStringSubmatch(s); m != nil {
		n.Channel = m[1]
	}
}

// bareChannelRe matches the DME channel printed beside the VHF value
// with no CH prefix ("115.8MHZ 105X").
var bareChannelRe = regexp.MustCompile(`\b(\d{2,3}[XY])\b`)

// navaidPosition reads the coordinate cell, in any of the three forms
// the cohort writes: compact, spaced DMS, and minutes-only.
func navaidPosition(cell string) (lat, lon float64, ok bool) {
	s := NormSpace(cell)
	if m := CoordRe.FindStringSubmatch(s); m != nil {
		return ParsePair(m[1], m[2])
	}
	if pt, found := SpacedCoord(s); found {
		return pt[0], pt[1], true
	}
	if pt, found := ShortCoord(s); found {
		return pt[0], pt[1], true
	}
	return 0, 0, false
}

// elevMetreRe reads the DME antenna elevation, which ENR 4.1 prints in
// metres ("92 M") or feet ("302 FT").
var elevMetreRe = regexp.MustCompile(`(?i)\b(\d{1,5})\s*(M|FT)\b`)

func elevMetres(cell string) *float64 {
	m := elevMetreRe.FindStringSubmatch(NormSpace(cell))
	if m == nil {
		return nil
	}
	v, err := strconv.ParseFloat(m[1], 64)
	if err != nil {
		return nil
	}
	if strings.EqualFold(m[2], "FT") {
		v = FtToM(v)
	}
	return &v
}
