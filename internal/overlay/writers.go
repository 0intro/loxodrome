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
	return writeFile(path, data)
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
	return writeFile(path, data)
}

// writeFile writes data beside path and renames it over path. A run that
// dies while writing leaves the previous file whole: the cumulative
// fr-supaip.json is the only record of the supplements the SIA has
// delisted, and cmd/supaip rebuilds one it cannot read from the listing
// alone.
func writeFile(path string, data []byte) error {
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(tmp, path)
	}
	if err != nil {
		os.Remove(tmp)
	}
	return err
}
