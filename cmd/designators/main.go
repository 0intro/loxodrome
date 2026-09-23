// Command designators extracts the ICAO aircraft type designators from the
// FAA Order JO 7360.1 PDF ("Aircraft Type Designators") and emits
// faa-designators.json plus faa-designators.meta.json: the designator set
// the SPA validates aircraft icaoType fields against, and the
// (designator, manufacturer, model) tuples behind the aircraft editor's
// suggestions. ICAO Doc 8643 itself is not redistributable (ICAO sells that
// dataset); the FAA order is a US Government work (17 U.S.C. 105, public
// domain) carrying the same designators for the types commonly receiving
// ATC services, a subset of Doc 8643.
//
// Refresh is manual, roughly annual (a new order edition; NOT one of the
// auto-refreshed datasets): download the current PDF from
// https://www.faa.gov/regulations_policies/orders_notices/index.cfm/go/document.current/documentNumber/7360.1
// and run, from the repo root:
//
//	go run ./cmd/designators -in FAA_Order_JO_7360.1K_Aircraft_Type_Designators.pdf \
//	    -edition "JO 7360.1K" -effective 2025-04-10
//
// pdftotext (poppler-utils) must be on PATH, the cmd/supaip dependency.
package main

import (
	"bytes"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/0intro/loxodrome/internal/aip"
)

// The order's document page (stable across editions; the per-edition PDF
// URL carries the edition letter, so the meta records the page).
const defaultSource = "https://www.faa.gov/regulations_policies/orders_notices/index.cfm/go/document.current/documentNumber/7360.1"

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	in := flag.String("in", "", "FAA Order JO 7360.1 PDF (required)")
	outDir := flag.String("out", "public/data", "output directory for faa-designators.json and faa-designators.meta.json (run from the repo root)")
	edition := flag.String("edition", "JO 7360.1K", "order edition recorded in the meta sidecar")
	effective := flag.String("effective", "2025-04-10", "order effective date recorded in the meta sidecar")
	source := flag.String("source", defaultSource, "source URL recorded in the meta sidecar")
	flag.Parse()
	if *in == "" {
		return fmt.Errorf("missing -in <pdf>")
	}

	text, err := pdftotextLayout(*in)
	if err != nil {
		return err
	}

	res, err := buildArtifact(text, Options{
		Edition:   *edition,
		Effective: *effective,
		Source:    *source,
	})
	if err != nil {
		return err
	}

	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		return err
	}
	if err := aip.WriteCompactJSON(filepath.Join(*outDir, "faa-designators.json"), res.Artifact); err != nil {
		return err
	}
	if err := aip.WritePrettyJSON(filepath.Join(*outDir, "faa-designators.meta.json"), res.Meta); err != nil {
		return err
	}

	fmt.Printf("wrote %d designators, %d model rows (%s, effective %s)\n",
		res.Meta.DesignatorCount, res.Meta.ModelCount, res.Meta.Edition, res.Meta.EffectiveDate)
	if orphans := codesWithoutTuples(res.Artifact); len(orphans) > 0 {
		fmt.Printf("%d designators have no model row (kept in the set): %s\n",
			len(orphans), strings.Join(orphans, " "))
	}
	return nil
}

// pdftotextLayout extracts the order's text with poppler's pdftotext in
// -layout mode, which preserves the table columns as runs of spaces (the
// cmd/supaip external dependency; a missing binary is a plain error).
func pdftotextLayout(path string) (string, error) {
	cmd := exec.Command("pdftotext", "-layout", path, "-")
	var out, errb bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errb
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("pdftotext: %w: %s", err, strings.TrimSpace(errb.String()))
	}
	return out.String(), nil
}
