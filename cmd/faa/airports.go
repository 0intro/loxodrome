// airports.go emits faa-airports.json from the FAA AIS US_Airport and
// Runways layers.
//
// This is an ENRICHMENT overlay, not a replacement: the OurAirports
// baseline already covers US aerodromes well (it is a US-origin project)
// and carries their tower, ground and approach frequencies. What the FAA
// adds is authority about status: which fields are military, which are
// private-use, and which are closed. OurAirports has no military column
// at all, which is why cmd/de has to carry a curated table for Germany.
//
// It deliberately emits NO frequencies. The hub's Frequency layer joins
// to airports through Services, and Services only carries ATIS, AWOS,
// ASOS, FSS and relay types: there is no tower, ground or approach
// frequency in the hub at all. Emitting the weather frequencies alone
// would be worse than emitting none, because mergeAixmOverlay takes the
// overlay's list whole when it is non-empty
// (`radios: ax.radios.length > 0 ? ax.radios : baseAp.radios`), so
// KORD's six baseline frequencies would collapse to one ATIS.

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
)

const (
	usAirportURL      = "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/US_Airport/FeatureServer/0/query"
	usRunwayURL       = "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/Runways/FeatureServer/0/query"
	usAirportNextURL  = "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/Pending_Airports/FeatureServer/0/query"
	usRunwayNextURL   = "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/Pending_Runway/FeatureServer/0/query"
	defaultMinUsAeros = 10000
	defaultMaxUsAeros = 40000
)

// AirportsMeta is the faa-airports.meta.json document.
type AirportsMeta struct {
	GeneratedAt   string `json:"generatedAt"`
	Source        string `json:"source"`
	SourceSha256  string `json:"sourceSha256"`
	Effective     string `json:"effective"`
	AhpCount      int    `json:"ahpCount"`
	RunwayCount   int    `json:"runwayCount"`
	MilitaryCount int    `json:"militaryCount"`
	JointCount    int    `json:"jointCount"`
	PrivateCount  int    `json:"privateCount"`
	IcaoCount     int    `json:"icaoCount"`
	SkippedNoGeo  int    `json:"skippedNoGeo"`
	// UnknownStatus reports operating-status or military codes the
	// mapping below does not know, which is the drift signal when the
	// FAA extends either list.
	UnknownStatus []string       `json:"unknownStatus"`
	Counts        map[string]int `json:"counts"`
	BBox          aip.BBox       `json:"bbox,omitempty"`
	// BBoxes splits that envelope into the pieces the rows really
	// occupy, for a publisher whose territory is not connected;
	// absent when the rows form one group.
	BBoxes []aip.BBox `json:"bboxes,omitempty"`
}

var airportsOutputFields = []string{
	"ident", "type", "name", "lat", "lon", "elev_ft", "iso_country",
	"municipality", "iata", "runways", "access", "military", "vfr", "ifr",
	"joint", "frequencies", "transition_alt_ft",
}

var airportsRunwayFields = []string{
	"le", "he", "length_ft", "width_ft", "surface", "lit",
	"le_lda_ft", "le_tora_ft", "le_toda_ft", "le_asda_ft",
	"he_lda_ft", "he_tora_ft", "he_toda_ft", "he_asda_ft",
}

var airportsFrequencyFields = []string{"freq", "unit", "call"}

// AirportsOptions configures BuildAirports.
type AirportsOptions struct {
	Now         func() time.Time
	Source      string
	Effective   string
	MinAirports int
	MaxAirports int
}

// usAirportType maps the FAA facility type onto the OurAirports size
// vocabulary the SPA's symbology reads. Runway length settles an
// aerodrome's size band, exactly as the AIXM path does.
func usAirportType(code string, closed bool, longestFt int) string {
	if closed {
		return "closed"
	}
	switch strings.ToUpper(strings.TrimSpace(code)) {
	case "HP":
		return "heliport"
	case "SP":
		return "seaplane_base"
	case "BP":
		return "balloonport"
	case "GL", "UL":
		// Glider and ultralight sites are small aerodromes; the SPA has no
		// separate symbol and they behave like one.
		return "small_airport"
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

// BuildAirports folds the airport and runway layers into one artifact.
func BuildAirports(airports, runways []byte, opts AirportsOptions) (airportsArtifact, AirportsMeta, error) {
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	minN, maxN := opts.MinAirports, opts.MaxAirports
	if minN == 0 {
		minN = defaultMinUsAeros
	}
	if maxN == 0 {
		maxN = defaultMaxUsAeros
	}

	var apt, rwy geoCollection
	if err := json.Unmarshal(airports, &apt); err != nil {
		return airportsArtifact{}, AirportsMeta{}, fmt.Errorf("decode US_Airport: %w", err)
	}
	if err := json.Unmarshal(runways, &rwy); err != nil {
		return airportsArtifact{}, AirportsMeta{}, fmt.Errorf("decode Runways: %w", err)
	}

	// Runways attach to their aerodrome by its GLOBAL_ID.
	type runway struct {
		le, he   string
		lengthFt any
		widthFt  any
		surface  string
		lit      int
	}
	byAirport := map[string][]runway{}
	runwayCount := 0
	for i := range rwy.Features {
		p := rwy.Features[i].Properties
		owner := propString(p, "AIRPORT_ID")
		if owner == "" {
			continue
		}
		le, he, _ := strings.Cut(propString(p, "DESIGNATOR"), "/")
		var lengthFt, widthFt any
		// DIM_UOM is FT throughout; convert anything else rather than
		// assume, so a unit change shows up as a wrong number nowhere.
		toFt := func(v float64) float64 {
			if strings.EqualFold(propString(p, "DIM_UOM"), "M") {
				return v / ftPerMetre
			}
			return v
		}
		if v, ok := propFloat(p, "LENGTH"); ok && v > 0 {
			lengthFt = int(math.Round(toFt(v)))
		}
		if v, ok := propFloat(p, "WIDTH"); ok && v > 0 {
			widthFt = int(math.Round(toFt(v)))
		}
		lit := 0
		if propString(p, "LIGHTINTNS") != "" {
			lit = 1
		}
		byAirport[owner] = append(byAirport[owner], runway{
			le: strings.TrimSpace(le), he: strings.TrimSpace(he),
			lengthFt: lengthFt, widthFt: widthFt,
			surface: strings.TrimSpace(propString(p, "COMP_CODE")),
			lit:     lit,
		})
		runwayCount++
	}

	rows := make([]any, 0, len(apt.Features))
	counts := map[string]int{}
	unknown := map[string]bool{}
	var militaryCount, jointCount, privateCount, icaoCount, skippedNoGeo int

	for i := range apt.Features {
		f := &apt.Features[i]
		p := f.Properties
		lat, lon, ok := f.point()
		if !ok {
			skippedNoGeo++
			continue
		}
		// The ICAO location indicator when the field has one, else the FAA
		// identifier. That is exactly how the OurAirports baseline names US
		// aerodromes (KORD for the 2 861 ICAO-coded fields, the bare 00A /
		// 1G0 form for the rest), so the merge lands on the right row.
		icao := propString(p, "ICAO_ID")
		ident := icao
		if ident == "" {
			ident = propString(p, "IDENT")
		}
		if ident == "" {
			continue
		}
		if icao != "" {
			icaoCount++
		}

		status := strings.ToUpper(propString(p, "OPERSTATUS"))
		closed := false
		switch status {
		case "OPERATIONAL", "":
		case "CLOSED", "INDEFINITE":
			// INDEFINITE is NASR's "closed indefinitely"; a field nobody can
			// plan into is closed, and the repo's rule is that the national
			// AIP's statement settles the type over the baseline's.
			closed = true
		default:
			unknown["OPERSTATUS:"+status] = true
		}

		mil := strings.ToUpper(propString(p, "MIL_CODE"))
		military, joint := false, false
		switch mil {
		case "MIL":
			military = true
		case "ALL":
			// Joint civil / military use.
			military, joint = true, true
		case "CIVIL", "OTHER", "":
		default:
			unknown["MIL_CODE:"+mil] = true
		}
		if military {
			militaryCount++
		}
		if joint {
			jointCount++
		}

		private := false
		if v, ok := propFloat(p, "PRIVATEUSE"); ok && v != 0 {
			private = true
			privateCount++
		}

		rws := byAirport[propString(p, "GLOBAL_ID")]
		longestFt := 0
		for _, r := range rws {
			if n, ok := r.lengthFt.(int); ok {
				longestFt = max(longestFt, n)
			}
		}
		typ := usAirportType(propString(p, "TYPE_CODE"), closed, longestFt)
		counts[typ]++

		var access any
		if private {
			access = "restricted"
		} else {
			access = "cap"
		}
		var elev any
		if v, ok := propFloat(p, "ELEVATION"); ok {
			elev = int(math.Round(v))
		}

		runwayRows := make([]any, 0, len(rws))
		// Stable order so a refresh diff stays readable.
		sort.SliceStable(rws, func(a, b int) bool { return rws[a].le < rws[b].le })
		for _, r := range rws {
			runwayRows = append(runwayRows, []any{
				r.le, r.he, r.lengthFt, r.widthFt, r.surface, r.lit,
				nil, nil, nil, nil, nil, nil, nil, nil,
			})
		}

		rows = append(rows, []any{
			ident,
			typ,
			propString(p, "NAME"),
			aip.Round5(lat),
			aip.Round5(lon),
			elev,
			"US",
			propString(p, "SERVCITY"),
			"", // IATA: not published in this layer
			runwayRows,
			access,
			military,
			// A private-use field is still civilian and VFR-usable with
			// permission, which is the French "usage restreint" treatment:
			// the civil symbol with the restricted tag, not the grey body
			// reserved for fields with no civilian access at all.
			!closed,
			propFloatIs(p, "IAPEXISTS", 1),
			joint,
			[]any{}, // frequencies: see the file comment
			nil,     // transition altitude: the US blanket 18 000 ft is applied by the SPA
		})
	}

	if n := len(rows); n < minN || n > maxN {
		return airportsArtifact{}, AirportsMeta{}, fmt.Errorf(
			"US airport count %d outside sanity window [%d, %d] - source format may have changed",
			n, minN, maxN)
	}

	sort.SliceStable(rows, func(i, j int) bool {
		return rows[i].([]any)[0].(string) < rows[j].([]any)[0].(string)
	})

	unknownList := make([]string, 0, len(unknown))
	for k := range unknown {
		unknownList = append(unknownList, k)
	}
	sort.Strings(unknownList)

	sum := sha256.Sum256(append(append([]byte{}, airports...), runways...))
	meta := AirportsMeta{
		GeneratedAt:   now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Source:        opts.Source,
		SourceSha256:  hex.EncodeToString(sum[:]),
		Effective:     opts.Effective,
		AhpCount:      len(rows),
		RunwayCount:   runwayCount,
		MilitaryCount: militaryCount,
		JointCount:    jointCount,
		PrivateCount:  privateCount,
		IcaoCount:     icaoCount,
		SkippedNoGeo:  skippedNoGeo,
		UnknownStatus: unknownList,
		Counts:        counts,
		BBox:          aip.BBoxOfRows(airportsOutputFields, rows),
		BBoxes:        aip.BBoxClustersOfRows(airportsOutputFields, rows),
	}
	return airportsArtifact{
		Fields:          airportsOutputFields,
		RunwayFields:    airportsRunwayFields,
		FrequencyFields: airportsFrequencyFields,
		Rows:            rows,
	}, meta, nil
}

// airportsArtifact is the faa-airports.json document.
type airportsArtifact struct {
	Fields          []string `json:"fields"`
	RunwayFields    []string `json:"runwayFields"`
	FrequencyFields []string `json:"frequencyFields"`
	Rows            []any    `json:"rows"`
}

// ftPerMetre is the exact international foot.
const ftPerMetre = 0.3048

// propFloatIs reports whether a numeric property equals want.
func propFloatIs(p map[string]any, key string, want float64) bool {
	v, ok := propFloat(p, key)
	return ok && v == want
}

// fetchAirportLayers pulls the aerodrome and runway layers for one slot.
func fetchAirportLayers(ctx context.Context, airportURL, runwayURL string) (airports, runways []byte, err error) {
	if airports, err = fetchFAAPaginated(ctx, airportURL); err != nil {
		return nil, nil, fmt.Errorf("US_Airport: %w", err)
	}
	if runways, err = fetchFAAPaginated(ctx, runwayURL); err != nil {
		return nil, nil, fmt.Errorf("Runways: %w", err)
	}
	return airports, runways, nil
}
