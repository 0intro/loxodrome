// airspaces_activite.go reads the third statement of a SIV sub-sector's
// frequency, the one neither the AIXM nor the <Frequence> remarks carry: the
// SIV VOLUME's own <Activite> field in the SIA proprietary XML.
//
//	<Volume lk="[LF][SIV LE BOURGET][.][10]">
//	  <Activite>LE BOURGET INFO#123.835</Activite>
//
// 109 of the 110 SIV volumes carry one (Cayenne names its unit but no
// frequency), and it is keyed to the sub-sector rather than to the unit, which
// is exactly what the AIXM cannot say (docs/siv-frequencies.md). It reaches
// two kinds of row the earlier paths leave wrong:
//
//   - the 18 sub-sectors with NO frequency at all, because the AIXM never
//     Sae-links their FIS service to the airspace and the <Frequence> record
//     carries no "SIV N" remark to key on (LE BOURGET, TOULOUSE, LYON 1-5,
//     PYRENEES, POINTE A PITRE, GENEVE 1-9);
//   - the sub-sectors carrying their whole unit's channel list because nothing
//     said which one is theirs (CLERMONT 1-7, BALE, NICE, RENNES, BASTIA,
//     BEAUVAIS 2).
//
// The field is free text, so the reading is deliberately narrow and every
// application is corroborated by a second published statement: a NARROW only
// removes frequencies the row's own AIXM union already carries, and a FILL
// only writes a frequency the SIA also publishes as a <Frequence> record of
// that same unit's flight information service. A stated value that neither
// corroborates is refused whole, counted, and left to the AIXM.
//
// The join to the AIXM is by name, through the same AIXMSIVByName index
// parseSIA already uses, and the name comes out of the volume's own lk: the
// second bracket is the espace ("SIV LE BOURGET") and the third the partie
// ("." when the SIV has only one). No pk graph and no Espace / Partie decoding
// is needed, which also keeps the reference children those records carry
// (same lk, empty payload) from ever reaching this code.

package main

import (
	"regexp"
	"strconv"
	"strings"
)

// siaActivityVolume is the slice of a SIA <Volume> this file reads. Distinct
// from nature.go's siaVolume, which reads the vertical limits off the same
// element for a different dataset.
type siaActivityVolume struct {
	Lk       string `xml:"lk,attr"`
	Activite string `xml:"Activite"`
}

// activiteFreqRe matches a VHF frequency in an <Activite> text. Anchored at
// both ends so a value cannot start part-way through a longer run of digits.
var activiteFreqRe = regexp.MustCompile(`\b\d{3}[.,]\d{1,3}\b`)

// activiteSuppletiveRe matches the "(s)" that marks the frequency BEFORE it as
// a backup channel (NICE "122.925 / 125.575 (s)", NANTES "130.275 -
// 119.400(s)"), spaced or not. A backup is not the channel a chart prints or a
// pilot sets, the same rule suppletiveRe applies to the <Frequence> remarks.
// The marker is matched exactly: "(1)" in the same position is a FOOTNOTE
// reference, not a demotion (BIARRITZ "PYRENEES INFO 126.525 (1)"), and its
// frequency is the one that makes those rows agree with the AIXM.
var activiteSuppletiveRe = regexp.MustCompile(`^\s*\((?i:s)\)`)

// The VHF air band. A number outside it in this field is not a frequency
// (no such value appears in the corpus; the guard is what keeps a future
// reformat from turning a distance or a level into a channel).
const (
	minVHFMHz = 118.0
	maxVHFMHz = 137.0
)

// activiteFreqs returns the frequency values an <Activite> text states, in
// order, dropping the ones marked supplétive. Lines are separated by the SIA's
// own '#', and by real newlines where the field wraps; each is read on its own
// so a unit's name cannot bind to the next unit's channel.
func activiteFreqs(text string) []string {
	var out []string
	for _, line := range strings.FieldsFunc(text, func(r rune) bool { return r == '#' || r == '\n' || r == '\r' }) {
		for _, loc := range activiteFreqRe.FindAllStringIndex(line, -1) {
			if activiteSuppletiveRe.MatchString(line[loc[1]:]) {
				continue
			}
			raw := strings.ReplaceAll(line[loc[0]:loc[1]], ",", ".")
			v, err := parseFreq(raw)
			if err != nil || v < minVHFMHz || v > maxVHFMHz {
				continue
			}
			out = append(out, raw)
		}
	}
	return out
}

// hasFreqValue reports whether list already carries this frequency VALUE, so
// the same channel written two ways ("135.200" / "135.2") counts once.
func hasFreqValue(list []string, freq string) bool {
	v, err := parseFreq(freq)
	if err != nil {
		return false
	}
	for _, s := range list {
		if w, err := parseFreq(s); err == nil && w == v {
			return true
		}
	}
	return false
}

// activiteSIVKeys turns a SIV volume's lk into the normalised AIXM txtName
// keys to look it up by, or nil when the lk names something else. The espace
// is the second bracket with its type word stripped and the partie the third,
// "." meaning the SIV has only one:
//
//	[LF][SIV LE BOURGET][.][10]        -> "LE BOURGET"
//	[LF][SIV SEINE][1][10]             -> "SEINE 1"
//	[LF][SIV RENNES][SUD partie A][30] -> "RENNES SUD PARTIE A", "RENNES SUD A"
//
// The second key drops the word "partie" / "part", which the SIA writes and
// the AIXM does not ("RENNES SUD A"). Both are tried in order.
func activiteSIVKeys(lk string) []string {
	parts := bracketTokens(lk)
	if len(parts) < 3 {
		return nil
	}
	name := strings.TrimSpace(strings.TrimPrefix(parts[1], "SIV "))
	if name == parts[1] || name == "" {
		return nil // not a SIV espace
	}
	if p := strings.TrimSpace(parts[2]); p != "" && p != "." {
		name += " " + p
	}
	key := normaliseName(name)
	if key == "" {
		return nil
	}
	if elided := normaliseName(activitePartieWordRe.ReplaceAllString(key, " ")); elided != key {
		return []string{key, elided}
	}
	return []string{key}
}

// activitePartieWordRe matches the SIA's "partie" / "part" filler word inside
// a sub-sector name.
var activitePartieWordRe = regexp.MustCompile(`(?i)\bPARTIES?\b|\bPARTS?\b`)

// sameChannel reports whether two published frequency values name the same
// channel. Equal values do, and so does a 25 kHz carrier beside its own 8.33
// channel DESIGNATOR, which is that carrier plus 5 kHz: the SIA writes
// CHAMBERY as "123.700" in the Activite and "123.705" in its <Frequence>
// record, one file, one unit, two conventions. The test is deliberately not a
// +/-5 kHz tolerance, which would merge the genuinely different 8.33 channels
// 118.005 and 118.010: only a value that is itself a multiple of 25 kHz can
// carry a designator, and no 8.33-only channel is.
func sameChannel(a, b float64) bool {
	if a == b {
		return true
	}
	lo, hi := a, b
	if lo > hi {
		lo, hi = hi, lo
	}
	if hi-lo > 0.0051 || hi-lo < 0.0049 {
		return false
	}
	// lo is a whole number of 25 kHz steps (the carrier), hi its designator.
	return int64(lo*1000+0.5)%25 == 0
}

// narrowRadioToStated keeps only the radio entries whose frequency the
// Activite states, and reports whether the two sources AGREE.
//
// They do not unless EVERY stated value is one the row's own AIXM union
// already publishes: the field is free text read by a regexp, and a value the
// AIXM does not corroborate means the reading, not the AIXM, is what to
// distrust. That is what leaves IROISE 3 (which also names LANDIVISIAU's
// 122.400) and any future stray number alone.
//
// Agreement is reported separately from the size of the result on purpose:
// a row whose union the Activite states WHOLE agrees and simply has nothing
// to narrow, and counting that as a refusal would bury the readings that
// genuinely failed among 57 rows where the two sources match exactly. The
// caller applies the result only when it is a real reduction.
func narrowRadioToStated(radio []any, stated []string) ([]any, bool) {
	have := make([]float64, 0, len(radio))
	for _, e := range radio {
		entry, ok := e.([]string)
		if !ok || len(entry) == 0 {
			continue
		}
		if v, err := parseFreq(entry[0]); err == nil {
			have = append(have, v)
		}
	}
	allowed := make(map[float64]bool, len(stated))
	for _, s := range stated {
		v, err := parseFreq(s)
		if err != nil {
			return nil, false
		}
		matched := false
		for _, h := range have {
			if sameChannel(v, h) {
				allowed[h] = true
				matched = true
			}
		}
		if !matched {
			return nil, false
		}
	}
	return filterRadioByFreq(radio, allowed), true
}

// activiteFillEntries turns the stated frequencies into radio entries for a
// sub-sector the earlier paths leave with none, or reports false.
//
// Every value must resolve to a <Frequence> record of the SAME unit's flight
// information service, keyed on (4-letter indicator, frequency): that is the
// second published statement the fill is corroborated by, and it supplies the
// publisher's own unit name and call sign rather than one synthesised from the
// Activite's label. Keying on the pair and not on the unit alone also keeps
// LYON's two records (135.200 for sectors 1-2, 135.530 for 3-5) apart, which a
// unit-keyed lookup could not. A value with no record is not filled: GENEVE's
// 126.350 is a Swiss channel that appears in no French record at all, and it
// rides sivFreqOverrides instead.
func activiteFillEntries(stated []string, indicator string, fis map[string]InjectEntry) ([]InjectEntry, bool) {
	if len(stated) == 0 || indicator == "" {
		return nil, false
	}
	out := make([]InjectEntry, 0, len(stated))
	for _, s := range stated {
		v, err := parseFreq(s)
		if err != nil {
			return nil, false
		}
		e, ok := fis[fisFreqKey(indicator, v)]
		if !ok {
			return nil, false
		}
		out = append(out, e)
	}
	return out, true
}

// fisFreqKey keys the flight-information-service frequency index by the unit's
// 4-letter location indicator and the frequency in whole kHz, so the SIA's own
// "135.200" and a "135.2" elsewhere land on one entry.
func fisFreqKey(indicator string, freq float64) string {
	return indicator + "|" + strconv.FormatInt(int64(freq*1000+0.5), 10)
}

// sivIndicator is the 4-letter location indicator a SIV codeId is filed
// under: "LFPBFS" -> "LFPB", "LSAGFS01" -> "LSAG", "TFFRFS" -> "TFFR". It is
// what a SIA service link's own stem (stemFromLk) is compared against.
func sivIndicator(codeId string) string {
	if len(codeId) < 4 {
		return ""
	}
	return codeId[:4]
}
