// points.go emits faa-navaids.json from the FAA AIS layers: the radio
// navaids (NAVAIDSystem for the kind and position, the edition's NASR
// register for the frequency, channel, elevation and status, nasr.go, and
// NavaidComponent for the foreign stations NASR does not list, each navaid
// reading only its own components, see BuildNavaids) and the designated
// points (RNAV waypoints and reporting points).
//
// The row schema is the shared <cc>-navaids.json one, so the SPA reads
// this file with the same loader as every AIXM publisher's; the "faa:"
// id prefix is what navaidSourceFromId keys the publisher off.

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/geodesy"
)

const (
	navaidSystemURL    = "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/NAVAIDSystem/FeatureServer/0/query"
	navaidComponentURL = "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/NAVAIDComponent/FeatureServer/0/query"
	designatedPointURL = "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/DesignatedPoints/FeatureServer/0/query"

	// Pre-release twins, published during the FAA's own pre-release
	// window and stale outside it (see edition.go).
	navaidSystemNextURL    = "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/Pending_NAVAID/FeatureServer/0/query"
	designatedPointNextURL = "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/Pending_Designated_Point/FeatureServer/0/query"

	defaultMinUsNavaids = 5000
	defaultMaxUsNavaids = 60000
)

// navaidTypeByCode maps the NASR navaid type code onto the SPA's navaid
// vocabulary (NAVAID_LABELS in src/lib/data/navaids.ts).
//
// The FAA publishes the kind as an integer, with the human-readable
// class alongside in CLASS_TXT. The mapping below was read off the data:
// every distinct (TYPE_CODE, CLASS_TXT) pair in the live layer agrees
// with the NASR ordering, e.g. 3 is only ever an NDB class (H, HH, HW,
// HW/LOM, MHW, LOMW ...), 6 only ever a VOR/DME class, 9 only ever
// TACAN.
//
// 4 is NDB/DME. There is no combined symbol for it, and the NDB is what
// a VFR pilot tunes, so it draws as an NDB.
var navaidTypeByCode = map[int]string{
	3: "NDB",
	4: "NDB",
	5: "DME",
	6: "VOR-DME",
	7: "VOR",
	8: "VORTAC",
	9: "TACAN",
}

// designatedPointType maps the FAA designated-point kind onto the two
// point types the SPA draws: the ICAO four-pointed star for an RNAV
// waypoint, the hollow triangle for a reporting point.
//
// CNF (Computer Navigation Fix) is deliberately absent: the FAA
// publishes those for flight-management systems and states they are not
// to be used for ATC clearances or position reports, so charting them as
// waypoints would assert something false. They are counted, not drawn.
var designatedPointType = map[string]string{
	"WPT":   "WAYPOINT",
	"RNAV":  "WAYPOINT",
	"NRS":   "WAYPOINT", // Navigation Reference System grid waypoints
	"RPT":   "VFR_REPORTING_POINT",
	"MRPT":  "VFR_REPORTING_POINT",
	"GND":   "VFR_REPORTING_POINT",
	"ORI":   "VFR_REPORTING_POINT",
	"OTHER": "WAYPOINT",
}

// navaidComponentKinds lists, per NASR navaid type code, the component
// kinds (SUBTYPE_CODE) the navaid is made of: 1 an NDB, 2 a DME, 3 a VOR, 4
// a TACAN. A TACAN carries a DME, so it serves every navaid with a distance
// function: the VORTACs the FAA has reduced to a DME keep their VOR and
// TACAN records in NASR (BKW, 117.70 on channel 124X), and those are the
// DME's. A standalone DME may also be an ILS's, paired with its localizer
// (7) under the same ident, as Terrace's IXT is with 110.10 MHz. A fan
// marker (0) or a glide slope (8) is never part of a navaid.
var navaidComponentKinds = map[int][]int{
	3: {1},
	4: {1, 2, 4},
	5: {2, 4, 7},
	6: {3, 2, 4},
	7: {3},
	8: {3, 4, 2},
	9: {4, 2},
}

const (
	// componentReachNM is how far a navaid's own components may lie from
	// its NAVAIDSystem position. The two layers disagree by up to a few
	// NM (LIT's components sit 8 NM from its system point), while a
	// foreign or another US station under the same ident is hundreds of
	// NM away.
	componentReachNM = 25
	// sameSiteNM is how close a second record must lie to be a copy of
	// the first rather than another navaid or point.
	sameSiteNM = 1
)

// NavaidsMeta is the faa-navaids.meta.json document.
type NavaidsMeta struct {
	GeneratedAt  string `json:"generatedAt"`
	Source       string `json:"source"`
	SourceSha256 string `json:"sourceSha256"`
	Effective    string `json:"effective"`
	NavaidCount  int    `json:"navaidCount"`
	RadioCount   int    `json:"radioCount"`
	PointCount   int    `json:"pointCount"`
	SkippedNoGeo int    `json:"skippedNoGeo"`
	SkippedCnf   int    `json:"skippedCnf"`
	// SkippedNavaidFixes counts the designated points that are a radio
	// navaid's own fix, which the navaid's row already draws or which goes
	// with a closed one: the FAA's of kind OTHER under the navaid's ident,
	// and another register's referencing the station (REFFAC), whatever
	// its ident, each within sameSiteNM of it.
	SkippedNavaidFixes int `json:"skippedNavaidFixes"`
	// SkippedForeignCopies counts the records another register files for
	// a navaid or point the FAA already carries: a radio navaid within
	// sameSiteNM of one of its family (sameNavaidFamily) under its ident
	// carrying stronger evidence of being the FAA's (nasRank: a NAS_USE
	// field over none, 1 over 0), or a point with no STATE within
	// sameSiteNM of one under its ident that has one.
	SkippedForeignCopies int `json:"skippedForeignCopies"`
	// SuffixedIds counts the rows whose id carries their GLOBAL_ID: two
	// different stations publishing one ident (the NDB pairs AA, BR, CO,
	// IL and VV).
	SuffixedIds int `json:"suffixedIds"`
	// SeparatedRows counts the rows still sharing an id after that (a
	// record without a GLOBAL_ID among them), kept by content under
	// "<id>#2" (aip.SeparateConflictingRows); absent when none was.
	SeparatedRows int `json:"separatedRows,omitempty"`
	// NASRSource is the NASR edition the radio navaids were read from.
	NASRSource string `json:"nasrSource"`
	// NASRMatched counts the radio navaids NASR registers, at their own
	// point: their frequency, channel and elevation are NASR's.
	NASRMatched int `json:"nasrMatched"`
	// SkippedClosed counts the radio navaids no longer in service: CLOSED
	// or DECOMM in the navaid layer's own status, SHUTDOWN in NASR's.
	SkippedClosed int `json:"skippedClosed"`
	// ChannelMismatches counts the radio navaids a component of which
	// states a frequency the navaid layer's channel does not pair with: a
	// component the register has not caught up on, set aside for the pair
	// (channelPairs).
	ChannelMismatches int `json:"channelMismatches"`
	// NoFrequency counts the radio navaids written with no frequency: NASR
	// states none in the navaid's band, nor a channel pairing with one, or,
	// for a station NASR does not list, none of its own components does.
	NoFrequency int `json:"noFrequency"`
	// RepeatedRows counts rows dropped as the exact repeat of an earlier
	// row under the same id; absent when none was.
	RepeatedRows int            `json:"repeatedRows,omitempty"`
	UnknownTypes []string       `json:"unknownTypes"`
	Counts       map[string]int `json:"counts"`
	BBox         aip.BBox       `json:"bbox,omitempty"`
	// BBoxes splits that envelope into the pieces the rows really
	// occupy, for a publisher whose territory is not connected;
	// absent when the rows form one group.
	BBoxes []aip.BBox `json:"bboxes,omitempty"`
}

var navaidsOutputFields = []string{
	"id", "type", "ident", "name", "lat", "lon", "freq", "channel", "elev",
}

// geoFeature is the slice of a GeoJSON feature these layers need: a
// point geometry and a flat attribute bag.
type geoFeature struct {
	Geometry struct {
		Type        string          `json:"type"`
		Coordinates json.RawMessage `json:"coordinates"`
	} `json:"geometry"`
	Properties map[string]any `json:"properties"`
}

type geoCollection struct {
	Features []geoFeature `json:"features"`
}

// point reads a GeoJSON point as (lat, lon).
func (f *geoFeature) point() (lat, lon float64, ok bool) {
	if f.Geometry.Type != "Point" {
		return 0, 0, false
	}
	var c []float64
	if err := json.Unmarshal(f.Geometry.Coordinates, &c); err != nil || len(c) < 2 {
		return 0, 0, false
	}
	return c[1], c[0], true
}

func propString(p map[string]any, key string) string {
	if v, ok := p[key].(string); ok {
		return strings.TrimSpace(v)
	}
	return ""
}

// propFloat reads a numeric property. The FAA publishes several numeric
// columns as STRINGS (the Digital Obstacle File's Quantity, Lat_DD and
// Long_DD all come back quoted), so a string that parses as a number
// counts: reading only the JSON number type silently loses them.
func propFloat(p map[string]any, key string) (float64, bool) {
	switch v := p[key].(type) {
	case float64:
		return v, true
	case json.Number:
		f, err := v.Float64()
		return f, err == nil
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
		return f, err == nil
	}
	return 0, false
}

// faaCoord reads a coordinate column: decimal degrees, or the FAA's
// degrees-minutes-seconds with a trailing hemisphere ("31-53-41.240N",
// "086-15-32.060W"), which is how the designated-point layer writes them.
// pos and neg are the hemisphere letters of the axis.
func faaCoord(s string, pos, neg byte) (float64, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	limit := 90.0
	if pos == 'E' {
		limit = 180
	}
	if v, err := strconv.ParseFloat(s, 64); err == nil {
		return v, math.Abs(v) <= limit
	}
	hemi := s[len(s)-1]
	if hemi != pos && hemi != neg {
		return 0, false
	}
	parts := strings.Split(s[:len(s)-1], "-")
	if len(parts) != 3 {
		return 0, false
	}
	d, err1 := strconv.ParseFloat(parts[0], 64)
	m, err2 := strconv.ParseFloat(parts[1], 64)
	sec, err3 := strconv.ParseFloat(parts[2], 64)
	if err1 != nil || err2 != nil || err3 != nil || d < 0 || m < 0 || m >= 60 || sec < 0 || sec >= 60 {
		return 0, false
	}
	v := d + m/60 + sec/3600
	if hemi == neg {
		v = -v
	}
	return v, v >= -limit && v <= limit
}

func propInt(p map[string]any, key string) (int, bool) {
	f, ok := propFloat(p, key)
	if !ok {
		return 0, false
	}
	return int(math.Round(f)), true
}

// NavaidsOptions configures BuildNavaids.
type NavaidsOptions struct {
	Now        func() time.Time
	Source     string
	Effective  string
	MinNavaids int
	MaxNavaids int
	// NASR is the edition's NAV_BASE.csv (nasr.go), where a radio navaid's
	// frequency, channel, elevation and status come from; nil reads them
	// off the components alone.
	NASR nasrIndex
	// NASRSource says which NASR edition that is, for the meta.
	NASRSource string
	// NASRDigest is NAV_BASE.csv's SHA-256, which the meta's source digest
	// covers beside the layers'.
	NASRDigest []byte
}

// navaidComponent is one NavaidComponent record: a piece of a navaid's
// equipment, which carries the frequency, channel and elevation.
type navaidComponent struct {
	kind     int
	nasr     bool
	gfid     string
	lat, lon float64
	freq     float64 // 0 when absent
	channel  string
	elevFt   any // whole feet, or nil
	distNM   float64
}

// A TACAN / DME channel is written as its number with an optional X or Y
// ("076X", "33X", "083", "111Y"). The navaid layer writes it bare ("076"),
// which names the number and not the mode.
var channelPattern = regexp.MustCompile(`^(\d{1,3})([XY]?)$`)

// parseChannel splits a channel into its number and its mode, "" when the
// channel names none.
func parseChannel(channel string) (n int, mode string, ok bool) {
	m := channelPattern.FindStringSubmatch(strings.ToUpper(strings.TrimSpace(channel)))
	if m == nil {
		return 0, "", false
	}
	n, err := strconv.Atoi(m[1])
	if err != nil {
		return 0, "", false
	}
	return n, m[2], true
}

// pairedMHz is the VHF frequency channel n pairs with (ICAO Annex 10
// Volume I, the DME / VOR-ILS pairing): channels 17 to 59 from 108.00, 70
// to 126 from 112.30, and the DME-only 1 to 16 and 60 to 69 from 134.40 and
// 133.30, a tenth apart, a Y channel 50 kHz above its X. Zero for a number
// outside the table.
func pairedMHz(n int, y bool) float64 {
	var base float64
	switch {
	case n >= 1 && n <= 16:
		base = 134.40 + float64(n-1)*0.1
	case n >= 17 && n <= 59:
		base = 108.00 + float64(n-17)*0.1
	case n >= 60 && n <= 69:
		base = 133.30 + float64(n-60)*0.1
	case n >= 70 && n <= 126:
		base = 112.30 + float64(n-70)*0.1
	default:
		return 0
	}
	if y {
		base += 0.05
	}
	return math.Round(base*1000) / 1000
}

// pairedVHFMHz is the VHF frequency a channel pairs with, a bare number
// read as its X channel, the usual one. Zero for anything else.
func pairedVHFMHz(channel string) float64 {
	n, mode, ok := parseChannel(channel)
	if !ok {
		return 0
	}
	return pairedMHz(n, mode == "Y")
}

// channelPairs reports whether mhz is the frequency channel pairs with. A
// bare number pairs with its X and its Y frequency alike: it does not say
// which mode the station works, and 18 of the stations the FAA carries work
// a Y channel.
func channelPairs(channel string, mhz float64) bool {
	n, mode, ok := parseChannel(channel)
	if !ok {
		return false
	}
	same := func(y bool) bool {
		p := pairedMHz(n, y)
		return p > 0 && math.Abs(mhz-p) <= 0.001
	}
	if mode == "" {
		return same(false) || same(true)
	}
	return same(mode == "Y")
}

// sameChannel reports whether two spellings name one channel: one number,
// and one mode where both state it ("076" is "076X" written bare).
func sameChannel(a, b string) bool {
	na, ma, okA := parseChannel(a)
	nb, mb, okB := parseChannel(b)
	return okA && okB && na == nb && (ma == "" || mb == "" || ma == mb)
}

// inNavaidBand reports whether v is a frequency the navaid type transmits
// on: an NDB carrier 190 to 1750 kHz, a VOR 108.00 to 117.95 MHz, a DME or
// a TACAN also the frequencies its channels pair with above the VOR band,
// 133.30 to 135.95 MHz (channels 1 to 16 and 60 to 69). NASR files a
// navaid's value and an NDB's in one column, in MHz and kHz, so the band is
// also what keeps a co-located NDB's 400 kHz from reading as 400 MHz.
func inNavaidBand(typ string, v float64) bool {
	switch typ {
	case "NDB":
		return v >= 190 && v <= 1750
	case "VOR", "VOR-DME", "VORTAC":
		return v >= 108 && v <= 117.95
	case "DME", "TACAN":
		return (v >= 108 && v <= 117.95) || (v >= 133.30 && v <= 135.95)
	}
	return false
}

// closedStatus reads the navaid layer's STATUS: CLOSED or DECOMM is a
// station no longer in service.
func closedStatus(status string) bool {
	st := strings.ToUpper(strings.TrimSpace(status))
	return st == "CLOSED" || strings.HasPrefix(st, "DECOMM")
}

func distanceNM(latA, lonA, latB, lonB float64) float64 {
	return geodesy.DistanceM(latA, lonA, latB, lonB) / 1852
}

// nasRank grades a NAVAIDSystem record's evidence of being the FAA's own.
// The FAA files NAS_USE on every station it carries, 1 where it uses it and
// 0 where it does not (YOC, a Canadian NDB), and the copy another register
// files beside it carries none: so the field's presence is what tells the
// two apart (1), and its value only ranks two of the FAA's own (2 over 1).
// Absent, 0.
func nasRank(p map[string]any) int {
	if p["NAS_USE"] == nil {
		return 0
	}
	if propFloatIs(p, "NAS_USE", 0) {
		return 1
	}
	return 2
}

// sameNavaidFamily reports whether two navaid type codes share a piece of
// equipment (navaidComponentKinds), which one register's record must, to
// be another's copy of it: a DME filed for a VOR/DME's distance half or an
// NDB/DME's, a TACAN for a VORTAC's. An NDB sharing a VOR's ident and site
// is another station, and so is a DME or a TACAN beside a plain VOR, which
// has no distance half.
func sameNavaidFamily(a, b int) bool {
	for _, k := range navaidComponentKinds[a] {
		if slices.Contains(navaidComponentKinds[b], k) {
			return true
		}
	}
	return false
}

// BuildNavaids folds the three layers into one faa-navaids.json.
//
// A radio navaid's frequency, channel, elevation and status are the
// edition's NASR register's (opts.NASR, nasr.go) where it lists the
// station: its ident, a NAV_BASE kind its type is filed under, within
// sameSiteNM. An elevation NASR leaves blank is the components' (YCD,
// YOC). The stations NASR does not list, foreign ones, read their own off
// the components, which the FAA files per piece of equipment and keys by
// ident alone. Idents repeat: NDB AA is CEDAR in Georgia and KENIE in North
// Dakota, and the ADDE half of the component layer files foreign stations
// under US idents. So a navaid reads only its OWN components: its ident, a
// kind it is made of (navaidComponentKinds), within componentReachNM,
// NASR's record before ADDE's, then the nearest; a frequency must also lie
// in its band. Joined on the ident alone, KENIE printed CEDAR's 341 kHz,
// and TACANs and DMEs a co-located or foreign NDB's kHz read as MHz.
//
// Then the copies go: a radio navaid another register files beside the
// FAA's own, a designated point that is a navaid's own fix, a point another
// register files beside the FAA's own. Two different stations still sharing
// an ident carry their GLOBAL_ID in their id, which no file order decides,
// and a row still sharing an id after that is kept by content under an id
// of its own (aip.SeparateConflictingRows), never failing the run.
func BuildNavaids(systems, components, points []byte, opts NavaidsOptions) (overlayArtifact, NavaidsMeta, error) {
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	minN, maxN := opts.MinNavaids, opts.MaxNavaids
	if minN == 0 {
		minN = defaultMinUsNavaids
	}
	if maxN == 0 {
		maxN = defaultMaxUsNavaids
	}

	var sys, comp, pts geoCollection
	if err := json.Unmarshal(systems, &sys); err != nil {
		return overlayArtifact{}, NavaidsMeta{}, fmt.Errorf("decode NAVAIDSystem: %w", err)
	}
	if err := json.Unmarshal(components, &comp); err != nil {
		return overlayArtifact{}, NavaidsMeta{}, fmt.Errorf("decode NavaidComponent: %w", err)
	}
	if err := json.Unmarshal(points, &pts); err != nil {
		return overlayArtifact{}, NavaidsMeta{}, fmt.Errorf("decode DesignatedPoints: %w", err)
	}

	componentsByIdent := map[string][]navaidComponent{}
	for i := range comp.Features {
		f := &comp.Features[i]
		p := f.Properties
		ident := propString(p, "IDENT_TXT")
		if ident == "" {
			continue
		}
		lat, lon, ok := f.point()
		if !ok {
			continue
		}
		kind, _ := propInt(p, "SUBTYPE_CODE")
		c := navaidComponent{
			kind:    kind,
			nasr:    strings.EqualFold(propString(p, "DATASOURCE_TXT"), "NASR"),
			gfid:    propString(p, "GFID"),
			lat:     lat,
			lon:     lon,
			channel: propString(p, "CHANNEL_TXT"),
		}
		if v, ok := propFloat(p, "FREQUENCY_VAL"); ok && v > 0 {
			c.freq = v
		}
		if v, ok := propFloat(p, "ELEV_VAL"); ok {
			c.elevFt = int(math.Round(v))
		}
		componentsByIdent[ident] = append(componentsByIdent[ident], c)
	}

	// formatFreq mirrors aixm5build.BuildNavaids: MHz to three decimals
	// for the VHF/UHF navaids, whole kHz for an NDB carrier.
	formatFreq := func(typ string, v float64) string {
		if v == 0 {
			return ""
		}
		if typ == "NDB" {
			return fmt.Sprintf("%.0f", v)
		}
		return fmt.Sprintf("%.3f", v)
	}

	// row is one emitted row with the GLOBAL_ID that tells it apart
	// from another station under its ident.
	type row struct {
		cells []any
		gid   string
	}
	var rows []row
	unknown := map[string]bool{}
	skippedNoGeo, skippedCnf, skippedFixes, skippedCopies, noFrequency, channelMismatches := 0, 0, 0, 0, 0, 0
	nasrMatched, skippedClosed := 0, 0

	type system struct {
		code             int
		typ, ident, name string
		channel, gid     string
		lat, lon         float64
		nasRank          int
		// closed: the layer's own status says the station is no longer
		// in service.
		closed bool
	}
	var radios []system
	radiosByIdent := map[string][]int{}
	for i := range sys.Features {
		f := &sys.Features[i]
		lat, lon, ok := f.point()
		if !ok {
			skippedNoGeo++
			continue
		}
		p := f.Properties
		code, _ := propInt(p, "TYPE_CODE")
		typ, known := navaidTypeByCode[code]
		if !known {
			unknown[fmt.Sprintf("NAVAID:%d", code)] = true
			continue
		}
		ident := propString(p, "IDENT")
		if ident == "" {
			continue
		}
		name := propString(p, "NAME_TXT")
		if strings.EqualFold(name, ident) {
			name = ""
		}
		radiosByIdent[ident] = append(radiosByIdent[ident], len(radios))
		radios = append(radios, system{
			code: code, typ: typ, ident: ident, name: name,
			channel: propString(p, "CHANNEL"), gid: propString(p, "GLOBAL_ID"),
			lat: lat, lon: lon,
			nasRank: nasRank(p),
			closed:  closedStatus(propString(p, "STATUS")),
		})
	}

	// kept holds the radio navaids that are not another register's copy
	// of one the FAA files: YVR and YOC come twice at one spot, once with
	// NAS_USE and once without, and YOC's own states 0. A record is the
	// copy where one under its ident within sameSiteNM carries stronger
	// evidence (nasRank), of the same family (sameNavaidFamily). A closed
	// station takes part, so another register's copy of it stays a copy
	// rather than standing in for it.
	var kept, closed []system
	for i, s := range radios {
		if slices.ContainsFunc(radiosByIdent[s.ident], func(j int) bool {
			o := radios[j]
			return j != i && sameNavaidFamily(o.code, s.code) && o.nasRank > s.nasRank &&
				distanceNM(s.lat, s.lon, o.lat, o.lon) <= sameSiteNM
		}) {
			skippedCopies++
			continue
		}
		// The layer marks a station no longer in service CLOSED or DECOMM
		// (Ripley, Newark's DME, Cozad) and kept drawing it.
		if s.closed {
			skippedClosed++
			closed = append(closed, s)
			continue
		}
		kept = append(kept, s)
	}

	for _, s := range kept {
		var own []navaidComponent
		for _, c := range componentsByIdent[s.ident] {
			if !slices.Contains(navaidComponentKinds[s.code], c.kind) {
				continue
			}
			c.distNM = distanceNM(s.lat, s.lon, c.lat, c.lon)
			if c.distNM <= componentReachNM {
				own = append(own, c)
			}
		}
		sort.SliceStable(own, func(a, b int) bool {
			if own[a].nasr != own[b].nasr {
				return own[a].nasr
			}
			if own[a].distNM != own[b].distNM {
				return own[a].distNM < own[b].distNM
			}
			return own[a].gfid < own[b].gfid
		})
		// NASR registers the station: its frequency, channel, elevation and
		// status are the edition's own.
		if n, ok := opts.NASR.match(s.typ, s.ident, s.lat, s.lon); ok {
			if n.shutdown {
				skippedClosed++
				continue
			}
			nasrMatched++
			freq := n.freq
			// A DME or TACAN NASR states by its channel alone (York's
			// TACAN, 75X) transmits on the frequency the channel pairs
			// with; an NDB's carrier is no channel's.
			if freq == 0 && s.typ != "NDB" {
				if c, mode, ok := parseChannel(n.channel); ok {
					freq = pairedMHz(c, mode == "Y")
				}
			}
			if !inNavaidBand(s.typ, freq) {
				freq = 0
			}
			if freq == 0 {
				noFrequency++
			}
			// A frequency or a channel stale in the components would be a
			// wrong one, so those stay NASR's even blank; an elevation
			// barely moves, and one NASR leaves blank (the Canadian NDBs
			// YCD and YOC) is the components'.
			elevFt := n.elevFt
			for _, c := range own {
				if elevFt != nil {
					break
				}
				elevFt = c.elevFt
			}
			rows = append(rows, row{gid: s.gid, cells: []any{
				"faa:" + s.typ + ":" + s.ident,
				s.typ, s.ident, s.name,
				aip.Round5(s.lat), aip.Round5(s.lon),
				formatFreq(s.typ, freq), n.channel, elevFt,
			}})
			continue
		}
		// The navaid layer's own channel, stated afresh, decides which
		// component frequencies are this station's: a component whose
		// frequency does not pair with it is one the register has not
		// caught up on (DGO's NASR record 0.97 NM off said 112.2 / 059X
		// where the layer says 076, 112.9). Failing any that pairs, the
		// channel's own pair is the frequency. The channel shown is a
		// component's that names the layer's, spelt with the mode the
		// layer leaves out ("075X" where it says 075), else the layer's.
		// An NDB's frequency is its carrier, which no channel pairs with:
		// an NDB/DME's channel is its DME's (Kosrae's 100, beside 393 kHz).
		layerChannel := ""
		if _, _, ok := parseChannel(s.channel); ok && s.typ != "NDB" {
			layerChannel = s.channel
		}
		var freq float64
		channel := ""
		var elevFt any
		mismatch := false
		for _, c := range own {
			if c.freq > 0 && inNavaidBand(s.typ, c.freq) {
				if layerChannel != "" && !channelPairs(layerChannel, c.freq) {
					mismatch = true
				} else if freq == 0 {
					freq = c.freq
				}
			}
			if channel == "" && c.channel != "" && (layerChannel == "" || sameChannel(layerChannel, c.channel)) {
				channel = c.channel
			}
			if elevFt == nil && c.elevFt != nil {
				elevFt = c.elevFt
			}
		}
		if channel == "" {
			channel = s.channel
		}
		if paired := pairedVHFMHz(layerChannel); freq == 0 && paired > 0 && inNavaidBand(s.typ, paired) {
			freq = paired
		}
		if mismatch {
			channelMismatches++
		}
		if freq == 0 {
			noFrequency++
		}
		rows = append(rows, row{gid: s.gid, cells: []any{
			"faa:" + s.typ + ":" + s.ident,
			s.typ, s.ident, s.name,
			aip.Round5(s.lat), aip.Round5(s.lon),
			formatFreq(s.typ, freq), channel, elevFt,
		}})
	}
	radioCount := len(rows)

	// A designated point that is a radio navaid's own fix is not drawn:
	// the navaid's row draws it already, or the navaid is closed and its
	// fix goes with it rather than coming back as a waypoint. The FAA files
	// one of kind OTHER on each station under its ident, so airways can
	// name it, and a foreign register files the same fix as a reporting
	// point (RPT, ORI) referencing the station (REFFAC) under an ident of
	// its own ("(UK)" on UK, "(LANB)" on LA) or referencing another
	// register's copy of it (YOC's, YVR's). So every record takes part,
	// copies and closed stations too, and the fix sits on its station: a
	// point referencing a station from further off is one defined by it,
	// and stays. Drawn, each was a triangle over the station's own symbol
	// (Durango, Chihuahua).
	sitesByIdent := map[string][]system{}
	radioByGid := map[string]system{}
	for _, s := range radios {
		sitesByIdent[s.ident] = append(sitesByIdent[s.ident], s)
		if s.gid != "" {
			radioByGid[s.gid] = s
		}
	}
	type point struct {
		typ, ident, gid string
		lat, lon        float64
		stated          bool // the record names a STATE
	}
	var candidates []point
	for i := range pts.Features {
		f := &pts.Features[i]
		p := f.Properties
		kind := strings.ToUpper(propString(p, "TYPE_CODE"))
		if kind == "CNF" {
			skippedCnf++
			continue
		}
		typ, known := designatedPointType[kind]
		if !known {
			unknown["POINT:"+kind] = true
			continue
		}
		ident := propString(p, "IDENT")
		if ident == "" {
			continue
		}
		// The layer carries the position both as geometry and as
		// LATITUDE / LONGITUDE columns; prefer the geometry and fall
		// back, since some rows publish only the columns (231 in the
		// 2026-09-03 edition, which the columns place in DMS).
		lat, lon, ok := f.point()
		if !ok {
			la, laOK := faaCoord(propString(p, "LATITUDE"), 'N', 'S')
			lo, loOK := faaCoord(propString(p, "LONGITUDE"), 'E', 'W')
			if !laOK || !loOK {
				skippedNoGeo++
				continue
			}
			lat, lon = la, lo
		}
		ownFix := kind == "OTHER" && slices.ContainsFunc(sitesByIdent[ident], func(s system) bool {
			return distanceNM(lat, lon, s.lat, s.lon) <= sameSiteNM
		})
		if ref, ok := radioByGid[propString(p, "REFFAC")]; ok && distanceNM(lat, lon, ref.lat, ref.lon) <= sameSiteNM {
			ownFix = true
		}
		if ownFix {
			skippedFixes++
			continue
		}
		candidates = append(candidates, point{
			typ: typ, ident: ident, gid: propString(p, "GLOBAL_ID"),
			lat: lat, lon: lon, stated: propString(p, "STATE") != "",
		})
	}
	candidatesByIdent := map[string][]int{}
	for i, c := range candidates {
		candidatesByIdent[c.ident] = append(candidatesByIdent[c.ident], i)
	}
	for i, c := range candidates {
		// Another register's copy of a point the FAA files under its
		// ident carries no STATE, whatever kind either names it (KUTAL is
		// a Russian RPT on the FAA's own WPT).
		if !c.stated && slices.ContainsFunc(candidatesByIdent[c.ident], func(j int) bool {
			o := candidates[j]
			return j != i && o.stated && distanceNM(c.lat, c.lon, o.lat, o.lon) <= sameSiteNM
		}) {
			skippedCopies++
			continue
		}
		rows = append(rows, row{gid: c.gid, cells: []any{
			"faa:" + c.typ + ":" + c.ident,
			c.typ, c.ident, "",
			aip.Round5(c.lat), aip.Round5(c.lon),
			"", "", nil,
		}})
	}
	pointCount := len(rows) - radioCount

	// Two rows under one id: a record filed twice is kept once, and two
	// different stations each carry their GLOBAL_ID.
	byID := map[string][]int{}
	for i := range rows {
		id := rows[i].cells[0].(string)
		byID[id] = append(byID[id], i)
	}
	drop := map[int]bool{}
	repeatedRows, suffixed := 0, 0
	for _, members := range byID {
		if len(members) < 2 {
			continue
		}
		var distinct []int
		var encs []string
		for _, i := range members {
			b, err := json.Marshal(rows[i].cells)
			if err != nil {
				return overlayArtifact{}, NavaidsMeta{}, err
			}
			if slices.Contains(encs, string(b)) {
				drop[i] = true
				repeatedRows++
				continue
			}
			encs = append(encs, string(b))
			distinct = append(distinct, i)
		}
		// A record without a GLOBAL_ID leaves its group to the content
		// order below (aip.SeparateConflictingRows) rather than fail the
		// run, the airports and the obstacles built beside it held back.
		if len(distinct) < 2 || slices.ContainsFunc(distinct, func(i int) bool { return rows[i].gid == "" }) {
			continue
		}
		for _, i := range distinct {
			rows[i].cells[0] = rows[i].cells[0].(string) + ":" + rows[i].gid
			suffixed++
		}
	}
	out := make([]any, 0, len(rows)-len(drop))
	counts := map[string]int{}
	// The rows below this index are the radio navaids; the counts move as
	// repeats go, the boundary does not.
	radioRows := radioCount
	for i := range rows {
		if drop[i] {
			if i < radioRows {
				radioCount--
			} else {
				pointCount--
			}
			continue
		}
		out = append(out, rows[i].cells)
		counts[rows[i].cells[1].(string)]++
	}
	// What still repeats (a group with a record lacking its GLOBAL_ID) is
	// kept, each under its own id, by content.
	out, _, conflicts := aip.DropRepeatedRows(out, 0)
	separatedRows := aip.SeparateConflictingRows(out, 0, conflicts)
	if len(conflicts) > 0 {
		fmt.Fprintf(os.Stderr, "US navaids: %d ids each carried by different records (%s), each kept under its own\n",
			len(conflicts), strings.Join(conflicts, ", "))
	}

	if n := len(out); n < minN || n > maxN {
		return overlayArtifact{}, NavaidsMeta{}, fmt.Errorf(
			"US navaid count %d outside sanity window [%d, %d] - source format may have changed",
			n, minN, maxN)
	}

	// Sort by (type, ident) like the shared builder, so a refresh diff
	// stays readable, then by id, so two stations sharing an ident keep
	// an order the layer's listing does not decide.
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i].([]any), out[j].([]any)
		if a[1] != b[1] {
			return a[1].(string) < b[1].(string)
		}
		if a[2] != b[2] {
			return a[2].(string) < b[2].(string)
		}
		return a[0].(string) < b[0].(string)
	})

	unknownList := make([]string, 0, len(unknown))
	for k := range unknown {
		unknownList = append(unknownList, k)
	}
	sort.Strings(unknownList)

	sum := sha256.Sum256(slices.Concat(systems, components, points, opts.NASRDigest))
	meta := NavaidsMeta{
		GeneratedAt:          now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Source:               opts.Source,
		SourceSha256:         hex.EncodeToString(sum[:]),
		Effective:            opts.Effective,
		NavaidCount:          len(out),
		RadioCount:           radioCount,
		PointCount:           pointCount,
		SkippedNoGeo:         skippedNoGeo,
		SkippedCnf:           skippedCnf,
		SkippedNavaidFixes:   skippedFixes,
		SkippedForeignCopies: skippedCopies,
		SuffixedIds:          suffixed,
		SeparatedRows:        separatedRows,
		NASRSource:           opts.NASRSource,
		NASRMatched:          nasrMatched,
		SkippedClosed:        skippedClosed,
		ChannelMismatches:    channelMismatches,
		NoFrequency:          noFrequency,
		RepeatedRows:         repeatedRows,
		UnknownTypes:         unknownList,
		Counts:               counts,
		BBox:                 aip.BBoxOfRows(navaidsOutputFields, out),
		BBoxes:               aip.BBoxClustersOfRows(navaidsOutputFields, out),
	}
	return overlayArtifact{Fields: navaidsOutputFields, Rows: out}, meta, nil
}

// overlayArtifact is the rows + fields document shape the SPA reads.
type overlayArtifact struct {
	Fields []string `json:"fields"`
	Rows   []any    `json:"rows"`
}

// fetchPointLayers pulls the three navaid layers for one slot.
func fetchPointLayers(ctx context.Context, systemURL, pointURL string) (systems, components, points []byte, err error) {
	if systems, err = fetchFAAPaginated(ctx, systemURL); err != nil {
		return nil, nil, nil, fmt.Errorf("NAVAIDSystem: %w", err)
	}
	if components, err = fetchFAAPaginated(ctx, navaidComponentURL); err != nil {
		return nil, nil, nil, fmt.Errorf("NavaidComponent: %w", err)
	}
	if points, err = fetchFAAPaginated(ctx, pointURL); err != nil {
		return nil, nil, nil, fmt.Errorf("DesignatedPoints: %w", err)
	}
	return systems, components, points, nil
}
