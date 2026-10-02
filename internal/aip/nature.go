// nature.go is the one layout of the nature datasets: the protected sites
// and sensitive areas the map draws as a bullseye carrying the minimum
// height to overfly them at. cmd/fr emits the SIA's PRN and SUR zones,
// cmd/be the ENR 5.6 bird areas, cmd/it the parks the Italian snapshot
// files as airspace; src/lib/data/nature.ts reads the rows by position.

package aip

import "fmt"

// NatureFields is the positional row layout of <cc>-nature.json:
//
//	id:        a stable slug ("LF-PRN-020", "it:<codeId>")
//	type:      NATURE | SENSITIVE | BIRD
//	name:      the site's name ("PARC NATIONAL DES CEVENNES")
//	lat/lon:   decimal degrees (the zone's representative point)
//	minAlt:    minimum overflight altitude value (ft, or the FL number)
//	minAltRef: "AGL" | "AMSL" | "FL" | "SFC" | "" (reference of minAlt)
var NatureFields = []string{"id", "type", "name", "lat", "lon", "minAlt", "minAltRef"}

// NatureArtifact is a <cc>-nature.json document.
type NatureArtifact struct {
	Fields []string `json:"fields"`
	Rows   []any    `json:"rows"`
}

// NatureRow is one site. MinAlt is written as given: a number, the
// publisher's own figure as text (cmd/it), or nil where none is stated.
type NatureRow struct {
	ID, Type, Name string
	Lat, Lon       float64
	MinAlt         any
	MinAltRef      string
}

// BuildNature lays the rows out in the order given and refuses a count
// outside [min, max], `what` naming the rows in the error. It returns the
// rows' envelope and the pieces they occupy, which the sidecar carries for
// the SPA's coverage gate (bbox.go).
func BuildNature(rows []NatureRow, what string, min, max int) (NatureArtifact, BBox, []BBox, error) {
	out := make([]any, len(rows))
	for i, r := range rows {
		out[i] = []any{r.ID, r.Type, r.Name, r.Lat, r.Lon, r.MinAlt, r.MinAltRef}
	}
	if n := len(out); n < min || n > max {
		return NatureArtifact{}, nil, nil, fmt.Errorf(
			"%s count %d outside sanity window [%d, %d] - source format may have changed", what, n, min, max)
	}
	return NatureArtifact{Fields: NatureFields, Rows: out}, BBoxOfRows(NatureFields, out), BBoxClustersOfRows(NatureFields, out), nil
}
