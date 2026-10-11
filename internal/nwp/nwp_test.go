package nwp

import (
	"encoding/json"
	"flag"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var update = flag.Bool("update", false, "rewrite the golden fixture the Worker suite reads")

func TestPyramidAnchorsOnTheLattice(t *testing.T) {
	cases := []struct {
		m    *Model
		want []Level
	}{
		{Arome, []Level{
			{Z: 7, Factor: 1, Ni: 1121, Nj: 717, Tx: 71, Ty: 45},
			{Z: 4, Factor: 5, I0: 0, J0: 1, Ni: 225, Nj: 144, Tx: 15, Ty: 9},
			{Z: 3, Factor: 10, I0: 0, J0: 6, Ni: 113, Nj: 72, Tx: 8, Ty: 5},
			{Z: 2, Factor: 20, I0: 0, J0: 16, Ni: 57, Nj: 36, Tx: 4, Ty: 3},
			{Z: 1, Factor: 40, I0: 0, J0: 16, Ni: 29, Nj: 18, Tx: 2, Ty: 2},
			{Z: 0, Factor: 80, I0: 0, J0: 56, Ni: 15, Nj: 9, Tx: 1, Ty: 1},
		}},
		{AromeOMAntil, []Level{
			{Z: 6, Factor: 1, Ni: 945, Nj: 529, Tx: 60, Ty: 34},
			{Z: 4, Factor: 5, I0: 2, J0: 1, Ni: 189, Nj: 106, Tx: 12, Ty: 7}, // -75.3 W, 22.9 N
			{Z: 3, Factor: 10, I0: 2, J0: 6, Ni: 95, Nj: 53, Tx: 6, Ty: 4},
			{Z: 2, Factor: 20, I0: 12, J0: 16, Ni: 47, Nj: 26, Tx: 3, Ty: 2},
			{Z: 1, Factor: 40, I0: 12, J0: 36, Ni: 24, Nj: 13, Tx: 2, Ty: 1},
			{Z: 0, Factor: 80, I0: 52, J0: 36, Ni: 12, Nj: 7, Tx: 1, Ty: 1},
		}},
		{AromeOMGuyane, []Level{
			{Z: 5, Factor: 1, Ni: 419, Nj: 317, Tx: 27, Ty: 20},
			{Z: 3, Factor: 5, I0: 0, J0: 3, Ni: 84, Nj: 63, Tx: 6, Ty: 4},
			{Z: 2, Factor: 10, I0: 0, J0: 8, Ni: 42, Nj: 31, Tx: 3, Ty: 2},
			{Z: 1, Factor: 20, I0: 10, J0: 18, Ni: 21, Nj: 15, Tx: 2, Ty: 1},
			{Z: 0, Factor: 40, I0: 30, J0: 38, Ni: 10, Nj: 7, Tx: 1, Ty: 1},
		}},
		{AromeOMIndien, []Level{
			{Z: 7, Factor: 1, Ni: 1395, Nj: 899, Tx: 88, Ty: 57},
			{Z: 5, Factor: 5, I0: 0, J0: 2, Ni: 279, Nj: 180, Tx: 18, Ty: 12},
			{Z: 4, Factor: 10, I0: 0, J0: 2, Ni: 140, Nj: 90, Tx: 9, Ty: 6},
			{Z: 3, Factor: 20, I0: 10, J0: 2, Ni: 70, Nj: 45, Tx: 5, Ty: 3},
			{Z: 2, Factor: 40, I0: 10, J0: 22, Ni: 35, Nj: 22, Tx: 3, Ty: 2},
			{Z: 1, Factor: 80, I0: 50, J0: 22, Ni: 17, Nj: 11, Tx: 2, Ty: 1},
		}},
		{AromeOMNcaled, []Level{
			{Z: 6, Factor: 1, Ni: 521, Nj: 491, Tx: 33, Ty: 31},
			{Z: 3, Factor: 5, I0: 0, J0: 0, Ni: 105, Nj: 99, Tx: 7, Ty: 7},
			{Z: 2, Factor: 10, I0: 0, J0: 0, Ni: 53, Nj: 50, Tx: 4, Ty: 4},
			{Z: 1, Factor: 20, I0: 0, J0: 10, Ni: 27, Nj: 25, Tx: 2, Ty: 2},
			{Z: 0, Factor: 40, I0: 20, J0: 10, Ni: 13, Nj: 13, Tx: 1, Ty: 1},
		}},
		{AromeOMPolyn, []Level{
			{Z: 6, Factor: 1, Ni: 521, Nj: 507, Tx: 33, Ty: 32},
			{Z: 3, Factor: 5, I0: 0, J0: 1, Ni: 105, Nj: 102, Tx: 7, Ty: 7},
			{Z: 2, Factor: 10, I0: 0, J0: 6, Ni: 53, Nj: 51, Tx: 4, Ty: 4},
			{Z: 1, Factor: 20, I0: 0, J0: 16, Ni: 27, Nj: 25, Tx: 2, Ty: 2},
			{Z: 0, Factor: 40, I0: 20, J0: 16, Ni: 13, Nj: 13, Tx: 1, Ty: 1},
		}},
		{Ifs, []Level{
			{Z: 7, Factor: 1, Ni: 1440, Nj: 721, Tx: 90, Ty: 46},
			{Z: 6, Factor: 2, Ni: 720, Nj: 361, Tx: 45, Ty: 23},
			{Z: 5, Factor: 4, Ni: 360, Nj: 181, Tx: 23, Ty: 12},
			{Z: 4, Factor: 8, Ni: 180, Nj: 91, Tx: 12, Ty: 6},
			{Z: 3, Factor: 16, J0: 8, Ni: 90, Nj: 45, Tx: 6, Ty: 3}, // 90 N is no multiple of 4 degrees: 88 is
		}},
	}
	for _, c := range cases {
		got, err := Pyramid(c.m)
		if err != nil {
			t.Fatal(err)
		}
		if len(got) != len(c.want) {
			t.Fatalf("%s: %d levels, want %d", c.m.ID, len(got), len(c.want))
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Errorf("%s level %d: %+v, want %+v", c.m.ID, i, got[i], c.want[i])
			}
		}
		// Every coarse point lies on its lattice step exactly.
		g := c.m.Grid
		for _, l := range got[1:] {
			step := int64(l.Factor) * g.Di
			for _, ab := range [][2]int{{0, 0}, {l.Ni - 1, l.Nj - 1}, {l.Ni / 2, l.Nj / 3}} {
				i, j, ok := l.Native(ab[0], ab[1], g)
				if !ok {
					t.Fatalf("%s x%d point %v off the grid", c.m.ID, l.Factor, ab)
				}
				if posMod(g.West+int64(i)*g.Di, step) != 0 || posMod(g.North-int64(j)*g.Dj, step) != 0 {
					t.Errorf("%s x%d point %v -> native %d,%d is off its lattice", c.m.ID, l.Factor, ab, i, j)
				}
			}
		}
	}
}

// A small domain has no zoom left for a 2° level: Guyane with x80 is
// refused rather than laid out over a zoom a finer level took.
func TestPyramidRefusesAZoomTaken(t *testing.T) {
	m := *AromeOMGuyane
	m.Pyramid = []int{5, 10, 20, 40, 80}
	if _, err := Pyramid(&m); err == nil || !strings.Contains(err.Error(), "needs a zoom the finer levels took") {
		t.Fatalf("Guyane with x80: %v", err)
	}
}

func TestNearestRoundsHalfUpInMicrodegrees(t *testing.T) {
	g := GridDesc{Ni: 741, Nj: 521, North: 72_000_000, West: -32_000_000, Di: 100_000, Dj: 100_000}
	for _, c := range []struct {
		lat, lon float64
		i, j     int
		ok       bool
	}{
		{72, -32, 0, 0, true},
		{71.95, -31.95, 1, 1, true}, // a tie goes to the larger index
		{71.96, -31.96, 0, 0, true},
		{20, 42, 740, 520, true},
		{19.9, 42, 0, 0, false},
		{50, 43, 0, 0, false},
	} {
		i, j, ok := g.Nearest(c.lat, c.lon)
		if ok != c.ok || (ok && (i != c.i || j != c.j)) {
			t.Errorf("Nearest(%g, %g) = %d, %d, %v, want %d, %d, %v", c.lat, c.lon, i, j, ok, c.i, c.j, c.ok)
		}
	}
	w := GridDesc{Ni: 1440, Nj: 721, North: 90_000_000, West: -180_000_000, Di: 250_000, Dj: 250_000, Wraps: true}
	for _, c := range []struct {
		lon float64
		i   int
	}{{-180, 0}, {179.75, 1439}, {179.9, 0}, {180, 0}, {0, 720}, {-0.1, 720}, {359.75, 719}} {
		i, _, ok := w.Nearest(0, c.lon)
		if !ok || i != c.i {
			t.Errorf("wrapping Nearest(0, %g) = %d, %v, want %d", c.lon, i, ok, c.i)
		}
	}
}

func TestQuantizeRefusesWhatInt16CannotHold(t *testing.T) {
	v := Var{Name: VarMSLP, Scale: 0.1, Offset: 1000}
	q, err := v.Quantize(1013.25)
	if err != nil || q != 133 {
		t.Fatalf("1013.25 hPa -> %d, %v", q, err)
	}
	if got := v.Value(q); math.Abs(got-1013.3) > 1e-9 {
		t.Errorf("back to %g", got)
	}
	for _, x := range []float64{101325, math.NaN(), math.Inf(1), 1000 - 3276.8} {
		if _, err := v.Quantize(x); err == nil {
			t.Errorf("%g accepted", x)
		}
	}
}

func TestSundqvistMatchesOpenMeteo(t *testing.T) {
	// Open-Meteo's Meteorology.relativeHumidityToCloudCover at these
	// points: no cloud under the critical humidity, overcast at 100 %.
	for _, c := range []struct{ rh, p, want float64 }{
		{100, 850, 100},
		{50, 850, 0},
		{95, 300, 100 * (1 - math.Sqrt(0.05/(1-(0.7+0.2*math.Exp(1-math.Pow(1013.25/300, 4))))))},
		{85, 1000, 0},
	} {
		if got := Sundqvist(c.rh, c.p); math.Abs(got-c.want) > 1e-9 {
			t.Errorf("Sundqvist(%g, %g) = %g, want %g", c.rh, c.p, got, c.want)
		}
	}
}

func TestStepsPerFamily(t *testing.T) {
	run := time.Date(2026, 10, 6, 0, 0, 0, 0, time.UTC)
	b := Arpege.Blocks(run)[4] // 49..60
	if got := Arpege.Steps(b, FamilyLevels); !equalInts(got, []int{51, 54, 57, 60}) {
		t.Errorf("ARPEGE levels past 48 h: %v", got)
	}
	if got := Arpege.Steps(b, FamilyHourlySurface); len(got) != 12 || got[0] != 49 {
		t.Errorf("ARPEGE SP1 past 48 h: %v", got)
	}
	if got := Ifs.Steps(Ifs.Blocks(run)[12], FamilyLevels); !equalInts(got, []int{150, 156, 162, 168}) {
		t.Errorf("IFS past 144 h: %v", got)
	}
	if n := len(Ifs.Blocks(run.Add(6 * time.Hour))); n != 12 {
		t.Errorf("an IFS 06Z run has %d blocks, want 12 (to +144 h)", n)
	}
	if Ifs.Horizon(run) != 360 || Ifs.Horizon(run.Add(6*time.Hour)) != 144 {
		t.Error("IFS horizons")
	}
	// AROME-OM: every field hourly to +48 h, eight blocks, four runs a day.
	om := AromeOMAntil
	for h := 0; h < 24; h += 6 {
		r := run.Add(time.Duration(h) * time.Hour)
		if om.Horizon(r) != 48 {
			t.Errorf("AROME-OM %02dZ horizon %d", h, om.Horizon(r))
		}
		bs := om.Blocks(r)
		if len(bs) != 8 || bs[0] != (Block{First: 0, Last: 6}) || bs[7] != (Block{First: 43, Last: 48}) {
			t.Errorf("AROME-OM %02dZ blocks %v", h, bs)
		}
	}
	for _, f := range []Family{FamilyLevels, FamilyHourlySurface, FamilySurface} {
		if got := om.Steps(om.Blocks(run)[7], f); !equalInts(got, []int{43, 44, 45, 46, 47, 48}) {
			t.Errorf("AROME-OM family %v steps %v", f, got)
		}
	}
	if _, err := om.RunTime("2026-10-06T03"); err == nil {
		t.Error("an AROME-OM run at 03Z was taken")
	}
	if _, err := om.RunTime("2026-10-06T18"); err != nil {
		t.Errorf("AROME-OM 18Z: %v", err)
	}
}

// A model whose ground is its own column's (ARPEGE, AROME-OM, which
// publishes none) wants no orography from its files.
func TestGroundFromColumnWantsNoOrography(t *testing.T) {
	for _, m := range Models {
		static := 0
		for _, w := range wants(m) {
			if w.static {
				static++
			}
		}
		if m.GroundFromColumn && static != 0 {
			t.Errorf("%s takes its ground from its column yet wants %d static fields", m.ID, static)
		}
		if !m.GroundFromColumn && static != 1 {
			t.Errorf("%s wants %d static fields, want its orography alone", m.ID, static)
		}
	}
}

// AROME-OM's files, one per hour: a block's four packages for each of its
// hours, under the domain's own directory and stem.
func TestAromeOMFilesAreHourly(t *testing.T) {
	run := time.Date(2026, 10, 6, 0, 0, 0, 0, time.UTC)
	files := MFBlockFiles(AromeOMAntil, run, AromeOMAntil.Blocks(run)[1]) // 7..12
	if len(files) != 24 {
		t.Fatalf("%d files, want 24", len(files))
	}
	if want := "pnt/2026-10-06T00:00:00Z/arome-om/ANTIL/0025/IP1/arome-om-ANTIL__0025__IP1__007H__2026-10-06T00:00:00Z.grib2"; files[0].Key != want {
		t.Errorf("first %s, want %s", files[0].Key, want)
	}
	if want := "pnt/2026-10-06T00:00:00Z/arome-om/ANTIL/0025/SP2/arome-om-ANTIL__0025__SP2__012H__2026-10-06T00:00:00Z.grib2"; files[23].Key != want {
		t.Errorf("last %s, want %s", files[23].Key, want)
	}
}

func equalInts(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestWantsAreUniqueAndComplete(t *testing.T) {
	for _, m := range Models {
		ws := wants(m) // indexWants panics on a duplicate key
		idx := indexWants(ws)
		l := LayoutFor(m)
		// A model taking its ground from its own column fills it from the
		// surface pressure and the heights (GroundFromColumn).
		filled := map[string]bool{VarElevation: m.GroundFromColumn}
		for _, w := range idx {
			if _, _, ok := l.Find(w.varKey); !ok {
				t.Errorf("%s: want %s fills no variable", m.ID, w.varKey)
			}
			filled[w.varKey] = true
		}
		for s := range l {
			for _, v := range l[s] {
				if !filled[v.Key()] {
					t.Errorf("%s: no source fills %s", m.ID, v.Key())
				}
			}
		}
	}
}

func TestTileRoundTrip(t *testing.T) {
	var td TileData
	for s := range td {
		td[s] = make([]int16, (s+1)*TileSize*TileSize)
		for i := range td[s] {
			td[s][i] = int16(i*7 - 900)
		}
		td[s][3] = Missing
	}
	payload, hashes, err := EncodeTile(&td)
	if err != nil {
		t.Fatal(err)
	}
	for s := Segment(0); s < NumSegments; s++ {
		got, err := DecodeSegment(payload, s)
		if err != nil {
			t.Fatal(err)
		}
		if len(got) != len(td[s]) || got[3] != Missing || got[10] != td[s][10] {
			t.Fatalf("segment %s did not round-trip", s)
		}
		if hashes[s] == (SegmentHash{}) {
			t.Fatal("no hash")
		}
	}
	if _, err := DecodeSegment(payload[:20], SegCloud); err == nil {
		t.Error("a truncated payload decoded")
	}
}

// miniModel is the golden fixture's model: a small grid whose x5 level is
// anchored off the corner (3, 2), tiles padded at the right and bottom
// edges, a masked north-west corner, and the levels and the surface
// pressure every 3 hours beside an hourly surface.
var miniModel = &Model{
	ID: "mini", Name: "mini", Producer: "test", Source: MeteoFrance,
	Grid:       Grid{Ni: 37, Nj: 23, North: 50_050_000, West: 1_050_000, Di: 25_000, Dj: 25_000},
	Levels:     []int{850, 700},
	CycleHours: 3,
	Pyramid:    []int{5},
	horizon:    func(time.Time) int { return 12 },
	blocks: func(time.Time) []Block {
		return []Block{{First: 0, Last: 6, Label: "00H06H"}, {First: 7, Last: 12, Label: "07H12H"}}
	},
}

// miniWide is the chain's second member in the read path's fixture: a
// coarser grid around the first, unmasked, every field 3-hourly with
// 3-hour gusts (ECMWF's rules).
var miniWide = &Model{
	ID: "miniwide", Name: "miniwide", Producer: "test", Source: ECMWF,
	Grid:       Grid{Ni: 31, Nj: 21, North: 51_000_000, West: 0, Di: 100_000, Dj: 100_000},
	Levels:     []int{850, 700},
	CycleHours: 6,
	Pyramid:    []int{5},
	horizon:    func(time.Time) int { return 12 },
	blocks:     func(time.Time) []Block { return []Block{{First: 0, Last: 12}} },
}

// miniValue is the fixture's synthetic field; shift tells runs and models
// apart.
func miniValue(v Var, i, j, h int, shift float64) float64 {
	base := float64(i)*0.5 - float64(j)*0.25 + float64(h) + shift
	switch v.Name {
	case VarElevation:
		return float64(i*10 + j)
	case VarMSLP:
		return 1010 + base/10
	case VarPS:
		return 990 + base/10
	case VarT, VarT2:
		return 5 + base/4 - float64(v.Level)/100
	case VarZ:
		return 12000 - float64(v.Level)*10 + base // rising up the column
	case VarGust:
		return math.Abs(base) + 2
	case VarCloud:
		return float64((i + j + h) % 101)
	}
	return base * (1 + float64(v.Level)/1000)
}

func buildMini(t *testing.T) (*Cube, time.Time) {
	run := time.Date(2026, 10, 6, 0, 0, 0, 0, time.UTC)
	return buildCube(t, miniModel, run, miniModel.Blocks(run)[0], 0, true), run
}

// buildCube fills one block of a fixture model; masked leaves the
// north-west corner without values.
func buildCube(t *testing.T, m *Model, run time.Time, b Block, shift float64, masked bool) *Cube {
	c := NewCube(m, run, b)
	g := m.Grid
	n := g.Ni * g.Nj
	for s := Segment(0); s < NumSegments; s++ {
		steps := c.Steps[s]
		if s == SegStatic {
			steps = []int{0}
		}
		for _, v := range c.Layout[s] {
			for _, h := range steps {
				if v.Name == VarGust && h == 0 {
					continue
				}
				vals := make([]float32, n)
				for k := range vals {
					i, j := k%g.Ni, k/g.Ni
					if masked && i+j < 6 {
						vals[k] = float32(math.NaN()) // the masked corner
						continue
					}
					vals[k] = float32(miniValue(v, i, j, h, shift))
				}
				if err := c.Set(v.Key(), h, vals, nil); err != nil {
					t.Fatal(err)
				}
				if v.Name == VarGust {
					period := time.Hour
					if m.Source == ECMWF {
						period = 3 * time.Hour
					}
					c.SetGustPeriod(h, period)
				}
			}
		}
	}
	return c
}

type fixturePoint struct {
	Lat    float64               `json:"lat"`
	Lon    float64               `json:"lon"`
	I      int                   `json:"i"`
	J      int                   `json:"j"`
	Series map[string][]*float64 `json:"series"` // null: no value at that step
	Absent bool                  `json:"absent,omitempty"`
}

// TestChainFixture writes (with -update) the read path's archives: the
// masked mini model's two runs (00Z, 03Z) of two blocks each, its levels
// 3-hourly across the blocks' boundary, and the wide unmasked model's one
// run, with every receipt; or checks their content still stands.
func TestChainFixture(t *testing.T) {
	dir := filepath.Join("..", "..", "loxodrome-nwp", "test", "fixtures", "chain")
	type built struct {
		model *Model
		run   time.Time
		index int
		block Block
		shift float64
		mask  bool
	}
	r00 := time.Date(2026, 10, 6, 0, 0, 0, 0, time.UTC)
	r03 := r00.Add(3 * time.Hour)
	var all []built
	for _, r := range []struct {
		run   time.Time
		shift float64
	}{{r00, 0}, {r03, 40}} {
		for i, b := range miniModel.Blocks(r.run) {
			all = append(all, built{miniModel, r.run, i, b, r.shift, true})
		}
	}
	all = append(all, built{miniWide, r00, 0, miniWide.Blocks(r00)[0], 80, false})
	var receipts []Receipt
	for _, x := range all {
		c := buildCube(t, x.model, x.run, x.block, x.shift, x.mask)
		key := ArchiveKey(x.model, x.run, x.index, x.block)
		path := filepath.Join(t.TempDir(), "a.pmtiles")
		rec, err := c.WriteArchive(path, nil)
		if err != nil {
			t.Fatal(err)
		}
		rec.Key = key
		rec.Built = time.Time{}
		receipts = append(receipts, rec)
		if *update {
			raw, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			out := filepath.Join(dir, filepath.FromSlash(key))
			if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(out, raw, 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}
	body, err := json.MarshalIndent(receipts, "", "\t")
	if err != nil {
		t.Fatal(err)
	}
	body = append(body, '\n')
	path := filepath.Join(dir, "receipts.json")
	if *update {
		if err := os.WriteFile(path, body, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	old, err := os.ReadFile(path)
	if err != nil || string(old) != string(body) {
		t.Fatalf("%s is stale (go test ./internal/nwp -run TestChainFixture -update): %v", path, err)
	}
}

func TestGoldenFixture(t *testing.T) {
	dir := filepath.Join("..", "..", "loxodrome-nwp", "test", "fixtures")
	archive := filepath.Join(dir, "mini-nwp.pmtiles")
	expected := filepath.Join(dir, "mini-nwp.json")
	c, _ := buildMini(t)
	if c.Steps[SegUVT][1] != 3 || len(c.Steps[SegSfc]) != 7 || len(c.Steps[SegPS]) != 3 {
		t.Fatalf("mini steps: levels %v, surface %v", c.Steps[SegUVT], c.Steps[SegSfc])
	}
	tmp := filepath.Join(t.TempDir(), "mini.pmtiles")
	rec, err := c.WriteArchive(tmp, nil)
	if err != nil {
		t.Fatal(err)
	}
	a, err := OpenArchive(tmp)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	if a.D.Levels[1].I0 != 3 || a.D.Levels[1].J0 != 2 {
		t.Fatalf("x5 anchors %d,%d, want 3,2", a.D.Levels[1].I0, a.D.Levels[1].J0)
	}
	g := a.D.Grid
	var points []fixturePoint
	for _, ij := range [][2]int{{0, 0}, {5, 0}, {3, 2}, {6, 0}, {18, 11}, {36, 22}, {35, 17}, {16, 16}, {15, 15}} {
		i, j := ij[0], ij[1]
		p := fixturePoint{Lat: float64(g.North-int64(j)*g.Dj) / 1e6, Lon: float64(g.West+int64(i)*g.Di) / 1e6, I: i, J: j, Series: map[string][]*float64{}}
		for _, seg := range a.D.Segments {
			for _, v := range seg.Vars {
				vals, _, ok, err := a.Series(i, j, v.Key())
				if err != nil {
					t.Fatal(err)
				}
				if !ok {
					p.Absent = true
					continue
				}
				out := make([]*float64, len(vals))
				for k, x := range vals {
					if !math.IsNaN(x) {
						x := x
						out[k] = &x
					}
				}
				p.Series[v.Key()] = out
			}
		}
		points = append(points, p)
	}
	// The masked corner reads missing, a covered point its quantised value.
	if p := points[0]; p.Series[VarElevation][0] != nil {
		t.Error("the masked corner has an elevation")
	}
	if p := points[4]; p.Series[VarElevation][0] == nil || *p.Series[VarElevation][0] != 191 {
		t.Errorf("point 18,11 elevation %v, want 191", p.Series[VarElevation])
	}
	if ps := points[4].Series[VarPS]; len(ps) != 3 || ps[1] == nil {
		t.Errorf("surface pressure %v: on the levels' three steps", ps)
	}
	if g := points[4].Series[VarGust]; g[0] != nil || g[1] == nil {
		t.Errorf("gusts %v: none at the analysis", g)
	}
	want := map[string]any{"descriptor": a.D, "receipt": map[string]any{"tiles": rec.Tiles, "content": rec.Content, "canaries": rec.Canaries}, "points": points}
	body, err := json.MarshalIndent(want, "", "\t")
	if err != nil {
		t.Fatal(err)
	}
	if *update {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		raw, err := os.ReadFile(tmp)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(archive, raw, 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(expected, append(body, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	// The committed archive must still read as the expected values say:
	// the Worker suite is held to both.
	old, err := os.ReadFile(expected)
	if err != nil {
		t.Fatalf("%v (regenerate with go test ./internal/nwp -run TestGoldenFixture -update)", err)
	}
	var oldDoc struct {
		Receipt struct {
			Content string `json:"content"`
		} `json:"receipt"`
	}
	if err := json.Unmarshal(old, &oldDoc); err != nil {
		t.Fatal(err)
	}
	if oldDoc.Receipt.Content != rec.Content {
		t.Errorf("the fixture's content changed: regenerate it with -update and rerun the Worker suite")
	}
	ca, err := OpenArchive(archive)
	if err != nil {
		t.Fatal(err)
	}
	defer ca.Close()
	for _, p := range points {
		for key, series := range p.Series {
			vals, _, ok, err := ca.Series(p.I, p.J, key)
			if err != nil || !ok {
				t.Fatalf("committed fixture at %d,%d %s: %v %v", p.I, p.J, key, ok, err)
			}
			for k, x := range vals {
				if (series[k] == nil) != math.IsNaN(x) || (series[k] != nil && *series[k] != x) {
					t.Fatalf("committed fixture disagrees at %d,%d %s step %d", p.I, p.J, key, k)
				}
			}
		}
	}
}

func TestCoverageIsTheIntersection(t *testing.T) {
	c, _ := buildMini(t)
	g := miniModel.Grid
	if got, want := c.CoveredCount(), g.Ni*g.Nj-21; got != want {
		t.Errorf("covered %d, want %d (the 21-point corner masked)", got, want)
	}
	// A field masking one more point removes it from every variable.
	vals := make([]float32, g.Ni*g.Nj)
	for k := range vals {
		vals[k] = 1
	}
	vals[200] = float32(math.NaN())
	if err := c.Set(Var{Name: VarCloud, Level: 850}.Key(), 6, vals, nil); err == nil {
		t.Fatal("a field arriving twice was accepted")
	}
}

func TestPlausibilityRefusesAUnitGoneWrong(t *testing.T) {
	c, _ := buildMini(t)
	if err := c.CheckPlausible(); err != nil {
		t.Fatalf("the clean mini cube: %v", err)
	}
	// Heights falling up the column (a level swap) are refused.
	_, vi, _ := c.Layout.Find(Var{Name: VarZ, Level: 700}.Key())
	f := c.data[SegZ][c.slot(SegZ, vi, 0)]
	for k := range f {
		if f[k] != Missing {
			f[k] = 1
		}
	}
	if err := c.CheckPlausible(); err == nil {
		t.Fatal("heights falling up the column passed")
	}
}

// TestModelsFixture writes (with -update) or checks the model table the
// Worker's registry is held to: one statement of the grids, levels, run
// cycles, horizons and time blocks, in Go.
func TestModelsFixture(t *testing.T) {
	type blockJSON struct {
		First int    `json:"first"`
		Last  int    `json:"last"`
		Name  string `json:"name"`
	}
	type mfJSON struct {
		Dir      string              `json:"dir"`
		Stem     string              `json:"stem"`
		CloudPkg string              `json:"cloudPkg"`
		Hourly   bool                `json:"hourly"`
		Keys     map[string][]string `json:"keys"`
	}
	type modelJSON struct {
		ID         string                 `json:"id"`
		Name       string                 `json:"name"`
		Producer   string                 `json:"producer"`
		Grid       GridDesc               `json:"grid"`
		Levels     []int                  `json:"levels"`
		CycleHours int                    `json:"cycleHours"`
		Horizons   map[string]int         `json:"horizons"`
		Blocks     map[string][]blockJSON `json:"blocks"`
		Pyramid    []Level                `json:"pyramid"`
		Cloud      string                 `json:"cloud"`
		// The Météo-France file naming, with a 00Z run's first and last
		// blocks' keys: what discover.ts must list (mfKeys).
		MF *mfJSON `json:"mf,omitempty"`
	}
	var out []modelJSON
	for _, m := range Models {
		lv, err := Pyramid(m)
		if err != nil {
			t.Fatal(err)
		}
		g := m.Grid
		mj := modelJSON{ID: m.ID, Name: m.Name, Producer: m.Producer, Levels: m.Levels, CycleHours: m.CycleHours,
			Grid:     GridDesc{Ni: g.Ni, Nj: g.Nj, North: g.North, West: g.West, Di: g.Di, Dj: g.Dj, Wraps: g.Wraps},
			Horizons: map[string]int{}, Blocks: map[string][]blockJSON{}, Pyramid: lv, Cloud: "native"}
		if !m.NativeCloud {
			mj.Cloud = "sundqvist"
		}
		if m.Source == MeteoFrance {
			run := time.Date(2026, 10, 6, 0, 0, 0, 0, time.UTC)
			blocks := m.Blocks(run)
			mj.MF = &mfJSON{Dir: m.mfDir, Stem: m.mfStem, CloudPkg: m.cloudPkg, Hourly: m.mfHourly, Keys: map[string][]string{}}
			for _, b := range []Block{blocks[0], blocks[len(blocks)-1]} {
				for _, f := range MFBlockFiles(m, run, b) {
					mj.MF.Keys[b.Name()] = append(mj.MF.Keys[b.Name()], f.Key)
				}
			}
		}
		for h := 0; h < 24; h += m.CycleHours {
			run := time.Date(2026, 10, 6, h, 0, 0, 0, time.UTC)
			key := fmt.Sprintf("%02d", h)
			mj.Horizons[key] = m.Horizon(run)
			for _, b := range m.Blocks(run) {
				mj.Blocks[key] = append(mj.Blocks[key], blockJSON{b.First, b.Last, b.Name()})
			}
		}
		out = append(out, mj)
	}
	body, err := json.MarshalIndent(out, "", "\t")
	if err != nil {
		t.Fatal(err)
	}
	body = append(body, '\n')
	path := filepath.Join("..", "..", "loxodrome-nwp", "test", "fixtures", "models.json")
	if *update {
		if err := os.WriteFile(path, body, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	old, err := os.ReadFile(path)
	if err != nil || string(old) != string(body) {
		t.Fatalf("%s is stale (go test ./internal/nwp -run TestModelsFixture -update): %v", path, err)
	}
}

// ifsIndex writes an ECMWF .index for one step listing every wanted field,
// the gust under `gust` ("" leaves it out), plus fields nobody wants.
func ifsIndex(t *testing.T, step int, gust string, extra ...string) []byte {
	t.Helper()
	var b strings.Builder
	line := func(param, levtype, level string, off int) {
		lv := ""
		if level != "" {
			lv = fmt.Sprintf(`, "levelist": %q`, level)
		}
		fmt.Fprintf(&b, `{"domain": "g", "step": "%d", "levtype": %q%s, "param": %q, "_offset": %d, "_length": 100}`+"\n", step, levtype, lv, param, off*100)
	}
	n := 0
	for _, w := range wants(Ifs) {
		switch {
		case w.ifs == "", w.static && step != 0:
			continue
		case w.gust:
			if gust == "" || step == 0 {
				continue
			}
			line(gust, w.levtype, "", n)
		case w.levtype == "pl":
			line(w.ifs, "pl", fmt.Sprint(w.level0), n)
		default:
			line(w.ifs, w.levtype, "", n)
		}
		n++
	}
	for _, p := range extra {
		line(p, "sfc", "", n)
		n++
	}
	return []byte(b.String())
}

func TestIFSPicksTheGustUnderEveryName(t *testing.T) {
	ws := wants(Ifs)
	// 46 fields a step past 0: u v t gh r on eight levels, 10u 10v 2t
	// msl sp and the gust.
	for _, c := range []struct {
		step int
		gust string
	}{{3, "10fg"}, {90, "10fg"}, {93, "10fg3"}, {144, "10fg3"}, {150, "10fg"}, {360, "10fg6"}} {
		picks, err := ifsPicks(ifsIndex(t, c.step, c.gust, "tp", "sf"), ws, c.step)
		if err != nil {
			t.Fatalf("step %d, gust %s: %v", c.step, c.gust, err)
		}
		if len(picks) != 46 {
			t.Fatalf("step %d: %d picks", c.step, len(picks))
		}
		found := false
		for _, p := range picks {
			found = found || p.Param == c.gust
		}
		if !found {
			t.Errorf("step %d: the gust %s not picked", c.step, c.gust)
		}
	}
	// Step 0: the orography, and no gust (none is published).
	picks, err := ifsPicks(ifsIndex(t, 0, ""), ws, 0)
	if err != nil || len(picks) != 46 {
		t.Fatalf("step 0: %d picks, %v", len(picks), err)
	}
	// Two names for the gust at one step: one pick, never two.
	picks, err = ifsPicks(ifsIndex(t, 96, "10fg3", "10fg"), ws, 96)
	if err != nil || len(picks) != 46 {
		t.Fatalf("both gust names: %d picks, %v", len(picks), err)
	}
	// A field the step does not list is refused, as before.
	if _, err := ifsPicks(ifsIndex(t, 96, ""), ws, 96); err == nil || !strings.Contains(err.Error(), "45 of the 46") {
		t.Fatalf("a missing gust: %v", err)
	}
}

// isaHeightM is the ICAO standard atmosphere's height of a pressure.
func isaHeightM(hPa float64) float64 {
	return 288.15 / 0.0065 * (1 - math.Pow(hPa/1013.25, isaExponent))
}

func TestGroundInColumn(t *testing.T) {
	mf := []int{1000, 950, 925, 900, 850, 800, 750, 700, 650, 600, 550, 500, 450, 400, 350, 300}
	isa := func(levels []int) []float64 {
		out := make([]float64, len(levels))
		for i, p := range levels {
			out[i] = isaHeightM(float64(p))
		}
		return out
	}
	for _, c := range []struct {
		name   string
		ps     float64
		levels []int
	}{
		{"between two levels (Megève's ARPEGE point, 2026-10-07)", 825.1, mf},
		{"on IFS's eight levels", 825.1, []int{1000, 925, 850, 700, 600, 500, 400, 300}},
		{"below the first level", 1025, mf},
		{"on a level", 850, mf},
	} {
		z, ok := GroundInColumn(c.ps, c.levels, isa(c.levels))
		if !ok || math.Abs(z-isaHeightM(c.ps)) > 0.01 {
			t.Errorf("%s: %v %.3f, want %.3f", c.name, ok, z, isaHeightM(c.ps))
		}
	}
	// An isothermal layer at 0 °C over IFS's widest low one: within 8 m.
	iso := func(p float64) float64 { return 1500 + 287.05287*273.15/standardGravity*math.Log(850/p) }
	if z, ok := GroundInColumn(775, []int{850, 700}, []float64{iso(850), iso(700)}); !ok || math.Abs(z-iso(775)) > 8 {
		t.Errorf("isothermal: %v %.1f, want %.1f", ok, z, iso(775))
	}
	// A missing level is skipped; two levels at least; heights must rise.
	h := isa(mf)
	h[4] = math.NaN()
	if z, ok := GroundInColumn(860, mf, h); !ok || math.Abs(z-isaHeightM(860)) > 0.01 {
		t.Errorf("a missing level: %v %.3f", ok, z)
	}
	if _, ok := GroundInColumn(900, []int{850}, []float64{1500}); ok {
		t.Error("one level found a ground")
	}
	if _, ok := GroundInColumn(900, []int{1000, 850}, []float64{100, 90}); ok {
		t.Error("a column falling as it rises found a ground")
	}
}

// TestGroundFromColumn: a model flagged to take its ground from its own
// column (ARPEGE) wants no height field and finds, in each block, the
// ground its surface pressure stands on, however far the published height
// field would have stood above it.
func TestGroundFromColumn(t *testing.T) {
	for _, w := range wants(Arpege) {
		if w.static {
			t.Fatalf("ARPEGE still wants %s, the height field its surface pressure does not stand on", w.varKey)
		}
	}
	oro := 0
	for _, m := range []*Model{Arome, Ifs} {
		for _, w := range wants(m) {
			if w.static {
				oro++
			}
		}
	}
	if oro != 2 {
		t.Fatalf("AROME and IFS keep their own orography: %d static wants", oro)
	}

	m := *miniModel
	m.GroundFromColumn = true
	run := time.Date(2026, 10, 6, 0, 0, 0, 0, time.UTC)
	b := m.Blocks(run)[1]
	c := NewCube(&m, run, b)
	g := m.Grid
	n := g.Ni * g.Nj
	// Each point's surface pressure stands at 100 m per column index over a
	// standard day.
	ground := func(k int) float64 { return float64(k%g.Ni) * 100 }
	pressureAt := func(z float64) float64 {
		return 1013.25 * math.Pow(1-0.0065*z/288.15, 1/isaExponent)
	}
	for _, h := range c.Steps[SegZ] {
		for _, lv := range m.Levels {
			vals := make([]float32, n)
			for k := range vals {
				vals[k] = float32(isaHeightM(float64(lv)))
			}
			if err := c.Set(Var{Name: VarZ, Level: lv}.Key(), h, vals, nil); err != nil {
				t.Fatal(err)
			}
		}
	}
	for _, h := range c.Steps[SegPS] {
		vals := make([]float32, n)
		for k := range vals {
			vals[k] = float32(pressureAt(ground(k)))
		}
		if err := c.Set(VarPS, h, vals, nil); err != nil {
			t.Fatal(err)
		}
	}
	elev, err := c.GroundFromColumn()
	if err != nil {
		t.Fatal(err)
	}
	for k := 0; k < n; k++ {
		// The pressure is stored to the tenth of a hectopascal: about a metre.
		if math.Abs(float64(elev[k])-ground(k)) > 2 {
			t.Fatalf("point %d: ground %d m, want %.0f", k, elev[k], ground(k))
		}
	}
}
