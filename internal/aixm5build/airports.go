// airports.go builds the <cc>-airports.json artifact every publisher
// shares. The schema mirrors cmd/fr's fr-airports.json so the SPA loader
// can merge each national overlay onto the worldwide OurAirports baseline
// by ICAO.
//
// This used to be a per-command file copied between cmd/uk, cmd/es, cmd/de
// and cmd/be, differing only in the country label, the ICAO-to-ISO map and
// (for Belgium) a trailing chart column. Those are options now; the
// behaviour is one implementation.
//
// cmd/at keeps its own builder: Austro Control publishes aerodromes as KML
// placemarks, not AirportHeliport features, so it has no *aixm5.Message to
// hand us.

package aixm5build

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/aixm5"
)

const (
	defaultMinAirports = 0
	defaultMaxAirports = 5000
)

// ftPerM is the exact international foot.
const ftPerM = 0.3048

// airportsOutputFields mirrors cmd/fr/airports.go. A publisher carrying
// aerodrome charts appends a trailing "charts" column; trailing columns
// are additive-safe because the SPA reads by index and ignores extras.
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

// AirportsArtifact is the <cc>-airports.json document.
type AirportsArtifact struct {
	Fields          []string `json:"fields"`
	RunwayFields    []string `json:"runwayFields"`
	FrequencyFields []string `json:"frequencyFields"`
	// ChartFields is present only for publishers that carry an
	// aerodrome-chart column (Belgium today).
	ChartFields []string `json:"chartFields,omitempty"`
	Rows        []any    `json:"rows"`
}

// AirportsMeta is the <cc>-airports.meta.json document.
type AirportsMeta struct {
	GeneratedAt        string `json:"generatedAt"`
	Source             string `json:"source"`
	SourceSha256       string `json:"sourceSha256"`
	Effective          string `json:"effective"`
	AhpCount           int    `json:"ahpCount"`
	RunwayCount        int    `json:"runwayCount"`
	MilitaryCount      int    `json:"militaryCount"`
	RadioCount         int    `json:"radioCount"`
	TransitionAltCount int    `json:"transitionAltCount"`
	// ChartCount rides along only for a publisher with a chart column.
	ChartCount int            `json:"chartCount,omitempty"`
	Counts     map[string]int `json:"counts"`
	// BBox is the emitted rows' lat/lon envelope (bbox.go).
	BBox aip.BBox `json:"bbox,omitempty"`
	// BBoxes splits that envelope into the pieces the rows really
	// occupy, for a publisher whose territory is not connected; absent
	// when the rows form one group.
	BBoxes []aip.BBox `json:"bboxes,omitempty"`
}

// AirportsOptions configures BuildAirports.
type AirportsOptions struct {
	// Country labels the sanity-window error ("DE", "UK", ...).
	Country string
	// CountryFromIcao maps an ICAO designator to its ISO-3166 code.
	// Required: it is the one genuinely per-publisher rule here, since
	// each State's AIP covers a different prefix family.
	CountryFromIcao func(icao string) string
	Now             func() time.Time
	MinAirports     int
	MaxAirports     int
	// Charts, when non-nil, appends the trailing chart column, taking
	// each aerodrome's entries from Charts[icao]. ChartFields names the
	// shape of one entry and must be set with it.
	Charts      map[string][]any
	ChartFields []string
}

// BuildAirports emits one row per AIXM AirportHeliport that has an ICAO
// designator. Entries without one are dropped, mirroring cmd/fr's
// behaviour for landing strips with no code.
//
// A designator published twice keeps the richer record, judged by runway
// count: ENAIRE files an aerodrome in both its own per-aerodrome document
// (runways, IATA, city, control type) and the bundled
// ADHP_Restricted / ADHP_Temp lists (header only), and the header-only
// copy must not win.
func BuildAirports(msg *aixm5.Message, source string, raw []byte, effective string, opts AirportsOptions) (AirportsArtifact, AirportsMeta, error) {
	if opts.CountryFromIcao == nil {
		return AirportsArtifact{}, AirportsMeta{}, fmt.Errorf("airports: CountryFromIcao is required")
	}
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	minN, maxN := opts.MinAirports, opts.MaxAirports
	if minN == 0 {
		minN = defaultMinAirports
	}
	if maxN == 0 {
		maxN = defaultMaxAirports
	}

	idents := make([]string, 0, len(msg.Airports))
	byIcao := map[string]*aixm5.Airport{}
	for i := range msg.Airports {
		a := &msg.Airports[i]
		icao := strings.TrimSpace(a.Designator)
		if icao == "" {
			continue
		}
		if prev, dup := byIcao[icao]; dup {
			if len(a.Runways) > len(prev.Runways) {
				byIcao[icao] = a
			}
			continue
		}
		byIcao[icao] = a
		idents = append(idents, icao)
	}
	sort.Strings(idents)

	rows := make([]any, 0, len(idents))
	counts := map[string]int{}
	runwayCount := 0
	militaryCount := 0
	radioCount := 0
	transitionAltCount := 0
	chartCount := 0
	for _, icao := range idents {
		a := byIcao[icao]
		military := isMilitary(a)
		if military {
			militaryCount++
		}
		runwayCount += len(a.Runways)
		radios := aixm5.CurateAirportRadios(a.Radio)
		radioCount += len(radios)
		if a.TransitionAltM != nil {
			transitionAltCount++
		}
		var charts []any
		if opts.Charts != nil {
			charts = opts.Charts[icao]
			chartCount += len(charts)
		}
		rows = append(rows, airportRow(a, military, radios, opts, charts))
		counts[deriveAirportType(a)]++
	}

	if n := len(rows); n < minN || n > maxN {
		return AirportsArtifact{}, AirportsMeta{}, fmt.Errorf(
			"%s airport count %d outside sanity window [%d, %d] - source format may have changed",
			opts.Country, n, minN, maxN)
	}

	sum := sha256.Sum256(raw)
	meta := AirportsMeta{
		GeneratedAt:        now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Source:             source,
		SourceSha256:       hex.EncodeToString(sum[:]),
		Effective:          effective,
		AhpCount:           len(rows),
		RunwayCount:        runwayCount,
		MilitaryCount:      militaryCount,
		RadioCount:         radioCount,
		TransitionAltCount: transitionAltCount,
		Counts:             counts,
	}
	artifact := AirportsArtifact{
		Fields:          airportsOutputFields,
		RunwayFields:    airportsRunwayFields,
		FrequencyFields: airportsFrequencyFields,
		Rows:            rows,
	}
	if opts.Charts != nil {
		artifact.Fields = append(append([]string{}, airportsOutputFields...), "charts")
		artifact.ChartFields = opts.ChartFields
		meta.ChartCount = chartCount
	}
	meta.BBox = aip.BBoxOfRows(artifact.Fields, artifact.Rows)
	return artifact, meta, nil
}

// IcaoCountry builds a CountryFromIcao function from an ICAO
// two-letter prefix table. Every publisher needs one and they differ
// only in their table, since each State's AIP covers a different prefix
// family (and sometimes a neighbour's, as cross-border reference).
// An ident too short to carry a prefix, or one outside the table, takes
// the fallback: the AIP's own State.
func IcaoCountry(prefixes map[string]string, fallback string) func(string) string {
	return func(icao string) string {
		if len(icao) < 2 {
			return fallback
		}
		if iso, ok := prefixes[strings.ToUpper(icao[:2])]; ok {
			return iso
		}
		return fallback
	}
}

// isMilitary reads the effective military status. The decoder already
// sets Airport.Military from a controlType of MILITARY or JOINT
// (internal/aixm5/airport.go); the controlType test here additionally
// catches the abbreviated "MIL" some publishers file.
func isMilitary(a *aixm5.Airport) bool {
	if a.Military {
		return true
	}
	return strings.EqualFold(a.ControlType, "MILITARY") || strings.EqualFold(a.ControlType, "MIL")
}

func airportRow(a *aixm5.Airport, military bool, radios []any, opts AirportsOptions, charts []any) []any {
	var elev any
	if a.ElevM != nil {
		elev = int(math.Round(*a.ElevM / ftPerM))
	}
	var transitionAlt any
	if a.TransitionAltM != nil {
		transitionAlt = int(math.Round(*a.TransitionAltM / ftPerM))
	}
	var access any
	if a.Access != "" {
		access = a.Access
	}
	row := []any{
		a.Designator,
		deriveAirportType(a),
		a.Name,
		a.Lat,
		a.Lon,
		elev,
		opts.CountryFromIcao(a.Designator),
		a.City,
		a.IATA,
		runwayRows(a.Runways),
		access,
		military,
		a.VFR,
		a.IFR,
		a.Joint,
		radios,
		transitionAlt,
	}
	if opts.Charts != nil {
		if charts == nil {
			charts = []any{}
		}
		row = append(row, charts)
	}
	return row
}

// deriveAirportType maps the AIXM type + longest runway onto the
// OurAirports size vocabulary, which is what the SPA's symbology and
// hasLikelyVac read. aixm:abandoned is the AIP's permanent statement
// about the field, so it settles the type ahead of the shape: EDOP /
// EDHP / EDCK keep their runways and are still closed.
func deriveAirportType(a *aixm5.Airport) string {
	if a.Abandoned {
		return "closed"
	}
	switch strings.ToUpper(strings.TrimSpace(a.Type)) {
	case "HP":
		return "heliport"
	case "LS":
		return "small_airport"
	}
	longestFt := 0
	for _, r := range a.Runways {
		if r.LengthM == nil {
			continue
		}
		ft := int(math.Round(*r.LengthM / ftPerM))
		longestFt = max(longestFt, ft)
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

func runwayRows(rws []aixm5.Runway) []any {
	out := make([]any, 0, len(rws))
	for _, r := range rws {
		out = append(out, []any{
			r.Le, r.He,
			feetFromMetres(r.LengthM),
			feetFromMetres(r.WidthM),
			r.Surface,
			0, // lit: AIXM 5.1 carries lighting on aixm:AeronauticalGroundLight; defer
			feetFromMetres(r.LeLdaM),
			feetFromMetres(r.LeToraM),
			feetFromMetres(r.LeTodaM),
			feetFromMetres(r.LeAsdaM),
			feetFromMetres(r.HeLdaM),
			feetFromMetres(r.HeToraM),
			feetFromMetres(r.HeTodaM),
			feetFromMetres(r.HeAsdaM),
		})
	}
	return out
}

func feetFromMetres(m *float64) any {
	if m == nil {
		return nil
	}
	return int(math.Round(*m / ftPerM))
}
