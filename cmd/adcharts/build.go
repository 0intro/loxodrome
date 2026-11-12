package main

import (
	"sort"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
)

// parserVersion tracks the extractor; bump on parser changes so the meta
// records which logic produced a committed dataset.
const parserVersion = 2

// build assembles the artifact and meta from the per-aerodrome chart lists
// and the two Atlas VAC indexes. Rows are sorted by ICAO, and an ident is
// emitted when it has charts OR a VAC plate, so a helistation with neither
// an eAIP page nor an instrument chart still carries its plate link. An
// unchanged cycle yields a byte-identical artifact (the workflow's no-op
// gate); generatedAt lives in the meta only.
func build(charts map[string][]chartRef, vacAD, vacHel []string, effective time.Time, menuURL string, fetched int, now time.Time) (Artifact, Meta) {
	inAD := make(map[string]bool, len(vacAD))
	for _, c := range vacAD {
		inAD[c] = true
	}
	inHel := make(map[string]bool, len(vacHel))
	for _, c := range vacHel {
		inHel[c] = true
	}

	idents := make([]string, 0, len(charts)+len(vacAD)+len(vacHel))
	seen := make(map[string]bool, cap(idents))
	for _, set := range []map[string]bool{inAD, inHel} {
		for icao := range set {
			if !seen[icao] {
				seen[icao] = true
				idents = append(idents, icao)
			}
		}
	}
	for icao := range charts {
		if !seen[icao] {
			seen[icao] = true
			idents = append(idents, icao)
		}
	}
	sort.Strings(idents)

	base := aip.SIAAtlasVACBase(effective)
	art := Artifact{Fields: outputFields, ChartFields: chartFields}
	meta := Meta{
		GeneratedAt: now.UTC().Format("2006-01-02T15:04:05.000Z"),
		Effective:   aip.AiracISO(effective),
		Source: sourceMeta{
			Site:      aip.SIAHost,
			Menu:      menuURL,
			VacIndex:  base + aip.SIAVacIndexJS,
			VacHIndex: base + aip.SIAVacHIndexJS,
		},
		VacAerodromes: len(inAD),
		VacHeliports:  len(inHel),
		ByFamily:      map[string]int{},
		PagesFetched:  fetched,
		ParserVersion: parserVersion,
	}
	for _, icao := range idents {
		refs := charts[icao]
		vac := vacFor(inAD[icao], inHel[icao])
		if len(refs) == 0 {
			// A fetched page that published nothing stays a scrape
			// diagnostic, whether or not the ident has a plate.
			if _, fetchedPage := charts[icao]; fetchedPage {
				meta.EmptyPages++
			}
			if vac == aip.VacNone {
				continue
			}
		}
		rows := make([][]string, 0, len(refs))
		for _, c := range refs {
			rows = append(rows, []string{c.Code, c.Title, c.Path})
			meta.ByFamily[c.Code]++
		}
		art.Rows = append(art.Rows, []any{icao, rows, vac})
		if len(refs) > 0 {
			meta.Aerodromes++
			meta.Charts += len(refs)
		}
	}
	return art, meta
}

// vacFor maps the two index memberships to the stored token.
func vacFor(ad, hel bool) aip.VacKind {
	switch {
	case ad && hel:
		return aip.VacBoth
	case ad:
		return aip.VacAD
	case hel:
		return aip.VacHel
	default:
		return aip.VacNone
	}
}
