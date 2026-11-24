// Package aixm5build turns a decoded AIXM 5.1 message (internal/aixm5)
// into the JSON row artefacts the SPA loads. The navaid and airspace
// builders are identical for every AIXM 5.1 publisher, so cmd/uk and
// cmd/es share them here; cmd/fr decodes AIXM 4.5 and keeps its own.
package aixm5build

import (
	"fmt"
	"strings"
)

// Artifact is a {fields, rows} JSON document: a column header plus one
// positional row per feature.
type Artifact struct {
	Fields []string `json:"fields"`
	Rows   []any    `json:"rows"`
}

// sampleIds names the first few of a list of ids for an error message, so a
// refused build says which records to look at without printing hundreds.
func sampleIds(ids []string) string {
	const shown = 5
	if len(ids) <= shown {
		return strings.Join(ids, ", ")
	}
	return strings.Join(ids[:shown], ", ") + fmt.Sprintf(" and %d more", len(ids)-shown)
}
