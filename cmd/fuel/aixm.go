// aixm.go reads the AIP's own AD 2.4 fuel entry, out of the committed
// facilities dataset rather than the AIXM itself.
//
// The AIXM is the proprietary SIA export, which lives on one machine and is
// rebuilt by hand; CI has only what cmd/fr already committed. That is
// enough, because cmd/fr carries the entry's TEXT forward untouched and
// leaves the reading of it here, in one place, at one parser version. A
// typed column there would have pinned a heuristic into a dataset only that
// machine can regenerate, and a parser fix would then need a hand rebuild
// before this dataset could catch up, with nothing in either sidecar to say
// the two halves had been read by different versions.
//
// The AIXM half is not a duplicate of the plates. The Atlas VAC is
// metropolitan only, so 42 aerodromes with a fuel entry have no plate at
// all (the overseas fields and the air bases), and 22 of the 29 entries
// that state NIL are among them. Those NILs are the AIP saying a field is
// dry, which is worth as much to a pilot as a grade list.

package main

import (
	"encoding/json"
	"fmt"
	"sort"

	"github.com/0intro/loxodrome/internal/aip"
)

// aixmItem is one aerodrome's AD 2.4 entry as cmd/fr emits it.
type aixmItem struct {
	Ident string
	// Avail is the AIXM's own answer: "no" where every field of the service
	// record is NIL, "yes" otherwise.
	Avail string
	Body  string
}

// readFacilitiesFuel reads the `fuel` column of fr-aerodrome-facilities.json.
// A dataset written before that column existed yields no items rather than
// an error, so this command still runs against an older tree.
func readFacilitiesFuel(path string) ([]aixmItem, error) {
	p, err := aip.ReadPositional(path)
	if err != nil {
		return nil, err
	}
	if err := p.Require("ident"); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	var out []aixmItem
	for _, row := range p.Rows {
		raw := p.Raw(row, "fuel")
		if len(raw) == 0 || string(raw) == "null" {
			continue
		}
		var pair []string
		if err := json.Unmarshal(raw, &pair); err != nil || len(pair) != 2 {
			continue
		}
		ident := p.Str(row, "ident")
		if ident == "" {
			continue
		}
		out = append(out, aixmItem{Ident: ident, Avail: pair[0], Body: pair[1]})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Ident < out[j].Ident })
	return out, nil
}
