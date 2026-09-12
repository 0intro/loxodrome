// The witness's reference: what the ground actually holds, against which a
// placed panel's own ink can be measured.
//
// THE REFERENCE IS A DATABASE, NOT A PICTURE. IGN publishes BD TOPO, the
// State's topographic survey, as keyless GeoJSON over WFS, and that beats an
// orthophoto at this job on every count that matters here. A building in BD
// TOPO is a FOOTPRINT; in an orthophoto it is a roof, and a twenty metre
// roof leans up to seven metres away from the camera, which reads exactly
// like the scale error this instrument is hunting. There are no shadows, no
// JPEG blocking to mistake for edges, and no flight vintage. Over featureless
// farmland it returns nothing, honestly, where a gradient threshold always
// finds something.
//
// A RENDERED map, IGN's own Plan or OpenStreetMap's tiles, is the one option
// refused: a map displaces features to stay legible, so matching against one
// measures the renderer and not the plate.
//
// Everything here lives in a _test.go file on purpose. Go does not link test
// files into the binary, so cmd/vacgeo CANNOT call any of it. The compiler
// is the guard, and it costs nothing.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// bdtopoBase is the Geoplateforme's WFS. No key, no quota form, and the
// same host the app's own IGN base layer already draws from.
const bdtopoBase = "https://data.geopf.fr/wfs/ows"

// How many questions to have in flight at once. The service is public and
// shared with the app's own base layer, so this is deliberately small; it is
// six rather than three only because a refusal now stops every worker
// (hold and cool) instead of one worker retrying into the same wall while
// the other two keep knocking.
const witnessGate = 3

// bdtopoLayers are the BD TOPO classes whose geometry a VAC plate also
// draws, and which it draws in the SAME PLACE: a footprint against a
// footprint, an outline against an outline.
//
// `troncon_de_route` is deliberately absent. BD TOPO gives a road as its
// CENTRELINE and these plates draw roads as the gap between their kerbs, so
// every road sample would sit half a carriageway off a reference that was
// never in the same place. A dense reference that is biased is worse than a
// thin one that is not.
var bdtopoLayers = []string{
	"batiment",
	"piste_d_aerodrome",
	"equipement_de_transport",
	"construction_surfacique",
	"terrain_de_sport",
	"cimetiere",
	"surface_hydrographique",
	"zone_de_vegetation",
}

// bdtopoCoarse is what a GENERALISED sheet draws instead. Past about 20 m of
// ground to the page point an approach chart states no building and no
// apron; what it still draws, and draws because they are landmarks, are the
// built-up areas as blobs, the coast, the big rivers and lakes, the railways
// and the numbered roads.
//
// `batiment` is deliberately absent rather than added to: at this scale a
// cell holds tens of thousands of footprints that the sheet never drew, and
// a reference the ink cannot correspond to is not a thinner signal but a
// different measurement.
var bdtopoCoarse = []string{
	"zone_d_habitation",
	"limite_terre_mer",
	"plan_d_eau",
	"cours_d_eau",
	"troncon_de_voie_ferree",
	"route_numerotee_ou_nommee",
}

// How big a reference cell is, in degrees, for each of the two scales. The
// coarse one is five times the fine one in each direction because a
// generalised panel reaches over tens of kilometres, and its layers are
// sparse enough to answer such a cell in one or two pages where `batiment`
// would need twenty.
const (
	fineCellDeg   = 0.02
	coarseCellDeg = 0.10
)

// refSeg is one reference edge, in the panel's own local metre frame.
type refSeg struct{ x1, y1, x2, y2 float64 }

// bdtopoFetcher caches a WFS answer per layer and bounding box. The shape is
// cmd/terrain's fetcher: stat first, write to .part, rename, and remember
// what the server said was absent so a second run does not ask again.
type bdtopoFetcher struct {
	dir     string
	client  *http.Client
	gate    chan struct{}
	mu      sync.Mutex
	offline bool

	// What the service said, counted. An instrument that reports "no
	// reference here" when the answer was really "the service refused" is
	// worse than no instrument, because the refusal reads as a clean bill
	// of health for the panel.
	ok, failed int
	lastErr    string

	// Every cell the corpus asked for, so a sweep can say how big its own
	// reference is and an offline run can size the fetch before it starts.
	asked map[string]bool
	held  int

	// When the service has asked to be left alone. A refusal for rate is
	// about the CALLER and not about the request, so it is answered by
	// every worker waiting rather than by this one retrying into the same
	// wall while the other two keep knocking.
	until time.Time
}

func (f *bdtopoFetcher) tally() (int, int, string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.ok, f.failed, f.lastErr
}

func (f *bdtopoFetcher) note(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err == nil {
		f.ok++
		return
	}
	f.failed++
	f.lastErr = err.Error()
}

// cells is how many distinct reference cells the corpus asked for, and how
// many of those reads the cache answered.
func (f *bdtopoFetcher) cells() (asked, held int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.asked), f.held
}

func newBDTopoFetcher(dir string, offline bool) *bdtopoFetcher {
	return &bdtopoFetcher{
		dir:     dir,
		client:  &http.Client{Timeout: 2 * time.Minute},
		gate:    make(chan struct{}, witnessGate),
		offline: offline,
	}
}

// bbox is a geographic window, south-west to north-east.
type bbox struct{ lat0, lon0, lat1, lon1 float64 }

// key names the cached answer. Six decimal places is a tenth of a metre,
// which is finer than any window edge this ever asks for.
func (b bbox) key(layer string) string {
	return fmt.Sprintf("%s_%.6f_%.6f_%.6f_%.6f.json", layer, b.lat0, b.lon0, b.lat1, b.lon1)
}

// get returns one layer's geometry over one window, from the cache if it is
// there. WFS 2.0 with an EPSG:4326 URN takes its bounding box LATITUDE
// FIRST, which is the axis order the standard states and the one a
// lon-first request silently answers empty on.
func (f *bdtopoFetcher) get(layer string, b bbox) ([]byte, error) {
	path := filepath.Join(f.dir, b.key(layer))
	f.mu.Lock()
	if f.asked == nil {
		f.asked = map[string]bool{}
	}
	f.asked[b.key(layer)] = true
	f.mu.Unlock()
	if body, err := os.ReadFile(path); err == nil {
		f.mu.Lock()
		f.held++
		f.mu.Unlock()
		return body, nil
	}
	if f.offline {
		return nil, nil
	}
	q := url.Values{
		"SERVICE":      {"WFS"},
		"VERSION":      {"2.0.0"},
		"REQUEST":      {"GetFeature"},
		"TYPENAMES":    {"BDTOPO_V3:" + layer},
		"SRSNAME":      {"EPSG:4326"},
		"OUTPUTFORMAT": {"application/json"},
		// Geometry only. The attributes are three quarters of the bytes
		// and this instrument reads none of them.
		"PROPERTYNAME": {"geometrie"},
		"COUNT":        {"20000"},
		"BBOX": {fmt.Sprintf("%.6f,%.6f,%.6f,%.6f,urn:ogc:def:crs:EPSG::4326",
			b.lat0, b.lon0, b.lat1, b.lon1)},
	}
	f.gate <- struct{}{}
	defer func() { <-f.gate }()
	body, err := f.pages(q)
	f.note(err)
	if err != nil {
		return nil, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := os.MkdirAll(f.dir, 0o755); err != nil {
		return nil, err
	}
	tmp := path + ".part"
	if err := os.WriteFile(tmp, body, 0o644); err != nil {
		return nil, err
	}
	return body, os.Rename(tmp, path)
}

// hold waits out a cooldown some other worker's refusal set.
func (f *bdtopoFetcher) hold() {
	for {
		f.mu.Lock()
		until := f.until
		f.mu.Unlock()
		d := time.Until(until)
		if d <= 0 {
			return
		}
		time.Sleep(d)
	}
}

// cool asks every worker to wait, because the service refused this one.
func (f *bdtopoFetcher) cool(d time.Duration) {
	f.mu.Lock()
	if t := time.Now().Add(d); t.After(f.until) {
		f.until = t
	}
	f.mu.Unlock()
}

// pages asks for one cell and keeps asking until the service has given all
// of it.
//
// The service caps an answer at five thousand features whatever COUNT says,
// and it SAYS SO: numberMatched is the real total and numberReturned what
// it sent. Nothing read those two fields at first, so a cell holding ten
// thousand buildings was answered with half of them and no one was told,
// and the reference was thinned in exactly the places that have the most of
// it. About one cell in eighty is affected, so the paging costs almost
// nothing; the alternative is an instrument that is quietly weakest over
// towns and says nothing about it.
func (f *bdtopoFetcher) pages(q url.Values) ([]byte, error) {
	var feats []json.RawMessage
	for {
		if len(feats) > 0 {
			q.Set("STARTINDEX", strconv.Itoa(len(feats)))
		}
		body, err := f.attempt(bdtopoBase + "?" + q.Encode())
		if err != nil {
			return nil, err
		}
		var doc struct {
			Features      []json.RawMessage `json:"features"`
			NumberMatched int               `json:"numberMatched"`
		}
		if err := json.Unmarshal(body, &doc); err != nil {
			return nil, err
		}
		feats = append(feats, doc.Features...)
		if len(doc.Features) == 0 || len(feats) >= doc.NumberMatched {
			break
		}
	}
	// Written back as one collection that states its own completeness, so
	// a cached cell can be asked later whether it holds everything.
	return json.Marshal(struct {
		Type           string            `json:"type"`
		NumberMatched  int               `json:"numberMatched"`
		NumberReturned int               `json:"numberReturned"`
		Features       []json.RawMessage `json:"features"`
	}{"FeatureCollection", len(feats), len(feats), feats})
}

// attempt is one request, retried while the service is refusing. The
// service is public and shared with the app's own base layer, so a refusal
// is answered by waiting rather than by trying harder.
func (f *bdtopoFetcher) attempt(url string) ([]byte, error) {
	var body []byte
	var err error
	for n := 0; ; n++ {
		f.hold()
		body, err = f.once(url)
		if err == nil || n == 5 {
			return body, err
		}
		wait := time.Duration(1<<n) * time.Second
		if strings.Contains(err.Error(), "429") {
			// Short and shared. The service refuses on CONCURRENCY rather
			// than on volume, so what it wants is one fewer question at
			// once for a moment, not a minute of silence: a fifteen second
			// freeze per refusal cost more throughput than the refusals
			// did.
			wait = time.Duration(1<<n) * time.Second
			f.cool(wait)
		}
		time.Sleep(wait)
	}
}

// once is one attempt at one request.
func (f *bdtopoFetcher) once(url string) ([]byte, error) {
	resp, err := f.client.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s", resp.Status)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if !strings.HasPrefix(strings.TrimSpace(string(body)), "{") {
		return nil, fmt.Errorf("not JSON")
	}
	return body, nil
}

// tiles cuts a window into the cells of a FIXED grid on the ellipsoid, and
// not into fractions of the window itself.
//
// The difference is the whole value of the cache. A fraction of a window is
// named by where the window IS, so a panel the reader moves by a metre asks
// a question nobody has ever asked, and a sweep that follows any change to
// the dataset refetches every byte it already holds. A cell of a grid is
// named by where the GROUND is: the five windows of one panel share their
// cells, so do two panels of one aerodrome, so do two aerodromes near each
// other, and a panel that moves asks for what is already on disk.
//
// The cell is deliberately no larger than the old cut, so no single request
// grows: what changes is that the answer can be used twice.
func (b bbox) tiles(deg float64) []bbox {
	i0, i1 := int(math.Floor(b.lat0/deg)), int(math.Floor(b.lat1/deg))
	j0, j1 := int(math.Floor(b.lon0/deg)), int(math.Floor(b.lon1/deg))
	out := make([]bbox, 0, (i1-i0+1)*(j1-j0+1))
	for i := i0; i <= i1; i++ {
		for j := j0; j <= j1; j++ {
			out = append(out, bbox{
				lat0: float64(i) * deg, lon0: float64(j) * deg,
				lat1: float64(i+1) * deg, lon1: float64(j+1) * deg,
			})
		}
	}
	return out
}

// refSegments turns one WFS answer into edges in a local metre frame.
//
// Every geometry type BD TOPO answers with is walked the same way, because
// what this wants from a building, a runway or a lake is identical: the
// straight pieces of its outline. A degenerate edge is dropped; a reference
// point carries no direction and would pull the score nowhere.
func refSegments(body []byte, fr local, out []refSeg) ([]refSeg, error) {
	if len(body) == 0 {
		return out, nil
	}
	var doc struct {
		Features []struct {
			Geometry struct {
				Type        string          `json:"type"`
				Coordinates json.RawMessage `json:"coordinates"`
			} `json:"geometry"`
		} `json:"features"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return out, err
	}
	for _, ft := range doc.Features {
		rings := ringsOf(ft.Geometry.Type, ft.Geometry.Coordinates)
		for _, r := range rings {
			for i := 0; i+1 < len(r); i++ {
				a := fr.to(latLon{lat: r[i][1], lon: r[i][0]})
				b := fr.to(latLon{lat: r[i+1][1], lon: r[i+1][0]})
				if math.Hypot(b[0]-a[0], b[1]-a[1]) < 0.25 {
					continue
				}
				out = append(out, refSeg{a[0], a[1], b[0], b[1]})
			}
		}
	}
	return out, nil
}

// ringsOf flattens any GeoJSON geometry to its lines of positions. BD TOPO
// answers MultiPolygon for a building, MultiLineString for a watercourse and
// Polygon for a runway, and a position may carry a third ordinate.
func ringsOf(kind string, raw json.RawMessage) [][][]float64 {
	depth := map[string]int{
		"Point": 0, "MultiPoint": 1, "LineString": 1, "MultiLineString": 2,
		"Polygon": 2, "MultiPolygon": 3,
	}[kind]
	if depth < 1 {
		return nil
	}
	var out [][][]float64
	var walk func(raw json.RawMessage, d int)
	walk = func(raw json.RawMessage, d int) {
		if d == 1 {
			var ring [][]float64
			if json.Unmarshal(raw, &ring) == nil && len(ring) > 1 {
				out = append(out, ring)
			}
			return
		}
		var parts []json.RawMessage
		if json.Unmarshal(raw, &parts) != nil {
			return
		}
		for _, p := range parts {
			walk(p, d-1)
		}
	}
	walk(raw, depth)
	return out
}

// field is a distance-to-the-nearest-reference grid, in cells of `cell`
// metres, anchored at (x0, y0) of the panel's local frame.
//
// A distance FIELD and not a hit test, because a hit test has a one-cell
// peak: a coarse search steps straight over it and a refinement has nothing
// to climb. The field is what makes the score smooth enough to search at
// all.
type field struct {
	x0, y0, cell float64
	nx, ny       int
	d            []float64 // metres to the nearest reference edge
}

func (f *field) at(x, y float64) float64 {
	i := int((x - f.x0) / f.cell)
	j := int((y - f.y0) / f.cell)
	if i < 0 || j < 0 || i >= f.nx || j >= f.ny {
		return math.Inf(1)
	}
	return f.d[j*f.nx+i]
}

// newField rasterises the reference edges and distance-transforms them.
func newField(segs []refSeg, x0, y0, cell float64, nx, ny int) *field {
	f := &field{x0: x0, y0: y0, cell: cell, nx: nx, ny: ny, d: make([]float64, nx*ny)}
	const far = 1e12
	for i := range f.d {
		f.d[i] = far
	}
	mark := func(x, y float64) {
		i := int(math.Round((x - x0) / cell))
		j := int(math.Round((y - y0) / cell))
		if i < 0 || j < 0 || i >= nx || j >= ny {
			return
		}
		f.d[j*nx+i] = 0
	}
	for _, s := range segs {
		l := math.Hypot(s.x2-s.x1, s.y2-s.y1)
		n := int(l/cell) + 1
		for k := 0; k <= n; k++ {
			t := float64(k) / float64(n)
			mark(s.x1+(s.x2-s.x1)*t, s.y1+(s.y2-s.y1)*t)
		}
	}
	squaredEDT(f.d, nx, ny)
	for i := range f.d {
		f.d[i] = math.Sqrt(f.d[i]) * cell
	}
	return f
}

// squaredEDT is Felzenszwalb and Huttenlocher's exact squared Euclidean
// distance transform, in place, over a grid whose zero cells are the seeds
// and whose others are a large number. Two separable passes, linear in the
// number of cells, no approximation and no dependency.
func squaredEDT(d []float64, nx, ny int) {
	buf := make([]float64, max(nx, ny))
	v := make([]int, max(nx, ny))
	z := make([]float64, max(nx, ny)+1)
	pass := func(n int, get func(int) float64, set func(int, float64)) {
		for q := 0; q < n; q++ {
			buf[q] = get(q)
		}
		k := 0
		v[0] = 0
		z[0] = math.Inf(-1)
		z[1] = math.Inf(1)
		for q := 1; q < n; q++ {
			s := 0.0
			for {
				fq, fv := buf[q]+float64(q*q), buf[v[k]]+float64(v[k]*v[k])
				s = (fq - fv) / float64(2*q-2*v[k])
				if s > z[k] {
					break
				}
				k--
			}
			k++
			v[k] = q
			z[k] = s
			z[k+1] = math.Inf(1)
		}
		k = 0
		for q := 0; q < n; q++ {
			for z[k+1] < float64(q) {
				k++
			}
			dq := float64(q - v[k])
			set(q, dq*dq+buf[v[k]])
		}
	}
	for i := 0; i < nx; i++ {
		pass(ny, func(j int) float64 { return d[j*nx+i] }, func(j int, val float64) { d[j*nx+i] = val })
	}
	for j := 0; j < ny; j++ {
		row := d[j*nx : (j+1)*nx]
		pass(nx, func(i int) float64 { return row[i] }, func(i int, val float64) { row[i] = val })
	}
}

func TestWitnessSquaredEDT(t *testing.T) {
	// Against brute force, on a grid whose seeds are awkwardly placed: the
	// transform is the whole reason the score can be searched coarsely, so
	// an approximation here would be invisible and wrong everywhere.
	const nx, ny = 17, 11
	seeds := [][2]int{{0, 0}, {16, 10}, {5, 6}, {5, 7}, {12, 2}}
	d := make([]float64, nx*ny)
	for i := range d {
		d[i] = 1e12
	}
	for _, s := range seeds {
		d[s[1]*nx+s[0]] = 0
	}
	squaredEDT(d, nx, ny)
	for j := 0; j < ny; j++ {
		for i := 0; i < nx; i++ {
			want := math.Inf(1)
			for _, s := range seeds {
				dx, dy := float64(i-s[0]), float64(j-s[1])
				want = math.Min(want, dx*dx+dy*dy)
			}
			if got := d[j*nx+i]; math.Abs(got-want) > 1e-9 {
				t.Fatalf("at (%d,%d) got %g, want %g", i, j, got, want)
			}
		}
	}
}

func TestWitnessFieldMeasuresMetres(t *testing.T) {
	fr := newLocal(latLon{lat: 48.8, lon: 2.4})
	// One reference edge 100 m long, lying on the frame's own east axis.
	segs := []refSeg{{0, 0, 100, 0}}
	f := newField(segs, -50, -50, 1, 220, 120)
	for _, tc := range []struct{ x, y, want float64 }{
		{50, 0, 0}, {50, 10, 10}, {50, -25, 25}, {0, 40, 40},
	} {
		if got := f.at(tc.x, tc.y); math.Abs(got-tc.want) > 1.5 {
			t.Errorf("at (%g,%g) = %.2f m, want about %.0f", tc.x, tc.y, got, tc.want)
		}
	}
	if !math.IsInf(f.at(1e6, 0), 1) {
		t.Error("a point off the grid must read as no evidence, not as zero")
	}
	_ = fr
}

func TestWitnessRefSegmentsReadsEveryGeometryBDTopoAnswers(t *testing.T) {
	fr := newLocal(latLon{lat: 48.8, lon: 2.4})
	// A building (MultiPolygon with a third ordinate, which BD TOPO
	// carries), a runway (Polygon) and a watercourse (LineString).
	body := []byte(`{"type":"FeatureCollection","features":[
	 {"type":"Feature","geometry":{"type":"MultiPolygon","coordinates":
	   [[[[2.4,48.8,58.4],[2.4010,48.8,58.4],[2.4010,48.8010,58.4],[2.4,48.8,58.4]]]]}},
	 {"type":"Feature","geometry":{"type":"Polygon","coordinates":
	   [[[2.4,48.8],[2.4020,48.8],[2.4020,48.8005],[2.4,48.8]]]}},
	 {"type":"Feature","geometry":{"type":"LineString","coordinates":
	   [[2.4,48.8],[2.4030,48.8]]}},
	 {"type":"Feature","geometry":{"type":"Point","coordinates":[2.4,48.8]}}
	]}`)
	got, err := refSegments(body, fr, nil)
	if err != nil {
		t.Fatal(err)
	}
	// Three outlines of three, three and one edges; the point carries no
	// direction and is not a reference.
	if len(got) != 7 {
		t.Fatalf("%d edges, want 7: %v", len(got), got)
	}
	// And the metres are the ellipsoid's. 0.0010 degrees of longitude at
	// 48.8 is 73.5 m, not the 78 m a sphere would give.
	if l := math.Hypot(got[0].x2-got[0].x1, got[0].y2-got[0].y1); math.Abs(l-73.5) > 1 {
		t.Errorf("first edge %.1f m, want about 73.5", l)
	}
	// An empty answer is not an error: a window over the sea has no
	// features and must say so rather than fail.
	if got, err := refSegments(nil, fr, nil); err != nil || got != nil {
		t.Errorf("empty body = %v, %v; want nothing and no error", got, err)
	}
}

func TestWitnessBBoxKeyIsLatitudeFirst(t *testing.T) {
	// WFS 2.0 with an EPSG:4326 URN takes latitude first. A lon-first
	// request does not fail, it answers EMPTY, which would read as "no
	// reference here" over the whole corpus.
	b := bbox{lat0: 48.79, lon0: 2.44, lat1: 48.81, lon1: 2.47}
	if k := b.key("batiment"); !strings.HasPrefix(k, "batiment_48.79") {
		t.Errorf("cache key %q, want the latitude first", k)
	}
}
