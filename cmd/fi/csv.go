// csv.go reads the Area 1 obstacle table.
//
// The archive holds one semicolon-separated CSV with 28 columns, of
// which nine describe the obstacle and the rest its data quality
// (accuracy, confidence, resolution, integrity), which this app does not
// model:
//
//	OBST ID;TYPE;COORD;LAT;LONG;HGT AGL (FT);ELEV MSL (FT);LGT COLOR;
//	LGT TYPE;LGT INTST;LGT HR;MARKINGS;Area of coverage;...
//
//	EFINOB 10031;Mast;615550.99N 254354.33E;61.9308305888;25.7317584521;
//	355;983;R;F;NIL;HN;Y;...
//
// Rows are mapped onto aixm5.Obstacle so the shared builder emits them,
// which is what keeps Finland's file identical in shape to the eight
// AIXM ones: the same codelist, the same sanity window, the same bbox
// and the same unknown-type drift signal.
//
// Two columns are deliberately not carried. MARKINGS has no counterpart
// in the row schema and no consumer in the app, so importing it would be
// a schema change wearing a data change's clothes. COORD is the same
// position as LAT / LONG in sexagesimal, and the decimal pair is both
// more precise and simpler to read.

package main

import (
	"bytes"
	"encoding/csv"
	"fmt"
	"io"
	"strconv"
	"strings"

	"archive/zip"
	"path/filepath"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/aixm5"
)

// ftPerM converts the published feet to the metres the shared builder
// takes; it converts them back on the way out, so the emitted values are
// the publisher's own integers.
const ftPerM = 0.3048

// parseStats counts what a run could not use, for the run's own report.
type parseStats struct {
	// SkippedNoPosition counts rows whose LAT / LONG did not parse. An
	// obstacle with no position cannot be drawn, and dropping it silently
	// is what this counter exists to prevent.
	SkippedNoPosition int
}

// readCSV returns the obstacle table out of a downloaded archive, or the
// bytes themselves when the input is already a bare CSV.
func readCSV(data []byte, name string) ([]byte, string, error) {
	if strings.EqualFold(filepath.Ext(name), ".csv") {
		return data, name, nil
	}
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, "", fmt.Errorf("open zip %s: %w", name, err)
	}
	var pick *zip.File
	for _, f := range zr.File {
		if !strings.EqualFold(filepath.Ext(f.Name), ".csv") {
			continue
		}
		if pick == nil || f.UncompressedSize64 > pick.UncompressedSize64 {
			pick = f
		}
	}
	if pick == nil {
		return nil, "", fmt.Errorf("zip %s has no .csv entries", name)
	}
	if pick.UncompressedSize64 > aip.MaxMemberSize {
		return nil, "", fmt.Errorf("member %s declares %d bytes, exceeds %d limit",
			pick.Name, pick.UncompressedSize64, aip.MaxMemberSize)
	}
	fr, err := pick.Open()
	if err != nil {
		return nil, "", fmt.Errorf("open %s in zip: %w", pick.Name, err)
	}
	defer func() {
		_ = fr.Close()
	}()
	out, err := io.ReadAll(io.LimitReader(fr, aip.MaxMemberSize+1))
	if err != nil {
		return nil, "", fmt.Errorf("read %s in zip: %w", pick.Name, err)
	}
	return out, filepath.Base(pick.Name), nil
}

// obstacleCols are the columns read, by their published heading. Reading
// the header rather than fixed positions costs nothing and survives the
// publisher inserting one of its many quality columns.
type obstacleCols struct{ id, kind, lat, lon, hgt, elev, lgtColor, lgtType, lgtHr int }

// parseObstacles maps the table onto the shared obstacle shape.
func parseObstacles(data []byte) ([]aixm5.Obstacle, parseStats, error) {
	var st parseStats
	r := csv.NewReader(bytes.NewReader(data))
	r.Comma = ';'
	// The publisher writes no quoted fields; accepting a bare quote keeps
	// one appearing in a name from failing the whole refresh.
	r.LazyQuotes = true
	// FieldsPerRecord defaults to the first record's count, so a row that
	// gains or loses a column is an error rather than a silent misread.

	head, err := r.Read()
	if err != nil {
		return nil, st, fmt.Errorf("read header: %w", err)
	}
	cols, err := headerCols(head)
	if err != nil {
		return nil, st, err
	}

	var out []aixm5.Obstacle
	for {
		rec, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, st, err
		}
		id := strings.TrimSpace(rec[cols.id])
		if id == "" {
			continue
		}
		lat, latOK := parseFloat(rec[cols.lat])
		lon, lonOK := parseFloat(rec[cols.lon])
		if !latOK || !lonOK {
			st.SkippedNoPosition++
			continue
		}
		o := aixm5.Obstacle{
			ID:   id,
			Type: strings.TrimSpace(rec[cols.kind]),
			// The register publishes no obstacle names, only ids and
			// types; inventing one from the id would be noise.
			Lat:     aip.Round5(lat),
			Lon:     aip.Round5(lon),
			Lighted: lighted(rec, cols),
		}
		if ft, ok := parseFloat(rec[cols.hgt]); ok {
			m := ft * ftPerM
			o.HeightM = &m
		}
		if ft, ok := parseFloat(rec[cols.elev]); ok {
			m := ft * ftPerM
			o.ElevM = &m
		}
		out = append(out, o)
	}
	return out, st, nil
}

// headerCols locates the read columns by heading.
func headerCols(head []string) (obstacleCols, error) {
	cols := obstacleCols{id: -1, kind: -1, lat: -1, lon: -1, hgt: -1, elev: -1, lgtColor: -1, lgtType: -1, lgtHr: -1}
	for i, h := range head {
		// The first heading may carry a UTF-8 byte-order mark.
		h = strings.ToUpper(strings.TrimSpace(strings.TrimPrefix(h, "\ufeff")))
		switch {
		case cols.id < 0 && h == "OBST ID":
			cols.id = i
		case cols.kind < 0 && h == "TYPE":
			cols.kind = i
		case cols.lat < 0 && h == "LAT":
			cols.lat = i
		// LONG must not match "Horizontal ..." or the COORD column; the
		// exact heading is the safest test for a table this wide.
		case cols.lon < 0 && (h == "LONG" || h == "LON"):
			cols.lon = i
		case cols.hgt < 0 && strings.HasPrefix(h, "HGT AGL"):
			cols.hgt = i
		case cols.elev < 0 && strings.HasPrefix(h, "ELEV MSL"):
			cols.elev = i
		case cols.lgtColor < 0 && h == "LGT COLOR":
			cols.lgtColor = i
		case cols.lgtType < 0 && h == "LGT TYPE":
			cols.lgtType = i
		case cols.lgtHr < 0 && h == "LGT HR":
			cols.lgtHr = i
		}
	}
	for _, m := range []struct {
		i    int
		name string
	}{
		{cols.id, "OBST ID"}, {cols.kind, "TYPE"}, {cols.lat, "LAT"},
		{cols.lon, "LONG"}, {cols.hgt, "HGT AGL (FT)"}, {cols.elev, "ELEV MSL (FT)"},
	} {
		if m.i < 0 {
			return cols, fmt.Errorf("no %q column in the header (source format may have changed)", m.name)
		}
	}
	return cols, nil
}

// lighted reports whether the register states a light on this obstacle.
//
// The three lighting columns are read together rather than the colour
// alone, because they disagree: 131 rows carry "Unknown;NIL;NIL" and are
// unlit, while one carries "Unknown;NIL;H24" and is lit by an
// unrecorded colour. A light is published when ANY of the three says
// something.
func lighted(rec []string, cols obstacleCols) bool {
	for _, i := range []int{cols.lgtColor, cols.lgtType, cols.lgtHr} {
		if i < 0 || i >= len(rec) {
			continue
		}
		if stated(rec[i]) {
			return true
		}
	}
	return false
}

// stated reports whether a cell carries a value, as opposed to the two
// spellings the register uses for the absence of one.
func stated(s string) bool {
	s = strings.TrimSpace(s)
	return s != "" && !strings.EqualFold(s, "NIL") && !strings.EqualFold(s, "Unknown")
}

// parseFloat reads a numeric cell, treating the register's own
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
