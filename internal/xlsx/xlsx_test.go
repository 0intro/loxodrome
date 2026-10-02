package xlsx

import (
	"archive/zip"
	"bytes"
	"reflect"
	"testing"
)

// book zips the parts of a workbook.
func book(t *testing.T, parts map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, body := range parts {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

const (
	workbookXML = `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Change Record" sheetId="1" r:id="rId1"/><sheet name="ENR 5.4" sheetId="2" r:id="rId2"/></sheets>
</workbook>`
	relsXML = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet2.xml"/>
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`
	sharedXML = `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<si><t>Obstacle_identifier</t></si>
<si><r><t>Obstacle</t></r><r><rPr><b/></rPr><t>_type</t></r></si>
<si><t>Wind Farm</t></si>
</sst>`
	sheet1XML = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>Date</t></is></c></row>
</sheetData></worksheet>`
	// Row 1 leaves B empty; row 2 carries a number, a shared string and
	// a cell far to the right, past the columns row 1 had.
	sheet2XML = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>
<row r="2"><c r="A2" t="str"><v>EISN-0008</v></c><c r="B2"><v>332.3123</v></c><c r="C2" t="s"><v>2</v></c><c r="AB2"><v>1</v></c></row>
</sheetData></worksheet>`
)

func TestRows(t *testing.T) {
	w, err := Open(book(t, map[string]string{
		"xl/workbook.xml":            workbookXML,
		"xl/_rels/workbook.xml.rels": relsXML,
		"xl/sharedStrings.xml":       sharedXML,
		"xl/worksheets/sheet1.xml":   sheet1XML,
		"xl/worksheets/sheet2.xml":   sheet2XML,
	}))
	if err != nil {
		t.Fatal(err)
	}
	if got := w.SheetNames(); !reflect.DeepEqual(got, []string{"Change Record", "ENR 5.4"}) {
		t.Errorf("sheets = %q", got)
	}
	rows, err := w.Rows("ENR 5.4")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("rows = %d, want 2", len(rows))
	}
	if !reflect.DeepEqual(rows[0], []string{"Obstacle_identifier", "", "Obstacle_type"}) {
		t.Errorf("row 1 = %q: the rich text runs must join, the empty cell stay empty", rows[0])
	}
	r := rows[1]
	if len(r) != 28 || r[0] != "EISN-0008" || r[1] != "332.3123" || r[2] != "Wind Farm" || r[27] != "1" {
		t.Errorf("row 2 = %q", r)
	}
	// A relative target resolves against xl/.
	rows, err = w.Rows("Change Record")
	if err != nil || len(rows) != 1 || rows[0][0] != "Date" {
		t.Errorf("Change Record = %q, %v", rows, err)
	}
	if _, err := w.Rows("nope"); err == nil {
		t.Error("a missing sheet read")
	}
}

func TestNotAWorkbook(t *testing.T) {
	if _, err := Open([]byte("not a zip")); err == nil {
		t.Error("garbage opened")
	}
	if _, err := Open(book(t, map[string]string{"x": ""})); err == nil {
		t.Error("a zip with no workbook opened")
	}
}

func TestColumnIndex(t *testing.T) {
	for ref, want := range map[string]int{"A1": 0, "Z9": 25, "AA1": 26, "AB12": 27, "AD4": 29} {
		if got := columnIndex(ref); got != want {
			t.Errorf("columnIndex(%s) = %d, want %d", ref, got, want)
		}
	}
}
