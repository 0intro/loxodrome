// ad2.go reads the aerodrome pages, AD 2 and AD 3, onto aixm5.Airport:
// the reference point and elevation, the runways (AD 2.12 joined with the
// declared distances of AD 2.13), the radio channels of AD 2.18 and the
// directory rows of AD 2.2 to AD 2.6. ICAO fixes the section numbers and
// the item labels, so the reader is one for every generator; what differs
// is how a page marks its sections, which ADSectionTables reads both ways.
//
// Lifted from cmd/be, whose output it reproduces byte for byte.

package eaip

import (
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/0intro/loxodrome/internal/aixm5"
)

// adSectionIDRe reads the id a generator marks a section's elements
// with: EUROCONTROL's "EBAW-AD-2.17" (the location indicator is checked by
// the caller), IDS's "AD2.12_1_TABLE", "AD2.16FATO_TABLE".
var adSectionIDRe = regexp.MustCompile(`^(?:([A-Z0-9]{4})-AD-[23]\.(\d+)|AD[23]\.(\d+)(?:[^\d.].*)?)$`)

// adHeadingRe reads a section's heading, where a generator marks it by
// neither id (SMATSA's "<h4><span>LYBE AD 2.2</span> ...</h4>").
var adHeadingRe = regexp.MustCompile(`^([A-Z0-9]{4})\s+AD\s*[23]\s*\.\s*(\d{1,2})\b`)

// ADSectionTables groups a page's tables by the AD section whose id, or
// heading, precedes them in document order ("EBAW-AD-2.17" → key "17").
func ADSectionTables(doc *Node, icao string) map[string][]*Node {
	out := map[string][]*Node{}
	current := ""
	var rec func(*Node)
	rec = func(n *Node) {
		if IsElem(n) {
			if m := adSectionIDRe.FindStringSubmatch(Attr(n, "id")); m != nil {
				switch {
				case m[1] == icao:
					current = m[2]
				case m[1] == "" && m[3] != "":
					current = m[3]
				}
			}
			if isHeadingTag(n.Data) {
				if m := adHeadingRe.FindStringSubmatch(NormSpace(NodeText(n))); m != nil && m[1] == icao {
					current = m[2]
				}
			}
			if n.Data == "table" && current != "" {
				out[current] = append(out[current], n)
				return // tables never nest sections
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			rec(c)
		}
	}
	rec(doc)
	return out
}

// milNameRe spots the "(MIL)" marker in an aerodrome name; NodeText's
// per-node spacing can print it "( MIL )".
var milNameRe = regexp.MustCompile(`\(\s*MIL\s*\)`)

// IsMilitaryName reports an aerodrome name carrying the "(MIL)" marker.
func IsMilitaryName(name string) bool {
	return milNameRe.MatchString(strings.ToUpper(name))
}

// ADName extracts the aerodrome name from the page's ADName heading
// ("EBSP — SPA (LA SAUVENIERE)" → "SPA (LA SAUVENIERE)").
func ADName(doc *Node, icao string) string {
	for _, n := range FindAll(doc, func(x *Node) bool { return HasClass(x, "ADName") }) {
		name := NodeText(n)
		name = strings.TrimSpace(strings.TrimPrefix(name, icao))
		name = strings.TrimSpace(strings.TrimLeft(name, "-— "))
		name = strings.ReplaceAll(name, "( ", "(")
		name = strings.ReplaceAll(name, " )", ")")
		if name != "" {
			return name
		}
	}
	return icao
}

// DocLabelled returns the first cell following a cell whose text begins
// with label (case-insensitive), across every table of the page in
// document order.
func DocLabelled(doc *Node, label string) string {
	for _, table := range Elems(doc, "table") {
		if v := LabelledAfter(table, label); v != "" {
			return v
		}
	}
	return ""
}

// LabelledAfter returns the cell after the first cell, anywhere in a row,
// whose text begins with label: an AD page sets its items "number | label
// | value" as well as "label | value", which the zone tables' first-cell
// LabelledPrefix does not read.
func LabelledAfter(table *Node, label string) string {
	for _, tr := range TableRows(table) {
		cells := RowCells(tr)
		for i, c := range cells {
			if strings.HasPrefix(strings.ToUpper(NodeText(c)), label) && i+1 < len(cells) {
				return NodeText(cells[i+1])
			}
		}
	}
	return ""
}

// --- runways ----------------------------------------------------------------

var (
	// rwyDesigRe is a runway end: its number, and L, C or R, or G for a
	// grass runway beside a paved one (NATS's Kemble 08G/26G).
	rwyDesigRe = regexp.MustCompile(`^(\d{2})([LRCG]?)$`)
	// dimRe tolerates the eAIP's grouped thousands ("1 510 x 45") and a
	// unit after each figure (AirNav's "620M x 16M").
	dimRe = regexp.MustCompile(`(\d[\d ]*)\s*(?:M\b)?\s*[xX×]\s*(\d[\d ]*)`)
	// lenOnlyRe is a length stated alone, Fintraffic's small fields'
	// "LEN: 770" with no width beside it, or NATS's "799 x - M", the width
	// left out.
	lenOnlyRe = regexp.MustCompile(`(?i)\bLEN(?:GTH)?\s*:\s*(\d[\d ]*)|(\d[\d ]*)\s*(?:M\b)?\s*[xX×]\s*[-–]`)
)

// rwyEnd is one AD 2.12 direction row.
type rwyEnd struct {
	desig   string
	lengthM *float64
	widthM  *float64
	surface string
	tora    *float64
	toda    *float64
	asda    *float64
	lda     *float64
}

// ParseRunways joins AD 2.12 (physical characteristics, one row per
// direction) with AD 2.13 (declared distances) into aixm5 runways.
func ParseRunways(physTables, declTables []*Node) []aixm5.Runway {
	ends := map[string]*rwyEnd{}
	var order []string
	for _, table := range physTables {
		matrix := ExpandTable(table)
		if desig, ok := directionTable(matrix); ok {
			// NAV Portugal sets a table per direction, the items in rows.
			e := ends[desig]
			if e == nil {
				e = &rwyEnd{desig: desig}
				ends[desig] = e
				order = append(order, desig)
			}
			for _, row := range matrix[1:] {
				cells := distinctCells(row)
				if len(cells) < 2 {
					continue
				}
				label := strings.ToUpper(strings.Join(cells[:len(cells)-1], " "))
				value := cells[len(cells)-1]
				switch {
				case strings.Contains(label, "DIMENSION") && strings.Contains(label, "RWY") && e.lengthM == nil:
					if m := dimRe.FindStringSubmatch(value); m != nil {
						if l, err := strconv.ParseFloat(ungroup(m[1]), 64); err == nil {
							e.lengthM = &l
						}
						if w, err := strconv.ParseFloat(ungroup(m[2]), 64); err == nil {
							e.widthM = &w
						}
					}
				case strings.Contains(label, "SURFACE") && strings.Contains(label, "RWY") && e.surface == "":
					e.surface = SurfaceToken(value)
				}
			}
			continue
		}
		for _, row := range matrix {
			if len(row) < 3 {
				continue
			}
			desig := strings.TrimSpace(row[0])
			if !rwyDesigRe.MatchString(desig) {
				continue
			}
			e := ends[desig]
			if e == nil {
				e = &rwyEnd{desig: desig}
				ends[desig] = e
				order = append(order, desig)
			}
			joined := NormSpace(strings.Join(row[1:], " | "))
			if m := dimRe.FindStringSubmatch(joined); m != nil && e.lengthM == nil {
				if l, err := strconv.ParseFloat(ungroup(m[1]), 64); err == nil {
					e.lengthM = &l
				}
				if w, err := strconv.ParseFloat(ungroup(m[2]), 64); err == nil {
					e.widthM = &w
				}
			} else if m := lenOnlyRe.FindStringSubmatch(joined); m != nil && e.lengthM == nil {
				if l, err := strconv.ParseFloat(ungroup(m[1]+m[2]), 64); err == nil {
					e.lengthM = &l
				}
			}
			if e.surface == "" {
				e.surface = SurfaceToken(joined)
			}
		}
	}
	for _, table := range declTables {
		matrix := ExpandTable(table)
		// Only the full declared-distances table qualifies; the sibling
		// intersection-TORA tables (ELLX "RWY | From | TORA") would
		// otherwise overwrite the full-length figures.
		if !declaredHeader(matrix) {
			continue
		}
		seen := map[string]bool{}
		for _, row := range matrix {
			if len(row) < 2 {
				continue
			}
			desig := strings.TrimSpace(row[0])
			e := ends[desig]
			if e == nil || !rwyDesigRe.MatchString(desig) || seen[desig] {
				continue
			}
			seen[desig] = true
			vals := make([]*float64, 0, 4)
			for _, cell := range row[1:] {
				vals = append(vals, metresVal(cell))
				if len(vals) == 4 {
					break
				}
			}
			for len(vals) < 4 {
				vals = append(vals, nil)
			}
			// AD 2.13 column order: TORA, TODA, ASDA, LDA.
			e.tora, e.toda, e.asda, e.lda = vals[0], vals[1], vals[2], vals[3]
		}
	}

	used := map[string]bool{}
	var out []aixm5.Runway
	for _, d := range order {
		if used[d] {
			continue
		}
		le := ends[d]
		// Stray designator-looking cells elsewhere in the section (sub-row
		// numbering, strip tables) carry no data: skip them.
		if le.lengthM == nil && le.surface == "" && le.tora == nil && le.lda == nil {
			used[d] = true
			continue
		}
		used[d] = true
		r := aixm5.Runway{
			Designator: le.desig,
			Le:         le.desig,
			LengthM:    le.lengthM,
			WidthM:     le.widthM,
			Surface:    le.surface,
			LeToraM:    le.tora,
			LeTodaM:    le.toda,
			LeAsdaM:    le.asda,
			LeLdaM:     le.lda,
		}
		if he := ends[Reciprocal(le.desig)]; he != nil && !used[he.desig] {
			used[he.desig] = true
			r.He = he.desig
			r.Designator = le.desig + "/" + he.desig
			r.HeToraM, r.HeTodaM, r.HeAsdaM, r.HeLdaM = he.tora, he.toda, he.asda, he.lda
			if r.LengthM == nil {
				r.LengthM = he.lengthM
			}
			if r.Surface == "" {
				r.Surface = he.surface
			}
		}
		out = append(out, r)
	}
	return out
}

// directionHeadRe is the head of a table given to one runway direction.
var directionHeadRe = regexp.MustCompile(`^RWY\s*(\d{2}[LRCG]?)$`)

// directionTable reports a table given to one runway direction, headed by
// its designator alone ("RWY 18"), and the designator.
func directionTable(matrix [][]string) (string, bool) {
	if len(matrix) < 2 {
		return "", false
	}
	head := distinctCells(matrix[0])
	if len(head) != 1 {
		return "", false
	}
	m := directionHeadRe.FindStringSubmatch(strings.ToUpper(head[0]))
	if m == nil {
		return "", false
	}
	return m[1], true
}

// Reciprocal returns the opposite runway designator ("08" → "26",
// "07L" → "25R").
func Reciprocal(d string) string {
	m := rwyDesigRe.FindStringSubmatch(d)
	if m == nil {
		return ""
	}
	n, _ := strconv.Atoi(m[1])
	n = (n+17)%36 + 1
	side := m[2]
	switch side {
	case "L":
		side = "R"
	case "R":
		side = "L"
	}
	return twoDigits(n) + side
}

func twoDigits(n int) string {
	if n < 10 {
		return "0" + strconv.Itoa(n)
	}
	return strconv.Itoa(n)
}

// declaredHeader reports whether a matrix is the full AD 2.13 table
// (TORA + LDA columns present).
func declaredHeader(matrix [][]string) bool {
	for _, row := range matrix {
		joined := strings.ToUpper(strings.Join(row, " "))
		if strings.Contains(joined, "TORA") && strings.Contains(joined, "LDA") {
			return true
		}
	}
	return false
}

// ungroup strips the grouped-thousands spaces from a digit run.
func ungroup(s string) string {
	return strings.ReplaceAll(strings.TrimSpace(s), " ", "")
}

// metresUnitRe is the unit NATS writes after each distance ("3047 M").
var metresUnitRe = regexp.MustCompile(`(?i)\s*M$`)

// metresVal parses one declared-distance cell (metres). nil for "NU",
// dashes, footnoted values, or blanks.
func metresVal(s string) *float64 {
	v, err := strconv.ParseFloat(ungroup(metresUnitRe.ReplaceAllString(NormSpace(s), "")), 64)
	if err != nil || v <= 0 {
		return nil
	}
	return &v
}

// SurfaceToken maps the AD 2.12 strength-and-surface prose onto the AIXM
// composition tokens the SPA's classifySurface / formatSurface understand
// (src/lib/data/runwaySurface.ts; tests/symbolCoverage.spec.ts lists every
// token a shipped overlay carries, so a new one is added there on purpose).
func SurfaceToken(s string) string {
	up := strings.ToUpper(s)
	switch {
	case unpavedRe.MatchString(up):
		// Before the paved word it holds: the SIA's "non revêtue / not
		// paved" is no asphalt, and the app reads UNPAVED as unpaved.
		return "UNPAVED"
	case strings.Contains(up, "ASPH"):
		return "ASPH"
	case strings.Contains(up, "CONC"):
		return "CONC"
	case strings.Contains(up, "GRASS"):
		return "GRASS"
	case strings.Contains(up, "PAVED"):
		return "ASPH"
	case strings.Contains(up, "BITUM") || strings.Contains(up, "MACADAM") || strings.Contains(up, "TARMAC"):
		// AirNav Ireland's "Bitumen/Macadam", the SIA's "enrobé bitumineux
		// / bituminous mix".
		return "ASPH"
	case strings.Contains(up, "SAND"):
		return "SAND"
	case strings.Contains(up, "WATER"):
		return "WATER"
	case strings.Contains(up, "GRAVEL"):
		return "GRAVE"
	}
	return ""
}

// unpavedRe is a surface stated as not paved, in either language.
var unpavedRe = regexp.MustCompile(`\b(?:UN|NOT\s*|NON[-\s]?)PAVED\b|\bNON\s+REV[ÊE]TU`)

// --- COM (AD 2.18) ------------------------------------------------------

// ParseComTable reads the ATS Communication Facilities table into raw
// RadioChannels: Unit carries the normalized AIXM 5.1 service-type code so
// aixm5.CurateAirportRadios' allowlist applies unchanged.
func ParseComTable(tables []*Node) []aixm5.RadioChannel {
	var out []aixm5.RadioChannel
	for _, table := range tables {
		matrix := ExpandTable(table)
		// NATS sets a service's further call signs and channels on rows of
		// their own, the service cell left blank ("| MANCHESTER RADAR |
		// 118.580"), and the call sign too for a second channel.
		prevService, prevCall := "", ""
		for _, row := range matrix {
			if len(row) < 3 {
				continue
			}
			service := strings.TrimSpace(row[0])
			callSign := strings.TrimSpace(row[1])
			if service == "" {
				if prevService == "" || len(FreqsComVHF(row[2])) == 0 {
					continue
				}
				service = prevService
				if callSign == "" {
					callSign = prevCall
				}
			}
			if strings.EqualFold(service, "Service designation") || service == "1" {
				prevService, prevCall = "", ""
				continue
			}
			prevService, prevCall = service, callSign
			for _, freq := range FreqsComVHF(row[2]) {
				out = append(out, aixm5.RadioChannel{
					Freq:     freq,
					Unit:     radioUnit(service, callSign),
					CallSign: callSign,
				})
			}
		}
	}
	return out
}

// radioCallServiceRe is a call sign naming its own service: NATS files
// Delivery and Ground under the TWR designation, and Radar and Director
// under APP.
var radioCallServiceRe = regexp.MustCompile(`(?i)\b(?:DELIVERY|GROUND|TOWER|RADAR|DIRECTOR|APPROACH)\b`)

// radioUnit is a channel's service: the designation's, unless the call
// sign names another one.
func radioUnit(service, callSign string) string {
	unit := ServiceCode(service)
	if radioCallServiceRe.MatchString(callSign) {
		if u := ServiceCode(callSign); u != "OTHER" && u != unit && unit != "ATIS" {
			return u
		}
	}
	return unit
}

// ServiceCode normalizes an AD 2.18 service designation onto the AIXM 5.1
// service-type vocabulary CurateAirportRadios curates (airportradio.go's
// allowlist). Unknown designations map to OTHER, which the curator keeps
// only for air-ground "... RADIO" call signs.
func ServiceCode(designation string) string {
	up := strings.ToUpper(designation)
	switch {
	case strings.Contains(up, "ATIS"):
		return "ATIS"
	case strings.Contains(up, "AFIS"):
		return "AFIS"
	case strings.Contains(up, "APP") || strings.Contains(up, "APPROACH") || strings.Contains(up, "ARRIVAL") || strings.Contains(up, "RADAR"):
		return "APP"
	case strings.Contains(up, "TWR") || strings.Contains(up, "TOWER"):
		return "TWR"
	case strings.Contains(up, "GND") || strings.Contains(up, "GROUND"):
		return "GND"
	case strings.Contains(up, "DEL") || strings.Contains(up, "DELIVERY") || strings.Contains(up, "CLEARANCE"):
		return "DEL"
	case strings.Contains(up, "FIS") || strings.Contains(up, "INFO"):
		return "FIS"
	case strings.Contains(up, "ACS") || strings.Contains(up, "ACC") || strings.Contains(up, "CTL") || strings.Contains(up, "CONTROL"):
		return "ACS"
	}
	return "OTHER"
}

// --- the directory rows (AD 2.2 to AD 2.6, AD 3) ---------------------------

// facilityRows are the labelled rows the directory takes, and where each
// lands. Prop is the AIXM propertyName the shared builder files it under,
// so an eAIP row and a DFS annotation reach the same panel heading; an
// empty Prop with a REMARK purpose is the builder's general-remark bucket.
var facilityRows = []struct {
	label string // uppercase prefix, as LabelledAfter matches
	prop  string
}{
	{"DIRECTION AND DISTANCE FROM", "airportLocation"},
	{"DIMENSIONS", "dimension"},
	{"SLOPE", "slope"},
	{"SURFACE", "surfaceComposition"},
	{"STRENGTH", "strength"},
	{"ARRIVAL ROUTES", "arrivalRoute"},
	{"SECONDARY POWER SUPPLY", "secondaryPowerSupply"},
	{"REMARKS", ""},
}

// ParseFacilityDetail fills the AIP-directory fields of one aerodrome
// from its page. Absent rows simply contribute nothing: the AD 2 pages
// carry only a few of these, and a page with none produces no facilities
// row.
func ParseFacilityDetail(doc *Node, ap *aixm5.Airport) {
	for _, r := range facilityRows {
		v := KeepFacilityText(DocLabelled(doc, r.label))
		if v == "" {
			continue
		}
		n := aixm5.Note{PropertyName: r.prop, Text: v}
		if r.prop == "" {
			n.Purpose = "REMARK"
		}
		ap.Notes = append(ap.Notes, n)
	}
	if v := KeepFacilityText(DocLabelled(doc, "OPERATIONAL HOURS")); v != "" {
		ap.Hours = append(ap.Hours, v)
	}

	// The operator block: skeyes prints the name and its postal address in
	// one cell on AD 3 ("Algemeen Ziekenhuis Delta (AZ Delta) VZW,
	// Deltalaan 1, 8800 Roeselare, BELGIUM"), and names it differently on
	// AD 2.
	c := aixm5.Contact{Name: KeepFacilityText(DocLabelled(doc, "OPERATOR"))}
	if c.Name == "" {
		c.Name = KeepFacilityText(DocLabelled(doc, "NAME OF AD OPERATOR"))
	}
	if v := KeepFacilityText(DocLabelled(doc, "TEL")); v != "" {
		c.Phone = append(c.Phone, v)
	}
	if v := KeepFacilityText(DocLabelled(doc, "FAX")); v != "" {
		c.Fax = append(c.Fax, v)
	}
	if v := KeepFacilityText(DocLabelled(doc, "EMAIL")); v != "" {
		c.Email = append(c.Email, v)
	}
	if c.Name != "" || len(c.Phone) > 0 || len(c.Fax) > 0 || len(c.Email) > 0 {
		ap.Contacts = append(ap.Contacts, c)
	}
}

// KeepFacilityText drops the placeholders a publisher prints for an absent
// row, so the panel shows nothing rather than the word "NIL".
func KeepFacilityText(s string) string {
	t := strings.Join(strings.Fields(s), " ")
	switch strings.ToUpper(strings.TrimRight(t, ". ")) {
	case "", "NIL", "NONE", "N/A", "INFO NOT AVBL", "NOT AVBL":
		return ""
	}
	return t
}

// --- ICAO's numbered items ---------------------------------------------------

// itemNumberRe is an item's number as a row's first cell ("5", "5.").
var itemNumberRe = regexp.MustCompile(`^(\d{1,2})\.?$`)

// ADItem is one numbered item of an AD section: its label, where the
// layout gives one, and its value cells, distinct and in order (SMATSA
// sets the ARP's coordinates and its site in two).
type ADItem struct {
	Label  string
	Values []string
	// More are the rows continuing the item, each its distinct cells: a
	// row repeating the item's number (skeyes sets the operator's
	// address, TEL and e-mail so), or one with no number at all (SMATSA).
	More [][]string
}

// ADItems reads a section's items by the numbers ICAO gives them, in
// either layout a generator sets them: a row per item ("5 | Transition
// altitude | 5000 ft", the number being the row's first non-empty cell,
// LFV setting it second, and the first row carrying a number winning, so
// skeyes's "1 | ARP coordinates" beats its "1 | Site of ARP" and
// Fintraffic's Finnish row its English twin), or a column per item (a row
// numbering them 1, 2, 3 ... under the labels, as IDS sets AD 2.17, the
// data rows under it, the first of which is read). The number is what
// reads, never the label, so the language does not matter.
func ADItems(tables []*Node) map[int]ADItem {
	items := map[int]ADItem{}
	for _, t := range tables {
		matrix := ExpandTable(t)
		last := 0 // the item the rows continue
		for ri := 0; ri < len(matrix); ri++ {
			row := matrix[ri]
			if cols := numberingRow(row); cols != nil {
				last = 0
				for _, data := range matrix[ri+1:] {
					if numberingRow(data) != nil || blankRow(data) {
						continue
					}
					for j, n := range cols {
						if _, ok := items[n]; ok || j >= len(data) {
							continue
						}
						if v := NormSpace(data[j]); v != "" {
							items[n] = ADItem{Values: []string{v}}
						}
					}
					break
				}
				continue
			}
			cells := distinctCells(row)
			if len(cells) == 0 {
				continue
			}
			m := itemNumberRe.FindStringSubmatch(cells[0])
			if m == nil {
				if it, ok := items[last]; ok && last != 0 {
					it.More = append(it.More, cells)
					items[last] = it
				}
				continue
			}
			if len(cells) < 2 {
				continue
			}
			n, _ := strconv.Atoi(m[1])
			if it, ok := items[n]; ok {
				if n == last {
					it.More = append(it.More, cells[1:])
					items[n] = it
				}
				continue
			}
			last = n
			it := ADItem{Label: cells[1]}
			if len(cells) > 2 {
				it.Values = cells[2:]
			}
			items[n] = it
		}
	}
	return items
}

// distinctCells is a row's non-empty cells, a span's repeats dropped.
func distinctCells(row []string) []string {
	var out []string
	for _, c := range row {
		c = NormSpace(c)
		if c == "" || (len(out) > 0 && out[len(out)-1] == c) {
			continue
		}
		out = append(out, c)
	}
	return out
}

// Text is the item's values joined.
func (it ADItem) Text() string { return strings.Join(it.Values, " ") }

// pickItem is item n when its label fits (or it has none, a column
// layout), else the first item whose label does: ANS CR numbers AD 2.2
// without the geoid undulation, so its types of traffic are item 6.
func pickItem(items map[int]ADItem, n int, label *regexp.Regexp) ADItem {
	if it, ok := items[n]; ok {
		if it.Label == "" || label.MatchString(it.Label) {
			return it
		}
		// Avians numbers each item twice, its own language's row first:
		// the English row is the one whose label fits.
		for _, row := range it.More {
			if len(row) > 1 && label.MatchString(row[0]) {
				return ADItem{Label: row[0], Values: row[1:]}
			}
		}
	}
	var nums []int
	for k := range items {
		nums = append(nums, k)
	}
	sort.Ints(nums)
	for _, k := range nums {
		if label.MatchString(items[k].Label) {
			return items[k]
		}
	}
	return items[n]
}

// The labels the x.2 and x.17 items are checked by, in the words and
// abbreviations the AIPs print (a bilingual publisher's first row may be
// its own language, whose IFR/VFR still reads).
var (
	arpLabelRe     = regexp.MustCompile(`(?i)\bARP\b|COORDINATES|REFERENCE POINT`)
	elevLabelRe    = regexp.MustCompile(`(?i)\bELEV|ELEVATION`)
	trafficLabelRe = regexp.MustCompile(`(?i)TRAFFIC|IFR\s*/\s*VFR|VFR\s*/\s*IFR`)
	taLabelRe      = regexp.MustCompile(`(?i)TRANSITION\s+ALT|\bTA\b`)
)

// numberingRow reads a row numbering the columns 1, 2, 3 ... in order
// (three at least), each cell's item number; nil for any other row.
func numberingRow(row []string) []int {
	var cols []int
	prev := 0
	for _, c := range row {
		m := itemNumberRe.FindStringSubmatch(strings.TrimSpace(c))
		if m == nil {
			return nil
		}
		n, _ := strconv.Atoi(m[1])
		if n != prev+1 && n != prev {
			return nil
		}
		prev = n
		cols = append(cols, n)
	}
	if prev < 3 {
		return nil
	}
	return cols
}

func blankRow(row []string) bool {
	for _, c := range row {
		if strings.TrimSpace(c) != "" {
			return false
		}
	}
	return true
}

// adIndexNameRe reads an AD x.1 heading line naming the field: "EFJY -
// JYVÄSKYLÄ", "EIWT — WESTON".
var adIndexNameRe = regexp.MustCompile(`^([A-Z0-9]{4})\s*[-—–]\s*(.+)$`)

// adTitleName reads the field's name off its AD x.1 section when the page
// carries no ADName heading (IDS).
func adTitleName(tables []*Node, icao string) string {
	for _, t := range tables {
		for _, row := range ExpandTable(t) {
			for _, c := range row {
				if m := adIndexNameRe.FindStringSubmatch(NormSpace(c)); m != nil && m[1] == icao {
					return strings.TrimSpace(m[2])
				}
			}
		}
	}
	return ""
}

// ReadAerodrome reads an AD 2 aerodrome page, or an AD 3 heliport page,
// by ICAO's section and item numbers: the reference point, the elevation
// and the types of traffic of x.2 (items 1, 3 and 7), the transition
// altitude of the ATS airspace section (item 5 of 2.17, 3.16), the
// runways of 2.12 with the declared distances of 2.13, and the radio of
// the communication facilities (2.18, 3.17). False when the page states
// no reference point, a stub.
func ReadAerodrome(doc *Node, icao string, heliport bool) (aixm5.Airport, bool) {
	secs := ADSectionTables(doc, icao)
	ap := aixm5.Airport{ID: icao, Designator: icao, Type: "AD"}
	atsSec, comSec := "17", "18"
	if heliport {
		ap.Type = "HP"
		atsSec, comSec = "16", "17"
	}
	ap.Name = ADName(doc, icao)
	if ap.Name == icao {
		if n := adTitleName(secs["1"], icao); n != "" {
			ap.Name = n
		}
	}
	ap.Military = IsMilitaryName(ap.Name)
	if ap.Military {
		ap.ControlType, ap.Access = "MILITARY", "restricted"
	} else {
		ap.ControlType, ap.Access = "CIVIL", "cap"
	}
	general := ADItems(secs["2"])
	lat, lon, ok := 0.0, 0.0, false
	for _, v := range pickItem(general, 1, arpLabelRe).Values {
		if lat, lon, ok = AnyCoord(v); ok {
			break
		}
	}
	if !ok {
		return ap, false
	}
	ap.Lat, ap.Lon = lat, lon
	if ft, ok := firstFt(pickItem(general, 3, elevLabelRe).Values); ok {
		elev := FtToM(float64(ft))
		ap.ElevM = &elev
	}
	if t := strings.ToUpper(pickItem(general, 7, trafficLabelRe).Text()); t != "" {
		ap.VFR = strings.Contains(t, "VFR")
		ap.IFR = strings.Contains(t, "IFR")
	}
	if ft, ok := firstFt(pickItem(ADItems(secs[atsSec]), 5, taLabelRe).Values); ok {
		ta := FtToM(float64(ft))
		ap.TransitionAltM = &ta
	}
	if !heliport {
		ap.Runways = ParseRunways(secs["12"], secs["13"])
	}
	ap.Radio = ParseComTable(secs[comSec])
	for i := range ap.Radio {
		ap.Radio[i].CallSign = EnglishCallSign(ap.Radio[i].CallSign)
	}
	readDirectory(&ap, general, ADItems(secs["3"]))
	return ap, true
}

// The labels of the directory items.
var (
	siteLabelRe = regexp.MustCompile(`(?i)DIRECTION|DISTANCE|\bCITY\b|\bTOWN\b`)
	// KANS words item 6 as the older "AD operating authority".
	operatorLabelRe = regexp.MustCompile(`(?i)OPERATOR|OPERATING\s+AUTHORITY|ADMINISTRATION|\bAD OPR\b|\bOPR\b`)
	remarkLabelRe   = regexp.MustCompile(`(?i)REMARK|\bRMK\b`)
	hoursLabelRe    = regexp.MustCompile(`(?i)OPERATOR|ADMINISTRATION|\bAD\b|AERODROME`)
)

// readDirectory fills the aerodrome's directory, what
// aixm5build.BuildFacilities makes the panel's section of: the site from
// x.2 item 2, the operator and its contacts from item 6, the remark of
// item 8, and the operator's hours, x.3 item 1.
func readDirectory(ap *aixm5.Airport, general, hours map[int]ADItem) {
	if it := pickItem(general, 2, siteLabelRe); it.Label != "" || len(it.Values) > 0 {
		if v := KeepFacilityText(it.Text()); v != "" {
			ap.Notes = append(ap.Notes, aixm5.Note{PropertyName: "airportLocation", Text: v})
		}
	}
	if it := pickItem(general, 8, remarkLabelRe); remarkLabelRe.MatchString(it.Label) {
		if v := KeepFacilityText(it.Text()); v != "" {
			ap.Notes = append(ap.Notes, aixm5.Note{Purpose: "REMARK", Text: v})
		}
	}
	if it := pickItem(hours, 1, hoursLabelRe); it.Label != "" || len(it.Values) > 0 {
		if v := KeepFacilityText(it.Text()); v != "" {
			ap.Hours = append(ap.Hours, v)
		}
	}
	if it := pickItem(general, 6, operatorLabelRe); operatorLabelRe.MatchString(it.Label) {
		if c, ok := ParseOperator(it); ok {
			ap.Contacts = append(ap.Contacts, c)
		}
	}
}

var (
	// contactLabelRe is a label inside the operator's block, the colon
	// optional where the label had a cell of its own. The AFS address
	// (KANS's "AFTN-ARO") only ends what comes before it. ROMATSA writes
	// an abbreviation's full stop before the colon or in its place ("Tel.:",
	// "Tel. : ", "Tel. 0736..."), one number for both ("Tel/Fax:") and a
	// mobile ("Mobil:"). Avinor's "Web page:" and "AFS/AFTN:" end the name
	// too.
	contactLabelRe = regexp.MustCompile(`(?i)(?:^|[\s,;./])(post|postal address|address|tel(?:ephone)?\s*/\s*fax|tel(?:ephone)?|phone|mobile?|telefax|fax|e-?mail|afs(?:\s*/\s*aftn)?|aftn(?:-aro)?|sita|web ?site|website|web ?page|web|internet|url)(?:\.?\s*:|\.\s)`)
	emailRe        = regexp.MustCompile(`[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+`)
	webRe          = regexp.MustCompile(`(?i)\b(?:https?://|www\.)[^\s,;]+[^\s,;.)]`)
	// A number's groups may be parted by a dot ("0736.663.797"), and its
	// country code bracketed ("(+4) 0722.361251").
	phoneRe = regexp.MustCompile(`\(?(?:\+\s?)?\(?\d[\d ()/.-]{5,}\d`)
)

// ParseOperator reads the AD x.2 item 6 block, the operator and its
// contacts, whatever its layout: one cell ("Post: ... Tel: ... Email:
// ..."), a row per field numbered alike (skeyes), or continuation rows
// labelled in a cell of their own (SMATSA). The operator is what comes
// before the first contact label, or the postal address; the e-mail and
// web addresses are taken wherever they stand, the numbers after their
// label.
func ParseOperator(it ADItem) (aixm5.Contact, bool) {
	var parts []string
	add := func(cells []string) {
		switch len(cells) {
		case 0:
		case 1:
			parts = append(parts, cells[0])
		default:
			// A label cell and its value, or a value continuing a label.
			label := strings.TrimRight(strings.TrimSpace(cells[0]), ": ")
			parts = append(parts, label+": "+strings.Join(cells[1:], " "))
		}
	}
	add(it.Values)
	for _, row := range it.More {
		add(row)
	}
	text := NormSpace(strings.Join(parts, " ; "))
	if KeepFacilityText(text) == "" {
		return aixm5.Contact{}, false
	}
	c := aixm5.Contact{}
	c.Email = uniq(emailRe.FindAllString(text, -1))
	for _, w := range webRe.FindAllString(text, -1) {
		if !strings.Contains(w, "@") {
			c.Web = append(c.Web, w)
		}
	}
	c.Web = uniq(c.Web)
	// Cut the block at its labels.
	idx := contactLabelRe.FindAllStringSubmatchIndex(text, -1)
	head := text
	if len(idx) > 0 {
		head = text[:idx[0][2]]
	}
	for i, m := range idx {
		label := strings.ToLower(text[m[2]:m[3]])
		end := len(text)
		if i+1 < len(idx) {
			end = idx[i+1][2]
		}
		value := strings.Trim(text[m[1]:end], " ;,.")
		switch {
		case strings.HasPrefix(label, "tel") && strings.Contains(label, "/"):
			// "Tel/Fax": the numbers answer both.
			c.Phone = append(c.Phone, phoneNumbers(value)...)
			c.Fax = append(c.Fax, phoneNumbers(value)...)
		case strings.HasPrefix(label, "tel") && label != "telefax" || label == "phone" || strings.HasPrefix(label, "mobil"):
			c.Phone = append(c.Phone, phoneNumbers(value)...)
		case label == "fax" || label == "telefax":
			c.Fax = append(c.Fax, phoneNumbers(value)...)
		case label == "post" || strings.HasSuffix(label, "address"):
			if c.Name == "" && strings.Trim(head, " ;,.:") == "" {
				c.Name = value
			} else {
				c.Address = value
			}
		}
	}
	if n := strings.Trim(head, " ;,.:"); n != "" {
		c.Name = n
	}
	c.Phone, c.Fax = uniq(c.Phone), uniq(c.Fax)
	for i := range c.Phone {
		c.Phone[i] = strings.TrimSpace(c.Phone[i])
	}
	for i := range c.Fax {
		c.Fax[i] = strings.TrimSpace(c.Fax[i])
	}
	if c.Name == "" && len(c.Phone) == 0 && len(c.Email) == 0 && len(c.Web) == 0 {
		return aixm5.Contact{}, false
	}
	return c, true
}

// timeRangeRe is office hours, which an operator's block states beside
// its numbers ("(0600-1800", SMATSA).
var timeRangeRe = regexp.MustCompile(`^\(?\d{4}\s*-\s*\d{4}\)?$`)

// phoneNumbers are the numbers of a TEL or FAX value: seven digits at
// least, and never a time range.
func phoneNumbers(value string) []string {
	var out []string
	for _, n := range splitNumberRuns(phoneRe.FindAllString(value, -1)) {
		// SMATSA writes "+ 381 11 ...".
		n = strings.Replace(strings.TrimSpace(n), "+ ", "+", 1)
		digits := 0
		for _, r := range n {
			if r >= '0' && r <= '9' {
				digits++
			}
		}
		if digits >= 7 && !timeRangeRe.MatchString(n) {
			out = append(out, n)
		}
	}
	return out
}

// numberStartRe is where a second number may begin inside a run the
// pattern read as one: a space, then a trunk prefix or a plus.
var numberStartRe = regexp.MustCompile(` [0+]`)

// splitNumberRuns parts a run that is two whole numbers side by side,
// ROMATSA's "0259-321935 0770-605706" at Oradea's heliport: at a space
// before a 0 or a +, where both sides hold nine digits at least. One
// number spaced in groups ("+353 1 621 73 00") never has nine on both
// sides of such a space.
func splitNumberRuns(runs []string) []string {
	digits := func(s string) int {
		n := 0
		for _, r := range s {
			if r >= '0' && r <= '9' {
				n++
			}
		}
		return n
	}
	var out []string
	for _, run := range runs {
		for {
			cut := -1
			for _, m := range numberStartRe.FindAllStringIndex(run, -1) {
				if digits(run[:m[0]]) >= 9 && digits(run[m[0]:]) >= 9 {
					cut = m[0]
					break
				}
			}
			if cut < 0 {
				break
			}
			out = append(out, strings.TrimRight(run[:cut], " /,;-"))
			run = strings.TrimSpace(run[cut:])
		}
		out = append(out, run)
	}
	return out
}

func uniq(in []string) []string {
	var out []string
	seen := map[string]bool{}
	for _, s := range in {
		if s = strings.TrimSpace(s); s != "" && !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

// englishServiceRe is the service word of an English call sign.
var englishServiceRe = regexp.MustCompile(`(?i)^(?:TOWER|GROUND|APPROACH|RADAR|ARRIVAL|DEPARTURE|DELIVERY|INFORMATION|RADIO|CONTROL|DIRECTOR|APRON|CLEARANCE)$`)

func englishService(w string) bool {
	return englishServiceRe.MatchString(strings.Trim(w, "().,;/"))
}

// EnglishCallSign keeps the English half of a call sign a bilingual AIP
// prints in both languages: Fintraffic's "JYVÄSKYLÄN TULO JYVÄSKYLÄ
// ARRIVAL" (its own designation, then the English one), SMATSA's
// "BEOGRAD TORANJ / BEOGRAD TOWER", Avians' "Hornafjörður flugradíó /
// Hornafjordur information". A call sign in English alone is kept, and a
// placeholder ("-") emptied.
func EnglishCallSign(s string) string {
	s = NormSpace(s)
	if strings.Trim(s, "-–— ") == "" {
		return ""
	}
	if parts := strings.Split(s, " / "); len(parts) > 1 {
		for i := len(parts) - 1; i >= 0; i-- {
			for _, w := range strings.Fields(parts[i]) {
				if englishService(w) {
					return strings.TrimSpace(parts[i])
				}
			}
		}
		return s
	}
	words := strings.Fields(s)
	last := -1
	for i, w := range words {
		if englishService(w) {
			last = i
		}
	}
	// The English call sign is the place and its service; what stands
	// before them must be the national designation, no English in it.
	if last < 3 {
		return s
	}
	for _, w := range words[:last-1] {
		if englishService(w) {
			return s
		}
	}
	return strings.Join(words[last-1:last+1], " ")
}

// firstFt is the first value cell reading as feet.
func firstFt(values []string) (int, bool) {
	for _, v := range values {
		if ft, ok := ADFeet(v); ok {
			return ft, true
		}
	}
	return 0, false
}

var (
	// adFtRe and adMRe are a figure marked in feet or in metres; NAV
	// Portugal, HungaroControl, BHANSA and Slovenia Control print the
	// metres first ("69M / 227 FT").
	adFtRe = regexp.MustCompile(`(?i)(\d[\d ]*(?:[.,]\d+)?)\s*(?:FT|FEET)\b`)
	adMRe  = regexp.MustCompile(`(?i)(\d[\d ]*(?:[.,]\d+)?)\s*M\b`)
)

// ADFeet reads an elevation or an altitude in feet: the figure marked FT
// wherever it stands, else one marked M converted, else the first figure,
// taken as feet as ParseFtInt does.
func ADFeet(s string) (int, bool) {
	s = NormSpace(s)
	if m := adFtRe.FindStringSubmatch(s); m != nil {
		// Czechia gives the elevation to the half foot ("793.5 ft").
		v := strings.ReplaceAll(strings.ReplaceAll(strings.TrimSpace(m[1]), " ", ""), ",", ".")
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return int(math.Round(f)), true
		}
	}
	if m := adMRe.FindStringSubmatch(s); m != nil {
		v := strings.ReplaceAll(strings.ReplaceAll(strings.TrimSpace(m[1]), " ", ""), ",", ".")
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return int(math.Round(f / FtPerM)), true
		}
	}
	return ParseFtInt(s)
}
