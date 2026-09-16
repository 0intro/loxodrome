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
}

// verticalTriple maps an OFMX limit onto the [code, value, uom] triple
// the row schema carries. OFMX uses the AIXM 4.5 vocabulary the SIA does,
// so the codes pass through: STD is a flight level, ALT an altitude, HEI
// a height above the surface.
func verticalTriple(ref, val, uom string) []string {
	ref = strings.ToUpper(strings.TrimSpace(ref))
	val = strings.TrimSpace(val)
	uom = strings.ToUpper(strings.TrimSpace(uom))
	switch ref {
	case "":
		return nil
	case "UNL":
		return []string{"UNL", "", ""}
	case "SFC", "GND":
		return []string{"HEI", "0", "FT"}
	}
	if val == "" {
		return nil
	}
	if uom == "" {
		uom = "FT"
	}
	return []string{ref, val, uom}
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
		id := a.CodeID
		name := a.Name
		if name == "" {
			name = id
		}
		rows = append(rows, overlay.Row{
			ID:    id,
			Type:  emit,
			Name:  name,
			Class: strings.ToUpper(strings.TrimSpace(a.Class)),
			Upper: verticalTriple(a.UpperRef, a.UpperVal, a.UpperUOM),
			Lower: verticalTriple(a.LowerRef, a.LowerVal, a.LowerUOM),
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
			VFR:        true,
			Access:     "cap",
		}
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

// navaidValues turns the decoded navaids and designated points into
// aixm5.Navaid values.
//
// A DME or TACAN co-located with a VOR is filed as its own feature
// sharing the VOR's ident, so the pair folds into one VOR-DME or VORTAC
// row, which is the composite the shared builder and the SPA both speak.
func navaidValues(snap *Snapshot) []aixm5.Navaid {
	hasDme := map[string]bool{}
	hasTcn := map[string]bool{}
	for i := range snap.Navaids {
		switch snap.Navaids[i].Kind {
		case "DME":
			hasDme[snap.Navaids[i].CodeID] = true
		case "TCN":
			hasTcn[snap.Navaids[i].CodeID] = true
		}
	}

	out := make([]aixm5.Navaid, 0, len(snap.Navaids))
	for i := range snap.Navaids {
		n := &snap.Navaids[i]
		if n.CodeID == "" {
			continue
		}
		var typ string
		switch n.Kind {
		case "VOR":
			switch {
			case hasTcn[n.CodeID]:
				typ = "VORTAC"
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
		if n.Kind == "DME" && (hasTcn[n.CodeID] || vorIdents(snap)[n.CodeID]) {
			continue
		}
		nv := aixm5.Navaid{
			ID:         typ + ":" + n.CodeID,
			Designator: n.CodeID,
			Type:       typ,
			Name:       n.Name,
			Lat:        n.Lat,
			Lon:        n.Lon,
			Channel:    n.Channel,
		}
		if f, ok := freqMHz(n.Freq, n.FreqUOM); ok {
			nv.FreqMHz = &f
		}
		out = append(out, nv)
	}
	return out
}

// vorIdents is the set of idents a VOR is filed under.
func vorIdents(snap *Snapshot) map[string]bool {
	out := map[string]bool{}
	for i := range snap.Navaids {
		if snap.Navaids[i].Kind == "VOR" {
			out[snap.Navaids[i].CodeID] = true
		}
	}
	return out
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

// freqMHz parses a navaid frequency into MHz. An NDB carrier is filed in
// kHz, which the shared builder formats back to kHz off the type.
func freqMHz(val, uom string) (float64, bool) {
	v, err := strconv.ParseFloat(strings.TrimSpace(val), 64)
	if err != nil || v <= 0 {
		return 0, false
	}
	if strings.EqualFold(strings.TrimSpace(uom), "KHZ") {
		return v / 1000, true
	}
	return v, true
}
