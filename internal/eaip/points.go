// points.go reads the points a pilot navigates by that no radio aid
// marks: ICAO's ENR 4.4, the five-letter name-codes of the significant
// points, and the visual reporting points an aerodrome page lists.
//
// ENR 4.4 is the same four columns wherever it is published:
//
//	| Name-code designator | Coordinates | ATS route or other route | Remarks
//	| ABITU | 482000N 0181929E | P41, Z650 | FRA (A): LKKU, LKTB
//
// (Fintraffic heads them REP / COORD / REF ATS RTE and adds its FRA
// relevance.) Every designator in the cohort is a five-letter name-code,
// which is an ICAO significant point, drawn as the four-pointed star the
// AIXM publishers' designated points of type ICAO are. A row naming
// anything else is left out and counted: a visual point has no business
// in this table, and a guess at its kind would draw it as the wrong one.

package eaip

import (
	"regexp"
	"strings"

	"github.com/0intro/loxodrome/internal/aixm5"
)

// fiveLNCRe is an ICAO five-letter name-code.
var fiveLNCRe = regexp.MustCompile(`^[A-Z]{5}$`)

// pointDesigRe and pointCoordRe head the ENR 4.4 columns.
var (
	pointDesigRe = regexp.MustCompile(`(?i)NAME-?\s*CODE|DESIGNATOR|^\s*REP\s*$|IDENT`)
	pointCoordRe = regexp.MustCompile(`(?i)COORD`)
)

// decimalCommaRe is a coordinate's seconds with a decimal comma, LPS SR's
// "490344,4N 0202826,5E".
var decimalCommaRe = regexp.MustCompile(`(\d{6,7}),(\d+\s*[NSEW])`)

// pointCoord reads a point's position, the decimal comma first.
func pointCoord(s string) (float64, float64, bool) {
	return AnyCoord(decimalCommaRe.ReplaceAllString(NormSpace(s), "$1.$2"))
}

// ParsePointTables reads the ENR 4.4 significant points of a section
// document as waypoints.
func ParsePointTables(doc *Node, st *NavaidStats) []aixm5.Navaid {
	var out []aixm5.Navaid
	for _, t := range FindAll(doc, func(n *Node) bool { return IsElem(n) && n.Data == "table" }) {
		cells := ExpandCells(t)
		matrix := TextMatrix(cells, NodeText)
		desig, coord := -1, -1
		for ri, row := range matrix {
			if desig < 0 {
				for j, c := range row {
					switch {
					case desig < 0 && pointDesigRe.MatchString(c):
						desig = j
					case coord < 0 && pointCoordRe.MatchString(c):
						coord = j
					}
				}
				if desig < 0 || coord < 0 {
					desig, coord = -1, -1
					continue
				}
				st.Tables++
				continue
			}
			ident := strings.TrimSpace(NormSpace(cell(row, desig)))
			if ident == "" || numberingRow(row) != nil {
				continue
			}
			// A rule part-way down a tall remarks cell adds a grid row the
			// name cell spans: the same point, read once.
			if ri > 0 && desig < len(cells[ri]) && desig < len(cells[ri-1]) &&
				cells[ri][desig] != nil && cells[ri][desig] == cells[ri-1][desig] {
				continue
			}
			lat, lon, ok := pointCoord(cell(row, coord))
			if !ok {
				continue
			}
			st.Rows++
			if !fiveLNCRe.MatchString(ident) {
				st.SkippedKinds["ENR 4.4 "+ident]++
				continue
			}
			out = append(out, aixm5.Navaid{
				ID:         "WPT:" + ident,
				Type:       "WAYPOINT",
				Designator: ident,
				Lat:        lat,
				Lon:        lon,
			})
		}
	}
	return out
}

// vrpRowRe is the head of a visual reporting point's row, the word the
// State files it under and the point's name: AirNav's "VRP Ashbourne
// Town", "VRP Drumcliff Church:".
var vrpRowRe = regexp.MustCompile(`(?i)^\s*VRP\s+(.+?)\s*:?\s*$`)

// ReadVisualPoints reads the visual reporting points an aerodrome page
// lists in a table: the rows whose first cell is "VRP <name>" beside a
// coordinate (AirNav), and in AD 2.22 the tables headed by a point's name
// and its coordinates (LGS's Riga, "Entry/Exit point | Visual reference |
// Coordinates"; ANS CR's Kunovice, "Designation | Location |
// Coordinates"). The holding points AirNav lists beside them at the same
// places are not points of their own. LVNL's and Slovenia Control's
// layouts, the direction before the name, are left until a State
// publishing one ships.
func ReadVisualPoints(doc *Node, icao string) []aixm5.Navaid {
	var out []aixm5.Navaid
	seen := map[string]bool{}
	add := func(name string, lat, lon float64) {
		ident := strings.ToUpper(NormSpace(name))
		if ident == "" || seen[ident] {
			return
		}
		seen[ident] = true
		out = append(out, aixm5.Navaid{
			ID:         "VRP:" + icao + ":" + Slug(ident),
			Type:       "VFR_REPORTING_POINT",
			Designator: ident,
			Lat:        lat,
			Lon:        lon,
		})
	}
	for _, t := range ADSectionTables(doc, icao)["22"] {
		matrix := ExpandTable(t)
		nameCol, coordCol, head := -1, -1, -1
		for r, row := range matrix {
			nameCol, coordCol = -1, -1
			landmark := false
			for i, h := range row {
				h = NormSpace(h)
				switch {
				case nameCol < 0 && pointHeadRe.MatchString(h):
					nameCol = i
				case coordCol < 0 && coordHeadRe.MatchString(h):
					coordCol = i
				case landmarkHeadRe.MatchString(h):
					landmark = true
				}
			}
			// A visual point is described by the landmark it is; a table
			// of names and coordinates alone is the procedures' waypoint
			// list (ANS CR's České Budějovice, AD 2.22.5).
			if nameCol >= 0 && coordCol >= 0 && landmark {
				head = r
				break
			}
		}
		if head < 0 {
			continue
		}
		for _, row := range matrix[head+1:] {
			if nameCol >= len(row) || coordCol >= len(row) {
				continue
			}
			lat, lon, ok := pointCoord(row[coordCol])
			if !ok {
				continue
			}
			// "RIVER (exit point only)": the point is RIVER.
			add(pointUseRe.ReplaceAllString(NormSpace(row[nameCol]), ""), lat, lon)
		}
	}
	for _, t := range FindAll(doc, func(n *Node) bool { return IsElem(n) && n.Data == "table" }) {
		for _, row := range ExpandTable(t) {
			cells := distinctCells(row)
			if len(cells) < 2 {
				continue
			}
			m := vrpRowRe.FindStringSubmatch(cells[0])
			if m == nil || strings.Contains(strings.ToUpper(m[1]), "HOLD") {
				continue
			}
			lat, lon, ok := pointCoord(strings.Join(cells[1:], " "))
			if !ok {
				continue
			}
			add(m[1], lat, lon)
		}
	}
	return out
}

var (
	// pointHeadRe heads the name column of an AD 2.22 table of points.
	pointHeadRe = regexp.MustCompile(`(?i)^(?:entry\s*/\s*exit\s+points?|(?:visual\s+|vfr\s+)?reporting\s+points?|designation)$`)
	// coordHeadRe heads its coordinates column.
	coordHeadRe = regexp.MustCompile(`(?i)^(?:geographical\s+)?coordinates?\b`)
	// landmarkHeadRe heads the column describing the landmark a visual
	// point is.
	landmarkHeadRe = regexp.MustCompile(`(?i)^(?:location|visual\s+reference|description|landmark)$`)
	// pointUseRe is a use a name carries in brackets.
	pointUseRe = regexp.MustCompile(`(?i)\s*\((?:entry|exit)[^)]*\)`)
)
