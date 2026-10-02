// build.go folds the two sources into one row per aerodrome and counts what
// it did.
//
// The fold is a UNION, which is the corpus's answer rather than an
// assumption: of the 150 aerodromes both sources state, 89 % yield identical
// grade sets and the rest are one source knowing more than the other, never
// one contradicting the other. The sidecar counts that relation per row, so
// the day the two halves start disagreeing it shows up as a number rather
// than as a wrong chip on a panel.

package main

import (
	"fmt"
	"sort"
	"time"

	"github.com/0intro/loxodrome/internal/fuel"
)

// parserVersion stamps the sidecar with the grammar that read the rows, so a
// dataset can be told from one built by an older reader. Bump it whenever
// the clause grammar, the vocabulary or the item extractor changes what an
// entry resolves to. It gates nothing.
const parserVersion = 1

// Artifact is public/data/fr-fuel.json.
type Artifact struct {
	Fields []string `json:"fields"`
	Rows   []any    `json:"rows"`
}

// artifactFields names the columns, in row order.
//
//	ident   ICAO indicator, or the SIA codeId of a helistation
//	avail   "yes" | "no"; an aerodrome the AIP says nothing about has no row
//	grades  [[grade, scope], ...], scope "" | "civ" | "mil"
//	flags   subset of h24 | or | hx | based
//	src     "vac" | "aixm" | "both"
//	text    the source's own words, verbatim, '#'-separated per AIP habit
var artifactFields = []string{"ident", "avail", "grades", "flags", "src", "text"}

// Meta is public/data/fr-fuel.meta.json.
type Meta struct {
	GeneratedAt string `json:"generatedAt"`
	// Effective is the plate cycle. AixmEffective is the cycle the
	// facilities dataset was built from, and the two WILL differ: the
	// plates refresh weekly in CI and the AIXM half only when the SIA
	// export is rebuilt by hand. Publishing one date would misdate half
	// the rows, so both are here and the About card prints both.
	Effective     string     `json:"effective"`
	AixmEffective string     `json:"aixmEffective"`
	Source        metaSource `json:"source"`

	Aerodromes    int            `json:"aerodromes"`
	WithGrades    int            `json:"withGrades"`
	NoFuel        int            `json:"noFuel"`
	StatedNoGrade int            `json:"statedNoGrade"`
	BySource      map[string]int `json:"bySource"`
	Agreement     map[string]int `json:"agreement"`
	ByGrade       map[string]int `json:"byGrade"`
	// Grades is the closed vocabulary this build could emit.
	// tests/fuelGrades.spec.ts pins the app's own FUEL_TYPES against it, so
	// a grade renamed on one side of the language boundary fails on the
	// other.
	Grades        []string   `json:"grades"`
	Plates        plateStats `json:"plates"`
	ParserVersion int        `json:"parserVersion"`
}

type metaSource struct {
	Site       string `json:"site"`
	Plates     string `json:"plates"`
	Dataset    string `json:"dataset"`
	Facilities string `json:"facilities"`
}

// row is one aerodrome's merged answer, before it is flattened.
type row struct {
	ident string
	st    fuel.Statement
	src   string
	// agree is how the two sources related, empty unless both spoke.
	agree fuel.Agreement
}

// mergeSources folds the plate entries and the AIXM entries into one row per
// ident. The plate is the primary source, its block being the richer of the
// two: it carries the hours, the payment methods and the CIV / MIL split
// that the AD 2.4 slot often leaves out.
func mergeSources(plates []plateItem, aixms []aixmItem) []row {
	vac := map[string]fuel.Statement{}
	for _, p := range plates {
		st := fuel.Parse(p.Body)
		if st.Avail == "" {
			continue
		}
		if prev, ok := vac[p.Ident]; ok {
			// An ident with a plate in both atlas products states the same
			// field twice; the aerodrome sheet leads.
			st = fuel.Merge(prev, st)
		}
		vac[p.Ident] = st
	}

	aip := map[string]fuel.Statement{}
	for _, a := range aixms {
		st := fuel.Parse(a.Body)
		if st.Avail == "" {
			// cmd/fr said the record exists but every field of it was NIL,
			// so there is nothing to parse and the answer is the answer.
			if a.Avail == fuel.AvailNo {
				st = fuel.Statement{Avail: fuel.AvailNo, Text: a.Body}
			} else {
				continue
			}
		}
		aip[a.Ident] = st
	}

	idents := map[string]bool{}
	for k := range vac {
		idents[k] = true
	}
	for k := range aip {
		idents[k] = true
	}
	out := make([]row, 0, len(idents))
	for ident := range idents {
		v, hasV := vac[ident]
		a, hasA := aip[ident]
		switch {
		case hasV && hasA:
			out = append(out, row{ident: ident, st: fuel.Merge(v, a), src: "both", agree: fuel.Compare(v, a)})
		case hasV:
			out = append(out, row{ident: ident, st: v, src: "vac"})
		default:
			out = append(out, row{ident: ident, st: a, src: "aixm"})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ident < out[j].ident })
	return out
}

// buildArtifact flattens the rows and counts them.
func buildArtifact(rows []row, ps plateStats, now time.Time, effective, aixmEffective, platesURL string) (Artifact, Meta) {
	art := Artifact{Fields: artifactFields}
	meta := Meta{
		GeneratedAt: now.UTC().Format("2006-01-02T15:04:05.000Z"),
		Effective:   effective, AixmEffective: aixmEffective,
		Source: metaSource{
			Site: "https://www.sia.aviation-civile.gouv.fr", Plates: platesURL,
			Dataset: "fr-adcharts.json", Facilities: "fr-aerodrome-facilities.json",
		},
		BySource:  map[string]int{},
		Agreement: map[string]int{},
		ByGrade:   map[string]int{},
		Grades:    append([]string{}, fuel.Vocabulary...),
		Plates:    ps, ParserVersion: parserVersion,
	}
	for _, r := range rows {
		grades := make([]any, 0, len(r.st.Grades))
		for _, g := range r.st.Grades {
			grades = append(grades, []string{g.Grade, g.Scope})
			meta.ByGrade[g.Grade]++
		}
		flags := r.st.Cond
		if flags == nil {
			flags = []string{}
		}
		art.Rows = append(art.Rows, []any{r.ident, r.st.Avail, grades, flags, r.src, r.st.Text})

		meta.Aerodromes++
		meta.BySource[r.src]++
		if r.agree != "" {
			meta.Agreement[r.agree]++
		}
		switch {
		case len(r.st.Grades) > 0:
			meta.WithGrades++
		case r.st.Avail == fuel.AvailNo:
			meta.NoFuel++
		default:
			meta.StatedNoGrade++
		}
	}
	return art, meta
}

// checkSanity refuses a build that lost a source.
//
// The row floor alone does not catch it. Either half clears 400 rows on its
// own account, so a run whose facilities column had vanished, or whose plate
// cache held only the helistations, would write a plausible-looking dataset
// silently missing a few hundred aerodromes. Each half must therefore have
// put something in.
func checkSanity(meta Meta, minRows int) error {
	if meta.Aerodromes < minRows {
		return fmt.Errorf("only %d aerodromes, want at least %d: the plate cache or the "+
			"facilities dataset looks incomplete", meta.Aerodromes, minRows)
	}
	both := meta.BySource["both"]
	if n := meta.BySource["vac"] + both; n == 0 {
		return fmt.Errorf("no aerodrome came from a plate: the plate cache looks empty " +
			"(run cmd/aipdocs first)")
	}
	if n := meta.BySource["aixm"] + both; n == 0 {
		return fmt.Errorf("no aerodrome came from the AIP: fr-aerodrome-facilities.json " +
			"has no `fuel` column (rebuild it with cmd/fr)")
	}
	return nil
}
