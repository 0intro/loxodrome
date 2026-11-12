// Package nwp turns the open forecast feeds Loxodrome serves (Météo-France
// AROME 0.025, AROME-OM 0.025 over five overseas territories and ARPEGE
// 0.1, ECMWF IFS 0.25) into the chunked archives the loxodrome-nwp Worker
// reads: what each model publishes and where, which fields are wanted (by
// their full GRIB2 key, never by position: AROME orders its files
// parameter > step > level, ARPEGE parameter > level > step), the
// conversions and the integer quantisation, the plausibility gates a
// block must pass, the pyramid aligned to the map lattice, the tile
// payload and the PMTiles archive (docs/nwp-service.md).
package nwp

import (
	"fmt"
	"time"
)

// Grid is a regular latitude/longitude grid in microdegrees, rows from the
// north: point (i, j) lies at North - j*Dj, West + i*Di. Integers, so that
// the lattice alignment of section "Pyramid" is exact.
type Grid struct {
	Ni, Nj int
	North  int64 // microdegrees
	West   int64 // microdegrees, in [-180e6, 180e6)
	Di, Dj int64 // microdegrees
	Wraps  bool  // the columns go round the globe
}

// Lat and Lon give a point's coordinates in degrees.
func (g Grid) Lat(j int) float64 { return float64(g.North-int64(j)*g.Dj) / 1e6 }
func (g Grid) Lon(i int) float64 {
	lon := g.West + int64(i)*g.Di
	if lon >= 180e6 {
		lon -= 360e6
	}
	return float64(lon) / 1e6
}

// South and East edges in microdegrees (East may pass 180e6 on a grid
// crossing the antimeridian).
func (g Grid) South() int64 { return g.North - int64(g.Nj-1)*g.Dj }
func (g Grid) East() int64  { return g.West + int64(g.Ni-1)*g.Di }

// Source names who publishes a model.
type Source int

const (
	MeteoFrance Source = iota
	ECMWF
)

// Block is a time block: the forecast hours one archive holds, decoded
// whole in memory and built as soon as its source files are out.
type Block struct {
	First, Last int // hours after the run, inclusive
	// Label is the source's own name for the hour group (Météo-France's
	// "00H06H"), empty for ECMWF and for a model publishing a file per
	// hour (mfLabels).
	Label string
}

// Name is the block's archive name.
func (b Block) Name() string { return fmt.Sprintf("b%03d-%03d", b.First, b.Last) }

// Model is one ingested model.
type Model struct {
	ID       string // archive and meta directory name
	Name     string // "AROME 0.025"
	Producer string
	Source   Source
	Grid     Grid
	// Levels are the served isobaric levels, hPa, from the ground up.
	Levels []int
	// CycleHours is the spacing of the runs.
	CycleHours int
	// Pyramid are the coarse levels' factors over the native grid, each a
	// lattice step the map asks (section 3 of the plan): AROME 0.025 x5
	// is 1/8 degree.
	Pyramid []int
	// NativeCloud says the model publishes a cloud fraction per level;
	// otherwise it is derived from the relative humidity (Sundqvist).
	NativeCloud bool
	// LevelsHourlyTo is the last hour the levels (and the surface
	// pressure) come hourly; past it they come every 3 hours while the
	// other surface fields stay hourly (ARPEGE past +48 h).
	LevelsHourlyTo int
	// GroundFromColumn takes the model's ground from where its surface
	// pressure stands in its own isobaric column (GroundInColumn), each
	// block from its first step, rather than from the published height
	// field. ARPEGE's 0.1° "geometric height" is not the ground of its own
	// surface pressure: 250 to 600 m above it in the Alps and Corsica
	// (2026-10-07, Megève's grid point 2 347 m stated, 1 739 m in its
	// column, where its sea-level pressure puts it at 1 742 m), the QNH
	// reduced from it reading 1050 to 1100 hPa. AROME's and IFS's agree
	// with their columns within 20 m and keep their own.
	GroundFromColumn bool

	// Météo-France store coordinates: the directory under a run
	// ("arome/0025"), the file stem ("arome__0025"), and whether a file
	// holds one forecast hour rather than a block's hour group.
	mfDir, mfStem string
	mfHourly      bool
	cloudPkg      string
	horizon       func(run time.Time) int
	blocks        func(run time.Time) []Block
}

// Horizon is the last forecast hour a run reaches.
func (m *Model) Horizon(run time.Time) int { return m.horizon(run) }

// Blocks lists a run's time blocks in order.
func (m *Model) Blocks(run time.Time) []Block { return m.blocks(run) }

// mfLevels is the served ladder on Météo-France's files: their 24 levels
// from 100 hPa down, cut at 300 (the curtain's and the flight levels' top).
var mfLevels = []int{1000, 950, 925, 900, 850, 800, 750, 700, 650, 600, 550, 500, 450, 400, 350, 300}

// ifsLevels is the open data's ladder below 250 hPa.
var ifsLevels = []int{1000, 925, 850, 700, 600, 500, 400, 300}

func mfGroups(edges [][2]int, width int) []Block {
	out := make([]Block, len(edges))
	for i, e := range edges {
		out[i] = Block{First: e[0], Last: e[1], Label: fmt.Sprintf("%0*dH%0*dH", width, e[0], width, e[1])}
	}
	return out
}

// Arome is AROME 0.025: France and its neighbours, eight runs a day to
// +51 h hourly.
var Arome = &Model{
	ID: "arome0025", Name: "AROME 0.025", Producer: "Météo-France", Source: MeteoFrance,
	Grid:           Grid{Ni: 1121, Nj: 717, North: 55_400_000, West: -12_000_000, Di: 25_000, Dj: 25_000},
	Levels:         mfLevels,
	CycleHours:     3,
	Pyramid:        []int{5, 10, 20, 40, 80},
	NativeCloud:    true,
	LevelsHourlyTo: 51,
	mfDir:          "arome/0025", mfStem: "arome__0025", cloudPkg: "IP2",
	horizon: func(time.Time) int { return 51 },
	blocks: func(time.Time) []Block {
		return mfGroups([][2]int{{0, 6}, {7, 12}, {13, 18}, {19, 24}, {25, 30}, {31, 36}, {37, 42}, {43, 48}, {49, 51}}, 2)
	},
}

// Arpege is ARPEGE 0.1 over Europe: four runs a day to +102 h, levels
// hourly to +48 h then 3-hourly, the surface hourly throughout.
var Arpege = &Model{
	ID: "arpege01", Name: "ARPEGE 0.1", Producer: "Météo-France", Source: MeteoFrance,
	Grid:             Grid{Ni: 741, Nj: 521, North: 72_000_000, West: -32_000_000, Di: 100_000, Dj: 100_000},
	Levels:           mfLevels,
	CycleHours:       6,
	Pyramid:          []int{5, 10, 20, 40},
	NativeCloud:      true,
	LevelsHourlyTo:   48,
	GroundFromColumn: true,
	mfDir:            "arpege/01", mfStem: "arpege__01", cloudPkg: "IP3",
	horizon: func(time.Time) int { return 102 },
	blocks: func(time.Time) []Block {
		return mfGroups([][2]int{{0, 12}, {13, 24}, {25, 36}, {37, 48}, {49, 60}, {61, 72}, {73, 84}, {85, 96}, {97, 102}}, 3)
	},
}

// Ifs is ECMWF's IFS 0.25 open data: four runs a day, 00 and 12 UTC to
// +360 h (3-hourly to 144, then 6-hourly), 06 and 18 UTC to +144 h.
var Ifs = &Model{
	ID: "ifs025", Name: "IFS 0.25", Producer: "ECMWF", Source: ECMWF,
	Grid:       Grid{Ni: 1440, Nj: 721, North: 90_000_000, West: -180_000_000, Di: 250_000, Dj: 250_000, Wraps: true},
	Levels:     ifsLevels,
	CycleHours: 6,
	Pyramid:    []int{2, 4, 8, 16},
	horizon: func(run time.Time) int {
		if run.Hour()%12 == 0 {
			return 360
		}
		return 144
	},
	blocks: func(run time.Time) []Block {
		edges := [][2]int{{0, 12}, {15, 24}, {27, 36}, {39, 48}, {51, 60}, {63, 72}, {75, 84}, {87, 96}, {99, 108}, {111, 120}, {123, 132}, {135, 144}}
		if run.Hour()%12 == 0 {
			edges = append(edges, [][2]int{{150, 168}, {174, 192}, {198, 216}, {222, 240}, {246, 264}, {270, 288}, {294, 312}, {318, 336}, {342, 360}}...)
		}
		out := make([]Block, len(edges))
		for i, e := range edges {
			out[i] = Block{First: e[0], Last: e[1]}
		}
		return out
	},
}

// omLevels is AROME-OM's served ladder: its files carry 19 levels to
// 100 hPa, without 750, 650, 550 or 450, cut at 300 like the others (the
// heights above it pass the plausibility bound in the tropics).
var omLevels = []int{1000, 950, 925, 900, 850, 800, 700, 600, 500, 400, 350, 300}

// omEdges are AROME-OM's blocks: six hours each, the first holding the
// analysis hour, to +48 h.
var omEdges = [][2]int{{0, 6}, {7, 12}, {13, 18}, {19, 24}, {25, 30}, {31, 36}, {37, 42}, {43, 48}}

func hourBlocks(edges [][2]int) []Block {
	out := make([]Block, len(edges))
	for i, e := range edges {
		out[i] = Block{First: e[0], Last: e[1]}
	}
	return out
}

// aromeOM is one AROME-OM domain, Météo-France's AROME over a French
// overseas territory: 0.025°, four runs a day to +48 h, a file per
// forecast hour under arome-om/<domain>/0025. It publishes no orography,
// so its ground is its own column's, as ARPEGE's is.
func aromeOM(id, dom string, g Grid, factors []int) *Model {
	return &Model{
		ID: id, Name: "AROME-OM " + dom, Producer: "Météo-France", Source: MeteoFrance,
		Grid:             g,
		Levels:           omLevels,
		CycleHours:       6,
		Pyramid:          factors,
		NativeCloud:      true,
		LevelsHourlyTo:   48,
		GroundFromColumn: true,
		mfDir:            "arome-om/" + dom + "/0025", mfStem: "arome-om-" + dom + "__0025", mfHourly: true, cloudPkg: "IP2",
		horizon: func(time.Time) int { return 48 },
		blocks:  func(time.Time) []Block { return hourBlocks(omEdges) },
	}
}

// The five AROME-OM domains. A small grid has no zoom left for a 2°
// level, so only the Antilles and the Indian Ocean carry one.
var (
	AromeOMAntil  = aromeOM("aromeomantil", "ANTIL", Grid{Ni: 945, Nj: 529, North: 22_900_000, West: -75_300_000, Di: 25_000, Dj: 25_000}, []int{5, 10, 20, 40, 80})
	AromeOMGuyane = aromeOM("aromeomguyane", "GUYANE", Grid{Ni: 419, Nj: 317, North: 8_950_000, West: -56_750_000, Di: 25_000, Dj: 25_000}, []int{5, 10, 20, 40})
	AromeOMIndien = aromeOM("aromeomindien", "INDIEN", Grid{Ni: 1395, Nj: 899, North: -3_450_000, West: 32_750_000, Di: 25_000, Dj: 25_000}, []int{5, 10, 20, 40, 80})
	AromeOMNcaled = aromeOM("aromeomncaled", "NCALED", Grid{Ni: 521, Nj: 491, North: -13_750_000, West: 158_500_000, Di: 25_000, Dj: 25_000}, []int{5, 10, 20, 40})
	AromeOMPolyn  = aromeOM("aromeompolyn", "POLYN", Grid{Ni: 521, Nj: 507, North: -12_600_000, West: -157_500_000, Di: 25_000, Dj: 25_000}, []int{5, 10, 20, 40})
)

// Models lists the ingested models, in the order Auto's chain tries them.
var Models = []*Model{Arome, AromeOMAntil, AromeOMGuyane, AromeOMIndien, AromeOMNcaled, AromeOMPolyn, Arpege, Ifs}

// ModelByID finds a model.
func ModelByID(id string) (*Model, error) {
	for _, m := range Models {
		if m.ID == id {
			return m, nil
		}
	}
	return nil, fmt.Errorf("nwp: unknown model %q", id)
}

// RunTime parses a run as 2006-01-02T15 (or RFC 3339) and checks it falls
// on the model's cycle.
func (m *Model) RunTime(s string) (time.Time, error) {
	var t time.Time
	var err error
	for _, layout := range []string{"2006-01-02T15", time.RFC3339, "2006010215"} {
		if t, err = time.Parse(layout, s); err == nil {
			break
		}
	}
	if err != nil {
		return time.Time{}, fmt.Errorf("nwp: run %q: want 2006-01-02T15", s)
	}
	t = t.UTC()
	if t.Minute() != 0 || t.Second() != 0 || t.Hour()%m.CycleHours != 0 {
		return time.Time{}, fmt.Errorf("nwp: %s is not a %s run", t.Format(time.RFC3339), m.Name)
	}
	return t, nil
}

// RunKey is a run's name in archive keys: YYYYMMDDHH.
func RunKey(run time.Time) string { return run.UTC().Format("2006010215") }

// Steps lists the hours a block holds for one source package or variable
// family; ARPEGE's levels and its surface pressure go 3-hourly past +48 h
// while its other surface fields stay hourly.
func (m *Model) Steps(b Block, family Family) []int {
	var out []int
	switch m.Source {
	case ECMWF:
		for h := b.First; h <= b.Last; h++ {
			if (h <= 144 && h%3 == 0) || (h > 144 && h%6 == 0) {
				out = append(out, h)
			}
		}
		return out
	}
	for h := b.First; h <= b.Last; h++ {
		if h > m.LevelsHourlyTo && h%3 != 0 && family != FamilyHourlySurface {
			continue
		}
		out = append(out, h)
	}
	return out
}

// Family groups fields by the step set they share.
type Family int

const (
	FamilyLevels        Family = iota // isobaric fields
	FamilyHourlySurface               // SP1: MSLP, 10 m wind, 2 m T, gusts
	FamilySurface                     // SP2: surface pressure
)
