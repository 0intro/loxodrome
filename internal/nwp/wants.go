package nwp

import (
	"fmt"

	"github.com/0intro/loxodrome/internal/grib2"
)

// want is one source field the cube needs, named by its full GRIB2
// identity: two feeds order their messages differently and every package
// carries fields we skip, so position means nothing.
type want struct {
	pkg     string // Météo-France package (IP1, IP2, IP3, SP1, SP2)
	ifs     string // ECMWF open-data param name in the .index
	levtype string // ECMWF "pl" or "sfc"
	cat     uint8
	num     uint8
	pdt     uint16
	stat    uint8 // statistical process, template 4.8 only
	surface uint8
	level   float64 // the surface's value: Pa on isobaric levels, m above ground on 103
	varKey  string
	level0  int // hPa of the variable, for derived conversions
	conv    func(float64) float64
	family  Family
	static  bool // read at step 0 only, into the static segment
	gust    bool // a period maximum: no step 0, its period recorded
}

type wantKey struct {
	// disc is the GRIB2 discipline: every field read is meteorological
	// (0), and a land-surface field (2) shares its category and number
	// table positions with them.
	disc     uint8
	cat, num uint8
	pdt      uint16
	stat     uint8
	surface  uint8
	level    float64
}

func (w want) key() wantKey {
	return wantKey{0, w.cat, w.num, w.pdt, w.stat, w.surface, w.level}
}

func fieldKey(f *grib2.Field) wantKey {
	k := wantKey{disc: f.Discipline, cat: f.Category, num: f.Number, pdt: f.PDT, surface: f.Surface1.Type, level: f.Surface1.Value}
	if f.PDT == 8 {
		k.stat = f.StatProcess
	}
	if f.Surface1.Missing {
		k.level = 0
	}
	return k
}

var (
	msToKt  = func(x float64) float64 { return x * ktPerMS }
	kToC    = func(x float64) float64 { return x - 273.15 }
	paToHpa = func(x float64) float64 { return x / 100 }
	geopToM = func(x float64) float64 { return x / standardGravity }
	fracPct = func(x float64) float64 { return x * 100 }
)

// wants lists a model's needed fields.
func wants(m *Model) []want {
	var out []want
	for _, lv := range m.Levels {
		pa := float64(lv) * 100
		iso := func(pkg, ifs string, cat, num uint8, name string, conv func(float64) float64) want {
			return want{pkg: pkg, ifs: ifs, levtype: "pl", cat: cat, num: num, surface: 100, level: pa,
				varKey: Var{Name: name, Level: lv}.Key(), level0: lv, conv: conv, family: FamilyLevels}
		}
		out = append(out,
			iso("IP1", "u", 2, 2, VarU, msToKt),
			iso("IP1", "v", 2, 3, VarV, msToKt),
			iso("IP1", "t", 0, 0, VarT, kToC))
		switch m.Source {
		case MeteoFrance:
			out = append(out,
				iso("IP1", "", 3, 4, VarZ, geopToM),
				iso(m.cloudPkg, "", 6, 32, VarCloud, fracPct))
		case ECMWF:
			level := float64(lv)
			out = append(out,
				iso("", "gh", 3, 5, VarZ, nil),
				iso("", "r", 1, 1, VarCloud, func(x float64) float64 { return Sundqvist(x, level) }))
		}
	}
	sfc := func(pkg, ifs string, cat, num uint8, surface uint8, level float64, name string, conv func(float64) float64, fam Family) want {
		return want{pkg: pkg, ifs: ifs, levtype: "sfc", cat: cat, num: num, surface: surface, level: level,
			varKey: name, conv: conv, family: fam}
	}
	out = append(out,
		sfc("SP1", "10u", 2, 2, 103, 10, VarU10, msToKt, FamilyHourlySurface),
		sfc("SP1", "10v", 2, 3, 103, 10, VarV10, msToKt, FamilyHourlySurface),
		sfc("SP1", "2t", 0, 0, 103, 2, VarT2, kToC, FamilyHourlySurface))
	gust := sfc("SP1", "10fg", 2, 22, 103, 10, VarGust, msToKt, FamilyHourlySurface)
	gust.pdt, gust.stat, gust.gust = 8, 2, true
	out = append(out, gust)
	switch m.Source {
	case MeteoFrance:
		out = append(out,
			sfc("SP1", "", 3, 1, 101, 0, VarMSLP, paToHpa, FamilyHourlySurface),
			sfc("SP2", "", 3, 0, 1, 0, VarPS, paToHpa, FamilySurface))
		if !m.GroundFromColumn {
			oro := sfc("SP2", "", 3, 6, 1, 0, VarElevation, nil, FamilySurface)
			oro.static = true
			out = append(out, oro)
		}
	case ECMWF:
		out = append(out,
			sfc("", "msl", 3, 0, 101, 0, VarMSLP, paToHpa, FamilyHourlySurface),
			sfc("", "sp", 3, 0, 1, 0, VarPS, paToHpa, FamilySurface))
		oro := sfc("", "z", 3, 4, 1, 0, VarElevation, geopToM, FamilySurface)
		oro.static = true
		out = append(out, oro)
	}
	return out
}

// wantIndex maps GRIB2 identities to wants.
type wantIndex map[wantKey]want

// mayHold reports whether a message of this identity could be a wanted
// field: the parameter is one read, whatever its level or template.
func (idx wantIndex) mayHold(id grib2.Identity) bool {
	for k := range idx {
		if k.disc == id.Discipline && k.cat == id.Category && k.num == id.Number {
			return true
		}
	}
	return false
}

func indexWants(ws []want) wantIndex {
	idx := wantIndex{}
	for _, w := range ws {
		if _, dup := idx[w.key()]; dup {
			panic(fmt.Sprintf("nwp: two wants share %+v", w.key()))
		}
		idx[w.key()] = w
	}
	return idx
}

// expected lists the (variable, hour) pairs a block must hold, the
// orography aside (it may come from an earlier block).
func expected(m *Model, b Block, ws []want) map[string][]int {
	out := map[string][]int{}
	for _, w := range ws {
		if w.static {
			continue
		}
		for _, h := range m.Steps(b, w.family) {
			if w.gust && h == 0 {
				continue
			}
			out[w.varKey] = append(out[w.varKey], h)
		}
	}
	return out
}
