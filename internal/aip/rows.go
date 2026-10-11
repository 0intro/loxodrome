// rows.go holds the rule a builder applies before it writes a dataset its
// readers index by id: an id carried twice is either one record filed twice
// or two records, and the builder says which. The file order never does.

package aip

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
)

// DropRepeatedRows drops every row identical to an earlier row with the same
// key (column col), keeping the first, and returns how many it dropped. Keys
// whose rows differ come back in conflicts, in the order their second record
// is met, every one of their rows left in place: whether the copies are two
// records or one record with an error in it is for the builder to resolve
// (SeparateConflictingRows keeps them all), never for the order the source
// happens to list them in. Rows compare as they are written, by their JSON
// encoding.
func DropRepeatedRows(rows []any, col int) (kept []any, dropped int, conflicts []string) {
	type group struct {
		encs     [][]byte
		conflict bool
	}
	groups := map[string]*group{}
	kept = make([]any, 0, len(rows))
	for _, r := range rows {
		row, ok := r.([]any)
		if !ok || col < 0 || col >= len(row) {
			kept = append(kept, r)
			continue
		}
		enc, err := json.Marshal(row)
		if err != nil {
			kept = append(kept, r)
			continue
		}
		key := fmt.Sprint(row[col])
		g := groups[key]
		if g == nil {
			groups[key] = &group{encs: [][]byte{enc}}
			kept = append(kept, r)
			continue
		}
		repeat := false
		for _, e := range g.encs {
			if bytes.Equal(e, enc) {
				repeat = true
				break
			}
		}
		if repeat {
			dropped++
			continue
		}
		g.encs = append(g.encs, enc)
		kept = append(kept, r)
		if !g.conflict {
			g.conflict = true
			conflicts = append(conflicts, key)
		}
	}
	return kept, dropped, conflicts
}

// SeparateConflictingRows gives each row of a conflicting key (DropRepeatedRows'
// conflicts) its own id, in place: the key's rows ordered by their JSON
// encoding, the first keeping the bare id and the others taking "#2", "#3",
// the occurrence form the app's own safety net uses. Nothing is dropped, so a
// chart that cannot tell which record is right draws both, the side that
// errs safe, and the file order decides nothing. Returns how many rows were
// renamed.
func SeparateConflictingRows(rows []any, col int, conflicts []string) int {
	if len(conflicts) == 0 {
		return 0
	}
	want := make(map[string]bool, len(conflicts))
	for _, k := range conflicts {
		want[k] = true
	}
	type member struct {
		row []any
		enc []byte
	}
	groups := map[string][]member{}
	for _, r := range rows {
		row, ok := r.([]any)
		if !ok || col < 0 || col >= len(row) {
			continue
		}
		key := fmt.Sprint(row[col])
		if !want[key] {
			continue
		}
		enc, err := json.Marshal(row)
		if err != nil {
			continue
		}
		groups[key] = append(groups[key], member{row: row, enc: enc})
	}
	renamed := 0
	for key, ms := range groups {
		sort.SliceStable(ms, func(i, j int) bool { return bytes.Compare(ms[i].enc, ms[j].enc) < 0 })
		for i, m := range ms[1:] {
			m.row[col] = fmt.Sprintf("%s#%d", key, i+2)
			renamed++
		}
	}
	return renamed
}
