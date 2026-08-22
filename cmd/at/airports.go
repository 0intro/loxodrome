// airports.go emits at-airports.json from the KML aerodrome and
// heliport placemarks. Schema mirrors cmd/de/airports.go so the SPA
// merges it with the worldwide OurAirports baseline by ICAO.
//
// The KML publishes the field position, elevation, longest runway and
// one frequency per aerodrome. Runway geometry and the full radio list
// stay with the baseline: the merge keeps a baseline value wherever the
// overlay row carries none, so Austria enriches OurAirports rather than
// thinning it.

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
)

const (
	defaultMinAtAirports = 30
	defaultMaxAtAirports = 500
)

// airportsOutputFields mirrors cmd/de/airports.go.
var airportsOutputFields = []string{
	"ident",
	"type",
	"name",
	"lat",
	"lon",
	"elev_ft",
	"iso_country",
	"municipality",
	"iata",
	"runways",
	"access",
	"military",
	"vfr",
	"ifr",
	"joint",
	"frequencies",
	"transition_alt_ft",
}

var airportsRunwayFields = []string{
	"le", "he", "length_ft", "width_ft", "surface", "lit",
	"le_lda_ft", "le_tora_ft", "le_toda_ft", "le_asda_ft",
	"he_lda_ft", "he_tora_ft", "he_toda_ft", "he_asda_ft",
}

var airportsFrequencyFields = []string{"freq", "unit", "call"}

// AirportsArtifact is the at-airports.json document.
type AirportsArtifact struct {
	Fields          []string `json:"fields"`
	RunwayFields    []string `json:"runwayFields"`
	FrequencyFields []string `json:"frequencyFields"`
	Rows            []any    `json:"rows"`
}

// AirportsMeta is the at-airports.meta.json document.
type AirportsMeta struct {
	GeneratedAt   string         `json:"generatedAt"`
	Source        string         `json:"source"`
	SourceSha256  string         `json:"sourceSha256"`
	Effective     string         `json:"effective"`
	AhpCount      int            `json:"ahpCount"`
	HeliportCount int            `json:"heliportCount"`
	MilitaryCount int            `json:"militaryCount"`
	ElevCount     int            `json:"elevCount"`
	Counts        map[string]int `json:"counts"`
	// BBox is the emitted rows' lat/lon envelope, which the SPA uses to
	// skip fetching a publisher the current view cannot reach (aip/bbox.go).
	BBox aip.BBox `json:"bbox,omitempty"`
	// BBoxes splits that envelope into the pieces the rows really
	// occupy, for a publisher whose territory is not connected;
	// absent when the rows form one group.
	BBoxes []aip.BBox `json:"bboxes,omitempty"`
}

// AirportsOptions configures BuildAirports.
type AirportsOptions struct {
	Now         func() time.Time
	MinAirports int
	MaxAirports int
}

const (
	airportFolder  = "05_Airports"
	heliportFolder = "06_Heliports"
)

// BuildAirports emits one row per aerodrome and heliport placemark,
// sorted by ICAO.
func BuildAirports(pms []Placemark, source string, raw []byte, effective string, opts AirportsOptions) (AirportsArtifact, AirportsMeta, error) {
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	minN, maxN := opts.MinAirports, opts.MaxAirports
	if minN == 0 {
		minN = defaultMinAtAirports
	}
	if maxN == 0 {
		maxN = defaultMaxAtAirports
	}

	type entry struct {
		ident string
		row   []any
		kind  string
	}
	entries := make([]entry, 0, len(pms))
	seen := map[string]bool{}
	counts := map[string]int{}
	heliportCount, militaryCount, elevCount := 0, 0, 0

	for i := range pms {
		pm := &pms[i]
		folder := lastFolder(pm.Folder, airportFolder, heliportFolder)
		if folder == "" || pm.Point == nil {
			continue
		}
		heliport := folder == heliportFolder
		ident := pm.Field("CODE")
		if ident == "" {
			ident = pm.Field("IDENT")
		}
		name := pm.Field("NAME")
		if name == "" {
			name = pm.Field("NAM")
		}
		if ident == "" || seen[ident] {
			continue
		}
		seen[ident] = true

		var elev any
		if ft, ok := elevationFt(pm); ok {
			elev = ft
			elevCount++
		}
		kind := airportType(pm, heliport)
		counts[kind]++
		if heliport {
			heliportCount++
		}
		military := isMilitaryIdent(ident)
		if military {
			militaryCount++
		}
		entries = append(entries, entry{
			ident: ident,
			kind:  kind,
			row: []any{
				ident,
				kind,
				name,
				pm.Point[0],
				pm.Point[1],
				elev,
				"AT",
				"",      // municipality: the KML publishes the field name only
				"",      // iata
				[]any{}, // runways: the OurAirports baseline keeps its own
				nil,     // access
				military,
				false,   // vfr
				false,   // ifr
				false,   // joint
				[]any{}, // frequencies: the baseline radio list is richer
				nil,     // transition_alt_ft
			},
		})
	}

	sort.Slice(entries, func(i, j int) bool { return entries[i].ident < entries[j].ident })
	rows := make([]any, 0, len(entries))
	for _, e := range entries {
		rows = append(rows, e.row)
	}

	if n := len(rows); n < minN || n > maxN {
		return AirportsArtifact{}, AirportsMeta{}, fmt.Errorf(
			"AT airport count %d outside sanity window [%d, %d] - source format may have changed",
			n, minN, maxN)
	}

	sum := sha256.Sum256(raw)
	meta := AirportsMeta{
		GeneratedAt:   now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Source:        source,
		SourceSha256:  hex.EncodeToString(sum[:]),
		Effective:     effective,
		AhpCount:      len(rows),
		HeliportCount: heliportCount,
		MilitaryCount: militaryCount,
		ElevCount:     elevCount,
		Counts:        counts,
	}
	meta.BBox = aip.BBoxOfRows(airportsOutputFields, rows)
	meta.BBoxes = aip.BBoxClustersOfRows(airportsOutputFields, rows)
	return AirportsArtifact{
		Fields:          airportsOutputFields,
		RunwayFields:    airportsRunwayFields,
		FrequencyFields: airportsFrequencyFields,
		Rows:            rows,
	}, meta, nil
}

// lastFolder returns whichever of want encloses the placemark.
func lastFolder(stack []string, want ...string) string {
	for _, id := range stack {
		for _, w := range want {
			if id == w {
				return w
			}
		}
	}
	return ""
}

// elevationFt reads the field elevation in feet. The description bubble
// states its unit ("Höhe (FT)") and is the primary source; the
// ExtendedData ELEVATION field, which carries metres for a few
// aerodromes and feet for the rest, is the fallback when a bubble is
// missing, taken as feet like the majority.
func elevationFt(pm *Placemark) (int, bool) {
	if v := descField(pm.Desc, "Höhe (FT)"); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return int(math.Round(f)), true
		}
	}
	if v := pm.Field("ELEVATION"); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return int(math.Round(f)), true
		}
	}
	return 0, false
}

// airportType maps the placemark onto the OurAirports type enum the SPA
// styles icons from. Runway length arrives in metres; the feet
// thresholds match cmd/de/airports.go so the size classes stay
// comparable across countries.
func airportType(pm *Placemark, heliport bool) string {
	if heliport {
		return "heliport"
	}
	longestFt := 0.0
	if v := pm.Field("RWYLENGTH"); v != "" {
		if m, err := strconv.ParseFloat(v, 64); err == nil {
			longestFt = m / 0.3048
		}
	}
	switch {
	case longestFt >= 8000:
		return "large_airport"
	case longestFt >= 4000:
		return "medium_airport"
	default:
		return "small_airport"
	}
}

// isMilitaryIdent reports whether an Austrian location indicator belongs
// to the LOX block, which the AIP reserves for military aerodromes
// (LOXA Aigen, LOXN Wiener Neustadt West, LOXT Langenlebarn, LOXZ
// Zeltweg).
func isMilitaryIdent(ident string) bool {
	return strings.HasPrefix(strings.ToUpper(ident), "LOX")
}
