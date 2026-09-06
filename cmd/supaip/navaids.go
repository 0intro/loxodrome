// navaids.go: load the committed fr-navaids.json into an ident -> position
// table for resolving radial/DME fixes. Missing or unreadable -> empty table,
// so radial fixes simply degrade to "no geometry" rather than failing.

package main

import (
	"encoding/json"
	"os"
)

func loadNavaids(path string) (navaidTable, error) {
	tab := navaidTable{}
	if path == "" {
		return tab, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return tab, err
	}
	var doc struct {
		Fields []string `json:"fields"`
		Rows   [][]any  `json:"rows"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return tab, err
	}
	// fr-navaids.json schema: [id, type, ident, name, lat, lon, ...].
	for _, r := range doc.Rows {
		if len(r) < 6 {
			continue
		}
		ident, _ := r[2].(string)
		lat, ok1 := r[4].(float64)
		lon, ok2 := r[5].(float64)
		if ident == "" || !ok1 || !ok2 {
			continue
		}
		if _, dup := tab[ident]; dup {
			continue // ambiguous ident: first wins (best-effort)
		}
		tab[ident] = latlon{lat, lon}
	}
	return tab, nil
}
