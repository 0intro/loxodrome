// positional.go reads the {fields, rows} artifact shape this repo's
// datasets share, resolving columns BY NAME, and reads the AIRAC date out
// of a dataset's own meta sidecar.
//
// It lives here because more than one builder now reads another builder's
// output: cmd/aipdocs enumerates the offline packs from fr-adcharts.json
// and fr-supaip.json, and cmd/vacgeo reads the same membership column to
// know which plates to georeference. A builder reading another command's
// artifact must not shift silently when a column is inserted, and every one
// of these files is written by a different command on its own schedule.

package aip

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"
)

// Positional is a decoded {fields, rows} artifact with its columns indexed
// by name.
type Positional struct {
	idx  map[string]int
	Rows [][]json.RawMessage
}

// ReadPositional decodes one dataset artifact.
func ReadPositional(path string) (*Positional, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var doc struct {
		Fields []string            `json:"fields"`
		Rows   [][]json.RawMessage `json:"rows"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	idx := make(map[string]int, len(doc.Fields))
	for i, f := range doc.Fields {
		idx[f] = i
	}
	return &Positional{idx: idx, Rows: doc.Rows}, nil
}

// Str reads one column of one row as a string. A column the artifact does
// not declare, or a row too short to reach it, reads empty: the datasets
// omit trailing optional columns (fr-adcharts leaves `vac` off a row with
// no membership at all).
func (p *Positional) Str(row []json.RawMessage, field string) string {
	i, ok := p.idx[field]
	if !ok || i >= len(row) {
		return ""
	}
	var s string
	if err := json.Unmarshal(row[i], &s); err != nil {
		return ""
	}
	return s
}

// Float reads one column of one row as a number, reporting whether it was
// there and numeric.
func (p *Positional) Float(row []json.RawMessage, field string) (float64, bool) {
	i, ok := p.idx[field]
	if !ok || i >= len(row) {
		return 0, false
	}
	var v float64
	if err := json.Unmarshal(row[i], &v); err != nil {
		return 0, false
	}
	return v, true
}

// Require reports an error naming the first column the artifact lacks.
func (p *Positional) Require(fields ...string) error {
	for _, f := range fields {
		if _, ok := p.idx[f]; !ok {
			return fmt.Errorf("column %q missing", f)
		}
	}
	return nil
}

// ReadEffective takes the AIRAC effective date from a dataset's own meta
// sidecar. The publisher's stamp is the truth: deriving the cycle from the
// clock instead would drift from the very dataset the enumeration came out
// of, one day a year, at the worst possible moment.
func ReadEffective(path string) (time.Time, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return time.Time{}, err
	}
	var meta struct {
		Effective string `json:"effective"`
	}
	if err := json.Unmarshal(body, &meta); err != nil {
		return time.Time{}, fmt.Errorf("%s: %w", path, err)
	}
	if strings.TrimSpace(meta.Effective) == "" {
		return time.Time{}, fmt.Errorf("%s: no effective date", path)
	}
	day, err := time.Parse("2006-01-02", meta.Effective)
	if err != nil {
		return time.Time{}, fmt.Errorf("%s: parse effective %q: %w", path, meta.Effective, err)
	}
	return day, nil
}
