package main

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"
)

// TestAuditCorpus re-reads every plate on disk and reports, per panel, what
// the fit found and how far the aerodrome landed from the panel centre. It
// is the only test that sees the whole corpus, so it is the one that
// notices a change of behaviour the unit tests cannot: a label form that
// stops parsing, a frame rule that starts swallowing headers, a cycle whose
// artwork moved.
//
//	VACGEO_AUDIT=/tmp/vacgeo go test ./cmd/vacgeo -run TestAuditCorpus
//
// It is env-gated because it needs the 170 MB plate cache cmd/aipdocs
// fills, which is per-machine and gitignored, and because a thousand-page
// sweep has no business in `go test ./...`.
func TestAuditCorpus(t *testing.T) {
	outDir := os.Getenv("VACGEO_AUDIT")
	if outDir == "" {
		t.Skip("set VACGEO_AUDIT=<report dir> to sweep the plate cache")
	}
	dataDir := filepath.Join("..", "..", "public", "data")
	cacheDir := filepath.Join("..", "..", "local", "aipdocs-cache")
	if _, err := os.Stat(filepath.Join(cacheDir, "vac")); err != nil {
		t.Skipf("no plate cache: %v", err)
	}
	ov, err := loadOverrides("overrides.tsv")
	if err != nil {
		t.Fatal(err)
	}
	art, meta, err := build(dataDir, cacheDir, filepath.Join(dataDir, "fr-adcharts.json"), "", ov,
		func(string) bool { return true })
	if err != nil {
		t.Fatal(err)
	}

	if err := os.MkdirAll(outDir, 0o755); err != nil {
		t.Fatal(err)
	}
	f, err := os.Create(filepath.Join(outDir, "vacgeo-audit.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	enc := json.NewEncoder(f)

	var devs, rmss, arps []float64
	var resids []float64
	var anchored int
	for _, r := range art.Rows {
		row := r.([]any)
		q := row[10].(quality)
		if err := enc.Encode(map[string]any{
			"ident": row[0], "section": row[1], "page": row[2], "kind": row[3],
			"clip": row[4], "sw": row[5], "ne": row[6], "aff": row[9], "quality": q,
		}); err != nil {
			t.Fatal(err)
		}
		devs = append(devs, math.Abs(q.DevPct))
		rmss = append(rmss, q.RMS)
		arps = append(arps, q.ARPm)
		if q.AnchorResidM > 0 || q.AnchorM > 0 {
			anchored++
			resids = append(resids, q.AnchorResidM)
		}
	}
	t.Logf("panels %d over %d aerodromes, from %d plates; %v by %v",
		meta.Panels, meta.Aerodromes, meta.Plates, meta.ByKind, meta.ByMethod)
	t.Logf("failures %v", meta.ByReason)
	t.Logf("|dev| median %.3f%% p99 %.3f%%; comb rms median %.3f pt p99 %.3f pt",
		pctl(devs, .5), pctl(devs, .99), pctl(rmss, .5), pctl(rmss, .99))

	// Floors, set a little under what the 2026-08-06 cycle produces. They
	// are a regression alarm, not a target: a change that drops coverage
	// or lets the projection check slide has to be deliberate.
	if meta.Panels < 765 {
		t.Errorf("panels %d, want >= 765", meta.Panels)
	}
	if meta.Aerodromes < 603 {
		t.Errorf("aerodromes %d, want >= 603", meta.Aerodromes)
	}
	// The runway fit is the only way a ground-movement chart is placed at
	// all, so losing it would show up nowhere else.
	if meta.ByMethod["runway"] < 35 {
		t.Errorf("runway fits %d, want >= 35", meta.ByMethod["runway"])
	}
	if got := pctl(devs, .99); got > 2.0 {
		t.Errorf("p99 |dev| %.3f%%, want <= 2%%", got)
	}
	if got := pctl(rmss, .99); got > 0.6 {
		t.Errorf("p99 comb rms %.3f pt, want <= 0.6", got)
	}
	// The gate is meant to catch a handful, not a third of the corpus: a
	// jump means the reader has started misreading labels wholesale.
	if meta.GateRejected > 8 {
		t.Errorf("gate rejected %d panels, want <= 8", meta.GateRejected)
	}
	// The runway anchor is what puts a panel that fitted perfectly in the
	// wrong place back where it belongs, and its own residual is what says
	// the shape it moved onto really was the runway. Losing it would
	// silently restore the misses it corrects.
	t.Logf("runway-anchored %d panels; post-move end residual median %.0f m p99 %.0f m",
		anchored, pctl(resids, .5), pctl(resids, .99))
	if anchored < 250 {
		t.Errorf("runway-anchored %d panels, want >= 250", anchored)
	}
	if got := pctl(resids, .99); got > float64(maxAnchorResidM) {
		t.Errorf("p99 post-move residual %.0f m, want <= %d", got, maxAnchorResidM)
	}
}

func pctl(v []float64, p float64) float64 {
	if len(v) == 0 {
		return 0
	}
	s := append([]float64(nil), v...)
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
	i := int(float64(len(s)-1) * p)
	return s[i]
}
