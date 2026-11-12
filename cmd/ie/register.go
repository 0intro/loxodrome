// register.go reads one of the IAA's obstacle spreadsheets.
//
// Each workbook holds the register and its change record. The register is
// the eTOD attribute table, headed over three rows (two in the Safety
// Significant list, which drops the "Mandatory" / "Optional" one):
//
//	Obstacle_identifier | ... | Horizontal_position ...        | Elevation | Height | ... | Obstacle_type | ... | Lighting
//	Mandatory           | ... | Mandatory ...                  | Mandatory | Optional | ... | Mandatory   | ... | Mandatory
//	                    | ... | LAT_DMS | LONG_DMS | LAT_DD | LONG_DD | ING_E | ING_N | (ft) | (ft) | ...
//	EISN-0271           | ... | 52° 36' 47.27" N | ...  | 52.613131 | -8.157342 | ... | 1829 | 460 | ... | Wind Farm | ... | LI TYPE B RED
//
// which internal/obstable reads as it reads Fintraffic's CSV. What is the
// IAA's own is the vocabulary and the numbering, both below, and the
// change record, whose Edition column dates every amendment.

package main

import (
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/aixm5"
	"github.com/0intro/loxodrome/internal/obstable"
	"github.com/0intro/loxodrome/internal/xlsx"
)

// kinds maps the IAA's obstacle types onto the builder's codelist. The
// register writes them as free text, singular and plural and under the
// owner's name ("RTE Mast" is the national broadcaster's, "Towercom Mast"
// a mast operator's), and a Wind Farm row is one turbine of the farm. A
// type this table misses reaches the builder as it is written and lands
// in the meta's unknownTypes, the drift signal.
var kinds = map[string]string{
	"WIND FARM":     "WIND_TURBINE",
	"WIND FARMS":    "WIND_TURBINE",
	"WIND TURBINE":  "WIND_TURBINE",
	"WIND TURBINES": "WIND_TURBINE",
	"TURBINE":       "WIND_TURBINE",
	"TURBINES":      "WIND_TURBINE",
	"MAST":          "MAST",
	"MASTS":         "MAST",
	"MET MAST":      "MAST",
	"MET MASTS":     "MAST",
	"RTE MAST":      "MAST",
	"RTE MASTS":     "MAST",
	"TOWERCOM MAST": "MAST",
	"CHIMNEY":       "CHIMNEY",
	"CHIMNEYS":      "CHIMNEY",
	"TANK":          "TANK",
	"TANKS":         "TANK",
	"CONTROL TOWER": "CONTROL_TOWER",
	"SPIRE":         "SPIRE",
	"ANTENNA":       "ANTENNA",
	"OTHER":         "OTHER",
}

func kind(s string) string {
	if k, ok := kinds[strings.ToUpper(strings.Join(strings.Fields(s), " "))]; ok {
		return k
	}
	return strings.TrimSpace(s)
}

// cluster is the obstacle an identifier numbers a part of: a farm's
// turbines and met masts are "EISN-0271.001" to "EISN-0271.019" under the
// farm's "EISN-0271", whose own row is the farm's highest point (it
// repeats one of the turbines, EISN-0271.015 here, and states the farm's
// lighting). Every row of a farm is flagged as a group.
func cluster(id string) string {
	if i := strings.IndexByte(id, '.'); i > 0 {
		return id[:i]
	}
	return id
}

var spec = obstable.Spec{Kind: kind, Cluster: cluster}

// register is one workbook read.
type register struct {
	obstacles []aixm5.Obstacle
	stats     obstable.Stats
	// edition is the newest amendment the change record dates, zero when
	// the workbook carries none.
	edition time.Time
}

// readRegister reads a workbook: the register is the sheet whose headings
// the obstacle reader recognises, whatever it is called ("ENR 5.4",
// "Safety Significant Obstacles"), and the change record the one with an
// Edition column.
func readRegister(data []byte, name string) (*register, error) {
	w, err := xlsx.Open(data)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", name, err)
	}
	var reg register
	found := false
	for _, sheet := range w.SheetNames() {
		rows, err := w.Rows(sheet)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
		if ed, ok := newestEdition(rows); ok {
			reg.edition = ed
			continue
		}
		if found {
			continue
		}
		if _, err := obstable.Header(rows); err != nil {
			continue
		}
		if reg.obstacles, reg.stats, err = obstable.Read(rows, spec); err != nil {
			return nil, fmt.Errorf("%s, sheet %q: %w", name, sheet, err)
		}
		found = true
	}
	if !found {
		return nil, fmt.Errorf("%s: no sheet carries an obstacle register (sheets %q)", name, w.SheetNames())
	}
	return &reg, nil
}

// editionRe is a change record's edition, "06 AUG 2026".
var editionRe = regexp.MustCompile(`^\s*(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{4})\s*$`)

// newestEdition reads a change record, a sheet headed by an Edition
// column, for the newest edition it dates.
func newestEdition(rows [][]string) (time.Time, bool) {
	if len(rows) == 0 {
		return time.Time{}, false
	}
	col := -1
	for i, h := range rows[0] {
		if strings.EqualFold(strings.TrimSpace(h), "Edition") {
			col = i
		}
	}
	if col < 0 {
		return time.Time{}, false
	}
	var newest time.Time
	for _, r := range rows[1:] {
		if col >= len(r) {
			continue
		}
		m := editionRe.FindStringSubmatch(r[col])
		if m == nil {
			continue
		}
		mon, ok := months[strings.ToLower(m[2])]
		if !ok {
			continue
		}
		var d, y int
		if _, err := fmt.Sscanf(m[1]+" "+m[3], "%d %d", &d, &y); err != nil {
			continue
		}
		t := time.Date(y, mon, d, 0, 0, 0, 0, time.UTC)
		if t.Day() != d {
			continue
		}
		if t.After(newest) {
			newest = t
		}
	}
	return newest, true
}
