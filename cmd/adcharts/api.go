// Command adcharts scrapes the public SIA eAIP per-aerodrome pages (AD 2
// aerodromes, AD 3 heliports) for their chart-PDF links and writes the
// fr-adcharts.json dataset: per aerodrome, the published chart files as
// [code, title, path] rows. The SIA names its chart files
// AD_2_<ICAO>_<FAMILY>_<QUALIFIER>.pdf, so the family (IAC / SID / STAR /
// DATA / ...) and a human-readable qualifier both come from the filename;
// the stored path is relative to the tree's html/eAIP/ directory, and the
// app rebuilds absolute URLs against the AIRAC cycle in force at render
// (the dated path segments rotate every 28 days; there is no stable alias
// like skeyes' eAIP_Main). Chart filenames are procedure-descriptive and
// carry no version suffixes, but the set changes at AIRAC amendments, so
// the dataset is re-scraped per cycle like cmd/be's chart column.
//
// The same dataset also stores each ident's Atlas VAC membership, read from
// the two index files the atlas itself ships. The eAIP publishes no VAC
// files; the plates live in a sibling tree whose URLs the SPA derives, so
// knowing WHICH idents have one is the whole job, and it is what lets the
// panel offer an exact link instead of a guess that 404s. The helistation
// half is keyed by the SIA codeId, the ident cmd/fr gives an aerodrome the
// AIP publishes without an ICAO location indicator.
package main

// userAgent identifies the tool to the SIA (cmd/supaip convention; the
// eAIP tree is served without a WAF, no browser headers needed).
const userAgent = "loxodrome-adcharts/1.0 (+https://loxodrome.fr)"

// The Atlas VAC is two products under one tree, each declaring its own
// produit / partie / section in FR/VAC[H]ProduitPartie.htm, which its quick-
// access widget spells out as
// PDF_AIPparSSection/<produit>/<partie>/<partie>-<section>.<code>.pdf:
//
//	VAC  / AD / 2  aerodromes,   keyed by ICAO       (AD-2.LFPG.pdf)
//	VACH / AD / 3  helistations, keyed by SIA codeId (AD-3.LF075.pdf)
//
// Each product ships the list of codes it actually carries as a JavaScript
// array, which is what makes an exact link possible: a code in the list
// resolves, one outside it 404s (verified on the 2026-08-06 cycle). The SPA
// derives the PDF URLs itself, so only the membership is stored.
//
// The index paths and the membership vocabulary live in internal/aip, which
// cmd/aipdocs reads too when it packs the plates for offline use.

// adPage is one aerodrome page discovered in the eAIP menu.
type adPage struct {
	ICAO    string
	Section int // 2 = AD 2 aerodromes, 3 = AD 3 heliports
}

// chartRef is one published chart file: Code is the filename family
// (IAC / SID / STAR / ADC / DATA / ...; empty when the name doesn't
// follow the AD_<n>_<ICAO>_ scheme), Title the rest of the stem with
// underscores as spaces, Path the href relative to html/eAIP/.
type chartRef struct {
	Code  string
	Title string
	Path  string
}

// outputFields describes the positional row layout of the artifact;
// chartFields the nested chart tuples. Mirrored by the loader in
// src/lib/data/adcharts.ts. `vac` is the Atlas VAC membership, which is
// why a row can carry an empty chart list: most helistations have a VAC
// plate and no eAIP page at all.
var (
	outputFields = []string{"icao", "charts", "vac"}
	chartFields  = []string{"code", "title", "path"}
)

// Artifact is the fr-adcharts.json payload.
type Artifact struct {
	Fields      []string `json:"fields"`
	ChartFields []string `json:"chartFields"`
	Rows        [][]any  `json:"rows"`
}

type sourceMeta struct {
	Site      string `json:"site"`
	Menu      string `json:"menu"`
	VacIndex  string `json:"vacIndex"`
	VacHIndex string `json:"vacHIndex"`
}

// Meta is the fr-adcharts.meta.json sidecar.
type Meta struct {
	GeneratedAt string     `json:"generatedAt"`
	Effective   string     `json:"effective"`
	Source      sourceMeta `json:"source"`
	Aerodromes  int        `json:"aerodromes"`
	Charts      int        `json:"charts"`
	// VacAerodromes / VacHeliports; the size of each Atlas VAC index, i.e.
	// how many idents get an exact plate link.
	VacAerodromes int            `json:"vacAerodromes"`
	VacHeliports  int            `json:"vacHeliports"`
	ByFamily      map[string]int `json:"byFamily"`
	PagesFetched  int            `json:"pagesFetched"`
	EmptyPages    int            `json:"emptyPages"`
	ParserVersion int            `json:"parserVersion"`
}
