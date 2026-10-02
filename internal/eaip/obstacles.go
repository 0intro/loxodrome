// obstacles.go reads ICAO's ENR 5.4, the air navigation obstacles, into
// aixm5.Obstacle features in the AIXM PANS-AIM vocabulary ("Wind turbine"
// is WIND_TURBINE), so the shared builder's type map and its drift net
// apply unchanged. Lifted from cmd/be, which reads its pages through it.
//
// The table is the same wherever it is printed, whatever its headings:
//
//	| Designation | OBST type | OBST position | ELEV/HGT (m) | LGT | Remarks
//	| BOSANY | chimney | 483433N 0181411E | 282/110 | yes - R, LIL |
//
// What differs is the unit of the elevation and height, which the column
// heading states ("ELEV/HGT (m)" at LPS SR, "ELEV / HGT GND (FT)" at
// SMATSA) and skeyes leaves out, meaning feet.

package eaip

import (
	"regexp"
	"strings"

	"github.com/0intro/loxodrome/internal/aixm5"
)

// obstacleCols maps the ENR 5.4 columns, -1 where absent.
type obstacleCols struct {
	name, kind, position, elev, lgt int
	// metres says the elevation column's heading states metres.
	metres bool
}

// metresHeadRe is an elevation heading in metres: "(m)", "(M)", "in m".
var metresHeadRe = regexp.MustCompile(`(?i)\(\s*m\s*\)|\bin\s+m\b|\bmetres?\b|\bmeters?\b`)

// obstacleColumns finds a table's header row and its columns; the
// position and the elevation are required.
func obstacleColumns(matrix [][]string) (obstacleCols, bool) {
	for _, row := range matrix {
		c := obstacleCols{name: 0, kind: -1, position: -1, elev: -1, lgt: -1}
		for i, h := range row {
			hu := strings.ToUpper(h)
			switch {
			case strings.Contains(hu, "POSITION") || strings.Contains(hu, "COORDINATES"):
				c.position = i
			case strings.Contains(hu, "ELEV") || strings.Contains(hu, "HGT") || strings.Contains(hu, "HEIGHT"):
				if c.elev < 0 {
					c.elev = i
					c.metres = metresHeadRe.MatchString(h)
				}
			case strings.Contains(hu, "LGT") || strings.Contains(hu, "LIGHT") || strings.Contains(hu, "MARKING"):
				// Before the kind: LPS SR heads it "LGT - Colour, Type".
				c.lgt = i
			case (strings.Contains(hu, "TYPE") || strings.Contains(hu, "OBSTACLE")) && c.kind < 0:
				c.kind = i
			case strings.Contains(hu, "NAME") || strings.Contains(hu, "LOCALITY") ||
				strings.Contains(hu, "MUNICIPALITY") || strings.Contains(hu, "DESIGNATION"):
				c.name = i
			}
		}
		if c.position >= 0 && c.elev >= 0 {
			return c, true
		}
	}
	return obstacleCols{}, false
}

// ParseObstacleTables reads every ENR 5.4 table in a section document
// that carries a position and an elevation column. A name several rows
// share is a cluster (a wind farm), flagged for the group styling.
func ParseObstacleTables(doc *Node) []aixm5.Obstacle {
	var out []aixm5.Obstacle
	byName := map[string]int{}
	for _, table := range Elems(doc, "table") {
		matrix := ExpandTable(table)
		cols, ok := obstacleColumns(matrix)
		if !ok {
			continue
		}
		for _, row := range matrix {
			pos := decimalCommaRe.ReplaceAllString(NormSpace(cell(row, cols.position)), "$1.$2")
			m := CoordRe.FindStringSubmatch(pos)
			if m == nil {
				continue
			}
			lat, lon, ok := ParsePair(m[1], m[2])
			if !ok {
				continue
			}
			name := strings.TrimSpace(cell(row, cols.name))
			elevM, hgtM := ParseElevHgt(cell(row, cols.elev), cols.metres)
			out = append(out, aixm5.Obstacle{
				ID:      ObstacleID(name, m[1], m[2]),
				Name:    name,
				Type:    NormObstacleType(cell(row, cols.kind)),
				Lat:     lat,
				Lon:     lon,
				Lighted: ObstacleLit(cell(row, cols.lgt)),
				ElevM:   elevM,
				HeightM: hgtM,
			})
			byName[name]++
		}
	}
	for i := range out {
		if byName[out[i].Name] > 1 {
			out[i].Group = true
		}
	}
	return out
}

// ParseElevHgt splits the "1518 / 489" elevation-slash-height cell into
// the aixm5 metre pointers, in the unit its heading states unless the
// value states its own (Avians' "1065 FT / 1028 FT").
func ParseElevHgt(s string, metres bool) (elevM, hgtM *float64) {
	conv := func(part string) *float64 {
		v, ok := ParseFtInt(part)
		if !ok {
			return nil
		}
		m := float64(v)
		inMetres := metres
		switch {
		case valueFeetRe.MatchString(part):
			inMetres = false
		case valueMetresRe.MatchString(part):
			inMetres = true
		}
		if !inMetres {
			m = FtToM(m)
		}
		return &m
	}
	parts := strings.SplitN(NormSpace(s), "/", 2)
	if len(parts) > 0 {
		elevM = conv(parts[0])
	}
	if len(parts) > 1 {
		hgtM = conv(parts[1])
	}
	return elevM, hgtM
}

// valueFeetRe and valueMetresRe are a unit written after a figure.
var (
	valueFeetRe   = regexp.MustCompile(`(?i)\d\s*(?:FT|FEET)\b`)
	valueMetresRe = regexp.MustCompile(`(?i)\d\s*M\b`)
)

// NormObstacleType maps the printed obstacle kind onto the AIXM
// PANS-AIM vocabulary keys of the builder's type map.
func NormObstacleType(s string) string {
	up := strings.ToUpper(strings.TrimSpace(NormSpace(s)))
	up = strings.Join(strings.Fields(up), "_")
	switch up {
	case "WINDTURBINE", "WIND_TURBINES", "WINDMILL", "WINDMILLS":
		return "WIND_TURBINE"
	case "MEASURING_MAST", "MET_MAST", "WIND_MEASURING_MAST":
		return "MAST"
	case "CHURCH", "CHURCH_TOWER", "BASILICA", "CATHEDRAL", "TOWERS":
		return "TOWER"
	case "COOLING_TOWERS":
		return "COOLING_TOWER"
	case "GASHOLDER", "GAS_HOLDER":
		return "TANK"
	case "BRIDGE_PYLON":
		// SMATSA's Ada bridge: the pylon of a cable-stayed bridge.
		return "BRIDGE"
	case "HIGH_VOLTAGE_LINE", "POWER_LINE", "CABLE":
		return "TRANSMISSION_LINE"
	}
	return up
}

// litRe is a lighting cell stating the obstacle is lit: skeyes's
// "LGT", "Day/Night", a bare "Y"; LPS SR's "yes - R, LIL"; SMATSA's
// "Yes FLG / W"; Avians' "Hazard light / FLG R". unlitRe is one stating
// it is not, first, since Avians' "No light" says LIGHT too.
var (
	litRe   = regexp.MustCompile(`(?i)LGT|LIGHT|DAY|NIGHT|^\s*Y(?:ES)?\b`)
	unlitRe = regexp.MustCompile(`(?i)^\s*(?:NO|NIL|NONE|UNLIT)\b`)
)

// ObstacleLit reads the lighting column.
func ObstacleLit(s string) bool {
	return !unlitRe.MatchString(s) && litRe.MatchString(s)
}

// ObstacleID builds a stable id from the name and the printed coordinates,
// unique per obstacle and invariant across cycles while it stands.
func ObstacleID(name, latS, lonS string) string {
	return Slug(name) + "-" + strings.TrimRight(latS, "NS") + strings.TrimRight(lonS, "EW")
}
