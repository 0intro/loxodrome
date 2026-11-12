package main

import (
	"testing"
	"time"
)

// The AIXM half: two helipads with no ICAO location indicator (the shape 252
// of the SIA's 275 take, so their ident is their codeId) and one that has one
// AND an AD 2 section, to pin the merge.
const sampleHelAIXM = `<?xml version="1.0" encoding="UTF-8"?>
<AIXM-Snapshot effective="2026-08-06T00:00:00.000+02:00" version="4.5">
  <Ahp>
    <AhpUid mid="1"><codeId>LF075</codeId></AhpUid>
    <txtName>CRETEIL CENTRE HOSPITALIER HENRI MONDOR</txtName>
    <codeType>HP</codeType>
    <geoLat>484755.53N</geoLat><geoLong>0022712.54E</geoLong>
  </Ahp>
  <Ahp>
    <AhpUid mid="2"><codeId>LF999</codeId></AhpUid>
    <txtName>NOWHERE PAD</txtName>
    <codeType>HP</codeType>
    <geoLat>480000N</geoLat><geoLong>0020000E</geoLong>
  </Ahp>
  <Ahp>
    <AhpUid mid="3"><codeId>LFWD</codeId></AhpUid>
    <txtName>DREUX CENTRE HOSPITALIER</txtName>
    <codeIcao>LFWD</codeIcao>
    <codeType>HP</codeType>
    <geoLat>484336N</geoLat><geoLong>0012304E</geoLong>
    <txtDescrSite>A DREUX\\At DREUX</txtDescrSite>
  </Ahp>
</AIXM-Snapshot>`

// The proprietary half. LF999 has no <Helistation>, so it must stay absent;
// CRETEIL exercises the coded values, the reuse mapping and the '#'-separated
// remark; DREUX carries the "non défini" placeholders that must be dropped.
const sampleHelSIA = `<?xml version="1.0" encoding="UTF-8"?>
<SIA>
  <Helistation pk="75" lk="[LF][CRETEIL CENTRE HOSPITALIER HENRI MONDOR]">
    <Nom>CRETEIL CENTRE HOSPITALIER HENRI MONDOR</Nom>
    <Statut>TPD</Statut>
    <Nuit>oui</Nuit>
    <EnTerrasse>oui</EnTerrasse>
    <HorTxt>H24</HorTxt>
    <Sslia>OUI (6 extincteurs poudre de 50 kg)</Sslia>
    <Balisage>OUI (Feux verts peripheriques + projecteur)</Balisage>
    <Exploitant>Centre Hospitalier Henri Mondor - TEL : 01 45 17 95 50</Exploitant>
    <Remarque>Strictement reservee aux transports sanitaires.#Contact radio obligatoire avec MOULINEAUX Tour.</Remarque>
  </Helistation>
  <Helistation pk="41" lk="[LF][DREUX CENTRE HOSPITALIER]">
    <Nom>DREUX CENTRE HOSPITALIER</Nom>
    <Statut>RST</Statut>
    <ClassePerf>non définie</ClassePerf>
    <HelRef>non défini</HelRef>
    <Nuit>non</Nuit>
    <ZoneHabitee>hostile habitée</ZoneHabitee>
    <DimFato>Diamètre 20</DimFato>
    <Resistance>3.6 t</Resistance>
    <HorTxt>NIL</HorTxt>
  </Helistation>
  <Helistation pk="900" lk="[LF][UNKNOWN TO THE AIXM]">
    <Nom>UNKNOWN TO THE AIXM</Nom>
    <Statut>ADM</Statut>
    <Nuit>non</Nuit>
  </Helistation>
</SIA>`

func buildHelFixture(t *testing.T) (FacilitiesArtifact, FacilitiesMeta) {
	t.Helper()
	art, meta, err := BuildAerodromeFacilities([]byte(sampleHelAIXM), FacilitiesOptions{
		Source:        "sample.aixm.xml",
		SIASource:     []byte(sampleHelSIA),
		Now:           func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) },
		MinAerodromes: 1,
		MaxAerodromes: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	return art, meta
}

func helRow(t *testing.T, art FacilitiesArtifact, ident string) []any {
	t.Helper()
	for _, r := range art.Rows {
		row := r.([]any)
		if row[0].(string) == ident {
			return row
		}
	}
	t.Fatalf("no row for %s", ident)
	return nil
}

// items turns a serialised [cat, text] column into a lookup.
func items(t *testing.T, col any) map[string]string {
	t.Helper()
	out := map[string]string{}
	for _, e := range col.([]any) {
		p := e.([]string)
		out[p[0]] = p[1]
	}
	return out
}

func TestHelistationsFold(t *testing.T) {
	art, meta := buildHelFixture(t)

	// LF999 has no <Helistation> and no AD 2 content, so it is not a row;
	// the SIA record naming no AIXM helipad is skipped both ways.
	if meta.HeliportCount != 2 {
		t.Errorf("HeliportCount = %d, want 2 (LF999 and the unknown name skipped)", meta.HeliportCount)
	}
	idents := make([]string, 0, len(art.Rows))
	for _, r := range art.Rows {
		idents = append(idents, r.([]any)[0].(string))
	}
	if len(idents) != 2 || idents[0] != "LF075" || idents[1] != "LFWD" {
		t.Fatalf("idents = %v, want [LF075 LFWD]", idents)
	}

	// Créteil: the coded values stay codes, the free text is verbatim with
	// its '#' intact (the SPA renders the break), and the three reused
	// fields land in the AD 2 columns rather than the heliport one.
	c := helRow(t, art, "LF075")
	if c[3].(string) != "H24" {
		t.Errorf("hours = %q, want H24 (from HorTxt)", c[3])
	}
	svc := items(t, c[5])
	if svc["fire"] != "OUI (6 extincteurs poudre de 50 kg)" {
		t.Errorf("fire service = %q", svc["fire"])
	}
	if svc["lighting"] != "OUI (Feux verts peripheriques + projecteur)" {
		t.Errorf("lighting service = %q", svc["lighting"])
	}
	if got := items(t, c[7])["operator"]; got != "Centre Hospitalier Henri Mondor - TEL : 01 45 17 95 50" {
		t.Errorf("operator contact = %q", got)
	}
	hel := items(t, c[8])
	for _, w := range []struct{ cat, want string }{
		{"status", "TPD"}, {"night", "oui"}, {"terrace", "oui"},
	} {
		if hel[w.cat] != w.want {
			t.Errorf("heliport[%s] = %q, want %q", w.cat, hel[w.cat], w.want)
		}
	}
	if got := hel["remark"]; got != "Strictement reservee aux transports sanitaires.#Contact radio obligatoire avec MOULINEAUX Tour." {
		t.Errorf("remark = %q", got)
	}

	// Dreux: the "non défini" placeholders are dropped, NIL hours too, and
	// its AD 2 situation survives beside the helipad directory.
	d := helRow(t, art, "LFWD")
	if d[1].(string) == "" {
		t.Errorf("LFWD lost its AD 2 situation on the merge")
	}
	if d[3].(string) != "" {
		t.Errorf("hours = %q, want empty (HorTxt NIL)", d[3])
	}
	dh := items(t, d[8])
	if _, ok := dh["perfClass"]; ok {
		t.Errorf("perfClass survived: %q", dh["perfClass"])
	}
	if _, ok := dh["helRef"]; ok {
		t.Errorf("helRef survived: %q", dh["helRef"])
	}
	if dh["builtUp"] != "hostile habitée" {
		t.Errorf("builtUp = %q, want the coded value (not dropped by the non-défini rule)", dh["builtUp"])
	}
	if dh["fato"] != "Diamètre 20" || dh["strength"] != "3.6 t" {
		t.Errorf("fato/strength = %q / %q", dh["fato"], dh["strength"])
	}

	// Emission order is fixed, status first and the remark last.
	cats := make([]string, 0)
	for _, e := range c[8].([]any) {
		cats = append(cats, e.([]string)[0])
	}
	if cats[0] != "status" || cats[len(cats)-1] != "remark" {
		t.Errorf("heliport order = %v", cats)
	}
}

func TestBuildFacilitiesWithoutSIA(t *testing.T) {
	// The proprietary file is optional on the command line; without it the
	// dataset is the AD 2 half alone and no row carries a heliport column.
	art, meta, err := BuildAerodromeFacilities([]byte(sampleHelAIXM), FacilitiesOptions{
		Source:        "sample.aixm.xml",
		Now:           func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) },
		MinAerodromes: 1,
		MaxAerodromes: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	if meta.HeliportCount != 0 {
		t.Errorf("HeliportCount = %d, want 0", meta.HeliportCount)
	}
	if len(art.Rows) != 1 {
		t.Fatalf("rows = %d, want 1 (LFWD's AD 2 situation alone)", len(art.Rows))
	}
	if n := len(helRow(t, art, "LFWD")[8].([]any)); n != 0 {
		t.Errorf("heliport column = %d entries, want 0", n)
	}
}

func TestParseHelistations(t *testing.T) {
	hels, err := parseHelistations([]byte(sampleHelSIA))
	if err != nil {
		t.Fatal(err)
	}
	if len(hels) != 3 {
		t.Fatalf("parsed %d, want 3", len(hels))
	}
	if hels[0].Nom != "CRETEIL CENTRE HOSPITALIER HENRI MONDOR" || hels[0].Statut != "TPD" {
		t.Errorf("first record = %+v", hels[0])
	}
	got, err := parseHelistations(nil)
	if err != nil || got != nil {
		t.Errorf("parseHelistations(nil) = %v, %v; want nil, nil", got, err)
	}
}
