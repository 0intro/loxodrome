// navaids.go: load the committed fr-navaids.json into an ident -> position
// table for resolving radial/DME fixes. Missing or unreadable -> empty table,
// so radial fixes simply degrade to "no geometry" rather than failing.

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"slices"
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

// loadAerodromes adds to tab each aerodrome of the committed fr-airports.json
// at its ARP, under its ICAO code, for a circle a supplement centres on an
// aerodrome ("centré sur l'ARP de l'aérodrome de Corte (LFKT)", 106/2026). A
// navaid keeps an ident they share.
func loadAerodromes(path string, tab navaidTable) error {
	if path == "" {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var doc struct {
		Rows [][]any `json:"rows"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return err
	}
	// fr-airports.json schema: [ident, type, name, lat, lon, ...].
	for _, r := range doc.Rows {
		if len(r) < 5 {
			continue
		}
		ident, _ := r[0].(string)
		lat, ok1 := r[3].(float64)
		lon, ok2 := r[4].(float64)
		if ident == "" || !ok1 || !ok2 {
			continue
		}
		if _, dup := tab[ident]; !dup {
			tab[ident] = latlon{lat, lon}
		}
	}
	return nil
}

// loadAirspaceIDs returns the ids of the P, R and D zones of the committed
// fr-airspaces.json ("LFR13A1", "LFD595"), the designators a zone's
// exclusion text may cite.
func loadAirspaceIDs(path string) (map[string]bool, error) {
	if path == "" {
		return nil, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var doc struct {
		Fields []string `json:"fields"`
		Rows   [][]any  `json:"rows"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, err
	}
	idCol, typeCol := slices.Index(doc.Fields, "id"), slices.Index(doc.Fields, "type")
	if idCol < 0 || typeCol < 0 {
		return nil, fmt.Errorf("%s: no id or type field", path)
	}
	ids := map[string]bool{}
	for _, r := range doc.Rows {
		if len(r) <= max(idCol, typeCol) {
			continue
		}
		id, _ := r[idCol].(string)
		switch typ, _ := r[typeCol].(string); typ {
		case "P", "R", "D":
			if id != "" {
				ids[id] = true
			}
		}
	}
	return ids, nil
}
