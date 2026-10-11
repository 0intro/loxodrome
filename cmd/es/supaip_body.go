// supaip_body.go: read one supplement's own document, whatever form it
// takes, into the fields the row schema needs beyond the listing.
//
// The validity span and the cancellation live in the ENAIRE template's
// header block, outside <main>, and older supplements predate the
// template entirely. Both are therefore read as TEXT regexes over the
// whole document rather than through the template's data-plantilla
// attributes, so a template-less edition and a pdftotext rendering parse
// the same way.

package main

import (
	"regexp"
	"strings"

	"github.com/0intro/loxodrome/internal/eaip"
)

var (
	// "03SEP26/21SEP26", "14MAY26/14MAY27EST": the effectivity span the
	// supplement prints beside its own number. EST marks an estimated
	// end date, which the SIA convention also uses; the date itself is
	// what the display window needs, so the marker is recorded as a
	// warning and stripped.
	esPeriodRe = regexp.MustCompile(`\b(\d{2})([A-Z]{3})(\d{2})\s*/\s*(\d{2})([A-Z]{3})(\d{2})(EST)?\b`)

	esFirMadridRe = regexp.MustCompile(`(?i)\bFIR\s*/?\s*(?:UIR)?\s*MADRID\b|\bMADRID\s+FIR\b`)
	esFirBcnRe    = regexp.MustCompile(`(?i)\bFIR\s*/?\s*(?:UIR)?\s*BARCELONA\b|\bBARCELONA\s+FIR\b`)
	esFirCanRe    = regexp.MustCompile(`(?i)\bCANARIAS\b|\bCANARY\b`)
	esGcIdentRe   = regexp.MustCompile(`\bGC[A-Z]{2}\b`)
)

// esBody is what one supplement document yields.
type esBody struct {
	validFrom string
	validTo   string
	// estEnd records the AIP's own "EST" marker on the end date. It is
	// counted in the meta but deliberately NOT a row warning: the panel
	// prints warnings as parse notes, and an estimated end date is what
	// ENAIRE published (97% of the corpus carries one), not a defect in
	// reading it.
	estEnd   bool
	text     string // the document's own text, for the FIR derivation
	zones    []esZone
	warnings []string
}

// parseSupDocument reads a supplement from its linearized blocks plus the
// document's full text (the header block sits outside the body scope).
func parseSupDocument(blocks []esBlock, fullText, subject string) esBody {
	var b esBody
	b.text = fullText
	zones, warns := parseSupZones(blocks, subject)
	b.zones = zones
	b.warnings = warns

	if m := esPeriodRe.FindStringSubmatch(strings.ToUpper(eaip.NormSpace(fullText))); m != nil {
		b.validFrom = isoFromDMY(m[1], m[2], m[3])
		b.validTo = isoFromDMY(m[4], m[5], m[6])
		b.estEnd = m[7] != ""
	}
	return b
}

// docText returns the whole visible text of a parsed page.
func docText(doc *eaip.Node) string {
	if doc == nil {
		return ""
	}
	return eaip.NodeText(doc)
}

// docSubject returns the supplement's own title, the <h2> the template
// puts at the head of <main>. "" when the document has none, in which
// case the listing's subject stands.
func docSubject(doc *eaip.Node) string {
	root := firstElem(doc, "main")
	if root == nil {
		root = doc
	}
	for _, h := range eaip.Elems(root, "h2") {
		if t := strings.TrimSpace(eaip.NodeText(h)); t != "" {
			return t
		}
	}
	return ""
}

// esFirsFor maps a supplement onto the Spanish FIRs it concerns. The
// subject names one ("FIR MADRID.- Parque Eolico ...", "CANARIAS FIR
// (GCCC).- ..."); failing that, the aerodromes it names place it (a
// Canarian field is GCCC's, a peninsular one is in Madrid's or
// Barcelona's, which the ident cannot tell apart); a supplement naming
// neither concerns the country, so all three are listed rather than
// none, which would orphan it.
func esFirsFor(subject, body string, adhp []string) []string {
	s := subject + " " + body
	var out []string
	if esFirMadridRe.MatchString(s) {
		out = append(out, "LECM")
	}
	if esFirBcnRe.MatchString(s) {
		out = append(out, "LECB")
	}
	if esFirCanRe.MatchString(s) || esGcIdentRe.MatchString(strings.ToUpper(subject)) {
		out = append(out, "GCCC")
	}
	if len(out) > 0 {
		return out
	}
	canary, peninsula := false, false
	for _, a := range adhp {
		if strings.HasPrefix(a, "GC") {
			canary = true
		} else {
			peninsula = true
		}
	}
	switch {
	case canary && !peninsula:
		return []string{"GCCC"}
	case peninsula && !canary:
		return []string{"LECM", "LECB"}
	}
	return []string{"LECM", "LECB", "GCCC"}
}

// The Spanish FIR / UIR / ACC indicators, ICAO-shaped like an aerodrome
// and printed in the same subjects ("CANARIAS FIR (GCCC).- ..."), which
// the aerodrome list must not carry.
var esFirIdents = map[string]bool{"LECM": true, "LECB": true, "GCCC": true, "LECS": true}

// esAdhpFor lists the aerodromes the subject names ("SANTIAGO/Rosalia de
// Castro AD (LEST).- ..."), the link the airport panel reads.
func esAdhpFor(subject string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, m := range esIcaoRe.FindAllString(strings.ToUpper(subject), -1) {
		if !seen[m] && !esFirIdents[m] {
			seen[m] = true
			out = append(out, m)
		}
	}
	return out
}
