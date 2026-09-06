// navaids.go produces fr-navaids.json from the AIXM 4.5 navaid
// elements (Vor / Dme / Ndb / Tcn / Dpn / Ils / Mkr). VOR-DME
// composition folds a paired DME into the VOR row when their codeIds
// match; standalone DMEs are emitted as DME. Each Ils emits an ILS
// (or ILS-DME with a co-located DME, LOC when it has no glidepath)
// keyed on its localizer; each Mkr an MKR.
//
// Phase 4: data only. The SPA loader doesn't fetch fr-navaids.json
// yet; the file is committed so the follow-up UI PR has data to
// drive a navaid map layer.

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
)

const (
	// Observed counts (May 2026 AIRAC): ~96 VOR, ~188 Dme, ~95 Ndb,
	// ~19 Tcn, ~4,286 Dpn. Sanity window is wide because the row
	// total varies a lot with VOR-DME composition and Dpn changes.
	defaultMinFrNavaids = 2500
	defaultMaxFrNavaids = 8000
)

// navaidsOutputFields is the positional row layout of fr-navaids.json.
//
//	id:      "<Type>:<mid>" stable identifier
//	type:    VOR | DME | NDB | TACAN | VOR-DME | VORTAC | WAYPOINT
//	ident:   3- or 5-letter codeId (ICAO identifier)
//	name:    txtName (human-readable site name; empty for waypoints
//	         where ident == name)
//	lat/lon: decimal degrees
//	freq:    string ("113.65" for VOR, "414" for NDB in kHz, "" for
//	         waypoints)
//	channel: TACAN channel string ("83Y") or "" when not applicable
//	elev:    feet AMSL; null when missing
var navaidsOutputFields = []string{
	"id", "type", "ident", "name", "lat", "lon", "freq", "channel", "elev",
}

// NavaidsArtifact is the fr-navaids.json document.
type NavaidsArtifact struct {
	Fields []string `json:"fields"`
	Rows   []any    `json:"rows"`
}

// NavaidsMeta is the fr-navaids.meta.json document.
type NavaidsMeta struct {
	GeneratedAt  string         `json:"generatedAt"`
	Source       string         `json:"source"`
	SourceSha256 string         `json:"sourceSha256"`
	Effective    string         `json:"effective"`
	NavaidCount  int            `json:"navaidCount"`
	Counts       map[string]int `json:"counts"`
	// BBox is the emitted rows' lat/lon envelope, which the SPA uses to
	// skip fetching a publisher the current view cannot reach (aip/bbox.go).
	BBox aip.BBox `json:"bbox,omitempty"`
	// BBoxes splits that envelope into the pieces the rows really
	// occupy, for a publisher whose territory is not connected;
	// absent when the rows form one group.
	BBoxes []aip.BBox `json:"bboxes,omitempty"`
}

// NavaidsOptions configures BuildNavaids.
type NavaidsOptions struct {
	Source     string
	Now        func() time.Time // overridable for tests
	MinNavaids int              // sanity window; 0 uses the default
	MaxNavaids int
}

// BuildNavaids decodes the AIXM source and produces the navaids
// artefact + meta. Output is sorted by (type, ident) for diff
// stability across cycles.
func BuildNavaids(src []byte, opts NavaidsOptions) (NavaidsArtifact, NavaidsMeta, error) {
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	minN, maxN := opts.MinNavaids, opts.MaxNavaids
	if minN == 0 {
		minN = defaultMinFrNavaids
	}
	if maxN == 0 {
		maxN = defaultMaxFrNavaids
	}

	snap, err := decodeNavaidsSnapshot(src)
	if err != nil {
		return NavaidsArtifact{}, NavaidsMeta{}, err
	}

	// Index DMEs by paired VOR codeId so VOR rows can fold the DME's
	// channel + ghost frequency into a single VOR-DME row.
	dmeByVorCodeId := make(map[string]*aixmDme, len(snap.dmes))
	pairedDmeMids := make(map[int64]bool, len(snap.dmes))
	for i := range snap.dmes {
		d := &snap.dmes[i]
		if d.VorUid == nil {
			continue
		}
		key := strings.TrimSpace(d.VorUid.CodeId)
		if key == "" {
			continue
		}
		dmeByVorCodeId[key] = d
		pairedDmeMids[d.Uid.Mid] = true
	}

	type row struct {
		t       string // sort key
		ident   string // sort tiebreaker
		payload []any
	}
	var rows []row
	counts := make(map[string]int)

	for i := range snap.vors {
		v := &snap.vors[i]
		lat, lon, ok := navaidCoords(v.Uid.GeoLat, v.Uid.GeoLong)
		if !ok {
			continue
		}
		typeCode := "VOR"
		channel := ""
		freq := strings.TrimSpace(v.ValFreq)
		if dme, paired := dmeByVorCodeId[strings.TrimSpace(v.Uid.CodeId)]; paired {
			typeCode = "VOR-DME"
			channel = strings.TrimSpace(dme.CodeChannel)
		}
		rows = append(rows, row{
			t:     typeCode,
			ident: v.Uid.CodeId,
			payload: []any{
				typeCode + ":" + strconv.FormatInt(v.Uid.Mid, 10),
				typeCode,
				strings.TrimSpace(v.Uid.CodeId),
				strings.TrimSpace(v.TxtName),
				lat,
				lon,
				freq,
				channel,
				elevFromAixm(v.ValElev, v.UomDistVer),
			},
		})
		counts[typeCode]++
	}

	for i := range snap.dmes {
		d := &snap.dmes[i]
		if pairedDmeMids[d.Uid.Mid] {
			continue // folded into the companion VOR row above
		}
		lat, lon, ok := navaidCoords(d.Uid.GeoLat, d.Uid.GeoLong)
		if !ok {
			continue
		}
		freq := strings.TrimSpace(d.ValGhostFreq)
		rows = append(rows, row{
			t:     "DME",
			ident: d.Uid.CodeId,
			payload: []any{
				"DME:" + strconv.FormatInt(d.Uid.Mid, 10),
				"DME",
				strings.TrimSpace(d.Uid.CodeId),
				strings.TrimSpace(d.TxtName),
				lat,
				lon,
				freq,
				strings.TrimSpace(d.CodeChannel),
				elevFromAixm(d.ValElev, d.UomDistVer),
			},
		})
		counts["DME"]++
	}

	for i := range snap.ndbs {
		n := &snap.ndbs[i]
		lat, lon, ok := navaidCoords(n.Uid.GeoLat, n.Uid.GeoLong)
		if !ok {
			continue
		}
		rows = append(rows, row{
			t:     "NDB",
			ident: n.Uid.CodeId,
			payload: []any{
				"NDB:" + strconv.FormatInt(n.Uid.Mid, 10),
				"NDB",
				strings.TrimSpace(n.Uid.CodeId),
				strings.TrimSpace(n.TxtName),
				lat,
				lon,
				strings.TrimSpace(n.ValFreq),
				"",
				elevFromAixm(n.ValElev, n.UomDistVer),
			},
		})
		counts["NDB"]++
	}

	for i := range snap.tcns {
		c := &snap.tcns[i]
		lat, lon, ok := navaidCoords(c.Uid.GeoLat, c.Uid.GeoLong)
		if !ok {
			continue
		}
		rows = append(rows, row{
			t:     "TACAN",
			ident: c.Uid.CodeId,
			payload: []any{
				"TACAN:" + strconv.FormatInt(c.Uid.Mid, 10),
				"TACAN",
				strings.TrimSpace(c.Uid.CodeId),
				strings.TrimSpace(c.TxtName),
				lat,
				lon,
				"",
				strings.TrimSpace(c.CodeChannel),
				elevFromAixm(c.ValElev, c.UomDistVer),
			},
		})
		counts["TACAN"]++
	}

	for i := range snap.dpns {
		p := &snap.dpns[i]
		lat, lon, ok := navaidCoords(p.Uid.GeoLat, p.Uid.GeoLong)
		if !ok {
			continue
		}
		name := strings.TrimSpace(p.TxtName)
		if name == strings.TrimSpace(p.Uid.CodeId) {
			name = ""
		}
		ct := strings.TrimSpace(p.CodeType)
		if strings.EqualFold(ct, "ADHP") {
			continue // designated point on an aerodrome; the airport symbol covers it
		}
		typeCode := "WAYPOINT"
		if !strings.EqualFold(ct, "ICAO") {
			typeCode = "VFR_REPORTING_POINT"
		}
		rows = append(rows, row{
			t:     typeCode,
			ident: p.Uid.CodeId,
			payload: []any{
				"WPT:" + strconv.FormatInt(p.Uid.Mid, 10),
				typeCode,
				strings.TrimSpace(p.Uid.CodeId),
				name,
				lat,
				lon,
				"",
				"",
				nil,
			},
		})
		counts[typeCode]++
	}

	for i := range snap.ilss {
		il := &snap.ilss[i]
		lat, lon, ok := navaidCoords(il.Ilz.GeoLat, il.Ilz.GeoLong)
		if !ok {
			continue
		}
		// A glidepath makes it a full ILS; a co-located DME an ILS-DME;
		// a localizer alone (no Igp) is a LOC approach. The SPA has no
		// LOC-DME, so a localizer + DME still reads as LOC.
		typeCode := "LOC"
		if il.Igp != nil {
			typeCode = "ILS"
			if il.DmeUid != nil {
				typeCode = "ILS-DME"
			}
		}
		rows = append(rows, row{
			t:     typeCode,
			ident: il.Ilz.CodeId,
			payload: []any{
				"ILS:" + il.Uid.Mid,
				typeCode,
				strings.TrimSpace(il.Ilz.CodeId),
				ilsName(il),
				lat,
				lon,
				strings.TrimSpace(il.Ilz.ValFreq),
				"",
				elevFromAixm(il.Ilz.ValElev, il.Ilz.UomDistVer),
			},
		})
		counts[typeCode]++
	}

	for i := range snap.mkrs {
		m := &snap.mkrs[i]
		lat, lon, ok := navaidCoords(m.Uid.GeoLat, m.Uid.GeoLong)
		if !ok {
			continue
		}
		rows = append(rows, row{
			t:     "MKR",
			ident: markerIdent(m),
			payload: []any{
				"MKR:" + m.Uid.Mid,
				"MKR",
				markerIdent(m),
				markerName(m),
				lat,
				lon,
				strings.TrimSpace(m.ValFreq),
				"",
				nil,
			},
		})
		counts["MKR"]++
	}

	// Stable order: by type then ident. Keeps the JSON diff-stable
	// across AIRAC refreshes when only a handful of records change.
	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i].t != rows[j].t {
			return rows[i].t < rows[j].t
		}
		return rows[i].ident < rows[j].ident
	})

	out := make([]any, len(rows))
	for i := range rows {
		out[i] = rows[i].payload
	}

	if n := len(out); n < minN || n > maxN {
		return NavaidsArtifact{}, NavaidsMeta{}, fmt.Errorf(
			"navaid count %d outside sanity window [%d, %d] - source format may have changed",
			n, minN, maxN)
	}

	sum := sha256.Sum256(src)
	meta := NavaidsMeta{
		GeneratedAt:  now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Source:       opts.Source,
		SourceSha256: hex.EncodeToString(sum[:]),
		Effective:    snap.effective,
		NavaidCount:  len(out),
		Counts:       counts,
	}
	meta.BBox = aip.BBoxOfRows(navaidsOutputFields, out)
	meta.BBoxes = aip.BBoxClustersOfRows(navaidsOutputFields, out)
	return NavaidsArtifact{Fields: navaidsOutputFields, Rows: out}, meta, nil
}

// navaidCoords parses AIXM DMS lat/lon and rounds to 5 dp. ok=false
// when either coordinate fails to parse (the navaid is dropped).
func navaidCoords(latStr, lonStr string) (lat, lon float64, ok bool) {
	la, laOk := aip.ParseLat(latStr)
	if !laOk {
		return 0, 0, false
	}
	lo, loOk := aip.ParseLon(lonStr)
	if !loOk {
		return 0, 0, false
	}
	return aip.Round5(la), aip.Round5(lo), true
}

// elevFromAixm converts an AIXM elev value + uomDistVer pair to feet.
// Returns nil for missing / unparseable values (rendered as null in
// the JSON, matching France's existing obstacles convention).
func elevFromAixm(val, uom string) any {
	val = strings.TrimSpace(val)
	if val == "" {
		return nil
	}
	x, err := strconv.ParseFloat(val, 64)
	if err != nil {
		return nil
	}
	switch strings.ToUpper(strings.TrimSpace(uom)) {
	case "FT", "":
		return int(x + 0.5)
	case "M":
		return int(x/0.3048 + 0.5)
	default:
		return nil
	}
}

// ilsName describes an ILS by the runway it serves, "LFGJ RWY 05", when
// the AIXM names no station text. The localizer ident (the codeId, "DO")
// is the row's ident; this fills the human-readable name column.
func ilsName(il *aixmIls) string {
	ahp := strings.TrimSpace(il.Uid.Rdn.Rwy.Ahp.CodeId)
	rwy := strings.TrimSpace(il.Uid.Rdn.TxtDesig)
	switch {
	case ahp != "" && rwy != "":
		return ahp + " RWY " + rwy
	case ahp != "":
		return ahp
	default:
		return ""
	}
}

// markerName describes a marker by its position and served runway,
// "LFBG RWY 23 middle marker". codePsnIls is O / M / I.
func markerName(m *aixmMkr) string {
	pos := map[string]string{"O": "outer", "M": "middle", "I": "inner"}[strings.ToUpper(strings.TrimSpace(m.CodePsnIls))]
	label := "marker"
	if pos != "" {
		label = pos + " marker"
	}
	ahp := strings.TrimSpace(m.Ils.Rdn.Rwy.Ahp.CodeId)
	rwy := strings.TrimSpace(m.Ils.Rdn.TxtDesig)
	if ahp != "" && rwy != "" {
		return ahp + " RWY " + rwy + " " + label
	}
	return label
}

// markerIdent builds a stable ident for a marker beacon; its AIXM codeId
// is a Morse pattern (".-"), not an identifier, so the aerodrome, runway
// and position letter compose one instead ("LFBG-23-M").
func markerIdent(m *aixmMkr) string {
	ahp := strings.TrimSpace(m.Ils.Rdn.Rwy.Ahp.CodeId)
	rwy := strings.TrimSpace(m.Ils.Rdn.TxtDesig)
	psn := strings.ToUpper(strings.TrimSpace(m.CodePsnIls))
	parts := make([]string, 0, 3)
	for _, p := range []string{ahp, rwy, psn} {
		if p != "" {
			parts = append(parts, p)
		}
	}
	return strings.Join(parts, "-")
}
