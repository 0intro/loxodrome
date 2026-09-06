// parse.go decodes EUROCONTROL pruatlas FIR GeoJSON (`ir-524.geojson`
// shape) into normalised airspace rows. Only FIR and UIR records are kept;
// pruatlas doesn't carry tactical airspaces (CTR / TMA / SUA), so this is
// the "FIR-only" branch of the per-source policy.

package main

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/0intro/loxodrome/internal/overlay"
)

// icaoPattern matches a clean 4-letter ICAO designator. Skipping non-ICAO
// pruatlas entries (e.g. "ZZZZ" placeholders, "XX*" testing codes) keeps
// the autorouter's `itemas` list free of values it would 400 on.
var icaoPattern = regexp.MustCompile(`^[A-Z]{4}$`)

type pruFeature struct {
	Type       string `json:"type"`
	Properties struct {
		AiracCfmu    int    `json:"airac_cfmu"`
		AirspaceType string `json:"airspace_type"`
		Code         string `json:"code"`
		Name         string `json:"name"`
		Icao         string `json:"icao"`
		MinFL        int    `json:"min_fl"`
		MaxFL        int    `json:"max_fl"`
	} `json:"properties"`
	Geometry json.RawMessage `json:"geometry"`
}

type pruCollection struct {
	Type     string       `json:"type"`
	Features []pruFeature `json:"features"`
}

// parsePruatlas returns the FIR/UIR rows plus the AIRAC cycle the file
// claims (the maximum airac_cfmu value across features; pruatlas files
// always share one cycle, but max-of-set is robust against any oddity).
func parsePruatlas(data []byte) ([]overlay.Row, int, error) {
	if len(data) == 0 {
		return nil, 0, nil
	}
	var coll pruCollection
	if err := json.Unmarshal(data, &coll); err != nil {
		return nil, 0, fmt.Errorf("decode pruatlas: %w", err)
	}
	var rows []overlay.Row
	cycle := 0
	for _, f := range coll.Features {
		if f.Properties.AiracCfmu > cycle {
			cycle = f.Properties.AiracCfmu
		}
		typ := strings.ToUpper(strings.TrimSpace(f.Properties.AirspaceType))
		if typ != "FIR" && typ != "UIR" {
			continue
		}
		// Pruatlas codes are 7-char like "AGGGFIR" / "EDUUUIR"; strip the
		// trailing FIR/UIR suffix to recover the 4-letter ICAO designator.
		// Already-4-char codes are kept as-is.
		code := strings.ToUpper(strings.TrimSpace(f.Properties.Code))
		code = strings.TrimSuffix(code, typ)
		if !icaoPattern.MatchString(code) {
			continue
		}
		rings, err := overlay.GeomToRings(f.Geometry)
		if err != nil || len(rings) == 0 {
			continue
		}
		upper := flTriple(f.Properties.MaxFL)
		lower := flTriple(f.Properties.MinFL)
		for _, r := range rings {
			rows = append(rows, overlay.Row{
				ID:    code,
				Type:  typ,
				Name:  f.Properties.Name,
				Class: "",
				Upper: upper,
				Lower: lower,
				Ring:  r,
			})
		}
	}
	return rows, cycle, nil
}

// flTriple converts a numeric flight-level band into the SIA-compatible
// [code, val, uom] triple. FL 0 / negative becomes SFC; the 999 sentinel
// pruatlas uses for "unlimited" becomes the explicit UNL triple, which the
// client renders "UNL" and treats as an unbounded ceiling.
func flTriple(fl int) []string {
	if fl <= 0 {
		return []string{"SFC", "", ""}
	}
	if fl >= 999 {
		return []string{"UNL", "", ""}
	}
	return []string{"STD", strconv.Itoa(fl), "FL"}
}
