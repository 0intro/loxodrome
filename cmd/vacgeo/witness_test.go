// The corpus witness.
//
// Every alignment fault this dataset has had was found by a person looking
// at one chart over imagery: a clip that kept the whole page, a comb a third
// of a step out of phase, a scale bar measured between its labels instead of
// along its ink, a frame the cutter could not see. Four faults, four pairs
// of eyes, one at a time. This sweeps all 847 panels and reports how far
// each one's own line work sits from the ground it claims, so the fifth is
// found by reading a list.
//
// IT OBSERVES. IT NEVER PLACES. See witnessguard_test.go for why that is
// enforced by the compiler and not by discipline.
//
//	VACGEO_WITNESS=local/vacgeo-witness go test ./cmd/vacgeo -run TestWitnessCorpus -v -timeout 3h
//	VACGEO_WITNESS_ONLY=LF075,LFPD   narrow to these idents
//	VACGEO_WITNESS_OFFLINE=1         the reference cache only, no network
package main

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"testing"

	"rsc.io/pdf"
)

// witnessVersion stamps a cached panel reading. Bump it when any threshold
// below changes, so a resumed sweep re-reads rather than mixing two
// instruments in one report.
const witnessVersion = 9

// Past this many metres of ground to the page point, a plate's line work is
// cartographically GENERALISED: one paper millimetre is more ground than any
// fault worth reporting, and the sheet's roads and towns are drawn for
// legibility rather than position. 253 of the 847 panels are approach sheets
// at 1:60 000 and coarser, and this instrument has nothing to say about
// them AGAINST THE FINE REFERENCE, which is footprints and aprons.
//
// They are measured against a coarse one instead (bdtopoCoarse), because
// what such a sheet draws is still surveyed, it is just bigger: the
// built-up areas, the coast, the rivers, the railways. Past maxCoarseMPerPt
// even that goes, and saying so is the honest answer; a low-confidence
// number would not be.
const (
	maxWitnessMPerPt = 20
	maxCoarseMPerPt  = 200
)

// witnessRow is one panel's reading.
type witnessRow struct {
	Ident   string  `json:"ident"`
	Section int     `json:"section"`
	Page    int     `json:"page"`
	Kind    string  `json:"kind"`
	Method  string  `json:"method"`
	Lat     float64 `json:"lat"`
	Lon     float64 `json:"lon"`
	SpanM   float64 `json:"spanM"`
	MPerPt  float64 `json:"mPerPt"`
	Scope   string  `json:"scope"`
	Verdict string  `json:"verdict"`

	ShiftM   float64 `json:"shiftM,omitempty"`
	BrgDeg   float64 `json:"shiftBrgDeg,omitempty"`
	ScalePct float64 `json:"scalePct,omitempty"`
	RotDeg   float64 `json:"rotDeg,omitempty"`
	ResidM   float64 `json:"residM,omitempty"`
	// How far a clipped panel is out by AT LEAST: the search range its
	// windows ran into. Present only on a `clipped` verdict.
	BeyondM float64 `json:"beyondM,omitempty"`
	// The search range this row's numbers came from, present only when the
	// narrow one could not answer and a wider one was tried.
	Severity  float64 `json:"severity,omitempty"`
	ScaleSev  float64 `json:"scaleSeverity,omitempty"`
	NWindows  int     `json:"nWindows"`
	NMeasured int     `json:"nMeasured"`
	NSamples  int     `json:"nSamples"`
	RefSegs   int     `json:"refSegs"`

	// Joined from the reader's own quality, so a reader of the report can
	// tell news from known: a runway-anchored panel was MOVED onto its
	// published runway ends, and a stretched one carries a disagreement the
	// plate's own labels asked for.
	AnchorM      float64 `json:"anchorM,omitempty"`
	AnchorResidM float64 `json:"anchorResidM,omitempty"`
	Axes         string  `json:"axes,omitempty"`
	ARPm         float64 `json:"arpM,omitempty"`

	Windows []witnessWindow `json:"windows,omitempty"`
	Witness bool            `json:"witness"`
}

type witnessWindow struct {
	Lat     float64 `json:"lat"`
	Lon     float64 `json:"lon"`
	ArmM    float64 `json:"armM"`
	Verdict string  `json:"verdict"`
	DxM     float64 `json:"dxM"`
	DyM     float64 `json:"dyM"`
	SigmaM  float64 `json:"sigmaM"`
	Peak    float64 `json:"peak"`
	Margin  float64 `json:"margin"`
	Aniso   float64 `json:"aniso"`
	N       int     `json:"n"`
	RefSegs int     `json:"refSegs"`
}

// shippedPanels reads the committed dataset. The witness measures WHAT WAS
// PUBLISHED, not what a fresh fit would produce, because the published rows
// are what a pilot sees.
type shippedRow struct {
	ident           string
	section, page   int
	kind            string
	clip            [4]float64
	aff             [6]float64
	method, axes    string
	anchorM, residM float64
	arpM            float64
	swLat, swLon    float64
	neLat, neLon    float64
}

// placedAs fingerprints WHERE this panel is, which is the thing the witness
// went and measured.
//
// The panel cache was keyed on the sheet alone at first, and a reading was
// taken as current if it carried the right witnessVersion. That is wrong the
// moment the reader moves a panel: the sweep would hand back the distance
// the panel used to sit from the ground and call it today's answer, and an
// A/B comparison of two datasets would read as no change at all. So the
// cached reading carries the placement it was taken against, and a panel
// that has moved is measured again.
func (r shippedRow) placedAs() string {
	h := sha256.New()
	for _, v := range r.clip {
		fmt.Fprintf(h, "%.4f,", v)
	}
	for _, v := range r.aff {
		fmt.Fprintf(h, "%.10f,", v)
	}
	return fmt.Sprintf("%x", h.Sum(nil))[:16]
}

// cacheHolds reports whether a cached reading is about this panel as it
// stands now: taken by this version of the witness, and against this
// placement.
func cacheHolds(body []byte, r shippedRow) bool {
	var m struct {
		V int    `json:"v"`
		P string `json:"p"`
	}
	if json.Unmarshal(body, &m) != nil {
		return false
	}
	return m.V == witnessVersion && m.P == r.placedAs()
}

func shippedPanels(path string) ([]shippedRow, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var ds struct {
		Fields []string `json:"fields"`
		Rows   [][]any  `json:"rows"`
	}
	if err := json.Unmarshal(body, &ds); err != nil {
		return nil, err
	}
	idx := map[string]int{}
	for i, f := range ds.Fields {
		idx[f] = i
	}
	nums := func(v any, n int) []float64 {
		out := make([]float64, n)
		arr, _ := v.([]any)
		for i := 0; i < n && i < len(arr); i++ {
			out[i], _ = arr[i].(float64)
		}
		return out
	}
	var out []shippedRow
	for _, r := range ds.Rows {
		q, _ := r[idx["quality"]].(map[string]any)
		f := func(k string) float64 { v, _ := q[k].(float64); return v }
		s := func(k string) string { v, _ := q[k].(string); return v }
		c := nums(r[idx["clip"]], 4)
		a := nums(r[idx["aff"]], 6)
		sw := nums(r[idx["sw"]], 2)
		ne := nums(r[idx["ne"]], 2)
		out = append(out, shippedRow{
			ident:   r[idx["ident"]].(string),
			section: int(r[idx["section"]].(float64)),
			page:    int(r[idx["page"]].(float64)),
			kind:    r[idx["kind"]].(string),
			clip:    [4]float64{c[0], c[1], c[2], c[3]},
			aff:     [6]float64{a[0], a[1], a[2], a[3], a[4], a[5]},
			method:  s("method"), axes: s("axes"),
			anchorM: f("anchorM"), residM: f("anchorResidM"), arpM: f("arpM"),
			swLat: sw[0], swLon: sw[1], neLat: ne[0], neLon: ne[1],
		})
	}
	return out, nil
}

// witnessPanel measures one panel and returns NUMBERS. It takes the affine
// by value and never hands one back, nor the coefficients that would build
// one: to act on a finding somebody has to do that arithmetic themselves,
// in the open, and then they are writing an overrides.tsv row by hand.
func witnessPanel(c pageContent, r shippedRow, ref *bdtopoFetcher) witnessRow {
	g := geoAffine{A: r.aff[0], B: r.aff[1], C: r.aff[2], D: r.aff[3], E: r.aff[4], F: r.aff[5]}
	pn := box{x0: r.clip[0], y0: r.clip[1], x1: r.clip[2], y1: r.clip[3]}
	cLat, cLon := g.at((pn.x0+pn.x1)/2, (pn.y0+pn.y1)/2)
	fr := newLocal(latLon{lat: cLat, lon: cLon})
	row := witnessRow{
		Ident: r.ident, Section: r.section, Page: r.page, Kind: r.kind,
		Method: r.method, Lat: round5(cLat), Lon: round5(cLon),
		AnchorM: r.anchorM, AnchorResidM: r.residM, Axes: r.axes, ARPm: r.arpM,
		Witness: true,
	}
	row.MPerPt = groundPerPoint(g, fr)
	span := math.Max(pn.width(), pn.height()) * row.MPerPt
	row.SpanM = math.Round(span)
	row.MPerPt = math.Round(row.MPerPt*1000) / 1000
	if row.MPerPt > maxCoarseMPerPt {
		row.Scope, row.Verdict = "generalised", "not-measured"
		return row
	}
	coarse := row.MPerPt > maxWitnessMPerPt
	layers, cellDeg := bdtopoLayers, fineCellDeg
	row.Scope = "in"
	if coarse {
		layers, cellDeg = bdtopoCoarse, coarseCellDeg
		row.Scope = "coarse"
	}

	// Every window number below is a size ON THE PAPER, expressed as ground
	// metres through the panel's own scale, and the fine branch's caps are
	// what a hundred points, seven and a half, a fifth and a half of a
	// point come to at the twenty metres per point where the two branches
	// meet. So the instrument is the same instrument at either scale and
	// the seam is continuous; what changes is the reference it is pointed
	// at, because a sheet at 1:150 000 draws different things.
	capM := func(pt float64) float64 { return pt * row.MPerPt }
	sideCap, searchCap, cellCap, d0Cap := 2000.0, 150.0, 4.0, 10.0
	if coarse {
		sideCap, searchCap = capM(100), capM(7.5)
		cellCap, d0Cap = capM(0.2), capM(0.5)
	}
	side := math.Min(sideCap, math.Max(150, 0.35*span))
	cell := math.Min(cellCap, math.Max(0.5, span/1500))
	// How far to look. Deliberately NARROW, a tenth of the panel. Over a
	// town the score surface is shallow, because a VAC sheet draws its
	// buildings schematically and the survey has them to the metre, and the
	// global best over a wide search then wanders to wherever the town is
	// densest rather than to where the panel belongs. A displacement past
	// this reads as `clipped`, which is a finding in its own right: it says
	// the panel is further out than the witness can follow.
	searchM := math.Min(searchCap, math.Max(40, 0.1*span))
	// How close counts as agreeing. Not a tolerance on the answer but a
	// statement about the CORRESPONDENCE: a VAC sheet draws a building
	// schematically and BD TOPO surveys its footprint, and at Creteil the
	// median sample sits four metres from its reference even where the
	// panel is right. A d0 tighter than that measures the draughtsman's
	// generalisation instead of the panel's placement.
	d0 := math.Min(d0Cap, math.Max(3, 0.01*span))
	loM := math.Max(3, side/40)
	hiM := math.Min(side, 0.6*span)

	ink := groundInk(c, pn, g, fr, loM, hiM, math.Max(1, cell))
	row.NSamples = len(ink)
	if len(ink) < 60 {
		row.Verdict = "no-evidence"
		return row
	}
	windows := witnessWindows(ink, side)
	// The window, the search, and the ring the score is levelled against,
	// which stands at three times the range.
	// ONE fetch for the whole panel, tiled. Asking per window multiplied
	// the requests fivefold, and at that rate the service refuses; a refusal
	// reads downstream as "no reference here", which reads as a clean bill
	// of health for the panel. Fewer, bigger questions.
	var lo, hi [2]float64
	for i, w := range windows {
		if i == 0 {
			lo, hi = w, w
		}
		lo[0], lo[1] = math.Min(lo[0], w[0]), math.Min(lo[1], w[1])
		hi[0], hi[1] = math.Max(hi[0], w[0]), math.Max(hi[1], w[1])
	}
	var panelSegs []refSeg
	reference := func(reach float64) {
		want := side/2 + 3.2*reach + 30
		all := bbox{
			lat0: cLat + (lo[1]-want)/fr.mPerLat, lon0: cLon + (lo[0]-want)/fr.mPerLon,
			lat1: cLat + (hi[1]+want)/fr.mPerLat, lon1: cLon + (hi[0]+want)/fr.mPerLon,
		}
		for _, t := range all.tiles(cellDeg) {
			for _, layer := range layers {
				body, err := ref.get(layer, t)
				if err != nil {
					continue
				}
				panelSegs, _ = refSegments(body, fr, panelSegs)
			}
		}
	}
	reference(searchM)
	row.RefSegs = len(panelSegs)

	var cxs, cys, dxs, dys, ws []float64
	look := func(reach float64) {
		row.Windows = row.Windows[:0]
		row.NMeasured = 0
		cxs, cys, dxs, dys, ws = nil, nil, nil, nil, nil
		half := side/2 + 3.2*reach + 30
		step := math.Max(cell, reach/40)
		for _, w := range windows {
			sub := inkIn(ink, w[0], w[1], side/2)
			if len(sub) < 120 {
				continue
			}
			sub = decimate(sub, 1200)
			segs := segsNear(panelSegs, w[0], w[1], half)
			n := int(2*half/cell) + 1
			fRef := newField(segs, w[0]-half, w[1]-half, cell, n, n)
			fInk := pointField(sub, w[0]-half, w[1]-half, cell, n, n)
			rp := refPoints(segs, w[0], w[1], side/2+reach, math.Max(2, cell), 1500)
			fix := peakOf(scoreMap(sub, fRef, rp, fInk, reach, step, d0))
			fix.n = len(sub)
			fix.verdict = witnessVerdict(fix, len(sub), len(segs))
			wLat, wLon := cLat+w[1]/fr.mPerLat, cLon+w[0]/fr.mPerLon
			row.Windows = append(row.Windows, witnessWindow{
				Lat: round5(wLat), Lon: round5(wLon),
				ArmM:    math.Round(math.Hypot(w[0], w[1])),
				Verdict: fix.verdict,
				DxM:     round2(fix.dxM), DyM: round2(fix.dyM),
				SigmaM: round2(fix.sigmaM), Peak: round4(fix.peak), Margin: round4(fix.margin),
				Aniso: round4(fix.aniso), N: fix.n, RefSegs: len(segs),
			})
			if fix.verdict != "measured" {
				continue
			}
			row.NMeasured++
			cxs = append(cxs, w[0])
			cys = append(cys, w[1])
			// The score says how far the INK must move; the panel's own error
			// is that, and the sign is kept as the reader would act on it.
			dxs = append(dxs, fix.dxM)
			dys = append(dys, fix.dyM)
			ws = append(ws, 1/math.Max(0.25, fix.sigmaM*fix.sigmaM))
		}
	}
	look(searchM)
	// A wider second look, offered only to a panel whose windows all ran
	// into the edge of the first, was built and measured and is NOT here.
	// It answered 64 panels the narrow search could not, and the answers
	// are what the narrow search exists to avoid: multi-kilometre shifts on
	// one or two windows, which is the score wandering to wherever the town
	// is densest. The recovery test fell from 7 of 7 to 6 of 7 on the fine
	// scale with it in, and that is the instrument saying it measures less
	// well. What survives from the experiment is the verdict above: a panel
	// that runs into the edge now SAYS so instead of reporting no evidence.
	row.NWindows = len(row.Windows)
	if row.NMeasured == 0 {
		// A window that CLIPPED did not fail to see anything: it saw the
		// panel wanting to move further than the search follows, and said
		// so. A panel whose windows mostly clip is therefore not "no
		// evidence", which reads as a clean bill of health; it is a panel
		// further out than this instrument can measure, which is a finding
		// in its own right and one of the more serious ones. Half the
		// no-evidence class was that, filed under nothing to say.
		//
		// It carries the direction its clipped windows agree on and the
		// search range as a LOWER BOUND, never a shift: the magnitude is
		// exactly what a clipped window does not know.
		clipped := 0
		var ex, ny float64
		for _, w := range row.Windows {
			if w.Verdict == "clipped" {
				clipped++
				d := math.Hypot(w.DxM, w.DyM)
				if d > 0 {
					ex += w.DxM / d
					ny += w.DyM / d
				}
			}
		}
		if clipped*2 >= len(row.Windows) && clipped > 0 {
			row.Verdict = "clipped"
			row.BrgDeg = math.Round(bearingOf(ex, ny))
			row.BeyondM = round2(searchM)
			return row
		}
		row.Verdict = "no-evidence"
		return row
	}
	fit := fitWindows(cxs, cys, dxs, dys, ws)
	row.ShiftM = round2(fit.shiftM)
	row.BrgDeg = math.Round(fit.brgDeg)
	row.ResidM = round2(fit.residM)
	if fit.full {
		row.ScalePct = round3(fit.scalePct)
		row.RotDeg = round3(fit.rotDeg)
	}
	// Severity in units of the panel's OWN tolerance. A hundred metres on a
	// 47 km approach sheet is nothing and fifteen on a 130 m pad detail is a
	// lot, so a list ranked in metres is a list ranked by panel size.
	sigmaDraft := 0.3 * row.MPerPt
	tol := math.Hypot(math.Hypot(fit.residM, sigmaDraft), 1.5)
	row.Severity = round2(fit.shiftM / (2 * tol))
	if fit.full {
		row.ScaleSev = round2(math.Abs(fit.scalePct) / (2 * 0.3))
	}
	// The panel's confidence is the windows' AGREEMENT, not any one
	// window's peak. Three that land within a few metres of one similarity
	// are evidence; three that scatter are a reading of three different
	// accidents, and saying so is the useful answer.
	switch {
	case fit.residM > math.Max(10, 0.01*span):
		row.Verdict = "inconsistent"
	case row.NMeasured < 3:
		row.Verdict = "translation-only"
	default:
		row.Verdict = "consistent"
	}
	return row
}

// witnessWindows places up to five looks: the ink's own centre of mass and
// its four quadrant centres.
//
// NEVER on the aerodrome reference point. 272 panels have already been
// translated onto their published runway ends, so a look there is measuring
// agreement that was manufactured, and the witness would systematically
// report those panels as better than they are.
func witnessWindows(ink []inkSample, side float64) [][2]float64 {
	mean := func(s []inkSample) [2]float64 {
		var x, y float64
		for _, p := range s {
			x += p.x
			y += p.y
		}
		return [2]float64{x / float64(len(s)), y / float64(len(s))}
	}
	c := mean(ink)
	out := [][2]float64{c}
	var q [4][]inkSample
	for _, p := range ink {
		i := 0
		if p.x > c[0] {
			i |= 1
		}
		if p.y > c[1] {
			i |= 2
		}
		q[i] = append(q[i], p)
	}
	quadrants := func(sep float64) {
		for _, s := range q {
			if len(s) < 120 {
				continue
			}
			m := mean(s)
			near := false
			for _, o := range out {
				if math.Hypot(m[0]-o[0], m[1]-o[1]) < sep {
					near = true
				}
			}
			if !near {
				out = append(out, m)
			}
		}
	}
	quadrants(0.75 * side)
	// A panel only a couple of windows across has its quadrant means inside
	// its own centre window BY CONSTRUCTION, so it is offered one window and
	// one window can never be more than `translation-only`, which wants
	// three. That is what the 62 pad panels are: their median span is 302 m
	// against a window floor of 150, their quadrant means sit about 75 m
	// from the middle, and the rule asks for 112. So where the panel ends up
	// with nothing but its centre, the quadrants are offered again at a
	// separation they can actually meet. Nothing that already had two
	// windows is touched.
	if len(out) == 1 {
		quadrants(0.35 * side)
	}
	return out
}

// segsNear is the reference within reach of one window.
func segsNear(segs []refSeg, cx, cy, half float64) []refSeg {
	var out []refSeg
	for _, s := range segs {
		if math.Abs((s.x1+s.x2)/2-cx) <= half && math.Abs((s.y1+s.y2)/2-cy) <= half {
			out = append(out, s)
		}
	}
	return out
}

func inkIn(ink []inkSample, cx, cy, half float64) []inkSample {
	var out []inkSample
	for _, p := range ink {
		if math.Abs(p.x-cx) <= half && math.Abs(p.y-cy) <= half {
			out = append(out, p)
		}
	}
	return out
}

// decimate keeps an even spread rather than a prefix, so a cap never turns
// a window into a reading of whichever corner was drawn first.
func decimate(s []inkSample, n int) []inkSample {
	if len(s) <= n {
		return s
	}
	out := make([]inkSample, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, s[i*len(s)/n])
	}
	return out
}

func round3(v float64) float64 { return math.Round(v*1000) / 1000 }
func round4(v float64) float64 { return math.Round(v*10000) / 10000 }
func round5(v float64) float64 { return math.Round(v*100000) / 100000 }

func TestWitnessCorpus(t *testing.T) {
	outDir := witnessDir(os.Getenv("VACGEO_WITNESS"))
	if outDir == "" {
		t.Skip("set VACGEO_WITNESS=<report dir> to sweep the corpus against BD TOPO")
	}
	// A comma-separated list, because the question a sweep usually answers
	// after the first one is "what did this change do", and a change moves
	// twenty panels rather than eight hundred.
	only := map[string]bool{}
	for _, id := range strings.Split(os.Getenv("VACGEO_WITNESS_ONLY"), ",") {
		if id = strings.ToUpper(strings.TrimSpace(id)); id != "" {
			only[id] = true
		}
	}
	offline := os.Getenv("VACGEO_WITNESS_OFFLINE") != ""
	dataDir := filepath.Join("..", "..", "public", "data")
	cacheDir := filepath.Join("..", "..", "local", "aipdocs-cache")
	if _, err := os.Stat(filepath.Join(cacheDir, "vac")); err != nil {
		t.Skipf("no plate cache: %v", err)
	}
	rows, err := shippedPanels(filepath.Join(dataDir, "fr-vacgeo.json"))
	if err != nil {
		t.Fatal(err)
	}
	eff, err := aipEffective(filepath.Join(dataDir, "fr-adcharts.meta.json"))
	if err != nil {
		t.Fatal(err)
	}
	plateDir := filepath.Join(cacheDir, "vac", eff)
	ref := newBDTopoFetcher(filepath.Join(outDir, "bdtopo"), offline)
	if err := os.MkdirAll(filepath.Join(outDir, "panels"), 0o755); err != nil {
		t.Fatal(err)
	}

	// One page is walked once however many panels it carries.
	type job struct {
		path string
		rows []shippedRow
	}
	byPage := map[string]*job{}
	var order []string
	for _, r := range rows {
		if len(only) > 0 && !only[r.ident] {
			continue
		}
		k := fmt.Sprintf("%s/%d/%d", r.ident, r.section, r.page)
		if byPage[k] == nil {
			byPage[k] = &job{path: filepath.Join(plateDir, fmt.Sprintf("AD-%d.%s.pdf", r.section, r.ident))}
			order = append(order, k)
		}
		byPage[k].rows = append(byPage[k].rows, r)
	}
	sort.Strings(order)
	abs, _ := filepath.Abs(outDir)
	t.Logf("%d panels over %d pages; reference %s; report %s",
		len(rows), len(order), bdtopoBase, abs)

	var mu sync.Mutex
	var done int
	work := make(chan string)
	var wg sync.WaitGroup
	// One worker walks one page at a time and asks for its reference one
	// request at a time, so the number of workers IS the number of
	// questions in flight and the fetcher's own gate is never reached. At
	// four, a corpus sweep spent five hours waiting on a service that was
	// answering every request in two seconds.
	for i := 0; i < min(witnessGate, runtime.NumCPU()); i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for k := range work {
				j := byPage[k]
				var pc pageContent
				walked := false
				for _, r := range j.rows {
					cache := filepath.Join(outDir, "panels",
						fmt.Sprintf("%s-%d-p%d.json", r.ident, r.section, r.page))
					if body, err := os.ReadFile(cache); err == nil && cacheHolds(body, r) {
						continue
					}
					if !walked {
						f, err := os.Open(j.path)
						if err != nil {
							break
						}
						info, _ := f.Stat()
						rd, err := pdf.NewReader(f, info.Size())
						if err == nil {
							pc, _ = walkPage(rd.Page(r.page))
						}
						f.Close()
						walked = true
					}
					row := witnessPanel(pc, r, ref)
					body, _ := json.Marshal(struct {
						V int    `json:"v"`
						P string `json:"p"`
						witnessRow
					}{witnessVersion, r.placedAs(), row})
					_ = os.WriteFile(cache, body, 0o644)
				}
				mu.Lock()
				done++
				if done%100 == 0 {
					t.Logf("   %d/%d pages", done, len(order))
				}
				mu.Unlock()
			}
		}()
	}
	for _, k := range order {
		work <- k
	}
	close(work)
	wg.Wait()

	// The report is assembled from the per-panel cache and sorted, so it is
	// the same bytes whatever order the workers finished in.
	var out []witnessRow
	for _, r := range rows {
		if len(only) > 0 && !only[r.ident] {
			continue
		}
		body, err := os.ReadFile(filepath.Join(outDir, "panels",
			fmt.Sprintf("%s-%d-p%d.json", r.ident, r.section, r.page)))
		if err != nil {
			continue
		}
		var w witnessRow
		if json.Unmarshal(body, &w) == nil {
			out = append(out, w)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Ident != out[j].Ident {
			return out[i].Ident < out[j].Ident
		}
		return out[i].Page < out[j].Page
	})
	if err := writeWitnessReport(outDir, out); err != nil {
		t.Fatal(err)
	}

	// The ONLY floor here is harness health. A witness with a floor on any
	// measurement becomes a target, and the cheapest way to hit a target
	// that measures agreement with a reference is to fit to the reference.
	var measured int
	for _, r := range out {
		if r.NMeasured > 0 {
			measured++
		}
	}
	askedN, heldN := ref.cells()
	t.Logf("reference cells: %d distinct asked for, %d reads answered from the cache",
		askedN, heldN)
	okN, failN, lastErr := ref.tally()
	t.Logf("reference requests: %d answered, %d refused%s", okN, failN,
		func() string {
			if failN == 0 {
				return ""
			}
			return " (last: " + lastErr + ")"
		}())
	t.Logf("%d rows; %d produced a measured window", len(out), measured)
	// A refused request reads downstream as "no reference here", which
	// reads as a clean bill of health. If the service was not answering,
	// the report is not a report.
	if okN+failN > 0 && failN > (okN+failN)/20 {
		t.Fatalf("%d of %d reference requests were refused; the report is not "+
			"evidence about the dataset, it is evidence about the network",
			failN, okN+failN)
	}
	if len(only) == 0 && !offline && measured < 100 {
		t.Errorf("only %d panels produced a measurement; the harness is broken, "+
			"which says nothing about the data", measured)
	}
}

// witnessDir resolves the report directory, a RELATIVE one against the repo
// root rather than the working directory.
//
// A test binary runs with its own package as the working directory, so the
// local/vacgeo-witness this file documents lands in cmd/vacgeo/local, which
// is not the gitignored one and holds none of the reference already
// fetched. Both of the first two sweeps went to the network for every cell
// they already had on disk, and were rate-limited for it.
func witnessDir(dir string) string {
	if dir == "" || filepath.IsAbs(dir) {
		return dir
	}
	return filepath.Join("..", "..", dir)
}

// clippedWindows counts the looks that ran into the edge of the search.
func clippedWindows(r witnessRow) int {
	n := 0
	for _, w := range r.Windows {
		if w.Verdict == "clipped" {
			n++
		}
	}
	return n
}

// aipEffective reads the cycle the plate cache is keyed by.
func aipEffective(path string) (string, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	var m struct {
		Effective string `json:"effective"`
	}
	if err := json.Unmarshal(body, &m); err != nil {
		return "", err
	}
	mon := []string{"JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"}
	var y, mo, d int
	if _, err := fmt.Sscanf(m.Effective, "%d-%d-%d", &y, &mo, &d); err != nil {
		return "", err
	}
	return fmt.Sprintf("%02d_%s_%d", d, mon[mo-1], y), nil
}

const witnessNote = "Observation only. This report never places a panel and is " +
	"never an input to cmd/vacgeo. A panel carries the scale and position its own " +
	"plate states, because a plate is not a survey."

func writeWitnessReport(dir string, rows []witnessRow) error {
	f, err := os.Create(filepath.Join(dir, "vacgeo-witness.jsonl"))
	if err != nil {
		return err
	}
	defer f.Close()
	enc := json.NewEncoder(f)
	var scope, measured, noEvidence, generalised, coarse, clipped int
	for _, r := range rows {
		if r.Scope == "coarse" {
			coarse++
		}
		switch {
		case r.Scope == "generalised":
			generalised++
		case r.Verdict == "clipped":
			clipped++
			scope++
		case r.Verdict == "no-evidence":
			noEvidence++
			scope++
		default:
			measured++
			scope++
		}
	}
	if err := enc.Encode(map[string]any{
		"kind": "vacgeo-witness", "witnessVersion": witnessVersion,
		"reference": "IGN BD TOPO v3 via data.geopf.fr WFS, (c) IGN",
		"note":      witnessNote,
		"panels":    len(rows), "inScope": scope, "measured": measured,
		"noEvidence": noEvidence, "generalised": generalised, "coarse": coarse,
		"clipped": clipped,
	}); err != nil {
		return err
	}
	for _, r := range rows {
		if err := enc.Encode(r); err != nil {
			return err
		}
	}

	// Three tables, because a panel in the wrong place, a panel at the
	// wrong scale and a panel the witness could not read are three
	// different findings, and one list hides two of them.
	var b strings.Builder
	fmt.Fprintf(&b, "%s\n\n", witnessNote)
	fmt.Fprintf(&b, "%d panels: %d in scope, %d measured, %d clipped past the search, "+
		"%d no evidence, %d generalised and not measured.\n",
		len(rows), scope, measured, clipped, noEvidence, generalised)
	var shifts, scales []float64
	for _, r := range rows {
		if r.NMeasured > 0 {
			shifts = append(shifts, r.ShiftM)
			if r.ScalePct != 0 {
				scales = append(scales, math.Abs(r.ScalePct))
			}
		}
	}
	sort.Float64s(shifts)
	sort.Float64s(scales)
	if len(shifts) > 0 {
		fmt.Fprintf(&b, "|shift| median %.1f m p90 %.1f m; |scale| median %.2f %% p90 %.2f %%.\n",
			pctl(shifts, .5), pctl(shifts, .9), pctl(scales, .5), pctl(scales, .9))
	}
	table := func(title string, less func(a, b witnessRow) bool, keep func(witnessRow) bool, n int) {
		var s []witnessRow
		for _, r := range rows {
			if keep(r) {
				s = append(s, r)
			}
		}
		sort.Slice(s, func(i, j int) bool { return less(s[i], s[j]) })
		fmt.Fprintf(&b, "\n%s\n", title)
		for i, r := range s {
			if i >= n {
				break
			}
			if r.Verdict == "clipped" {
				// A clipped panel knows a direction and a floor, and does
				// not know a shift. Printing zeroes for what it cannot say
				// is how the class hid in the first place.
				fmt.Fprintf(&b, "  %-7s p%d %-4s %-10s span %6.0f m  beyond %5.1f m = %4.1f pt  brg %03.0f  %d of %d windows clipped\n",
					r.Ident, r.Page, r.Kind, r.Method, r.SpanM, r.BeyondM,
					r.BeyondM/math.Max(r.MPerPt, 1e-9), r.BrgDeg,
					clippedWindows(r), r.NWindows)
				continue
			}
			anchored := ""
			if r.AnchorResidM > 0 {
				anchored = fmt.Sprintf("  runway %.0f m", r.AnchorResidM)
			}
			fmt.Fprintf(&b, "  %-7s p%d %-4s %-10s span %6.0f m  shift %6.1f m brg %03.0f  scale %+6.2f %%  resid %5.1f m  sev %5.2f  %s%s\n",
				r.Ident, r.Page, r.Kind, r.Method, r.SpanM, r.ShiftM, r.BrgDeg, r.ScalePct, r.ResidM, r.Severity, r.Verdict, anchored)
		}
	}
	// TWO tables, because the two groups' numbers are about different
	// things and one list hides that. A panel whose own drawn runway lands
	// on its published ends has been confirmed by evidence that owes the
	// ground nothing, and what its ink shift then measures is the plate's
	// BACKGROUND: a VAC chart draws its runway where the survey puts it and
	// its topography approximately. At Loudun the drawn strip lies on the
	// real one while the drawn woods and hedges around it are visibly
	// offset, and the AIP's published ends sit 0 m from IGN's own surveyed
	// runway, so both readings are honest and only one of them is about
	// where the panel sits.
	confirmed := func(r witnessRow) bool { return r.AnchorResidM > 0 }
	table("Out of place, and nothing confirms them, worst first:",
		func(a, c witnessRow) bool { return a.Severity > c.Severity },
		func(r witnessRow) bool { return r.NMeasured >= 3 && !confirmed(r) }, 40)
	table("Their own runway confirms them, so this is the plate's background:",
		func(a, c witnessRow) bool { return a.Severity > c.Severity },
		func(r witnessRow) bool { return r.NMeasured >= 3 && confirmed(r) }, 20)
	table("Out of scale, worst first:",
		func(a, c witnessRow) bool { return a.ScaleSev > c.ScaleSev },
		func(r witnessRow) bool { return r.NMeasured >= 3 }, 40)
	table("Further out than the search follows, worst first:",
		func(a, c witnessRow) bool { return a.BeyondM/a.MPerPt > c.BeyondM/c.MPerPt },
		func(r witnessRow) bool { return r.Verdict == "clipped" }, 40)
	table("Could not be read, which is itself a finding:",
		func(a, c witnessRow) bool { return a.SpanM < c.SpanM },
		func(r witnessRow) bool {
			return r.Scope == "in" && (r.Verdict == "no-evidence" || r.Verdict == "inconsistent")
		}, 40)
	if err := os.WriteFile(filepath.Join(dir, "vacgeo-witness-worst.txt"), []byte(b.String()), 0o644); err != nil {
		return err
	}

	// And the picture: the panel footprints and where each look landed,
	// to drop onto the app's own IGN layer.
	var feats []any
	for _, r := range rows {
		for _, w := range r.Windows {
			feats = append(feats, map[string]any{
				"type":     "Feature",
				"geometry": map[string]any{"type": "Point", "coordinates": []float64{w.Lon, w.Lat}},
				"properties": map[string]any{
					"ident": r.Ident, "page": r.Page, "verdict": w.Verdict,
					"dxM": w.DxM, "dyM": w.DyM, "sigmaM": w.SigmaM, "aniso": w.Aniso,
					"peak": w.Peak, "margin": w.Margin, "n": w.N, "refSegs": w.RefSegs,
				},
			})
		}
	}
	gj, err := json.Marshal(map[string]any{
		"type": "FeatureCollection", "note": witnessNote, "features": feats,
	})
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "vacgeo-witness.geojson"), gj, 0o644)
}

// TestWitnessRecoversAKnownShiftOnARealPlate is the one that decides whether
// the report can be believed. The synthesised town in witnessfit_test.go
// proves the arithmetic; this proves the whole instrument, on real chart ink
// against the real survey: displace a panel's affine by a stated amount and
// require the number back.
//
// It leans on the reference cache the sweep filled, but a displaced panel
// looks at slightly different ground, so it fetches the few windows the
// sweep never asked for. A few hundred requests, once.
//
//	VACGEO_WITNESS=local/vacgeo-witness go test ./cmd/vacgeo -run TestWitnessRecovers -v
func TestWitnessRecoversAKnownShiftOnARealPlate(t *testing.T) {
	dir := witnessDir(os.Getenv("VACGEO_WITNESS"))
	if dir == "" {
		t.Skip("set VACGEO_WITNESS=<report dir> holding a reference cache")
	}
	dataDir := filepath.Join("..", "..", "public", "data")
	cacheDir := filepath.Join("..", "..", "local", "aipdocs-cache")
	rows, err := shippedPanels(filepath.Join(dataDir, "fr-vacgeo.json"))
	if err != nil {
		t.Fatal(err)
	}
	eff, err := aipEffective(filepath.Join(dataDir, "fr-adcharts.meta.json"))
	if err != nil {
		t.Fatal(err)
	}
	ref := newBDTopoFetcher(filepath.Join(dir, "bdtopo"), false)

	// Panels the witness already reads with three agreeing windows, so the
	// experiment is about the displacement and not about the panel. Both
	// scales, because they are two instruments in one file: the fine one
	// measures against footprints and aprons, the coarse one against
	// built-up areas, coast, rivers and railways, and a number the second
	// cannot read back is a number nobody should trust.
	var subjects []shippedRow
	var scale []float64
	seen := map[string]int{}
	for _, r := range rows {
		body, err := os.ReadFile(filepath.Join(dir, "panels",
			fmt.Sprintf("%s-%d-p%d.json", r.ident, r.section, r.page)))
		if err != nil {
			continue
		}
		var w witnessRow
		if json.Unmarshal(body, &w) != nil || w.NMeasured < 3 {
			continue
		}
		// "Already near the ground", in the panel's own units of paper.
		if w.ShiftM > math.Max(40, 2*w.MPerPt) {
			continue
		}
		if seen[w.Scope] >= 8 {
			continue
		}
		seen[w.Scope]++
		subjects = append(subjects, r)
		scale = append(scale, w.MPerPt)
	}
	if len(subjects) == 0 {
		t.Skip("no panel in the cache reads well enough to test with")
	}
	tested, recovered := 0, 0
	byScope := map[string][2]int{}
	for i, r := range subjects {
		// Three points of paper, which is a displacement worth reporting on
		// any of these sheets and is under half of what the search can
		// follow at either scale.
		wantM := math.Max(60, 3*scale[i])
		tolM := math.Max(20, scale[i])
		f, err := os.Open(filepath.Join(cacheDir, "vac", eff,
			fmt.Sprintf("AD-%d.%s.pdf", r.section, r.ident)))
		if err != nil {
			continue
		}
		info, _ := f.Stat()
		rd, err := pdf.NewReader(f, info.Size())
		if err != nil {
			f.Close()
			continue
		}
		c, err := walkPage(rd.Page(r.page))
		f.Close()
		if err != nil {
			continue
		}
		base := witnessPanel(c, r, ref)
		// East by a stated amount, in the panel's own frame.
		moved := r
		_, mLon := metrePerDeg(base.Lat)
		moved.aff[4] += wantM / mLon
		got := witnessPanel(c, moved, ref)
		if got.NMeasured < 3 {
			continue
		}
		tested++
		// The witness says how far the ink must MOVE to sit on the ground,
		// so displacing the panel east must show up as a westward correction
		// of the stated size, on top of whatever the panel already carried.
		dx := got.ShiftM*math.Sin(got.BrgDeg*math.Pi/180) - base.ShiftM*math.Sin(base.BrgDeg*math.Pi/180)
		n := byScope[base.Scope]
		n[1]++
		if math.Abs(dx+wantM) < tolM {
			recovered++
			n[0]++
		} else {
			t.Logf("%s p%d (%s, %.1f m/pt): displaced %+.0f m east, recovered %+.1f m "+
				"(base %.1f m brg %.0f, moved %.1f m brg %.0f)",
				r.ident, r.page, base.Scope, base.MPerPt, wantM, -dx,
				base.ShiftM, base.BrgDeg, got.ShiftM, got.BrgDeg)
		}
		byScope[base.Scope] = n
	}
	if tested == 0 {
		t.Skip("no cached panel could be re-read offline")
	}
	for scope, n := range byScope {
		t.Logf("%s: %d of %d returned a stated displacement to within tolerance",
			scope, n[0], n[1])
	}
	// Per scale, because a coarse reading that cannot be read back is a
	// third of the corpus reported on with numbers nobody should trust,
	// and a fine one that passes would hide it.
	for scope, n := range byScope {
		if n[1] >= 3 && n[0]*3 < n[1]*2 {
			t.Errorf("%s: only %d of %d recovered a stated shift; those rows are "+
				"not evidence until this passes", scope, n[0], n[1])
		}
	}
	if recovered*3 < tested*2 {
		t.Errorf("only %d of %d recovered a stated shift; the report is not "+
			"evidence until this passes", recovered, tested)
	}
}
