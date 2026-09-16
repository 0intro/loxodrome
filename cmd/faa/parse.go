// parse.go decodes FAA FeatureServer GeoJSON into normalised airspace
// rows. Boundary_Airspace and Special_Use_Airspace share the same field
// layout. Boundary contributes FIR/OCA (which feed viewportIcaos().firs
// on the client) plus richer US controlled-airspace polygons; SUA
// contributes MOAs, Restricted, Prohibited, Warning, and Alert areas.

package main

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"

	"github.com/0intro/loxodrome/internal/overlay"
)

type faaFeature struct {
	Type       string          `json:"type"`
	Properties faaProperties   `json:"properties"`
	Geometry   json.RawMessage `json:"geometry"`
}

// faaProperties covers fields from both Boundary_Airspace and
// Special_Use_Airspace; missing fields (e.g. SUA lacks IDENT/WKHR_CODE)
// decode as the zero value. UPPER_VAL / LOWER_VAL use numString because
// Boundary returns them as integers but SUA returns them as strings; the
// two FeatureServers genuinely differ in encoding for the same logical
// type.
type faaProperties struct {
	IDENT     string    `json:"IDENT"`
	NAME      string    `json:"NAME"`
	TypeCode  string    `json:"TYPE_CODE"`
	Class     string    `json:"CLASS"`
	LocalType string    `json:"LOCAL_TYPE"`
	IcaoID    string    `json:"ICAO_ID"`
	Sector    string    `json:"SECTOR"`
	UpperDesc string    `json:"UPPER_DESC"`
	UpperVal  numString `json:"UPPER_VAL"`
	UpperUOM  string    `json:"UPPER_UOM"`
	UpperCode string    `json:"UPPER_CODE"`
	LowerDesc string    `json:"LOWER_DESC"`
	LowerVal  numString `json:"LOWER_VAL"`
	LowerUOM  string    `json:"LOWER_UOM"`
	LowerCode string    `json:"LOWER_CODE"`
	WkhrCode  string    `json:"WKHR_CODE"`
	WkhrRmk   string    `json:"WKHR_RMK"`
	Remarks   string    `json:"REMARKS"`
	// TimesOfUse is the special-use airspace's published activity prose
	// ("0800 - 2200, DAILY", "CONTINUOUS", "BY NOTAM"); class airspace
	// carries none and takes its hours from the Airspace_Schedule layer
	// instead (schedule.go).
	TimesOfUse string `json:"TIMESOFUSE"`
	// GlobalID keys the Airspace_Schedule join.
	GlobalID string `json:"GLOBAL_ID"`
}

// numString decodes either a JSON number or a JSON string into a float64.
// Empty / null / unparseable strings become 0.
type numString float64

func (n *numString) UnmarshalJSON(b []byte) error {
	if len(b) == 0 || string(b) == "null" {
		*n = 0
		return nil
	}
	if b[0] == '"' {
		var s string
		if err := json.Unmarshal(b, &s); err != nil {
			return err
		}
		s = strings.TrimSpace(s)
		if s == "" {
			*n = 0
			return nil
		}
		v, err := strconv.ParseFloat(s, 64)
		if err != nil {
			// Some SUA rows carry non-numeric markers ("UNL", "NOTAM");
			// leave the value zero and let UpperCode/Desc drive the
			// triple via faaTriple's SFC/unlimited paths.
			*n = 0
			return nil
		}
		*n = numString(v)
		return nil
	}
	var v float64
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	*n = numString(v)
	return nil
}

type faaCollection struct {
	Type     string       `json:"type"`
	Features []faaFeature `json:"features"`
}

// parseFAA decodes a paginated-merged FAA FeatureServer GeoJSON dump.
// Empty input returns no rows.
func parseFAA(data []byte) ([]overlay.Row, error) {
	rows, _, err := parseFAAWithIDs(data)
	return rows, err
}

// parseFAAWithIDs is parseFAA plus the emitted-id to GLOBAL_ID map the
// Airspace_Schedule join needs (schedule.go). A multi-ring airspace fans
// out to several rows under one id, and they all share the one GLOBAL_ID.
func parseFAAWithIDs(data []byte) ([]overlay.Row, map[string]string, error) {
	if len(data) == 0 {
		return nil, nil, nil
	}
	var coll faaCollection
	if err := json.Unmarshal(data, &coll); err != nil {
		return nil, nil, fmt.Errorf("decode FAA: %w", err)
	}
	var rows []overlay.Row
	ids := map[string]string{}
	for _, f := range coll.Features {
		got := featureToRows(f)
		rows = append(rows, got...)
		if gid := strings.TrimSpace(f.Properties.GlobalID); gid != "" && len(got) > 0 {
			ids[got[0].ID] = gid
		}
	}
	return rows, ids, nil
}

// featureToRows turns one FAA feature into 0..N overlay rows: one row per
// geometry ring (a multipolygon airspace fans out across multiple rows
// sharing the same id), or zero if the feature lacks a known type, an id,
// or a valid geometry.
func featureToRows(f faaFeature) []overlay.Row {
	p := f.Properties
	typ := faaEmitType(p.TypeCode)
	if typ == "" {
		return nil
	}
	id := faaID(typ, p)
	if id == "" {
		return nil
	}
	rings, err := overlay.GeomToRings(f.Geometry)
	if err != nil || len(rings) == 0 {
		return nil
	}
	name := faaName(p, id)
	upper := faaTriple(p.UpperCode, p.UpperUOM, float64(p.UpperVal), p.UpperDesc)
	lower := faaTriple(p.LowerCode, p.LowerUOM, float64(p.LowerVal), p.LowerDesc)
	class := strings.TrimSpace(p.Class)
	workHr := strings.TrimSpace(p.TimesOfUse)
	out := make([]overlay.Row, 0, len(rings))
	for _, r := range rings {
		out = append(out, overlay.Row{
			ID: id, Type: typ, Name: name, Class: class,
			Upper: upper, Lower: lower, WorkHr: workHr, Ring: r,
		})
	}
	return out
}

// faaName composes the display name: trimmed NAME, falling back to the
// derived id, with an optional " - SECTOR" suffix when the row carries
// one (sector-split ARTCCs and a handful of CTAs).
func faaName(p faaProperties, fallback string) string {
	name := strings.TrimSpace(p.NAME)
	if name == "" {
		name = fallback
	}
	if p.Sector != "" {
		name += " - " + strings.TrimSpace(p.Sector)
	}
	return name
}

// faaEmitType maps a FAA TYPE_CODE to the type-string we emit, or "" to
// skip. The emitted strings are consumed by AIRSPACE_CATEGORY in
// src/lib/data/airspaces.ts; FIR / OCA land in the 'fir' category and
// feed viewportIcaos.
func faaEmitType(code string) string {
	switch strings.ToUpper(strings.TrimSpace(code)) {
	case "FIR":
		return "FIR"
	case "OCA":
		return "OCA"
	case "ARTCC":
		return "ARTCC"
	case "ACC":
		return "ACC"
	case "CTA", "CTA-P":
		return "CTA"
	case "CLASS":
		return "CLASS"
	case "TRSA":
		return "TRSA"
	case "SATA":
		return "SATA"
	case "UTA":
		return "UTA"
	case "ADIZ":
		return "ADIZ"
	case "DEF":
		return "TFR"
	case "R":
		return "R"
	case "P":
		return "P"
	case "MOA":
		return "MOA"
	case "W":
		return "W"
	case "A":
		return "A"
	}
	return ""
}

// artccIcaoExceptions maps the few non-CONUS ARTCCs to their real ICAO.
// The K-prefix rule below works for the 20 CONUS centres (ZAB..ZTL) but
// Anchorage (PAZA), Honolulu (PHZH), and San Juan (TJZS) sit in other
// ICAO regions.
var artccIcaoExceptions = map[string]string{
	"ZAN": "PAZA",
	"ZHN": "PHZH",
	"ZSU": "TJZS",
}

// faaID derives the canonical id used by viewportIcaos().firs on the
// client and by the autorouter `itemas` list. Source priority depends on
// the airspace type:
//
//   - FIR/OCA: ICAO_ID (4-letter, autorouter-compatible) -> IDENT -> NAME.
//   - ARTCC: CONUS ARTCCs ship as 3-letter Z-prefix codes (ZAB, ZNY, ...);
//     prefixing K yields the 4-letter ICAO the autorouter recognises
//     (KZAB, KZNY) and unlocks US en-route NOTAMs that today silently
//     skip. Non-CONUS ARTCCs (ZAN Alaska, ZHN Hawaii, ZSU Puerto Rico)
//     use different ICAO regions; en-route NOTAMs for those already come
//     via the matching FIR/OCA records (PAZA, PHZH, TJZS), so the IDENT
//     fallback is harmless even though it won't pass ICAO_PATTERN.
//   - Everything else: IDENT -> ICAO_ID -> NAME. The NAME fallback is for
//     Special_Use_Airspace, which carries no IDENT/ICAO_ID; its
//     identifiers (R-2305, A-220, MOA names) live in NAME.
func faaID(typ string, p faaProperties) string {
	icao := strings.ToUpper(strings.TrimSpace(p.IcaoID))
	ident := strings.ToUpper(strings.TrimSpace(p.IDENT))
	name := strings.ToUpper(strings.TrimSpace(p.NAME))
	switch typ {
	case "FIR", "OCA":
		if icao != "" {
			return icao
		}
		if ident != "" {
			return ident
		}
		return name
	case "ARTCC":
		if exc, ok := artccIcaoExceptions[ident]; ok {
			return exc
		}
		if len(ident) == 3 && ident[0] == 'Z' {
			return "K" + ident
		}
		if ident != "" {
			return ident
		}
	}
	if ident != "" {
		return ident
	}
	if icao != "" {
		return icao
	}
	return name
}

// faaTriple converts FAA upper/lower fields into the SIA [code,val,uom]
// triple the SPA's vertical core parses. Conventions: SFC -> ("SFC","","");
// unlimited -> ("UNL","",""); FL band -> ("STD",val,"FL"); MSL feet ->
// ("ALT",val,"FT"); AGL feet -> ("HEI",val,"FT"); a blank or unrecognized
// code keeps an EMPTY datum ("" renders bare and compares as AMSL
// downstream) rather than claiming standard-pressure: live rows like
// R-4001B publish "10000 FT" MSL with a null code.
func faaTriple(code, uom string, val float64, desc string) []string {
	code = strings.ToUpper(strings.TrimSpace(code))
	uom = strings.ToUpper(strings.TrimSpace(uom))
	descU := strings.ToUpper(strings.TrimSpace(desc))

	if code == "SFC" || strings.Contains(descU, "SFC") || strings.Contains(descU, "SURFACE") {
		return []string{"SFC", "", ""}
	}
	if code == "UNLTD" || strings.Contains(descU, "UNLIMITED") {
		return []string{"UNL", "", ""}
	}
	valStr := formatFAAValue(val)
	if valStr == "" {
		return nil
	}
	siaCode := ""
	switch code {
	case "STD":
		siaCode = "STD"
	case "MSL", "AMSL":
		if uom == "FL" {
			siaCode = "STD"
		} else {
			siaCode = "ALT"
		}
	case "AGL", "HEI":
		siaCode = "HEI"
	}
	// An FL unit is standard-pressure by definition, whatever the code said.
	if siaCode == "" && uom == "FL" {
		siaCode = "STD"
	}
	return []string{siaCode, valStr, uom}
}

// formatFAAValue prints a FAA numeric altitude value: integer when whole,
// otherwise one decimal. Zero is treated as "no value" since FAA stores
// SFC as (val=0, code=SFC) which we already handled. The exact sentinels
// -9998 and -9999 ("value not provided") also become "no value" so
// faaTriple returns nil and the row ends up with a null upper / lower.
// Any other negative value (e.g. Bar Yehuda airfield's -1300 ft MSL at
// the Dead Sea) is preserved verbatim; a broad range guard would silently
// drop legitimate sub-sea-level altitudes.
func formatFAAValue(v float64) string {
	if v == 0 || v == -9998 || v == -9999 {
		return ""
	}
	if math.Floor(v) == v {
		return strconv.FormatInt(int64(v), 10)
	}
	return strconv.FormatFloat(v, 'f', 1, 64)
}
