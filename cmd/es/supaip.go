// supaip.go emits es-supaip.json: the Spanish AIP Supplements from
// ENAIRE's public listing, mirroring cmd/supaip's fr-supaip.json row
// schema exactly (api.go outputFields, 23 columns) so the SPA loader
// reads France, Belgium and Spain with one decoder.
//
// Two deliberate differences from the French pipeline:
//
//   - The dataset is REBUILT from the listing every run, never
//     accumulated. The SIA lists only what is in force and forgets a
//     lapsed supplement, so cmd/supaip retains delisted rows verbatim to
//     stay the durable record. ENAIRE instead delists a supplement when
//     it is CANCELLED (each one names its predecessor, "CANCELAR: SUP
//     135/26") while leaving expired-but-uncancelled ones listed with an
//     EST end date. Delisting is therefore the kill signal here, and
//     retaining a delisted row would keep a cancelled reservation
//     drawing until its stated end date.
//   - Zones carry no activation schedules. Spanish supplements delegate
//     the daily windows to NOTAM and the AUP/UUP ("La activacion de
//     dichas areas, asi como el establecimiento del horario diario, se
//     realizara mediante la publicacion de NOTAM"), so a zone displays
//     on its supplement's validity and on NOTAM activation, which is
//     what state/supaip.svelte.ts already does when activations is
//     empty.

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/eaip"
)

const (
	defaultMinEsSup = 150
	defaultMaxEsSup = 400

	// esSupParserVersion bumps when the extractor changes, the fr/be
	// convention for tracking parse-coverage regressions.
	// 2: corridors buffered from their centreline, bulleted positions
	// never a ring without a lateral marker, obstacle-table header and
	// coordinate-form tolerance, radius adjacency and cap, EST end dates
	// open while in force.
	esSupParserVersion = 2
)

// esSupOutputFields mirrors cmd/supaip/api.go's outputFields.
var esSupOutputFields = []string{
	"id", "title", "region", "descriptionFr", "descriptionEn", "lieu",
	"urlPdf", "validFrom", "validTo", "ifr", "vfr", "airac", "fir", "adhp",
	"zones", "bbox", "geometrySource", "parseConfidence", "warnings",
	"urlPdfEn",
	"contacts", "penetration", "manager",
}

// EsSupArtifact is the es-supaip.json document.
type EsSupArtifact struct {
	Fields []string `json:"fields"`
	Rows   []any    `json:"rows"`
}

// EsSupMeta is the es-supaip.meta.json document.
type EsSupMeta struct {
	GeneratedAt      string          `json:"generatedAt"`
	Source           esSupSourceMeta `json:"source"`
	Total            int             `json:"total"`
	Active           int             `json:"active"`
	Upcoming         int             `json:"upcoming"`
	WithGeometry     int             `json:"withGeometry"`
	WithVertical     int             `json:"withVertical"`
	WithEnglish      int             `json:"withEnglish"`
	Polygon          int             `json:"polygon"`
	Circle           int             `json:"circle"`
	Mixed            int             `json:"mixed"`
	None             int             `json:"none"`
	PdfFallbacks     int             `json:"pdfFallbacks"`
	PdftotextMissing int             `json:"pdftotextMissing"`
	DocsMissing      int             `json:"docsMissing"`
	EstimatedEnd     int             `json:"estimatedEnd"`
	ByRegion         map[string]int  `json:"byRegion"`
	Warnings         map[string]int  `json:"warnings"`
	ParserVersion    int             `json:"parserVersion"`
}

type esSupSourceMeta struct {
	Site        string            `json:"site"`
	ListingShas map[string]string `json:"listingShas,omitempty"`
}

// buildEsSupaip turns the acquired corpus into the artefact + meta.
func buildEsSupaip(c *esCorpus, rows []esListingRow, now func() time.Time, minN, maxN int) (EsSupArtifact, EsSupMeta, error) {
	if now == nil {
		now = time.Now
	}
	if minN == 0 {
		minN = defaultMinEsSup
	}
	if maxN == 0 {
		maxN = defaultMaxEsSup
	}

	meta := EsSupMeta{
		GeneratedAt:   now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Source:        esSupSourceMeta{Site: esAipBase + esSupListEs, ListingShas: map[string]string{}},
		ByRegion:      map[string]int{},
		Warnings:      map[string]int{},
		ParserVersion: esSupParserVersion,
	}
	if len(c.listingEs) > 0 {
		meta.Source.ListingShas["es"] = shaOf(c.listingEs)
	}
	if len(c.listingEn) > 0 {
		meta.Source.ListingShas["en"] = shaOf(c.listingEn)
	}

	out := make([]any, 0, len(rows))
	for _, r := range rows {
		body, warns := readSupBody(c, r, &meta)
		if body.estEnd {
			meta.EstimatedEnd++
		}

		subjectEs := r.subjectEs
		if subjectEs == "" {
			subjectEs = r.subjectEn
		}

		validFrom, validTo := body.validFrom, body.validTo
		if validFrom == "" {
			// A supplement whose body did not parse still has the
			// listing's own effectivity date; an absent end date reads
			// as open-ended downstream, which is the safe side.
			validFrom = r.wef
		} else if r.wef != "" && r.wef != validFrom {
			warns = append(warns, "wef-mismatch")
		}
		if body.estEnd && r.inForce {
			// An ESTIMATED end date on a supplement the listing still
			// carries IN FORCE is no end date: ENAIRE keeps such a
			// supplement listed past it ("SUP EST, solo se cancelara por
			// NOTAM, SUP o enmienda al AIP") and delisting is the kill
			// signal here, so the row reads open-ended until then.
			// Otherwise the standing 152/20 transit corridor, whose
			// estimated end lapsed in 2021, would draw nothing.
			validTo = ""
		}

		zones := make([]any, 0, len(body.zones))
		var bbox []float64
		nPoly, nCircle := 0, 0
		withVertical := false
		for _, z := range body.zones {
			zones = append(zones, map[string]any{
				"name":           z.name,
				"geometry":       z.geom,
				"bbox":           z.bbox,
				"lower":          z.lower,
				"upper":          z.upper,
				"geometrySource": z.source,
			})
			bbox = unionBbox(bbox, z.bbox)
			if z.lower != nil || z.upper != nil {
				withVertical = true
			}
			if t, _ := z.geom["type"].(string); t == "circle" {
				nCircle++
			} else {
				nPoly++
			}
		}

		geometrySource := "none"
		switch {
		case nPoly > 0 && nCircle > 0:
			geometrySource = "html-mixed"
			meta.Mixed++
			meta.WithGeometry++
		case nPoly > 0:
			geometrySource = "html-polygon"
			meta.Polygon++
			meta.WithGeometry++
		case nCircle > 0:
			geometrySource = "html-position"
			meta.Circle++
			meta.WithGeometry++
		default:
			meta.None++
		}
		if withVertical {
			meta.WithVertical++
		}
		if r.subjectEn != "" {
			meta.WithEnglish++
		}
		if r.inForce {
			meta.Active++
		} else {
			meta.Upcoming++
		}
		meta.ByRegion["es"]++
		for _, w := range warns {
			meta.Warnings[w]++
		}

		subject := subjectEs
		if subject == "" {
			subject = r.subjectEn
		}
		out = append(out, []any{
			r.id(),      // id
			r.title(),   // title
			"es",        // region
			subjectEs,   // descriptionFr: the local-language subject
			r.subjectEn, // descriptionEn
			"",          // lieu
			r.pdfEs,     // urlPdf
			nullableStr(validFrom),
			nullableStr(validTo),
			true, // ifr (the listing carries no flight-rule flags)
			true, // vfr
			r.airac,
			esFirsFor(subject, body.text, esAdhpFor(subject)), // fir
			esAdhpFor(subject),   // adhp
			zones,                // zones
			bbox,                 // bbox (nil marshals to null)
			geometrySource,       // geometrySource
			"listing+html",       // parseConfidence
			uniqueStrings(warns), // warnings
			r.pdfEn,              // urlPdfEn
			[]any{},              // contacts
			nil,                  // penetration
			"",                   // manager
		})
	}

	meta.Total = len(out)
	if n := len(out); n < minN || n > maxN {
		return EsSupArtifact{}, EsSupMeta{}, fmt.Errorf(
			"ES supplement count %d outside sanity window [%d, %d] - source format may have changed",
			n, minN, maxN)
	}
	// The sanity window counts LISTING rows, which a transient upstream
	// failure leaves intact while every per-document fetch fails: 234
	// geometry-less rows would pass it and the workflow would commit an
	// overlay where every reservation has disappeared. A missing document
	// is a refused build past a small tolerance (one or two 404s on a
	// listing of 234 are the source's own).
	if len(out) > 0 && meta.DocsMissing*20 > len(out) {
		return EsSupArtifact{}, EsSupMeta{}, fmt.Errorf(
			"ES supplements: %d of %d documents could not be fetched - refusing to publish a partial overlay",
			meta.DocsMissing, len(out))
	}
	return EsSupArtifact{Fields: esSupOutputFields, Rows: out}, meta, nil
}

// geometryCollapsed reports whether the fresh build lost more than half
// the geometry the previously committed meta recorded: the failure mode
// a listing-count window cannot see (every document fetched, none of
// them readable after a template change). A missing or unreadable
// previous meta means no comparison.
func geometryCollapsed(prevMetaPath string, fresh EsSupMeta) bool {
	data, err := os.ReadFile(prevMetaPath)
	if err != nil {
		return false
	}
	var prev struct {
		WithGeometry int `json:"withGeometry"`
	}
	if json.Unmarshal(data, &prev) != nil || prev.WithGeometry == 0 {
		return false
	}
	return fresh.WithGeometry*2 < prev.WithGeometry
}

// readSupBody parses one supplement's document, whichever form reached
// the corpus, and counts the degradations in meta.
func readSupBody(c *esCorpus, r esListingRow, meta *EsSupMeta) (esBody, []string) {
	url := r.bodyURL()
	data, name := c.doc(url)
	if len(data) == 0 {
		meta.DocsMissing++
		return esBody{}, []string{"document-not-fetched"}
	}
	subject := r.subjectEs
	if subject == "" {
		subject = r.subjectEn
	}

	if isPDF(data) || strings.HasSuffix(name, ".pdf") {
		meta.PdfFallbacks++
		text, err := pdfLayoutText(data)
		if err != nil {
			meta.PdftotextMissing++
			fmt.Fprintf(os.Stderr, "es: sup %s: %v\n", r.title(), err)
			return esBody{}, []string{"pdftotext-unavailable"}
		}
		b := parseSupDocument(blocksFromText(text), text, subject)
		return b, append(b.warnings, "pdf-fallback")
	}
	// A pre-rendered `pdftotext -layout` capture, which is what the Go
	// tests carry instead of a PDF binary: the same path, one step
	// further along, so it counts as the same fallback.
	if strings.HasSuffix(name, ".txt") {
		meta.PdfFallbacks++
		text := string(data)
		b := parseSupDocument(blocksFromText(text), text, subject)
		return b, append(b.warnings, "pdf-fallback")
	}

	doc, err := eaip.ParseHTML(data)
	if err != nil {
		return esBody{}, []string{"document-unparseable"}
	}
	if s := docSubject(doc); s != "" {
		subject = s
	}
	b := parseSupDocument(blocksFromHTML(doc), docText(doc), subject)
	return b, b.warnings
}

func shaOf(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func nullableStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func uniqueStrings(in []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, s := range in {
		if s == "" || seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	return out
}

// buildSupaipDataset acquires the supplement corpus and writes
// es-supaip.json + es-supaip.meta.json. Supplements are not AIRAC-sliced,
// so there is no .next twin, exactly as for fr-supaip and be-supaip.
func buildSupaipDataset(outDir, snapshotIn, snapshotOut string, now func() time.Time, minN, maxN int) error {
	var (
		c    *esCorpus
		rows []esListingRow
		err  error
	)
	if snapshotIn != "" {
		c, rows, err = acquireEsSupOffline(snapshotIn)
	} else {
		c, rows, err = acquireEsSupLive(context.Background(), snapshotOut)
	}
	if err != nil {
		return err
	}
	artifact, meta, err := buildEsSupaip(c, rows, now, minN, maxN)
	if err != nil {
		return err
	}
	if geometryCollapsed(outDir+"/es-supaip.meta.json", meta) {
		return fmt.Errorf(
			"ES supplements: geometry collapsed to %d rows against the committed dataset - refusing to publish",
			meta.WithGeometry)
	}
	if err := aip.WriteCompactJSON(outDir+"/es-supaip.json", artifact); err != nil {
		return err
	}
	if err := aip.WritePrettyJSON(outDir+"/es-supaip.meta.json", meta); err != nil {
		return err
	}
	fmt.Printf("wrote %d ES supplements (%d active, %d upcoming, %d with geometry, %d pdf fallbacks)\n",
		meta.Total, meta.Active, meta.Upcoming, meta.WithGeometry, meta.PdfFallbacks)
	return nil
}
