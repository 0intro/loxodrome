// nature.go produces fr-nature.json from the SIA proprietary XML_SIA file:
// the "zones naturelles" (TypeEspace "PRN": parcs nationaux / réserves
// naturelles) and sensitive-site overflight zones (TypeEspace "SUR": nuclear /
// industrial / prison), where low overflight is prohibited (typically a 1000 ft
// or 3300 ft AGL floor). They are absent from the AIXM 4.5 airspace export.
//
// The SIA export gives a polygon for only a handful of these zones (mostly
// overseas islets); for the major metropole parks it carries only a single
// representative point. So each zone is emitted as one POINT (the Contour's
// centroid) carrying the minimum overflight altitude, and is drawn on the map as
// the AIP "site with special marking of prohibited low overflying" symbol (a
// bullseye), styled like the navaids.
//
// The records are relational, joined by the bracketed `lk` logical key: a
// Partie's parent Espace is its lk with the final "[...]" stripped; a Volume's
// parent Partie likewise. The display name is the Partie's NomUsuel, the point
// the Partie's Contour centroid, and the minimum altitude the Volume's Plafond.

package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
)

const (
	// Sanity window: 143 PRN + 198 SUR ~= 341 zones in the May 2026 AIRAC.
	// Wide enough for cycle-to-cycle drift, tight enough to catch a schema break.
	defaultMinNature = 200
	defaultMaxNature = 600
)

// natureTypeByEspace maps the SIA TypeEspace values we surface to the emitted
// `type`. Everything else is ignored.
var natureTypeByEspace = map[string]string{
	"PRN": "NATURE",    // parcs nationaux / réserves naturelles
	"SUR": "SENSITIVE", // sensitive sites (nuclear / industrial / prison)
}

// natureOutputFields is the positional row layout of fr-nature.json; the browser
// indexes rows by these positions (rowToNature in src/lib/data/nature.ts).
//
//	id:        non-AIXM slug from the Espace lk ("LF-PRN-020")
//	type:      NATURE | SENSITIVE
//	name:      NomUsuel ("PARC NATIONAL DES CEVENNES")
//	lat/lon:   decimal degrees (the zone's representative point)
//	minAlt:    minimum overflight altitude value (ft, or the FL number)
//	minAltRef: "AGL" | "AMSL" | "FL" | "SFC" | "" (reference of minAlt)
var natureOutputFields = []string{
	"id", "type", "name", "lat", "lon", "minAlt", "minAltRef",
}

// NatureArtifact is the fr-nature.json document.
type NatureArtifact struct {
	Fields []string `json:"fields"`
	Rows   []any    `json:"rows"`
}

// NatureMeta is the fr-nature.meta.json document.
type NatureMeta struct {
	GeneratedAt  string         `json:"generatedAt"`
	Source       string         `json:"source"`
	SourceSha256 string         `json:"sourceSha256"`
	Effective    string         `json:"effective"`
	ZoneCount    int            `json:"zoneCount"`
	Counts       map[string]int `json:"counts"`
	// BBox is the emitted rows' lat/lon envelope, which the SPA uses to
	// skip fetching a publisher the current view cannot reach (aip/bbox.go).
	BBox aip.BBox `json:"bbox,omitempty"`
	// BBoxes splits that envelope into the pieces the rows really
	// occupy, for a publisher whose territory is not connected;
	// absent when the rows form one group.
	BBoxes       []aip.BBox `json:"bboxes,omitempty"`
	SkippedNoGeo int        `json:"skippedNoGeo"`
}

// NatureOptions configures BuildNature.
type NatureOptions struct {
	Source   string
	Now      func() time.Time // overridable for tests
	MinZones int              // sanity window; 0 uses the default
	MaxZones int
}

// natureZone is one emitted zone.
type natureZone struct {
	id        string
	emitType  string // NATURE | SENSITIVE
	name      string
	lat, lon  float64
	minAlt    int    // overflight-floor value
	minAltRef string // "AGL" | "AMSL" | "FL" | "SFC" | ""
}

// natureStats counts emitted / skipped zones for the meta sidecar.
type natureStats struct {
	counts  map[string]int
	skipped int
}

// siaEspace / siaPartie / siaVolume mirror the XML_SIA records we join. The
// empty reference children the format scatters (an empty <Espace/> inside a
// Partie, etc.) decode to blank and are dropped by the `lk == ""` guards.
type siaEspace struct {
	Lk         string `xml:"lk,attr"`
	TypeEspace string `xml:"TypeEspace"`
}

type siaPartie struct {
	Lk       string `xml:"lk,attr"`
	NomUsuel string `xml:"NomUsuel"`
	Contour  string `xml:"Contour"`
}

type siaVolume struct {
	Lk              string `xml:"lk,attr"`
	Plafond         string `xml:"Plafond"`
	PlafondRefUnite string `xml:"PlafondRefUnite"`
}

// BuildNature decodes the SIA proprietary XML and produces the nature-zone
// artefact + meta. Output is sorted by (type, id) for diff stability.
func BuildNature(src []byte, opts NatureOptions) (NatureArtifact, NatureMeta, error) {
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	minN, maxN := opts.MinZones, opts.MaxZones
	if minN == 0 {
		minN = defaultMinNature
	}
	if maxN == 0 {
		maxN = defaultMaxNature
	}

	zones, effective, stats, err := parseNatureZones(src)
	if err != nil {
		return NatureArtifact{}, NatureMeta{}, err
	}

	type row struct {
		t, id   string
		payload []any
	}
	rows := make([]row, 0, len(zones))
	for _, z := range zones {
		rows = append(rows, row{z.emitType, z.id, []any{
			z.id, z.emitType, z.name, z.lat, z.lon, z.minAlt, z.minAltRef,
		}})
	}
	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i].t != rows[j].t {
			return rows[i].t < rows[j].t
		}
		return rows[i].id < rows[j].id
	})
	out := make([]any, len(rows))
	for i := range rows {
		out[i] = rows[i].payload
	}
	if n := len(out); n < minN || n > maxN {
		return NatureArtifact{}, NatureMeta{}, fmt.Errorf(
			"nature-zone count %d outside sanity window [%d, %d] - source format may have changed",
			n, minN, maxN)
	}

	sum := sha256.Sum256(src)
	meta := NatureMeta{
		GeneratedAt:  now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Source:       opts.Source,
		SourceSha256: hex.EncodeToString(sum[:]),
		Effective:    effective,
		ZoneCount:    len(out),
		Counts:       stats.counts,
		SkippedNoGeo: stats.skipped,
	}
	meta.BBox = aip.BBoxOfRows(natureOutputFields, out)
	meta.BBoxes = aip.BBoxClustersOfRows(natureOutputFields, out)
	return NatureArtifact{Fields: natureOutputFields, Rows: out}, meta, nil
}

// stripLastBracket removes the final "[...]" segment of an lk:
// "[LF][PRN 22][.]" -> "[LF][PRN 22]".
func stripLastBracket(lk string) string {
	if i := strings.LastIndex(lk, "["); i > 0 {
		return lk[:i]
	}
	return lk
}

// parseNatureZones streams the SIA proprietary XML and returns the PRN / SUR
// zones joined from Espace / Partie / Volume, plus the export's effective date
// (the <Situation effDate>). One zone per Partie.
func parseNatureZones(src []byte) ([]natureZone, string, natureStats, error) {
	stats := natureStats{counts: map[string]int{}}
	if len(src) == 0 {
		return nil, "", stats, nil
	}
	var effective string
	espType := map[string]string{} // espace lk -> TypeEspace (PRN/SUR only)
	var parties []siaPartie
	vols := map[string]siaVolume{} // partie lk -> first Volume

	dec := xml.NewDecoder(bytes.NewReader(src))
	dec.CharsetReader = newCharsetReader
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, "", stats, fmt.Errorf("reading SIA XML: %w", err)
		}
		se, ok := tok.(xml.StartElement)
		if !ok {
			continue
		}
		switch se.Name.Local {
		case "Situation":
			for _, a := range se.Attr {
				if a.Name.Local == "effDate" {
					effective = a.Value
				}
			}
		case "Espace":
			var e siaEspace
			if err := dec.DecodeElement(&e, &se); err != nil {
				return nil, "", stats, fmt.Errorf("decoding Espace: %w", err)
			}
			if e.Lk != "" && natureTypeByEspace[e.TypeEspace] != "" {
				espType[e.Lk] = e.TypeEspace
			}
		case "Partie":
			var p siaPartie
			if err := dec.DecodeElement(&p, &se); err != nil {
				return nil, "", stats, fmt.Errorf("decoding Partie: %w", err)
			}
			if p.Lk != "" {
				parties = append(parties, p)
			}
		case "Volume":
			var v siaVolume
			if err := dec.DecodeElement(&v, &se); err != nil {
				return nil, "", stats, fmt.Errorf("decoding Volume: %w", err)
			}
			if v.Lk != "" {
				if pk := stripLastBracket(v.Lk); vols[pk].Lk == "" {
					vols[pk] = v
				}
			}
		}
	}

	var out []natureZone
	for i := range parties {
		p := &parties[i]
		te, ok := espType[stripLastBracket(p.Lk)]
		if !ok {
			continue // not a PRN / SUR zone
		}
		lat, lon, ok := contourCentroid(p.Contour)
		if !ok {
			stats.skipped++
			continue
		}
		v := vols[p.Lk]
		alt, ref := minAltFromSIA(v.PlafondRefUnite, v.Plafond)
		emit := natureTypeByEspace[te]
		stats.counts[emit]++
		out = append(out, natureZone{
			id:        natureID(p.Lk),
			emitType:  emit,
			name:      strings.TrimSpace(p.NomUsuel),
			lat:       lat,
			lon:       lon,
			minAlt:    alt,
			minAltRef: ref,
		})
	}
	return out, effective, stats, nil
}

// natureID builds a stable, non-AIXM id from the Partie's parent-Espace lk
// ("[LF][PRN 22]" -> "LF-PRN-22"). Parties of one Espace share this id.
func natureID(partieLk string) string {
	toks := bracketTokens(stripLastBracket(partieLk))
	s := strings.Join(toks, "-")
	return strings.Map(func(r rune) rune {
		if r == ' ' || r == '/' {
			return '-'
		}
		return r
	}, s)
}

// contourCentroid averages the decimal-degree vertices of a SIA <Contour> into
// one representative point. Each segment line is
// "<segId>,Cloture=<n>,<lat> <lon>,<seg>(...)": the "<lat> <lon>" field is the
// vertex (or circle centre). ok=false when no coordinate parses.
func contourCentroid(text string) (lat, lon float64, ok bool) {
	var slat, slon float64
	var n int
	for _, line := range strings.Split(text, "\n") {
		f := strings.Split(strings.TrimSpace(line), ",")
		if len(f) < 3 {
			continue
		}
		la, lo, lok := parseDecimalLatLon(f[2])
		if !lok {
			continue
		}
		slat += la
		slon += lo
		n++
	}
	if n == 0 {
		return 0, 0, false
	}
	return round5(slat / float64(n)), round5(slon / float64(n)), true
}

// parseDecimalLatLon parses a space-separated "<lat> <lon>" decimal-degree pair.
func parseDecimalLatLon(s string) (lat, lon float64, ok bool) {
	f := strings.Fields(s)
	if len(f) != 2 {
		return 0, 0, false
	}
	lat, err1 := strconv.ParseFloat(f[0], 64)
	lon, err2 := strconv.ParseFloat(f[1], 64)
	if err1 != nil || err2 != nil || lat < -90 || lat > 90 || lon < -180 || lon > 180 {
		return 0, 0, false
	}
	return lat, lon, true
}

// minAltFromSIA maps a SIA Plafond (value + reference-unit) to a numeric minimum
// overflight altitude + a reference code: "ft ASFC" / "ft AGL" -> AGL; "ft AMSL"
// -> AMSL; "FL" -> FL; "SFC" -> the surface; "UNL" -> an explicit UNL marker
// (the value is meaningless; the silent Atoi used to make it a bare 0).
func minAltFromSIA(refUnite, val string) (alt int, ref string) {
	r := strings.ToUpper(strings.TrimSpace(refUnite))
	v, _ := strconv.Atoi(strings.TrimSpace(val))
	switch {
	case r == "UNL" || strings.ToUpper(strings.TrimSpace(val)) == "UNL":
		return 0, "UNL"
	case strings.Contains(r, "AMSL"):
		return v, "AMSL"
	case r == "FL":
		return v, "FL"
	case r == "SFC" || r == "GND":
		return 0, "SFC"
	case strings.Contains(r, "ASFC") || strings.Contains(r, "AGL") || strings.Contains(r, "SFC"):
		return v, "AGL"
	default:
		return v, r
	}
}
