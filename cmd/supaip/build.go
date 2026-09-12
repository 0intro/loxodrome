// build.go: turn acquired supplements into the fr-supaip.json artefact and
// its meta. Build is deterministic: rows are sorted by (region, year,
// number), coordinates are rounded, and no timestamp leaks into the artefact,
// so an unchanged upstream yields a byte-identical file (the git diff --quiet
// commit guard then makes the workflow a no-op).

package main

import (
	"fmt"
	"os"
	"sort"
	"time"

	"github.com/0intro/loxodrome/internal/overlay"
)

// parserVersion stamps the meta with the extractor that wrote the rows, so a
// dataset can be told apart from one built by an older parser. Bump it
// whenever parse_geom / parse_pdf behaviour is altered. It gates nothing: the
// only on-disk cache holds PDF bytes and is keyed by SIA download id, and
// every run re-parses from those bytes regardless.
const parserVersion = 4

type buildOpts struct {
	now       func() time.Time
	minSupaip int
	maxSupaip int
	// prev is the previously written artefact, whose delisted rows are carried
	// forward; nil on a fresh checkout. retainFrom is the earliest year worth
	// retaining, 0 to rebuild from scratch as before.
	prev       *prevArtifact
	retainFrom int
}

// Build parses every supplement's PDF and assembles the artefact + meta.
func Build(res acquireResult, nav navaidTable, o buildOpts) (overlay.Artifact, Meta, error) {
	now := o.now
	if now == nil {
		now = time.Now
	}
	today := now().UTC().Format("2006-01-02")

	sups := res.sups
	sort.Slice(sups, func(i, j int) bool {
		if sups[i].region != sups[j].region {
			return sups[i].region < sups[j].region
		}
		if sups[i].year != sups[j].year {
			return sups[i].year < sups[j].year
		}
		return sups[i].number < sups[j].number
	})

	meta := Meta{
		GeneratedAt:   now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Source:        sourceMeta{Site: siaHost, PdfBase: pdfStore, ListingShas: res.listingSha},
		ByRegion:      map[string]int{},
		PdfFetched:    res.fetched,
		PdfCached:     res.cached,
		ParserVersion: parserVersion,
	}

	rows := make([]any, 0, len(sups))
	for _, s := range sups {
		gr := parsePDF(s.pdf, nav)
		if gr.source == "none" && hasWarning(gr.warnings, "pdf-extract-failed") {
			meta.ParseErrors++
		}
		if hasWarning(gr.warnings, "pdf-poppler-fallback") {
			meta.PopplerFallback++
		}
		descEn := ""
		if len(s.pdfEn) > 0 {
			descEn = enSubject(s.pdfEn)
		}
		if descEn != "" {
			meta.WithEnglish++
		}
		rows = append(rows, buildRow(s, gr, descEn))

		if len(gr.contacts) > 0 {
			meta.WithContacts++
		}
		if gr.penetration != nil {
			meta.WithPenetration++
		}
		if gr.manager != "" {
			meta.WithManager++
		}

		meta.Total++
		meta.ByRegion[s.region]++
		switch gr.source {
		case "pdf-polygon":
			meta.Polygon++
			meta.WithGeometry++
		case "pdf-circle":
			meta.Circle++
			meta.WithGeometry++
		case "pdf-mixed":
			meta.Mixed++
			meta.WithGeometry++
		default:
			meta.None++
		}
		for _, z := range gr.zones {
			if z.lower != nil || z.upper != nil {
				meta.WithVertical++
				break
			}
		}
		switch {
		case s.validFrom != "" && s.validFrom > today:
			meta.Upcoming++
		case s.validFrom != "" && (s.validTo == "" || s.validTo >= today):
			meta.Active++
		}
	}

	// The window guards the FETCH: too few rows means the listing came back
	// short, which is the failure worth refusing to commit. It is checked
	// before the merge, since retained rows would otherwise mask it.
	if err := sanity(len(sups), o.minSupaip, o.maxSupaip); err != nil {
		return overlay.Artifact{}, Meta{}, err
	}

	merged, retained, err := mergeRetained(rows, o.prev, mergeOpts{retainFrom: o.retainFrom})
	if err != nil {
		// Retention is best-effort: a previous artefact this build cannot read
		// leaves the run exactly as it was before merging existed, which loses
		// nothing that is not already committed.
		fmt.Fprintf(os.Stderr, "supaip: %v\n", err)
	}
	for _, row := range retained {
		countRetained(row, today, &meta)
	}
	meta.Retained = len(retained)
	if len(merged) < len(rows) {
		return overlay.Artifact{}, Meta{}, fmt.Errorf("supaip: merge lost rows (%d < %d)", len(merged), len(rows))
	}
	return overlay.Artifact{Fields: outputFields, Rows: merged}, meta, nil
}

// extractAny reconstructs a PDF's rows, trying the native rsc.io/pdf reader
// first and poppler's pdftotext when the native reader cannot read the file
// (Acrobat Distiller and similar, where it panics or yields nothing). poppler
// reports true when its output was used. An error means both routes failed (or
// poppler is not installed), so the supplement has no usable text.
func extractAny(data []byte) (rows []prow, poppler bool, err error) {
	if rows, err = extractRows(data); err == nil && len(rows) > 0 {
		return rows, false, nil
	}
	frows, ferr := pdftotextRows(data)
	if ferr != nil || len(frows) == 0 {
		if err == nil {
			err = ferr
		}
		return nil, false, err
	}
	return frows, true, nil
}

// extractFor is the debug entry point: it forces the poppler extractor when
// requested, else uses the normal native-then-poppler order.
func extractFor(data []byte, forcePoppler bool) ([]prow, bool, error) {
	if forcePoppler {
		rows, err := pdftotextRows(data)
		return rows, true, err
	}
	return extractAny(data)
}

// parsePDF extracts text and parses geometry. The pure-Go rsc.io/pdf is tried
// first; poppler's pdftotext is the fallback both for files it cannot read
// (Acrobat Distiller, where it panics) AND for files it reads into garbage (a
// Word PDF whose coordinate glyphs decode to U+FFFD, e.g. 212/2025) — caught by
// the native pass finding no geometry. poppler is used only when it actually
// finds geometry; otherwise the native result (with its FIR/AD) stands, tagged
// pdf-extract-failed only when nothing could read the file at all.
func parsePDF(data []byte, nav navaidTable) geomResult {
	res := parsePDFRaw(data, nav)
	// The native extractor jams names (lost spaces) and leaves U+FFFD where a
	// font glyph is unmapped; respace zone names and the coordination block from
	// the layout text, then drop any coordination field still garbled.
	respaceDoc(&res, data)
	sanitizeResult(&res)
	return res
}

func parsePDFRaw(data []byte, nav navaidTable) geomResult {
	rows, nerr := extractRows(data)
	nativeRead := nerr == nil && len(rows) > 0
	var native geomResult
	if nativeRead {
		native = parseGeometry(rows, nav)
	}
	frows, ferr := pdftotextRows(data)
	popplerRead := ferr == nil && len(frows) > 0
	var pop geomResult
	if popplerRead {
		pop = parseGeometry(frows, nav)
	}
	// The native pass finding SOME geometry used to stand unconditionally,
	// which kept the whole answer when the native text was illegible for most
	// of a table (159/2026's prime marks vanish entirely, truncating both
	// rings to a third). Poppler now competes on richness: strictly more
	// zones, or the same zones read with strictly more boundary points.
	nativeGeom := nativeRead && native.source != "none"
	popGeom := popplerRead && pop.source != "none"
	if popGeom && (!nativeGeom || richerResult(pop, native)) {
		pop.warnings = append(pop.warnings, "pdf-poppler-fallback")
		sort.Strings(pop.warnings)
		return pop
	}
	if nativeGeom {
		return native
	}
	// No geometry from either reader: keep whichever read the file (for its
	// FIR/AD); only when neither could read it is it a genuine extract failure.
	switch {
	case nativeRead:
		return native
	case popplerRead:
		return pop
	default:
		return geomResult{source: "none", confidence: "none", warnings: []string{"pdf-extract-failed"}}
	}
}

// richerResult reports whether a's geometry is strictly richer than b's:
// more zones, or the same number read with more boundary points. Ties keep
// the native pass (the status quo, and its text feeds the respace step). At
// equal zone counts a circle may never degrade into rings on the way to
// "richer": a fused poppler row reads a circle's centre as ring vertices and
// the junk rings out-count the clean parse (083/2026's ZRT 1), so the parse
// with fewer circles loses however many points it carries.
func richerResult(a, b geomResult) bool {
	if len(a.zones) != len(b.zones) {
		return len(a.zones) > len(b.zones)
	}
	return geomPoints(a) > geomPoints(b) && circleCount(a) >= circleCount(b)
}

func circleCount(r geomResult) int {
	n := 0
	for _, z := range r.zones {
		if z.geom != nil && z.geom.kind == "circle" {
			n++
		}
	}
	return n
}

func geomPoints(r geomResult) int {
	n := 0
	for _, z := range r.zones {
		if z.geom == nil {
			continue
		}
		switch z.geom.kind {
		case "circle":
			n++
		case "multipolygon":
			for _, ring := range z.geom.rings {
				n += len(ring)
			}
		default:
			n += len(z.geom.ring)
		}
	}
	return n
}

// rowWarnings is the parse-quality codes plus, for a supplement recovered from
// the media store, the note that it never had a listing row: its subject and
// validity were read off the cover page, which predates any amendment the
// listing would have carried. Measured against the supplements whose listing
// values are known, the cover page agrees on 99 of 114 windows and is
// unreadable on 7, so the code marks data that is good but not authoritative.
func rowWarnings(s rawSup, gr geomResult) []string {
	if !s.swept {
		return gr.warnings
	}
	w := append(append([]string{}, gr.warnings...), "listing-absent")
	sort.Strings(w)
	return w
}

// buildRow emits one positional row in outputFields order. descEn is the
// English subject parsed from the _en.pdf (empty when there is none).
func buildRow(s rawSup, gr geomResult, descEn string) []any {
	urlEn := ""
	if len(s.pdfEn) > 0 {
		urlEn = pdfURL(enFilename(s.filename))
	}
	return []any{
		fmt.Sprintf("%s-%d-%03d", s.region, s.year, s.number), // id
		fmt.Sprintf("%03d/%d", s.number, s.year),              // title
		s.region,
		// The row-emit chokepoint rather than the listing parse: a refreshed
		// retained row carries the PREVIOUS artefact's subject, which may
		// still hold the escaping a past build stored.
		unescapeListing(s.descFr),
		descEn, // descriptionEn: from the parallel _en.pdf
		"",     // lieu: free-text not available without the API; see fir/adhp
		pdfURL(s.filename),
		s.validFrom,
		s.validTo,
		s.ifr,
		s.vfr,
		s.airac,
		emptyStrings(gr.fir),
		emptyStrings(gr.adhp),
		zonesJSON(gr.zones),
		bboxOrNull(gr.bbox),
		gr.source,
		gr.confidence,
		emptyStrings(rowWarnings(s, gr)),
		urlEn, // urlPdfEn
		contactsJSON(gr.contacts),
		penetrationOrNull(gr.penetration),
		gr.manager,
	}
}

func bboxOrNull(b []float64) any {
	if len(b) == 0 {
		return nil
	}
	return b
}

func tripleOrNull(t []string) any {
	if t == nil {
		return nil
	}
	return t
}

func hasWarning(ws []string, w string) bool {
	for _, x := range ws {
		if x == w {
			return true
		}
	}
	return false
}

func sanity(n, lo, hi int) error {
	if lo == 0 {
		lo = 20
	}
	if hi == 0 {
		hi = 500
	}
	if n < lo || n > hi {
		return fmt.Errorf("supaip: %d supplements outside sanity window [%d, %d]", n, lo, hi)
	}
	return nil
}
