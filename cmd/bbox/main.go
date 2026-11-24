// Command bbox stamps a dataset's lat/lon envelope into its .meta.json
// sidecar, for the datasets that predate the field.
//
// The SPA gates a country's fetch on that envelope (docs/data-coverage.md),
// reading an absent one as "no idea, load it". Every builder now writes it,
// so each dataset gains one on its next scheduled refresh; this reads the
// COMMITTED artifact instead and writes only the sidecar, so a repository
// becomes consistent without a 50 MB data churn and without waiting a
// cycle. It changes no aeronautical value: the envelope is measured from
// the very rows it describes, by the same aip.BBoxOfRows the builders call.
//
// Run from the repository root:
//
//	go run ./cmd/bbox                  # every dataset missing one
//	go run ./cmd/bbox -force           # recompute them all
//	go run ./cmd/bbox -dir public/data -n   # dry run
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/0intro/loxodrome/internal/aip"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	dir := flag.String("dir", "public/data", "dataset directory")
	force := flag.Bool("force", false, "recompute sidecars that already carry a bbox")
	dry := flag.Bool("n", false, "report what would change, write nothing")
	flag.Parse()

	entries, err := os.ReadDir(*dir)
	if err != nil {
		return err
	}
	var names []string
	for _, e := range entries {
		n := e.Name()
		if e.IsDir() || !strings.HasSuffix(n, ".json") || strings.HasSuffix(n, ".meta.json") {
			continue
		}
		names = append(names, n)
	}
	sort.Strings(names)

	changed, skipped, nogeo := 0, 0, 0
	for _, n := range names {
		metaPath := filepath.Join(*dir, strings.TrimSuffix(n, ".json")+".meta.json")
		meta, err := readObject(metaPath)
		if err != nil {
			// A dataset with no sidecar is not one the SPA slot-picks.
			continue
		}
		box, clusters, err := bboxOfFile(filepath.Join(*dir, n))
		if err != nil {
			return fmt.Errorf("%s: %w", n, err)
		}
		if !*force && sameEnvelope(meta, box, clusters) {
			skipped++
			continue
		}
		if box == nil {
			// No usable coordinates: leaving the field absent is right,
			// since the SPA reads absent as "load it".
			nogeo++
			continue
		}
		fmt.Printf("%-34s %v (%d pieces)\n", n, box, max(len(clusters), 1))
		changed++
		if *dry {
			continue
		}
		if err := writeFields(metaPath, box, clusters); err != nil {
			return err
		}
	}
	fmt.Printf("%d stamped, %d already current, %d carry no coordinates\n", changed, skipped, nogeo)
	return nil
}

// sameEnvelope reports whether the sidecar already states exactly this
// envelope, so a re-run is a no-op rather than a rewrite. The comparison
// goes through JSON because the decoded sidecar holds []any of float64.
func sameEnvelope(meta map[string]any, box aip.BBox, clusters []aip.BBox) bool {
	want, err := json.Marshal(map[string]any{"bbox": box, "bboxes": clusters})
	if err != nil {
		return false
	}
	got, err := json.Marshal(map[string]any{"bbox": meta["bbox"], "bboxes": meta["bboxes"]})
	if err != nil {
		return false
	}
	return string(want) == string(got)
}

// readObject decodes a sidecar. Only the presence of the two keys is
// read from it; the WRITE is a textual splice (see writeFields), because
// re-marshalling a map sorts the keys and would reorder every committed
// sidecar for the sake of adding one field.
func readObject(path string) (map[string]any, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return out, nil
}

// writeFields splices the two envelope fields into a sidecar, replacing
// them where they already exist and appending them at the end otherwise.
// Every other byte of the file is left alone, so the diff is the envelope
// and nothing else.
func writeFields(path string, box aip.BBox, clusters []aip.BBox) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	text := strings.TrimRight(string(raw), " \t\r\n")
	if !strings.HasSuffix(text, "}") {
		return fmt.Errorf("%s: not a JSON object", path)
	}
	body := strings.TrimRight(text[:len(text)-1], " \t\r\n")
	for _, f := range []string{"bbox", "bboxes"} {
		body = dropField(body, f)
	}
	boxJSON, err := json.Marshal(box)
	if err != nil {
		return err
	}
	body = strings.TrimRight(body, ",")
	body += fmt.Sprintf(",\n  \"bbox\": %s", boxJSON)
	if len(clusters) > 0 {
		clustersJSON, err := json.Marshal(clusters)
		if err != nil {
			return err
		}
		body += fmt.Sprintf(",\n  \"bboxes\": %s", clustersJSON)
	}
	return os.WriteFile(path, []byte(body+"\n}\n"), 0o644)
}

// dropField removes one top-level key and its whole value from a
// pretty-printed sidecar. The value may span lines (the builders indent
// their arrays), so it is scanned to the matching bracket rather than to
// the end of the line: cutting one line out of a multi-line array leaves
// the rest of the array behind and the file is no longer JSON.
func dropField(body, name string) string {
	needle := "\n  \"" + name + "\":"
	i := strings.Index(body, needle)
	if i < 0 {
		return body
	}
	end := valueEnd(body, i+len(needle))
	if end < 0 {
		return body
	}
	// Take the comma that separated it from the next key, if any.
	for end < len(body) && (body[end] == ',' || body[end] == ' ') {
		end++
	}
	return body[:i] + strings.TrimRight(body[end:], "")
}

// valueEnd returns the index just past the JSON value starting at or
// after from, honouring nesting and strings.
func valueEnd(s string, from int) int {
	i := from
	for i < len(s) && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r') {
		i++
	}
	if i >= len(s) {
		return -1
	}
	depth := 0
	inStr := false
	for ; i < len(s); i++ {
		c := s[i]
		if inStr {
			if c == '\\' {
				i++
			} else if c == '"' {
				inStr = false
				if depth == 0 {
					return i + 1
				}
			}
			continue
		}
		switch c {
		case '"':
			inStr = true
		case '[', '{':
			depth++
		case ']', '}':
			depth--
			if depth == 0 {
				return i + 1
			}
			if depth < 0 {
				return -1
			}
		case ',', '\n':
			if depth == 0 {
				return i
			}
		}
	}
	if depth == 0 {
		return len(s)
	}
	return -1
}

// bboxOfFile reads a {fields, rows} artifact and measures its envelope,
// plus the pieces its rows really occupy.
func bboxOfFile(path string) (aip.BBox, []aip.BBox, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, nil, err
	}
	var doc struct {
		Fields []string `json:"fields"`
		Rows   []any    `json:"rows"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		// Not a columnar artifact (the aircraft index, a chart list).
		return nil, nil, nil
	}
	if len(doc.Fields) == 0 || len(doc.Rows) == 0 {
		return nil, nil, nil
	}
	return aip.BBoxOfRows(doc.Fields, doc.Rows), aip.BBoxClustersOfRows(doc.Fields, doc.Rows), nil
}
