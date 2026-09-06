// airspaces_sia.go decodes the SIA proprietary XML (XML_SIA_<date>.xml),
// the second member of the SIA zip alongside the AIXM 4.5 export. The AIXM
// doesn't carry per-sub-sector frequency assignment, and for several SIVs it
// never Sae-links the serving frequency to the SIV airspace at all (orphaned
// or mis-linked services: Iroise 119.575, Toulouse, Provence, …). The
// proprietary XML closes both gaps: its <Frequence>/<Remarque> annotations
// name the SIV sub-sector each frequency serves ("Information/Radar SIV N",
// "Secteur/Sector XX (SIV N)"). parseSIA turns those into SectorEntries, a
// sub-sector codeId → []InjectEntry map that resolveRadio uses to both
// narrow buildSIVRadio's stem-wide union down to the frequencies that
// actually serve the sub-sector AND augment it with the ones the AIXM
// missed. sivFreqOverrides hand-fills the few sub-sectors the SIA leaves
// untagged (Beauvais 1, worked on the approach but published only on the
// SIV chart).
//
// The same per-sub-sector tags exist for approach-controlled TMA parts: an
// "[APP <centre> Approche]" service whose <Remarque> reads "Secteur/Sector XX
// (TMA <NAME> 1/5/6)" works those numbered TMA parts on one control frequency,
// while the AIXM hangs every approach frequency off a single untagged service
// (so each part's Sae union carries all of them). parseSIA resolves each tagged
// part to its AIXM codeId by name (TMA part codeIds keep the decimal dot,
// "LFPM7.1", where SIV uses a "P", so name resolution is the reliable map) and
// feeds the same SectorEntries; resolveRadio narrows the part's AIXM union the
// same way it narrows a SIV. Only the clean parenthesised form is taken: prose
// ("Contrôle en TMA", "TMA de LORIENT") and the overseas "TMA NOUMEA partie 1.1
// NAME" form (a word between name and number) contribute nothing.
//
// Seine is the only unit that names its TMA parts that way. Everywhere else the
// remark names the CONTROL SECTOR instead ("Secteur QW-Contrôle en TMA",
// "Secteurs/Sectors BE 1 et/and 2", "Secteur d'approche FA"), and those sectors
// are published airspaces in their own right, so the parts they work can be
// reached through their geometry: sectorNameRe / expandSectorNames collect the
// names into APPSectorFreqs and airspaces_sectors.go does the join.

package main

import (
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"
)

// SIAPlan is everything build.go needs from the SIA proprietary XML:
//
//   - SectorEntries maps each sub-sector codeId to the [freq, unit,
//     callsign] triples the SIA explicitly assigns to it. SIV keys come from
//     the "Information/Radar SIV N" / "Secteur/Sector XX (SIV N)" Remarque
//     pattern; TMA-part keys (e.g. "LFPM5") come from the parallel
//     "Secteur/Sector XX (TMA <NAME> N)" approach-service pattern. resolveRadio
//     narrows the AIXM union to these frequencies (Lille, Strasbourg, Seine SIV
//     and the Seine TMA sectors) AND augments it with any the AIXM never linked
//     (Iroise 119.575, Provence, Montpellier, Nantes, …). FIS records win over
//     APP records for the same SIV sub-sector, so a SIV with its own Information
//     frequency is never polluted by the overlying approach sector's control
//     frequency. sivFreqOverrides seeds the same map for sub-sectors the SIA
//     leaves untagged.
//
//   - InjectFreqs is the "inject mode" entries used when the AIXM has no Sae
//     linking the SIV to its FIS service and the SIA tags it only by cardinal
//     SecteurSituation (Paris, Marseille). The keys are SIV codeIds resolved
//     via the AIXM txtName index passed into parseSIA.
//
// A SIA Frequence record feeds SectorEntries when its Remarque carries the
// "SIV N" pattern and InjectFreqs when its SecteurSituation field is set; a
// few records (Provence) carry both, and resolveRadio prefers the more
// precise SectorEntries.
//
//   - StemDropFreqs maps each SIV codeId stem (e.g. "LFSBFS") to the
//     frequency values an untagged sub-sector of that stem must NOT carry:
//     the ones the SIA attributes to a specific numbered sector ("SIV N"), a
//     backup role ("Supplétive"), or a delegation ("espaces délégués").
//     resolveRadio drops these from an untagged sub-sector's stem-wide union so
//     it keeps only the general Information frequencies, never trimming to
//     empty. Bâle and Strasbourg 1/2 (no per-sub-sector "SIV N" tag) are the
//     current beneficiaries.
//
//   - APPSectorFreqs maps an approach control sector to the frequencies worked
//     on it, keyed "<unit stem>|<SECTOR NAME>" ("LFQQ|QW", "LFBD|BE 1"). The
//     names come from the "Secteur(s)/Sector(s) <list>" Remarque form, which is
//     how the SIA states the assignment for most units; airspaces_sectors.go
//     joins them to the sectors' own published geometry to reach the TMA parts
//     each one works. A key with no number ("LFMT|FA") is a family reference
//     covering that family's numbered sectors.
type SIAPlan struct {
	SectorEntries  map[string][]InjectEntry
	InjectFreqs    map[string][]InjectEntry
	StemDropFreqs  map[string][]string
	APPSectorFreqs map[string][]InjectEntry
}

// sivFreqOverrides hand-maps SIV sub-sectors the SIA frequency XML leaves
// without a "SIV N" tag, so neither the AIXM Sae chain nor parseSIA can reach
// the right frequency. These are the approach-rendered sectors whose
// per-sub-sector assignment is published only on the SIV chart. Keep the list
// short and source each entry from the chart.
//
// Beauvais 1 (West) is worked by BEAUVAIS Approche 123.985, but the SIA tags
// 123.985 only as "Secteurs WEST et EAST" and leaves the FIS 119.800
// untagged, so the data-driven path otherwise gives Beauvais 1 the auxiliary
// 119.800. Beauvais 2 (East) correctly stays on 119.800 (no override).
var sivFreqOverrides = map[string][]InjectEntry{
	"LFOBFS1": {{Freq: "123.985", Unit: "APP BEAUVAIS Approche", Callsign: "BEAUVAIS - APPROCHE"}},
}

// InjectEntry is the SIA-derived [freq, unit, callsign] triple to inject
// into a SIV row that has no AIXM-side frequency data. Shape matches the
// existing AIXM-derived radio entries built by buildRadio.
type InjectEntry struct {
	Freq, Unit, Callsign string
}

// AIXMSIVByName indexes the AIXM SIV airspaces by normalised txtName for
// the SIA→AIXM join. Multiple codeIds can share a name (Marseille has
// LFMMFSN / LFMMFSN1 / LFMMFSN2 all titled "MARSEILLE NORD" as vertical
// subdivisions). Keys are upper-cased and space-collapsed.
type AIXMSIVByName map[string][]string

// AIXMTMAByName indexes the AIXM TMA airspace parts by normalised txtName
// ("SEINE 5" → ["LFPM5"]) for the SIA→AIXM join. parseSIA uses it to resolve
// the "TMA <NAME> <parts>" approach-remark tags to concrete codeIds. Resolving
// by name (not by constructing the codeId) is deliberate: TMA part codeIds keep
// the decimal dot ("LFPM7.1") where the SIV codeId uses a "P" ("…FS7P1"), so
// only the AIXM itself reliably maps a part number to its codeId. Keys are
// upper-cased and space-collapsed.
type AIXMTMAByName map[string][]string

// parseSIA reads the SIA proprietary XML and produces the sector and inject
// plans. aixmSIVByName is the AIXM-side lookup used to resolve directional
// SecteurSituation tags ("NORD", "SUD", "OUEST") to concrete SIV codeIds via
// "{centre} {direction}" name matching; aixmTMAByName resolves the
// "TMA <NAME> N" approach tags to TMA part codeIds via "{name} {part}"
// matching. Both FIS and APP services are scanned for "SIV N" Remarque tags;
// FIS wins per sub-sector so a SIV's own Information frequency is preferred over
// the overlying approach sector's control frequency. APP services are also
// scanned for "TMA <NAME> N" tags. sivFreqOverrides is merged last, for the
// untagged stragglers, and so applies even when src is empty.
func parseSIA(src []byte, aixmSIVByName AIXMSIVByName, aixmTMAByName AIXMTMAByName) (SIAPlan, error) {
	plan := SIAPlan{
		SectorEntries:  map[string][]InjectEntry{},
		InjectFreqs:    map[string][]InjectEntry{},
		StemDropFreqs:  map[string][]string{},
		APPSectorFreqs: map[string][]InjectEntry{},
	}
	// FIS- and APP-derived sector entries are collected separately so FIS can
	// take precedence per sub-sector when both tag the same one. TMA part
	// entries live in their own map (disjoint codeId namespace from the SIV
	// "…FS…" keys, no FIS/APP contest since only APP controls a TMA).
	fisByCode := map[string][]InjectEntry{}
	appByCode := map[string][]InjectEntry{}
	tmaByCode := map[string][]InjectEntry{}
	if len(src) > 0 {
		dec := xml.NewDecoder(bytes.NewReader(src))
		// The SIA proprietary XML ships as ISO-8859-1 (Latin-1); needed for
		// the "à/to" range markers and SIV names with French diacritics. Go's
		// encoding/xml has no built-in non-UTF-8 support, so register a small
		// converter rather than pulling in golang.org/x/text/encoding.
		dec.CharsetReader = newCharsetReader
		for {
			tok, err := dec.Token()
			if err == io.EOF {
				break
			}
			if err != nil {
				return plan, fmt.Errorf("reading SIA XML: %w", err)
			}
			se, ok := tok.(xml.StartElement)
			if !ok || se.Name.Local != "Frequence" {
				continue
			}
			var f siaFreq
			if err := dec.DecodeElement(&f, &se); err != nil {
				return plan, fmt.Errorf("decoding Frequence: %w", err)
			}
			lk := f.Service.Lk
			isFIS := strings.Contains(lk, "[FIS ")
			isAPP := strings.Contains(lk, "[APP ")
			if !isFIS && !isAPP {
				continue // TWR / VDF / ATIS / A-A never render a SIV
			}
			freq := strings.TrimSpace(f.Frequence)
			if freq == "" {
				continue
			}
			// Inject path (FIS only): cardinal SecteurSituation
			// (Paris/Marseille). Resolve to AIXM codeIds via "{centre}
			// {direction}" txtName matching and synthesise a radio triple
			// from the SIA data alone. A record can carry both a
			// SecteurSituation and a numbered tag (Provence), so this does
			// not short-circuit the sector path below; resolveRadio prefers
			// the more precise SectorEntries when both land on a codeId.
			if isFIS {
				if direction := strings.TrimSpace(f.SecteurSituation); direction != "" {
					if centre := centreFromLk(lk); centre != "" {
						key := normaliseName(centre + " " + direction)
						entry := InjectEntry{
							Freq:     freq,
							Unit:     "FIS " + centre + " Information",
							Callsign: centre + " - INFORMATION",
						}
						// No match (e.g. PROVENCE Vitrolles) leaves the range
						// empty and contributes nothing.
						for _, codeId := range aixmSIVByName[key] {
							plan.InjectFreqs[codeId] = append(plan.InjectFreqs[codeId], entry)
						}
					}
				}
			}
			unit, callsign := lkUnitCallsign(lk)
			// TMA sector path (APP only): an approach service whose Remarque
			// tags numbered TMA parts ("Secteur/Sector SJ (TMA SEINE 1/5/6)")
			// works those parts on this control frequency. Each part resolves
			// to its AIXM codeId by name, so only real TMA parts land an entry;
			// prose "Contrôle en TMA" / "TMA de LORIENT" and the overseas
			// "partie N NAME" form resolve to nothing. APP-only keeps an
			// information service that happens to name a TMA from moving a TMA
			// part onto an FIS frequency.
			if isAPP {
				for _, ts := range expandTMASectorList(f.Remarque) {
					key := normaliseName(ts.name + " " + ts.part)
					entry := InjectEntry{Freq: freq, Unit: unit, Callsign: callsign}
					for _, codeId := range aixmTMAByName[key] {
						tmaByCode[codeId] = append(tmaByCode[codeId], entry)
					}
				}
			}
			// Control-sector path (APP only): the sector names the remark
			// gives this frequency, for the geometric join in
			// airspaces_sectors.go. A backup channel is not the one a chart
			// prints or a pilot sets, so a "supplétive" record is skipped
			// even when it names sectors (Lille 125.500 "Secteurs QW QE").
			if isAPP && !suppletiveRe.MatchString(f.Remarque) {
				if stem := stemFromLk(lk); stem != "" {
					entry := InjectEntry{Freq: freq, Unit: unit, Callsign: callsign}
					for _, name := range expandSectorNames(f.Remarque) {
						key := stem + "|" + name
						if !hasFreq(plan.APPSectorFreqs[key], freq) {
							plan.APPSectorFreqs[key] = append(plan.APPSectorFreqs[key], entry)
						}
					}
				}
			}
			// Sector path (FIS and APP): "Information/Radar SIV N" /
			// "Secteur/Sector XX (SIV N)".
			stem := stemFromLk(lk)
			if stem == "" {
				continue
			}
			sectors := expandSectorList(f.Remarque)
			// A frequency the SIA attributes to a specific numbered sector, a
			// backup role or a delegation is not a general Information frequency:
			// record it against the SIV stem so resolveRadio can drop it from
			// that stem's UNTAGGED sub-sectors (the tagged ones take the
			// SectorEntries branch and keep it). TMA-only remarks yield no SIV
			// sector here, so they never enter the SIV drop set. Only the FIS
			// service defines a SIV's frequency roles: an APP record can carry a
			// "supplétive"/delegated note about its own approach role for a
			// frequency that is the SIV sector's primary one (Nouméa 128.300 is
			// the SIV SUD sector on FIS yet an auxiliary TMA frequency on APP),
			// so classifying APP here would wrongly drop it.
			if isFIS && (len(sectors) > 0 || suppletiveRe.MatchString(f.Remarque) || delegatedRe.MatchString(f.Remarque)) {
				sivKey := stem + "FS"
				plan.StemDropFreqs[sivKey] = append(plan.StemDropFreqs[sivKey], freq)
			}
			for _, sec := range sectors {
				suffix := sectorToSuffix(sec)
				if suffix == "" {
					continue
				}
				codeId := stem + "FS" + suffix
				entry := InjectEntry{Freq: freq, Unit: unit, Callsign: callsign}
				if isFIS {
					fisByCode[codeId] = append(fisByCode[codeId], entry)
				} else {
					appByCode[codeId] = append(appByCode[codeId], entry)
				}
			}
		}
	}
	// FIS wins; APP only fills sub-sectors with no FIS tag (the overlying
	// approach frequency is the SIV frequency only where there is no dedicated
	// Information one).
	for codeId, entries := range fisByCode {
		plan.SectorEntries[codeId] = entries
	}
	for codeId, entries := range appByCode {
		if _, ok := plan.SectorEntries[codeId]; !ok {
			plan.SectorEntries[codeId] = entries
		}
	}
	// TMA part entries use a disjoint codeId namespace (no "FS"), so a plain
	// merge can't collide with the SIV keys above.
	for codeId, entries := range tmaByCode {
		plan.SectorEntries[codeId] = entries
	}
	// Hand overrides win over everything, and apply even with no SIA source.
	for codeId, entries := range sivFreqOverrides {
		plan.SectorEntries[codeId] = entries
	}
	return plan, nil
}

// lkUnitCallsign turns a SIA Service.lk third bracket into the [unit,
// callsign] pair matching the AIXM-derived radio shape. "[LF][RB][FIS IROISE
// Information][…]" → ("FIS IROISE Information", "IROISE - INFORMATION");
// "[LF][OB][APP BEAUVAIS Approche][…]" → ("APP BEAUVAIS Approche",
// "BEAUVAIS - APPROCHE"). Returns ("", "") when the bracket is missing.
func lkUnitCallsign(lk string) (unit, callsign string) {
	parts := bracketTokens(lk)
	if len(parts) < 3 {
		return "", ""
	}
	b3 := strings.TrimSpace(parts[2])
	toks := strings.Fields(b3)
	if len(toks) < 2 {
		return b3, ""
	}
	centre := strings.Join(toks[1:len(toks)-1], " ")
	word := toks[len(toks)-1]
	return b3, strings.ToUpper(centre) + " - " + strings.ToUpper(word)
}

// siaFreq mirrors enough of the SIA Frequence XML record to extract the
// service identity (via lk attribute), the leaf frequency value, the
// optional cardinal-direction sector tag, and the human-readable remark.
type siaFreq struct {
	Service struct {
		Lk string `xml:"lk,attr"`
	} `xml:"Service"`
	Frequence        string `xml:"Frequence"`
	SecteurSituation string `xml:"SecteurSituation"`
	Remarque         string `xml:"Remarque"`
}

// centreFromLk extracts the centre name from the SIA Service.lk's third
// bracket. "[LF][QQ][FIS LILLE Information]" → "LILLE";
// "[LF][FIR PARIS][FIS PARIS Information]" → "PARIS". Robust across the
// inconsistent middle-bracket conventions (a 2-letter code for most
// centres, a "FIR <name>" string for the two ACC-managed FIRs).
func centreFromLk(lk string) string {
	parts := bracketTokens(lk)
	if len(parts) < 3 {
		return ""
	}
	s := parts[2]
	s = strings.TrimPrefix(s, "FIS ")
	s = strings.TrimSuffix(s, " Information")
	return strings.TrimSpace(s)
}

// normaliseName uppercases and collapses runs of whitespace so SIA-side
// composition matches AIXM-side txtName lookup robustly.
func normaliseName(s string) string {
	return strings.Join(strings.Fields(strings.ToUpper(s)), " ")
}

// stemFromLk pulls the ICAO state + ATC-centre code out of a SIA
// service-link string. "[LF][QQ][FIS LILLE Information]" → "LFQQ".
// Returns "" if the format is unexpected.
func stemFromLk(lk string) string {
	parts := bracketTokens(lk)
	if len(parts) < 2 {
		return ""
	}
	return parts[0] + parts[1]
}

// bracketTokens splits a "[a][b][c…]" string into ["a", "b", "c…"].
// Trailing or unbracketed text is ignored. Empty brackets collapse.
func bracketTokens(s string) []string {
	var out []string
	for {
		i := strings.Index(s, "[")
		if i < 0 {
			return out
		}
		j := strings.Index(s[i+1:], "]")
		if j < 0 {
			return out
		}
		out = append(out, s[i+1:i+1+j])
		s = s[i+1+j+1:]
	}
}

// sivRe matches the "SIV <list>" tail of a Remarque. The leading
// "Information/Radar" prefix is optional so that "Sector SIV 2" or bare
// "SIV 2" also parse, and an optional centre word is skipped so the
// name-embedded "SIV IROISE 2" form matches too. expandSectorListLine uses
// FindAll so a line with several "SIV" tokens ("SIV 1 et/and SIV 4")
// yields every sector.
var sivRe = regexp.MustCompile(`(?i)SIV\s+(?:\p{L}+\s+)?([\d.\s,etandàto/]+)`)

// suppletiveRe and delegatedRe classify a SIV Information frequency's Remarque
// as a non-general role. suppletiveRe catches the SIA "Supplétive sur
// instruction ATC" backup frequencies (Bâle 129.250); delegatedRe catches the
// ones dedicated to delegated airspaces (Bâle 134.680, "espaces délégués
// Zürich"). Both are dropped from a stem's untagged sub-sectors so those keep
// only the primary Information frequencies. English spellings included so a
// future bilingual remark still classifies.
var suppletiveRe = regexp.MustCompile(`(?i)suppl[eé]tive|supplement`)
var delegatedRe = regexp.MustCompile(`(?i)d[eé]l[eé]gu|delegat`)

// expandSectorList parses the sector portion of a Remarque and returns
// the individual SIV labels. Multi-line remarques split on '#' (SIA's
// in-line separator) are processed independently; "SIV 2.1#SIV 4"
// yields ["2.1", "4"]. Examples:
//
//	"Information/Radar SIV 1"                     → ["1"]
//	"Information/Radar SIV 3 et/and 5"            → ["3", "5"]
//	"Information/Radar SIV 4.1 et/and 4.2"        → ["4.1", "4.2"]
//	"Information/Radar SIV 6.1 à/to 6.4"          → ["6.1","6.2","6.3","6.4"]
//	"Secteur SJ (SIV 1/2/3)."                     → ["1", "2", "3"]
//	"SIV 2.1#SIV 4"                               → ["2.1", "4"]
//
// Unrecognised tokens are silently dropped; the empty / partial list
// keeps the buildSIVRadio fallback engaged in build.go.
func expandSectorList(remarque string) []string {
	var out []string
	for _, line := range strings.Split(remarque, "#") {
		out = append(out, expandSectorListLine(line)...)
	}
	return out
}

func expandSectorListLine(line string) []string {
	var out []string
	for _, m := range sivRe.FindAllStringSubmatch(line, -1) {
		out = append(out, expandSectorTail(m[1])...)
	}
	return out
}

// tmaSector is one resolved "TMA <name> <part>" reference from an approach
// Remarque: name "SEINE", part "5" → AIXM txtName "SEINE 5".
type tmaSector struct{ name, part string }

// tmaRe matches a "TMA <NAME> <list>" reference where the number list follows
// the name immediately, e.g. the SEINE form "Secteur/Sector SJ (TMA SEINE
// 1/5/6)". Requiring the list right after a single-word name keeps prose
// mentions ("Contrôle en TMA.", "TMA de LORIENT") and the overseas
// "TMA NOUMEA partie 1.1 …" form (a word between name and number) from
// matching. The list class mirrors sivRe so the et/and, à/to and '/'
// separators expand the same way.
var tmaRe = regexp.MustCompile(`(?i)\bTMA\s+(\p{L}[\p{L}'-]*)\s+([\d.\s,etandàto/]+)`)

// expandTMASectorList parses an approach Remarque into the individual
// (name, part) pairs it tags. Multi-line remarques split on '#' are processed
// independently. Each pair still has to resolve against the AIXM TMA name
// index in parseSIA, which is what guarantees only real TMA parts contribute.
func expandTMASectorList(remarque string) []tmaSector {
	var out []tmaSector
	for _, line := range strings.Split(remarque, "#") {
		for _, m := range tmaRe.FindAllStringSubmatch(line, -1) {
			name := strings.TrimSpace(m[1])
			for _, part := range expandSectorTail(m[2]) {
				out = append(out, tmaSector{name: name, part: part})
			}
		}
	}
	return out
}

// sectorNameRe matches a "Secteur(s)/Sector(s) <list>" reference and captures
// the list: "Secteur QW-Contrôle en TMA" → "QW", "Secteurs/Sectors BE 1 et/and
// 2." → "BE 1 et/and 2", "Secteurs AW 1 à 4." → "AW 1 à 4", "Secteurs QW QE" →
// "QW QE", "Secteur d'approche FA (REF ENR 2.2)" → "FA". The separator
// vocabulary sits INSIDE the capture class, as in sivRe, so an accented range
// is not cut in half. Sector names are matched case-SENSITIVELY (the published
// names are upper-case) while the leading word is not: that is what stops the
// lowercase prose around them from being read as a name in "secteur SU /
// sector SU" or "Secteur NORD/NORTH sector". A capture that names no published
// sector resolves to nothing in airspaces_sectors.go, so prose forms like
// "Secteur EST" (Strasbourg publishes RE / RW) are inert rather than wrong.
var sectorNameRe = regexp.MustCompile(
	`(?i:\b(?:secteurs?|sectors?)\b(?:\s*/\s*(?:secteurs?|sectors?))?(?:\s+d['’]approche)?)\s+` +
		`((?:[A-Z][A-Z0-9]*|\d+)(?:(?:\s*(?:à/to|a/to|à|et/and|et|and|/|,)\s*|\s+)(?:[A-Z][A-Z0-9]*|\d+))*)`)

// sectorRangeRe matches one normalised "lo..hi" piece of a sector list, with
// the family name optional on either side ("AW 1..4", "MAC 1..10", "1..3").
var sectorRangeRe = regexp.MustCompile(`^(?:([A-Z][A-Z0-9]*)\s+)?(\d+)\.\.(?:([A-Z][A-Z0-9]*)\s+)?(\d+)$`)

// sectorSepSpaceRe absorbs the spaces a normalised delimiter inherits from the
// words it replaced ("MAC 1 .. 10" -> "MAC 1..10", "BE 1 , 2" -> "BE 1,2").
var sectorSepSpaceRe = regexp.MustCompile(`\s*(\.\.|,)\s*`)

// expandSectorNames parses an approach Remarque into the control-sector names
// it cites, in AIXM txtName form ("BE 1", "QW", "MAC 7"). Multi-line remarques
// split on '#' are processed independently, and the family carries across a
// list so "Secteurs/Sectors BE 1 et/and 2" yields both parts. A name cited
// without a number ("Secteur d'approche FA") is returned bare and matches that
// family's numbered sectors in airspaces_sectors.go.
func expandSectorNames(remarque string) []string {
	var out []string
	for _, line := range strings.Split(remarque, "#") {
		for _, m := range sectorNameRe.FindAllStringSubmatch(line, -1) {
			out = append(out, expandSectorNameList(m[1])...)
		}
	}
	return out
}

// expandSectorNameList turns one captured list into its sector names.
func expandSectorNameList(list string) []string {
	// Normalise the multi-word separators into single delimiters, in the same
	// order as expandSectorTail: the ranges before the bare '/' pass. The
	// spaces around a delimiter go with it, so "MAC 1 à/to 10" reads as one
	// range piece and not as the two ends with a stray ".." between them.
	norm := strings.Join(strings.Fields(list), " ")
	for _, sep := range []string{"à/to", "a/to", "à"} {
		norm = strings.ReplaceAll(norm, sep, "..")
	}
	for _, sep := range []string{"et/and", " et ", " and "} {
		norm = strings.ReplaceAll(norm, sep, ",")
	}
	norm = strings.ReplaceAll(norm, "/", ",")
	norm = sectorSepSpaceRe.ReplaceAllString(norm, "$1")

	var out []string
	family := ""
	for _, piece := range strings.Split(norm, ",") {
		piece = strings.TrimSpace(piece)
		if m := sectorRangeRe.FindStringSubmatch(piece); m != nil {
			name := firstNonEmpty(m[1], m[3], family)
			lo, hi := atoiSafe(m[2]), atoiSafe(m[4])
			// The 64-sector ceiling keeps a mis-parsed range ("FL 075..115")
			// from spraying names; the largest real family has 10 sectors.
			if name != "" && lo >= 1 && hi >= lo && hi-lo < 64 {
				family = name
				for n := lo; n <= hi; n++ {
					out = append(out, fmt.Sprintf("%s %d", family, n))
				}
			}
			continue
		}
		// A piece is a run of names and numbers ("BE 1", "QW QE", "3"): each
		// name sets the family, each number qualifies the family before it.
		toks := strings.Fields(piece)
		for i := 0; i < len(toks); i++ {
			switch tok := toks[i]; {
			case isSectorFamily(tok):
				family = tok
				if i+1 < len(toks) && looksLikeSectorNumber(toks[i+1]) {
					out = append(out, family+" "+toks[i+1])
					i++
					continue
				}
				out = append(out, family)
			case looksLikeSectorNumber(tok) && family != "":
				out = append(out, family+" "+tok)
			}
		}
	}
	return out
}

// isSectorFamily reports whether s is an upper-case sector name or family
// ("QW", "MAC", "WEST", "B2"). Digits may follow letters but never lead, so a
// bare part number is not mistaken for a name. Two letters is the floor: every
// published French approach sector carries at least two, and the initial of a
// capitalised prose word ("Secteur Albi" -> "A") is not a sector.
func isSectorFamily(s string) bool {
	if len(s) < 2 || !(s[0] >= 'A' && s[0] <= 'Z') {
		return false
	}
	for _, r := range s {
		if !(r >= 'A' && r <= 'Z') && !(r >= '0' && r <= '9') {
			return false
		}
	}
	return true
}

// looksLikeSectorNumber reports whether s is a plain sector number.
func looksLikeSectorNumber(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func atoiSafe(s string) int {
	v, err := strconv.Atoi(s)
	if err != nil {
		return 0
	}
	return v
}

// hasFreq reports whether entries already carry this frequency value. A remark
// naming the same sector on both its French and English line ("Secteur
// QW-Contrôle en TMA.#Secteur/Sector QW (SIV 2).") must not double the entry.
func hasFreq(entries []InjectEntry, freq string) bool {
	for _, e := range entries {
		if e.Freq == freq {
			return true
		}
	}
	return false
}

// expandSectorTail turns one "SIV <tail>" capture into its sector labels.
func expandSectorTail(tail string) []string {
	tail = strings.TrimSpace(tail)
	// Normalise the multi-word separators into single delimiters. Order
	// matters: "à/to" and "et/and" must be replaced before the bare '/'
	// pass, otherwise their slashes get half-tokenised.
	norm := tail
	norm = strings.ReplaceAll(norm, "à/to", "..")
	norm = strings.ReplaceAll(norm, "et/and", ",")
	norm = strings.ReplaceAll(norm, " et ", ",")
	norm = strings.ReplaceAll(norm, " and ", ",")
	// Bare '/' between sector numbers (e.g. "SIV 4/5", "SIV 1/2/3") is
	// the most common form in parenthesised secteur lists.
	norm = strings.ReplaceAll(norm, "/", ",")
	// Now split into pieces by comma; each piece is either a single
	// sector number or a "lo..hi" range.
	var out []string
	for _, piece := range strings.Split(norm, ",") {
		piece = strings.TrimSpace(piece)
		piece = strings.TrimRight(piece, ".") // "4.1." → "4.1"; "1." → "1"
		if piece == "" {
			continue
		}
		if strings.Contains(piece, "..") {
			r := expandRange(piece)
			out = append(out, r...)
			continue
		}
		if !looksLikeSector(piece) {
			continue
		}
		out = append(out, piece)
	}
	return out
}

// looksLikeSector returns true if s is a plain number or N.x form.
func looksLikeSector(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if !(r >= '0' && r <= '9') && r != '.' {
			return false
		}
	}
	return true
}

// expandRange turns a "lo..hi" sector range into the individual sector
// numbers in between. The step is 1 for whole-number ranges and 0.1
// for decimal-sub ones ("6.1 à/to 6.4" → 6.1, 6.2, 6.3, 6.4). Mixed-
// granularity ranges (rare) default to 0.1 to be safe.
func expandRange(s string) []string {
	parts := strings.SplitN(s, "..", 2)
	if len(parts) != 2 {
		return nil
	}
	lo, err1 := strconv.ParseFloat(strings.TrimSpace(parts[0]), 64)
	hi, err2 := strconv.ParseFloat(strings.TrimSpace(parts[1]), 64)
	if err1 != nil || err2 != nil || hi < lo {
		return nil
	}
	step := 1.0
	if strings.Contains(parts[0], ".") || strings.Contains(parts[1], ".") {
		step = 0.1
	}
	var out []string
	for v := lo; v <= hi+1e-9; v += step {
		out = append(out, formatSector(v))
	}
	return out
}

// formatSector renders a sector number back as the user-visible string:
// integers without a fraction, sub-sectors with a single decimal place.
func formatSector(v float64) string {
	rounded := float64(int64(v*10+0.5)) / 10
	if rounded == float64(int64(rounded)) {
		return strconv.FormatInt(int64(rounded), 10)
	}
	return strconv.FormatFloat(rounded, 'f', 1, 64)
}

// newCharsetReader is the CharsetReader plug for the SIA proprietary XML.
// Only ISO-8859-1 / Latin-1 are needed in practice; UTF-8 is passed through.
// Other charsets are rejected so unexpected SIA reformats fail loud.
func newCharsetReader(charset string, input io.Reader) (io.Reader, error) {
	c := strings.ToLower(strings.TrimSpace(charset))
	switch c {
	case "", "utf-8", "utf8":
		return input, nil
	case "iso-8859-1", "latin1", "latin-1", "iso8859-1":
		raw, err := io.ReadAll(input)
		if err != nil {
			return nil, err
		}
		// Latin-1 → UTF-8: bytes 0x00-0x7F unchanged; 0x80-0xFF expand to
		// two-byte UTF-8 (0xC0|hi6, 0x80|lo6). Pre-size to avoid Grow churn.
		buf := make([]byte, 0, len(raw)+len(raw)/4)
		for _, b := range raw {
			if b < 0x80 {
				buf = append(buf, b)
			} else {
				buf = append(buf, 0xC0|(b>>6), 0x80|(b&0x3F))
			}
		}
		return bytes.NewReader(buf), nil
	}
	return nil, fmt.Errorf("unsupported SIA charset %q", charset)
}

// sectorToSuffix converts a sector label to the AIXM codeId suffix:
// "1" → "1", "4.1" → "4P1". Returns "" for unparseable input.
func sectorToSuffix(label string) string {
	label = strings.TrimSpace(label)
	if label == "" {
		return ""
	}
	if i := strings.Index(label, "."); i >= 0 {
		whole := label[:i]
		sub := label[i+1:]
		if whole == "" || sub == "" {
			return ""
		}
		return whole + "P" + sub
	}
	return label
}
