// csv.go: low-level OurAirports CSV parsing primitives and validation tables.
// Pure functions, no I/O.

package main

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

var requiredSourceColumns = []string{
	"ident",
	"type",
	"name",
	"latitude_deg",
	"longitude_deg",
	"elevation_ft",
	"iso_country",
	"municipality",
	"iata_code",
	"icao_code",
}

var requiredRunwayColumns = []string{
	"airport_ident",
	"length_ft",
	"width_ft",
	"surface",
	"lighted",
	"closed",
	"le_ident",
	"he_ident",
}

// OurAirports assigns synthetic idents of the form XX-NNNN to airports that
// have no official code (no ICAO, no FAA, no local). In practice these are
// ULM / altisurface strips, private ranches, informal hospital helipads, and
// closed airports; the kind of points that clutter the map without adding
// useful context to a NOTAM viewer.
var syntheticIdentRE = regexp.MustCompile(`^[A-Z]{2}-[0-9]+$`)

// Secondary records OurAirports keeps for airports that already have a
// canonical entry under their real ICAO ident; names literally start with
// "(Duplicate)" or "(??Duplicate??)".
var duplicateNameRE = regexp.MustCompile(`^\(\?*[Dd]uplicate`)

var knownTypes = map[string]struct{}{
	"large_airport":  {},
	"medium_airport": {},
	"small_airport":  {},
	"heliport":       {},
	"seaplane_base":  {},
	"balloonport":    {},
	"closed":         {},
}

func isKnownType(t string) bool {
	_, ok := knownTypes[t]
	return ok
}

// parseCsvLine splits one OurAirports CSV line. Handles quoted fields with
// commas and RFC-4180 "" escapes inside quotes. The source has no embedded
// newlines, so line-based parsing is safe.
func parseCsvLine(line string) []string {
	fields := []string{}
	var current strings.Builder
	inQuotes := false
	i := 0
	for i < len(line) {
		ch := line[i]
		switch {
		case inQuotes:
			if ch == '"' {
				if i+1 < len(line) && line[i+1] == '"' {
					current.WriteByte('"')
					i += 2
				} else {
					inQuotes = false
					i++
				}
			} else {
				current.WriteByte(ch)
				i++
			}
		case ch == ',':
			fields = append(fields, current.String())
			current.Reset()
			i++
		case ch == '"' && current.Len() == 0:
			inQuotes = true
			i++
		default:
			current.WriteByte(ch)
			i++
		}
	}
	fields = append(fields, current.String())
	return fields
}

// splitCsvLines normalises CRLF and drops empty lines.
func splitCsvLines(csv string) []string {
	csv = strings.ReplaceAll(csv, "\r\n", "\n")
	raw := strings.Split(csv, "\n")
	out := raw[:0]
	for _, l := range raw {
		if l != "" {
			out = append(out, l)
		}
	}
	return out
}

// maxColumnIndex returns the highest header index among the given columns.
// Data-row loops guard with it: a row shorter than the columns it reads
// (an upstream truncation, or a quoted embedded newline splitting one
// record across lines) must be skipped, not indexed, or cells[idx[...]]
// panics the unattended refresh.
func maxColumnIndex(idx map[string]int, cols []string) int {
	m := -1
	for _, c := range cols {
		if i, ok := idx[c]; ok && i > m {
			m = i
		}
	}
	return m
}

// indexHeader builds a column-name → index map and rejects rows missing any
// required column.
func indexHeader(header []string, required []string, kind string) (map[string]int, error) {
	idx := map[string]int{}
	for i, name := range header {
		idx[name] = i
	}
	for _, col := range required {
		if _, ok := idx[col]; !ok {
			return nil, fmt.Errorf("missing required %s CSV column: %s", kind, col)
		}
	}
	return idx, nil
}

// nullableInt returns nil for empty/unparseable input, an int otherwise.
// Marshals to JSON null vs. integer respectively.
func nullableInt(s string) any {
	if s == "" {
		return nil
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return nil
	}
	return n
}

// positiveInt is nullableInt but also rejects zero/negative; used for runway
// length_ft and width_ft, where 0 means "missing" not "valid".
func positiveInt(s string) any {
	if s == "" {
		return nil
	}
	n, err := strconv.Atoi(s)
	if err != nil || n <= 0 {
		return nil
	}
	return n
}

// boolFlag matches the JS pattern `x === '1' ? 1 : 0`; the on-disk shape uses
// integer 1/0, not JSON booleans.
func boolFlag(s string) int {
	if s == "1" {
		return 1
	}
	return 0
}

// parseRunways turns runways.csv into a map of airport_ident → positional
// runway rows matching runwayFields. Closed runways are excluded.
func parseRunways(csv string) (map[string][]any, error) {
	if csv == "" {
		return map[string][]any{}, nil
	}
	lines := splitCsvLines(csv)
	if len(lines) < 2 {
		return map[string][]any{}, nil
	}
	header := parseCsvLine(lines[0])
	idx, err := indexHeader(header, requiredRunwayColumns, "runways")
	if err != nil {
		return nil, err
	}
	maxIdx := maxColumnIndex(idx, requiredRunwayColumns)
	byIdent := map[string][]any{}
	for _, line := range lines[1:] {
		cells := parseCsvLine(line)
		if len(cells) <= maxIdx {
			continue // short (malformed) row
		}
		if cells[idx["closed"]] == "1" {
			continue
		}
		ident := cells[idx["airport_ident"]]
		if ident == "" {
			continue
		}
		// Trailing eight nils are the AIXM per-direction declared-distance
		// slots (LDA / TORA / TODA / ASDA on each end); populated for
		// France / UK / Spain by the per-country AIXM overlay, null
		// elsewhere.
		entry := []any{
			cells[idx["le_ident"]],
			cells[idx["he_ident"]],
			positiveInt(cells[idx["length_ft"]]),
			positiveInt(cells[idx["width_ft"]]),
			cells[idx["surface"]],
			boolFlag(cells[idx["lighted"]]),
			nil, nil, nil, nil,
			nil, nil, nil, nil,
		}
		byIdent[ident] = append(byIdent[ident], entry)
	}
	return byIdent, nil
}
