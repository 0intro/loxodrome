// meta.go: assemble the airports.meta.json sidecar from the parse result.

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"time"
)

// buildMeta combines the CSV input hash and the parse output into the
// on-disk Meta record. The format-drift sanity check has already passed
// by this point.
func buildMeta(csv string, parsed parsedRows, rows []any, now time.Time) Meta {
	return Meta{
		GeneratedAt:    now.UTC().Format("2006-01-02T15:04:05.000Z"),
		SourceSha256:   hashHex([]byte(csv)),
		RawRowCount:    parsed.rawRowCount,
		RowCount:       len(rows),
		RunwayCount:    countRunways(rows),
		FrequencyCount: countFrequencies(rows),
		ShortRows:      parsed.shortRows,
		UnknownTypes:   parsed.unknownTypes,
	}
}

func hashHex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// countRunways walks the final row slice and sums the runway sub-array
// lengths. Row layout puts runways at index 9.
func countRunways(rows []any) int {
	n := 0
	for _, r := range rows {
		row := r.([]any)
		if rws, ok := row[9].([]any); ok {
			n += len(rws)
		}
	}
	return n
}

// countFrequencies walks the final row slice and sums the frequency
// sub-array lengths. Row layout puts frequencies last, at index 15.
func countFrequencies(rows []any) int {
	n := 0
	for _, r := range rows {
		row := r.([]any)
		if fqs, ok := row[15].([]any); ok {
			n += len(fqs)
		}
	}
	return n
}
