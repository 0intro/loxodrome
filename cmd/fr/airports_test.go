package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestBuildAirports exercises the AIXM-only airport pipeline against a
// fixture covering: a civilian aerodrome with full Rwy/Rdd/Rls/Ahu and a
// PERMIT GAT block (cap), a military aerodrome (STATE FlightClass, no GAT
// -> restricted), a civilian usage-restreint field (GAT with
// codeUsageLimitation=OTHER -> restricted), an ICAO-less hospital heliport
// and an ICAO-less decommissioned field (both kept, under their SIA codeId),
// and a fictive AFS pseudo-aerodrome (FIR/ACC centre, marked by
// txtDescrRefPt) that must be dropped despite having an ICAO + coords.
func TestBuildAirports(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("testdata", "airports", "aixm.xml"))
	if err != nil {
		t.Fatal(err)
	}
	fixedNow := func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) }
	art, meta, err := BuildAirports(src, AirportsOptions{
		Source:      "aixm.xml",
		Now:         fixedNow,
		MinAirports: 1,
		MaxAirports: 100,
	})
	if err != nil {
		t.Fatal(err)
	}

	// 5 real Ahps (3 ICAO'd + the 2 carrying a national code); only the
	// fictive LFFF (AFS pseudo-aerodrome) is dropped.
	if meta.AhpCount != 5 {
		t.Errorf("AhpCount = %d, want 5", meta.AhpCount)
	}
	if meta.NationalCodeCount != 2 {
		t.Errorf("NationalCodeCount = %d, want 2 (LF075, LF43)", meta.NationalCodeCount)
	}
	// LFPG has a PERMIT GAT block (cap); LFXM has only OAT, no GAT
	// (restricted, military); LFFG has an OTHER-only GAT block (restricted,
	// usage restreint).
	if got := meta.AccessCounts["cap"]; got != 1 {
		t.Errorf("AccessCounts[cap] = %d, want 1", got)
	}
	if got := meta.AccessCounts["restricted"]; got != 2 {
		t.Errorf("AccessCounts[restricted] = %d, want 2", got)
	}
	// LFXM is the only military aerodrome (STATE FlightClass).
	if meta.MilitaryCount != 1 {
		t.Errorf("MilitaryCount = %d, want 1", meta.MilitaryCount)
	}
	// LFPG: TWR + GND + ATIS kept, PAR curated out; LFFG: OTHER -> A/A. = 4 kept.
	if meta.RadioCount != 4 {
		t.Errorf("RadioCount = %d, want 4", meta.RadioCount)
	}
	// LFPG carries valTransitionAlt 5000 FT; LFXM's 0 placeholder is dropped.
	if meta.TransitionAltCount != 1 {
		t.Errorf("TransitionAltCount = %d, want 1", meta.TransitionAltCount)
	}
	// Effective date pulled from the AIXM-Snapshot root.
	if got, want := meta.Effective, "2026-05-14T00:00:00+02:00"; got != want {
		t.Errorf("Effective = %q, want %q", got, want)
	}

	// Schema shape.
	if len(art.Fields) != 17 || art.Fields[0] != "ident" || art.Fields[14] != "joint" || art.Fields[15] != "frequencies" || art.Fields[16] != "transition_alt_ft" {
		t.Errorf("airports fields shape mismatch: %v", art.Fields)
	}
	if len(art.RunwayFields) != 18 || art.RunwayFields[0] != "le" ||
		art.RunwayFields[14] != "le_lgt" || art.RunwayFields[16] != "le_pos" {
		t.Errorf("runway fields shape mismatch: %v", art.RunwayFields)
	}
	if len(art.FrequencyFields) != 3 || art.FrequencyFields[0] != "freq" {
		t.Errorf("frequency fields shape mismatch: %v", art.FrequencyFields)
	}

	// Sorted ident order: the two national codes, then the ICAO'd fields.
	idents := make([]string, 0, len(art.Rows))
	for _, r := range art.Rows {
		idents = append(idents, r.([]any)[0].(string))
	}
	want := []string{"LF075", "LF43", "LFFG", "LFPG", "LFXM"}
	for i, w := range want {
		if i >= len(idents) || idents[i] != w {
			t.Errorf("idents[%d] = %q, want %q (got %v)", i, idents[i], w, idents)
		}
	}

	// The two ICAO-less fields: the hospital helipad keeps its position and
	// elevation and types as a heliport, the LS row as closed. Neither has an
	// Ahu or an Sah, so access stays null and no frequency is invented (the
	// SPA's applyFrAutoInfoFrequency is aerodrome-scoped for the same reason).
	for _, r := range art.Rows {
		row := r.([]any)
		switch row[0].(string) {
		case "LF075":
			if row[1].(string) != "heliport" {
				t.Errorf("LF075 type = %q, want heliport", row[1])
			}
			if row[2].(string) != "CRETEIL CENTRE HOSPITALIER HENRI MONDOR" {
				t.Errorf("LF075 name = %q", row[2])
			}
			if row[3].(float64) != 48.79876 || row[4].(float64) != 2.45348 {
				t.Errorf("LF075 position = %v/%v, want 48.79876/2.45348", row[3], row[4])
			}
			if row[5].(any) != 160 {
				t.Errorf("LF075 elev_ft = %v, want 160", row[5])
			}
			if row[6].(string) != "FR" {
				t.Errorf("LF075 iso_country = %q, want FR", row[6])
			}
			if row[10] != nil {
				t.Errorf("LF075 access = %v, want nil (no Ahu published)", row[10])
			}
			if freqs := row[15].([]any); len(freqs) != 0 {
				t.Errorf("LF075 frequencies = %v, want none", freqs)
			}
		case "LF43":
			if row[1].(string) != "closed" {
				t.Errorf("LF43 type = %q, want closed (codeType LS)", row[1])
			}
		}
	}
	// The fictive AFS pseudo-aerodrome must not survive the filter.
	for _, id := range idents {
		if id == "LFFF" {
			t.Errorf("fictive AFS aerodrome LFFF should have been dropped, got %v", idents)
		}
	}

	// Spot-check the LFPG row: AIXM lat/lon round to 5 decimals,
	// runways length converted to feet (4200 m -> 13780 ft), Rls
	// presence on 09L marks the strip as lit.
	for _, r := range art.Rows {
		row := r.([]any)
		if row[0].(string) != "LFPG" {
			continue
		}
		if row[1].(string) != "large_airport" {
			t.Errorf("LFPG type = %q, want large_airport", row[1])
		}
		if row[10].(any) != "cap" {
			t.Errorf("LFPG access = %v, want cap", row[10])
		}
		if row[11].(bool) {
			t.Errorf("LFPG military = true, want false")
		}
		if !row[13].(bool) {
			t.Errorf("LFPG ifr = false, want true")
		}
		if row[14].(bool) {
			t.Errorf("LFPG joint = true, want false (civil cap)")
		}
		rws := row[9].([]any)
		if len(rws) != 1 {
			t.Errorf("LFPG runways = %d, want 1", len(rws))
		}
		rw := rws[0].([]any)
		if rw[5].(int) != 1 {
			t.Errorf("LFPG runway lit flag = %v, want 1", rw[5])
		}
		// AD 2.14 lighting: 09L (le) carries edge + threshold lines, PAPI and an
		// approach light system; 27R (he) has none.
		if rw[15] != nil {
			t.Errorf("LFPG 27R lighting = %v, want nil", rw[15])
		}
		lgt, ok := rw[14].(map[string]any)
		if !ok {
			t.Fatalf("LFPG 09L lighting type = %T, want map", rw[14])
		}
		lines := lgt["lines"].([]any)
		if len(lines) != 2 {
			t.Fatalf("09L light lines = %d, want 2 (edge, thr)", len(lines))
		}
		if edge := lines[0].([]string); edge[0] != "EDGE" || edge[1] != "WHI" || edge[2] != "LIH" {
			t.Errorf("09L edge line = %v", edge)
		}
		if papi := lgt["papi"].([]string); papi[0] != "PAPI" || papi[1] != "LEFT" {
			t.Errorf("09L papi = %v", lgt["papi"])
		}
		if als := lgt["als"].([]any); als[0].(string) != "A" || als[1].(int) != 900 {
			t.Errorf("09L als = %v", lgt["als"])
		}
		// Frequencies: TWR + ATIS + a ground position (SIA codeType TWR with a
		// "- SOL" call sign -> GND); PAR curated out, the 0 MHz stub dropped.
		freqs := row[15].([]any)
		if len(freqs) != 3 {
			t.Fatalf("LFPG frequencies = %d, want 3 (TWR, ATIS, GND; PAR dropped)", len(freqs))
		}
		hasGnd := false
		for _, f := range freqs {
			tr := f.([]any)
			if tr[1].(string) == "PAR" {
				t.Errorf("LFPG PAR frequency should have been curated out, got %v", tr)
			}
			if tr[0] == "121.700" {
				hasGnd = true
				if tr[1] != "GND" {
					t.Errorf("LFPG 121.700 = %v, want GND (SIA codeType TWR + SOL call sign)", tr)
				}
			}
		}
		if !hasGnd {
			t.Errorf("LFPG ground frequency 121.700 missing from %v", freqs)
		}
		if tr := freqs[0].([]any); tr[0] != "119.250" || tr[1] != "TWR" || tr[2] != "DE GAULLE TOUR" {
			t.Errorf("LFPG first frequency = %v, want [119.250 TWR DE GAULLE TOUR]", tr)
		}
		if ta, ok := row[16].(int); !ok || ta != 5000 {
			t.Errorf("LFPG transition_alt_ft = %v, want 5000", row[16])
		}
	}

	// LFXM publishes the 0 transition-altitude placeholder: dropped to nil.
	for _, r := range art.Rows {
		row := r.([]any)
		if row[0].(string) == "LFXM" && row[16] != nil {
			t.Errorf("LFXM transition_alt_ft = %v, want nil (0 placeholder dropped)", row[16])
		}
	}

	// LFFG is a civilian usage-restreint field: its OTHER-only GAT block
	// resolves to access=restricted, not military, VFR-only. Its "OTHER"
	// auto-information service must surface as A/A.
	for _, r := range art.Rows {
		row := r.([]any)
		if row[0].(string) != "LFFG" {
			continue
		}
		if row[10].(any) != "restricted" {
			t.Errorf("LFFG access = %v, want restricted (OTHER-only GAT)", row[10])
		}
		if row[11].(bool) {
			t.Errorf("LFFG military = true, want false")
		}
		if !row[12].(bool) {
			t.Errorf("LFFG vfr = false, want true")
		}
		if row[13].(bool) {
			t.Errorf("LFFG ifr = true, want false (VFR-only)")
		}
		freqs := row[15].([]any)
		if len(freqs) != 1 {
			t.Fatalf("LFFG frequencies = %d, want 1 (A/A)", len(freqs))
		}
		if tr := freqs[0].([]any); tr[0] != "123.500" || tr[1] != "A/A" || tr[2] != "LA FERTE" {
			t.Errorf("LFFG frequency = %v, want [123.500 A/A LA FERTE]", tr)
		}
	}
}

func TestRefineFrLabel(t *testing.T) {
	cases := []struct{ label, call, want string }{
		{"TWR", "LOGNES - SOL", "GND"},
		{"TWR", "DE GAULLE - SOL NORD", "GND"},
		{"TWR", "DE GAULLE - PREVOL", "DEL"},
		{"TWR", "GRENOBLE - TOUR", "TWR"},
		{"TWR", "DE GAULLE - TRAFIC", "TWR"},
		{"TWR", "LOGNES", "TWR"},         // bare field name, no sub-position
		{"ATIS", "LOGNES - SOL", "ATIS"}, // only TWR is refined
		{"APP", "MONTPELLIER - APPROCHE", "APP"},
	}
	for _, c := range cases {
		if got := refineFrLabel(c.label, c.call); got != c.want {
			t.Errorf("refineFrLabel(%q, %q) = %q, want %q", c.label, c.call, got, c.want)
		}
	}
}

func TestTidyCallSign(t *testing.T) {
	cases := []struct{ in, want string }{
		{"GRENOBLE - .", "GRENOBLE"},
		{"DE GAULLE - .", "DE GAULLE"},
		{"GRENOBLE - TOUR", "GRENOBLE - TOUR"},
		{"MONTPELLIER", "MONTPELLIER"},
		{"  PARIS - .  ", "PARIS"},
	}
	for _, c := range cases {
		if got := tidyCallSign(c.in); got != c.want {
			t.Errorf("tidyCallSign(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestCountryFromIcao(t *testing.T) {
	cases := []struct{ icao, want string }{
		{"LFPG", "FR"},
		{"FMEE", "RE"},
		{"NTAA", "PF"},
		// ICAO Doc 7910: NW = New Caledonia, NL = Wallis and Futuna
		// (NC is the Cook Islands, not French; falls to the default).
		{"NWWW", "NC"},
		{"NLWW", "WF"},
		{"SOCA", "GF"},
		{"X", ""}, // too short
	}
	for _, c := range cases {
		if got := countryFromIcao(c.icao); got != c.want {
			t.Errorf("countryFromIcao(%q) = %q, want %q", c.icao, got, c.want)
		}
	}
}

func TestReadAIXMEffective(t *testing.T) {
	xml := []byte(`<?xml version="1.0"?>` +
		`<AIXM-Snapshot created="2026-04-17T17:37:09.244+02:00" origin="Sia-France" version="4.5" effective="2026-06-11T00:00:00.000+02:00">` +
		`</AIXM-Snapshot>`)
	got, err := readAIXMEffective(xml)
	if err != nil {
		t.Fatalf("readAIXMEffective: %v", err)
	}
	if want := "2026-06-11T00:00:00.000+02:00"; got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestReadAIXMEffectiveMissing(t *testing.T) {
	xml := []byte(`<AIXM-Snapshot version="4.5"></AIXM-Snapshot>`)
	if _, err := readAIXMEffective(xml); err == nil {
		t.Errorf("expected error for missing effective attribute")
	}
}

// TestRunwayEnds pins the rule that decides which drawn end of a strip is
// which. The AIXM files several centreline points per runway and none of
// them says which threshold it is, so the designator settles it: "08" means
// the runway runs on about 080, and the end the axis points AWAY from is
// the 08 threshold.
func TestRunwayEnds(t *testing.T) {
	// LFPL 08R/26L, as the 2026-08-06 export files it: four points on the
	// axis, in no useful order, running west to east.
	pts := [][2]float64{
		{48.82034, 2.62822},
		{48.82034, 2.63284},
		{48.81903, 2.61803},
		{48.81958, 2.62469},
	}
	le, he := runwayEnds(pts, "08R")
	if le == nil || he == nil {
		t.Fatal("no ends")
	}
	// The two EXTREMES, and 08 to the west.
	if le[1] > he[1] {
		t.Errorf("08R end at %v is east of 26L at %v", le, he)
	}
	if le[1] != 2.61803 || he[1] != 2.63284 {
		t.Errorf("ends %v / %v, want the two extremes", le, he)
	}
	// The same strip named from the other direction swaps them.
	le2, he2 := runwayEnds(pts, "26L")
	if le2[1] != he[1] || he2[1] != le[1] {
		t.Errorf("naming the strip 26L gave %v / %v, want the pair reversed", le2, he2)
	}
	// A strip the AIXM files no points for, and one designator this reader
	// cannot read, both answer nothing rather than guessing.
	if a, b := runwayEnds(pts[:1], "08"); a != nil || b != nil {
		t.Error("one point is not two ends")
	}
	if a, b := runwayEnds(pts, "XX"); a != nil || b != nil {
		t.Error("an unreadable designator should place nothing")
	}
}

func TestLeadingDigits(t *testing.T) {
	for in, want := range map[string]int{
		"08": 8, "08R": 8, "26L": 26, "36": 36, "": -1, "R": -1, "99": -1, "0": -1,
	} {
		if got := leadingDigits(in); got != want {
			t.Errorf("leadingDigits(%q) = %d, want %d", in, got, want)
		}
	}
}
