package main

import (
	"math"
	"reflect"
	"slices"
	"testing"
)

var (
	sfc      = []string{"HEI", "0", "FT"}
	asfc1500 = []string{"HEI", "1500", "FT"}
)

// TestSectorDefs: the sector definitions the supplements print outside their
// zone tables, each named for the supplement whose layout it is.
func TestSectorDefs(t *testing.T) {
	nav := navaidTable{"LFKT": {42.29028, 9.1925}}
	type want struct {
		name         string
		kind         string
		radiusM      float64 // a circle's
		minRing      int     // a ring's least vertex count, its arcs spliced
		lower, upper []string
		hours        [][2]string
	}
	for _, c := range []struct {
		name string
		rows []prow
		want []want
	}{
		{"107/2026, named circles under a heading with hours", rowsFromLines([]string{
			"Zones d'exclusion en ZRT SAINT CHRISTOL APLHA valables LS-CS",
			"Séderon : Cercle de 2.5Nm de rayon centré sur 44°13'19''N, 005°30'20''E, de SFC à 1500 ft ASFC",
			"Banon : Cercle de 1Nm de rayon centré sur 44°02'32''N, 005°38'03''E, de SFC à 1500 ft ASFC",
		}), []want{
			{"Séderon", "circle", 4630, 0, sfc, asfc1500, [][2]string{{"SR", "SS"}}},
			{"Banon", "circle", 1852, 0, sfc, asfc1500, [][2]string{{"SR", "SS"}}},
		}},
		{"106/2026, a circle on an ARP, its statement wrapped", rowsFromLines([]string{
			"Définition du secteur d'exclusion Corte : cercle de 2.5 NM de rayon centré sur sur l'ARP de",
			"l'aérodrome de Corte (LFKT), de limites verticales SFC / 1500 FT ASFC, destiné à protéger les tours de piste",
		}), []want{
			{"Corte", "circle", 4630, 0, sfc, asfc1500, nil},
		}},
		{"201/2026, an arc with no end points, its limits wrapped", rowsFromLines([]string{
			"Zones d'exclusion en ZRT TOLL BRAVO et DELTA :",
			"Saint Vincent les Forts : arc horaire de 1.50nm de rayon centré sur 44°26'17'' N,006°22'28'' E - SFC / 9000 ft",
			"AMSL",
			"Digne les Bains : cercle de 2.00nm de rayon centré sur 44°05'31''N,006°13'26'' E - SFC / 9000 ft AMSL",
		}), []want{
			{"Saint Vincent les Forts", "circle", 2778, 0, sfc, []string{"ALT", "9000", "FT"}, nil},
			{"Digne les Bains", "circle", 3704, 0, sfc, []string{"ALT", "9000", "FT"}, nil},
		}},
		{"228/2026, a ring under a sentence", rowsFromLines([]string{
			"Aérodrome",
			"CONDOM Valence sur Baïse (LFID), un secteur, de SFC à 1500 FT ASFC, permettant l'activité tours de piste et les",
			"départs et arrivées vers ou en provenance de l'Est, est défini ci- après :",
			"43°52'04'' N, 000°21'39'' E",
			"arc horaire de 2.70nm de rayon centré sur 43°54'33'' N, 000°23'10'' E",
			"43°57'02'' N, 000°24'37'' E",
			"43°55'14'' N, 000°30'15'' E",
			"43°50'11'' N, 000°27'35'' E",
			"43°52'04'' N, 000°21'39'' E",
			"Activités aériennes légères, sportives et récréatives",
		}), []want{
			{"CONDOM Valence sur Baïse", "polygon", 0, 10, sfc, asfc1500, nil},
		}},
		{"001/2026, a ring its limits follow, an arc's centre over three cells", []prow{
			cellsRow(10, cell{55, "Belle Ile :"}),
			cellsRow(9, cell{55, "47°21'45''N,003°14'58''W"}),
			cellsRow(8, cell{55, "47°19'33''N,003°09'27''W"}),
			cellsRow(7, cell{55, "47°19'15''N,003°07'33''W"}),
			cellsRow(6, cell{55, "arc horaire de 3Nm de rayon centré sur 47°19'34''"}, cell{223, "N,003°11'56''"}, cell{271, "W(ARPLFEA)"}),
			cellsRow(5, cell{55, "47°21'45''N,003°14'58''W"}),
			cellsRow(4, cell{55, "de SFC à 2000 ft ASFC"}),
		}, []want{
			{"Belle Ile", "polygon", 0, 10, sfc, []string{"HEI", "2000", "FT"}, nil},
		}},
		{"a validity the reader cannot place, and a sector without limits", rowsFromLines([]string{
			"Zones d'exclusion valables du 1er au 5 juin",
			"Sault : cercle de 1 NM de rayon centré sur 44°05'00''N, 005°24'00''E, de SFC à 1500 ft ASFC",
			"Autre secteur",
			"Lure : cercle de 1 NM de rayon centré sur 44°00'00''N, 005°48'00''E",
		}), nil},
	} {
		defs := sectorDefs(c.rows, make([]bool, len(c.rows)), nav)
		if len(defs) != len(c.want) {
			t.Errorf("%s: %d sectors, want %d: %+v", c.name, len(defs), len(c.want), defs)
			continue
		}
		for i, w := range c.want {
			d := defs[i]
			if d.name != w.name || d.geom.kind != w.kind || !reflect.DeepEqual(d.lower, w.lower) ||
				!reflect.DeepEqual(d.upper, w.upper) || !reflect.DeepEqual(d.hours, w.hours) {
				t.Errorf("%s: sector %d = %q %s %v..%v %v, want %q %s %v..%v %v", c.name, i,
					d.name, d.geom.kind, d.lower, d.upper, d.hours, w.name, w.kind, w.lower, w.upper, w.hours)
			}
			if w.kind == "circle" && math.Abs(d.geom.radiusM-w.radiusM) > 1 {
				t.Errorf("%s: %s radius %.0f m, want %.0f", c.name, d.name, d.geom.radiusM, w.radiusM)
			}
			if w.kind == "polygon" && len(d.geom.ring) < w.minRing {
				t.Errorf("%s: %s ring of %d vertices, want %d at least", c.name, d.name, len(d.geom.ring), w.minRing)
			}
		}
	}
}

// TestSectorKeys: a zone cites a sector by its whole name or by the capitals
// it opens on, jammed or spaced.
func TestSectorKeys(t *testing.T) {
	for _, c := range []struct {
		name string
		want []string
	}{
		{"CONDOM Valence sur Baïse", []string{"condomvalencesurbase", "condom"}},
		{"CONDOMValencesurBa�se", []string{"condomvalencesurbase", "condom"}},
		{"Belle Ile", []string{"belleile"}},
		{"S�deron", []string{"sderon"}},
		{"Yeu", nil},
	} {
		if got := sectorKeys(c.name); !reflect.DeepEqual(got, c.want) {
			t.Errorf("sectorKeys(%q) = %q, want %q", c.name, got, c.want)
		}
	}
}

// TestInlineSector: 077/2026 states the Ouessant sector inside its zones'
// exclusion text, as the native reader returns it.
func TestInlineSector(t *testing.T) {
	text := "Al\x19exclusion: -delaTMAIroise1; -dusecteurassoci�� l\x19a�rodromed\x19Ouessant (LFEC)suivant:cerclede3NM derayon centr�sur48�27\x1848''N, 005�03\x1849''WSFC2500ft."
	e, ok := inlineSector(text)
	if !ok {
		t.Fatalf("inlineSector(%q) read nothing", text)
	}
	c := roundPt(latlon{48 + 27.0/60 + 48.0/3600, -(5 + 3.0/60 + 49.0/3600)})
	if e.name != "Ouessant" || e.geom.kind != "circle" || e.geom.center != c || e.geom.radiusM != 5556 ||
		!reflect.DeepEqual(e.lower, sfc) || !reflect.DeepEqual(e.upper, []string{"ALT", "2500", "FT"}) {
		t.Errorf("inlineSector = %q %+v %v..%v", e.name, e.geom, e.lower, e.upper)
	}
	if _, ok := inlineSector("A l'exclusion de la LF-D595 lorsqu'elle est active"); ok {
		t.Error("an airspace the zone excludes read as a sector")
	}
}

// TestAttachExclusions: a zone takes the sectors its exclusion text names,
// and a sector clear of its box is a misreading.
func TestAttachExclusions(t *testing.T) {
	ring := []latlon{{44.2, 0.2}, {44.0, 0.6}, {43.6, 0.4}, {43.6, 0.1}, {44.2, 0.2}}
	zones := []zone{
		{name: "ZRT CONDOM ALPHA", geom: &geometry{kind: "polygon", ring: ring}, bbox: ringBbox(ring),
			exclText: "�l'exclusiondusecteurd'a�rodromedeCondom"},
		{name: "ZRT CONDOM BRAVO", geom: &geometry{kind: "polygon", ring: ring}, bbox: ringBbox(ring)},
	}
	near := &geometry{kind: "circle", center: latlon{43.9, 0.4}, radiusM: 5000}
	far := &geometry{kind: "circle", center: latlon{48.0, 2.0}, radiusM: 5000}
	defs := []sectorDef{
		{exclusion: exclusion{name: "CONDOM Valence sur Baïse", geom: near, bbox: geomBbox(near), lower: sfc, upper: asfc1500},
			keys: []string{"condomvalencesurbase", "condom"}},
		{exclusion: exclusion{name: "Banon", geom: near, bbox: geomBbox(near), lower: sfc, upper: asfc1500}, keys: []string{"banon"}},
	}
	if warns := attachExclusions(zones, defs); len(warns) != 0 {
		t.Errorf("warnings %v", warns)
	}
	if got := zones[0].exclusions; len(got) != 1 || got[0].name != "CONDOM Valence sur Baïse" {
		t.Errorf("ALPHA's exclusions = %+v", got)
	}
	if len(zones[1].exclusions) != 0 {
		t.Errorf("BRAVO took %+v", zones[1].exclusions)
	}
	zones[0].exclusions = nil
	defs[0].geom, defs[0].bbox = far, geomBbox(far)
	if warns := attachExclusions(zones, defs); !slices.Equal(warns, []string{"exclusion-outside-zone"}) || len(zones[0].exclusions) != 0 {
		t.Errorf("a sector clear of the zone: warnings %v, exclusions %+v", warns, zones[0].exclusions)
	}
}

// TestCollectColumnsExclusionText: what a column prints after "à
// l'exclusion" is its exclusion text. 077/2026's circle there is the
// excluded Ouessant sector, which the zone drew as part of itself, and
// a_099/2026's zone excluded from "Identiques à celles de la zone LF-TRA6"
// read as a second zone it was the same as.
func TestCollectColumnsExclusionText(t *testing.T) {
	colXs := []float64{100, 300}
	rows := []prow{
		cellsRow(9, cell{100, "48°54'00\"N, 004°21'00\"W"}, cell{300, "Identiques à celles de la zone LF-TRA6"}),
		cellsRow(8, cell{100, "A l'exclusion du secteur suivant :"}, cell{300, "à l'exclusion de la partie interférente de la zone"}),
		cellsRow(7, cell{100, "cercle de 3 NM de rayon centré sur 48°27'48'' N, 005°03'49'' W SFC2500ft."}, cell{300, "LF-R 506A Coëtquidan"}),
	}
	cols := collectColumns(rows, colXs)
	a, b := cols[100], cols[300]
	if len(a.circles) != 0 || len(a.verts) != 1 {
		t.Errorf("column A: %d vertices, circles %+v", len(a.verts), a.circles)
	}
	if want := "A l'exclusion du secteur suivant : cercle de 3 NM de rayon centré sur 48°27'48'' N, 005°03'49'' W SFC2500ft."; a.exclusion != want {
		t.Errorf("column A's exclusion = %q, want %q", a.exclusion, want)
	}
	if got, want := extractRefDesignators(b.sameAs), extractRefDesignators("Identiques à celles de la zone LF-TRA6"); got != want {
		t.Errorf("column B is the same as %q, want %q", got, want)
	}
}

// TestSectorDefsUnderHeadings: 231/2026 states its sectors' limits once on
// their heading and names them by aerodrome code, and 207/2026 lists
// aerodromes over one circle on each ARP and heads a ring with its own
// code, the next head's limits no part of the ring before it. A heading's
// hours reach every sector of its list, and a prose row ends the list.
func TestSectorDefsUnderHeadings(t *testing.T) {
	nav := navaidTable{"LFJF": {44.695, 5.152}, "LFJE": {44.497, 5.402}, "LFHE": {45.054, 5.103}}
	type want struct {
		name         string
		kind         string
		keys         []string
		lower, upper []string
		hours        [][2]string
		under        bool
	}
	for _, c := range []struct {
		name string
		rows []string
		want []want
	}{
		{"231/2026", []string{
			"Secteurs d'exclusion des aérodromes : SFC / 1500ft ASFC",
			"LFKE (Saint-Jean-en-Royans):",
			"45°01'14\"N, 005°15'46\"E",
			"45°01'13\"N, 005°21'19\"E",
			"arc horaire de 2Nm de rayon centré sur 45°01'35\"N, 005°18'33\"E",
			"45°01'14\"N, 005°15'46\"E",
			"LFJF (Aubenasson):",
			"cercle de 2Nm de rayon centré sur 44°41'43\"N, 005°09'14\"E",
		}, []want{
			{"LFKE (Saint-Jean-en-Royans)", "polygon", []string{"lfkesaintjeanenroyans", "lfke"}, sfc, asfc1500, nil, true},
			{"LFJF (Aubenasson)", "circle", []string{"lfjfaubenasson", "lfjf"}, sfc, asfc1500, nil, true},
		}},
		{"hours and a prose row", []string{
			"Secteurs d'exclusion des aérodromes actifs de 0800 à 1700 : SFC / 1500ft ASFC",
			"LFKE (Saint-Jean-en-Royans):",
			"45°01'14\"N, 005°15'46\"E",
			"45°01'13\"N, 005°21'19\"E",
			"arc horaire de 2Nm de rayon centré sur 45°01'35\"N, 005°18'33\"E",
			"45°01'14\"N, 005°15'46\"E",
			"LFJF (Aubenasson):",
			"cercle de 2Nm de rayon centré sur 44°41'43\"N, 005°09'14\"E",
			"Les usagers sont informés de l'activité par la fréquence",
			"Banon : Cercle de 1Nm de rayon centré sur 44°02'32''N, 005°38'03''E, de SFC à 1500 ft ASFC",
		}, []want{
			{"LFKE (Saint-Jean-en-Royans)", "polygon", []string{"lfkesaintjeanenroyans", "lfke"}, sfc, asfc1500, [][2]string{{"08:00", "17:00"}}, true},
			{"LFJF (Aubenasson)", "circle", []string{"lfjfaubenasson", "lfjf"}, sfc, asfc1500, [][2]string{{"08:00", "17:00"}}, true},
			{"Banon", "circle", []string{"banon"}, sfc, asfc1500, nil, false},
		}},
		{"207/2026", []string{
			"Des secteurs d’exclusion sont définis pour :",
			"- les aérodromes de Aubenasson (LFJF), La Motte-Chalancon (LFJE), Romans",
			"(LFHE), Valréas (LFNV),",
			"cercle de 2nm de rayon centré sur l'ARP du sol à 1500ft AGL ou plafond de la ZRT considérée",
			"- Pour les écoles de parapentes à Séderon de SR-30 à SS+30, cercle de 2.5Nm de rayon centré sur 44°13'19''N,",
			"005°30'20''E SFC/1500ft ASFC",
			"- la RMZ Valence (LFLU) étendue SFC/3500ft AMSL définie par :",
			"44°55'51'' N,005°06'05'' E",
			"45°01'45'' N,004°55'52'' E",
			"44°55'21'' N,004°54'11'' E",
			"44°55'51'' N,005°06'05'' E",
			"- la RMZ Le Versoud (LFLG) et Vallée de l’Isère SFC/6000ft AMSL définies par :",
			"45°16'04\"N, 005°49'48\"E",
			"45°14’35’’N, 005°56’01’’E",
			"45°12’06’’N, 005°52’32’’E",
			"45°16'04\"N, 005°49'48\"E",
		}, []want{
			{"Aubenasson (LFJF)", "circle", []string{"lfjf", "aubenasson"}, sfc, asfc1500, nil, true},
			{"La Motte-Chalancon (LFJE)", "circle", []string{"lfje", "lamottechalancon"}, sfc, asfc1500, nil, true},
			{"Romans (LFHE)", "circle", []string{"lfhe", "romans"}, sfc, asfc1500, nil, true},
			{"la RMZ Valence", "polygon", []string{"larmzvalence", "lflu"}, sfc, []string{"ALT", "3500", "FT"}, nil, true},
			{"la RMZ Le Versoud", "polygon", []string{"larmzleversoud", "lflg"}, sfc, []string{"ALT", "6000", "FT"}, nil, true},
		}},
	} {
		rows := rowsFromLines(c.rows)
		defs := sectorDefs(rows, make([]bool, len(rows)), nav)
		if len(defs) != len(c.want) {
			t.Errorf("%s: %d sectors, want %d: %+v", c.name, len(defs), len(c.want), defs)
			continue
		}
		for i, w := range c.want {
			d := defs[i]
			if d.name != w.name || d.geom.kind != w.kind || !reflect.DeepEqual(d.keys, w.keys) ||
				!reflect.DeepEqual(d.lower, w.lower) || !reflect.DeepEqual(d.upper, w.upper) ||
				!reflect.DeepEqual(d.hours, w.hours) || d.under != w.under {
				t.Errorf("%s: sector %d = %q %s %v %v..%v %v under=%v, want %q %s %v %v..%v %v under=%v", c.name, i,
					d.name, d.geom.kind, d.keys, d.lower, d.upper, d.hours, d.under,
					w.name, w.kind, w.keys, w.lower, w.upper, w.hours, w.under)
			}
		}
	}
}

// TestAttachExclusionsGeneric: a citation naming no sector (231/2026)
// takes every one a heading sets that meets the zone, and none other.
func TestAttachExclusionsGeneric(t *testing.T) {
	ring := []latlon{{45.1, 5.0}, {45.1, 5.5}, {44.4, 5.5}, {44.4, 5.0}, {45.1, 5.0}}
	in := &geometry{kind: "circle", center: latlon{44.7, 5.15}, radiusM: 3704}
	out := &geometry{kind: "circle", center: latlon{44.2, 5.5}, radiusM: 4630}
	loose := &geometry{kind: "circle", center: latlon{44.8, 5.3}, radiusM: 3704}
	defs := []sectorDef{
		{exclusion: exclusion{name: "LFJF (Aubenasson)", geom: in, bbox: geomBbox(in), lower: sfc, upper: asfc1500}, keys: []string{"lfjf"}, under: true},
		{exclusion: exclusion{name: "Séderon", geom: out, bbox: geomBbox(out), lower: sfc, upper: asfc1500}, keys: []string{"sderon"}, under: true},
		{exclusion: exclusion{name: "X", geom: loose, bbox: geomBbox(loose), lower: sfc, upper: asfc1500}, keys: []string{"xxxx"}},
	}
	zones := []zone{{name: "ZRT OMBLEZE", geom: &geometry{kind: "polygon", ring: ring}, bbox: ringBbox(ring),
		exclText: "à l'exclusion des secteurs d'aérodromes définis en dispositions complémentaires."}}
	attachExclusions(zones, defs)
	var names []string
	for _, e := range zones[0].exclusions {
		names = append(names, e.name)
	}
	if !reflect.DeepEqual(names, []string{"LFJF (Aubenasson)"}) {
		t.Errorf("generic citation took %q, want [LFJF (Aubenasson)]", names)
	}
}

// TestGenericSectors: a citation is of the sectors as a class only when a
// clause names none, as the corpus prints it natively, through poppler with
// a coordinate from the next column, or in a list.
func TestGenericSectors(t *testing.T) {
	for _, c := range []struct {
		text string
		want bool
	}{
		{"�l'exclusiondessecteurs d'a�rodromesd��\x01nisendispositions compl�mentaires.", true},
		{"àl'exclusiondessecteurs44°26'17\"N,004°38'09\"E44°26'17\"N,004°38'09\"E d'aérodromesdéﬁnisendispositions complémentaires.", true},
		{"A l'exclusion : - des LF-D569 et LF-D595 lorsqu'elles sont actives - des secteurs d'aérodromes définis en dispositions complémentaires", true},
		{"àl'exclusiondessecteursd'aérodromedéfinis endispositionscomplémentaires (Belle-Ile)", false},
		{"àl'exclusiondusecteur d'aérodromedeRibéracTourette LFIKtelquedéfiniendispositions complémentaires", false},
		{"àl'exclusiondusecteur2définidans lesdispositionscomplémentaires", false},
		{"àl'exclusiondelaLF-R231Aetdessecteurs1et2 définisdanslesdispositions complémentaires", false},
		{"-dusecteurd'aérodromedéfiniendispositionscomplémentaires (Ploërmel-Loyat)", false},
		{"A l'exclusion des LF-D569 et LF-D595 lorsqu'elles sont actives", false},
	} {
		if got := genericSectors(c.text); got != c.want {
			t.Errorf("genericSectors(%q) = %v, want %v", c.text, got, c.want)
		}
	}
}

// TestExcludeAirspaces: the P, R and D zones and the zones of its own
// supplement a zone's exclusion text cites, jammed or spaced, each with the
// condition of its clause, as the corpus prints them.
func TestExcludeAirspaces(t *testing.T) {
	ids := map[string]bool{}
	for _, id := range []string{
		"LFR110A", "LFR110B", "LFD216", "LFP35", "LFR115A", "LFR115B", "LFR115C",
		"LFR15A", "LFR15B", "LFR6A", "LFP77", "LFR64A0", "LFR64A1", "LFR64B", "LFR64C",
		"LFR231A", "LFR231B", "LFD16A", "LFD16B", "LFD16C", "LFD16D", "LFD16E", "LFD32", "LFD33",
		"LFR13A1", "LFR13A2", "LFR13C", "LFP23", "LFP25", "LFP047", "LFR83", "LFR106", "LFP234L",
		"LFR230", "LFR230B", "LFR14", "LFR84A", "LFR84B", "LFR157LOW", "LFR157HIG", "LFR205/2", "LFR205/3",
	} {
		ids[id] = true
	}
	type ex = excludedAirspace
	for _, c := range []struct {
		text string
		want []ex
	}{
		{"Al’exclusion: -desLF-R110AetBPont-Saint-Vincent lorsqu’ellessontactives, -delaLF-D216Boisl’Evêquelorsqu’elleestactive.",
			[]ex{{id: "LFR110A", whenActive: true}, {id: "LFR110B", whenActive: true}, {id: "LFD216", whenActive: true}}},
		{"àl’exclusion delaLF-P35«MONTDEMARSAN, desLF-R115A/B/CetdelaZRTCASTELJALOUX lorsqu’ellessontactives",
			[]ex{{id: "LFP35", whenActive: true}, {id: "LFR115A", whenActive: true}, {id: "LFR115B", whenActive: true},
				{id: "LFR115C", whenActive: true}, {zone: "ZRT CASTELJALOUX", whenActive: true}}},
		{"Al’exclusionde: -laCTRVatrylorsqu’elleestactive -deszonesLF-R15AetBBriennele Château lorsqu’ellessontactives -lazoneLF-R6AMaillylorsqu’elleest active -LF-P77BrienneleChâteau",
			[]ex{{id: "LFR15A", whenActive: true}, {id: "LFR15B", whenActive: true}, {id: "LFR6A", whenActive: true}, {id: "LFP77"}}},
		{"àl’exclusiondelaLF-R64Blorsqu’elleestactive", []ex{{id: "LFR64B", whenActive: true}}},
		{"àl'exclusiondelaLF-R231Aetdessecteurs1et2 définisdanslesdispositions complémentaires", []ex{{id: "LFR231A"}}},
		{"àl'exclusiondeszonesLF- D16A,B,CD,E, LF-D32,LF-D33etLF-R13C lorsqu'ellessont actives.",
			[]ex{{id: "LFD16A", whenActive: true}, {id: "LFD16B", whenActive: true}, {id: "LFD16C", whenActive: true},
				{id: "LFD16D", whenActive: true}, {id: "LFD16E", whenActive: true}, {id: "LFD32", whenActive: true},
				{id: "LFD33", whenActive: true}, {id: "LFR13C", whenActive: true}}},
		{"àl’exclusiondeszonesinterditesLF-P23,LF-P25etLF-P47.", []ex{{id: "LFP23"}, {id: "LFP25"}, {id: "LFP047"}}},
		{"A l’exclusion de la ZRT MENTON 1, des LF-R 83, 106 et LF-P 234L",
			[]ex{{id: "LFR83"}, {id: "LFR106"}, {id: "LFP234L"}, {zone: "ZRT MENTON 1"}}},
		{"Al'exclusiondelazoneLF-R230Baccaratlorsqu'elleestactive", []ex{{id: "LFR230", whenActive: true}}},
		{"àl'exclusiondespartiesinterférentesaveclesAWY A5etR14", nil},
		{"à l'exclusion des zones LF-P25 et LF-R84 qui conservent leur statut habituel.",
			[]ex{{id: "LFP25"}, {id: "LFR84A"}, {id: "LFR84B"}}},
		{"àl'exclusion deszonesLFR157LOWPierres-Noires etdelaLF-R205/2, LF- R205/3",
			[]ex{{id: "LFR157LOW"}, {id: "LFR205/2"}, {id: "LFR205/3"}}},
		{"àl'exclusiondelaZRT12", nil},
	} {
		zones := []zone{{name: "ZRT TEST", exclText: c.text}, {name: "ZRT CASTELJALOUX"}, {name: "ZRT MENTON 1"}, {name: "ZRT 1"}}
		excludeAirspaces(zones, ids)
		if got := zones[0].excluded; !reflect.DeepEqual(got, c.want) {
			t.Errorf("excludeAirspaces(%q) =\n  %+v\nwant\n  %+v", c.text, got, c.want)
		}
	}
}
