// obstacles_parse.go: the ENR 5.4 en-route obstacle table →
// aixm5.Obstacle features. The parser emits AIXM PANS-AIM vocabulary
// ("Wind turbine" → WIND_TURBINE) so the shared obstacleTypeMap and its
// unknown-type drift net apply unchanged.

package main

import (
	"github.com/0intro/loxodrome/internal/eaip"
	"strings"

	"github.com/0intro/loxodrome/internal/aixm5"
)

// parseObstacles reads every ENR 5.4 table that carries an
// elevation/height column.
func parseObstacles(t *tree) []aixm5.Obstacle {
	doc := t.doc("eAIP/EB-ENR-5.4-en-GB.html")
	if doc == nil {
		return nil
	}
	var out []aixm5.Obstacle
	byName := map[string]int{}
	for _, table := range eaip.Elems(doc, "table") {
		matrix := eaip.ExpandTable(table)
		cols := obstacleColumns(matrix)
		if cols.position < 0 || cols.elev < 0 {
			continue
		}
		for _, row := range matrix {
			pos := eaip.NormSpace(zCell(row, cols.position))
			m := eaip.CoordRe.FindStringSubmatch(pos)
			if m == nil {
				continue
			}
			lat, lon, ok := eaip.ParsePair(m[1], m[2])
			if !ok {
				continue
			}
			name := strings.TrimSpace(zCell(row, cols.name))
			elevM, hgtM := parseElevHgt(zCell(row, cols.elev))
			o := aixm5.Obstacle{
				ID:      obstacleID(name, m[1], m[2]),
				Name:    name,
				Type:    normObstacleType(zCell(row, cols.kind)),
				Lat:     lat,
				Lon:     lon,
				Lighted: obstacleLit(zCell(row, cols.lgt)),
				ElevM:   elevM,
				HeightM: hgtM,
			}
			byName[name]++
			out = append(out, o)
		}
	}
	// Localities listing several obstacles are clusters (wind farms):
	// flag them so the SPA's group styling applies.
	for i := range out {
		if byName[out[i].Name] > 1 {
			out[i].Group = true
		}
	}
	return out
}

// obstacleCols maps the ENR 5.4 columns. -1 = absent.
type obstacleCols struct {
	name, kind, position, elev, lgt int
}

// obstacleColumns finds the header row and resolves the columns of
// interest. position and elev are required.
func obstacleColumns(matrix [][]string) obstacleCols {
	cols := obstacleCols{name: 0, kind: -1, position: -1, elev: -1, lgt: -1}
	for _, row := range matrix {
		probe := obstacleCols{name: 0, kind: -1, position: -1, elev: -1, lgt: -1}
		for i, h := range row {
			hu := strings.ToUpper(h)
			switch {
			case strings.Contains(hu, "POSITION") || strings.Contains(hu, "COORDINATES"):
				probe.position = i
			case strings.Contains(hu, "ELEV") || strings.Contains(hu, "HGT") || strings.Contains(hu, "HEIGHT"):
				if probe.elev < 0 {
					probe.elev = i
				}
			case strings.Contains(hu, "TYPE") || strings.Contains(hu, "OBSTACLE"):
				probe.kind = i
			case strings.Contains(hu, "LGT") || strings.Contains(hu, "LIGHT") || strings.Contains(hu, "MARKING"):
				probe.lgt = i
			case strings.Contains(hu, "NAME") || strings.Contains(hu, "LOCALITY") ||
				strings.Contains(hu, "MUNICIPALITY") || strings.Contains(hu, "DESIGNATION"):
				probe.name = i
			}
		}
		if probe.position >= 0 && probe.elev >= 0 {
			return probe
		}
	}
	return cols
}

// parseElevHgt splits the "1518 / 489" elevation-slash-height cell (feet)
// into the aixm5 metre pointers.
func parseElevHgt(s string) (elevM, hgtM *float64) {
	parts := strings.SplitN(eaip.NormSpace(s), "/", 2)
	if len(parts) > 0 {
		if ft, ok := eaip.ParseFtInt(parts[0]); ok {
			m := eaip.FtToM(float64(ft))
			elevM = &m
		}
	}
	if len(parts) > 1 {
		if ft, ok := eaip.ParseFtInt(parts[1]); ok {
			m := eaip.FtToM(float64(ft))
			hgtM = &m
		}
	}
	return elevM, hgtM
}

// normObstacleType maps the printed obstacle kind onto the AIXM PANS-AIM
// vocabulary keys of obstacleTypeMap.
func normObstacleType(s string) string {
	up := strings.ToUpper(strings.TrimSpace(eaip.NormSpace(s)))
	up = strings.Join(strings.Fields(up), "_")
	switch up {
	case "WINDTURBINE", "WIND_TURBINES", "WINDMILL":
		return "WIND_TURBINE"
	case "MEASURING_MAST", "MET_MAST", "WIND_MEASURING_MAST":
		return "MAST"
	case "CHURCH", "CHURCH_TOWER", "BASILICA", "CATHEDRAL":
		return "TOWER"
	case "HIGH_VOLTAGE_LINE", "POWER_LINE", "CABLE":
		return "TRANSMISSION_LINE"
	}
	return up
}

// obstacleLit reads the lighting column ("LGT", "Day/Night", "Y").
func obstacleLit(s string) bool {
	up := strings.ToUpper(s)
	return strings.Contains(up, "LGT") || strings.Contains(up, "LIGHT") ||
		strings.Contains(up, "DAY") || strings.Contains(up, "NIGHT") ||
		strings.TrimSpace(up) == "Y" || strings.TrimSpace(up) == "YES"
}

// obstacleID builds a stable id from the locality and the raw printed
// coordinates (unique per obstacle, invariant across cycles while the
// obstacle stands).
func obstacleID(name, latS, lonS string) string {
	return slug(name) + "-" + strings.TrimRight(latS, "NS") + strings.TrimRight(lonS, "EW")
}
