// merge.go: carry forward the supplements the SIA has stopped listing.
//
// The listing pages advertise only what is currently in force, so a supplement
// drops off them the moment it lapses and a from-scratch rebuild loses it: SUP
// AIP 142/26, the 14 July 2026 flypast over Paris, was in the dataset on 9 July
// and gone by the end of the month. The PDFs stay served, but nothing in the
// listing points at them any more, so the committed artefact is the only
// durable record of what was published.
//
// So each run unions its fresh rows with the previous artefact: a row the
// listing still carries is rebuilt, one it has dropped is RETAINED as last
// written, and rows older than the retention floor are pruned. Retained rows
// therefore freeze at the parser version that produced them, which is the right
// trade for data that can no longer be re-fetched reliably.

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
)

// prevArtifact is the previously written fr-supaip.json, held two ways. Rows
// are decoded loosely (strings, float64, map, slice) so the meta can be counted
// off them. Raw keeps each field's original bytes, and a retained row is
// re-emitted from THOSE: a decoded object comes back as a Go map, which
// marshals with its keys sorted, so passing the decoded form through would
// rewrite every retained row's key order and cost the build its
// byte-identical-on-no-change property, which is what makes the weekly
// workflow a no-op.
type prevArtifact struct {
	Fields []string `json:"fields"`
	Rows   [][]any  `json:"rows"`
	Raw    [][]json.RawMessage
}

// readPrevious loads the artefact at path. A missing file is not an error: the
// first run of a fresh checkout has nothing to carry forward.
func readPrevious(path string) (*prevArtifact, error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var a prevArtifact
	if err := json.Unmarshal(data, &a); err != nil {
		return nil, fmt.Errorf("decode %s: %w", path, err)
	}
	var raw struct {
		Rows [][]json.RawMessage `json:"rows"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("decode %s: %w", path, err)
	}
	a.Raw = raw.Rows
	return &a, nil
}

// rowID is a row's stable identity, "<region>-<year>-<NNN>" (field 0).
func rowID(row []any) string {
	if len(row) == 0 {
		return ""
	}
	s, _ := row[0].(string)
	return s
}

// splitID reads the year and number back off an id. The region itself may
// contain hyphens (car-sam-nam), so the two numeric tails are taken from the
// right and whatever precedes them is the region.
func splitID(id string) (region string, year, number int, ok bool) {
	i := strings.LastIndex(id, "-")
	if i < 0 {
		return "", 0, 0, false
	}
	j := strings.LastIndex(id[:i], "-")
	if j < 0 {
		return "", 0, 0, false
	}
	year, err1 := strconv.Atoi(id[j+1 : i])
	number, err2 := strconv.Atoi(id[i+1:])
	if err1 != nil || err2 != nil {
		return "", 0, 0, false
	}
	return id[:j], year, number, true
}

// mergeOpts controls what a merge keeps.
type mergeOpts struct {
	// retainFrom is the earliest year a delisted supplement is kept for; 0
	// disables retention entirely (a from-scratch rebuild, the old behaviour).
	retainFrom int
}

// mergeRetained appends the previous artefact's delisted rows to the fresh
// ones, in place of nothing: a fresh row always wins, so a supplement still on
// the listing is the one just rebuilt. Returns the merged rows and how many
// were carried forward.
//
// A previous file whose field list differs from the current one is skipped
// wholesale rather than reinterpreted, since its rows would be misaligned; the
// run then degrades to today's from-scratch behaviour and loses nothing that is
// not already committed.
func mergeRetained(fresh []any, prev *prevArtifact, o mergeOpts) ([]any, [][]any, error) {
	if prev == nil || o.retainFrom == 0 {
		return fresh, nil, nil
	}
	if !sameFields(prev.Fields, outputFields) {
		return fresh, nil, fmt.Errorf("previous artefact has a different field list; retention skipped")
	}

	seen := make(map[string]bool, len(fresh))
	for _, r := range fresh {
		row, ok := r.([]any)
		if !ok {
			continue
		}
		seen[rowID(row)] = true
	}

	merged := fresh
	var retained [][]any
	for i, row := range prev.Rows {
		id := rowID(row)
		if id == "" || seen[id] {
			continue
		}
		_, year, _, ok := splitID(id)
		if !ok || year < o.retainFrom {
			continue
		}
		// Guard the sort's precondition as well as the union's: a duplicate id
		// would make the row order, and so the file's bytes, undefined.
		seen[id] = true
		// The RAW field bytes, so the row is re-emitted exactly as it was
		// written; the decoded copy is only for counting.
		if i < len(prev.Raw) {
			merged = append(merged, any(prev.Raw[i]))
		} else {
			merged = append(merged, any(row))
		}
		retained = append(retained, row)
	}
	sortRows(merged)
	return merged, retained, nil
}

// anyRowID reads a row's id whether it is a freshly built row, a decoded one,
// or the raw bytes a retained row is carried as.
func anyRowID(r any) string {
	switch row := r.(type) {
	case []any:
		return rowID(row)
	case []json.RawMessage:
		if len(row) == 0 {
			return ""
		}
		var id string
		if err := json.Unmarshal(row[0], &id); err != nil {
			return ""
		}
		return id
	}
	return ""
}

func sameFields(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// sortRows orders rows by (region, year, number), the identity buildRow's id
// encodes, so an unchanged upstream still yields a byte-identical file.
func sortRows(rows []any) {
	sort.Slice(rows, func(i, j int) bool {
		regI, yearI, numI, _ := splitID(anyRowID(rows[i]))
		regJ, yearJ, numJ, _ := splitID(anyRowID(rows[j]))
		if regI != regJ {
			return regI < regJ
		}
		if yearI != yearJ {
			return yearI < yearJ
		}
		return numI < numJ
	})
}

// countRetained folds a carried-forward row into the meta. Only the counters
// that describe the DATASET are touched; the ones describing the run itself
// (pdfFetched, pdfCached, parseErrors, popplerFallback) stay with the fresh
// supplements, which are the only ones this run actually fetched and parsed.
func countRetained(row []any, today string, meta *Meta) {
	str := func(i int) string {
		if i >= len(row) {
			return ""
		}
		s, _ := row[i].(string)
		return s
	}
	meta.Total++
	if reg := str(2); reg != "" {
		meta.ByRegion[reg]++
	}
	if str(4) != "" {
		meta.WithEnglish++
	}
	switch str(16) {
	case "pdf-polygon":
		meta.Polygon++
		meta.WithGeometry++
	case "pdf-circle":
		meta.Circle++
		meta.WithGeometry++
	case "pdf-mixed":
		meta.Mixed++
		meta.WithGeometry++
	default:
		meta.None++
	}
	if rowSliceLen(row, 20) > 0 {
		meta.WithContacts++
	}
	if rowPresent(row, 21) {
		meta.WithPenetration++
	}
	if str(22) != "" {
		meta.WithManager++
	}
	if retainedHasVertical(row) {
		meta.WithVertical++
	}
	validFrom, validTo := str(7), str(8)
	switch {
	case validFrom != "" && validFrom > today:
		meta.Upcoming++
	case validFrom != "" && (validTo == "" || validTo >= today):
		meta.Active++
	}
}

// retainedHasVertical reports whether any of the row's zones states a vertical
// limit. The zones come back from JSON as maps, never the zoneJSON the fresh
// path counts.
func retainedHasVertical(row []any) bool {
	if len(row) <= 14 {
		return false
	}
	zones, ok := row[14].([]any)
	if !ok {
		return false
	}
	for _, z := range zones {
		m, ok := z.(map[string]any)
		if !ok {
			continue
		}
		if m["lower"] != nil || m["upper"] != nil {
			return true
		}
	}
	return false
}

func rowSliceLen(row []any, i int) int {
	if i >= len(row) {
		return 0
	}
	s, _ := row[i].([]any)
	return len(s)
}

func rowPresent(row []any, i int) bool {
	return i < len(row) && row[i] != nil
}

// previousRows is the previous artefact's rows, or nil when there is none.
func previousRows(prev *prevArtifact) [][]any {
	if prev == nil {
		return nil
	}
	return prev.Rows
}
