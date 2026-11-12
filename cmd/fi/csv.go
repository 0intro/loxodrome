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
	"archive/zip"
	"bytes"
	"fmt"
	"io"
	"path/filepath"
	"strings"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/aixm5"
	"github.com/0intro/loxodrome/internal/obstable"
)

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

// parseObstacles maps the table onto the shared obstacle shape, through
// the register reader cmd/ie shares: the headings, the placeholders
// ("NIL", "Unknown") and the three lighting columns read together are
// the ones this command has always read.
func parseObstacles(data []byte) ([]aixm5.Obstacle, obstable.Stats, error) {
	rows, err := obstable.CSV(data, ';')
	if err != nil {
		return nil, obstable.Stats{}, err
	}
	return obstable.Read(rows, obstable.Spec{})
}
