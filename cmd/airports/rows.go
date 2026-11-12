// rows.go: turn an OurAirports CSV string into the positional rows the browser
// consumes. The output shape mirrors outputFields in build.go; access /
// military / vfr / ifr slots come back as their zero values and are filled in
// later by the AIXM overlay.

package main

import (
	"fmt"
	"math"
	"sort"
	"strconv"

	"github.com/0intro/loxodrome/internal/aip"
)

// parsedRows carries everything parseRowsFromCsv produces. Returned by value;
// the caller passes it on to overlay + meta steps.
type parsedRows struct {
	rows         []any
	rawRowCount  int
	shortRows    int
	unknownTypes []string
}

// parseRowsFromCsv parses airports.csv, drops uncoded / duplicate / invalid
// rows, and emits one positional row per kept airport. The sanity window
// (minRows..maxRows) guards against an upstream schema break silently
// shrinking or ballooning the dataset.
func parseRowsFromCsv(csv string, runways, frequencies map[string][]any, minRows, maxRows int) (parsedRows, error) {
	lines := splitCsvLines(csv)
	if len(lines) < 2 {
		return parsedRows{}, fmt.Errorf("CSV contains fewer than 2 non-empty lines")
	}
	header := parseCsvLine(lines[0])
	idx, err := indexHeader(header, requiredSourceColumns, "")
	if err != nil {
		return parsedRows{}, err
	}

	// Rows shorter than the columns buildRowFromCsv reads would panic on
	// cells[idx[...]]; skip and count them so the meta surfaces the drift.
	maxIdx := maxColumnIndex(idx, requiredSourceColumns)
	unknownTypes := map[string]struct{}{}
	rows := []any{}
	rawRowCount := 0
	shortRows := 0
	for _, line := range lines[1:] {
		cells := parseCsvLine(line)
		if len(cells) <= maxIdx {
			shortRows++
			continue
		}
		row, ok := buildRowFromCsv(cells, idx, runways, frequencies, unknownTypes)
		if !ok {
			continue
		}
		rawRowCount++
		if row == nil {
			continue
		}
		rows = append(rows, row)
	}

	if rawRowCount < minRows || rawRowCount > maxRows {
		return parsedRows{}, fmt.Errorf(
			"raw parsed count %d outside sanity window [%d, %d] - source format may have changed",
			rawRowCount, minRows, maxRows,
		)
	}

	sortedUnknown := make([]string, 0, len(unknownTypes))
	for t := range unknownTypes {
		sortedUnknown = append(sortedUnknown, t)
	}
	sort.Strings(sortedUnknown)
	return parsedRows{rows: rows, rawRowCount: rawRowCount, shortRows: shortRows, unknownTypes: sortedUnknown}, nil
}

// buildRowFromCsv returns (row, ok). ok=false means the line is malformed and
// shouldn't even count toward the sanity window; ok=true with row=nil means
// the line counts but is filtered out (synthetic ident, duplicate, bad
// coords). ok=true with a non-nil row is a kept airport.
func buildRowFromCsv(
	cells []string,
	idx map[string]int,
	runways map[string][]any,
	frequencies map[string][]any,
	unknownTypes map[string]struct{},
) (any, bool) {
	ident := cells[idx["ident"]]
	typ := cells[idx["type"]]
	name := cells[idx["name"]]
	if ident == "" || typ == "" || name == "" {
		return nil, false
	}

	// Drop uncoded ULM/altisurface/private/closed points.
	if syntheticIdentRE.MatchString(ident) && cells[idx["icao_code"]] == "" {
		return nil, true
	}
	if duplicateNameRE.MatchString(name) {
		return nil, true
	}

	lat, lon, ok := parseLatLon(cells[idx["latitude_deg"]], cells[idx["longitude_deg"]])
	if !ok {
		return nil, true
	}

	if !isKnownType(typ) {
		unknownTypes[typ] = struct{}{}
	}

	rws := runways[ident]
	if rws == nil {
		rws = []any{}
	}
	freqs := frequencies[ident]
	if freqs == nil {
		freqs = []any{}
	}

	return []any{
		ident,
		typ,
		name,
		aip.Round5(lat),
		aip.Round5(lon),
		nullableInt(cells[idx["elevation_ft"]]),
		cells[idx["iso_country"]],
		cells[idx["municipality"]],
		cells[idx["iata_code"]],
		rws,
		// access / military / vfr / ifr / joint; the AIXM overlay fills these
		// in. frequencies come from OurAirports' airport-frequencies.csv here
		// and are replaced by the AIXM overlay where it has authoritative data.
		nil,
		false,
		false,
		false,
		false,
		freqs,
	}, true
}

// parseLatLon parses a (lat, lon) pair and rejects out-of-range, NaN/Inf, and
// the (0, 0) missing-coordinate sentinel.
func parseLatLon(latStr, lonStr string) (lat, lon float64, ok bool) {
	if latStr == "" || lonStr == "" {
		return 0, 0, false
	}
	lat, err1 := strconv.ParseFloat(latStr, 64)
	lon, err2 := strconv.ParseFloat(lonStr, 64)
	if err1 != nil || err2 != nil {
		return 0, 0, false
	}
	if math.IsNaN(lat) || math.IsNaN(lon) || math.IsInf(lat, 0) || math.IsInf(lon, 0) {
		return 0, 0, false
	}
	if lat < -90 || lat > 90 || lon < -180 || lon > 180 {
		return 0, 0, false
	}
	if lat == 0 && lon == 0 {
		return 0, 0, false
	}
	return lat, lon, true
}
