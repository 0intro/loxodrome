// Package xlsx reads the cells of an Office Open XML workbook, which is a
// zip of XML parts: the workbook names its sheets, its relationships file
// says which part holds each, the shared-strings part holds the text the
// cells index, and each sheet part holds the cells. Enough to read the
// obstacle registers some States publish as spreadsheets (the Irish
// Aviation Authority's ENR 5.4 data set), with the standard library alone;
// formulas are read by their cached values, and styles, dates and
// comments are not interpreted.
package xlsx

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
	"path"
	"strconv"
	"strings"
)

// Workbook is an opened spreadsheet.
type Workbook struct {
	files  map[string]*zip.File
	sheets []sheetRef
	shared []string
}

type sheetRef struct{ name, part string }

// Open reads a workbook's structure from its bytes.
func Open(b []byte) (*Workbook, error) {
	zr, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		return nil, fmt.Errorf("xlsx: %w", err)
	}
	w := &Workbook{files: map[string]*zip.File{}}
	for _, f := range zr.File {
		w.files[f.Name] = f
	}
	var wb struct {
		Sheets []struct {
			Name string `xml:"name,attr"`
			RID  string `xml:"http://schemas.openxmlformats.org/officeDocument/2006/relationships id,attr"`
		} `xml:"sheets>sheet"`
	}
	if err := w.decode("xl/workbook.xml", &wb); err != nil {
		return nil, err
	}
	var rels struct {
		Rels []struct {
			ID     string `xml:"Id,attr"`
			Target string `xml:"Target,attr"`
		} `xml:"Relationship"`
	}
	if err := w.decode("xl/_rels/workbook.xml.rels", &rels); err != nil {
		return nil, err
	}
	target := map[string]string{}
	for _, r := range rels.Rels {
		t := r.Target
		if strings.HasPrefix(t, "/") {
			t = strings.TrimPrefix(t, "/")
		} else {
			t = path.Join("xl", t)
		}
		target[r.ID] = t
	}
	for _, s := range wb.Sheets {
		w.sheets = append(w.sheets, sheetRef{name: s.Name, part: target[s.RID]})
	}
	if _, ok := w.files["xl/sharedStrings.xml"]; ok {
		var sst struct {
			Items []struct {
				T string `xml:"t"`
				R []struct {
					T string `xml:"t"`
				} `xml:"r"`
			} `xml:"si"`
		}
		if err := w.decode("xl/sharedStrings.xml", &sst); err != nil {
			return nil, err
		}
		for _, it := range sst.Items {
			s := it.T
			for _, r := range it.R {
				s += r.T
			}
			w.shared = append(w.shared, s)
		}
	}
	return w, nil
}

// SheetNames lists the sheets in workbook order.
func (w *Workbook) SheetNames() []string {
	out := make([]string, len(w.sheets))
	for i, s := range w.sheets {
		out[i] = s.name
	}
	return out
}

// Rows returns a sheet's cells as text, row by row, each row as wide as
// its last cell, an absent cell "".
func (w *Workbook) Rows(name string) ([][]string, error) {
	part := ""
	for _, s := range w.sheets {
		if s.name == name {
			part = s.part
		}
	}
	if part == "" {
		return nil, fmt.Errorf("xlsx: no sheet %q", name)
	}
	var sheet struct {
		Rows []struct {
			Cells []struct {
				Ref    string `xml:"r,attr"`
				Type   string `xml:"t,attr"`
				Value  string `xml:"v"`
				Inline struct {
					T string `xml:"t"`
				} `xml:"is"`
			} `xml:"c"`
		} `xml:"sheetData>row"`
	}
	if err := w.decode(part, &sheet); err != nil {
		return nil, err
	}
	out := make([][]string, 0, len(sheet.Rows))
	for _, r := range sheet.Rows {
		var row []string
		for i, c := range r.Cells {
			col := i
			if c.Ref != "" {
				col = columnIndex(c.Ref)
			}
			for len(row) <= col {
				row = append(row, "")
			}
			switch c.Type {
			case "s":
				if n, err := strconv.Atoi(c.Value); err == nil && n >= 0 && n < len(w.shared) {
					row[col] = w.shared[n]
				}
			case "inlineStr":
				row[col] = c.Inline.T
			default:
				row[col] = c.Value
			}
		}
		out = append(out, row)
	}
	return out, nil
}

// columnIndex reads the column of a cell reference, "AB12" being 27.
func columnIndex(ref string) int {
	n := 0
	for _, r := range ref {
		if r < 'A' || r > 'Z' {
			break
		}
		n = n*26 + int(r-'A'+1)
	}
	return n - 1
}

func (w *Workbook) decode(name string, v any) error {
	f, ok := w.files[name]
	if !ok {
		return fmt.Errorf("xlsx: no part %s", name)
	}
	rc, err := f.Open()
	if err != nil {
		return fmt.Errorf("xlsx: %s: %w", name, err)
	}
	defer rc.Close()
	b, err := io.ReadAll(rc)
	if err != nil {
		return fmt.Errorf("xlsx: %s: %w", name, err)
	}
	if err := xml.Unmarshal(b, v); err != nil {
		return fmt.Errorf("xlsx: %s: %w", name, err)
	}
	return nil
}
