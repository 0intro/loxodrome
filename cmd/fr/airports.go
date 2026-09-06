// airports.go decodes the SIA AIXM 4.5 export for airport-relevant elements
// (Ahp, Rwy, Rdd, Rls, Ahu), merges them into per-ident records, and emits
// fr-airports.json containing only French AIXM-sourced aerodromes. The SPA
// loader merges this on top of the worldwide OurAirports baseline from
// cmd/airports. Moved from cmd/airports' AIXM-augmentation half during the
// cmd/fr consolidation.

package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"io"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
)

// Sanity window on the emitted row count. The floor sits above the ~545
// aerodromes the export codes with an ICAO indicator, so losing the codeId
// fallback in indexAhps (which carries the other ~295) fails the build
// instead of silently shipping a France without hospital helipads.
const (
	defaultMinFrAirports = 700
	defaultMaxFrAirports = 1200
)

// airportsOutputFields is the row layout of fr-airports.json. The schema
// mirrors the worldwide airports.json (rows.go in cmd/airports), so the SPA
// can dedup-merge by ICAO across both files; transition_alt_ft is AIXM-only
// (the 16-column baseline omits it, and the SPA loader defaults the missing
// trailing element to null).
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

// airportsRunwayFields mirrors the RunwayRow tuple in src/lib/data/airports.ts.
// The eight per-direction declared-distance fields come from AIXM <Rdd>
// records (TORA / TODA / ASDA / LDA per direction); le_lgt / he_lgt carry the
// per-direction AD 2.14 lighting object (Rls light lines + Rda approach
// lighting + Rdn VASIS/PAPI), null when the direction is unlit. le_pos /
// he_pos are the physical ends as [lat, lon], read from the AIXM <Rcp>
// centreline points; null where the strip has none.
var airportsRunwayFields = []string{
	"le", "he", "length_ft", "width_ft", "surface", "lit",
	"le_lda_ft", "le_tora_ft", "le_toda_ft", "le_asda_ft",
	"he_lda_ft", "he_tora_ft", "he_toda_ft", "he_asda_ft",
	"le_lgt", "he_lgt",
	"le_pos", "he_pos",
}

// airportsFrequencyFields mirrors FREQ_IDX in src/lib/data/airports.ts.
// One triple per radio service: the published MHz string, the curated
// service label (TWR / APP / ATIS / AFIS / A/A / …), and the spoken call
// sign. Built from AIXM <Sah> (service<->aerodrome) + <Fqy> records.
var airportsFrequencyFields = []string{"freq", "unit", "call"}

// frServiceLabel maps an AIXM 4.5 service codeType to the canonical label
// shown in the airport panel, and reports whether the service is kept. The
// curated ATC/info set drops military/technical services (PAR, UDF, ALRS) and
// VDF: SIA publishes direction-finding (gonio) on the SAME frequencies as the
// field's TWR / APP / FIS services, so keeping it just duplicates every channel
// with a GONIO tag. SIA models an uncontrolled field's auto-information
// frequency as an "OTHER" service carrying the field's own call sign, so OTHER
// maps to A/A. Labels match the OurAirports (cmd/airports) and UK (cmd/uk)
// vocabularies.
var frServiceLabel = map[string]string{
	"TWR":   "TWR",
	"APP":   "APP",
	"AFIS":  "AFIS",
	"ATIS":  "ATIS",
	"FIS":   "FIS",
	"ACS":   "ACS",
	"OTHER": "A/A",
}

// AirportsArtifact is the fr-airports.json document.
type AirportsArtifact struct {
	Fields          []string `json:"fields"`
	RunwayFields    []string `json:"runwayFields"`
	FrequencyFields []string `json:"frequencyFields"`
	Rows            []any    `json:"rows"`
}

// AirportsMeta is the fr-airports.meta.json document.
type AirportsMeta struct {
	GeneratedAt  string `json:"generatedAt"`
	Source       string `json:"source"`
	SourceSha256 string `json:"sourceSha256"`
	Effective    string `json:"effective"`
	AhpCount     int    `json:"ahpCount"`
	// NationalCodeCount; aerodromes published with no ICAO location
	// indicator, carrying the SIA's own codeId as their ident (see
	// indexAhps). Tracks the share of the export that would be lost by
	// keying on codeIcao alone.
	NationalCodeCount int            `json:"nationalCodeCount"`
	AccessCounts      map[string]int `json:"accessCounts"`
	// BBox is the emitted rows' lat/lon envelope, which the SPA uses to
	// skip fetching a publisher the current view cannot reach (aip/bbox.go).
	BBox aip.BBox `json:"bbox,omitempty"`
	// BBoxes splits that envelope into the pieces the rows really
	// occupy, for a publisher whose territory is not connected;
	// absent when the rows form one group.
	BBoxes             []aip.BBox `json:"bboxes,omitempty"`
	MilitaryCount      int        `json:"militaryCount"`
	RadioCount         int        `json:"radioCount"`
	TransitionAltCount int        `json:"transitionAltCount"`
}

// AirportsOptions configures BuildAirports.
type AirportsOptions struct {
	Source      string
	Now         func() time.Time // overridable for tests
	MinAirports int              // sanity window; 0 uses the default
	MaxAirports int
}

// BuildAirports decodes the AIXM source and produces the AIXM-derived
// French airports artefact + meta.
func BuildAirports(src []byte, opts AirportsOptions) (AirportsArtifact, AirportsMeta, error) {
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	minN, maxN := opts.MinAirports, opts.MaxAirports
	if minN == 0 {
		minN = defaultMinFrAirports
	}
	if maxN == 0 {
		maxN = defaultMaxFrAirports
	}

	airports, err := buildAixmAirports(src)
	if err != nil {
		return AirportsArtifact{}, AirportsMeta{}, err
	}

	// Sorted ident order keeps the output diff-stable across runs.
	icaos := make([]string, 0, len(airports))
	for k := range airports {
		icaos = append(icaos, k)
	}
	sort.Strings(icaos)

	accessCounts := map[string]int{}
	militaryCount := 0
	radioCount := 0
	transitionAltCount := 0
	nationalCodeCount := 0
	rows := make([]any, 0, len(airports))
	for _, icao := range icaos {
		ax := airports[icao]
		rows = append(rows, buildRowFromAixm(ax))
		if ax.Access != "" {
			accessCounts[ax.Access]++
		}
		if ax.NationalCode {
			nationalCodeCount++
		}
		if ax.Military {
			militaryCount++
		}
		radioCount += len(ax.Radio)
		if ax.TransitionAltFt != nil {
			transitionAltCount++
		}
	}

	if n := len(rows); n < minN || n > maxN {
		return AirportsArtifact{}, AirportsMeta{}, fmt.Errorf(
			"airport count %d outside sanity window [%d, %d] - source format may have changed",
			n, minN, maxN)
	}

	sum := sha256.Sum256(src)
	// Fail loud: an empty effective would route a -target auto pre-release
	// run onto the active slot (aip.ResolveTarget treats "" as current).
	effective, err := readAIXMEffective(src)
	if err != nil {
		return AirportsArtifact{}, AirportsMeta{}, fmt.Errorf("effective: %w", err)
	}
	meta := AirportsMeta{
		GeneratedAt:        now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Source:             opts.Source,
		SourceSha256:       hex.EncodeToString(sum[:]),
		Effective:          effective,
		AhpCount:           len(rows),
		NationalCodeCount:  nationalCodeCount,
		AccessCounts:       accessCounts,
		MilitaryCount:      militaryCount,
		RadioCount:         radioCount,
		TransitionAltCount: transitionAltCount,
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

// readAIXMEffective extracts the `effective` attribute from the AIXM
// document's root <AIXM-Snapshot> element. Streams only as far as the
// first StartElement so a 40 MB file costs roughly nothing.
func readAIXMEffective(data []byte) (string, error) {
	dec := xml.NewDecoder(bytes.NewReader(data))
	for {
		tok, err := dec.Token()
		if err != nil {
			return "", fmt.Errorf("scan AIXM head: %w", err)
		}
		se, ok := tok.(xml.StartElement)
		if !ok {
			continue
		}
		for _, attr := range se.Attr {
			if attr.Name.Local == "effective" {
				return attr.Value, nil
			}
		}
		return "", fmt.Errorf("AIXM root element %q has no `effective` attribute", se.Name.Local)
	}
}

// aixmAhp; aerodrome / heliport / landing-strip header.
type aixmAhp struct {
	Uid struct {
		Mid    int64  `xml:"mid,attr"`
		CodeId string `xml:"codeId"`
	} `xml:"AhpUid"`
	TxtName        string `xml:"txtName"`
	CodeIcao       string `xml:"codeIcao"`
	CodeIata       string `xml:"codeIata"`
	CodeType       string `xml:"codeType"` // AD / HP / LS
	TxtDescrRefPt  string `xml:"txtDescrRefPt"`
	GeoLat         string `xml:"geoLat"`
	GeoLong        string `xml:"geoLong"`
	ValElev        string `xml:"valElev"`
	TxtNameCitySer string `xml:"txtNameCitySer"`
	// Transition altitude (AD 2.2). SIA publishes it only on aerodromes
	// under a TMA (AIP ENR 1.7), always with uom FT.
	ValTransitionAlt string `xml:"valTransitionAlt"`
	UomTransitionAlt string `xml:"uomTransitionAlt"`
}

// aixmRwy; a single runway pair (the strip), linked to its Ahp by codeId.
type aixmRwy struct {
	Uid struct {
		Mid    int64 `xml:"mid,attr"`
		AhpUid struct {
			CodeId string `xml:"codeId"`
		} `xml:"AhpUid"`
		TxtDesig string `xml:"txtDesig"` // e.g. "09L/27R"
	} `xml:"RwyUid"`
	ValLen          string `xml:"valLen"`
	ValWid          string `xml:"valWid"`
	UomDimRwy       string `xml:"uomDimRwy"` // M / FT
	CodeComposition string `xml:"codeComposition"`
}

// aixmRcp; a runway centreline point. The AIXM gives several per strip,
// all on the axis: the two thresholds and, where the runway has them, the
// displaced ones. The two EXTREMES are the physical ends, which is what a
// chart draws and what a diagram has to be fitted to.
type aixmRcp struct {
	Uid struct {
		RwyUid struct {
			AhpUid struct {
				CodeId string `xml:"codeId"`
			} `xml:"AhpUid"`
			TxtDesig string `xml:"txtDesig"`
		} `xml:"RwyUid"`
		GeoLat  string `xml:"geoLat"`
		GeoLong string `xml:"geoLong"`
	} `xml:"RcpUid"`
}

// aixmRdd; per-direction declared distance (TORA / TODA / ASDA / LDA).
type aixmRdd struct {
	Uid struct {
		RdnUid struct {
			RwyUid struct {
				AhpUid struct {
					CodeId string `xml:"codeId"`
				} `xml:"AhpUid"`
				TxtDesig string `xml:"txtDesig"`
			} `xml:"RwyUid"`
			TxtDesig string `xml:"txtDesig"` // direction designator, e.g. "09L"
		} `xml:"RdnUid"`
		CodeType string `xml:"codeType"` // TORA / TODA / ASDA / LDA
	} `xml:"RddUid"`
	ValDist string `xml:"valDist"`
	UomDist string `xml:"uomDist"` // M / FT
}

// aixmRls; one runway lighting element (a light line), attached to a runway
// direction. codePsn is where it sits (EDGE / THR / END / CL / TDZ / SWYCL),
// with a colour and optional intensity. Any Rls on a runway makes it lit.
type aixmRls struct {
	Uid struct {
		RdnUid struct {
			RwyUid struct {
				AhpUid struct {
					CodeId string `xml:"codeId"`
				} `xml:"AhpUid"`
				TxtDesig string `xml:"txtDesig"`
			} `xml:"RwyUid"`
			TxtDesig string `xml:"txtDesig"` // direction designator (QFU)
		} `xml:"RdnUid"`
		CodePsn string `xml:"codePsn"` // EDGE / THR / END / CL / TDZ / SWYCL / OTHER
	} `xml:"RlsUid"`
	CodeColour string `xml:"codeColour"` // WHI / RED / GRN / BLU / YEL
	CodeIntst  string `xml:"codeIntst"`  // LIH / LIM / LIL
}

// aixmRda; an approach lighting system serving a runway direction (AD 2.14).
type aixmRda struct {
	Uid struct {
		RdnUid struct {
			RwyUid struct {
				AhpUid struct {
					CodeId string `xml:"codeId"`
				} `xml:"AhpUid"`
				TxtDesig string `xml:"txtDesig"`
			} `xml:"RwyUid"`
			TxtDesig string `xml:"txtDesig"`
		} `xml:"RdnUid"`
		CodeType string `xml:"codeType"` // A / SSALS / ... (approach-light system)
	} `xml:"RdaUid"`
	ValLen    string `xml:"valLen"`
	UomLen    string `xml:"uomLen"`
	CodeIntst string `xml:"codeIntst"`
}

// aixmRdn; a runway direction. We take only the VASIS / PAPI approach-slope
// indicator (AD 2.14); the runway geometry itself comes from Rwy / Rdd.
type aixmRdn struct {
	Uid struct {
		RwyUid struct {
			AhpUid struct {
				CodeId string `xml:"codeId"`
			} `xml:"AhpUid"`
			TxtDesig string `xml:"txtDesig"`
		} `xml:"RwyUid"`
		TxtDesig string `xml:"txtDesig"`
	} `xml:"RdnUid"`
	CodeTypeVasis string `xml:"codeTypeVasis"` // PAPI / APAPI
	CodePsnVasis  string `xml:"codePsnVasis"`  // LEFT / RIGHT
}

// aixmAhu; aerodrome usage. One Ahu per Ahp; the UsageLimitation list
// inside it holds one FlightClass row per (GAT/OAT × rule × purpose), and
// that row is what carries the open/private/military signal.
type aixmAhu struct {
	Uid struct {
		AhpUid struct {
			CodeId string `xml:"codeId"`
		} `xml:"AhpUid"`
	} `xml:"AhuUid"`
	Limits []struct {
		CodeUsage  string `xml:"codeUsageLimitation"` // OTHER / PERMIT / RESERV
		Conditions []struct {
			FlightClass struct {
				CodeType    string `xml:"codeType"`    // GAT (civilian) / OAT (state)
				CodeRule    string `xml:"codeRule"`    // V (VFR-only) / IV (IFR+VFR)
				CodeStatus  string `xml:"codeStatus"`  // STATE => military
				CodePurpose string `xml:"codePurpose"` // P (private) / S (scheduled) / NS / OTHER / T
			} `xml:"FlightClass"`
		} `xml:"UsageCondition"`
	} `xml:"UsageLimitation"`
}

// aixmAirport is the merged-per-ICAO record we feed back into the row
// builder.
type aixmAirport struct {
	Ident    string
	Name     string
	CodeType string // AD / HP / LS
	Lat, Lon float64
	ElevFt   *int
	// TransitionAltFt; the published transition altitude. Nil when the
	// aerodrome has none (no overlying TMA) or publishes a 0 placeholder.
	TransitionAltFt *int
	IsoCountry      string
	City            string
	Iata            string
	// Access; derived from the GAT codeUsageLimitation inside Ahu (see
	// applyUsage). "cap" when a GAT block is PERMIT (ouvert à la CAP),
	// "restricted" when GAT is OTHER-only (usage restreint) or absent
	// (military / state-only), "" when no Ahu was seen for this ident.
	Access string
	// NationalCode; the Ident is the SIA's own codeId, the aerodrome having
	// no ICAO location indicator (see indexAhps). Meta counter only.
	NationalCode bool
	Military     bool // any FlightClass codeStatus = STATE
	// VFR / IFR; civilian (GAT) flight-rule support. Most small fields are
	// VFR-only; commercial/towered fields support both via codeRule=IV.
	Vfr     bool
	Ifr     bool
	Runways []aixmRunway
	// Radio is the curated [freq, label, callSign] triples for this
	// aerodrome, joined from the <Sah> service links and <Fqy> frequencies.
	Radio []any
}

// Sah links a service to an aerodrome. SahUid embeds the full SerUid inline
// (mid, service codeType, unit name), so no separate <Ser> lookup is needed;
// it is the airport twin of the Sae (service<->airspace) link.
type Sah struct {
	Uid struct {
		AhpCodeId string `xml:"AhpUid>codeId"`
		Ser       struct {
			Mid      int64  `xml:"mid,attr"`
			CodeType string `xml:"codeType"`
			UniName  string `xml:"UniUid>txtName"`
		} `xml:"SerUid"`
	} `xml:"SahUid"`
}

// lightLine is one Rls light element: its position, colour and intensity.
type lightLine struct {
	Psn    string
	Colour string
	Intst  string
}

// vasisLight is a VASIS / PAPI approach-slope indicator (Rdn).
type vasisLight struct {
	Type string // PAPI / APAPI
	Side string // LEFT / RIGHT
}

// approachLight is an approach lighting system (Rda).
type approachLight struct {
	Type string
	LenM *int
}

// dirLighting is one runway direction's AD 2.14 lighting.
type dirLighting struct {
	Lines []lightLine
	Papi  *vasisLight
	Als   *approachLight
}

type aixmRunway struct {
	Le, He   string
	LengthFt *int
	WidthFt  *int
	Surface  string
	Lit      int
	LeLdaFt  *int
	LeToraFt *int
	LeTodaFt *int
	LeAsdaFt *int
	HeLdaFt  *int
	HeToraFt *int
	HeTodaFt *int
	HeAsdaFt *int
	// Per-direction AD 2.14 lighting; nil when the direction has none.
	LeLighting *dirLighting
	HeLighting *dirLighting
	// The physical ends, WGS84, nil when the AIXM gives no centreline
	// point for the strip.
	LePos *[2]float64
	HePos *[2]float64
}

// aixmStreams holds the element slices decodeAixm collects in one pass.
type aixmStreams struct {
	ahps []aixmAhp
	rwys []aixmRwy
	rcps []aixmRcp
	rdds []aixmRdd
	rdas []aixmRda
	rdns []aixmRdn
	rlss []aixmRls
	ahus []aixmAhu
	sahs []Sah
	fqys []Fqy
}

// decodeAixm streams the AIXM XML, decoding only the elements we care about.
func decodeAixm(src []byte) (aixmStreams, error) {
	var s aixmStreams
	dec := xml.NewDecoder(bytes.NewReader(src))
	for {
		tok, e := dec.Token()
		if e == io.EOF {
			break
		}
		if e != nil {
			return aixmStreams{}, fmt.Errorf("reading AIXM XML: %w", e)
		}
		se, ok := tok.(xml.StartElement)
		if !ok {
			continue
		}
		switch se.Name.Local {
		case "AIXM-Snapshot":
			// Pass-through; descend into its children.
			continue
		case "Ahp":
			var v aixmAhp
			if err := dec.DecodeElement(&v, &se); err != nil {
				return aixmStreams{}, fmt.Errorf("decoding Ahp: %w", err)
			}
			s.ahps = append(s.ahps, v)
		case "Rwy":
			var v aixmRwy
			if err := dec.DecodeElement(&v, &se); err != nil {
				return aixmStreams{}, fmt.Errorf("decoding Rwy: %w", err)
			}
			s.rwys = append(s.rwys, v)
		case "Rcp":
			var v aixmRcp
			if err := dec.DecodeElement(&v, &se); err != nil {
				return aixmStreams{}, fmt.Errorf("decoding Rcp: %w", err)
			}
			s.rcps = append(s.rcps, v)
		case "Rdd":
			var v aixmRdd
			if err := dec.DecodeElement(&v, &se); err != nil {
				return aixmStreams{}, fmt.Errorf("decoding Rdd: %w", err)
			}
			s.rdds = append(s.rdds, v)
		case "Rls":
			var v aixmRls
			if err := dec.DecodeElement(&v, &se); err != nil {
				return aixmStreams{}, fmt.Errorf("decoding Rls: %w", err)
			}
			s.rlss = append(s.rlss, v)
		case "Rda":
			var v aixmRda
			if err := dec.DecodeElement(&v, &se); err != nil {
				return aixmStreams{}, fmt.Errorf("decoding Rda: %w", err)
			}
			s.rdas = append(s.rdas, v)
		case "Rdn":
			var v aixmRdn
			if err := dec.DecodeElement(&v, &se); err != nil {
				return aixmStreams{}, fmt.Errorf("decoding Rdn: %w", err)
			}
			s.rdns = append(s.rdns, v)
		case "Ahu":
			var v aixmAhu
			if err := dec.DecodeElement(&v, &se); err != nil {
				return aixmStreams{}, fmt.Errorf("decoding Ahu: %w", err)
			}
			s.ahus = append(s.ahus, v)
		case "Sah":
			var v Sah
			if err := dec.DecodeElement(&v, &se); err != nil {
				return aixmStreams{}, fmt.Errorf("decoding Sah: %w", err)
			}
			s.sahs = append(s.sahs, v)
		case "Fqy":
			var v Fqy
			if err := dec.DecodeElement(&v, &se); err != nil {
				return aixmStreams{}, fmt.Errorf("decoding Fqy: %w", err)
			}
			s.fqys = append(s.fqys, v)
		default:
			if err := dec.Skip(); err != nil {
				return aixmStreams{}, fmt.Errorf("skipping <%s>: %w", se.Name.Local, err)
			}
		}
	}
	return s, nil
}

// rddKey indexes a per-direction declared distance by aerodrome, runway
// strip designator, and direction designator.
type rddKey struct{ icao, rwy, rdn string }

// rwyKey indexes a runway strip by aerodrome and strip designator.
type rwyKey struct{ icao, rwy string }

// buildAixmAirports decodes the AIXM XML and links the streams into a
// per-ident airport record (the ICAO indicator, else the SIA codeId).
func buildAixmAirports(src []byte) (map[string]*aixmAirport, error) {
	s, err := decodeAixm(src)
	if err != nil {
		return nil, err
	}
	out, icaoByCodeId := indexAhps(s)
	rddByKey, litByRwy := indexRddsRls(s, icaoByCodeId)
	lights := indexLighting(s, icaoByCodeId)
	attachRunways(out, s, icaoByCodeId, rddByKey, litByRwy, lights)
	applyUsage(out, s, icaoByCodeId)
	attachRadios(out, s, icaoByCodeId)
	return out, nil
}

// attachRadios joins each aerodrome's <Sah> service links to the <Fqy>
// frequency records (by service mid) and folds the curated [freq, label,
// callSign] triples onto the airport record. Mirrors buildRadio in
// airspaces.go, keyed by aerodrome codeId via Sah instead of airspace mid
// via Sae. Non-allowlisted services and blank frequencies are dropped, and
// duplicate (freq, label) pairs are collapsed.
func attachRadios(out map[string]*aixmAirport, s aixmStreams, icaoByCodeId map[string]string) {
	fqyBySer := make(map[int64][]Fqy)
	for i := range s.fqys {
		f := &s.fqys[i]
		fqyBySer[f.Uid.Ser.Mid] = append(fqyBySer[f.Uid.Ser.Mid], *f)
	}
	seen := make(map[string]bool) // icao|freq|label
	for i := range s.sahs {
		sah := &s.sahs[i]
		icao := icaoByCodeId[strings.TrimSpace(sah.Uid.AhpCodeId)]
		if icao == "" {
			continue
		}
		ap := out[icao]
		if ap == nil {
			continue
		}
		label, ok := frServiceLabel[strings.ToUpper(strings.TrimSpace(sah.Uid.Ser.CodeType))]
		if !ok {
			continue
		}
		for _, fqy := range fqyBySer[sah.Uid.Ser.Mid] {
			freq := strings.TrimSpace(fqy.Uid.ValFreqTrans)
			// Drop blank / placeholder "0" frequencies (SIA emits a 0 MHz
			// stub for some services with no real channel).
			if v, err := strconv.ParseFloat(freq, 64); err != nil || v <= 0 {
				continue
			}
			call := tidyCallSign(callSign(fqy))
			svc := refineFrLabel(label, call)
			key := icao + "|" + freq + "|" + svc
			if seen[key] {
				continue
			}
			seen[key] = true
			ap.Radio = append(ap.Radio, []any{freq, svc, call})
		}
	}
}

// indexAhps builds the per-aerodrome records from the Ahp headers plus the
// codeId -> ident map that links the runway and usage streams (codeId is
// the internal linker; for ICAO'd Ahps it equals codeIcao). Ahps with
// unparseable coordinates are skipped.
//
// An ICAO location indicator is an AFTN addressing artefact, not a statement
// that the aerodrome exists: the SIA leaves 295 of its 877 Ahps without one,
// among them 252 of the 275 heliports (every hospital helipad but the handful
// the SIA happened to code, so LFWH Strasbourg-Hautepierre is published and
// LF075 Créteil Henri-Mondor is not). Those keep the SIA's own codeId as their
// ident, the way cmd/de carries the DFS national codes (ED0004) through the
// AIXM 5.1 designator. codeId is unique across the export and never equals an
// ICAO the export itself emits.
//
// It is NOT unique against the OurAirports baseline, whose French rows are
// keyed by local code in the same LFnn shape: the SIA's LF51 is VITRY EN ARTOIS
// (CLOSED) while OurAirports' LF51 is Orange Plan-de-Dieu, which the SIA itself
// publishes as LFPR. The two registries only look alike, so mergeAixmOverlay
// matches an exact ident against the baseline for ICAO-shaped idents only.
func indexAhps(s aixmStreams) (out map[string]*aixmAirport, icaoByCodeId map[string]string) {
	out = make(map[string]*aixmAirport)
	icaoByCodeId = make(map[string]string)
	for i := range s.ahps {
		a := &s.ahps[i]
		icao := strings.TrimSpace(a.CodeIcao)
		national := icao == ""
		if national {
			icao = strings.TrimSpace(a.Uid.CodeId)
		}
		if icao == "" {
			continue
		}
		// SIA marks fictive AFS-addressing pseudo-aerodromes (the FIR/ACC
		// centres and similar) with this txtDescrRefPt and a placeholder
		// coordinate in the Atlantic. They are not real aerodromes; skip them
		// so they don't pollute the airport dataset (and so en-route NOTAMs
		// filed under a FIR code aren't taken for aerodrome NOTAMs).
		if strings.Contains(strings.ToLower(a.TxtDescrRefPt), "fictive airport only used for afs") {
			continue
		}
		lat, latOk := aip.ParseLat(a.GeoLat)
		lon, lonOk := aip.ParseLon(a.GeoLong)
		if !latOk || !lonOk {
			continue
		}
		var elev *int
		if v, err := strconv.Atoi(strings.TrimSpace(a.ValElev)); err == nil {
			elev = &v
		}
		var transitionAlt *int
		if n, ok := taFeet(a.ValTransitionAlt, a.UomTransitionAlt); ok {
			transitionAlt = &n
		}
		icaoByCodeId[a.Uid.CodeId] = icao
		out[icao] = &aixmAirport{
			Ident:           icao,
			Name:            strings.TrimSpace(a.TxtName),
			CodeType:        strings.TrimSpace(a.CodeType),
			Lat:             aip.Round5(lat),
			Lon:             aip.Round5(lon),
			ElevFt:          elev,
			TransitionAltFt: transitionAlt,
			IsoCountry:      countryFromIcao(icao),
			City:            strings.TrimSpace(a.TxtNameCitySer),
			Iata:            strings.TrimSpace(a.CodeIata),
			NationalCode:    national,
		}
	}
	return out, icaoByCodeId
}

// indexRddsRls indexes the declared-distance (Rdd) and lighting (Rls)
// streams so attachRunways can resolve each runway's per-direction
// distances and lit flag in O(1).
func indexRddsRls(s aixmStreams, icaoByCodeId map[string]string) (rddByKey map[rddKey]map[string]float64, litByRwy map[rwyKey]bool) {
	rddByKey = make(map[rddKey]map[string]float64) // codeType (TORA/LDA) -> metres
	for i := range s.rdds {
		d := &s.rdds[i]
		icao := icaoByCodeId[d.Uid.RdnUid.RwyUid.AhpUid.CodeId]
		if icao == "" {
			continue
		}
		val, err := strconv.ParseFloat(strings.TrimSpace(d.ValDist), 64)
		if err != nil || val <= 0 {
			continue
		}
		m := lengthToMeters(val, d.UomDist)
		if m <= 0 {
			continue
		}
		key := rddKey{icao: icao, rwy: d.Uid.RdnUid.RwyUid.TxtDesig, rdn: d.Uid.RdnUid.TxtDesig}
		if rddByKey[key] == nil {
			rddByKey[key] = make(map[string]float64)
		}
		rddByKey[key][strings.ToUpper(strings.TrimSpace(d.Uid.CodeType))] = m
	}

	litByRwy = make(map[rwyKey]bool)
	for i := range s.rlss {
		r := &s.rlss[i]
		icao := icaoByCodeId[r.Uid.RdnUid.RwyUid.AhpUid.CodeId]
		if icao == "" {
			continue
		}
		litByRwy[rwyKey{icao: icao, rwy: r.Uid.RdnUid.RwyUid.TxtDesig}] = true
	}
	return rddByKey, litByRwy
}

// lightingIndex holds the AD 2.14 lighting streams keyed per runway direction
// (rddKey), so attachRunways can resolve each QFU's lighting in O(1).
type lightingIndex struct {
	lines map[rddKey][]lightLine
	papi  map[rddKey]*vasisLight
	als   map[rddKey]*approachLight
}

// indexLighting builds the per-direction lighting index from the Rls (light
// lines), Rda (approach lighting) and Rdn (VASIS/PAPI) streams.
func indexLighting(s aixmStreams, icaoByCodeId map[string]string) lightingIndex {
	idx := lightingIndex{
		lines: make(map[rddKey][]lightLine),
		papi:  make(map[rddKey]*vasisLight),
		als:   make(map[rddKey]*approachLight),
	}
	for i := range s.rlss {
		r := &s.rlss[i]
		icao := icaoByCodeId[r.Uid.RdnUid.RwyUid.AhpUid.CodeId]
		if icao == "" {
			continue
		}
		psn := strings.ToUpper(strings.TrimSpace(r.Uid.CodePsn))
		colour := strings.ToUpper(strings.TrimSpace(r.CodeColour))
		if psn == "" && colour == "" {
			continue // a bare Rls only sets the lit flag, already handled
		}
		key := rddKey{icao: icao, rwy: r.Uid.RdnUid.RwyUid.TxtDesig, rdn: r.Uid.RdnUid.TxtDesig}
		idx.lines[key] = append(idx.lines[key], lightLine{
			Psn:    psn,
			Colour: colour,
			Intst:  strings.ToUpper(strings.TrimSpace(r.CodeIntst)),
		})
	}
	for i := range s.rdas {
		d := &s.rdas[i]
		icao := icaoByCodeId[d.Uid.RdnUid.RwyUid.AhpUid.CodeId]
		if icao == "" {
			continue
		}
		key := rddKey{icao: icao, rwy: d.Uid.RdnUid.RwyUid.TxtDesig, rdn: d.Uid.RdnUid.TxtDesig}
		if _, dup := idx.als[key]; dup {
			continue // first approach-light system per direction wins
		}
		var lenM *int
		if v, err := strconv.ParseFloat(strings.TrimSpace(d.ValLen), 64); err == nil && v > 0 {
			if m := int(math.Round(lengthToMeters(v, d.UomLen))); m > 0 {
				lenM = &m
			}
		}
		idx.als[key] = &approachLight{Type: strings.ToUpper(strings.TrimSpace(d.Uid.CodeType)), LenM: lenM}
	}
	for i := range s.rdns {
		d := &s.rdns[i]
		vt := strings.ToUpper(strings.TrimSpace(d.CodeTypeVasis))
		if vt == "" {
			continue
		}
		icao := icaoByCodeId[d.Uid.RwyUid.AhpUid.CodeId]
		if icao == "" {
			continue
		}
		key := rddKey{icao: icao, rwy: d.Uid.RwyUid.TxtDesig, rdn: d.Uid.TxtDesig}
		if _, dup := idx.papi[key]; dup {
			continue
		}
		idx.papi[key] = &vasisLight{Type: vt, Side: strings.ToUpper(strings.TrimSpace(d.CodePsnVasis))}
	}
	return idx
}

// forDir assembles one runway direction's lighting, or nil when it has none.
func (idx lightingIndex) forDir(key rddKey) *dirLighting {
	lines, papi, als := idx.lines[key], idx.papi[key], idx.als[key]
	if len(lines) == 0 && papi == nil && als == nil {
		return nil
	}
	return &dirLighting{Lines: lines, Papi: papi, Als: als}
}

// indexRcp groups the runway centreline points by strip.
func indexRcp(s aixmStreams, icaoByCodeId map[string]string) map[rwyKey][][2]float64 {
	out := map[rwyKey][][2]float64{}
	for i := range s.rcps {
		r := &s.rcps[i]
		icao := icaoByCodeId[r.Uid.RwyUid.AhpUid.CodeId]
		if icao == "" {
			continue
		}
		lat, ok1 := aip.ParseLat(r.Uid.GeoLat)
		lon, ok2 := aip.ParseLon(r.Uid.GeoLong)
		if !ok1 || !ok2 {
			continue
		}
		k := rwyKey{icao: icao, rwy: r.Uid.RwyUid.TxtDesig}
		out[k] = append(out[k], [2]float64{aip.Round5(lat), aip.Round5(lon)})
	}
	return out
}

// runwayEnds picks the strip's two physical ends out of its centreline
// points and says which designator each belongs to.
//
// The AIXM files several points per strip, all on the axis (LFPL 08R/26L
// has four: the two thresholds and two displaced ones), and none of them
// says which end it is. The two furthest apart ARE the ends, and the
// designator settles the order: "08" means the runway runs on about 080,
// so the end the axis points away from is the 08 threshold. The designator
// is magnetic and the coordinates true, but French variation is a degree
// or two and the test is a half-turn, so nothing rides on that.
func runwayEnds(pts [][2]float64, le string) (lePos, hePos *[2]float64) {
	if len(pts) < 2 {
		return nil, nil
	}
	bi, bj, best := 0, 1, -1.0
	for i := 0; i < len(pts); i++ {
		for j := i + 1; j < len(pts); j++ {
			d := math.Hypot(pts[j][0]-pts[i][0],
				(pts[j][1]-pts[i][1])*math.Cos(pts[i][0]*math.Pi/180))
			if d > best {
				bi, bj, best = i, j, d
			}
		}
	}
	a, b := pts[bi], pts[bj]
	deg := leadingDigits(le)
	if deg < 0 {
		return nil, nil
	}
	want := float64(deg) * 10
	dy := b[0] - a[0]
	dx := (b[1] - a[1]) * math.Cos(a[0]*math.Pi/180)
	brg := math.Mod(math.Atan2(dx, dy)*180/math.Pi+360, 360)
	if diff := math.Abs(math.Mod(brg-want+540, 360) - 180); diff > 90 {
		a, b = b, a
	}
	return &a, &b
}

// leadingDigits reads the two-digit number a runway designator opens with
// ("08R" -> 8), or -1.
func leadingDigits(s string) int {
	n, i := 0, 0
	for ; i < len(s) && s[i] >= '0' && s[i] <= '9'; i++ {
		n = n*10 + int(s[i]-'0')
	}
	if i == 0 || n < 1 || n > 36 {
		return -1
	}
	return n
}

// attachRunways links each Rwy strip to its aerodrome, folding in the
// indexed per-direction declared distances, lit flag, lighting and the
// centreline points that give each end its position.
func attachRunways(out map[string]*aixmAirport, s aixmStreams, icaoByCodeId map[string]string, rddByKey map[rddKey]map[string]float64, litByRwy map[rwyKey]bool, lights lightingIndex) {
	rcpByRwy := indexRcp(s, icaoByCodeId)
	for i := range s.rwys {
		r := &s.rwys[i]
		icao := icaoByCodeId[r.Uid.AhpUid.CodeId]
		if icao == "" {
			continue
		}
		ap := out[icao]
		if ap == nil {
			continue
		}
		le, he := splitRunwayDesig(r.Uid.TxtDesig)
		var lengthFt, widthFt *int
		if v, err := strconv.ParseFloat(strings.TrimSpace(r.ValLen), 64); err == nil && v > 0 {
			n := int(math.Round(lengthToFeet(v, r.UomDimRwy)))
			lengthFt = &n
		}
		if v, err := strconv.ParseFloat(strings.TrimSpace(r.ValWid), 64); err == nil && v > 0 {
			n := int(math.Round(lengthToFeet(v, r.UomDimRwy)))
			widthFt = &n
		}
		lit := 0
		if litByRwy[rwyKey{icao: icao, rwy: r.Uid.TxtDesig}] {
			lit = 1
		}
		leKey := rddKey{icao: icao, rwy: r.Uid.TxtDesig, rdn: le}
		heKey := rddKey{icao: icao, rwy: r.Uid.TxtDesig, rdn: he}
		lePos, hePos := runwayEnds(rcpByRwy[rwyKey{icao: icao, rwy: r.Uid.TxtDesig}], le)
		ap.Runways = append(ap.Runways, aixmRunway{
			Le:         le,
			He:         he,
			LengthFt:   lengthFt,
			WidthFt:    widthFt,
			Surface:    strings.TrimSpace(r.CodeComposition),
			Lit:        lit,
			LeLdaFt:    metersToFeetPtr(rddByKey[leKey]["LDA"]),
			LeToraFt:   metersToFeetPtr(rddByKey[leKey]["TORA"]),
			LeTodaFt:   metersToFeetPtr(rddByKey[leKey]["TODA"]),
			LeAsdaFt:   metersToFeetPtr(rddByKey[leKey]["ASDA"]),
			HeLdaFt:    metersToFeetPtr(rddByKey[heKey]["LDA"]),
			HeToraFt:   metersToFeetPtr(rddByKey[heKey]["TORA"]),
			HeTodaFt:   metersToFeetPtr(rddByKey[heKey]["TODA"]),
			HeAsdaFt:   metersToFeetPtr(rddByKey[heKey]["ASDA"]),
			LeLighting: lights.forDir(leKey),
			HeLighting: lights.forDir(heKey),
			LePos:      lePos,
			HePos:      hePos,
		})
	}
}

// applyUsage resolves access, military and VFR/IFR from the Ahu
// UsageLimitation / UsageCondition / FlightClass tree.
//
// The CAP vs "usage restreint" signal is the codeUsageLimitation carried on
// the GAT (General Air Traffic = civilian) UsageLimitation:
//
//   - a GAT block with codeUsageLimitation=PERMIT -> ouvert à la CAP ("cap")
//   - GAT present but only OTHER                   -> usage restreint ("restricted")
//   - no GAT block at all (OAT / state only)       -> military / state ("restricted")
//
// codePurpose (P/S/NS/T/OTHER) is a flight CATEGORY ("private flights / GA
// welcome"), not an access restriction, so it is ignored: ~490 ordinary
// civilian fields carry GAT/P. Military is set independently from any
// codeStatus=STATE, and airportStatus() puts military first, so a base keeps
// its red symbol while only civil usage-restreint fields fall through to grey.
//
// This deliberately diverges from internal/aixm5.digestAvailability (UK/ES):
// AIXM 4.5 codeUsageLimitation has no PRIVATE token, so SIA overloads OTHER
// for "usage restreint"; AIXM 5.1 has dedicated PRIVATE / MILITARY tokens and
// reserves OTHER for benign cases (so OTHER maps to cap there).
func applyUsage(out map[string]*aixmAirport, s aixmStreams, icaoByCodeId map[string]string) {
	for i := range s.ahus {
		u := &s.ahus[i]
		ap := out[icaoByCodeId[u.Uid.AhpUid.CodeId]]
		if ap == nil {
			continue
		}
		var permitGat bool
		for _, lim := range u.Limits {
			permit := strings.EqualFold(strings.TrimSpace(lim.CodeUsage), "PERMIT")
			for _, c := range lim.Conditions {
				fc := &c.FlightClass
				codeType := strings.ToUpper(strings.TrimSpace(fc.CodeType))
				codeRule := strings.ToUpper(strings.TrimSpace(fc.CodeRule))
				if strings.EqualFold(fc.CodeStatus, "STATE") {
					ap.Military = true
				}
				if codeType == "GAT" {
					if permit {
						permitGat = true
					}
					if strings.Contains(codeRule, "V") {
						ap.Vfr = true
					}
					if strings.Contains(codeRule, "I") {
						ap.Ifr = true
					}
				}
			}
		}
		if permitGat {
			ap.Access = "cap"
		} else {
			ap.Access = "restricted"
		}
	}
}

// buildRowFromAixm constructs a full row for an AIXM aerodrome. The type
// enum is derived from codeType + the longest runway. Row layout matches
// airportsOutputFields.
func buildRowFromAixm(ax *aixmAirport) []any {
	var elev any
	if ax.ElevFt != nil {
		elev = *ax.ElevFt
	}
	var access any
	if ax.Access != "" {
		access = ax.Access
	}
	return []any{
		ax.Ident,
		deriveAixmType(ax.CodeType, ax.Runways),
		ax.Name,
		ax.Lat,
		ax.Lon,
		elev,
		ax.IsoCountry,
		ax.City,
		ax.Iata,
		runwayRowsFromAixm(ax.Runways),
		access,
		ax.Military,
		ax.Vfr,
		ax.Ifr,
		ax.Military && ax.Access == "cap",
		radioRows(ax.Radio),
		intOrNil(ax.TransitionAltFt),
	}
}

// radioRows returns the curated frequency triples, never nil so the JSON
// column is always a (possibly empty) array.
func radioRows(radio []any) []any {
	if radio == nil {
		return []any{}
	}
	return radio
}

// tidyCallSign drops the SIA "NAME - ." placeholder suffix that marks a service
// with no specific sub-position, so the panel shows "GRENOBLE" not
// "GRENOBLE - .". A real sub-position ("GRENOBLE - TOUR") is left intact.
func tidyCallSign(call string) string {
	call = strings.TrimSpace(call)
	if i := strings.LastIndex(call, " - "); i >= 0 && strings.TrimSpace(call[i+3:]) == "." {
		return strings.TrimSpace(call[:i])
	}
	return call
}

// refineFrLabel sharpens a TWR-coded service to GND / DEL using the SIA call
// sign suffix: SIA publishes ground ("SOL") and clearance-delivery ("PREVOL")
// positions under codeType TWR, distinguishing them only by call sign (e.g.
// "LOGNES - SOL" is ground, not tower). Other suffixes (TOUR, TRAFIC, ...) and
// non-TWR services are returned unchanged.
func refineFrLabel(label, call string) string {
	if label != "TWR" {
		return label
	}
	switch frCallSuffix(call) {
	case "SOL":
		return "GND"
	case "PREVOL", "PRÉVOL":
		return "DEL"
	}
	return label
}

// frCallSuffix returns the upper-cased first word of a call sign's sub-position
// (the part after " - ", e.g. "LOGNES - SOL" -> "SOL", "DE GAULLE - SOL NORD"
// -> "SOL"). A call sign with no " - " separator is a bare field name with no
// sub-position, so it returns "".
func frCallSuffix(call string) string {
	call = strings.ToUpper(call)
	i := strings.LastIndex(call, " - ")
	if i < 0 {
		return ""
	}
	fields := strings.Fields(call[i+3:])
	if len(fields) == 0 {
		return ""
	}
	return fields[0]
}

// lightingToAny serialises one runway direction's AD 2.14 lighting to the
// compact JSON object emitted per runway end, or nil when the direction is
// unlit:  { "lines": [[psn, colour, intst], ...], "papi": [type, side],
// "als": [type, lenM] }  (papi / als omitted when absent).
func lightingToAny(l *dirLighting) any {
	if l == nil {
		return nil
	}
	lines := make([]any, 0, len(l.Lines))
	for _, ln := range l.Lines {
		lines = append(lines, []string{ln.Psn, ln.Colour, ln.Intst})
	}
	out := map[string]any{"lines": lines}
	if l.Papi != nil {
		out["papi"] = []string{l.Papi.Type, l.Papi.Side}
	}
	if l.Als != nil {
		out["als"] = []any{l.Als.Type, intOrNil(l.Als.LenM)}
	}
	return out
}

func runwayRowsFromAixm(rws []aixmRunway) []any {
	out := make([]any, 0, len(rws))
	for _, r := range rws {
		out = append(out, []any{
			r.Le, r.He,
			intOrNil(r.LengthFt),
			intOrNil(r.WidthFt),
			r.Surface,
			r.Lit,
			intOrNil(r.LeLdaFt),
			intOrNil(r.LeToraFt),
			intOrNil(r.LeTodaFt),
			intOrNil(r.LeAsdaFt),
			intOrNil(r.HeLdaFt),
			intOrNil(r.HeToraFt),
			intOrNil(r.HeTodaFt),
			intOrNil(r.HeAsdaFt),
			lightingToAny(r.LeLighting),
			lightingToAny(r.HeLighting),
			posOrNil(r.LePos),
			posOrNil(r.HePos),
		})
	}
	return out
}

// posOrNil emits a runway end as [lat, lon], or null where the AIXM files
// no centreline point for the strip.
func posOrNil(p *[2]float64) any {
	if p == nil {
		return nil
	}
	return []float64{p[0], p[1]}
}

func intOrNil(p *int) any {
	if p == nil {
		return nil
	}
	return *p
}

// deriveAixmType maps AIXM codeType + the longest runway to one of the
// OurAirports type values, so consumers like hasLikelyVac() keep working
// for AIXM-derived French aerodromes.
func deriveAixmType(codeType string, rws []aixmRunway) string {
	switch strings.ToUpper(strings.TrimSpace(codeType)) {
	case "HP":
		return "heliport"
	case "LS":
		// The SIA files decommissioned fields under LS, and only those: all
		// 29 rows of the 2026-08-06 export are named "... (CLOSED)" and no
		// ICAO'd row carries that marker. They are the legend's "AD
		// désaffecté" (circled X), a landmark rather than an aerodrome.
		return "closed"
	}
	longestFt := 0
	for _, r := range rws {
		if r.LengthFt != nil {
			longestFt = max(longestFt, *r.LengthFt)
		}
	}
	switch {
	case longestFt >= 8000: // >= 2438 m
		return "large_airport"
	case longestFt >= 4000: // >= 1219 m
		return "medium_airport"
	default:
		return "small_airport"
	}
}

// splitRunwayDesig splits "09L/27R" into ("09L", "27R"). A single-direction
// designator returns (s, "").
func splitRunwayDesig(s string) (string, string) {
	s = strings.TrimSpace(s)
	if i := strings.Index(s, "/"); i >= 0 {
		return strings.TrimSpace(s[:i]), strings.TrimSpace(s[i+1:])
	}
	return s, ""
}

// lengthToMeters converts an AIXM length value to metres. uom: M / FT.
func lengthToMeters(val float64, uom string) float64 {
	switch strings.ToUpper(strings.TrimSpace(uom)) {
	case "M", "":
		return val
	case "FT":
		return val * 0.3048
	default:
		return 0
	}
}

// taFeet converts an Ahp valTransitionAlt / uomTransitionAlt pair to whole
// feet. ok=false for missing, non-positive (SIA stubs a 0 on the fictive
// NTTT AFS row) or unknown-unit values; unlike lengthToFeet, a missing uom
// is NOT defaulted to metres (SIA always publishes FT here, so an absent
// unit means an absent value).
func taFeet(val, uom string) (int, bool) {
	v, err := strconv.ParseFloat(strings.TrimSpace(val), 64)
	if err != nil || v <= 0 {
		return 0, false
	}
	switch strings.ToUpper(strings.TrimSpace(uom)) {
	case "FT":
		return int(math.Round(v)), true
	case "M":
		return int(math.Round(v / 0.3048)), true
	default:
		return 0, false
	}
}

// lengthToFeet converts an AIXM length value to feet. uom: M / FT.
func lengthToFeet(val float64, uom string) float64 {
	switch strings.ToUpper(strings.TrimSpace(uom)) {
	case "M", "":
		return val / 0.3048
	case "FT":
		return val
	default:
		return 0
	}
}

// metersToFeetPtr returns nil for zero (sentinel "no value") and a rounded
// int pointer otherwise. Used for declared-distance outputs.
func metersToFeetPtr(m float64) *int {
	if m <= 0 {
		return nil
	}
	n := int(math.Round(m / 0.3048))
	return &n
}

// countryFromIcao is a small best-effort ISO-3166 map; the SPA's merge
// logic prefers OurAirports' iso_country when present and falls back to
// this. The mapping covers French metropolitan + overseas-territory
// prefixes.
func countryFromIcao(icao string) string {
	if len(icao) < 2 {
		return ""
	}
	switch strings.ToUpper(icao[:2]) {
	case "LF":
		return "FR"
	case "FM":
		return "RE" // Réunion
	case "NT":
		return "PF" // French Polynesia
	case "NW":
		return "NC" // New Caledonia
	case "NL":
		return "WF" // Wallis & Futuna
	case "SO":
		return "GF" // French Guiana
	case "TF":
		return "GP" // Guadeloupe (best-effort default for Antilles)
	default:
		return "FR"
	}
}
