package eaip

import (
	"strings"
	"testing"

	"github.com/0intro/loxodrome/internal/aixm5"
)

// ICAO's ENR 2.1 packs the name, the lateral limits, the vertical limits
// and the class into ONE cell, and every State runs them together a
// little differently. Each case below is a real cell from a live eAIP:
// getting one wrong does not fail loudly, it files a control area with
// no ceiling, or with the ground on top.
func TestSplitIcaoComposite(t *testing.T) {
	cases := []struct {
		name       string
		prefix     string
		in         string
		wantName   string
		wantUpper  string // Value+Unit, "" for none
		wantLower  string
		wantClass  string
		wantSwap   bool
		wantGeoEnd string // the last token the lateral limits must keep
	}{
		{
			name:   "Hungary: upper first, no separator, no class",
			prefix: "LH",
			in: "BUDAPEST FIR 465209N 0160650E along border AUSTRIA_HUNGARY - " +
				"462901N 0163358E FL 660 GND",
			wantName: "BUDAPEST FIR", wantUpper: "660FL", wantLower: "GND",
			wantGeoEnd: "462901N 0163358E",
		},
		{
			name:     "Slovakia: slash separator, boundary prose for geometry",
			prefix:   "LZ",
			in:       "BRATISLAVA FIR State boundary with Poland, Ukraine, Hungary, Austria and Czech Republic. UNL / GND",
			wantName: "BRATISLAVA FIR State boundary with Poland, Ukraine, Hungary, Austria and Czech Republic.",
			// No coordinate at all: the whole cell is the name, and the
			// limits still come off the end.
			wantUpper: "UNL", wantLower: "GND",
		},
		{
			name:   "Portugal: UNL SFC after a coordinate list",
			prefix: "LP",
			in: "LISBOA FIR (LPPC FIR) 4300N 01300W - 4200N 01000W - " +
				"along Portuguese/Spanish border - 4300N 01300W UNL SFC",
			wantName: "LISBOA FIR (LPPC FIR)", wantUpper: "UNL", wantLower: "SFC",
			wantGeoEnd: "4300N 01300W",
		},
		{
			name:   "Romania: the classes a dash list, by level and by area",
			prefix: "LR",
			in: "BUCURE\u015eTI CTA 2 451300N 0294000E - 450900N 0295800E - 443000N 0301600E - 451300N 0294000E FL 245 " +
				"Class of airspace: - C ABV, but not including FL 105, ATS routes, CTRs, TMA - A TMA - G outside other regulated airspace",
			// C above FL 105 and G below it outside the routes and zones
			// is no class of the whole area: none is stated.
			wantName: "BUCURE\u015eTI CTA 2", wantUpper: "245FL",
			wantGeoEnd: "451300N 0294000E",
		},
		{
			name:   "Portugal: a metric floor, and prose after the class",
			prefix: "LP",
			in: "FARO TMA (LPFR TMA) 370730N 0072318W - 364016N 0072311W - " +
				"373551N 0075731W FL245 300M AGL/AMSL Class of Airspace: C",
			wantName: "FARO TMA (LPFR TMA)", wantUpper: "245FL", wantLower: "300M",
			wantClass: "C", wantGeoEnd: "373551N 0075731W",
		},
		{
			name:   "Slovenia: an explicit class phrase and a footnote marker",
			prefix: "LJ",
			in: "LJUBLJANA FIR covers the entire territory of the Republic of Slovenia " +
				"FL 660 / GND 2) Class of airspace: C,D,E,G",
			wantName:  "LJUBLJANA FIR covers the entire territory of the Republic of Slovenia",
			wantUpper: "660FL", wantLower: "GND",
			// A stack the one-letter column cannot express: left empty.
			wantClass: "",
		},
		{
			name:      "Ireland: the block, and the pair printed LOWER first",
			prefix:    "EI",
			in:        "Shannon FIR 5520N 00655W, 5425N 00810W, 5100N 01500W, 5520N 00655W SFC / FL 245 - Class C/G/A",
			wantName:  "Shannon FIR",
			wantUpper: "245FL", wantLower: "SFC", wantSwap: true,
			// C/G/A is a stack too.
			wantClass: "", wantGeoEnd: "5520N 00655W",
		},
		{
			name:   "Portugal: three limit tokens are not a pair",
			prefix: "LP",
			in: "LISBOA TMA (LPPT TMA) 394325N 0083705W - 400045N 0083905W " +
				"FL245 300M AGL/AMSL 450M AGL/AMSL Class of Airspace: C",
			wantName: "LISBOA TMA (LPPT TMA)",
			// A ceiling and two alternative floors: taking any two would
			// state a band the AIP never published.
			wantUpper: "", wantLower: "", wantClass: "C",
		},
		{
			name:   "Portugal: the spacing lost between inline values",
			prefix: "LP",
			in: "1 LISBOA TMA WEST 380000N 0100000W - 385400N 0100000W." +
				"FL2451000FTClass of Airspace: C",
			wantName: "1 LISBOA TMA WEST",
			// "FL2451000FT" reads as FL 2451000; no limit is better than
			// that one.
			wantUpper: "", wantLower: "", wantClass: "C",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			st := NewZoneStats()
			_, name, lateral, upper, lower, class := splitIcaoComposite(c.in, c.prefix, st)
			if name != c.wantName {
				t.Errorf("name = %q, want %q", name, c.wantName)
			}
			if got := limitStr(upper); got != c.wantUpper {
				t.Errorf("upper = %q, want %q", got, c.wantUpper)
			}
			if got := limitStr(lower); got != c.wantLower {
				t.Errorf("lower = %q, want %q", got, c.wantLower)
			}
			if class != c.wantClass {
				t.Errorf("class = %q, want %q", class, c.wantClass)
			}
			if (st.LimitsSwapped > 0) != c.wantSwap {
				t.Errorf("swapped = %v, want %v", st.LimitsSwapped > 0, c.wantSwap)
			}
			if c.wantGeoEnd != "" && !hasSuffixFold(lateral, c.wantGeoEnd) {
				t.Errorf("lateral limits end %q, want them to end with %q", tailOf(lateral), c.wantGeoEnd)
			}
		})
	}
}

// The vertical limits must never be left inside the geometry: a stray
// "FL 660" in a boundary sentence would become a phantom vertex.
func TestSplitVerticalTailKeepsGeometry(t *testing.T) {
	geo, upper, lower := splitVerticalTail("A circle of radius 100 M centred on 481533N 0182725E FL 195 GND")
	if upper != "FL 195" || lower != "GND" {
		t.Errorf("limits = %q / %q, want %q / %q", upper, lower, "FL 195", "GND")
	}
	if !hasSuffixFold(geo, "481533N 0182725E") {
		t.Errorf("geometry = %q, want it to keep the circle centre", geo)
	}
	// A radius in metres with nothing after it is not a limit.
	geo, upper, _ = splitVerticalTail("A circle of radius 100 M centred on 481533N 0182725E")
	if upper != "" {
		t.Errorf("vertical = %q, want none", upper)
	}
	if geo == "" {
		t.Error("geometry was dropped")
	}
}

// ENR 2.1 prints one unit and call sign beside several frequencies, and
// military UHF beside civil VHF.
func TestRadioChannelsFrom(t *testing.T) {
	got := RadioChannelsFrom(
		"128.880 121.330 130.235 363.300 MHz/",
		"LJUBLJANA ACC",
		"LJUBLJANA RADAR (English) H24",
	)
	if len(got) != 3 {
		t.Fatalf("got %d channels, want 3 (the UHF 363.300 is not a channel to set): %+v", len(got), got)
	}
	for _, c := range got {
		if c.Unit != "LJUBLJANA ACC" {
			t.Errorf("unit = %q", c.Unit)
		}
		if c.CallSign != "LJUBLJANA RADAR" {
			t.Errorf("call sign = %q, want the languages and hours trimmed", c.CallSign)
		}
	}
	if got[0].Freq != "128.880" {
		t.Errorf("freq = %q", got[0].Freq)
	}
	// The unit written against the figure: NAV Portugal's "122.555MHZ",
	// AirNav Ireland's "122.600MHz", KANS's "125.980MHZ". A longer run of
	// digits is no channel.
	for in, want := range map[string]string{"122.555MHZ": "122.555", "122.600MHz": "122.600", "127,425 MHz": "127.425", "122.5551": ""} {
		if got := strings.Join(FreqsComVHF(in), " "); got != want {
			t.Errorf("FreqsComVHF(%q) = %q, want %q", in, got, want)
		}
	}
}

// An ACC elementary-sector table is controller positions, and it puts
// the vertical limits LEFT of the lateral ones, so reading it names
// every row after a level band.
func TestSectorTablesAreNotZoneTables(t *testing.T) {
	matrix := [][]string{
		{"Sector group / Identification / Class of airspace", "Sector name / Identification",
			"Vertical limits", "Lateral limits", "Remarks"},
		{"1", "2", "3", "4", "5"},
		{"ACC BUDAPEST WEST (LHCCWEST) C", "WEST 0 (LHCCW0)", "9500 FT ALT - FL 305",
			"480024N 0170939E 474227N 0170500E 473244N 0164214E", "..."},
	}
	if row, _, _ := icaoHeaderRow(matrix); row >= 0 {
		t.Errorf("header row = %d, want the table skipped", row)
	}
}

// The mode is decided per TABLE from its header, never from the section
// number: Hungary publishes ENR 2.2 in the ENR 5 shape while Slovakia
// publishes it in the ENR 2.1 one.
func TestHeaderPicksTheMode(t *testing.T) {
	combinedHdr := [][]string{{"Name Lateral limits Vertical limits Class of airspace",
		"Unit providing service", "Call sign", "Frequencies", "Remarks"}}
	if _, lat0, combined := icaoHeaderRow(combinedHdr); !combined || lat0 != 0 {
		t.Errorf("combined header read as lat0=%d combined=%v", lat0, combined)
	}
	columnarHdr := [][]string{{"ID / Name Lateral limits", "Upper limit Lower limit",
		"Time of activity", "Remarks"}}
	if _, lat0, combined := icaoHeaderRow(columnarHdr); combined || lat0 != 0 {
		t.Errorf("columnar header read as lat0=%d combined=%v", lat0, combined)
	}
	polishHdr := [][]string{{"NAZWA STREFY NAME", "GRANICA BOCZNA STREFY LATERAL LIMITS",
		"GORNA/DOLNA GRANICA STREFY VERTICAL LIMITS"}}
	if _, lat0, combined := icaoHeaderRow(polishHdr); combined || lat0 != 1 {
		t.Errorf("split-name header read as lat0=%d combined=%v", lat0, combined)
	}
}

func limitStr(v *aixm5.VerticalLimit) string {
	if v == nil {
		return ""
	}
	return v.Value + v.Unit
}

func hasSuffixFold(s, suffix string) bool {
	s = NormSpace(s)
	return len(s) >= len(suffix) && s[len(s)-len(suffix):] == suffix
}

func tailOf(s string) string {
	s = NormSpace(s)
	if len(s) > 40 {
		return "..." + s[len(s)-40:]
	}
	return s
}

// ROMATSA's ENR 2.1 names a TMA made of parts twice over: the whole as a
// row of its own, its outline and class but no limits, before its parts
// ("ARAD TMA (ARAD TMA 1 + ARAD TMA 2)", "NAPOC TMA"), or as a heading on
// the first part's cell, the heading spelling the S with a comma below
// and the part with a cedilla; and a group of parts heads the first of
// them ("NAPOC NORTH SECTOR NAPOC TMA 1").
func TestFoldAggregates(t *testing.T) {
	spec := ZoneSpec{IDPrefix: "RO", IcaoPrefix: "LR"}
	fl := func(v string) *aixm5.VerticalLimit { return &aixm5.VerticalLimit{Value: v, Unit: "FL", Ref: "STD"} }
	zone := func(name, desig string, limited bool) aixm5.Airspace {
		id := idOf(desig, name, spec)
		z := aixm5.Airspace{ID: id, Designator: id, Name: name}
		if limited {
			z.UpperLimit, z.LowerLimit = fl("175"), fl("065")
		}
		return z
	}
	zones := []aixm5.Airspace{
		zone("ARAD TMA (ARAD TMA 1 + ARAD TMA 2)", "", false),
		zone("ARAD TMA 1", "", true),
		zone("ARAD TMA 2", "", true),
		zone("BUCUREȘTI CTA (BUCUREȘTI CTA consists of BUCUREȘTI CTA 1 and BUCUREȘTI CTA 2) BUCUREŞTI CTA 1", "", true),
		zone("BUCUREŞTI CTA 2", "", false),
		zone("NAPOC TMA", "", false),
		zone("NAPOC NORTH SECTOR NAPOC TMA 1", "", true),
		zone("NAPOC TMA 2", "", true),
		zone("(IAŞI)", "LRTRA2", false),
	}
	st := NewZoneStats()
	got := foldAggregates(zones, spec, st)
	var names, ids []string
	for _, z := range got {
		names = append(names, z.Name)
		ids = append(ids, z.ID)
	}
	want := []string{"ARAD TMA 1", "ARAD TMA 2", "BUCUREŞTI CTA 1", "BUCUREŞTI CTA 2", "NAPOC TMA 1", "NAPOC TMA 2", "(IAŞI)"}
	if strings.Join(names, "|") != strings.Join(want, "|") {
		t.Errorf("names\n %q\nwant\n %q", names, want)
	}
	if ids[2] != "RO-BUCURESTI-CTA-1" || ids[4] != "RO-NAPOC-TMA-1" || ids[6] != "LRTRA2" {
		t.Errorf("ids %q: a renamed part takes its name's id, a designated zone keeps its own", ids)
	}
	if st.Aggregates != 2 {
		t.Errorf("aggregates dropped = %d, want 2 (ARAD TMA, NAPOC TMA)", st.Aggregates)
	}
}

// ROMATSA's BUCUREŞTI CTA 2 runs from FL 245 down to the "Lower limit of
// ATS routes", a floor stated in words. Left in the cell it stopped the
// ceiling reading too, and a CTA with neither limit reads from the ground
// to unlimited; the words belong in the remarks.
func TestCombinedTextualFloor(t *testing.T) {
	doc, err := ParseHTML([]byte(`<html><body><table>
<tr><td>Name Lateral limits Vertical limits Class of airspace</td><td>Unit providing service</td><td>Call sign</td><td>Frequencies</td><td>Remarks</td></tr>
<tr><td><p>BUCUREŞTI CTA 2</p><p>451300N 0294000E - 450900N 0295800E - 443000N 0301600E - 451300N 0294000E</p><p>FL 245</p><p>Lower limit of ATS routes</p><p>Class of airspace: C</p></td><td>BUCUREŞTI ACC</td><td>Bucureşti Control</td><td>132.755</td><td>Frequencies are not protected above FL 450.</td></tr>
</table></body></html>`))
	if err != nil {
		t.Fatal(err)
	}
	st := NewZoneStats()
	zones := ParseIcaoZoneTables(doc, "ENR 2.1", ZoneSpec{Type: SectionType, IDPrefix: "RO", IcaoPrefix: "LR"}, st)
	if len(zones) != 1 {
		t.Fatalf("zones = %d, want 1", len(zones))
	}
	z := zones[0]
	if limitStr(z.UpperLimit) != "245FL" || z.LowerLimit != nil {
		t.Errorf("limits %q / %q, want FL 245 over a floor left unknown", limitStr(z.UpperLimit), limitStr(z.LowerLimit))
	}
	if !strings.HasPrefix(z.Rmk, "Lower limit of ATS routes") {
		t.Errorf("remarks %q, want the floor's words first", z.Rmk)
	}
	if st.LimitsTextual != 1 {
		t.Errorf("limits stated in words = %d, want 1", st.LimitsTextual)
	}
}

// An id folds each accented letter to its base letter rather than cutting
// the name at it.
func TestSlugFoldsAccents(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"KOŠICE TMA 1A", "KOSICE-TMA-1A"},
		{"NIŠ TMA", "NIS-TMA"},
		{"BUCUREŞTI CTA 1", "BUCURESTI-CTA-1"},
		{"BRAȘOV CTR 1", "BRASOV-CTR-1"},
		{"LIÈGE TMA ONE", "LIEGE-TMA-ONE"},
		{"Úlfarsfell", "ULFARSFELL"},
		{"PYHTÄÄ RMZ", "PYHTAA-RMZ"},
	} {
		if got := Slug(c.in); got != c.want {
			t.Errorf("Slug(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
