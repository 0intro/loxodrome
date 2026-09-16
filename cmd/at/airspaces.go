// airspaces.go turns the KML airspace placemarks into aixm5.Airspace
// records, so the shared aixm5build.BuildAirspaces emits at-airspaces.json
// with the row schema every other country uses.

package main

import (
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/0intro/loxodrome/internal/aixm5"
	"github.com/0intro/loxodrome/internal/aixm5build"
)

const (
	defaultMinAtAirspaces = 150
	defaultMaxAtAirspaces = 2000
)

// airspaceFolderType keys the Austro Control folder ids to the airspace
// type vocabulary. The military folders keep their own tokens: the
// shared mapAirspaceType folds them onto the charted equivalent (MTMA
// draws as a TMA) while the subtype column preserves the military kind
// for the detail panel.
var airspaceFolderType = map[string]string{
	"0101_Restricted_areas":                  "R",
	"0102_Control_areas":                     "CTA",
	"0103_Terminal_control_areas":            "TMA",
	"0104_Control_zones":                     "CTR",
	"0105_Radio_mandatory_zones":             "RMZ",
	"0106_Transponder_mandatory_zones":       "TMZ",
	"0107_Temporary_reserved_areas":          "TRA",
	"0201_Danger_areas":                      "D",
	"0202_Restricted_areas_military":         "R",
	"0203_Military_terminal_control_areas":   "MTMA",
	"0204_Military_control_zones":            "MCTR",
	"0205_Military_aerodrome_traffic_zones":  "MATZ",
	"0206_Military_temporary_reserved_areas": "MTRA",
	"0207_Military_training_areas":           "MTA",
	"Parachute_jumping_areas":                "PARACHUTE",
	"Gliding_areas":                          "GLIDER",
	"Hang_gliding_and_para_gliding_areas":    "PARAGLIDER",
}

// asmaFolder holds the ATC surveillance minimum altitude sectors. They
// are a controller aid published as airspace-shaped geometry rather than
// a volume pilots fly in, so they stay out of the overlay.
const asmaFolder = "04_ATC_Surveillance_Minimum_Altitudes"

// classBandRe matches the placemark identity Austro Control gives one
// class-banded layer of a CTA / TMA sector, "Luftraumklasse_D".
var classBandRe = regexp.MustCompile(`(?i)^Luftraumklasse[ _]([A-G])$`)

// atAirspacesMeta wraps the shared meta with the KML-parse counters, so
// upstream drift (a renamed folder, a new limit phrasing) is visible
// cycle to cycle.
type atAirspacesMeta struct {
	aixm5build.AirspacesMeta
	Placemarks     int            `json:"placemarks"`
	MultiFootprint int            `json:"multiFootprint"`
	UnparsedLimits []string       `json:"unparsedLimits"`
	FolderCounts   map[string]int `json:"folderCounts"`
}

// airspaceParse is the outcome of walking the KML placemarks.
type airspaceParse struct {
	airspaces      []aixm5.Airspace
	placemarks     int
	multiFootprint int
	unparsed       []string
	folderCounts   map[string]int
}

// parseAirspaces converts every placemark sitting under a known airspace
// folder. A placemark with several distinct footprints emits one row per
// footprint, matching the decoder's per-geometry-component behaviour.
func parseAirspaces(pms []Placemark) airspaceParse {
	out := airspaceParse{folderCounts: map[string]int{}}
	unparsed := map[string]bool{}
	for i := range pms {
		pm := &pms[i]
		folder, kind := airspaceKind(pm.Folder)
		if kind == "" {
			continue
		}
		out.placemarks++
		out.folderCounts[folder]++
		if len(pm.Rings) > 1 {
			out.multiFootprint++
		}

		a := aixm5.Airspace{
			Designator: pm.Field("IDENT"),
			Name:       pm.Field("Name"),
			Type:       kind,
			ClassCode:  bandClass(pm),
		}
		upper, upperNote := parseLimit(pm.Field("Upper Limit"))
		lower, lowerNote := parseLimit(pm.Field("Lower Limit"))
		a.UpperLimit, a.LowerLimit = upper, lower
		a.Rmk = strings.TrimSpace(strings.Join(nonEmpty(upperNote, lowerNote), "; "))
		if upper == nil && pm.Field("Upper Limit") != "" {
			unparsed[pm.Field("Upper Limit")] = true
		}
		if lower == nil && pm.Field("Lower Limit") != "" {
			unparsed[pm.Field("Lower Limit")] = true
		}
		// A sector published in class bands repeats its designator on
		// every band; the SPA keys same-id siblings apart by name and
		// tells them apart by the class column.
		if a.Designator == "" {
			a.Designator = pm.ID
		}
		if a.Name == "" {
			a.Name = a.Designator
		}

		for n, ring := range pm.Rings {
			row := a
			row.ID = fmt.Sprintf("%s-%s", kind, a.Designator)
			if row.ClassCode != "" {
				row.ID += "-" + row.ClassCode
			}
			if n > 0 {
				row.ID = fmt.Sprintf("%s#%d", row.ID, n+1)
			}
			row.Ring = ring
			out.airspaces = append(out.airspaces, row)
		}
	}
	for s := range unparsed {
		out.unparsed = append(out.unparsed, s)
	}
	sort.Strings(out.unparsed)
	return out
}

// airspaceKind finds the category folder enclosing a placemark and
// returns it with its airspace type. The walk runs outermost first, so
// the per-sector and per-aerodrome sub-folders (TMA_LOWW > LOWW1) stay
// under the category that owns them.
func airspaceKind(stack []string) (string, string) {
	for _, id := range stack {
		if id == asmaFolder {
			return "", ""
		}
		if kind, ok := airspaceFolderType[id]; ok {
			return id, kind
		}
	}
	return "", ""
}

// bandClass reads the ICAO class off a class-banded layer placemark.
// Austro Control splits a CTA / TMA sector into one placemark per class,
// identified by the placemark rather than by an ExtendedData field.
func bandClass(pm *Placemark) string {
	for _, s := range []string{pm.ID, pm.Name} {
		if m := classBandRe.FindStringSubmatch(strings.TrimSpace(s)); m != nil {
			return strings.ToUpper(m[1])
		}
	}
	return ""
}

var (
	flLimitRe      = regexp.MustCompile(`(?i)^FL\s*(\d+)$`)
	ftLimitRe      = regexp.MustCompile(`(?i)^(\d+(?:\.\d+)?)\s*(?:FT|FEET)(?:\s+(AMSL|MSL|AGL|ASFC|GND))?$`)
	atLeastLimitRe = regexp.MustCompile(`(?i)^(.*?)\s+but\s+at\s+least\s+.*$`)
)

// parseLimit maps one Austro Control limit string onto the AIXM vertical
// limit the shared verticalTriple encodes, plus a remark for the
// terrain-clearance form.
//
// The vocabulary is "GND", "FL 245", "2500 FT AMSL", "1000 FT AGL", a
// bare "4500 FT" (an altitude AMSL, the form the AIP uses inside a
// class band), and the combined "3500 FT AMSL but at least 1000 FT AGL",
// where the zone floor is the higher of an altitude and a height above
// terrain. The altitude is kept as the limit, which places the floor no
// higher than it really is, and the full phrasing rides along as a
// remark so the panel states the rule.
func parseLimit(s string) (*aixm5.VerticalLimit, string) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, ""
	}
	note := ""
	if m := atLeastLimitRe.FindStringSubmatch(s); m != nil {
		note = s
		s = strings.TrimSpace(m[1])
	}
	switch strings.ToUpper(s) {
	case "GND", "SFC":
		return &aixm5.VerticalLimit{Value: "GND"}, note
	case "UNL":
		return &aixm5.VerticalLimit{Value: "UNL"}, note
	}
	if m := flLimitRe.FindStringSubmatch(s); m != nil {
		return &aixm5.VerticalLimit{Value: m[1], Unit: "FL"}, note
	}
	if m := ftLimitRe.FindStringSubmatch(s); m != nil {
		ref := "MSL"
		switch strings.ToUpper(m[2]) {
		case "AGL", "ASFC", "GND":
			ref = "SFC"
		}
		return &aixm5.VerticalLimit{Value: m[1], Unit: "FT", Ref: ref}, note
	}
	return nil, note
}

func nonEmpty(vals ...string) []string {
	out := make([]string, 0, len(vals))
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			out = append(out, v)
		}
	}
	return out
}
