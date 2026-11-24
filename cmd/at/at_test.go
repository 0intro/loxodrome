package main

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

func fixedNow() time.Time { return time.Date(2026, 7, 20, 12, 0, 0, 0, time.UTC) }

func loadFixture(t *testing.T) []Placemark {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "luftraum.kml"))
	if err != nil {
		t.Fatal(err)
	}
	pms, err := ParseKML(data)
	if err != nil {
		t.Fatal(err)
	}
	return pms
}

func TestParseKMLFolders(t *testing.T) {
	pms := loadFixture(t)
	if len(pms) != 12 {
		t.Fatalf("placemarks = %d, want 12", len(pms))
	}
	byID := map[string][]Placemark{}
	for _, pm := range pms {
		byID[pm.ID] = append(byID[pm.ID], pm)
	}
	lor1 := byID["LOR1"][0]
	want := []string{"Lufträume_Österreich", "01_Zivile_Lufträume", "0101_Restricted_areas"}
	if len(lor1.Folder) != len(want) {
		t.Fatalf("LOR1 folder = %v, want %v", lor1.Folder, want)
	}
	for i, id := range want {
		if lor1.Folder[i] != id {
			t.Errorf("LOR1 folder[%d] = %q, want %q", i, lor1.Folder[i], id)
		}
	}
	if got := lor1.Field("Upper Limit"); got != "1500 FT AMSL" {
		t.Errorf("LOR1 upper = %q", got)
	}
	// The prism's floor and ceiling caps describe one footprint.
	if len(lor1.Rings) != 1 {
		t.Fatalf("LOR1 rings = %d, want 1", len(lor1.Rings))
	}
	if n := len(lor1.Rings[0]); n != 4 {
		t.Errorf("LOR1 ring vertices = %d, want 4 (open ring)", n)
	}
	if got := lor1.Rings[0][0]; got[0] != 47.97 || got[1] != 16.50 {
		t.Errorf("LOR1 first vertex = %v, want [47.97 16.50] in lat/lon order", got)
	}
}

func TestParseAirspaces(t *testing.T) {
	got := parseAirspaces(loadFixture(t))
	if got.placemarks != 5 {
		t.Fatalf("airspace placemarks = %d, want 5 (the surveillance minima stay out)", got.placemarks)
	}
	if len(got.unparsed) != 0 {
		t.Errorf("unparsed limits = %v, want none", got.unparsed)
	}

	by := map[string][]int{}
	for i, a := range got.airspaces {
		by[a.Designator] = append(by[a.Designator], i)
	}
	if _, ok := by["LOS901"]; ok {
		t.Error("LOS901 surveillance minimum sector was emitted")
	}

	r := got.airspaces[by["LOR1"][0]]
	if r.Type != "R" || r.Name != "SEIBERSDORF" {
		t.Errorf("LOR1 = %+v", r)
	}
	if r.LowerLimit.Value != "GND" {
		t.Errorf("LOR1 lower = %+v, want GND", r.LowerLimit)
	}
	if r.UpperLimit.Value != "1500" || r.UpperLimit.Unit != "FT" || r.UpperLimit.Ref != "MSL" {
		t.Errorf("LOR1 upper = %+v", r.UpperLimit)
	}

	// One class band per placemark, all under the sector designator.
	bands := by["LOWW6"]
	if len(bands) != 2 {
		t.Fatalf("LOWW6 rows = %d, want 2 class bands", len(bands))
	}
	classes := map[string]int{}
	for _, i := range bands {
		a := got.airspaces[i]
		classes[a.ClassCode] = i
		if a.Name != "LOWW 6" {
			t.Errorf("LOWW6 band name = %q, want %q", a.Name, "LOWW 6")
		}
		if a.Type != "TMA" {
			t.Errorf("LOWW6 band type = %q", a.Type)
		}
	}
	c, okC := classes["C"]
	e, okE := classes["E"]
	if !okC || !okE {
		t.Fatalf("LOWW6 classes = %v, want C and E", classes)
	}
	if u := got.airspaces[c].UpperLimit; u.Value != "245" || u.Unit != "FL" {
		t.Errorf("LOWW6/C upper = %+v, want FL 245", u)
	}
	// The bare "6500 FT" form is an altitude AMSL.
	if l := got.airspaces[c].LowerLimit; l.Value != "6500" || l.Ref != "MSL" {
		t.Errorf("LOWW6/C lower = %+v, want 6500 FT AMSL", l)
	}
	// The terrain-clearance floor keeps the altitude and states the
	// full rule as a remark.
	if l := got.airspaces[e].LowerLimit; l.Value != "3500" || l.Ref != "MSL" {
		t.Errorf("LOWW6/E lower = %+v, want 3500 FT AMSL", l)
	}
	if rmk := got.airspaces[e].Rmk; rmk != "3500 FT AMSL but at least 1000 FT AGL" {
		t.Errorf("LOWW6/E rmk = %q", rmk)
	}

	// Military and sporting vocabulary reaches the shared type mapper
	// with the kind preserved for the subtype column.
	mta := got.airspaces[by["LOTRAHSH"][0]]
	if mta.Type != "MTA" {
		t.Errorf("LOTRAHSH type = %q, want MTA", mta.Type)
	}
	if mta.UpperLimit.Unit != "FL" || mta.UpperLimit.Value != "265" {
		t.Errorf("LOTRAHSH upper = %+v", mta.UpperLimit)
	}
	if pg := got.airspaces[by["LOHPGACHE1"][0]]; pg.Type != "PARAGLIDER" {
		t.Errorf("LOHPGACHE1 type = %q, want PARAGLIDER", pg.Type)
	}
}

// TestParseAirspacesCeilingAtLeast reads a class band whose ceiling is
// published in the floor's combined form. ENR 2.1 prints TMA LOWI 2 [E]
// as "9000 FT AMSL / 7500 FT AMSL jedoch mindestens/but at least 1000 FT
// AGL", under a [D] band whose floor is "9000 FT AMSL but at least 1000
// FT AGL". Over terrain above 8000 ft that ceiling is the height, so the
// altitude alone would draw it low.
func TestParseAirspacesCeilingAtLeast(t *testing.T) {
	band := Placemark{
		ID:     "Luftraumklasse_E",
		Name:   "Luftraumklasse E",
		Folder: []string{"Lufträume_Österreich", "01_Zivile_Lufträume", "0103_Terminal_control_areas", "TMA_LOWI", "LOWI2"},
		Data: map[string]string{
			"IDENT":       "LOWI2",
			"Name":        "LOWI 2",
			"Upper Limit": "9000 FT AMSL but at least 1000 FT AGL",
			"Lower Limit": "7500 FT AMSL but at least 1000 FT AGL",
		},
		Rings: [][][2]float64{{{47.27, 10.79}, {47.30, 10.79}, {47.30, 10.88}}},
	}
	got := parseAirspaces([]Placemark{band})
	if len(got.airspaces) != 1 {
		t.Fatalf("rows = %d, want 1", len(got.airspaces))
	}
	a := got.airspaces[0]
	if a.UpperLimit != nil {
		t.Errorf("upper = %+v, want nil, read as unbounded", a.UpperLimit)
	}
	if l := a.LowerLimit; l == nil || l.Value != "7500" || l.Ref != "MSL" {
		t.Errorf("lower = %+v, want 7500 FT AMSL", l)
	}
	if want := "9000 FT AMSL but at least 1000 FT AGL; 7500 FT AMSL but at least 1000 FT AGL"; a.Rmk != want {
		t.Errorf("rmk = %q, want %q", a.Rmk, want)
	}
	if len(got.unparsed) != 0 {
		t.Errorf("unparsed limits = %v, want none", got.unparsed)
	}
	if got.ceilingsAtLeast != 1 {
		t.Errorf("ceilingsAtLeast = %d, want 1", got.ceilingsAtLeast)
	}
}

func TestParseLimit(t *testing.T) {
	cases := []struct {
		in               string
		ceiling          bool
		val, unit, ref   string
		note             string
		wantNilVerticals bool
	}{
		{in: "GND", val: "GND"},
		{in: "UNL", ceiling: true, val: "UNL"},
		{in: "FL 245", ceiling: true, val: "245", unit: "FL"},
		{in: "FL245", ceiling: true, val: "245", unit: "FL"},
		{in: "2500 FT AMSL", val: "2500", unit: "FT", ref: "MSL"},
		{in: "2500 FT AMSL", ceiling: true, val: "2500", unit: "FT", ref: "MSL"},
		{in: "1000 FT AGL", val: "1000", unit: "FT", ref: "SFC"},
		{in: "4500 FT", val: "4500", unit: "FT", ref: "MSL"},
		// A floor keeps the altitude, the lowest it can be.
		{
			in:  "3500 FT AMSL but at least 1000 FT AGL",
			val: "3500", unit: "FT", ref: "MSL",
			note: "3500 FT AMSL but at least 1000 FT AGL",
		},
		// A ceiling has no highest figure, so it is left unbounded.
		{
			in:               "9000 FT AMSL but at least 1000 FT AGL",
			ceiling:          true,
			note:             "9000 FT AMSL but at least 1000 FT AGL",
			wantNilVerticals: true,
		},
		{in: "", wantNilVerticals: true},
		{in: "SOMETHING ELSE", wantNilVerticals: true},
	}
	for _, c := range cases {
		got, note := parseLimit(c.in, c.ceiling)
		if note != c.note {
			t.Errorf("parseLimit(%q, %v) note = %q, want %q", c.in, c.ceiling, note, c.note)
		}
		if c.wantNilVerticals {
			if got != nil {
				t.Errorf("parseLimit(%q, %v) = %+v, want nil", c.in, c.ceiling, got)
			}
			continue
		}
		if got == nil {
			t.Errorf("parseLimit(%q, %v) = nil", c.in, c.ceiling)
			continue
		}
		if got.Value != c.val || got.Unit != c.unit || got.Ref != c.ref {
			t.Errorf("parseLimit(%q, %v) = %+v, want {%s %s %s}", c.in, c.ceiling, got, c.val, c.unit, c.ref)
		}
	}
}

func TestBuildAirports(t *testing.T) {
	artifact, meta, err := BuildAirports(loadFixture(t), "fixture", []byte("fixture"), "2026-07-09T00:00:00.000Z",
		AirportsOptions{Now: fixedNow, MinAirports: 1, MaxAirports: 10})
	if err != nil {
		t.Fatal(err)
	}
	if meta.AhpCount != 3 || meta.HeliportCount != 1 || meta.MilitaryCount != 1 {
		t.Fatalf("meta = %+v", meta)
	}
	rows := map[string][]any{}
	for _, r := range artifact.Rows {
		row := r.([]any)
		rows[row[0].(string)] = row
	}

	lowg := rows["LOWG"]
	// The ExtendedData elevation is metres for this aerodrome; the
	// description bubble states the feet the AIP publishes.
	if lowg[5] != 1120 {
		t.Errorf("LOWG elev_ft = %v, want 1120", lowg[5])
	}
	if lowg[1] != "large_airport" {
		t.Errorf("LOWG type = %v", lowg[1])
	}
	if lowg[6] != "AT" {
		t.Errorf("LOWG iso_country = %v", lowg[6])
	}
	if lowg[11] != false {
		t.Errorf("LOWG military = %v", lowg[11])
	}
	// Runways and radios stay with the OurAirports baseline, which the
	// merge keeps whenever the overlay row carries none.
	if got := lowg[9].([]any); len(got) != 0 {
		t.Errorf("LOWG runways = %v, want empty", got)
	}
	if got := lowg[15].([]any); len(got) != 0 {
		t.Errorf("LOWG frequencies = %v, want empty", got)
	}

	if rows["LOXZ"][11] != true {
		t.Error("LOXZ is a LOX-block aerodrome and should be military")
	}
	if rows["LOAE"][1] != "heliport" {
		t.Errorf("LOAE type = %v, want heliport", rows["LOAE"][1])
	}
	if rows["LOAE"][5] != nil {
		t.Errorf("LOAE elev_ft = %v, want nil", rows["LOAE"][5])
	}
}

// TestBuildAirportsElevationWithoutBubble reads an aerodrome whose bubble
// states no "Höhe (FT)". Its ExtendedData ELEVATION is metres for LOWZ
// (753.3 in the 2026-10-29 edition, against a 2471 ft bubble), so read as
// feet it would replace the OurAirports elevation with a third of it.
func TestBuildAirportsElevationWithoutBubble(t *testing.T) {
	lowz := Placemark{
		ID:     "LOWZ",
		Name:   "LOWZ",
		Folder: []string{"Lufträume_Österreich", "05_Airports"},
		Data: map[string]string{
			"CODE":      "LOWZ",
			"NAME":      "Zell am See",
			"ELEVATION": "753.3",
			"FREQUENCY": "119.705",
			"RWYLENGTH": "780",
		},
		Point: &[2]float64{47.291574178, 12.791019894},
	}
	artifact, meta, err := BuildAirports(append(loadFixture(t), lowz), "fixture", []byte("fixture"), "2026-10-29T00:00:00.000Z",
		AirportsOptions{Now: fixedNow, MinAirports: 1, MaxAirports: 10})
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range artifact.Rows {
		row := r.([]any)
		if row[0] == "LOWZ" && row[5] != nil {
			t.Errorf("LOWZ elev_ft = %v, want nil so the baseline elevation stands", row[5])
		}
	}
	// LOWG and LOXZ state their feet in the bubble.
	if meta.ElevCount != 2 || meta.ElevBubbleMissing != 1 {
		t.Errorf("elevCount = %d, elevBubbleMissing = %d, want 2 and 1", meta.ElevCount, meta.ElevBubbleMissing)
	}
}

func TestParseNavaids(t *testing.T) {
	navaids := parseNavaids(loadFixture(t))
	if len(navaids) != 3 {
		t.Fatalf("navaids = %d, want 3", len(navaids))
	}
	by := map[string]int{}
	for i, n := range navaids {
		by[n.Designator] = i
	}

	ndb := navaids[by["GBG"]]
	if ndb.Type != "NDB" || ndb.ID != "NDB-GBG" || ndb.Name != "Gleichenberg" {
		t.Errorf("GBG = %+v", ndb)
	}
	if ndb.FreqKHz == nil || *ndb.FreqKHz != 426 {
		t.Errorf("GBG freq = %v, want 426 kHz", ndb.FreqKHz)
	}
	if ndb.FreqMHz != nil {
		t.Errorf("GBG carries a MHz frequency: %v", *ndb.FreqMHz)
	}

	vor := navaids[by["FMD"]]
	if vor.Type != "VOR-DME" || vor.Channel != "41X" {
		t.Errorf("FMD = %+v", vor)
	}
	if vor.FreqMHz == nil || *vor.FreqMHz != 110.4 {
		t.Errorf("FMD freq = %v, want 110.4 MHz", vor.FreqMHz)
	}

	vrp := navaids[by["DT"]]
	if vrp.Type != "VFR_REPORTING_POINT" || vrp.Name != "DONAUTURM" {
		t.Errorf("DT = %+v", vrp)
	}
	// The aerodrome folder keeps the short code unique across fields.
	if vrp.ID != "VRP-LOWW-DT" {
		t.Errorf("DT id = %q, want VRP-LOWW-DT", vrp.ID)
	}
}

func TestKMLPayloadTakesFirstMemberOfKMZ(t *testing.T) {
	kml, err := os.ReadFile(filepath.Join("testdata", "luftraum.kml"))
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	// The published .kmz names its member after the cycle it was first
	// generated for, so the entry is taken by position.
	for _, name := range []string{"20230907LuftraumAT.kml", "files/legend.png"} {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write(kml); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}

	got, inner, err := KMLPayload("20260709LuftraumAT_2026-05-26_1105212.kmz", buf.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if inner != "20230907LuftraumAT.kml" {
		t.Errorf("inner name = %q", inner)
	}
	if !bytes.Equal(got, kml) {
		t.Error("payload does not match the archived KML")
	}
}

func TestNormaliseEffective(t *testing.T) {
	cases := map[string]string{
		"20260709":                 "2026-07-09T00:00:00.000Z",
		"2026-07-09":               "2026-07-09T00:00:00.000Z",
		"":                         "",
		"2026-07-09T00:00:00.000Z": "2026-07-09T00:00:00.000Z",
	}
	for in, want := range cases {
		if got := normaliseEffective(in); got != want {
			t.Errorf("normaliseEffective(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestSelectHrefs pins the current / next split against the real listing
// Austro Control served on 2026-08-16: three airspace editions, the middle
// one published as a bare .kml. Taking the newest alone put 2026-10-01 in
// the pre-release slot, skipped 2026-09-03 entirely, and left the in-force
// cycle to whatever an earlier run had written.
func TestSelectHrefs(t *testing.T) {
	page := `<a href="data/dokumente/20260709LuftraumAT_2026-05-26_1105212.kmz">KML</a>
	         <a href="data/dokumente/20260903LuftraumAT_2026-07-22_0807453.kml">KML</a>
	         <a href="data/dokumente/20261001LuftraumAT_2026-08-13_1308390.kmz">KML</a>`
	now := time.Date(2026, 8, 16, 12, 0, 0, 0, time.UTC)

	cur, next := selectHrefs(page, kmzHrefRe, now)
	if cur.stamp != "20260709" {
		t.Errorf("current stamp = %q, want the cycle in force", cur.stamp)
	}
	if cur.href != "data/dokumente/20260709LuftraumAT_2026-05-26_1105212.kmz" {
		t.Errorf("current href = %q", cur.href)
	}
	if next.stamp != "20260903" {
		t.Errorf("next stamp = %q, want the first cycle after today", next.stamp)
	}
	if next.href != "data/dokumente/20260903LuftraumAT_2026-07-22_0807453.kml" {
		t.Errorf("next href = %q, the .kml edition must be seen", next.href)
	}
	if got := isoFromStamp(cur.stamp); got != "2026-07-09T00:00:00.000Z" {
		t.Errorf("isoFromStamp = %q", got)
	}

	// Once 2026-09-03 is in force it becomes current and 2026-10-01 the
	// pre-release, with no code change.
	cur, next = selectHrefs(page, kmzHrefRe, time.Date(2026, 9, 3, 0, 0, 0, 0, time.UTC))
	if cur.stamp != "20260903" || next.stamp != "20261001" {
		t.Errorf("on the changeover: current = %q, next = %q", cur.stamp, next.stamp)
	}

	// The obstacle product lists one edition at a time, so there is no
	// pre-release to find.
	obsPage := `<a href="data/dokumente/LO_OBS_DS_AREA1_20260612_2026-06-01_1406590.zip">A</a>
	            <a href="data/dokumente/LO_OBS_DS_AREA1_20260710_2026-06-30_0706137.zip">B</a>`
	cur, next = selectHrefs(obsPage, obsHrefRe, now)
	if cur.stamp != "20260710" {
		t.Errorf("obstacle current stamp = %q", cur.stamp)
	}
	if next.href != "" {
		t.Errorf("obstacle next = %q, want none", next.href)
	}
}

// TestSelectHrefsAllFuture covers a product page that has only just
// started carrying a cycle: the oldest listed becomes current, so a run
// always has something to build rather than writing a pre-release alone.
func TestSelectHrefsAllFuture(t *testing.T) {
	page := `<a href="data/dokumente/20260903LuftraumAT_a.kml">A</a>
	         <a href="data/dokumente/20261001LuftraumAT_b.kmz">B</a>`
	cur, next := selectHrefs(page, kmzHrefRe, time.Date(2026, 8, 16, 12, 0, 0, 0, time.UTC))
	if cur.stamp != "20260903" || next.stamp != "20261001" {
		t.Errorf("current = %q, next = %q", cur.stamp, next.stamp)
	}
}

// TestSlotEditions pins which editions a run builds. The listing is the
// airspace page of 2026-11-13: the cycle in force, 2026-10-29, and the
// pre-release of 2026-12-24.
func TestSlotEditions(t *testing.T) {
	current := &download{name: "current", effective: "2026-10-29T00:00:00.000Z"}
	next := &download{name: "next", effective: "2026-12-24T00:00:00.000Z"}
	both := []*download{current, next}
	// Every listed cycle still ahead, the page TestSelectHrefsAllFuture
	// reads: selectHrefs files the oldest as current.
	sooner := &download{name: "sooner", effective: "2026-09-03T00:00:00.000Z"}
	later := &download{name: "later", effective: "2026-10-01T00:00:00.000Z"}
	ahead := []*download{sooner, later}
	now := time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC)
	before := time.Date(2026, 8, 16, 12, 0, 0, 0, time.UTC)

	cases := []struct {
		name     string
		editions []*download
		target   string
		override string
		now      time.Time
		want     []string
	}{
		{"auto builds both", both, "auto", "", now, []string{"current", "next"}},
		{"current names one slot", both, "current", "", now, []string{"current"}},
		{"next names one slot", both, "next", "", now, []string{"next"}},
		{"a lone edition under next is still built", []*download{current}, "next", "", now, []string{"current"}},
		{"nothing listed", nil, "auto", "", now, nil},
		// Both cycles ahead resolve to .next, and the soonest is the one
		// the app changes over to: the later one would overwrite it.
		{"two cycles ahead fill .next once", ahead, "auto", "", before, []string{"sooner"}},
		// -effective dates the one edition a -target names.
		{"-effective with current", both, "current", "2026-10-29T00:00:00.000Z", now, []string{"current"}},
		{"-effective with next", both, "next", "2026-12-24T00:00:00.000Z", now, []string{"next"}},
		{"-effective with one edition listed", []*download{current}, "auto", "2026-10-29T00:00:00.000Z", now, []string{"current"}},
	}
	for _, c := range cases {
		editions, err := slotEditions(c.editions, c.target, c.override, c.now)
		if err != nil {
			t.Errorf("%s: %v", c.name, err)
			continue
		}
		var got []string
		for _, d := range editions {
			got = append(got, d.name)
		}
		if !slices.Equal(got, c.want) {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}

	// Under auto, -effective would date both editions alike and send them
	// to one slot, the pre-release overwriting the cycle in force.
	if got, err := slotEditions(both, "auto", "2026-10-29T00:00:00.000Z", now); err == nil {
		t.Errorf("-effective under auto with two editions = %d editions, want an error", len(got))
	}
}
