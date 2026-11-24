// points.go maps LFV's point typenames onto aixm5 navaids and aerodromes.

package main

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/0intro/loxodrome/internal/aixm5"
	"github.com/0intro/loxodrome/internal/eaip"
	"github.com/0intro/loxodrome/internal/gis"
)

// navaidTypenames are read in this order. The designated points split the
// repo's way: the five-letter ICAO points (DNPT) and the RNAV terminal
// points (WPT) are waypoints; the CTR entry / exit points (ECTR) and the
// VFR holding points (VFRH) are what a VFR pilot reports over, the hollow
// triangle.
var navaidTypenames = []string{"VOR", "DMEV", "DME", "NDB", "DNPT", "WPT", "ECTR", "VFRH"}

var (
	freqRe    = regexp.MustCompile(`(?i)(\d+(?:\.\d+)?)\s*(MHZ|KHZ)`)
	channelRe = regexp.MustCompile(`(?i)\bchannel\s*:?\s*(\d{1,3}[XY])\b`)
)

// navaidStats counts what could not be placed, for the meta.
type navaidStats struct {
	NoPosition int `json:"noPosition"`
}

func parseNavaids(typename string, feats []gis.Feature, st *navaidStats) []aixm5.Navaid {
	var out []aixm5.Navaid
	for _, f := range feats {
		p := f.Properties
		lat, lon, ok := gis.Point(f.Geometry)
		if !ok {
			st.NoPosition++
			continue
		}
		ident := gis.Prop(p, "NAMEOFPOINT")
		loc := gis.Prop(p, "LOCATION")
		n := aixm5.Navaid{Lat: eaip.Round5(lat), Lon: eaip.Round5(lon), Designator: ident, Name: loc}
		switch typename {
		case "VOR":
			n.Type = "VOR"
		case "DMEV":
			n.Type = "VOR-DME"
		case "DME":
			n.Type = "DME"
		case "NDB":
			n.Type = "NDB"
		case "DNPT", "WPT":
			n.Type = "WAYPOINT"
			n.Name = ident
		case "ECTR":
			// The point's name is its LOCATION; NAMEOFPOINT is the number
			// the aerodrome's chart gives it.
			n.Type = "VFR_REPORTING_POINT"
			n.Designator = loc
			n.Name = loc
		case "VFRH":
			n.Type = "VFR_REPORTING_POINT"
			n.Name = ident
		default:
			continue
		}
		if n.Name == "" {
			n.Name = n.Designator
		}
		// A navaid's name is its place; LFV prefixes some with the
		// aerodrome and the kind ("ESNO DMEV OSK"), which says nothing
		// the row does not.
		if parts := strings.Fields(n.Name); len(parts) == 3 && parts[1] == typename && parts[2] == ident {
			n.Name = ident
		}
		if m := freqRe.FindStringSubmatch(gis.Prop(p, "FREQ")); m != nil {
			v, err := strconv.ParseFloat(m[1], 64)
			if err == nil {
				if strings.EqualFold(m[2], "KHZ") {
					n.FreqKHz = &v
				} else if n.Type != "DME" {
					// A DME's FREQ is its paired VHF channel, not a frequency
					// anyone tunes it by; its channel says the same.
					n.FreqMHz = &v
				}
			}
		}
		if m := channelRe.FindStringSubmatch(gis.Prop(p, "COMMENT_1")); m != nil {
			n.Channel = strings.ToUpper(m[1])
		}
		if ft, ok := gis.PropNum(p, "MSL"); ok && typename != "DNPT" && typename != "WPT" {
			m := eaip.FtToM(ft)
			n.ElevM = &m
		}
		n.ID = typename + ":" + n.Designator + ":" + gis.Prop(p, "POSITIONINDICATOR")
		out = append(out, n)
	}
	return out
}

// trafficRe reads the ARP's "Traffic permitted: IV".
var trafficRe = regexp.MustCompile(`(?i)traffic permitted:\s*([IV]+)`)

// parseAerodromes maps the aerodrome (ARP) and heliport (HKP_ARP)
// reference points. LFV gives the ARP its ICAO indicator, its name and the
// traffic permitted, and the heliport its elevation; runways, frequencies
// and the rest are AD 2's (the merge keeps the baseline's meanwhile).
func parseAerodromes(typename string, feats []gis.Feature, st *navaidStats) []aixm5.Airport {
	var out []aixm5.Airport
	for _, f := range feats {
		p := f.Properties
		lat, lon, ok := gis.Point(f.Geometry)
		icao := strings.ToUpper(gis.Prop(p, "POSITIONINDICATOR"))
		if !ok || icao == "" {
			st.NoPosition++
			continue
		}
		a := aixm5.Airport{
			ID:         icao,
			Designator: icao,
			Name:       gis.Prop(p, "LOCATION"),
			Lat:        eaip.Round5(lat),
			Lon:        eaip.Round5(lon),
			Type:       "AD",
		}
		if typename == "HKP_ARP" {
			a.Type = "HP"
		}
		if m := trafficRe.FindStringSubmatch(gis.Prop(p, "COMMENT_2")); m != nil {
			a.IFR = strings.Contains(strings.ToUpper(m[1]), "I")
			a.VFR = strings.Contains(strings.ToUpper(m[1]), "V")
		}
		if ft, ok := gis.PropNum(p, "MSL"); ok {
			m := eaip.FtToM(ft)
			a.ElevM = &m
		}
		out = append(out, a)
	}
	return out
}
