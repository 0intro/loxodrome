// Package overlay holds source-agnostic dataset-build primitives: the
// airspace row schema and its simplify / antimeridian-split / serialise
// pipeline (cmd/pruatlas, cmd/faa), the HTTP retry/backoff client (also
// cmd/supaip, cmd/metar), and the JSON file writers.
//
// The airspace cmds emit the same 13-field row schema so
// src/lib/data/airspaces.ts can decode either artefact with the same
// rowToAirspace() helper.
package overlay

// OutputFields mirrors cmd/fr/airspaces.go:airspacesOutputFields.
// rowToAirspace() in src/lib/data/airspaces.ts indexes rows by these
// fixed positions (ring at 12, subtype 13, arcs 14), so the overlay
// artefacts (pruatlas-firs.json, faa-airspaces.json) load without any
// client-side schema change; rows shorter than the field list (older
// artefacts) decode with the trailing columns absent. Keep the
// positions aligned with cmd/fr.
var OutputFields = []string{
	"id", "type", "name", "class",
	"upper", "lower", "max", "mnm",
	"workHr", "rmkWorkHr", "rmk",
	"radio", "ring", "subtype", "arcs",
}

// Artifact is the rows + fields document written by either cmd.
type Artifact struct {
	Fields []string `json:"fields"`
	Rows   []any    `json:"rows"`
}

// SourceMeta tracks one upstream source: where it came from, its byte-stream
// fingerprint, and a row count. Cycle is populated only by pruatlas (the
// AIRAC cycle the GeoJSON claims) and stays zero / omitted for FAA.
type SourceMeta struct {
	URL    string `json:"url,omitempty"`
	Sha256 string `json:"sha256,omitempty"`
	Count  int    `json:"count"`
	Cycle  int    `json:"cycle,omitempty"`
}

// Row is the intermediate normalised airspace shape produced by each cmd's
// parser, before serialisation. A MultiPolygon feature becomes one Row per
// outer ring, matching how cmd/fr emits multi-area airspaces (the
// client dedups by id where needed; see notamLayer.ts).
type Row struct {
	ID    string
	Type  string
	Name  string
	Class string
	Upper []string
	Lower []string
	// WorkHr is the published hours of activity, as free prose in the
	// same column cmd/fr fills from the SIA codeWorkHr and the AIXM
	// publishers fill from their timesheets. Empty when the source
	// publishes none.
	WorkHr string
	Ring   [][2]float64
}

// RowsToArtifact runs the shared simplify / antimeridian-split / serialise
// pipeline on a normalised parser output. Returns the artefact (rows ready
// for JSON) and a per-type count map; the FAA meta surfaces the counts, the
// pruatlas FIR-only meta discards them.
func RowsToArtifact(in []Row) (Artifact, map[string]int) {
	counts := map[string]int{}
	rows := make([]any, 0, len(in))
	for _, r := range in {
		if len(r.Ring) < 3 {
			continue
		}
		// Split before simplification: Simplify's start/end anchoring would
		// otherwise treat an antimeridian-spanning ring as having a huge
		// chord across the Pacific.
		for _, piece := range SplitAntimeridian(r.Ring) {
			piece = Simplify(piece, SimplifyTolerance)
			if len(piece) < 3 {
				continue
			}
			counts[r.Type]++
			rows = append(rows, []any{
				r.ID, r.Type, r.Name, r.Class,
				anyTriple(r.Upper), anyTriple(r.Lower),
				nil, nil, // max, mnm; not provided by these sources
				r.WorkHr, "", "", // workHr, rmkWorkHr, rmk
				[]any{}, // radio
				piece,
				"",  // subtype: no refinement in these sources
				nil, // arcs: patched by firarcs.Apply (pruatlas only)
			})
		}
	}
	return Artifact{Fields: OutputFields, Rows: rows}, counts
}

// anyTriple returns the vertical-limit triple as `any` so json.Marshal emits
// null for absent limits and ["code","val","uom"] otherwise; matching the
// SIA schema in cmd/fr.
func anyTriple(t []string) any {
	if len(t) == 0 {
		return nil
	}
	return t
}
