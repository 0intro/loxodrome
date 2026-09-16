// navaids.go turns the KML navaid and VFR reporting point placemarks
// into aixm5.Navaid records for the shared aixm5build.BuildNavaids.

package main

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/0intro/loxodrome/internal/aixm5"
)

const (
	defaultMinAtNavaids = 80
	defaultMaxAtNavaids = 600
)

const (
	navaidFolder = "07_Navaids"
	vrpFolder    = "08_VFR_Reporting_Points"
)

// navaidFolderType keys the equipment sub-folders of 07_Navaids to the
// SPA navaid type codes.
var navaidFolderType = map[string]string{
	"DME":     "DME",
	"NDB":     "NDB",
	"VOR/DME": "VOR-DME",
	"VOR":     "VOR",
	"TACAN":   "TACAN",
	"VORTAC":  "VORTAC",
}

// freqSuffixRe splits the suffixed frequency form ("110.4MHZ", "426KHZ").
var freqSuffixRe = regexp.MustCompile(`(?i)^([\d.]+)\s*(MHZ|KHZ)$`)

// parseNavaids reads both the radio navigation aids and the VFR
// reporting points. Reporting points are a navaid type in the SPA, with
// their own Layers-tab toggle, and Austro Control groups them per
// aerodrome, which disambiguates the short codes shared between fields.
func parseNavaids(pms []Placemark) []aixm5.Navaid {
	var out []aixm5.Navaid
	for i := range pms {
		pm := &pms[i]
		if pm.Point == nil {
			continue
		}
		switch {
		case lastFolder(pm.Folder, navaidFolder) != "":
			if n, ok := radioNavaid(pm); ok {
				out = append(out, n)
			}
		case lastFolder(pm.Folder, vrpFolder) != "":
			out = append(out, reportingPoint(pm))
		}
	}
	return out
}

func radioNavaid(pm *Placemark) (aixm5.Navaid, bool) {
	kind := ""
	for _, id := range pm.Folder {
		if t, ok := navaidFolderType[id]; ok {
			kind = t
			break
		}
	}
	ident := pm.Field("CODEID")
	if ident == "" {
		ident = pm.Field("IDENT")
	}
	if kind == "" || ident == "" {
		return aixm5.Navaid{}, false
	}
	name := pm.Field("TXTNAME")
	if name == "" {
		name = pm.Field("VOR_TXTNAME")
	}
	if name == "" {
		name = pm.Field("DME_TXTNAME")
	}
	n := aixm5.Navaid{
		ID:         kind + "-" + ident,
		Type:       kind,
		Designator: ident,
		Name:       name,
		Lat:        pm.Point[0],
		Lon:        pm.Point[1],
		Channel:    pm.Field("channel"),
	}
	if mhz, khz := navaidFreq(pm); mhz != nil {
		n.FreqMHz = mhz
	} else if khz != nil {
		n.FreqKHz = khz
	}
	return n, true
}

// navaidFreq resolves the published frequency. The numeric FREQUENCY /
// VALFREQ fields carry MHz for the VOR family and kHz for NDBs; the
// suffixed "frequency" string states the unit and covers the rows that
// publish it alone.
func navaidFreq(pm *Placemark) (mhz, khz *float64) {
	if v := pm.Field("FREQUENCY"); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return &f, nil
		}
	}
	if v := pm.Field("VALFREQ"); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return nil, &f
		}
	}
	if m := freqSuffixRe.FindStringSubmatch(pm.Field("frequency")); m != nil {
		f, err := strconv.ParseFloat(m[1], 64)
		if err == nil {
			if strings.EqualFold(m[2], "MHZ") {
				return &f, nil
			}
			return nil, &f
		}
	}
	return nil, nil
}

func reportingPoint(pm *Placemark) aixm5.Navaid {
	ident := pm.Field("IDENT")
	if ident == "" {
		ident = pm.ID
	}
	// The innermost folder is the aerodrome the point reports to; it
	// keeps the id unique where two fields publish the same letter code.
	aerodrome := ""
	if n := len(pm.Folder); n > 0 {
		aerodrome = pm.Folder[n-1]
	}
	return aixm5.Navaid{
		ID:         strings.TrimSuffix("VRP-"+aerodrome+"-"+ident, "-"),
		Type:       "VFR_REPORTING_POINT",
		Designator: ident,
		Name:       pm.Field("NAM"),
		Lat:        pm.Point[0],
		Lon:        pm.Point[1],
	}
}
