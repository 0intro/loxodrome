// build.go: the pure core. Turn the pdftotext -layout text of FAA Order
// JO 7360.1 into the faa-designators.json artefact + meta the browser
// consumes. No I/O lives here, so the parse stays test-friendly, exactly
// like cmd/metar.

package main

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	// Sanity windows: JO 7360.1K yields ~2.6k designators over ~5k model
	// rows (Appendix C, the by-model sort); a future edition whose layout
	// defeats the parser must fail loudly instead of writing a near-empty
	// dataset.
	defaultMinDesignators = 1500
	defaultMaxDesignators = 6000
	defaultMinModels      = 3000
	defaultMaxModels      = 20000
)

// classWords are the only values of the order's Class column (verified on
// JO 7360.1K: no glider / balloon / airship classes exist, and the word is
// "Gyroplane", not "Gyrocopter"). A Class cell marks a designator table
// row, and the cell immediately to its left is always the Designator
// column, in all three sorts of the catalogue.
var classWords = map[string]bool{
	"Fixed-wing":   true,
	"Helicopter":   true,
	"Gyroplane":    true,
	"Powered-lift": true,
}

// classCell reports whether a cell is the Class column: the bare word, its
// marked variants (paragraph 2-2: "@" Fixed-wing is an amphibian, "$" a
// seaplane), or a jammed "class engine" cell (a handful of rows lose the
// column gap, e.g. "@Fixed-wing 1P/S"). A model NAME containing a class
// word ("JE-2 Gyroplane") never starts with one, so it does not match.
func classCell(cell string) bool {
	c := strings.TrimLeft(cell, "@$")
	if classWords[c] {
		return true
	}
	for w := range classWords {
		if strings.HasPrefix(c, w+" ") {
			return true
		}
	}
	return false
}

// codeRe is the ICAO type designator shape (Doc 8643: 2 to 4 characters,
// upper-case letters and digits).
var codeRe = regexp.MustCompile(`^[A-Z0-9]{2,4}$`)

// designatorCell returns the designator of a table cell, stripping the
// order's one marker suffix: an asterisk denotes a single-piloted military
// turbojet (paragraph 2-1 a.), FAA metadata that is not part of the
// designator ("A10*" is the A-10's plain A10). Returns "" when the cell is
// not a designator. Verified on JO 7360.1K: every cell left of a Class
// word matches [A-Z0-9]{2,4} with an optional trailing star, nothing else.
func designatorCell(cell string) string {
	c := strings.TrimSuffix(cell, "*")
	if codeRe.MatchString(c) {
		return c
	}
	return ""
}

// cellSplitRe splits a -layout line into cells on runs of two or more
// spaces; single spaces stay inside a cell (model names, "DR-400 2+2").
var cellSplitRe = regexp.MustCompile(`\s{2,}`)

// Tuple is one (designator, manufacturer, model) row of the catalogue's
// by-model sort, the source of the editor's suggestion labels.
type Tuple struct {
	Designator   string
	Manufacturer string
	Model        string
}

// splitCells returns the trimmed non-empty cells of one table line.
func splitCells(line string) []string {
	parts := cellSplitRe.Split(strings.TrimSpace(line), -1)
	cells := parts[:0]
	for _, p := range parts {
		if p != "" {
			cells = append(cells, p)
		}
	}
	return cells
}

// anyManufacturer is Appendix B's heading for the generic designators
// (Balloon -> BALL, Glider -> GLID, ... ZZZZ); their rows carry no Class
// cell, so they need their own harvest.
const anyManufacturer = "(any manufacturer)"

// parseText harvests the designator set and the model tuples from the
// order's text.
//
// Codes: any cell matching the designator shape whose right neighbour is a
// Class cell, at any indent. This covers all three catalogue sorts
// (Appendix A by designator: code, class, ...; Appendix C by model: model,
// manufacturer, code, class, ...; Appendix B by manufacturer: model, code,
// class, ... under a manufacturer heading) plus wrapped continuation rows.
// Appendix B's class-less "(any manufacturer)" generics are added there.
//
// Tuples, three sources, deduped exactly:
//   - Appendix C shaped rows anywhere (code in the third cell, class in
//     the fourth, model and manufacturer before them). Appendix A's
//     trailing "MANUFACTURER, Model" cell is NOT split on the comma (some
//     manufacturer names contain one).
//   - Appendix B rows (model, code, class) under the current indent-0
//     manufacturer heading. This recovers the multi-manufacturer models
//     whose Appendix C manufacturer cell centre-wraps onto its own lines
//     (MD-11, the Learjets, ...).
//   - Appendix B's "(any manufacturer)" block (model, code; no class).
//
// Rows whose model cell itself centre-wraps stay tuple-less; their
// designator is still in the set via the code harvest.
func parseText(text string) ([]string, []Tuple, error) {
	lines := strings.Split(text, "\n")
	for i := range lines {
		lines[i] = strings.TrimLeft(lines[i], "\f")
	}

	// Appendix B bounds: the in-body headings (the table of contents lists
	// the same titles, so take the LAST "Appendix B. Encode" and the first
	// "Appendix C." after it).
	bStart, bEnd := -1, -1
	for i, l := range lines {
		if strings.HasPrefix(strings.TrimSpace(l), "Appendix B. Encode") {
			bStart = i
		}
	}
	if bStart >= 0 {
		for i := bStart + 1; i < len(lines); i++ {
			if strings.HasPrefix(strings.TrimSpace(lines[i]), "Appendix C.") {
				bEnd = i
				break
			}
		}
	}
	if bStart < 0 || bEnd < 0 {
		return nil, nil, fmt.Errorf("Appendix B bounds not found (headings changed in this edition?)")
	}

	seenCode := map[string]bool{}
	seenTuple := map[string]bool{}
	var tuples []Tuple
	addTuple := func(code, manufacturer, model string) {
		k := code + "|" + manufacturer + "|" + model
		if !seenTuple[k] {
			seenTuple[k] = true
			tuples = append(tuples, Tuple{Designator: code, Manufacturer: manufacturer, Model: model})
		}
	}

	manufacturer := ""
	for i, line := range lines {
		cells := splitCells(line)
		for j := 0; j+1 < len(cells); j++ {
			if classCell(cells[j+1]) {
				if c := designatorCell(cells[j]); c != "" {
					seenCode[c] = true
				}
			}
		}
		if len(cells) >= 4 && classCell(cells[3]) {
			if c := designatorCell(cells[2]); c != "" {
				addTuple(c, cells[1], cells[0])
			}
		}
		if i <= bStart || i >= bEnd {
			continue
		}
		// Inside Appendix B: an indent-0 single-cell line is the next
		// manufacturer heading ("MANUFACTURER" is the repeated per-page
		// table header; page furniture is right-aligned, so indented).
		if len(cells) == 1 && line != "" && !strings.HasPrefix(line, " ") &&
			cells[0] != "MANUFACTURER" && !strings.HasPrefix(cells[0], "Appendix") {
			manufacturer = cells[0]
			continue
		}
		if manufacturer == "" {
			continue
		}
		if len(cells) >= 3 && classCell(cells[2]) {
			if c := designatorCell(cells[1]); c != "" {
				addTuple(c, manufacturer, cells[0])
			}
		}
		if manufacturer == anyManufacturer && len(cells) == 2 {
			if c := designatorCell(cells[1]); c != "" {
				seenCode[c] = true
				addTuple(c, manufacturer, cells[0])
			}
		}
	}

	codes := make([]string, 0, len(seenCode))
	for c := range seenCode {
		codes = append(codes, c)
	}
	sort.Strings(codes)
	sort.Slice(tuples, func(i, j int) bool {
		a, b := tuples[i], tuples[j]
		if a.Designator != b.Designator {
			return a.Designator < b.Designator
		}
		if a.Manufacturer != b.Manufacturer {
			return a.Manufacturer < b.Manufacturer
		}
		return a.Model < b.Model
	})
	return codes, tuples, nil
}

// Artifact is the top-level shape written to data/faa-designators.json.
// The positional types rows mirror FaaDesignatorRow in
// src/lib/data/designators.ts; keep the two in lockstep.
type Artifact struct {
	Designators []string    `json:"designators"`
	Types       [][3]string `json:"types"`
}

// Meta is the data/faa-designators.meta.json sidecar.
type Meta struct {
	GeneratedAt     string `json:"generatedAt"`
	Source          string `json:"source"`
	Edition         string `json:"edition"`
	EffectiveDate   string `json:"effectiveDate"`
	DesignatorCount int    `json:"designatorCount"`
	ModelCount      int    `json:"modelCount"`
	License         string `json:"license"`
}

// Result bundles what the build returns to the caller.
type Result struct {
	Artifact Artifact
	Meta     Meta
}

// Options carries the meta provenance and the sanity window overrides
// (zero values fall back to the production defaults), plus a Now hook for
// tests.
type Options struct {
	Edition        string
	Effective      string
	Source         string
	MinDesignators int
	MaxDesignators int
	MinModels      int
	MaxModels      int
	Now            func() time.Time
}

// buildArtifact parses the order text and assembles the artefact + meta.
func buildArtifact(text string, opts Options) (Result, error) {
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	minD, maxD := opts.MinDesignators, opts.MaxDesignators
	if minD == 0 {
		minD = defaultMinDesignators
	}
	if maxD == 0 {
		maxD = defaultMaxDesignators
	}
	minM, maxM := opts.MinModels, opts.MaxModels
	if minM == 0 {
		minM = defaultMinModels
	}
	if maxM == 0 {
		maxM = defaultMaxModels
	}

	codes, tuples, err := parseText(text)
	if err != nil {
		return Result{}, err
	}
	if len(codes) < minD || len(codes) > maxD {
		return Result{}, fmt.Errorf("designator count %d outside sanity window [%d, %d]; refusing to write", len(codes), minD, maxD)
	}
	if len(tuples) < minM || len(tuples) > maxM {
		return Result{}, fmt.Errorf("model row count %d outside sanity window [%d, %d]; refusing to write", len(tuples), minM, maxM)
	}

	types := make([][3]string, len(tuples))
	for i, t := range tuples {
		types[i] = [3]string{t.Designator, t.Manufacturer, t.Model}
	}
	return Result{
		Artifact: Artifact{Designators: codes, Types: types},
		Meta: Meta{
			GeneratedAt:     now().UTC().Format("2006-01-02T15:04:05.000Z"),
			Source:          opts.Source,
			Edition:         opts.Edition,
			EffectiveDate:   opts.Effective,
			DesignatorCount: len(codes),
			ModelCount:      len(types),
			License:         "Public domain (US Government work, 17 U.S.C. 105)",
		},
	}, nil
}

// codesWithoutTuples lists the designators that have no model row (their
// by-model lines wrapped or were otherwise unparseable); they stay valid
// members of the set, this is a diagnostic for the run log.
func codesWithoutTuples(a Artifact) []string {
	withTuple := map[string]bool{}
	for _, t := range a.Types {
		withTuple[t[0]] = true
	}
	var out []string
	for _, c := range a.Designators {
		if !withTuple[c] {
			out = append(out, c)
		}
	}
	return out
}
