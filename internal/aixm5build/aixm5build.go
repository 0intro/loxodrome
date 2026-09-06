// Package aixm5build turns a decoded AIXM 5.1 message (internal/aixm5)
// into the JSON row artefacts the SPA loads. The navaid and airspace
// builders are identical for every AIXM 5.1 publisher, so cmd/uk and
// cmd/es share them here; cmd/fr decodes AIXM 4.5 and keeps its own.
package aixm5build

// Artifact is a {fields, rows} JSON document: a column header plus one
// positional row per feature.
type Artifact struct {
	Fields []string `json:"fields"`
	Rows   []any    `json:"rows"`
}
