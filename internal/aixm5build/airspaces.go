// airspaces.go translates aixm5 decoded airspaces into the row schema
// the SPA expects (mirrors cmd/fr/airspaces.go). workHr, rmk and radio
// come from the decoder (activation timesheets, REMARK notes, Service
// links); max, mnm and rmkWorkHr stay at their "absent" values, AIXM
// 5.1 having no equivalent of those France-specific columns.

package aixm5build

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/aixm5"
	"github.com/0intro/loxodrome/internal/firarcs"
)

const (
	defaultMinAirspaces = 200
	defaultMaxAirspaces = 6000
)

// airspacesOutputFields mirrors cmd/fr/airspaces.go's row layout so the
// SPA can read <cc>-airspaces.json with the same rowToAirspace decoder
// it uses for fr-airspaces.json.
var airspacesOutputFields = []string{
	"id", "type", "name", "class",
	"upper", "lower", "max", "mnm",
	"workHr", "rmkWorkHr", "rmk",
	"radio", "ring", "subtype", "arcs",
}

// AirspacesMeta is the <cc>-airspaces.meta.json document.
type AirspacesMeta struct {
	GeneratedAt   string `json:"generatedAt"`
	Source        string `json:"source"`
	SourceSha256  string `json:"sourceSha256"`
	Effective     string `json:"effective"`
	AirspaceCount int    `json:"airspaceCount"`
	// SkippedNoBoundary counts volumes whose stated boundary decoded to no
	// ring: geometry lost, the figure to watch (the arc centres read as a
	// bare pos were 334 German volumes here). SkippedNoProjection counts
	// the volumes stating none of their own, their extent other airspaces'
	// (the DFS's contributor volumes, several hundred every cycle), which
	// once shared this count and hid a loss.
	SkippedNoBoundary   int `json:"skippedNoBoundary"`
	SkippedNoProjection int `json:"skippedNoProjection"`
	SkippedNoType       int `json:"skippedNoType"`
	// SkippedCoveredParts counts the TMA parts a drawn whole covers
	// (coveredByWhole); absent when none was.
	SkippedCoveredParts int `json:"skippedCoveredParts,omitempty"`
	SkippedNonBaseline  int `json:"skippedNonBaseline"`
	UnresolvedXlinks    int `json:"unresolvedXlinks"`
	// UnresolvedGeometryXlinks is the geometry's own share of
	// UnresolvedXlinks (aixm5.Message), the airspaces' signal.
	UnresolvedGeometryXlinks int `json:"unresolvedGeometryXlinks"`
	// MultiComponentAirspaces surfaces the decoder's counter of
	// airspaces published with several geometry components (one row
	// emitted per component).
	MultiComponentAirspaces int `json:"multiComponentAirspaces"`
	// SkippedRadioChannels surfaces the decoder's count of radio channels
	// dropped for a unit other than MHz; absent when none was.
	SkippedRadioChannels int `json:"skippedRadioChannels,omitempty"`
	// LimitRefsFromLayers counts the limits whose datum came from a class
	// layer because the volume stated none (aixm5.layerReference), and
	// LimitsWithoutRef the emitted limits still carrying no datum, a value
	// rendered bare and compared as AMSL; both absent when zero. ENAIRE's
	// exports from 2026-10-01 are why: watch the second fall when it states
	// the references again.
	LimitRefsFromLayers int            `json:"limitRefsFromLayers,omitempty"`
	LimitsWithoutRef    int            `json:"limitsWithoutRef,omitempty"`
	Counts              map[string]int `json:"counts"`
	// BBox is the emitted rows' lat/lon envelope, which the SPA uses to
	// skip fetching a country the current view cannot reach (bbox.go).
	BBox aip.BBox `json:"bbox,omitempty"`
	// BBoxes splits that envelope into the pieces the rows really
	// occupy, for a publisher whose territory is not connected; absent
	// when the rows form one group.
	BBoxes []aip.BBox `json:"bboxes,omitempty"`
}

// AirspacesOptions configures BuildAirspaces. Country labels the
// sanity-window error ("UK" / "ES").
type AirspacesOptions struct {
	Country      string
	Now          func() time.Time
	MinAirspaces int
	MaxAirspaces int
}

// BuildAirspaces walks the decoded AIXM 5.1 message and emits the
// per-airspace row plus aggregate meta. Source-side counters
// (SkippedNonBaseline, UnresolvedXlinks) surface as meta fields so
// upstream drift is visible to the operator.
func BuildAirspaces(msg *aixm5.Message, source string, raw []byte, effective string, opts AirspacesOptions) (Artifact, AirspacesMeta, error) {
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	minA, maxA := opts.MinAirspaces, opts.MaxAirspaces
	if minA == 0 {
		minA = defaultMinAirspaces
	}
	if maxA == 0 {
		maxA = defaultMaxAirspaces
	}

	rows := make([]any, 0, len(msg.Airspaces))
	counts := make(map[string]int)
	var skippedNoBoundary, skippedNoProjection, skippedNoType, skippedCoveredParts, limitsWithoutRef int
	// A TMA filed in parts (TMA_P) draws its parts where no drawn whole
	// covers them: Georgia files its three TMAs as aggregates with no
	// boundary of their own. ENAIRE files each of its 16 whole, with one,
	// and again in its 151 parts tiling it; both drawn, every stretch of a
	// TMA doubled on the map and in the alerts. So a part a whole covers
	// goes, as every part did before TMA_P was read.
	var tmaWholes [][][2]float64
	for i := range msg.Airspaces {
		if a := &msg.Airspaces[i]; strings.EqualFold(strings.TrimSpace(a.Type), "TMA") && len(a.Ring) >= 3 {
			tmaWholes = append(tmaWholes, a.Ring)
		}
	}
	for i := range msg.Airspaces {
		a := &msg.Airspaces[i]
		emitType := mapAirspaceType(a.Type, a.LocalType)
		if emitType == "" {
			skippedNoType++
			continue
		}
		if len(a.Ring) == 0 {
			if a.NoProjection {
				skippedNoProjection++
			} else {
				skippedNoBoundary++
			}
			continue
		}
		if strings.EqualFold(strings.TrimSpace(a.Type), "TMA_P") && coveredByWhole(a.Ring, tmaWholes) {
			skippedCoveredParts++
			continue
		}
		counts[emitType]++
		row := airspaceRow(a, emitType)
		for _, i := range []int{4, 5} {
			if t, ok := row[i].([]string); ok && t[0] == "" && t[1] != "" {
				limitsWithoutRef++
			}
		}
		rows = append(rows, row)
	}
	// Same-state same-type FIR siblings get their foreign-facing arcs
	// (NATS EGTT001/EGPX001, ENAIRE LECM/LECB FIR + UIR twins; DFS
	// ships no FIR-family rows, so a no-op for Germany).
	firarcs.Apply(rows)

	if n := len(rows); n < minA || n > maxA {
		return Artifact{}, AirspacesMeta{}, fmt.Errorf(
			"%s airspace count %d outside sanity window [%d, %d] - source format may have changed",
			opts.Country, n, minA, maxA)
	}

	sum := sha256.Sum256(raw)
	meta := AirspacesMeta{
		GeneratedAt:              now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Source:                   source,
		SourceSha256:             hex.EncodeToString(sum[:]),
		Effective:                effective,
		AirspaceCount:            len(rows),
		SkippedNoBoundary:        skippedNoBoundary,
		SkippedNoProjection:      skippedNoProjection,
		SkippedCoveredParts:      skippedCoveredParts,
		SkippedNoType:            skippedNoType,
		SkippedNonBaseline:       msg.SkippedNonBaseline,
		UnresolvedXlinks:         msg.UnresolvedXlinks,
		UnresolvedGeometryXlinks: msg.UnresolvedGeometryXlinks,
		MultiComponentAirspaces:  msg.MultiComponentAirspaces,
		SkippedRadioChannels:     msg.SkippedRadioChannels,
		LimitRefsFromLayers:      msg.LimitRefsFromLayers,
		LimitsWithoutRef:         limitsWithoutRef,
		Counts:                   counts,
	}
	meta.BBox = aip.BBoxOfRows(airspacesOutputFields, rows)
	meta.BBoxes = aip.BBoxClustersOfRows(airspacesOutputFields, rows)
	return Artifact{Fields: airspacesOutputFields, Rows: rows}, meta, nil
}

// airspaceRow builds one positional row matching airspacesOutputFields.
// Columns the AIXM 5.1 pipeline populates: id, type, name, class,
// upper, lower, workHr, rmk, radio, ring, subtype. Only max, mnm and
// rmkWorkHr are left at their "absent" values (France-specific columns
// with no AIXM 5.1 counterpart).
func airspaceRow(a *aixm5.Airspace, emitType string) []any {
	// Designator is the canonical ID for NATS / ENAIRE (codeId
	// equivalent). Fall back to the raw gml:id when no designator is
	// published.
	id := a.Designator
	if id == "" {
		id = a.ID
	}
	return []any{
		id,
		emitType,
		a.Name,
		a.ClassCode,
		verticalTriple(a.UpperLimit),
		verticalTriple(a.LowerLimit),
		nil, // max: AIXM 5.1 doesn't carry the France-specific maximum
		nil, // mnm: same
		a.WorkHr,
		"", // rmkWorkHr: France's separate field; AIXM 5.1 collapses with rmk
		a.Rmk,
		radioTriples(a.Radio),
		a.Ring,
		a.Type, // subtype: AIXM type verbatim
		nil,    // arcs: patched by firarcs.Apply where siblings exist
	}
}

// radioTriples translates aixm5.RadioChannel slices into the
// [freq, unit, callsign] triples France's airspaces.json row uses.
func radioTriples(rs []aixm5.RadioChannel) []any {
	out := make([]any, 0, len(rs))
	for _, r := range rs {
		out = append(out, []string{r.Freq, r.Unit, r.CallSign})
	}
	return out
}

// mapAirspaceType translates the AIXM 5.1 codeAirspaceType vocabulary
// into the SPA's type taxonomy (matches cmd/fr/airspaces.go's
// classifyAse outcomes). Empty result means "drop the row"; AIXM has
// many types the overlay doesn't render (SECTOR, AWY, RCA, ...).
//
// localType is the aixm:localType refinement DFS Germany uses to carry
// the real kind under a generic type: RAS ("regulated airspace") with
// localType RMZ / TMZ / ATZ / DLG-ATS / a FIS sector / a danger sub-
// zone; A ("activity") with a parachute / glider / drone localType.
// NATS and ENAIRE leave localType empty, so their standard types fall
// straight through the first switch and their behaviour is unchanged.
func mapAirspaceType(t, localType string) string {
	norm := strings.ToUpper(strings.TrimSpace(t))
	lt := strings.ToUpper(strings.TrimSpace(localType))
	switch norm {
	// Hard pass-through: the SPA's category dictionary and the SIA
	// symbology resolver (airspaceSymbology.ts) recognise these
	// natively: ATZ draws the blue round-dot ring, MOA / W / A the
	// restricted hatch family, so the old folds (ATZ -> CTR,
	// MOA / W -> R, A -> ACTIVITY) would only lose the designator.
	// TSA rides beside TRA, and ACTIVITY is cmd/be's emit for the
	// Belgian ENR 5.5 sporting areas (the SPA's activity family).
	// SIV / DLG-ATS ride here too so a publisher that types them
	// directly (DFS uses them as localType, below) is covered.
	// CBA is AIXM's cross-border area (cmd/be emits it for the Belgian
	// CBA1 volumes and the republished LFCBA16B); the Legende2026 chart
	// files it with the R/D hatch family.
	// PARACHUTE / GLIDER / PARAGLIDER are cmd/at's emit for the Austrian
	// Luftsportgebiete; they ride the SPA's activity family, whose glyph
	// resolver keys the parachute / glider / paraglider pictograms off
	// exactly these tokens (cmd/fr emits them too).
	case "FIR", "UIR", "OCA", "TMA", "CTA", "CTR", "ATZ", "UTA",
		"D", "R", "P", "TRA", "TSA", "CBA", "MOA", "W", "A", "ACTIVITY",
		"TMZ", "RMZ", "SIV", "DLG-ATS",
		"PARACHUTE", "GLIDER", "PARAGLIDER",
		// cmd/fr's activity kinds, listed so a future AIXM 5.1 publisher can
		// emit them rather than folding back into the generic bucket.
		"MODEL", "AEROBATIC", "UAS":
		return norm
	case "UIR-P":
		return "UIR"
	// The Nordic traffic information zones and areas (LFV's TIZ / TIA) are
	// radio mandatory zones by the AIP's own designation ("LYCKSELE
	// TIZ/RMZ"): class G around an AFIS aerodrome, entered with a call. They
	// draw and alert as the RMZ family; the subtype column keeps the
	// State's word for the panel. So does a flight information zone, the
	// same thing under another name (Fintraffic's "EFET FIZ LOWER", "RMZ
	// H24"; EANS's and ALBCONTROL's "FIZ/RMZ"), which the eAIP readers
	// type from an aerodrome's AD 2.17.
	case "TIZ", "TIA", "FIZ", "OTHER:FIZ":
		// Sakaeronavigatsia types its three class G FIZs OTHER:FIZ.
		return "RMZ"

	// Austro Control vocabulary: the Austrian military volumes are
	// published as their own kinds. Each draws as the charted civil
	// equivalent, while the subtype column keeps the military kind for
	// the detail panel.
	case "MTMA":
		return "TMA"
	case "MCTR":
		return "CTR"
	case "MATZ":
		return "ATZ"
	case "MTRA":
		return "TRA"
	case "MTA":
		return "TSA"

	// DFS Germany vocabulary. German airspace is filed under a handful
	// of generic types; the real kind is the aixm:localType or the
	// OTHER: extension code.
	case "CLASS":
		// A volume defined by its ICAO class (a TMA / CTA layer, e.g.
		// "SALZBURG TMA A" class D). Render as a class-banded control
		// area; the ClassCode column drives the band colour.
		return "CTA"
	case "CTR_P":
		return "CTR"
	case "TMA_P":
		// Georgia files each of its three TMAs as parts, the TMA itself an
		// aggregate with no boundary of its own: dropped, the country drew
		// no TMA at all.
		return "TMA"
	case "D_OTHER", "OTHER:D_AMC":
		return "D"
	case "OTHER:R_AMC":
		return "R"
	case "RAS":
		// Regulated airspace: dispatch on the localType.
		switch lt {
		case "RMZ", "TMZ", "ATZ", "DLG-ATS":
			return lt
		case "FBZ":
			// Danger sub-zone (e.g. EDD19A "TODENDORF-PUTLOS A", an
			// ED-D firing range). The SPA's own "FBZ" token is a
			// balloon activity glyph, so map to D, not FBZ.
			return "D"
		case "FLIGHT INFORMATION SECTOR":
			return "SIV"
		}
		// FRA (free-route reference), NPZ, GT and any other RAS
		// localType are not rendered on the airspace overlay.
		return ""

	// Airway / route / sector / class-of-airspace overlay: not part of
	// the airspace overlay (handled by route data later, or not drawn):
	// AWY, RCA, SECTOR, PROTECT (NATS / ENAIRE); PART, ENTRY, EXIT,
	// ENTRY_EXIT, DLGT, STATE, OTHER (DFS free-route / sectors). TIZ and
	// TIA used to be dropped here too, though neither NATS nor ENAIRE
	// files a volume under them; they are LFV's RMZs, above.
	case "AWY", "RCA", "SECTOR", "PROTECT":
		return ""
	}
	return ""
}

// coveredByWhole reports whether a part lies in one of wholes: its middle
// (the mean of its vertices) inside one, or most of its vertices, a thin
// part whose middle falls outside (ENAIRE's TMA SEVILLA AREA 4, four of its
// five inside) still being its whole's. A part shares its whole's edges,
// which a vertex on them may read either side of, so half is not enough:
// a part beside a whole, outside it, shares half its vertices with it.
func coveredByWhole(part [][2]float64, wholes [][][2]float64) bool {
	var mid [2]float64
	for _, p := range part {
		mid[0] += p[0] / float64(len(part))
		mid[1] += p[1] / float64(len(part))
	}
	for _, w := range wholes {
		if insideRing(mid, w) {
			return true
		}
		in := 0
		for _, p := range part {
			if insideRing(p, w) {
				in++
			}
		}
		if 2*in > len(part) {
			return true
		}
	}
	return false
}

// insideRing reports whether a [lat, lon] point lies inside a ring, by the
// even-odd rule on the plane of the coordinates.
func insideRing(p [2]float64, ring [][2]float64) bool {
	in := false
	for i, j := 0, len(ring)-1; i < len(ring); j, i = i, i+1 {
		a, b := ring[i], ring[j]
		if (a[0] > p[0]) != (b[0] > p[0]) && p[1] < a[1]+(p[0]-a[0])*(b[1]-a[1])/(b[0]-a[0]) {
			in = !in
		}
	}
	return in
}

// verticalTriple maps an aixm5.VerticalLimit to France's
// [code, val, uom] triple. Returns nil for an absent limit so the
// SPA's cleanVerticalLimit fast-path catches it.
//
// AIXM 5.1 axes:
//   - value: numeric ("350") or sentinel ("GND", "UNL")
//   - unit:  "FL", "FT", "M"
//   - ref:   "STD", "MSL", "SFC", "" (publisher-dependent)
//
// France codes (per cmd/fr/airspaces.go verTriple use sites):
//   - "STD": flight-level (FL); val is the level integer
//   - "ALT": altitude AMSL; val + uom (FT/M)
//   - "HEI": height AGL/ASFC; val=0 means GND
//   - "SFC": surface
//   - "UNL": unlimited (own triple; nil means "not published")
//   - "":    reference dropped by the publisher (renders bare downstream)
func verticalTriple(v *aixm5.VerticalLimit) any {
	if v == nil {
		return nil
	}
	val := strings.TrimSpace(v.Value)
	unit := strings.ToUpper(strings.TrimSpace(v.Unit))
	ref := strings.ToUpper(strings.TrimSpace(v.Ref))

	// ENAIRE hides limit references behind OTHER: prefixes: OTHER:ALT is an
	// AMSL altitude, OTHER:HEI / OTHER:HEISG heights above the surface. Map
	// them onto the standard vocabulary so the datum survives (they used to
	// fall through to the empty-code catch-all).
	switch ref {
	case "OTHER:ALT":
		ref = "MSL"
	case "OTHER:HEI", "OTHER:HEISG":
		ref = "SFC"
	}

	// Sentinels handled first. UNL keeps its own triple: a null limit means
	// "not published", which is a different fact than "unlimited".
	switch strings.ToUpper(val) {
	case "GND":
		return []string{"HEI", "0", "FT"}
	case "UNL":
		return []string{"UNL", "", ""}
	case "SFC":
		return []string{"SFC", "", ""}
	case "":
		if ref == "" {
			return nil
		}
	}

	// Flight levels: STD altimeter setting, value in FL units.
	if unit == "FL" {
		return []string{"STD", val, "FL"}
	}

	// Surface-referenced (above ground): height.
	if ref == "SFC" {
		return []string{"HEI", val, unit}
	}

	// Mean-sea-level referenced: altitude.
	if ref == "MSL" || ref == "AMSL" {
		return []string{"ALT", val, unit}
	}

	// Standard altimeter (numeric, not FL): treat as STD with the
	// unit verbatim (some publishers code FT-with-STD for transition
	// altitudes).
	if ref == "STD" {
		return []string{"STD", val, unit}
	}

	// No reference; emit the value with its unit and let the SPA's
	// renderer decide. This is the catch-all for partially populated
	// limits.
	if val != "" {
		return []string{"", val, unit}
	}
	return nil
}
