package main

import (
	"testing"
	"time"
)

// A minimal AIXM 4.5 fixture: one real aerodrome (LFXX) with situation / ARP /
// hours and a spread of Ahs / Pfy / Aha, a fictive-AFS Ahp that must be
// skipped, a FIRE service that contributes only its RFFS category, a NIL
// service that must be dropped, and an Ase that must be ignored.
const sampleFacilitiesAIXM = `<?xml version="1.0" encoding="UTF-8"?>
<AIXM-Snapshot effective="2026-05-14T00:00:00.000+02:00" version="4.5">
  <Ahp>
    <AhpUid mid="1"><codeId>LFXX</codeId></AhpUid>
    <txtName>TESTVILLE</txtName>
    <codeIcao>LFXX</codeIcao>
    <codeType>AD</codeType>
    <txtDescrRefPt>Centre RWY 07/25\\RWY centre 07/25</txtDescrRefPt>
    <geoLat>480000N</geoLat>
    <geoLong>0020000E</geoLong>
    <txtDescrSite>2 km N de TESTVILLE\\2 km N of TESTVILLE</txtDescrSite>
    <Aht><codeWorkHr>OTHER</codeWorkHr><txtRmkWorkHr>HOR ATS\\ATS HOR</txtRmkWorkHr></Aht>
  </Ahp>
  <Ahp>
    <AhpUid mid="2"><codeId>LFYY</codeId></AhpUid>
    <codeIcao>LFYY</codeIcao>
    <txtDescrRefPt>Fictive airport only used for AFS addressing</txtDescrRefPt>
    <geoLat>480000N</geoLat>
    <geoLong>0300000W</geoLong>
  </Ahp>
  <Ahs>
    <AhsUid mid="10"><AhpUid mid="1"><codeId>LFXX</codeId></AhpUid><codeType>FUEL</codeType></AhsUid>
    <txtDescrFac>Carburant 100 LL\\Fuel 100 LL</txtDescrFac>
    <Ast><codeWorkHr>HX</codeWorkHr><txtRmkWorkHr>ETE : 0700-1000.\\SUM : 0700-1000.</txtRmkWorkHr></Ast>
    <txtRmk>1 cuve de 30 m3.</txtRmk>
  </Ahs>
  <Ahs>
    <AhsUid mid="11"><AhpUid mid="1"><codeId>LFXX</codeId></AhpUid><codeType>FIRE</codeType></AhsUid>
    <codeCat>A7</codeCat><codeCatReference>ICAO</codeCatReference>
  </Ahs>
  <Ahs>
    <AhsUid mid="12"><AhpUid mid="1"><codeId>LFXX</codeId></AhpUid><codeType>SECUR</codeType></AhsUid>
    <Ast><codeWorkHr>OTHER</codeWorkHr><txtRmkWorkHr>Assurée.\\Provided.</txtRmkWorkHr></Ast>
  </Ahs>
  <Ahs>
    <AhsUid mid="13"><AhpUid mid="1"><codeId>LFXX</codeId></AhpUid><codeType>REPAIR</codeType></AhsUid>
    <txtDescrFac>NIL</txtDescrFac>
  </Ahs>
  <Pfy>
    <PfyUid mid="20"><AhpUid mid="1"><codeId>LFXX</codeId></AhpUid><codeType>REST</codeType><noSeq>1</noSeq></PfyUid>
    <txtDescr>Sur AD.\\At the AD.</txtDescr>
  </Pfy>
  <Aha>
    <AhaUid mid="30"><AhpUid mid="1"><codeId>LFXX</codeId></AhpUid><codeType>PHONE</codeType><noSeq>1</noSeq></AhaUid>
    <txtAddress>+33 1 23 45 67 89</txtAddress>
  </Aha>
  <Ase><AseUid mid="99"><codeType>TMA</codeType><codeId>X</codeId></AseUid><txtName>IGNORE</txtName></Ase>
</AIXM-Snapshot>`

func TestBuildAerodromeFacilities(t *testing.T) {
	art, meta, err := BuildAerodromeFacilities([]byte(sampleFacilitiesAIXM), FacilitiesOptions{
		Source:        "sample.aixm.xml",
		Now:           func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) },
		MinAerodromes: 1,
		MaxAerodromes: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	if meta.Effective != "2026-05-14T00:00:00.000+02:00" {
		t.Errorf("effective = %q", meta.Effective)
	}
	// Only LFXX; the fictive-AFS LFYY is skipped.
	if meta.AerodromeCount != 1 {
		t.Fatalf("aerodromeCount = %d, want 1 (LFYY fictive skipped)", meta.AerodromeCount)
	}
	if len(art.Fields) != 10 || art.Fields[0] != "ident" || art.Fields[4] != "fireCat" ||
		art.Fields[5] != "services" || art.Fields[8] != "directory" || art.Fields[9] != "fuel" {
		t.Fatalf("fields shape mismatch: %v", art.Fields)
	}

	row := art.Rows[0].([]any)
	if row[0] != "LFXX" {
		t.Errorf("ident = %v", row[0])
	}
	// Bilingual header strings emitted verbatim (the SPA splits the "\\").
	if row[1] != `2 km N de TESTVILLE\\2 km N of TESTVILLE` {
		t.Errorf("site = %q", row[1])
	}
	if row[2] != `Centre RWY 07/25\\RWY centre 07/25` {
		t.Errorf("arp = %q", row[2])
	}
	if row[3] != `HOR ATS\\ATS HOR` {
		t.Errorf("hours = %q", row[3])
	}
	// A7 -> aeroplane category "7"; FIRE contributes no service item (no text).
	if row[4] != "7" {
		t.Errorf("fireCat = %q, want 7", row[4])
	}

	services := row[5].([]any)
	if len(services) != 2 {
		t.Fatalf("services len = %d, want 2 (fuel + security; fire has no text, repair NIL dropped)", len(services))
	}
	fuel := services[0].([]string)
	if fuel[0] != "fuel" || fuel[1] != `Carburant 100 LL\\Fuel 100 LL` {
		t.Errorf("services[0] = %v", fuel)
	}
	if sec := services[1].([]string); sec[0] != "security" || sec[1] != `Assurée.\\Provided.` {
		t.Errorf("services[1] = %v", sec)
	}

	// The services item keeps the first surviving field, unchanged. The
	// fuel column keeps all three, joined per language, which is what
	// cmd/fuel reads: the grades, the hours and the tank capacity are in
	// three different fields and which one holds the grades varies by
	// aerodrome.
	fuelCol, ok := row[9].([]string)
	if !ok || len(fuelCol) != 2 {
		t.Fatalf("fuel column = %#v, want a [avail, text] pair", row[9])
	}
	if fuelCol[0] != "yes" {
		t.Errorf("fuel avail = %q, want yes", fuelCol[0])
	}
	if want := `Carburant 100 LL#ETE : 0700-1000.#1 cuve de 30 m3.\\Fuel 100 LL#SUM : 0700-1000.#1 cuve de 30 m3.`; fuelCol[1] != want {
		t.Errorf("fuel text\n got %s\nwant %s", fuelCol[1], want)
	}

	passenger := row[6].([]any)
	if len(passenger) != 1 {
		t.Fatalf("passenger len = %d, want 1", len(passenger))
	}
	if rest := passenger[0].([]string); rest[0] != "restaurant" || rest[1] != `Sur AD.\\At the AD.` {
		t.Errorf("passenger[0] = %v", rest)
	}

	contact := row[7].([]any)
	if len(contact) != 1 {
		t.Fatalf("contact len = %d, want 1", len(contact))
	}
	if ph := contact[0].([]string); ph[0] != "phone" || ph[1] != "+33 1 23 45 67 89" {
		t.Errorf("contact[0] = %v", ph)
	}

	if meta.Counts["fuel"] != 1 || meta.Counts["security"] != 1 || meta.Counts["restaurant"] != 1 || meta.Counts["phone"] != 1 {
		t.Errorf("counts = %v", meta.Counts)
	}
}

func TestNormFireCat(t *testing.T) {
	cases := map[string]string{"A7": "7", "A10": "10", "H1": "H1", "": "", " A1 ": "1"}
	for in, want := range cases {
		if got := normFireCat(in); got != want {
			t.Errorf("normFireCat(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestKeepText(t *testing.T) {
	drop := []string{"", "NIL", "NIL.", "nil", "NONE", " NÉANT ", "Néant."}
	for _, s := range drop {
		if keepText(s) != "" {
			t.Errorf("keepText(%q) should drop", s)
		}
	}
	if keepText(`Carburant\\Fuel`) != `Carburant\\Fuel` {
		t.Error("keepText should preserve a real bilingual value verbatim")
	}
	// "NIL" as part of a larger value is kept (e.g. oil grades NIL among fuel).
	if got := keepText("100 LL, JET A1#Oil: NIL"); got != "100 LL, JET A1#Oil: NIL" {
		t.Errorf("keepText partial-NIL = %q", got)
	}
}

// The AD 2.4 fuel entry is joined PER LANGUAGE, because each of the record's
// three fields is bilingual on its own: concatenating them raw would leave a
// French half between two English ones, and formatAipRemark splits on the
// first separator alone.
func TestFuelColumn(t *testing.T) {
	got := fuelColumn(`Carburant : 100 LL\\Fuel : 100 LL`, `ETE : 0700-1000.\\SUM : 0700-1000.`, "")
	if got == nil || got.avail != "yes" {
		t.Fatalf("entry = %+v", got)
	}
	if want := `Carburant : 100 LL#ETE : 0700-1000.\\Fuel : 100 LL#SUM : 0700-1000.`; got.text != want {
		t.Errorf("text\n got %s\nwant %s", got.text, want)
	}

	// A monolingual field joins both halves, since that is how the app
	// already shows one: the same words in either locale.
	got = fuelColumn("100 LL", "", "1 cuve de 30 m3.")
	if got.text != "100 LL#1 cuve de 30 m3." {
		t.Errorf("monolingual text = %q", got.text)
	}

	// Every field NIL: the AIP stating the field is dry, which the services
	// list drops as an absent facility and this column keeps.
	if got = fuelColumn("NIL", "NIL.", ""); got == nil || got.avail != "no" || got.text != "" {
		t.Errorf("all-NIL entry = %+v", got)
	}
	// No record at all is not a statement about anything.
	if got = fuelColumn("", "  ", ""); got != nil {
		t.Errorf("empty entry = %+v, want nil", got)
	}
}

// The AIXM does not forbid a second FUEL record, and overwriting would drop
// the first without a trace.
func TestAddFuelKeepsBoth(t *testing.T) {
	a := &fuelEntry{avail: "no", text: ""}
	b := &fuelEntry{avail: "yes", text: `Carburant : 100 LL\\Fuel : 100 LL`}
	got := addFuel(a, b)
	if got.avail != "yes" {
		t.Errorf("avail = %q, want yes: one record naming a grade outweighs one saying NIL", got.avail)
	}
	if got.text != b.text {
		t.Errorf("text = %q", got.text)
	}

	got = addFuel(&fuelEntry{avail: "yes", text: `A\\B`}, &fuelEntry{avail: "yes", text: `C\\D`})
	if want := `A#C\\B#D`; got.text != want {
		t.Errorf("joined text\n got %s\nwant %s", got.text, want)
	}
	if addFuel(nil, b) != b || addFuel(a, nil) != a {
		t.Error("a nil side must pass the other through")
	}
}
