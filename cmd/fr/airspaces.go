// airspaces.go joins AIXM airspaces with their boundary geometry and radio
// frequencies and produces the compact fr-airspaces.json artifact. Moved from
// cmd/airspaces in the cmd/fr consolidation.

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/firarcs"
)

const (
	// Sanity window: observed count is ~3,850 after the May 2026 AIRAC
	// (1,636 base + ~2,189 D-OTHER + a handful of TMZ/RMZ/OCA/UTA/UIR-P).
	// Window allows ~30% headroom for cycle-to-cycle growth without
	// silently swallowing an upstream schema break.
	defaultMinAirspaces = 2500
	defaultMaxAirspaces = 6000
)

// sivLocalType marks the RAS airspaces that are French Flight Information
// Sectors (SIV). classifyAse maps them to the emitted type "SIV".
const sivLocalType = "FLIGHT INFORMATION SECTOR"

// isSIV reports whether the Ase is a Flight Information Sector row (the
// emitted SIV and FIC types both are). The one detection predicate:
// classifyAse, prepareIndexes, indexAIXMSIVsByName and resolveRadio all go
// through it, so a case / whitespace variant of the local type cannot be
// emitted as SIV while silently missing from the radio-join indexes, and
// the FIC split below cannot detach a row from those indexes either.
func isSIV(a *Ase) bool {
	return a.Uid.CodeType == "RAS" &&
		strings.ToUpper(strings.TrimSpace(a.TxtLocalType)) == sivLocalType
}

// firFsIdents are the French FIR / UIR location indicators. A Flight
// Information Sector whose codeId is one of them followed by "FS" is a
// FIR-level FIS sector run by the FIC (LFFFFSO PARIS OUEST, LFMMFSS
// MARSEILLE SUD, NWWWFS NOUVELLE CALEDONIE, SOCAFS CAYENNE), not an
// APP-run SIV (those carry their aerodrome ident: LFPMFS7 Melun SEINE,
// LFRBFS1 IROISE, TFFRFS Pointe-a-Pitre). The 1:500 000 chart prints
// "SIV APP" limits only, never the FIC sectors (their limits ride the FIR
// boundaries), so the app renders type FIC without the green SIV marks
// (docs/airspace-symbology.md, decision 2026-07-20).
var firFsIdents = []string{
	"LFFF", "LFRR", "LFBB", "LFMM", "LFEE", // metropolitan
	"NWWW", "SOCA", "TFFF", "FMEE", "NTTT", "SOOO", // overseas
}

// foreignAipTwinIdents are FIR / UIR rows the SIA export republishes from a
// NEIGHBOURING state's AIP that has its own dataset in the app. The SIA
// copy is a coarse simplification (LECB "BARCELONA" UIR: 11 points against
// ENAIRE's 307), and the app's merge dedupes by id with France first, so
// emitting it would shadow every ENAIRE volume filed under the same id
// (FIR + UIR + TMA BARCELONA). The OTHER foreign-ident FIR-family rows
// stay: CZQX Gander (Saint-Pierre-et-Miquelon), FMMM (La Reunion /
// Mayotte), TTZP (the Antilles), NTTT / SOOO and the OCA rows serve French
// territories and no higher-resolution dataset ships them.
var foreignAipTwinIdents = map[string]bool{
	"LECB": true,
}

// isFIC reports whether a Flight Information Sector row is FIR-level
// (emitted as FIC instead of SIV).
func isFIC(a *Ase) bool {
	if !isSIV(a) {
		return false
	}
	for _, ident := range firFsIdents {
		if strings.HasPrefix(a.Uid.CodeId, ident+"FS") {
			return true
		}
	}
	return false
}

// classifyAse maps an Ase record to the emitted `type` plus a `wanted` flag.
// Three outcomes:
//   - wanted=false: codeType isn't in the overlay (SECTOR / SECTOR-C are ATC
//     internal coordination, etc.). Silent skip, not counted.
//   - wanted=true, emit="": codeType is one we keep but the subtype is
//     unrecognised (e.g. a RAS with a new txtLocalType). Counted in
//     skippedNoClassify so upstream schema drift surfaces in the meta.
//   - wanted=true, emit=type: kept.
//
// RAS subtypes worth noting: FBZ = free balloon zone (high-FL meteo
// activity), DLG-ATS = delegated ATS responsibility, FRA = free route
// airspace, RMZ-TMZ = combined zone (one emit). D-OTHER splits by
// codeActivity for paragliding / gliding / ballooning / parachuting /
// towing; the rest collapse to a generic "ACTIVITY".
func classifyAse(a *Ase) (emit string, wanted bool) {
	switch a.Uid.CodeType {
	case "TMA", "CTR", "CTA",
		"R", "D", "P", "TRA",
		"FIR", "UIR", "OCA", "UTA":
		if (a.Uid.CodeType == "FIR" || a.Uid.CodeType == "UIR") &&
			foreignAipTwinIdents[a.Uid.CodeId] {
			return "", false
		}
		return a.Uid.CodeType, true
	case "UIR-P":
		return "UIR", true
	case "RAS":
		if isSIV(a) {
			if isFIC(a) {
				return "FIC", true
			}
			return "SIV", true
		}
		switch strings.ToUpper(strings.TrimSpace(a.TxtLocalType)) {
		case "TMZ":
			return "TMZ", true
		case "RMZ":
			return "RMZ", true
		case "RMZ-TMZ":
			return "TMZ-RMZ", true
		case "FBZ":
			return "FBZ", true
		case "DLG-ATS":
			return "DLG-ATS", true
		case "FRA":
			return "FRA", true
		}
		return "", true
	case "D-OTHER":
		// LTA (Lower Traffic Area / region inferieure de controle) is a
		// French national control area, not a sporting activity: the SIA
		// files it under D-OTHER but tags txtLocalType "LTA". It is class
		// D / E controlled airspace FL 115 - FL 195; the 500k chart groups
		// it with TMA / CTA (Legende2026, "Espaces aeriens controles"). Route
		// FIRST, ahead of the codeActivity split, so it never falls to the
		// generic ACTIVITY bucket.
		if strings.ToUpper(strings.TrimSpace(a.TxtLocalType)) == "LTA" {
			return "LTA", true
		}
		switch strings.ToUpper(strings.TrimSpace(a.CodeActivity)) {
		case "PARAGLIDER":
			return "PARAGLIDER", true
		case "GLIDER":
			return "GLIDER", true
		case "BALLOON":
			return "BALLOON", true
		case "PARACHUTE":
			return "PARACHUTE", true
		case "TOWING":
			return "TOWING", true
		}
		return "ACTIVITY", true
	}
	// Silent drop: SECTOR, SECTOR-C, anything else we don't track.
	return "", false
}

// isActivityType reports whether the emitted type is one of the D-OTHER
// activity variants. These rows are eligible for the single-vertex
// circle-synthesis fallback in pointBoundaryRing.
func isActivityType(t string) bool {
	switch t {
	case "ACTIVITY", "PARAGLIDER", "GLIDER", "BALLOON", "PARACHUTE", "TOWING":
		return true
	}
	return false
}

// airspacesOutputFields is the positional row layout of fr-airspaces.json;
// the browser indexes rows by these positions (rowToAirspace in src/lib/data/
// airspaces.ts). `subtype` carries the AIXM txtLocalType verbatim so the
// detail panel can show D-OTHER local types (VOL, TRVL, UAC, ...) and
// confirm RAS subtypes (TMZ, FBZ, ...). Empty when the source has no
// txtLocalType.
var airspacesOutputFields = []string{
	"id", "type", "name", "class",
	"upper", "lower", "max", "mnm",
	"workHr", "rmkWorkHr", "rmk",
	"radio", "ring", "subtype", "arcs",
}

// AirspacesArtifact is the fr-airspaces.json document.
type AirspacesArtifact struct {
	Fields []string `json:"fields"`
	Rows   []any    `json:"rows"`
}

// AirspacesMeta is the fr-airspaces.meta.json document.
type AirspacesMeta struct {
	GeneratedAt          string         `json:"generatedAt"`
	Source               string         `json:"source"`
	SourceSha256         string         `json:"sourceSha256"`
	Effective            string         `json:"effective"`
	AirspaceCount        int            `json:"airspaceCount"`
	SkippedNoBoundary    int            `json:"skippedNoBoundary"`
	SkippedNoClassify    int            `json:"skippedNoClassify"`
	SameExtentCount      int            `json:"sameExtentCount"`
	WithRadio            int            `json:"withRadio"`
	SIASectorMappedCount int            `json:"siaSectorMappedCount"`
	SIASectorInjectCount int            `json:"siaSectorInjectCount"`
	SIATMASectorCount    int            `json:"siaTMASectorCount"`
	Counts               map[string]int `json:"counts"`
	// BBox is the emitted rows' lat/lon envelope, which the SPA uses to
	// skip fetching a publisher the current view cannot reach (aip/bbox.go).
	BBox aip.BBox `json:"bbox,omitempty"`
	// BBoxes splits that envelope into the pieces the rows really
	// occupy, for a publisher whose territory is not connected;
	// absent when the rows form one group.
	BBoxes []aip.BBox `json:"bboxes,omitempty"`
}

// AirspacesOptions configures BuildAirspaces. SIASource is the optional
// XML_SIA_*.xml blob from the SIA zip; when non-nil, its per-sub-sector
// frequency remarks narrow each SIV (and approach-controlled TMA-part) row's
// radio list and augment it with the frequencies the AIXM never linked (see
// airspaces_sia.go and resolveRadio).
type AirspacesOptions struct {
	Source       string
	SIASource    []byte
	Now          func() time.Time // overridable for tests
	MinAirspaces int              // sanity window; 0 uses the default
	MaxAirspaces int
}

// BuildAirspaces decodes the AIXM source and produces the airspaces artifact
// and meta.
func BuildAirspaces(src []byte, opts AirspacesOptions) (AirspacesArtifact, AirspacesMeta, error) {
	minA, maxA := airspaceLimits(opts)
	now := opts.Now
	if now == nil {
		now = time.Now
	}

	snap, err := decodeAirspacesSnapshot(src)
	if err != nil {
		return AirspacesArtifact{}, AirspacesMeta{}, err
	}

	// Resolve the optional SIA proprietary XML against AIXM-name indexes so
	// SecteurSituation-tagged frequencies ("PARIS NORD") and "TMA <NAME> N"
	// approach tags ("SEINE 5") land on the right codeIds. With no SIA source
	// the plan is empty and the rows fall back to AIXM-only behaviour.
	plan, err := loadSIAPlan(opts.SIASource, indexAIXMSIVsByName(snap.ases), indexAIXMTMAsByName(snap.ases))
	if err != nil {
		return AirspacesArtifact{}, AirspacesMeta{}, fmt.Errorf("SIA: %w", err)
	}

	idx := prepareIndexes(snap)
	// The per-part control frequency exists in neither the AIXM nor ENR 2.1;
	// it comes from joining the published approach sectors' geometry to the
	// frequencies the SIA names them on (airspaces_sectors.go). Runs here
	// because it needs the boundary index, and before buildRows because it
	// feeds the same SectorEntries resolveRadio already applies.
	tmaSectors := assignTMASectorRadio(&plan, snap, idx)
	rows, stats, err := buildRows(snap, idx, plan, minA, maxA)
	if err != nil {
		return AirspacesArtifact{}, AirspacesMeta{}, err
	}
	// Same-state same-type FIR siblings get their foreign-facing arcs;
	// for the SIA export the only real group is the five metropolitan
	// FIRs (the LFFF UIR FRANCE outline stays a typed singleton).
	firarcs.Apply(rows)

	sum := sha256.Sum256(src)
	meta := AirspacesMeta{
		GeneratedAt:          now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Source:               opts.Source,
		SourceSha256:         hex.EncodeToString(sum[:]),
		Effective:            snap.effective,
		AirspaceCount:        len(rows),
		SkippedNoBoundary:    stats.skipped,
		SkippedNoClassify:    stats.skippedClass,
		SameExtentCount:      stats.sameExtent,
		WithRadio:            stats.withRadio,
		SIASectorMappedCount: stats.siaSectorMapped,
		SIASectorInjectCount: stats.siaInjected,
		SIATMASectorCount:    tmaSectors,
		Counts:               stats.counts,
	}
	meta.BBox = aip.BBoxOfRows(airspacesOutputFields, rows)
	meta.BBoxes = aip.BBoxClustersOfRows(airspacesOutputFields, rows)
	return AirspacesArtifact{Fields: airspacesOutputFields, Rows: rows}, meta, nil
}

func airspaceLimits(opts AirspacesOptions) (minA, maxA int) {
	minA, maxA = opts.MinAirspaces, opts.MaxAirspaces
	if minA == 0 {
		minA = defaultMinAirspaces
	}
	if maxA == 0 {
		maxA = defaultMaxAirspaces
	}
	return
}

// airspaceIndexes holds the AIXM lookup maps every row needs: boundary by
// airspace mid, services per airspace, frequencies per service, the SIV stem
// index used by buildSIVRadio, and the same-extent base each Ase without its
// own boundary borrows from.
type airspaceIndexes struct {
	abdByAse        map[int64]*Abd
	sameExtentByAse map[int64]int64
	saeByAse        map[int64][]Sae
	fqyBySer        map[int64][]Fqy
	sivMidsByStem   map[string][]int64
}

func prepareIndexes(snap airspacesSnapshot) airspaceIndexes {
	// Boundary by airspace mid (exactly one Abd per Ase in practice; the
	// first wins on the rare duplicate).
	abdByAse := make(map[int64]*Abd, len(snap.abds))
	for i := range snap.abds {
		mid := snap.abds[i].Uid.AseUid.Mid
		if _, dup := abdByAse[mid]; !dup {
			abdByAse[mid] = &snap.abds[i]
		}
	}
	// Same-extent base per twin Ase: a vertically split volume's twin rows
	// (the class E part under a class D TMA, the LTA Alps slabs) carry no Abd
	// and borrow the base's lateral extent. The union-group Adgs decode with a
	// zero SameExtent.Mid and are skipped.
	sameExtentByAse := make(map[int64]int64, len(snap.adgs))
	for i := range snap.adgs {
		adg := &snap.adgs[i]
		if adg.SameExtent.Mid != 0 {
			sameExtentByAse[adg.Uid.AseUid.Mid] = adg.SameExtent.Mid
		}
	}
	saeByAse := make(map[int64][]Sae)
	for _, s := range snap.saes {
		saeByAse[s.Uid.AseUid.Mid] = append(saeByAse[s.Uid.AseUid.Mid], s)
	}
	fqyBySer := make(map[int64][]Fqy)
	for _, f := range snap.fqys {
		fqyBySer[f.Uid.Ser.Mid] = append(fqyBySer[f.Uid.Ser.Mid], f)
	}
	// A SIV's frequency is split across sibling RAS records sharing a
	// codeId stem (a frequency-bearing parent plus geometry-bearing
	// numbered parts), so group every SIV's mid by stem for the radio
	// join in buildSIVRadio.
	sivMidsByStem := make(map[string][]int64)
	for i := range snap.ases {
		a := &snap.ases[i]
		if isSIV(a) {
			stem := sivStem(a.Uid.CodeId)
			sivMidsByStem[stem] = append(sivMidsByStem[stem], a.Uid.Mid)
		}
	}
	return airspaceIndexes{
		abdByAse:        abdByAse,
		sameExtentByAse: sameExtentByAse,
		saeByAse:        saeByAse,
		fqyBySer:        fqyBySer,
		sivMidsByStem:   sivMidsByStem,
	}
}

// buildStats accumulates the per-row decisions buildRows surfaces into the
// meta sidecar.
type buildStats struct {
	counts          map[string]int
	skipped         int
	skippedClass    int
	withRadio       int
	siaSectorMapped int
	siaInjected     int
	sameExtent      int
}

// buildRows walks the Ase list, classifies each entry, joins boundary and
// radio data, and accumulates the artifact rows. Returns an error when the
// final row count falls outside the sanity window so an upstream schema
// break doesn't silently ship.
func buildRows(snap airspacesSnapshot, idx airspaceIndexes, plan loadedSIAPlan, minA, maxA int) ([]any, buildStats, error) {
	rows := make([]any, 0, len(snap.ases))
	stats := buildStats{counts: make(map[string]int)}
	for i := range snap.ases {
		ase := &snap.ases[i]
		emitType, wanted := classifyAse(ase)
		if !wanted {
			// codeType isn't in our overlay (SECTOR / SECTOR-C / ...).
			continue
		}
		if emitType == "" {
			// Wanted codeType, unrecognised subtype; surfaces in meta
			// so upstream schema drift is visible.
			stats.skippedClass++
			continue
		}
		abd, borrowed := resolveBoundary(ase.Uid.Mid, emitType, idx)
		ring, ok := buildRing(abd, ase, emitType)
		if !ok {
			stats.skipped++
			continue
		}
		if borrowed {
			stats.sameExtent++
		}
		radio := resolveRadio(ase, idx, plan, &stats)
		if len(radio) > 0 {
			stats.withRadio++
		}
		stats.counts[emitType]++
		rows = append(rows, aseRow(ase, emitType, ring, radio, borrowed))
	}
	if n := len(rows); n < minA || n > maxA {
		return nil, buildStats{}, fmt.Errorf(
			"airspace count %d outside sanity window [%d, %d] - source format may have changed",
			n, minA, maxA)
	}
	return rows, stats, nil
}

// isFirFamilyType reports whether the emitted type is a FIR-family row (FIR
// / UIR / OCA). resolveBoundary excludes these from the same-extent borrow:
// a FIR twin's ring is identical to its base, which would make
// internal/firarcs see same-state same-type siblings sharing every run,
// emit EMPTY arcs, and grey out the FIR limits; the twin also duplicates the
// row a NOTAM's Item A) files under. The one dropped twin per FIR (LFFF.20,
// FMMM.20, NTTT.20, OCA4521.20, OCA4691.20) carries no boundary of its own,
// so the base FIR row still draws the region.
func isFirFamilyType(t string) bool {
	switch t {
	case "FIR", "UIR", "OCA":
		return true
	}
	return false
}

// resolveBoundary returns the Abd to use for an Ase and whether it was
// borrowed from a same-extent base. Rows with their own Abd use it directly.
// A vertically split volume's twin carries no Abd; it borrows the base's
// lateral extent through ONE AseUidSameExtent hop (no recursion: the sole
// chained case in the export points at a boundary-less union-group parent and
// is a FIR twin, excluded anyway). Returns (nil, false) when no boundary is
// reachable, so buildRing skips the row exactly as before.
func resolveBoundary(mid int64, emitType string, idx airspaceIndexes) (*Abd, bool) {
	if abd := idx.abdByAse[mid]; abd != nil {
		return abd, false
	}
	if isFirFamilyType(emitType) {
		return nil, false
	}
	if base, ok := idx.sameExtentByAse[mid]; ok {
		if abd := idx.abdByAse[base]; abd != nil {
			return abd, true
		}
	}
	return nil, false
}

// buildRing returns the boundary ring for an Ase, synthesising a small
// circle for the single-vertex D-OTHER activity case that boundaryRing
// would otherwise reject as degenerate. ok=false means no ring is
// available; the caller skips the row.
func buildRing(abd *Abd, ase *Ase, emitType string) ([][2]float64, bool) {
	if abd == nil {
		return nil, false
	}
	ring, err := boundaryRing(abd)
	if err != nil && isActivityType(emitType) {
		if alt := pointBoundaryRing(abd, 0.5*1852); alt != nil {
			ring, err = alt, nil
		}
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "skip %s %s: %v\n", ase.Uid.CodeType, ase.Uid.CodeId, err)
		return nil, false
	}
	return ring, true
}

// resolveRadio returns the radio list for one Ase. Flight Information
// Sector records (emitted SIV or FIC; the isSIV predicate, so the FIC
// split cannot strip the FIR-level sectors' frequencies) get the
// stem-wide union, then the SIA sector entries narrow it to (and augment it
// with) the frequencies that serve the sub-sector; failing that, an SIA
// inject backfills when AIXM lacks the Sae link. Every other type uses the
// simple per-mid chain, but an approach-controlled TMA part the SIA tags by
// number is narrowed the same way (its AIXM Sae union carries every approach
// frequency, since they all share one untagged service).
func resolveRadio(ase *Ase, idx airspaceIndexes, plan loadedSIAPlan, stats *buildStats) []any {
	if !isSIV(ase) {
		radio := buildRadio(ase.Uid.Mid, idx.saeByAse, idx.fqyBySer)
		if entries := plan.SectorEntries[ase.Uid.CodeId]; len(entries) > 0 {
			radio = applySectorEntries(radio, entries)
			stats.siaSectorMapped++
		}
		return radio
	}
	radio := buildSIVRadio(idx.sivMidsByStem[sivStem(ase.Uid.CodeId)], idx.saeByAse, idx.fqyBySer)
	if entries := plan.SectorEntries[ase.Uid.CodeId]; len(entries) > 0 {
		radio = applySectorEntries(radio, entries)
		stats.siaSectorMapped++
		return radio
	}
	// Untagged sub-sector: the SIA assigns it no "SIV N" frequency, so its
	// stem-wide union would otherwise carry the whole Information service. Keep
	// only the general frequencies by dropping the ones the SIA marks as a
	// backup role, a delegation, or as belonging to a different numbered sector;
	// never trim to empty, so a data gap can't blank a sub-sector.
	if drop := plan.StemDropFreqs[sivStem(ase.Uid.CodeId)]; len(drop) > 0 && len(radio) > 0 {
		if trimmed := excludeRadioByFreq(radio, drop); len(trimmed) > 0 {
			radio = trimmed
		}
	}
	if len(radio) == 0 {
		if entries := plan.InjectFreqs[ase.Uid.CodeId]; len(entries) > 0 {
			for _, e := range entries {
				radio = append(radio, []string{e.Freq, e.Unit, e.Callsign})
			}
			stats.siaInjected++
		}
	}
	return radio
}

// applySectorEntries narrows a SIV's AIXM stem union to the frequencies the
// SIA assigns to this sub-sector AND augments it with any the AIXM never
// linked. Frequencies present in both keep their AIXM unit/call sign (the
// real ICAO station); SIA-only frequencies (orphaned or mis-linked services,
// plus the hand overrides) are synthesised from the SIA service link.
func applySectorEntries(radio []any, entries []InjectEntry) []any {
	allowed := make(map[float64]bool, len(entries))
	for _, e := range entries {
		if v, err := parseFreq(e.Freq); err == nil {
			allowed[v] = true
		}
	}
	out := filterRadioByFreq(radio, allowed)
	have := make(map[float64]bool, len(out))
	for _, e := range out {
		entry, ok := e.([]string)
		if !ok || len(entry) == 0 {
			continue
		}
		if v, err := parseFreq(entry[0]); err == nil {
			have[v] = true
		}
	}
	for _, e := range entries {
		v, err := parseFreq(e.Freq)
		if err != nil || have[v] {
			continue
		}
		out = append(out, []string{e.Freq, e.Unit, e.Callsign})
		have[v] = true
	}
	return out
}

// slabSuffixRe matches the SIA vertical-slab tail on a same-extent twin's
// name: an optional space, a dot, one digit, then a trailing zero (".20" /
// ".30" / ".40", incl. "AZ4 .20" and "BIARRITZ 9.2.20"). aseRow strips it
// from borrowed rows so the twin shares the base's printed designator: the
// chart prints ONE label per shared outline, and the deco layer's label
// de-collision then places just one. The raw codeId (LFLC2.20) stays in the
// id field, so the row is still traceable and same-id keying is untouched.
var slabSuffixRe = regexp.MustCompile(`\s*\.\d0$`)

// aseRow builds one positional row matching airspacesOutputFields. borrowed
// marks a same-extent twin (see resolveBoundary), whose name loses its slab
// suffix.
func aseRow(ase *Ase, emitType string, ring [][2]float64, radio []any, borrowed bool) []any {
	name := ase.TxtName
	if borrowed {
		name = slabSuffixRe.ReplaceAllString(name, "")
	}
	return []any{
		ase.Uid.CodeId,
		emitType,
		name,
		ase.CodeClass,
		verTriple(ase.CodeDistVerUpper, ase.ValDistVerUpper, ase.UomDistVerUpper),
		verTriple(ase.CodeDistVerLower, ase.ValDistVerLower, ase.UomDistVerLower),
		verTriple(ase.CodeDistVerMax, ase.ValDistVerMax, ase.UomDistVerMax),
		verTriple(ase.CodeDistVerMnm, ase.ValDistVerMnm, ase.UomDistVerMnm),
		ase.WorkHr,
		ase.RmkWorkHr,
		ase.TxtRmk,
		radio,
		ring,
		strings.TrimSpace(ase.TxtLocalType),
		// arcs: patched by firarcs.Apply for FIR-family rows with
		// same-state siblings once every ring is built; nil (JSON
		// null) everywhere else.
		nil,
	}
}

// loadedSIAPlan is the build-time view of SIAPlan. SectorEntries carries the
// per-sub-sector [freq, unit, callsign] triples; applySectorEntries parses
// the frequency strings on demand (tolerating SIA-vs-AIXM trailing-zero
// differences like "126.480" vs "126.48"). assignTMASectorRadio adds to
// SectorEntries from APPSectorFreqs before the rows are built.
type loadedSIAPlan struct {
	SectorEntries  map[string][]InjectEntry
	InjectFreqs    map[string][]InjectEntry
	StemDropFreqs  map[string][]string
	APPSectorFreqs map[string][]InjectEntry
}

// loadSIAPlan parses the SIA proprietary XML and returns the build-side view.
// Even with empty src the plan still carries sivFreqOverrides, so the hand
// fixes apply in the AIXM-only path too.
func loadSIAPlan(src []byte, aixmSIVByName AIXMSIVByName, aixmTMAByName AIXMTMAByName) (loadedSIAPlan, error) {
	plan, err := parseSIA(src, aixmSIVByName, aixmTMAByName)
	if err != nil {
		return loadedSIAPlan{}, err
	}
	return loadedSIAPlan{
		SectorEntries:  plan.SectorEntries,
		InjectFreqs:    plan.InjectFreqs,
		StemDropFreqs:  plan.StemDropFreqs,
		APPSectorFreqs: plan.APPSectorFreqs,
	}, nil
}

// indexAIXMSIVsByName produces a normalised-name → []codeId index over
// the SIV Ase records. Used by parseSIA to resolve SIA SecteurSituation
// tags ("PARIS" + "NORD" → "PARIS NORD" → [LFFFFSN]) to concrete codeIds.
// Multiple codeIds can share a name when an AIXM SIV is vertically
// subdivided (e.g. MARSEILLE NORD has LFMMFSN / LFMMFSN1 / LFMMFSN2).
func indexAIXMSIVsByName(ases []Ase) AIXMSIVByName {
	out := make(AIXMSIVByName)
	for i := range ases {
		a := &ases[i]
		if !isSIV(a) {
			continue
		}
		key := normaliseName(a.TxtName)
		if key == "" {
			continue
		}
		out[key] = append(out[key], a.Uid.CodeId)
	}
	return out
}

// indexAIXMTMAsByName produces a normalised-name → []codeId index over the
// AIXM TMA airspace parts ("SEINE 5" → ["LFPM5"]). parseSIA uses it to resolve
// the "TMA <NAME> <parts>" approach-remark tags to concrete codeIds. The bare
// TMA parent ("SEINE" → "LFPM", no boundary, never emitted) is indexed too but
// never looked up, since the tags always cite a numbered part.
func indexAIXMTMAsByName(ases []Ase) AIXMTMAByName {
	out := make(AIXMTMAByName)
	for i := range ases {
		a := &ases[i]
		if a.Uid.CodeType != "TMA" {
			continue
		}
		key := normaliseName(a.TxtName)
		if key == "" {
			continue
		}
		out[key] = append(out[key], a.Uid.CodeId)
	}
	return out
}

// excludeRadioByFreq is the inverse of filterRadioByFreq: it drops the radio
// entries whose frequency parses to a value in dropFreqs and keeps everything
// else (entries that fail to parse fall through). resolveRadio uses it to strip
// an untagged SIV sub-sector's non-general frequencies (backup / delegated /
// other-numbered-sector) from the stem union. dropFreqs are SIA-side strings,
// parsed on demand so SIA-vs-AIXM trailing-zero differences ("135.850" vs
// "135.85") still match.
func excludeRadioByFreq(radio []any, dropFreqs []string) []any {
	drop := make(map[float64]bool, len(dropFreqs))
	for _, f := range dropFreqs {
		if v, err := parseFreq(f); err == nil {
			drop[v] = true
		}
	}
	out := make([]any, 0, len(radio))
	for _, e := range radio {
		entry, ok := e.([]string)
		if !ok || len(entry) == 0 {
			out = append(out, e)
			continue
		}
		if v, err := parseFreq(entry[0]); err == nil && drop[v] {
			continue
		}
		out = append(out, e)
	}
	return out
}

// filterRadioByFreq keeps the radio entries whose frequency string parses
// to a float64 in allowed. Entries that fail to parse fall through (the
// allowlist is only an inclusion filter for well-formed frequencies).
func filterRadioByFreq(radio []any, allowed map[float64]bool) []any {
	out := make([]any, 0, len(radio))
	for _, e := range radio {
		entry, ok := e.([]string)
		if !ok || len(entry) == 0 {
			out = append(out, e)
			continue
		}
		v, err := parseFreq(entry[0])
		if err != nil {
			out = append(out, e)
			continue
		}
		if allowed[v] {
			out = append(out, e)
		}
	}
	return out
}

// parseFreq parses a frequency string ("126.48", "126.480 ", "  119.000")
// to a float64, rounded to 3 decimals so SIA and AIXM formatting agree.
func parseFreq(s string) (float64, error) {
	s = strings.TrimSpace(s)
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, err
	}
	return float64(int64(v*1000+0.5)) / 1000, nil
}

// verTriple returns a [code,val,uom] triple, or nil when the limit is absent.
// The SIA encodes "unlimited" as FL999 (one FL9999 row exists in the export);
// both normalize to the explicit UNL triple so no consumer mistakes them for
// a real flight level.
func verTriple(code, val, uom string) any {
	if code == "" && val == "" && uom == "" {
		return nil
	}
	if code == "STD" && uom == "FL" && (val == "999" || val == "9999") {
		return []string{"UNL", "", ""}
	}
	return []string{code, val, uom}
}

// sivStem returns the codeId stem a SIV shares with its sibling records: the
// 4-character ICAO centre code plus the "FS" sector marker that follows it;
// "LFSBFS22" -> "LFSBFS", "LFSTFS1" -> "LFSTFS", "LFRNFSNORD" -> "LFRNFS". A
// SIV's frequency-bearing parent and its geometry-bearing numbered parts all
// share this stem. The search starts past the centre code so an "FS" inside the
// ICAO indicator itself (Bâle "LF-S-B", Strasbourg "LF-S-T") is not mistaken for
// the marker, which would collapse both centres into one "LFS" stem and
// cross-link their frequencies.
func sivStem(codeId string) string {
	if len(codeId) > 4 {
		if i := strings.Index(codeId[4:], "FS"); i >= 0 {
			return codeId[:4+i+2]
		}
	}
	return codeId
}

// buildRadio collects the deduplicated radio frequencies serving an airspace.
// Each entry is [frequency, unitName, callSign].
func buildRadio(aseMid int64, saeByAse map[int64][]Sae, fqyBySer map[int64][]Fqy) []any {
	out := []any{}
	seen := make(map[string]bool)
	for _, sae := range saeByAse[aseMid] {
		unit := sae.Uid.Ser.UniName
		for _, fqy := range fqyBySer[sae.Uid.Ser.Mid] {
			freq := strings.TrimSpace(fqy.Uid.ValFreqTrans)
			if freq == "" {
				continue
			}
			key := freq + "|" + unit
			if seen[key] {
				continue
			}
			seen[key] = true
			out = append(out, []string{freq, unit, callSign(fqy)})
		}
	}
	return out
}

// buildSIVRadio collects a Flight Information Sector's frequencies by unioning
// buildRadio over every sibling airspace sharing the sector's codeId stem; a
// SIV's frequency sits on a parent record while geometry sits on numbered
// parts. Entries keep buildRadio's [frequency, unitName, callSign] shape.
func buildSIVRadio(mids []int64, saeByAse map[int64][]Sae, fqyBySer map[int64][]Fqy) []any {
	out := []any{}
	seen := make(map[string]bool)
	for _, mid := range mids {
		for _, entry := range buildRadio(mid, saeByAse, fqyBySer) {
			e := entry.([]string)
			key := e[0] + "|" + e[1]
			if seen[key] {
				continue
			}
			seen[key] = true
			out = append(out, entry)
		}
	}
	return out
}

// callSign returns the French call sign, falling back to English then any.
func callSign(f Fqy) string {
	var fr, en, fallback string
	for _, c := range f.Cdl {
		switch c.CodeLang {
		case "FR":
			fr = c.TxtCallSign
		case "EN":
			en = c.TxtCallSign
		}
		if fallback == "" {
			fallback = c.TxtCallSign
		}
	}
	switch {
	case fr != "":
		return fr
	case en != "":
		return en
	default:
		return fallback
	}
}
