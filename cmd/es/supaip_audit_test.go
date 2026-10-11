// supaip_audit_test.go: an env-gated audit of the WHOLE Spanish
// supplement corpus, the cmd/supaip audit_test.go pattern.
//
// The unit tests pin seven documents. This one runs the grammar over
// every supplement ENAIRE currently lists and checks the invariants that
// must hold for all of them, chiefly the one the fixtures can only
// sample: that no coordinate reaches a zone from outside a boundary
// declaration. Populate the cache with
//
//	go run ./cmd/es -only=supaip -sup-snapshot local/es-sup-cache
//	ES_SUPAIP_AUDIT=../../local/es-sup-audit go test ./cmd/es -run TestAuditCorpus -v
//
// The report path is relative to the PACKAGE directory, which is where
// `go test` runs, so it needs the ../.. to land in the gitignored
// repo-root local/.

package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"
)

const esAuditCache = "../../local/es-sup-cache"

type auditZone struct {
	Supplement string `json:"supplement"`
	Subject    string `json:"subject"`
	Zone       string `json:"zone"`
	Kind       string `json:"kind"`
	Points     int    `json:"points"`
	Lower      any    `json:"lower"`
	Upper      any    `json:"upper"`
}

type auditReport struct {
	GeneratedAt  string         `json:"generatedAt"`
	Total        int            `json:"total"`
	WithGeometry int            `json:"withGeometry"`
	Warnings     map[string]int `json:"warnings"`
	// Per supplement, so a histogram entry can be traced to its document.
	RowWarnings map[string][]string `json:"rowWarnings"`
	Zones       []auditZone         `json:"zones"`
}

func TestAuditCorpus(t *testing.T) {
	dir := os.Getenv("ES_SUPAIP_AUDIT")
	if dir == "" {
		t.Skip("set ES_SUPAIP_AUDIT=<report dir> to audit the cached corpus")
	}
	if _, err := os.Stat(esAuditCache); err != nil {
		t.Skipf("no corpus at %s: run cmd/es -only=supaip -sup-snapshot first", esAuditCache)
	}
	c, rows, err := acquireEsSupOffline(esAuditCache)
	if err != nil {
		t.Fatalf("acquireEsSupOffline: %v", err)
	}
	art, meta, err := buildEsSupaip(c, rows, time.Now, 1, 10000)
	if err != nil {
		t.Fatalf("buildEsSupaip: %v", err)
	}

	rep := auditReport{
		GeneratedAt:  time.Now().UTC().Format(time.RFC3339),
		Total:        meta.Total,
		WithGeometry: meta.WithGeometry,
		Warnings:     meta.Warnings,
		RowWarnings:  map[string][]string{},
	}

	for _, r := range art.Rows {
		cells := r.([]any)
		title, _ := cells[1].(string)
		subject, _ := cells[3].(string)
		zones, _ := cells[14].([]any)
		rowBox, _ := cells[15].([]float64)
		if ws, _ := cells[18].([]string); len(ws) > 0 {
			rep.RowWarnings[title] = ws
		}

		for _, z := range zones {
			zm := z.(map[string]any)
			g, _ := zm["geometry"].(map[string]any)
			kind, _ := g["type"].(string)
			name, _ := zm["name"].(string)
			box, _ := zm["bbox"].([]float64)

			// Every zone must be addressable and drawable.
			if name == "" {
				t.Errorf("%s: a zone has no name", title)
			}
			if len(box) != 4 {
				t.Errorf("%s / %s: no bbox", title, name)
			}

			pts := 0
			check := func(ring []any) {
				pts += len(ring)
				if len(ring) < 4 {
					t.Errorf("%s / %s: ring of %d points", title, name, len(ring))
				}
				if len(ring) > 0 && ring[0].([2]float64) != ring[len(ring)-1].([2]float64) {
					t.Errorf("%s / %s: unclosed ring", title, name)
				}
				for _, p := range ring {
					pt := p.([2]float64)
					// Spain, the outer sanity box: anything outside is a
					// misread column or a swapped pair.
					if pt[0] < esMinLat || pt[0] > esMaxLat || pt[1] < esMinLon || pt[1] > esMaxLon {
						t.Errorf("%s / %s: vertex %v outside Spain", title, name, pt)
					}
					if len(box) == 4 && (pt[0] < box[0]-1e-6 || pt[0] > box[2]+1e-6 || pt[1] < box[1]-1e-6 || pt[1] > box[3]+1e-6) {
						t.Errorf("%s / %s: vertex %v outside its bbox %v", title, name, pt, box)
					}
					if len(rowBox) == 4 && (pt[0] < rowBox[0]-1e-6 || pt[0] > rowBox[2]+1e-6) {
						t.Errorf("%s / %s: vertex %v outside the row bbox %v", title, name, pt, rowBox)
					}
				}
			}
			switch kind {
			case "polygon":
				ring, _ := g["ring"].([]any)
				check(ring)
			case "multipolygon":
				rings, _ := g["rings"].([]any)
				for _, r := range rings {
					check(r.([]any))
				}
			case "circle":
				if rad, _ := g["radiusM"].(float64); rad <= 0 {
					t.Errorf("%s / %s: circle radius %v", title, name, g["radiusM"])
				}
			default:
				t.Errorf("%s / %s: unknown geometry kind %q", title, name, kind)
			}

			rep.Zones = append(rep.Zones, auditZone{
				Supplement: title, Subject: subject, Zone: name,
				Kind: kind, Points: pts, Lower: zm["lower"], Upper: zm["upper"],
			})
		}
	}

	sort.Slice(rep.Zones, func(i, j int) bool {
		if rep.Zones[i].Supplement != rep.Zones[j].Supplement {
			return rep.Zones[i].Supplement < rep.Zones[j].Supplement
		}
		return rep.Zones[i].Zone < rep.Zones[j].Zone
	})
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	out, _ := json.MarshalIndent(rep, "", "  ")
	if err := os.WriteFile(filepath.Join(dir, "es-supaip-audit.json"), out, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Logf("audited %d supplements, %d with geometry, %d zones; report in %s",
		rep.Total, rep.WithGeometry, len(rep.Zones), dir)
}
