// airspaces_sectors.go gives an approach-controlled TMA / CTA part the
// frequency of the control sector that works it, by joining the sectors' own
// published geometry to the frequencies the SIA names them on.
//
// The AIXM cannot state this: Sae links an airspace to a SERVICE and the Fqy
// frequencies hang off the service, so Lille's single "LFQQ LILLE"/APP service
// puts all six approach channels on all 19 TMA parts, and its Fqy records carry
// no remark at all. The eAIP ENR 2.1 table has no frequency column either. Only
// the 1:500 000 chart prints the per-part frequency (TMA LILLE 12: 120.275).
//
// Two published facts recover it. The SIA proprietary XML names each channel's
// control sector ("Secteur QW-Contrôle en TMA", collected into
// APPSectorFreqs), and the AIXM publishes those sectors as airspaces of their
// own: codeType SECTOR with txtLocalType APP, each with its Abd boundary and
// vertical limits (LFQQQW = "QW", SFC / FL 115; also in eAIP ENR 2.2). A part
// inside sector QW is worked by QW, so it carries QW's frequency.
//
// The rule is deliberately fail-safe: a row keeps its full AIXM union unless
// every condition in assignTMASectorRadio holds, since a wrong frequency is
// worse than several right ones. Seine, the one unit that states the mapping
// itself ("Secteur/Sector SJ (TMA SEINE 1/5/6)"), keeps that statement: the
// geometric entries are only written where SectorEntries has none. The two
// agree on all 11 Seine parts, which is what validates the rule.

package main

import (
	"strconv"
	"strings"
)

// sectorSliverShare is the share of a part's area a sector must cover to count
// as working it. TMA parts are commonly cut along sector boundaries, so a
// fraction of a percent of overlap is coincident edges, not a handover.
const sectorSliverShare = 0.15

// sectorTieShare is how close the runner-up may be to the dominant sector
// before both are kept. A part is charged to the sector that covers most of it
// (the chart prints one frequency per box, and for the two straddling Seine
// parts the publisher's own choice is the dominant sector), but sectors that
// cover it equally (the vertically split Bastia KB / KC, both whole) cannot be
// separated that way and both stand.
const sectorTieShare = 0.05

// sectorSampleGrid is the resolution of the area sample per part: an n x n
// lattice over its bounding box, keeping the points inside its ring.
const sectorSampleGrid = 28

// appSector is one published approach control sector: its ring and bounding
// box, its approximate vertical band in feet, and the frequencies the SIA works
// it on (empty when the SIA names no frequency for it).
type appSector struct {
	ring                           [][2]float64
	minLat, maxLat, minLon, maxLon float64
	lowerFt, upperFt               float64
	entries                        []InjectEntry
}

// assignTMASectorRadio fills plan.SectorEntries for every TMA / CTA part whose
// control sector can be resolved from geometry, and returns how many parts it
// keyed. A part qualifies only when ALL of these hold:
//
//  1. exactly one AIXM service serves it, of codeType APP (so a CTR keeps its
//     tower, ground and ATIS rows, which share the aerodrome's Sae list);
//  2. its unit publishes APP sectors with boundaries;
//  3. sectors cover at least sectorSliverShare of it and overlap it vertically;
//  4. the dominant one (plus any within sectorTieShare) is named by the SIA;
//  5. the resulting frequencies are a strict subset of the part's own union.
//
// Anything else leaves the row untouched. The entries written are the part's
// OWN union rows, so applySectorEntries only ever narrows here, never augments,
// and the AIXM unit and call sign survive.
func assignTMASectorRadio(plan *loadedSIAPlan, snap airspacesSnapshot, idx airspaceIndexes) int {
	sectors := indexAPPSectors(snap, idx, *plan)
	if len(sectors) == 0 {
		return 0
	}
	keyed := 0
	for i := range snap.ases {
		ase := &snap.ases[i]
		if ase.Uid.CodeType != "TMA" && ase.Uid.CodeType != "CTA" {
			continue
		}
		if _, done := plan.SectorEntries[ase.Uid.CodeId]; done {
			continue // the SIA states this part itself (Seine).
		}
		approachUnit := soleApproachUnit(ase.Uid.Mid, idx)
		if approachUnit == "" {
			continue
		}
		stemSectors := sectors[partStem(ase.Uid.CodeId, approachUnit)]
		if len(stemSectors) == 0 {
			continue
		}
		abd, _ := resolveBoundary(ase.Uid.Mid, ase.Uid.CodeType, idx)
		if abd == nil {
			continue
		}
		ring, err := boundaryRing(abd)
		if err != nil {
			continue
		}
		entries, ok := sectorEntriesFor(ring, ase, stemSectors)
		if !ok {
			continue
		}
		// Keep only what the part already publishes, and only when that is a
		// real reduction: a set equal to the union says nothing, and an empty
		// one means the sector's frequency is not on this part's service.
		union := buildRadio(ase.Uid.Mid, idx.saeByAse, idx.fqyBySer)
		kept := keepUnionEntries(union, entries)
		if len(kept) == 0 || len(kept) >= len(union) {
			continue
		}
		plan.SectorEntries[ase.Uid.CodeId] = kept
		keyed++
	}
	return keyed
}

// indexAPPSectors groups the published approach sectors by unit stem, keeping
// only those with a usable boundary. Sectors the SIA never names keep an empty
// entry list on purpose: they still block a part they cover (condition 4).
func indexAPPSectors(snap airspacesSnapshot, idx airspaceIndexes, plan loadedSIAPlan) map[string][]appSector {
	out := map[string][]appSector{}
	for i := range snap.ases {
		ase := &snap.ases[i]
		if ase.Uid.CodeType != "SECTOR" || !strings.EqualFold(strings.TrimSpace(ase.TxtLocalType), "APP") {
			continue
		}
		abd := idx.abdByAse[ase.Uid.Mid]
		if abd == nil {
			continue
		}
		ring, err := boundaryRing(abd)
		if err != nil {
			continue
		}
		stem := unitStem(ase.Uid.CodeId)
		lower, upper := verticalBandFt(ase)
		s := appSector{ring: ring, lowerFt: lower, upperFt: upper}
		s.minLat, s.maxLat, s.minLon, s.maxLon = ringBBox(ring)
		s.entries = plan.sectorFreqEntries(stem, normaliseName(ase.TxtName))
		out[stem] = append(out[stem], s)
	}
	return out
}

// sectorFreqEntries returns the frequencies the SIA works a sector on: its own
// name first, else its family ("FA 1" under a bare "Secteur d'approche FA").
func (p loadedSIAPlan) sectorFreqEntries(stem, name string) []InjectEntry {
	if e := p.APPSectorFreqs[stem+"|"+name]; len(e) > 0 {
		return e
	}
	if family, _, ok := strings.Cut(name, " "); ok {
		return p.APPSectorFreqs[stem+"|"+family]
	}
	return nil
}

// sectorEntriesFor picks the sectors that decide this part and returns their
// frequencies. ok=false means no assignment: nothing covers the part, or a
// deciding sector is one the SIA never names (Strasbourg's RE / RW, Lyon's
// VE / VW), and guessing past that is exactly what this must not do.
func sectorEntriesFor(ring [][2]float64, ase *Ase, sectors []appSector) ([]InjectEntry, bool) {
	samples := interiorSamples(ring, sectorSampleGrid)
	if len(samples) == 0 {
		return nil, false
	}
	lower, upper := verticalBandFt(ase)
	best := 0.0
	shares := make([]float64, len(sectors))
	for i := range sectors {
		s := &sectors[i]
		if !bandsOverlap(lower, upper, s.lowerFt, s.upperFt) {
			continue
		}
		share := coveredShare(samples, s)
		if share < sectorSliverShare {
			continue
		}
		shares[i] = share
		if share > best {
			best = share
		}
	}
	if best == 0 {
		return nil, false
	}
	var out []InjectEntry
	for i := range sectors {
		if shares[i] < best-sectorTieShare {
			continue
		}
		if len(sectors[i].entries) == 0 {
			return nil, false
		}
		for _, e := range sectors[i].entries {
			if !hasFreq(out, e.Freq) {
				out = append(out, e)
			}
		}
	}
	return out, len(out) > 0
}

// keepUnionEntries returns the part's own union rows whose frequency the
// sectors work, as InjectEntry triples in the union's order.
func keepUnionEntries(union []any, entries []InjectEntry) []InjectEntry {
	want := make(map[float64]bool, len(entries))
	for _, e := range entries {
		if v, err := parseFreq(e.Freq); err == nil {
			want[v] = true
		}
	}
	var out []InjectEntry
	for _, row := range union {
		triple, ok := row.([]string)
		if !ok || len(triple) < 3 {
			continue
		}
		v, err := parseFreq(triple[0])
		if err != nil || !want[v] {
			continue
		}
		out = append(out, InjectEntry{Freq: triple[0], Unit: triple[1], Callsign: triple[2]})
	}
	return out
}

// servedByApproachAlone reports whether exactly one service serves the
// airspace and it is an approach one. A volume sharing its Sae list with a
// tower, ground or ATIS service is an aerodrome's, and narrowing it to one
// approach channel would drop the frequencies a pilot needs there.
func servedByApproachAlone(mid int64, idx airspaceIndexes) bool {
	return soleApproachUnit(mid, idx) != ""
}

// soleApproachUnit returns the txtName of the ONE approach service serving the
// airspace ("LFQQ LILLE"), or "" when several services serve it or the one that
// does is not an approach.
func soleApproachUnit(mid int64, idx airspaceIndexes) string {
	unit := ""
	seen := map[int64]bool{}
	for _, sae := range idx.saeByAse[mid] {
		if seen[sae.Uid.Ser.Mid] {
			continue
		}
		seen[sae.Uid.Ser.Mid] = true
		if len(seen) > 1 {
			return ""
		}
		if !strings.EqualFold(strings.TrimSpace(sae.Uid.Ser.CodeType), "APP") {
			return ""
		}
		unit = strings.TrimSpace(sae.Uid.Ser.UniName)
	}
	return unit
}

// unitStem is the 4-character ICAO indicator every codeId of one unit shares:
// "LFQQ12" → "LFQQ", "LFQQQW" → "LFQQ", "LFPM7.1" → "LFPM".
func unitStem(codeId string) string {
	if len(codeId) < 4 {
		return ""
	}
	return codeId[:4]
}

// partStem is the ICAO indicator to look a part's control sectors up under.
// The codeId carries it for a TMA named after its unit ("LFQQ12" → "LFQQ"),
// but a CTA is filed under a serial ("CTA7500N", "CTA13502") and every one of
// the 80 published CTA parts stemmed to "CTA7" / "CTA1", which matches no
// sector and silently excluded the whole type from a rule the package
// documents as covering it. The SERVICE knows: an airspace worked by one
// approach carries that unit's own name, whose first word is the indicator.
// The codeId stays the fallback, so nothing that resolved before moves.
func partStem(codeId, approachUnit string) string {
	if stem := unitStem(codeId); isICAOIndicator(stem) {
		return stem
	}
	if i := strings.IndexByte(approachUnit, ' '); i > 0 {
		if stem := strings.ToUpper(approachUnit[:i]); isICAOIndicator(stem) {
			return stem
		}
	}
	return ""
}

// isICAOIndicator reports whether s is a 4-letter location indicator, the shape
// every published sector codeId stems to.
func isICAOIndicator(s string) bool {
	if len(s) != 4 {
		return false
	}
	for i := 0; i < len(s); i++ {
		if c := s[i]; c < 'A' || c > 'Z' {
			return false
		}
	}
	return true
}

// verticalBandFt returns an airspace's vertical limits in approximate feet, for
// the overlap test alone: a flight level counts as 100 ft each and the datums
// (AMSL / above-surface / standard) are not reconciled, which is enough to tell
// a sector stacked above a part from one around it, and never enough to move a
// frequency on its own. An absent limit opens the band.
func verticalBandFt(ase *Ase) (lower, upper float64) {
	lower = levelFt(ase.CodeDistVerLower, ase.ValDistVerLower, ase.UomDistVerLower, 0)
	upper = levelFt(ase.CodeDistVerUpper, ase.ValDistVerUpper, ase.UomDistVerUpper, unlimitedFt)
	if upper <= lower {
		return 0, unlimitedFt
	}
	return lower, upper
}

// unlimitedFt stands for UNL / an absent ceiling: above every published French
// airspace (FL 660 is the highest).
const unlimitedFt = 100000.0

// levelFt converts one AIXM vertical limit to approximate feet, returning
// fallback when it carries no value.
func levelFt(code, val, uom string, fallback float64) float64 {
	switch strings.ToUpper(strings.TrimSpace(code)) {
	case "SFC", "GND":
		return 0
	case "UNL":
		return unlimitedFt
	}
	v, err := strconv.ParseFloat(strings.TrimSpace(val), 64)
	if err != nil {
		return fallback
	}
	switch strings.ToUpper(strings.TrimSpace(uom)) {
	case "FL":
		return v * 100
	case "M":
		return v / 0.3048
	}
	return v
}

// bandsOverlap reports whether two vertical bands share height. Touching bands
// (Strasbourg's SC below FL 115 and SU above it) do not overlap.
func bandsOverlap(loA, hiA, loB, hiB float64) bool {
	return loA < hiB && loB < hiA
}

// interiorSamples returns an area sample of a ring: the points of an n x n
// lattice over its bounding box that fall inside it, the centroid alone if the
// lattice misses (a sliver thinner than one cell).
func interiorSamples(ring [][2]float64, n int) [][2]float64 {
	minLat, maxLat, minLon, maxLon := ringBBox(ring)
	out := make([][2]float64, 0, n*n/2)
	for i := 0; i < n; i++ {
		lat := minLat + (maxLat-minLat)*(float64(i)+0.5)/float64(n)
		for j := 0; j < n; j++ {
			lon := minLon + (maxLon-minLon)*(float64(j)+0.5)/float64(n)
			p := [2]float64{lat, lon}
			if pointInRing(p, ring) {
				out = append(out, p)
			}
		}
	}
	if len(out) == 0 {
		var sumLat, sumLon float64
		for _, p := range ring {
			sumLat += p[0]
			sumLon += p[1]
		}
		out = append(out, [2]float64{sumLat / float64(len(ring)), sumLon / float64(len(ring))})
	}
	return out
}

// coveredShare is the fraction of the sampled points a sector contains.
func coveredShare(samples [][2]float64, s *appSector) float64 {
	inside := 0
	for _, p := range samples {
		if p[0] < s.minLat || p[0] > s.maxLat || p[1] < s.minLon || p[1] > s.maxLon {
			continue
		}
		if pointInRing(p, s.ring) {
			inside++
		}
	}
	return float64(inside) / float64(len(samples))
}
