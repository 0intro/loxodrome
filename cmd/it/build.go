// build.go maps the decoded OFMX snapshot onto the repo's row schemas.
//
// The type table below is grounded in the Italian snapshot's own
// contents, not in a guess at what an OFMX abbreviation stands for; the
// notes name the evidence wherever the reading is not self-evident.

package main

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/0intro/loxodrome/internal/aixm5"
	"github.com/0intro/loxodrome/internal/geodesy"
	"github.com/0intro/loxodrome/internal/overlay"
)

// airspaceType maps an OFMX codeType onto the SPA's own vocabulary
// (AIRSPACE_CATEGORY in src/lib/data/airspaces.ts). An empty string
// means the volume is deliberately not drawn as airspace.
var airspaceType = map[string]string{
	"FIR": "FIR",
	"CTA": "CTA",
	"CTR": "CTR",
	"TMA": "TMA",
	"ATZ": "ATZ",
	"RMZ": "RMZ",
	"TMZ": "TMZ",
	"TRA": "TRA",
	"TSA": "TSA",
	"CBA": "CBA",
	"D":   "D",
	"R":   "R",
	// A volume defined by its ICAO class, the same shape DFS files under
	// CLASS; it draws as a class-banded control area.
	"CLASS": "CTA",
	// Sporting and recreational activity areas. PARA / GLDR / HPGLDR get
	// their own pictogram; MODEL (model aircraft), ULM (microlight) and
	// ACRO (aerobatics) ride the generic activity family.
	"PARA":   "PARACHUTE",
	"GLDR":   "GLIDER",
	"HPGLDR": "PARAGLIDER",
	"MODEL":  "ACTIVITY",
	"ULM":    "ACTIVITY",
	"ACRO":   "ACTIVITY",
	// MTA rows are named after towns and their remarks describe intensive
	// military helicopter activity ("Intensa attivita elicotteristica
	// militare"); AWA rows ring aerodromes and flying clubs. Both are
	// areas where an activity happens, not controlled or restricted
	// volumes.
	"MTA": "ACTIVITY",
	"AWA": "ACTIVITY",
	// Not drawn: an ATC working division, and the volcanic-ash
	// contingency sectors, which exist to be activated by NOTAM rather
	// than to be flown around every day.
	"SECTOR": "",
	"VAS":    "",
	"AWY":    "",
}

// prohibitedDesignatorRe recognises a genuine ICAO prohibited area in
// the Italian snapshot.
//
// This matters: OFMX files 481 volumes under codeType P, and only 277 of
// them are prohibited areas ("LI P215 - SALUZZO"). The rest are national
// and regional nature parks ("PARCO NAZIONALE GRAN PARADISO", "VAL
// TRONCEA", "BRIC TANA"), whose overflight the Italian AIP regulates
// with a minimum height rather than a prohibition. Drawing 200 parks as
// prohibited airspace would be a false statement about where an aircraft
// may fly, so the two are split on the designator and both sides are
// counted in the meta.
var prohibitedDesignatorRe = regexp.MustCompile(`(?i)^LI\s*P\s*\d`)

// designatorRe reads the designator the Italian AIP names a zone by at
// the head of its name: "LI R64/BIS - BARGE", "LI R83C - IVREA", "LI P215
// - SALUZZO". A cross-border "LI/LD D35/A" names no Italian one.
var designatorRe = regexp.MustCompile(`^LI ?([RDP]) ?(\d{1,3})([A-Z]{0,3})(?: ?/ ?([A-Z0-9]{1,3}))?\b`)

// designatorID returns the id of a zone the Italian AIP designates, in
// the form a NOTAM cites it by ("RESTRICTED AREA LI R309/A - CASACALENDA
// ACTIVATED"): the prefix, the letter, the unpadded number and its
// sub-letters, the slash dropped (LIR64BIS, LIR83C, LIR309A). It returns
// "" for a name that carries no designator.
func designatorID(name string) string {
	m := designatorRe.FindStringSubmatch(strings.ToUpper(strings.TrimSpace(name)))
	if m == nil {
		return ""
	}
	n, err := strconv.Atoi(m[2])
	if err != nil {
		return ""
	}
	return "LI" + m[1] + strconv.Itoa(n) + m[3] + m[4]
}

// isProhibited reports whether a codeType P volume is a real prohibited
// area rather than a protected natural site.
func isProhibited(a *Airspace) bool {
	return prohibitedDesignatorRe.MatchString(strings.TrimSpace(a.Name))
}

// buildStats counts what a run degraded or dropped, so a source change
// shows up as a number rather than as silently missing airspace.
type buildStats struct {
	skippedType    int
	skippedNoGeo   int
	natureRows     int
	borderStitched int
	borderChords   int
	arcChords      int
	unitsRepaired  int
}

// verticalTriple maps an OFMX limit onto the [code, value, uom] triple
// the row schema carries, and reports whether it repaired the unit. OFMX
// uses the AIXM 4.5 vocabulary the SIA does, so the codes pass through:
// STD is a flight level, ALT an altitude, HEI a height above the surface.
//
// The community data sometimes files a unit its code contradicts, and the
// code wins, since the app reads a flight level off the unit alone. STD is
// written in FL: a figure filed in FT is the level itself below 1000 (STD
// 95 FT, a class D ceiling, is FL95) and feet from 1000 up (STD 6000 FT is
// FL60). ALT and HEI are written in feet, a figure filed as FL included
// (ALT 5500 FL is 5500 ft, HEI 400 FL a drone ceiling of 400 ft).
func verticalTriple(ref, val, uom string) ([]string, bool) {
	ref = strings.ToUpper(strings.TrimSpace(ref))
	val = strings.TrimSpace(val)
	uom = strings.ToUpper(strings.TrimSpace(uom))
	switch ref {
	case "":
		return nil, false
	case "UNL":
		return []string{"UNL", "", ""}, false
	case "SFC", "GND":
		return []string{"HEI", "0", "FT"}, false
	}
	if val == "" {
		return nil, false
	}
	switch {
	case ref == "STD" && uom == "FT":
		v, err := strconv.ParseFloat(val, 64)
		if err != nil {
			return nil, false
		}
		if v >= 1000 {
			v /= 100
		}
		return []string{ref, strconv.FormatFloat(v, 'f', -1, 64), "FL"}, true
	case (ref == "ALT" || ref == "HEI") && uom == "FL":
		return []string{ref, val, "FT"}, true
	case uom == "":
		uom = "FT"
	}
	return []string{ref, val, uom}, false
}

// airspaceRows turns the decoded airspaces into artifact rows, and
// returns the nature zones split off from them.
func airspaceRows(snap *Snapshot, stats *buildStats) ([]overlay.Row, []Airspace) {
	var rows []overlay.Row
	var nature []Airspace
	for i := range snap.Airspaces {
		a := &snap.Airspaces[i]
		code := strings.ToUpper(strings.TrimSpace(a.CodeType))

		// The nature sites: every NRA, and the codeType P volumes that
		// carry no prohibited-area designator.
		if code == "NRA" || (code == "P" && !isProhibited(a)) {
			nature = append(nature, *a)
			stats.natureRows++
			continue
		}
		emit, known := airspaceType[code]
		if code == "P" {
			emit, known = "P", true
		}
		if !known || emit == "" {
			stats.skippedType++
			continue
		}
		ring := ringFrom(a.Vertices, snap.Borders, stats)
		if len(ring) < 3 {
			stats.skippedNoGeo++
			continue
		}
		// A designated zone goes by its designator, the snapshot's code being
		// the database's own (LI99133 for LI R64/BIS - BARGE).
		id := designatorID(a.Name)
		if id == "" {
			id = a.CodeID
		}
		name := a.Name
		if name == "" {
			name = id
		}
		upper, repaired := verticalTriple(a.UpperRef, a.UpperVal, a.UpperUOM)
		if repaired {
			stats.unitsRepaired++
		}
		lower, repaired := verticalTriple(a.LowerRef, a.LowerVal, a.LowerUOM)
		if repaired {
			stats.unitsRepaired++
		}
		rows = append(rows, overlay.Row{
			ID:    id,
			Type:  emit,
			Name:  name,
			Class: strings.ToUpper(strings.TrimSpace(a.Class)),
			Upper: upper,
			Lower: lower,
			Ring:  ring,
		})
	}
	return rows, nature
}

// aerodromeType maps the OFMX aerodrome kind onto the AIXM type the
// shared airport builder reads: AD an aerodrome, HP a heliport, LS a
// landing site (the microlight and emergency-landing sites).
func aerodromeType(code string) string {
	switch strings.ToUpper(strings.TrimSpace(code)) {
	case "HP":
		return "HP"
	case "UL", "ELS":
		return "LS"
	}
	return "AD"
}

// airportValues turns the decoded aerodromes into aixm5.Airport values
// for the shared builder, the way cmd/at and cmd/be do.
func airportValues(snap *Snapshot) []aixm5.Airport {
	out := make([]aixm5.Airport, 0, len(snap.Airports))
	for i := range snap.Airports {
		a := &snap.Airports[i]
		if a.CodeID == "" {
			continue
		}
		ap := aixm5.Airport{
			ID:         a.CodeID,
			Designator: a.CodeID,
			Type:       aerodromeType(a.Type),
			Name:       a.Name,
			Lat:        a.Lat,
			Lon:        a.Lon,
		}
		usage(&ap, a.Permits)
		if m, ok := lengthMetres(a.Elev, a.ElevUOM); ok {
			ap.ElevM = &m
		}
		for _, r := range a.Runways {
			le, he, _ := strings.Cut(r.Designator, "/")
			rw := aixm5.Runway{
				Le:      strings.TrimSpace(le),
				He:      strings.TrimSpace(he),
				Surface: strings.TrimSpace(r.Surface),
			}
			if m, ok := lengthMetres(r.Length, r.DimUOM); ok {
				rw.LengthM = &m
			}
			if m, ok := lengthMetres(r.Width, r.DimUOM); ok {
				rw.WidthM = &m
			}
			ap.Runways = append(ap.Runways, rw)
		}
		out = append(out, ap)
	}
	return out
}

// usage sets who may use an aerodrome from the flights its Ahu permits.
// A field permitting military flights alone is a military aerodrome,
// restricted (GHEDI MIL, TRAPANI/BIRGI "open to authorized civil
// traffic"), one permitting them beside others a joint one. A field
// permitting civil or other flights takes public air traffic, and an
// empty permit list leaves the access to the baseline.
func usage(ap *aixm5.Airport, permits []Permit) {
	var mil, other bool
	for _, p := range permits {
		if p.Mil == "MIL" {
			mil = true
		} else {
			other = true
		}
		ap.VFR = ap.VFR || p.Rule == "V" || p.Rule == "IV"
		ap.IFR = ap.IFR || p.Rule == "I" || p.Rule == "IV"
	}
	switch {
	case mil && other:
		ap.Military, ap.Joint, ap.Access = true, true, "cap"
	case mil:
		ap.Military, ap.Access = true, "restricted"
	case other:
		ap.Access = "cap"
	}
}

// dpnMaxFromAerodromeNM is how far a designated point may lie from the
// aerodrome it is filed under. Over the LI snapshot the points sit within
// 44 NM of theirs (99% within 36 NM); the next distance is LNNE1=BINAGO's
// second copy, 319 NM away at 16.51E where the first is at 8.92E, a
// longitude typed wrong. The limit sits well clear of both.
const dpnMaxFromAerodromeNM = 100

// vortacMaxM is how far a TACAN may stand from the VOR whose ident it
// shares and still be that VORTAC's half. The seven Italian VORTACs file
// both at one position, and idents repeat across kinds: TRAPANI's NDB is
// TRP too, 2.7 km from its VORTAC.
const vortacMaxM = 500

// navaidValues turns the decoded navaids and designated points into
// aixm5.Navaid values, and reports how many designated points it dropped
// for lying further than dpnMaxFromAerodromeNM from their aerodrome.
//
// A DME or TACAN co-located with a VOR is filed as its own feature
// sharing the VOR's ident, so the pair folds into one VOR-DME or VORTAC
// row, which is the composite the shared builder and the SPA both speak.
// A VORTAC carries its TACAN's channel.
//
// A designated point is filed under the aerodrome it serves, which is what
// places an error: a point far from its own aerodrome is dropped, and of
// two copies of one id both near theirs, the nearer stays, an exact tie
// going to the southernmost then westernmost so the file order decides
// nothing. Copies the distance cannot decide (no aerodrome) are both passed
// on, for the shared builder to keep once if identical or to keep each
// under its own id. The drops are counted: far from their aerodrome, and
// farther copies of a point kept nearer.
func navaidValues(snap *Snapshot) ([]aixm5.Navaid, dpnDrops) {
	vors := map[string]Point{}
	for i := range snap.Navaids {
		if n := &snap.Navaids[i]; n.Kind == "VOR" {
			vors[n.CodeID] = Point{Lat: n.Lat, Lon: n.Lon}
		}
	}
	hasDme := map[string]bool{}
	hasTcn := map[string]bool{}
	// vortac holds the channel of each TACAN standing with its VOR, by
	// their ident.
	vortac := map[string]string{}
	for i := range snap.Navaids {
		n := &snap.Navaids[i]
		switch n.Kind {
		case "DME":
			hasDme[n.CodeID] = true
		case "TCN":
			hasTcn[n.CodeID] = true
			if v, ok := vors[n.CodeID]; ok && geodesy.DistanceM(v.Lat, v.Lon, n.Lat, n.Lon) <= vortacMaxM {
				vortac[n.CodeID] = n.Channel
			}
		}
	}

	aerodromes := make(map[string]Point, len(snap.Airports))
	for i := range snap.Airports {
		// An aerodrome with no mid is nobody's: indexed under "", every
		// en-route point (filed under no aerodrome) would be measured
		// against it.
		if snap.Airports[i].Mid != "" {
			aerodromes[snap.Airports[i].Mid] = Point{Lat: snap.Airports[i].Lat, Lon: snap.Airports[i].Lon}
		}
	}
	// The aerodromes whose far designated points are dropped. A point far
	// from its aerodrome is a copy typed wrong where that aerodrome has
	// points near it. One whose own position is wrong has none, and
	// dropping by distance there lost every correct point filed under it:
	// its points stay when they agree among themselves (two or more, each
	// within dpnMaxFromAerodromeNM of their middle), which is how a
	// misplaced aerodrome's look. A lone far point, or scattered ones,
	// cannot say which position is wrong, and a point drawn hundreds of NM
	// from where it is would mislead: they go, as far points always did.
	dropFar := map[string]bool{}
	farPoints := map[string][]Point{}
	for i := range snap.Navaids {
		n := &snap.Navaids[i]
		if n.Kind != "DPN" || n.AhpMid == "" {
			continue
		}
		ad, ok := aerodromes[n.AhpMid]
		if !ok {
			continue
		}
		if geodesy.DistanceM(ad.Lat, ad.Lon, n.Lat, n.Lon) <= dpnMaxFromAerodromeNM*1852 {
			dropFar[n.AhpMid] = true
		} else {
			farPoints[n.AhpMid] = append(farPoints[n.AhpMid], Point{Lat: n.Lat, Lon: n.Lon})
		}
	}
	for mid, pts := range farPoints {
		if dropFar[mid] {
			continue
		}
		var mid0 Point
		for _, p := range pts {
			mid0.Lat += p.Lat / float64(len(pts))
			mid0.Lon += p.Lon / float64(len(pts))
		}
		agree := len(pts) >= 2
		for _, p := range pts {
			if geodesy.DistanceM(mid0.Lat, mid0.Lon, p.Lat, p.Lon) > dpnMaxFromAerodromeNM*1852 {
				agree = false
			}
		}
		dropFar[mid] = !agree
	}
	// dpnAt indexes the designated points kept so far by id, with their
	// distance to their aerodrome.
	type placed struct {
		at    int
		distM float64
	}
	dpnAt := map[string]placed{}
	var drops dpnDrops

	out := make([]aixm5.Navaid, 0, len(snap.Navaids))
	for i := range snap.Navaids {
		n := &snap.Navaids[i]
		if n.CodeID == "" {
			continue
		}
		var typ string
		channel := n.Channel
		switch n.Kind {
		case "VOR":
			tacan, isVortac := vortac[n.CodeID]
			switch {
			case isVortac:
				typ, channel = "VORTAC", tacan
			case hasDme[n.CodeID]:
				typ = "VOR-DME"
			default:
				typ = "VOR"
			}
		case "NDB":
			typ = "NDB"
		case "DME":
			// Folded into its VOR when there is one.
			if hasTcn[n.CodeID] {
				continue
			}
			typ = "DME"
		case "TCN":
			// Folded into the VOR it stands with.
			if _, ok := vortac[n.CodeID]; ok {
				continue
			}
			typ = "TACAN"
		case "DPN":
			// Every Italian designated point in the snapshot is a VFR
			// reporting point (VFR-MRP mandatory, VFR-RP on request,
			// VFR-ENR en-route); compulsory versus on-request is a route
			// property, not a point property, so they draw as the hollow
			// triangle.
			typ = "VFR_REPORTING_POINT"
		default:
			continue
		}
		// A DME sharing a VOR's ident is that VOR's distance half; the
		// composite row already carries it.
		_, isVor := vors[n.CodeID]
		if n.Kind == "DME" && (hasTcn[n.CodeID] || isVor) {
			continue
		}
		nv := aixm5.Navaid{
			ID:         typ + ":" + n.CodeID,
			Designator: n.CodeID,
			Type:       typ,
			Name:       n.Name,
			Lat:        n.Lat,
			Lon:        n.Lon,
			Channel:    channel,
		}
		nv.FreqMHz, nv.FreqKHz = frequency(n.Freq, n.FreqUOM)
		if n.Kind == "DPN" && n.AhpMid != "" {
			if ad, ok := aerodromes[n.AhpMid]; ok {
				d := geodesy.DistanceM(ad.Lat, ad.Lon, n.Lat, n.Lon)
				if d > dpnMaxFromAerodromeNM*1852 && dropFar[n.AhpMid] {
					drops.far++
					continue
				}
				if prev, dup := dpnAt[nv.ID]; dup {
					drops.farther++
					kept := out[prev.at]
					// The nearer copy; at one distance the content decides,
					// the position then the name and the channel, never the
					// file's order.
					if d < prev.distM || (d == prev.distM && dpnBefore(nv, kept)) {
						out[prev.at] = nv
						dpnAt[nv.ID] = placed{at: prev.at, distM: d}
					}
					continue
				}
				dpnAt[nv.ID] = placed{at: len(out), distM: d}
			}
		}
		out = append(out, nv)
	}
	return out, drops
}

// dpnBefore orders two copies of a designated point at one distance from
// their aerodrome by content: the position, then the name, then the
// channel.
func dpnBefore(a, b aixm5.Navaid) bool {
	switch {
	case a.Lat != b.Lat:
		return a.Lat < b.Lat
	case a.Lon != b.Lon:
		return a.Lon < b.Lon
	case a.Name != b.Name:
		return a.Name < b.Name
	}
	return a.Channel < b.Channel
}

// dpnDrops counts the designated points navaidValues drops: far from the
// aerodrome they are filed under, and the farther copy of a point one id
// carries twice near its aerodrome.
type dpnDrops struct {
	far, farther int
}

// lengthMetres parses a length with its unit into metres.
func lengthMetres(val, uom string) (float64, bool) {
	v, err := strconv.ParseFloat(strings.TrimSpace(val), 64)
	if err != nil || v == 0 {
		return 0, false
	}
	switch strings.ToUpper(strings.TrimSpace(uom)) {
	case "M", "":
		return v, true
	case "FT":
		return v * 0.3048, true
	case "KM":
		return v * 1000, true
	case "NM":
		return v * 1852, true
	}
	return 0, false
}

// frequency parses a navaid frequency into the field of its unit, MHz or
// kHz: a VOR is filed in MHz, an NDB carrier in kHz.
func frequency(val, uom string) (mhz, khz *float64) {
	v, err := strconv.ParseFloat(strings.TrimSpace(val), 64)
	if err != nil || v <= 0 {
		return nil, nil
	}
	if strings.EqualFold(strings.TrimSpace(uom), "KHZ") {
		return nil, &v
	}
	return &v, nil
}
