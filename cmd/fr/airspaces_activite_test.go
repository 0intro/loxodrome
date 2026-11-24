package main

import (
	"testing"
	"time"
)

// TestActiviteFreqs covers the shapes the corpus actually uses. The two that
// matter for safety are the supplétive "(s)", whose frequency must go, and the
// footnote "(1)", whose frequency must stay: BIARRITZ and CHAMBERY only agree
// with the AIXM because their footnoted channel is kept.
func TestActiviteFreqs(t *testing.T) {
	cases := []struct {
		name, in string
		want     []string
	}{
		{"unit then frequency", "APP MELUN#SEINE INFO 134.300", []string{"134.300"}},
		{"call sign on its own line", "LE BOURGET INFO#123.835", []string{"123.835"}},
		{"frequency on its own line", "APP CLERMONT#CLERMONT INFO#133.725", []string{"133.725"}},
		{"supplétive spaced", "NICE INFO 122.925 / 125.575 (s)", []string{"122.925"}},
		{"supplétive unspaced", "NANTES INFO 130.275 - 119.400(s)", []string{"130.275"}},
		{"footnote is not supplétive", "APP PYRENEES#PYRENEES INFO 126.525 (1)", []string{"126.525"}},
		{"two units on one line", "RENNES INFO#FIR BREST 134.200 - FIR PARIS 120.350", []string{"134.200", "120.350"}},
		{"two units on two lines", "LANDIVISIAU INFO 122.400#IROISE INFO 119.575", []string{"122.400", "119.575"}},
		{"unit suffix", "TONTOUTA INFORMATION#128.2 MHz (Nord/North)", []string{"128.2"}},
		{"no frequency at all", "ACC CAYENNE#FIS#CAYENNE INFO (FR)", nil},
		{"outside the VHF band", "SOME UNIT 999.999", nil},
		{"empty", "", nil},
	}
	for _, c := range cases {
		got := activiteFreqs(c.in)
		if !equalStrings(got, c.want) {
			t.Errorf("%s: activiteFreqs(%q) = %v, want %v", c.name, c.in, got, c.want)
		}
	}
}

// TestActiviteSIVKeys covers the lk forms the SIV volumes carry, including the
// "partie" filler the SIA writes and the AIXM does not.
func TestActiviteSIVKeys(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"[LF][SIV LE BOURGET][.][10]", []string{"LE BOURGET"}},
		{"[LF][SIV SEINE][1][10]", []string{"SEINE 1"}},
		{"[LF][SIV LILLE][4.1][100]", []string{"LILLE 4.1"}},
		{"[LF][SIV RENNES][SUD partie A][30]", []string{"RENNES SUD PARTIE A", "RENNES SUD A"}},
		{"[TF][SIV POINTE A PITRE][.][10]", []string{"POINTE A PITRE"}},
		// Not a SIV espace, and a truncated link: both contribute nothing.
		{"[LF][TMA SEINE][5][10]", nil},
		{"[LF][SIV SEINE]", nil},
	}
	for _, c := range cases {
		if got := activiteSIVKeys(c.in); !equalStrings(got, c.want) {
			t.Errorf("activiteSIVKeys(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

// TestSameChannel pins the 25 kHz carrier / 8.33 designator equivalence and,
// more importantly, that it is not a blanket 5 kHz tolerance: 118.005 and
// 118.010 are different channels and must stay different.
func TestSameChannel(t *testing.T) {
	cases := []struct {
		a, b float64
		want bool
	}{
		{123.700, 123.700, true},
		{123.700, 123.705, true}, // CHAMBERY: the Activite states the carrier
		{123.705, 123.700, true},
		{118.005, 118.010, false},
		{118.010, 118.015, false},
		{135.200, 135.530, false},
		// 119.575 IS a 25 kHz channel, so 119.580 is its designator.
		{119.575, 119.580, true},
		// 118.030 is not a 25 kHz multiple, so nothing pairs with it.
		{118.030, 118.035, false},
	}
	for _, c := range cases {
		if got := sameChannel(c.a, c.b); got != c.want {
			t.Errorf("sameChannel(%.3f, %.3f) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}

// TestParseSIAActiviteFreqs covers the join: the volume's own lk names the
// sub-sector, the AIXM name index maps it to a codeId, several volumes of one
// sub-sector union their frequencies, the "partie" elision reaches the AIXM
// spelling, and the reference children every SIA record carries (same lk, no
// payload) contribute nothing.
func TestParseSIAActiviteFreqs(t *testing.T) {
	const sia = `<?xml version="1.0" encoding="UTF-8"?>
<SiaExport><Situation>
<VolumeS>
<Volume pk="1" lk="[LF][SIV ZZZ][4][10]"><Partie pk="11" lk="[LF][SIV ZZZ][4]"/><Activite>APP ZZZ#ZZZ Approche#132.215</Activite></Volume>
<Volume pk="2" lk="[LF][SIV ZZZ][4][20]"><Partie pk="11" lk="[LF][SIV ZZZ][4]"/><Activite>APP ZZZ#ZZZ Info#119.450</Activite></Volume>
<Volume pk="3" lk="[LF][SIV YYY][SUD partie A][30]"><Partie pk="12" lk="[LF][SIV YYY][SUD partie A]"/><Activite>APP YYY#YYY INFO 134.000</Activite></Volume>
<Volume pk="4" lk="[LF][SIV ZZZ][4][30]"><Partie pk="11" lk="[LF][SIV ZZZ][4]"/><Activite>APP ZZZ#ZZZ Approche 132.215</Activite></Volume>
<Volume pk="5" lk="[LF][SIV NONE][.][10]"><Partie pk="13" lk="[LF][SIV NONE][.]"/></Volume>
</VolumeS>
</Situation></SiaExport>`
	byName := AIXMSIVByName{
		"ZZZ 4":     {"LFZZFS4"},
		"YYY SUD A": {"LFYYFSSUDA"},
	}
	plan, err := parseSIA([]byte(sia), byName, AIXMTMAByName{})
	if err != nil {
		t.Fatal(err)
	}
	// Two volumes of one sub-sector on different frequencies keep both, the
	// third repeats one and does not double it, and the order is by value.
	if got := plan.ActiviteFreqs["LFZZFS4"]; !equalStrings(got, []string{"119.450", "132.215"}) {
		t.Errorf("LFZZFS4 = %v, want [119.450 132.215]", got)
	}
	// The AIXM spells it without the SIA's "partie".
	if got := plan.ActiviteFreqs["LFYYFSSUDA"]; !equalStrings(got, []string{"134.000"}) {
		t.Errorf("LFYYFSSUDA = %v, want [134.000]", got)
	}
	// A volume stating no frequency, and a name the AIXM does not carry, both
	// leave nothing behind.
	if len(plan.ActiviteFreqs) != 2 {
		t.Errorf("ActiviteFreqs has %d keys, want 2: %v", len(plan.ActiviteFreqs), plan.ActiviteFreqs)
	}
}

// activiteFixture is one AIXM snapshot exercising every branch of the
// <Activite> path against synthetic units:
//
//	LFZZFS1/2  the ordinary narrow, two sub-sectors of a two-channel unit
//	LFTTFS1    the narrow across the 8.33 designator (CHAMBERY's shape)
//	LFYYFS     the fill, corroborated by a FIS record of the same unit
//	LFWWFS     the fill refused, no record to corroborate it (GENEVE's shape)
//	LFVVFS1    the narrow refused, a stated value the AIXM does not carry
//	NWWWFS     a FIC, never narrowed (NOUVELLE CALEDONIE's shape)
var activiteFixture = `<?xml version="1.0" encoding="UTF-8"?>
<AIXM-Snapshot version="4.5" effective="2026-09-03T00:00:00.000+02:00">
  <Ase><AseUid mid="6000"><codeType>RAS</codeType><codeId>LFZZFS</codeId></AseUid><txtName>ZZZ</txtName><txtLocalType>FLIGHT INFORMATION SECTOR</txtLocalType></Ase>
  <Ase><AseUid mid="6001"><codeType>RAS</codeType><codeId>LFZZFS1</codeId></AseUid><txtName>ZZZ 1</txtName><txtLocalType>FLIGHT INFORMATION SECTOR</txtLocalType></Ase>
  <Ase><AseUid mid="6002"><codeType>RAS</codeType><codeId>LFZZFS2</codeId></AseUid><txtName>ZZZ 2</txtName><txtLocalType>FLIGHT INFORMATION SECTOR</txtLocalType></Ase>
  <Ase><AseUid mid="6100"><codeType>RAS</codeType><codeId>LFTTFS</codeId></AseUid><txtName>TTT</txtName><txtLocalType>FLIGHT INFORMATION SECTOR</txtLocalType></Ase>
  <Ase><AseUid mid="6101"><codeType>RAS</codeType><codeId>LFTTFS1</codeId></AseUid><txtName>TTT 1</txtName><txtLocalType>FLIGHT INFORMATION SECTOR</txtLocalType></Ase>
  <Ase><AseUid mid="6200"><codeType>RAS</codeType><codeId>LFYYFS</codeId></AseUid><txtName>YYY</txtName><txtLocalType>FLIGHT INFORMATION SECTOR</txtLocalType></Ase>
  <Ase><AseUid mid="6300"><codeType>RAS</codeType><codeId>LFWWFS</codeId></AseUid><txtName>WWW</txtName><txtLocalType>FLIGHT INFORMATION SECTOR</txtLocalType></Ase>
  <Ase><AseUid mid="6400"><codeType>RAS</codeType><codeId>LFVVFS</codeId></AseUid><txtName>VVV</txtName><txtLocalType>FLIGHT INFORMATION SECTOR</txtLocalType></Ase>
  <Ase><AseUid mid="6401"><codeType>RAS</codeType><codeId>LFVVFS1</codeId></AseUid><txtName>VVV 1</txtName><txtLocalType>FLIGHT INFORMATION SECTOR</txtLocalType></Ase>
  <Ase><AseUid mid="6500"><codeType>RAS</codeType><codeId>NWWWFS</codeId></AseUid><txtName>NCAL</txtName><txtLocalType>FLIGHT INFORMATION SECTOR</txtLocalType></Ase>
  <Abd><AbdUid mid="8001"><AseUid mid="6001"/></AbdUid>` + quadRing("480000.00N", "0073000.00E") + `</Abd>
  <Abd><AbdUid mid="8002"><AseUid mid="6002"/></AbdUid>` + quadRing("481000.00N", "0073000.00E") + `</Abd>
  <Abd><AbdUid mid="8101"><AseUid mid="6101"/></AbdUid>` + quadRing("482000.00N", "0073000.00E") + `</Abd>
  <Abd><AbdUid mid="8200"><AseUid mid="6200"/></AbdUid>` + quadRing("483000.00N", "0073000.00E") + `</Abd>
  <Abd><AbdUid mid="8300"><AseUid mid="6300"/></AbdUid>` + quadRing("484000.00N", "0073000.00E") + `</Abd>
  <Abd><AbdUid mid="8401"><AseUid mid="6401"/></AbdUid>` + quadRing("485000.00N", "0073000.00E") + `</Abd>
  <Abd><AbdUid mid="8500"><AseUid mid="6500"/></AbdUid>` + quadRing("490000.00N", "0073000.00E") + `</Abd>
  <Sae><SaeUid mid="9000"><SerUid mid="7000"><UniUid><txtName>LFZZ ZZZ</txtName></UniUid><codeType>FIS</codeType></SerUid><AseUid mid="6000"/></SaeUid></Sae>
  <Sae><SaeUid mid="9100"><SerUid mid="7100"><UniUid><txtName>LFTT TTT</txtName></UniUid><codeType>FIS</codeType></SerUid><AseUid mid="6100"/></SaeUid></Sae>
  <Sae><SaeUid mid="9400"><SerUid mid="7400"><UniUid><txtName>LFVV VVV</txtName></UniUid><codeType>FIS</codeType></SerUid><AseUid mid="6400"/></SaeUid></Sae>
  <Sae><SaeUid mid="9500"><SerUid mid="7500"><UniUid><txtName>NWWW NCAL</txtName></UniUid><codeType>FIS</codeType></SerUid><AseUid mid="6500"/></SaeUid></Sae>
  <Fqy><FqyUid mid="a000"><SerUid mid="7000"/><valFreqTrans>120.000</valFreqTrans></FqyUid><Cdl><txtCallSign>ZZZ - INFORMATION</txtCallSign><codeLang>FR</codeLang></Cdl></Fqy>
  <Fqy><FqyUid mid="a001"><SerUid mid="7000"/><valFreqTrans>121.000</valFreqTrans></FqyUid><Cdl><txtCallSign>ZZZ - INFORMATION</txtCallSign><codeLang>FR</codeLang></Cdl></Fqy>
  <Fqy><FqyUid mid="a100"><SerUid mid="7100"/><valFreqTrans>123.705</valFreqTrans></FqyUid><Cdl><txtCallSign>TTT - INFORMATION</txtCallSign><codeLang>FR</codeLang></Cdl></Fqy>
  <Fqy><FqyUid mid="a101"><SerUid mid="7100"/><valFreqTrans>135.200</valFreqTrans></FqyUid><Cdl><txtCallSign>TTT - INFORMATION</txtCallSign><codeLang>FR</codeLang></Cdl></Fqy>
  <Fqy><FqyUid mid="a400"><SerUid mid="7400"/><valFreqTrans>130.000</valFreqTrans></FqyUid><Cdl><txtCallSign>VVV - INFORMATION</txtCallSign><codeLang>FR</codeLang></Cdl></Fqy>
  <Fqy><FqyUid mid="a500"><SerUid mid="7500"/><valFreqTrans>118.100</valFreqTrans></FqyUid><Cdl><txtCallSign>NCAL - INFORMATION</txtCallSign><codeLang>FR</codeLang></Cdl></Fqy>
  <Fqy><FqyUid mid="a501"><SerUid mid="7500"/><valFreqTrans>128.200</valFreqTrans></FqyUid><Cdl><txtCallSign>NCAL - INFORMATION</txtCallSign><codeLang>FR</codeLang></Cdl></Fqy>
</AIXM-Snapshot>`

const activiteFixtureSIA = `<?xml version="1.0" encoding="UTF-8"?>
<SiaExport><Situation>
<FrequenceS>
<Frequence lk="[LF][YY][FIS YYY Information][123.835]"><Service lk="[LF][YY][FIS YYY Information]"/><Frequence>123.835</Frequence></Frequence>
</FrequenceS>
<VolumeS>
<Volume pk="1" lk="[LF][SIV ZZZ][1][10]"><Activite>APP ZZZ#ZZZ INFO 120.000</Activite></Volume>
<Volume pk="2" lk="[LF][SIV ZZZ][2][10]"><Activite>APP ZZZ#ZZZ INFO 121.000</Activite></Volume>
<Volume pk="3" lk="[LF][SIV TTT][1][10]"><Activite>APP TTT#TTT APP 123.700</Activite></Volume>
<Volume pk="4" lk="[LF][SIV YYY][.][10]"><Activite>YYY INFO#123.835</Activite></Volume>
<Volume pk="5" lk="[LF][SIV WWW][.][10]"><Activite>FIC WWW#WWW INFO 126.350</Activite></Volume>
<Volume pk="6" lk="[LF][SIV VVV][1][10]"><Activite>APP VVV#VVV INFO 130.000#OTHER INFO 131.000</Activite></Volume>
<Volume pk="7" lk="[NW][SIV NCAL][.][10]"><Activite>ACC/FIC NCAL#NCAL INFORMATION#128.200 MHz (Nord/North)</Activite></Volume>
</VolumeS>
</Situation></SiaExport>`

func TestBuildAirspacesActivite(t *testing.T) {
	artifact, meta, err := BuildAirspaces([]byte(activiteFixture), AirspacesOptions{
		Source:       "activite.aixm.xml",
		SIASource:    []byte(activiteFixtureSIA),
		Now:          func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) },
		MinAirspaces: 1,
		MaxAirspaces: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	radioOf := func(id string) []string {
		t.Helper()
		for _, r := range artifact.Rows {
			row := r.([]any)
			if row[0] != id {
				continue
			}
			entries := row[11].([]any)
			out := make([]string, 0, len(entries))
			for _, e := range entries {
				out = append(out, e.([]string)[0])
			}
			return out
		}
		t.Fatalf("no emitted row for %q", id)
		return nil
	}
	tripleOf := func(id string) []string {
		t.Helper()
		for _, r := range artifact.Rows {
			row := r.([]any)
			if row[0] == id {
				entries := row[11].([]any)
				if len(entries) == 0 {
					t.Fatalf("%s has no radio entry", id)
				}
				return entries[0].([]string)
			}
		}
		t.Fatalf("no emitted row for %q", id)
		return nil
	}

	// The ordinary narrow: each sub-sector keeps the one channel its volume
	// states, out of the unit's two.
	if got := radioOf("LFZZFS1"); !equalStrings(got, []string{"120.000"}) {
		t.Errorf("LFZZFS1 radio = %v, want [120.000]", got)
	}
	if got := radioOf("LFZZFS2"); !equalStrings(got, []string{"121.000"}) {
		t.Errorf("LFZZFS2 radio = %v, want [121.000]", got)
	}
	// The narrow reaches across the 8.33 designator: the Activite states the
	// 25 kHz carrier 123.700, the AIXM publishes the channel 123.705, and the
	// row keeps the AIXM's value and unit rather than gaining a second entry.
	if got := radioOf("LFTTFS1"); !equalStrings(got, []string{"123.705"}) {
		t.Errorf("LFTTFS1 radio = %v, want [123.705] (8.33 designator matched)", got)
	}
	// The fill takes its unit and call sign from the unit's own FIS record.
	if got := tripleOf("LFYYFS"); !equalStrings(got, []string{"123.835", "FIS YYY Information", "YYY - INFORMATION"}) {
		t.Errorf("LFYYFS radio = %v, want the SIA FIS record's unit and call sign", got)
	}
	// No record to corroborate it: not filled, and counted as refused.
	if got := radioOf("LFWWFS"); len(got) != 0 {
		t.Errorf("LFWWFS radio = %v, want empty (no FIS record for the stated value)", got)
	}
	// A stated value the AIXM does not carry distrusts the whole reading.
	if got := radioOf("LFVVFS1"); !equalStrings(got, []string{"130.000"}) {
		t.Errorf("LFVVFS1 radio = %v, want [130.000] unchanged (uncorroborated reading refused)", got)
	}
	// A FIC is never narrowed: its channel list is per-sub-area by
	// construction and its Activite states only the general watch.
	if got := radioOf("NWWWFS"); !equalStrings(got, []string{"118.100", "128.200"}) {
		t.Errorf("NWWWFS radio = %v, want both (a FIC keeps its published set)", got)
	}
	if meta.SIAActiviteFilled != 1 {
		t.Errorf("SIAActiviteFilled = %d, want 1 (LFYYFS)", meta.SIAActiviteFilled)
	}
	if meta.SIAActiviteNarrowed != 3 {
		t.Errorf("SIAActiviteNarrowed = %d, want 3 (LFZZFS1, LFZZFS2, LFTTFS1)", meta.SIAActiviteNarrowed)
	}
	if meta.SIAActiviteRefused != 2 {
		t.Errorf("SIAActiviteRefused = %d, want 2 (LFWWFS, LFVVFS1)", meta.SIAActiviteRefused)
	}
}
