// airspaces.go maps LFV's airspace typenames onto aixm5.Airspace.
//
// Each WFS typename is one kind of volume, so the typename IS the airspace
// type, refined by the designator where the AIP's own letter says more
// (a prohibited area filed among the restricted ones). The class is
// COMMENT_1 and the remarks COMMENT_2, in the language the AIP wrote them.

package main

import (
	"regexp"
	"strings"

	"github.com/0intro/loxodrome/internal/aixm5"
	"github.com/0intro/loxodrome/internal/gis"
	"github.com/0intro/loxodrome/internal/overlay"
)

// airspaceTypes is what each typename files as. Absent typenames are not
// read at all: the FIR and UIR rings come from pruatlas like every other
// publisher's; AOR and the ATC sectors are controller divisions, not
// volumes a pilot enters; TMAW is the TMA whole, drawn already by its
// sectors (TMAS), which carry the limits and the class the whole does not.
var airspaceTypes = map[string]string{
	"CTR":  "CTR",
	"TMAS": "TMA",
	// Sweden's traffic information zones and areas are radio mandatory
	// zones: every one is named "<X> TIZ/RMZ" or "<X> TIA/RMZ" in the AIP
	// itself. They are filed under their own word, which the shared
	// builder maps onto the RMZ family and keeps as the subtype.
	"TIZ":   "TIZ",
	"TIA":   "TIA",
	"ATZ":   "ATZ",
	"RSTA":  "R",
	"DNGA":  "D",
	"TRA":   "TRA",
	"CBA":   "CBA",
	"DELEG": "DLG-ATS",
}

// airspaceTypenames are read in this order, which is the order the rows
// are emitted in.
var airspaceTypenames = []string{"CTR", "TMAS", "TIZ", "TIA", "ATZ", "RSTA", "DNGA", "TRA", "CBA", "DELEG"}

// designatorRe reads an ICAO area designator out of a name: "ES R104C",
// "ES D182", "ESTRA80 med", "EUCBA10". The letter after the State's ES is
// the area's family.
var designatorRe = regexp.MustCompile(`^(ES)\s*([PRD])\s*(\d+[A-Z]?)\b|^((?:ES|EU)(?:TRA|TSA|CBA)\s*\d+[A-Z]?)\b`)

// airspaceStats counts what the mapping could not use, for the meta.
type airspaceStats struct {
	NoGeometry     int            `json:"noGeometry"`
	DatumFromEAIP  int            `json:"datumFromEaip"`
	UnparsedLimits map[string]int `json:"unparsedLimits,omitempty"`
}

// parseAirspaces maps one typename's features.
func parseAirspaces(typename string, feats []gis.Feature, hints *datumHints, st *airspaceStats) []aixm5.Airspace {
	kind, ok := airspaceTypes[typename]
	if !ok {
		return nil
	}
	var out []aixm5.Airspace
	for _, f := range feats {
		p := f.Properties
		name := strings.Join(strings.Fields(gis.Prop(p, "NAMEOFAREA")), " ")
		// A designated area's NAMEOFAREA is its designator alone ("ES
		// R104C"); LOCATION adds the place ("ES R104C KÄNSÖ"), which is
		// what the panel should title it with.
		title := name
		if loc := strings.Join(strings.Fields(gis.Prop(p, "LOCATION")), " "); len(loc) > len(name) && strings.HasPrefix(loc, name) {
			title = loc
		}
		rings, err := overlay.GeomToRings(f.Geometry)
		if err != nil || len(rings) == 0 {
			st.NoGeometry++
			continue
		}
		typ := kind
		designator := ""
		if m := designatorRe.FindStringSubmatch(strings.ToUpper(name)); m != nil {
			if m[1] != "" {
				designator = m[1] + m[2] + m[3]
				if typename == "RSTA" && m[2] == "P" {
					// Prohibited areas are filed among the restricted ones.
					typ = "P"
				}
			} else {
				designator = strings.ReplaceAll(m[4], " ", "")
			}
		}
		id := designator
		if id == "" {
			id = "SE-" + slug(name)
		}
		upper := parseLimit(gis.Prop(p, "UPPER"), name, hints, st)
		lower := parseLimit(gis.Prop(p, "LOWER"), name, hints, st)
		for _, ring := range rings {
			out = append(out, aixm5.Airspace{
				ID:         id,
				Designator: designator,
				Name:       title,
				Type:       typ,
				ClassCode:  classLetter(gis.Prop(p, "COMMENT_1")),
				UpperLimit: upper,
				LowerLimit: lower,
				Ring:       ring,
				Rmk:        strings.TrimSpace(gis.Prop(p, "COMMENT_2")),
			})
		}
	}
	return out
}

// classLetter keeps a single ICAO class letter; anything else (a blank on
// the restricted areas) is no class.
func classLetter(s string) string {
	s = strings.ToUpper(strings.TrimSpace(s))
	if len(s) == 1 && s[0] >= 'A' && s[0] <= 'G' {
		return s
	}
	return ""
}

var (
	flLimitRe = regexp.MustCompile(`^FL\s*(\d{1,3})$`)
	ftLimitRe = regexp.MustCompile(`^(\d{1,6})$`)
)

// parseLimit reads LFV's limit strings: "GND", "UNL", "FL 95", or a bare
// number of feet. The bare number carries no datum; AIP Sweden writes its
// limits in ft AMSL, and states otherwise in words ("400 ft SFC", "1000 ft
// GND") the WFS drops, which the eAIP's own row gives back (datum.go).
func parseLimit(s, name string, hints *datumHints, st *airspaceStats) *aixm5.VerticalLimit {
	v := strings.ToUpper(strings.TrimSpace(s))
	switch v {
	case "":
		return nil
	case "GND", "SFC":
		return &aixm5.VerticalLimit{Value: "GND"}
	case "UNL":
		return &aixm5.VerticalLimit{Value: "UNL"}
	}
	if m := flLimitRe.FindStringSubmatch(v); m != nil {
		return &aixm5.VerticalLimit{Value: m[1], Unit: "FL", Ref: "STD"}
	}
	if m := ftLimitRe.FindStringSubmatch(v); m != nil {
		ref := "MSL"
		if hints.surface(name, m[1]) {
			ref = "SFC"
			st.DatumFromEAIP++
		}
		return &aixm5.VerticalLimit{Value: m[1], Unit: "FT", Ref: ref}
	}
	if st.UnparsedLimits == nil {
		st.UnparsedLimits = map[string]int{}
	}
	st.UnparsedLimits[v]++
	return nil
}

// slug is an id-safe form of a name: upper case, runs of anything but a
// letter or a digit folded to one hyphen.
func slug(s string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToUpper(s) {
		if (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == 'Å' || r == 'Ä' || r == 'Ö' {
			b.WriteRune(r)
			dash = false
		} else if !dash && b.Len() > 0 {
			b.WriteByte('-')
			dash = true
		}
	}
	return strings.TrimSuffix(b.String(), "-")
}
