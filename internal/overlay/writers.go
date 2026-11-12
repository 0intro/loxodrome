// writers.go: JSON file writers for the per-source artefact + meta pair.

package overlay

import (
	"encoding/json"
	"os"
)

// WriteCompactJSON marshals v with json.Marshal (one line, no indent) and
// writes it to path. Used for the large rows-array artefacts where
// pretty-printing would inflate the file size by 2-3x.
func WriteCompactJSON(path string, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

// WritePrettyJSON marshals v with two-space indentation and a trailing
// newline. Used for the small *.meta.json sidecars where readability
// (and friendly diffs) matter.
func WritePrettyJSON(path string, v any) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return os.WriteFile(path, data, 0o644)
}
