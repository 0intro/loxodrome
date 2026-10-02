// Package obstable reads an obstacle register published as a table, a
// CSV or a spreadsheet's sheet, into aixm5.Obstacle features, so the
// shared builder emits them like the AIXM publishers' (the same codelist,
// sanity window, bbox and unknown-type drift signal).
//
// The registers are the electronic obstacle data sets of ICAO Annex 15
// and PANS-AIM (Doc 10066, Appendix 8), and they carry the same
// attributes whatever the publisher, under headings each spells its own
// way:
//
//	Fintraffic   OBST ID;TYPE;COORD;LAT;LONG;HGT AGL (FT);ELEV MSL (FT);LGT COLOR;...
//	IAA          Obstacle_identifier | ... | Elevation | Height | ... | Obstacle_type | ... | Lighting
//	               ...                 LAT_DMS | LONG_DMS | LAT_DD | LONG_DD ...  (ft) | (ft)
//	ROMATSA      Obstacle identifier,...,Latitude,Longitude,...,Elevation,Height,...,Unit of measurement used,Lighting
//
// So the columns are found by their heading, from the table of spellings
// below, and a heading may run over several rows: the IAA writes the
// attribute on the first, "Mandatory" or "Optional" on the second, and
// the sub-heading naming the decimal columns and the unit on the third.
// A register adds its spellings to the table; a heading is matched
// whole, never as a prefix, because these tables carry a column of
// accuracies, confidence levels and resolutions beside every attribute
// ("Vertical accuracy (ft)").
//
// A position is read in decimal degrees or packed sexagesimal
// ("441039N 0282448E"). The heights are read in the unit a heading
// states, else in the one the row's own unit column states (the eTOD
// "Unit of measurement used", ROMATSA's "Feet" or "METER" row by row),
// and a table stating neither is refused: a register in the wrong unit
// would draw every obstacle three times too high or too low with nothing
// to show it. A row whose unit cannot be read is skipped and counted.
package obstable

import (
	"bytes"
	"encoding/csv"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/aixm5"
)

// Field is a register attribute this reader takes.
type Field int

// The fields, in the order a missing one is reported.
const (
	ID Field = iota
	Kind
	Lat
	Lon
	Height
	Elev
	Light
	Unit
	// HeightUnit and ElevUnit are a unit column given to one height alone
	// (PANSA's "Height Uom" and "Elevation Uom").
	HeightUnit
	ElevUnit
	numFields
)

var fieldNames = [numFields]string{"obstacle identifier", "obstacle type", "latitude", "longitude", "height", "elevation", "lighting", "unit of measurement", "height unit", "elevation unit"}

// required are the fields a table must carry: without any of them an
// obstacle cannot be placed, typed or given its height. Light is
// optional, an absent column reading unlit, and so is Unit, which only a
// table whose headings state no unit needs.
var required = []Field{ID, Kind, Lat, Lon, Height, Elev}

// headings are the spellings each field is published under, normalised
// by norm: upper case, underscores as spaces, a stated unit removed.
// Light takes every column it matches (Fintraffic splits the lighting
// over colour, type and hours); the others take the first.
var headings = [numFields][]string{
	ID:   {"OBST ID", "OBSTACLE IDENTIFIER", "OBSTACLE ID"},
	Kind: {"TYPE", "OBSTACLE TYPE"},
	// Where a register prints the position twice, the decimal columns
	// and never the sexagesimal ones beside them (Fintraffic's COORD, the
	// IAA's LAT_DMS): the decimal pair is both more precise and simpler
	// to read. ROMATSA prints it once, packed, under the plain names.
	Lat:    {"LAT", "LAT DD", "LATITUDE"},
	Lon:    {"LONG", "LON", "LONG DD", "LONGITUDE"},
	Height: {"HGT AGL", "HEIGHT"},
	Elev:   {"ELEV MSL", "ELEVATION"},
	Light:  {"LGT COLOR", "LGT TYPE", "LGT HR", "LIGHTING", "LIGHTED"},
	// ALBCONTROL gives the vertical distances' unit a column of its own
	// beside the geographical accuracy's, which is not it.
	Unit:       {"UNIT OF MEASUREMENT USED", "UNIT OF MEASUREMENT", "UNIT OF MEASUREMENT [VERTICAL DISTANCE]"},
	HeightUnit: {"HEIGHT UOM"},
	ElevUnit:   {"ELEVATION UOM"},
}

// maxHeaderRows bounds the heading search, so a table whose headings
// never complete fails rather than reading a data cell as one.
const maxHeaderRows = 10

// unitRe is a unit a heading states, as the heading's own suffix
// ("HGT AGL (FT)") or as a sub-heading cell of its own ("(ft)").
var unitRe = regexp.MustCompile(`(?i)\(\s*(ft|feet|m|metres?|meters?)\s*\)`)

// ftPerM converts the published feet to the metres the shared builder
// takes; it converts them back on the way out, so the emitted values are
// the publisher's own integers.
const ftPerM = 0.3048

// unit is how a height column's values are read.
type unit int

const (
	unitNone unit = iota
	unitFeet
	unitMetres
	// unitPerRow reads the row's own unit column.
	unitPerRow
)

// Spec carries what one register does its own way.
type Spec struct {
	// Kind maps a published obstacle kind onto the builder's codelist
	// ("Wind Farm" is WIND_TURBINE). Nil passes the text through, trimmed;
	// a kind nothing maps reaches the builder's unknownTypes either way.
	Kind func(string) string
	// Cluster names the cluster an identifier belongs to, "" for none.
	// Rows sharing a cluster are flagged Group, the styling of a wind
	// farm's turbines. Nil groups nothing.
	Cluster func(id string) string
}

// Stats counts what a read could not use, for the run's own report.
type Stats struct {
	// SkippedNoPosition counts rows with an identifier and no readable
	// position. An obstacle with no position cannot be drawn, and
	// dropping it silently is what this counter exists to prevent.
	SkippedNoPosition int
	// SkippedNoUnit counts rows whose own unit column had to be read and
	// could not be (ROMATSA's one row carrying a height there instead).
	SkippedNoUnit int
}

// Columns are the columns a table's headings name, -1 where absent.
type Columns struct {
	col   [numFields]int
	light []int
	// unit is each height column's unit.
	unit [numFields]unit
	// header is the index of the last heading row.
	header int
}

// Header finds a table's heading rows and the columns they name. Every
// required field must be named within the first maxHeaderRows rows, and
// both heights must state their unit, in a heading or in a unit column.
func Header(rows [][]string) (Columns, error) {
	var c Columns
	for f := range c.col {
		c.col[f] = -1
	}
	c.header = -1
	for r := 0; r < len(rows) && r < maxHeaderRows; r++ {
		for i, h := range rows[r] {
			n := norm(h)
			if n == "" {
				continue
			}
			for f := Field(0); f < numFields; f++ {
				if !matches(f, n) {
					continue
				}
				if f == Light {
					c.light = append(c.light, i)
				} else if c.col[f] < 0 {
					c.col[f] = i
				}
				break
			}
		}
		if c.complete() {
			c.header = r
			break
		}
	}
	for _, f := range required {
		if c.col[f] < 0 {
			return c, fmt.Errorf("no %s column in the header (source format may have changed)", fieldNames[f])
		}
	}
	for _, f := range []Field{Height, Elev} {
		for r := 0; r <= c.header && c.unit[f] == unitNone; r++ {
			if m := unitRe.FindStringSubmatch(cell(rows[r], c.col[f])); m != nil {
				c.unit[f] = parseUnit(m[1])
			}
		}
		if c.unit[f] == unitNone {
			if c.col[Unit] < 0 && c.col[ownUnit(f)] < 0 {
				return c, fmt.Errorf("no unit stated for the %s column", fieldNames[f])
			}
			c.unit[f] = unitPerRow
		}
	}
	return c, nil
}

// ownUnit is the unit column given to one height alone.
func ownUnit(f Field) Field {
	if f == Height {
		return HeightUnit
	}
	return ElevUnit
}

func (c *Columns) complete() bool {
	for _, f := range required {
		if c.col[f] < 0 {
			return false
		}
	}
	return true
}

func matches(f Field, n string) bool {
	for _, h := range headings[f] {
		if n == h {
			return true
		}
	}
	return false
}

// norm folds a heading for the spelling table.
func norm(h string) string {
	// The first heading of a CSV may carry a UTF-8 byte-order mark.
	h = strings.TrimPrefix(h, "\ufeff")
	h = unitRe.ReplaceAllString(h, " ")
	h = strings.ReplaceAll(h, "_", " ")
	return strings.ToUpper(strings.Join(strings.Fields(h), " "))
}

// parseUnit reads a unit, in a heading or a unit column; anything else,
// "ft/m" or "Metre/Feet" among them, is no unit.
func parseUnit(s string) unit {
	switch strings.ToUpper(strings.TrimSpace(s)) {
	case "FT", "FEET", "FOOT":
		return unitFeet
	case "M", "METRE", "METRES", "METER", "METERS":
		return unitMetres
	}
	return unitNone
}

// Read maps a register's rows, its headings included, onto the shared
// obstacle shape.
func Read(rows [][]string, spec Spec) ([]aixm5.Obstacle, Stats, error) {
	var st Stats
	cols, err := Header(rows)
	if err != nil {
		return nil, st, err
	}
	var out []aixm5.Obstacle
	for _, rec := range rows[cols.header+1:] {
		id := strings.TrimSpace(cell(rec, cols.col[ID]))
		if id == "" {
			continue
		}
		lat, latOK := coord(cell(rec, cols.col[Lat]), false)
		lon, lonOK := coord(cell(rec, cols.col[Lon]), true)
		if !latOK || !lonOK {
			st.SkippedNoPosition++
			continue
		}
		units := cols.unit
		skip := false
		for _, f := range []Field{Height, Elev} {
			if units[f] == unitPerRow {
				u := Unit
				if cols.col[ownUnit(f)] >= 0 {
					u = ownUnit(f)
				}
				units[f] = parseUnit(cell(rec, cols.col[u]))
				skip = skip || units[f] == unitNone
			}
		}
		if skip {
			st.SkippedNoUnit++
			continue
		}
		kind := strings.TrimSpace(cell(rec, cols.col[Kind]))
		if spec.Kind != nil {
			kind = spec.Kind(kind)
		}
		o := aixm5.Obstacle{
			ID:   id,
			Type: kind,
			// The registers publish no obstacle names, only ids and
			// types; inventing one from the id would be noise.
			Lat:     aip.Round5(lat),
			Lon:     aip.Round5(lon),
			Lighted: lighted(rec, cols.light),
		}
		o.HeightM = height(cell(rec, cols.col[Height]), units[Height])
		o.ElevM = height(cell(rec, cols.col[Elev]), units[Elev])
		out = append(out, o)
	}
	if spec.Cluster != nil {
		n := map[string]int{}
		for _, o := range out {
			if k := spec.Cluster(o.ID); k != "" {
				n[k]++
			}
		}
		for i := range out {
			if k := spec.Cluster(out[i].ID); k != "" && n[k] > 1 {
				out[i].Group = true
			}
		}
	}
	return out, st, nil
}

// coord reads a latitude or a longitude, in decimal degrees or packed
// sexagesimal. A packed longitude whose degrees are written in two digits
// ("265546.1821E", ROMATSA's aerodrome sets) is read as such: packed
// seconds are never one digit, so six integer digits can only be DDMMSS.
// The hemisphere may also come first and the three parts spaced, marked or
// not, as PANSA and ALBCONTROL print them (a preformatted block, which
// gofmt leaves verbatim: in prose it rewrites the two apostrophes of the
// seconds mark into a closing quote):
//
//	N 49 18 29.60
//	N 40° 59' 31.3645''
func coord(s string, lon bool) (float64, bool) {
	limit := 90.0
	if lon {
		limit = 180
	}
	if v, ok := parseFloat(s); ok {
		return v, v >= -limit && v <= limit
	}
	s = strings.TrimSpace(s)
	if m := spacedDMSRe.FindStringSubmatch(s); m != nil {
		hemi := m[1]
		if lon != (hemi == "E" || hemi == "W") {
			return 0, false
		}
		d, _ := strconv.ParseFloat(m[2], 64)
		mi, _ := strconv.ParseFloat(m[3], 64)
		se, _ := strconv.ParseFloat(strings.Replace(m[4], ",", ".", 1), 64)
		if mi >= 60 || se >= 60 {
			return 0, false
		}
		v := d + mi/60 + se/3600
		if hemi == "S" || hemi == "W" {
			v = -v
		}
		return v, v >= -limit && v <= limit
	}
	if !lon {
		return aip.ParseLat(s)
	}
	if v, ok := aip.ParseLon(s); ok {
		return v, true
	}
	if intDigits(s) == 6 {
		return aip.ParseLon("0" + s)
	}
	return 0, false
}

// spacedDMSRe is a position written hemisphere first, its degrees, minutes
// and seconds spaced and optionally marked.
var spacedDMSRe = regexp.MustCompile(`^([NSEW])\s*(\d{1,3})\s*°?\s+(\d{1,2})\s*['′]?\s+(\d{1,2}(?:[.,]\d+)?)\s*(?:''|"|″)?$`)

// intDigits counts the digits a packed coordinate opens with.
func intDigits(s string) int {
	n := 0
	for n < len(s) && s[n] >= '0' && s[n] <= '9' {
		n++
	}
	return n
}

// height reads a height cell in metres.
func height(s string, u unit) *float64 {
	v, ok := parseFloat(s)
	if !ok {
		return nil
	}
	if u == unitFeet {
		v *= ftPerM
	}
	return &v
}

// lighted reports whether the register states a light on this obstacle.
//
// Fintraffic's three lighting columns are read together rather than the
// colour alone, because they disagree: 131 rows carry "Unknown;NIL;NIL"
// and are unlit, while one carries "Unknown;NIL;H24" and is lit by an
// unrecorded colour. A light is published when ANY of them says
// something other than that there is none ("NO", ROMATSA's aerodrome
// sets).
func lighted(rec []string, cols []int) bool {
	for _, i := range cols {
		s := cell(rec, i)
		if stated(s) && !unlitRe.MatchString(s) {
			return true
		}
	}
	return false
}

// unlitRe is a lighting cell stating there is no light, ALBCONTROL's "N"
// among them.
var unlitRe = regexp.MustCompile(`(?i)^\s*(?:N|NO|NONE|UNLIT)\s*$`)

// stated reports whether a cell carries a value, as opposed to the two
// spellings the registers use for the absence of one.
func stated(s string) bool {
	s = strings.TrimSpace(s)
	return s != "" && !strings.EqualFold(s, "NIL") && !strings.EqualFold(s, "Unknown")
}

// parseFloat reads a numeric cell, treating the registers' own
// placeholders as absent.
func parseFloat(s string) (float64, bool) {
	s = strings.TrimSpace(s)
	if !stated(s) {
		return 0, false
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, false
	}
	return v, true
}

func cell(row []string, i int) string {
	if i < 0 || i >= len(row) {
		return ""
	}
	return row[i]
}

// CSV splits a register published as delimited text into its rows.
func CSV(data []byte, comma rune) ([][]string, error) {
	r := csv.NewReader(bytes.NewReader(data))
	r.Comma = comma
	// The publishers write no quoted fields; accepting a bare quote keeps
	// one appearing in a name from failing the whole refresh.
	r.LazyQuotes = true
	// FieldsPerRecord defaults to the first record's count, so a row that
	// gains or loses a column is an error rather than a silent misread.
	return r.ReadAll()
}
