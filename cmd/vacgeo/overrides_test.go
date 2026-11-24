package main

import (
	"bytes"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"rsc.io/pdf"
)

func TestLoadOverrides(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "overrides.tsv")
	body := "" +
		"# a comment, and the reason the entry exists\n" +
		"\n" +
		"LFxx\t2\t1\t0123456789ab\t50\t33\t400\t480\t48.7\t2.5\t48.9\t2.7\n"
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	ov, err := loadOverrides(path)
	if err != nil {
		t.Fatal(err)
	}
	o, ok := ov.lookup("lfxx", 2, 1)
	if !ok {
		t.Fatal("override not found (the ident should match case-insensitively)")
	}
	if o.sum != "0123456789ab" || o.at != path+":3" {
		t.Errorf("drawing %q at %s, want 0123456789ab at %s:3", o.sum, o.at, path)
	}
	// The two corners define the affine: the clip's own corners must come
	// back as the coordinates that were typed.
	f := o.fit
	lat, lon := f.Geo.at(f.Clip.x0, f.Clip.y0)
	if math.Abs(lat-48.7) > 1e-9 || math.Abs(lon-2.5) > 1e-9 {
		t.Errorf("SW corner %.6f,%.6f, want 48.7,2.5", lat, lon)
	}
	lat, lon = f.Geo.at(f.Clip.x1, f.Clip.y1)
	if math.Abs(lat-48.9) > 1e-9 || math.Abs(lon-2.7) > 1e-9 {
		t.Errorf("NE corner %.6f,%.6f, want 48.9,2.7", lat, lon)
	}
	if _, ok := ov.lookup("LFxx", 2, 2); ok {
		t.Error("an override answered for a page it does not address")
	}
}

func TestLoadOverridesRejectsMalformedLines(t *testing.T) {
	dir := t.TempDir()
	for name, body := range map[string]string{
		"short":      "LFxx\t2\t1\t0123456789ab\t50\t33\t400\n",
		"not-a-num":  "LFxx\t2\t1\t0123456789ab\t50\t33\t400\t480\t48.7\t2.5\t48.9\tEAST\n",
		"empty-clip": "LFxx\t2\t1\t0123456789ab\t50\t33\t50\t480\t48.7\t2.5\t48.9\t2.7\n",
		// A row with no drawing is a row that would hold on any page.
		"no-drawing":   "LFxx\t2\t1\t50\t33\t400\t480\t48.7\t2.5\t48.9\t2.7\n",
		"short-sum":    "LFxx\t2\t1\t0123456789\t50\t33\t400\t480\t48.7\t2.5\t48.9\t2.7\n",
		"not-hex":      "LFxx\t2\t1\t0123456789xy\t50\t33\t400\t480\t48.7\t2.5\t48.9\t2.7\n",
		"upper-case":   "LFxx\t2\t1\t0123456789AB\t50\t33\t400\t480\t48.7\t2.5\t48.9\t2.7\n",
		"drawing-last": "LFxx\t2\t1\t50\t33\t400\t480\t48.7\t2.5\t48.9\t2.7\t0123456789ab\n",
	} {
		path := filepath.Join(dir, name+".tsv")
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := loadOverrides(path); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// A missing file is not an error: the table is optional.
	if ov, err := loadOverrides(filepath.Join(dir, "absent.tsv")); err != nil || len(ov) != 0 {
		t.Errorf("a missing override table should read empty, got %v %v", ov, err)
	}
}

// overridePlate is a landing sheet with nothing the reader can place: its
// header names the chart and the aerodrome reference point, and that is
// all. The extra ink stands for an amendment to the drawing.
func overridePlate(t *testing.T, extra string) string {
	t.Helper()
	content := "BT /F1 10 Tf 1 0 0 1 30 560 Tm (AD 2 LFXX ATT 01) Tj ET\n" +
		"BT /F1 8 Tf 1 0 0 1 30 545 Tm (LAT : 48 49 19 N) Tj ET\n" +
		"BT /F1 8 Tf 1 0 0 1 30 535 Tm (LONG : 002 37 22 E) Tj ET\n" +
		"60 300 m 300 300 l S\n" + extra
	data := buildPDF(t, []string{
		"<</Type/Catalog /Pages 2 0 R>>",
		"<</Type/Pages /Kids [3 0 R] /Count 1>>",
		"<</Type/Page /Parent 2 0 R /MediaBox [0 0 400 600] /Resources 4 0 R /Contents 5 0 R>>",
		"<</Font <</F1 6 0 R>>>>",
		stream("", content),
		"<</Type/Font /Subtype/Type1 /BaseFont/Helvetica /Encoding/WinAnsiEncoding>>",
	})
	path := filepath.Join(t.TempDir(), "AD-2.LFXX.pdf")
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func newStats() stats {
	return stats{byKind: map[string]int{}, byReason: map[string]int{}, byMethod: map[string]int{},
		byAxes: map[string]int{}, ovSeen: map[overrideKey]bool{}}
}

// A row was measured on one drawing of its page. LFBO's helicopter sheet
// is kept by such a row, and the reader alone puts that panel 760 m north
// of itself: applied to a page the SIA has redrawn, the row would publish
// the old clip and corners over whatever the page now draws.
func TestOverrideHoldsOnlyOnItsDrawing(t *testing.T) {
	measured := overridePlate(t, "")
	data, err := os.ReadFile(measured)
	if err != nil {
		t.Fatal(err)
	}
	rd, err := pdf.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	c, err := walkPage(rd.Page(1))
	if err != nil {
		t.Fatal(err)
	}
	if len(c.sum) != sumDigits {
		t.Fatalf("drawing %q, want %d hex digits", c.sum, sumDigits)
	}
	fit := &panelFit{
		Clip:    box{x0: 50, y0: 100, x1: 350, y1: 500},
		Geo:     northUp(100, 48.80, 0.05/400, 50, 2.60, 0.05/300),
		PtPerNM: 400 / (0.05 * 60),
		Method:  "override",
	}
	key := overrideKey{ident: "LFXX", section: 2, page: 1}
	ov := overrides{key: {fit: fit, sum: c.sum, at: "overrides.tsv:7"}}

	st := newStats()
	got, err := readPlate(plate{ident: "LFXX", section: 2, path: measured}, nil, ov, &st)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].q.Src != "override" {
		t.Fatalf("on its own drawing the row placed %+v, want the one hand-placed panel", got)
	}
	if got[0].q.Drawing != c.sum {
		t.Errorf("the panel names drawing %q, want %q", got[0].q.Drawing, c.sum)
	}

	// The same page amended: one stroke more.
	st = newStats()
	redrawn := overridePlate(t, "60 320 m 300 320 l S\n")
	got, err = readPlate(plate{ident: "LFXX", section: 2, path: redrawn}, nil, ov, &st)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Errorf("on a redrawn page the row placed %+v, want nothing", got)
	}
	if n := st.byReason["override-stale"]; n != 1 {
		t.Errorf("override-stale %d, want 1", n)
	}
	if st.overridden != 0 || !st.ovSeen[key] {
		t.Errorf("overridden %d, seen %v: want 0 and the row marked as read", st.overridden, st.ovSeen[key])
	}
}

// A row whose page no run reached, a plate that lost the page or the
// atlas that lost the plate, is named rather than left to vanish.
func TestUnreadOverrides(t *testing.T) {
	ov := overrides{
		{ident: "LFBB", section: 2, page: 1}: {},
		{ident: "LFAA", section: 2, page: 3}: {},
		{ident: "LFAA", section: 2, page: 1}: {},
	}
	seen := map[overrideKey]bool{{ident: "LFAA", section: 2, page: 1}: true}
	all := func(string) bool { return true }
	want := []overrideKey{{ident: "LFAA", section: 2, page: 3}, {ident: "LFBB", section: 2, page: 1}}
	if got := ov.unread(seen, all); !reflect.DeepEqual(got, want) {
		t.Errorf("unread = %v, want %v", got, want)
	}
	// An -only run reads some idents and answers for those alone.
	onlyAA := func(id string) bool { return id == "LFAA" }
	want = []overrideKey{{ident: "LFAA", section: 2, page: 3}}
	if got := ov.unread(seen, onlyAA); !reflect.DeepEqual(got, want) {
		t.Errorf("unread under -only LFAA = %v, want %v", got, want)
	}
}
