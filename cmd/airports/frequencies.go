// frequencies.go: turn OurAirports' airport-frequencies.csv into a map of
// airport_ident -> positional frequency rows matching frequencyFields in
// build.go. OurAirports mixes ATC/info services (TWR, GND, APP, ATIS, …)
// with US-centric noise (CTAF, UNIC, CNTR, AWOS, MISC, …); we keep only the
// curated ATC/info set and normalise each type to a canonical label. Pure
// functions, no I/O.

package main

import (
	"strconv"
	"strings"
)

var requiredFrequencyColumns = []string{
	"airport_ident",
	"type",
	"frequency_mhz",
}

// ourairportsFreqLabel maps an OurAirports frequency "type" code to the
// canonical service label shown in the airport panel, and reports whether the
// frequency is kept. Anything not in the table (CTAF, UNIC, CNTR, AWOS, ASOS,
// ARCAL, MF, MISC, OPS, EMR, VFR, A/D, RDO, RCO, FSS, …) is curated out. The
// canonical labels match the FR (cmd/fr) and UK (cmd/uk) overlays so the SPA
// reads one vocabulary across sources; A/G (air-ground) is shown as the French
// A/A (auto-information) like the FR "OTHER" services.
var ourairportsFreqLabel = map[string]string{
	"TWR":  "TWR",
	"GND":  "GND",
	"APP":  "APP",
	"DEP":  "DEP",
	"ATIS": "ATIS",
	"AFIS": "AFIS",
	"A/G":  "A/A",
	"INFO": "INFO",
	"FIS":  "FIS",
	"CLD":  "DEL",
	"DEL":  "DEL",
	"ARR":  "ARR",
}

// parseFrequencies parses airport-frequencies.csv into airport_ident ->
// curated [freq, label, call] triples. Blank/zero frequencies and
// non-allowlisted service types are dropped.
func parseFrequencies(csv string) (map[string][]any, error) {
	if csv == "" {
		return map[string][]any{}, nil
	}
	lines := splitCsvLines(csv)
	if len(lines) < 2 {
		return map[string][]any{}, nil
	}
	header := parseCsvLine(lines[0])
	idx, err := indexHeader(header, requiredFrequencyColumns, "frequencies")
	if err != nil {
		return nil, err
	}
	descIdx, hasDesc := idx["description"]
	maxIdx := maxColumnIndex(idx, requiredFrequencyColumns)

	byIdent := map[string][]any{}
	for _, line := range lines[1:] {
		cells := parseCsvLine(line)
		if len(cells) <= maxIdx {
			continue // short (malformed) row
		}
		ident := cells[idx["airport_ident"]]
		if ident == "" {
			continue
		}
		label, ok := ourairportsFreqLabel[strings.ToUpper(strings.TrimSpace(cells[idx["type"]]))]
		if !ok {
			continue
		}
		freq, ok := cleanFreq(cells[idx["frequency_mhz"]])
		if !ok {
			continue
		}
		call := ""
		if hasDesc && descIdx < len(cells) {
			call = cleanCallSign(cells[descIdx], cells[idx["type"]], label)
		}
		byIdent[ident] = append(byIdent[ident], []any{freq, label, call})
	}
	return byIdent, nil
}

// cleanFreq trims a published MHz value and rejects blank / unparseable /
// non-positive ones. The valid value is returned verbatim (precision is
// preserved; the SPA formats it to three decimals at display time).
func cleanFreq(s string) (string, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", false
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil || v <= 0 {
		return "", false
	}
	return s, true
}

// cleanCallSign returns the description as the spoken call sign, dropping it
// when it is empty or merely repeats the raw type or canonical label (e.g. a
// "TWR" description on a TWR row adds nothing).
func cleanCallSign(desc, rawType, label string) string {
	desc = strings.TrimSpace(desc)
	if desc == "" {
		return ""
	}
	if strings.EqualFold(desc, strings.TrimSpace(rawType)) || strings.EqualFold(desc, label) {
		return ""
	}
	return desc
}
