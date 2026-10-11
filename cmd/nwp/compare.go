package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math"
	"math/rand/v2"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/nwp"
)

// The Open-Meteo twin of each ingested model: its models= value and the
// run directory whose meta names the run it serves.
var openMeteoTwin = map[string][2]string{
	"arome0025": {"meteofrance_arome_france", "meteofrance_arome_france0025"},
	"arpege01":  {"meteofrance_arpege_europe", "meteofrance_arpege_europe"},
	"ifs025":    {"ecmwf_ifs025", "ecmwf_ifs025"},
}

// cmdCompare is the differential harness: the first block of the run
// Open-Meteo serves, read through our archive at sampled grid nodes, held
// against Open-Meteo's own answer for the same nodes and hours. It only
// runs when Open-Meteo's meta names the very run the archive holds.
func cmdCompare(args []string) error {
	fs := flag.NewFlagSet("compare", flag.ExitOnError)
	model := fs.String("model", "", "one of the models Open-Meteo also serves: arome0025, arpege01 or ifs025")
	dir := fs.String("archive", "", "the store directory holding first/<model>/<run>.pmtiles")
	n := fs.Int("n", 50, "grid nodes")
	levelsFlag := fs.String("levels", "925,850,700,500", "levels compared (hPa)")
	seed := fs.Uint64("seed", 1, "node sampling seed")
	fs.Parse(args)
	m, err := nwp.ModelByID(*model)
	if err != nil {
		return err
	}
	twin, ok := openMeteoTwin[m.ID]
	if !ok {
		return fmt.Errorf("Open-Meteo serves no twin of %s", m.ID)
	}
	run, err := openMeteoRun(twin[1])
	if err != nil {
		return err
	}
	path, err := firstArchive(*dir, m.ID, run)
	if err != nil {
		return fmt.Errorf("Open-Meteo serves %s %s: %w", m.Name, run.Format("2006-01-02T15Z"), err)
	}
	a, err := nwp.OpenArchive(path)
	if err != nil {
		return fmt.Errorf("Open-Meteo serves %s %s: %w", m.Name, run.Format("2006-01-02T15Z"), err)
	}
	defer a.Close()
	var levels []int
	for _, s := range strings.Split(*levelsFlag, ",") {
		var lv int
		fmt.Sscan(s, &lv)
		levels = append(levels, lv)
	}

	// Sample covered grid nodes, deterministically.
	g := a.D.Grid
	rng := rand.New(rand.NewPCG(*seed, 7))
	type node struct{ i, j int }
	var nodes []node
	for tries := 0; len(nodes) < *n && tries < 100000; tries++ {
		i, j := rng.IntN(g.Ni), rng.IntN(g.Nj)
		lat := float64(g.North-int64(j)*g.Dj) / 1e6
		if math.Abs(lat) > 70 {
			continue
		}
		v, _, ok, err := a.Series(i, j, "elevation")
		if err != nil {
			return err
		}
		if ok && !math.IsNaN(v[0]) {
			nodes = append(nodes, node{i, j})
		}
	}
	lonOf := func(i int) float64 {
		lon := g.West + int64(i)*g.Di
		if lon >= 180e6 {
			lon -= 360e6
		}
		return float64(lon) / 1e6
	}
	latOf := func(j int) float64 { return float64(g.North-int64(j)*g.Dj) / 1e6 }

	var hourly []string
	for _, lv := range levels {
		hourly = append(hourly, fmt.Sprintf("wind_speed_%dhPa", lv), fmt.Sprintf("wind_direction_%dhPa", lv),
			fmt.Sprintf("geopotential_height_%dhPa", lv), fmt.Sprintf("temperature_%dhPa", lv), fmt.Sprintf("cloud_cover_%dhPa", lv))
	}
	hourly = append(hourly, "wind_speed_10m", "wind_direction_10m", "temperature_2m", "pressure_msl", "surface_pressure")
	var lats, lons []string
	for _, nd := range nodes {
		lats = append(lats, fmt.Sprintf("%.4f", latOf(nd.j)))
		lons = append(lons, fmt.Sprintf("%.4f", lonOf(nd.i)))
	}
	end := run.Add(time.Duration(a.D.Last) * time.Hour)
	q := url.Values{
		"latitude": {strings.Join(lats, ",")}, "longitude": {strings.Join(lons, ",")},
		"hourly": {strings.Join(hourly, ",")}, "models": {twin[0]},
		"wind_speed_unit": {"kn"}, "timeformat": {"unixtime"},
		// Open-Meteo otherwise moves a land point to the neighbouring
		// cell whose elevation best matches its own terrain model.
		"cell_selection": {"nearest"},
		"start_hour":     {run.Format("2006-01-02T15:04")}, "end_hour": {end.Format("2006-01-02T15:04")},
	}
	resp, err := http.Get("https://api.open-meteo.com/v1/forecast?" + q.Encode())
	if err != nil {
		return err
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("Open-Meteo: HTTP %d %s", resp.StatusCode, body)
	}
	var locs []struct {
		Elevation float64                    `json:"elevation"`
		Hourly    map[string]json.RawMessage `json:"hourly"`
	}
	if err := json.Unmarshal(body, &locs); err != nil {
		return err
	}
	if len(locs) != len(nodes) {
		return fmt.Errorf("Open-Meteo answered %d locations for %d", len(locs), len(nodes))
	}

	diffs := map[string][]float64{}
	add := func(k string, d float64) { diffs[k] = append(diffs[k], math.Abs(d)) }
	for li, nd := range nodes {
		loc := locs[li]
		var times []int64
		json.Unmarshal(loc.Hourly["time"], &times)
		series := func(name string) []*float64 {
			var v []*float64
			json.Unmarshal(loc.Hourly[name], &v)
			return v
		}
		ours := func(key string) ([]float64, []int) {
			v, steps, ok, err := a.Series(nd.i, nd.j, key)
			if err != nil || !ok {
				return nil, nil
			}
			return v, steps
		}
		elev, _ := ours("elevation")
		if len(elev) > 0 {
			add("elevation (report)", elev[0]-loc.Elevation)
		}
		compareAt := func(name string, omName string, ourKey string, conv func(float64) float64) {
			om := series(omName)
			vals, steps := ours(ourKey)
			for si, h := range steps {
				t := run.Add(time.Duration(h) * time.Hour).Unix()
				k := sort.Search(len(times), func(x int) bool { return times[x] >= t })
				if k >= len(times) || times[k] != t || k >= len(om) || om[k] == nil || math.IsNaN(vals[si]) {
					continue
				}
				d := vals[si] - *om[k]
				if conv != nil {
					d = conv(d)
				}
				add(name, d)
			}
		}
		for _, lv := range levels {
			uv, steps := ours(fmt.Sprintf("wind_u@%d", lv))
			vv, _ := ours(fmt.Sprintf("wind_v@%d", lv))
			spd := series(fmt.Sprintf("wind_speed_%dhPa", lv))
			dir := series(fmt.Sprintf("wind_direction_%dhPa", lv))
			for si, h := range steps {
				t := run.Add(time.Duration(h) * time.Hour).Unix()
				k := sort.Search(len(times), func(x int) bool { return times[x] >= t })
				if k >= len(times) || times[k] != t || spd[k] == nil || dir[k] == nil {
					continue
				}
				s := math.Hypot(uv[si], vv[si])
				add("wind speed (kt)", s-*spd[k])
				if *spd[k] >= 10 {
					d := math.Mod(math.Atan2(-uv[si], -vv[si])*180/math.Pi+360, 360) - *dir[k]
					d = math.Mod(d+540, 360) - 180
					add("wind direction (deg, >= 10 kt)", d)
				}
			}
			compareAt("height (m)", fmt.Sprintf("geopotential_height_%dhPa", lv), fmt.Sprintf("geopotential_height@%d", lv), nil)
			compareAt("temperature (C)", fmt.Sprintf("temperature_%dhPa", lv), fmt.Sprintf("temperature@%d", lv), nil)
			compareAt("cloud cover (%, report)", fmt.Sprintf("cloud_cover_%dhPa", lv), fmt.Sprintf("cloud_cover@%d", lv), nil)
			if lv == 850 {
				compareAt("z850 (m)", "geopotential_height_850hPa", "geopotential_height@850", nil)
			}
		}
		compareAt("2 m temperature (C, report)", "temperature_2m", "temperature_2m", nil)
		compareAt("MSLP (hPa)", "pressure_msl", "pressure_msl", nil)
		compareAt("surface pressure (hPa, report)", "surface_pressure", "surface_pressure", nil)
	}
	fmt.Printf("%s run %s: %d nodes, Open-Meteo %s\n", m.Name, run.Format("2006-01-02T15Z"), len(nodes), twin[0])
	pct := func(v []float64, p float64) float64 {
		s := append([]float64(nil), v...)
		sort.Float64s(s)
		if len(s) == 0 {
			return math.NaN()
		}
		return s[min(len(s)-1, int(math.Ceil(p*float64(len(s))))-1)]
	}
	keys := make([]string, 0, len(diffs))
	for k := range diffs {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		v := diffs[k]
		fmt.Printf("  %-34s n=%5d  p50 %8.3f  p95 %8.3f  p99 %8.3f  max %8.3f\n", k, len(v), pct(v, 0.5), pct(v, 0.95), pct(v, 0.99), pct(v, 1))
	}
	var fails []string
	check := func(k string, limit float64) {
		if p := pct(diffs[k], 0.99); p > limit {
			fails = append(fails, fmt.Sprintf("%s p99 %.3f > %g", k, p, limit))
		}
	}
	check("wind speed (kt)", 0.8)
	check("wind direction (deg, >= 10 kt)", 3)
	check("height (m)", 3)
	check("temperature (C)", 0.2)
	if z := pct(diffs["z850 (m)"], 1); z > 50 {
		fails = append(fails, fmt.Sprintf("|dz850| reaches %.0f m", z))
	}
	if len(fails) > 0 {
		fmt.Println("FAIL:", strings.Join(fails, "; "))
		os.Exit(1)
	}
	fmt.Println("PASS")
	return nil
}

// firstArchive finds a run's first block in a store directory: named by
// its content since VersionedKey (<run>.<sha12>.pmtiles), by the run alone
// before; the newest when a rebuild left two.
func firstArchive(dir, id string, run time.Time) (string, error) {
	base := filepath.Join(dir, "first", id)
	entries, err := os.ReadDir(base)
	if err != nil {
		return "", err
	}
	name := regexp.MustCompile(`^` + regexp.QuoteMeta(nwp.RunKey(run)) + `(\.[0-9a-f]{12})?\.pmtiles$`)
	var best string
	var newest time.Time
	for _, e := range entries {
		if e.IsDir() || !name.MatchString(e.Name()) {
			continue
		}
		info, err := e.Info()
		if err != nil {
			return "", err
		}
		if best == "" || info.ModTime().After(newest) {
			best, newest = e.Name(), info.ModTime()
		}
	}
	if best == "" {
		return "", fmt.Errorf("no first block of %s in %s", nwp.RunKey(run), base)
	}
	return filepath.Join(base, best), nil
}

func openMeteoRun(dir string) (time.Time, error) {
	resp, err := http.Get("https://api.open-meteo.com/data/" + dir + "/static/meta.json")
	if err != nil {
		return time.Time{}, err
	}
	defer resp.Body.Close()
	var meta struct {
		Init int64 `json:"last_run_initialisation_time"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&meta); err != nil {
		return time.Time{}, err
	}
	return time.Unix(meta.Init, 0).UTC(), nil
}
