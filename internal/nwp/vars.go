package nwp

import (
	"fmt"
	"math"
)

// Segment is one of a tile's independently compressed parts: a request
// inflates only the ones it reads (winds: sfc, uvt, z; clouds: z, cloud;
// the map lattice: sfc, uvt, z; an aerodrome: sfc, ps).
type Segment int

// Every variable of a segment is present at every step the segment
// holds, so a reader interpolates over one step list per segment: the
// surface pressure, which ARPEGE publishes every 3 hours past +48 h while
// its other surface fields stay hourly, has a segment of its own on the
// levels' steps.
const (
	SegStatic Segment = iota // the model's orography
	SegSfc                   // hourly surface fields
	SegPS                    // the surface pressure, on the levels' steps
	SegUVT                   // winds and temperatures on the levels
	SegZ                     // geopotential heights on the levels
	SegCloud                 // cloud cover on the levels
	NumSegments
)

var segmentNames = [NumSegments]string{"static", "sfc", "ps", "uvt", "z", "cloud"}

func (s Segment) String() string { return segmentNames[s] }

// Missing marks a point or step with no value.
const Missing = math.MinInt16

// Var is one stored variable: a physical value is q*Scale + Offset.
type Var struct {
	Name   string  `json:"name"`
	Level  int     `json:"level,omitempty"` // hPa; 0 off the levels
	Scale  float64 `json:"scale"`
	Offset float64 `json:"offset,omitempty"`
}

// Quantize turns a physical value into the stored integer, refusing one the
// int16 cannot hold (a unit gone wrong, never clamped).
func (v Var) Quantize(x float64) (int16, error) {
	q := math.Round((x - v.Offset) / v.Scale)
	if !(q > math.MinInt16 && q <= math.MaxInt16) {
		return 0, fmt.Errorf("nwp: %s %g out of range", v.Key(), x)
	}
	return int16(q), nil
}

// Value turns a stored integer back into the physical value.
func (v Var) Value(q int16) float64 { return float64(q)*v.Scale + v.Offset }

// Key names a variable uniquely: "wind_u@850".
func (v Var) Key() string {
	if v.Level != 0 {
		return fmt.Sprintf("%s@%d", v.Name, v.Level)
	}
	return v.Name
}

// Variable names, before the served ones are derived from them (a level's
// wind_u and wind_v become wind_speed_850hPa and wind_direction_850hPa).
const (
	VarElevation    = "elevation"
	VarMSLP         = "pressure_msl"
	VarPS           = "surface_pressure"
	VarU10          = "wind_u_10m"
	VarV10          = "wind_v_10m"
	VarT2           = "temperature_2m"
	VarGust         = "wind_gusts_10m"
	VarU            = "wind_u"
	VarV            = "wind_v"
	VarT            = "temperature"
	VarZ            = "geopotential_height"
	VarCloud        = "cloud_cover"
	ktPerMS         = 3600.0 / 1852.0
	standardGravity = 9.80665
)

// Layout is the variables of each segment, in their stored order.
type Layout [NumSegments][]Var

// LayoutFor returns a model's tile layout.
func LayoutFor(m *Model) Layout {
	var l Layout
	l[SegStatic] = []Var{{Name: VarElevation, Scale: 1}}
	l[SegSfc] = []Var{
		{Name: VarMSLP, Scale: 0.1, Offset: 1000},
		{Name: VarU10, Scale: 0.5},
		{Name: VarV10, Scale: 0.5},
		{Name: VarT2, Scale: 0.1},
		{Name: VarGust, Scale: 0.5},
	}
	l[SegPS] = []Var{{Name: VarPS, Scale: 0.1, Offset: 1000}}
	for _, lv := range m.Levels {
		l[SegUVT] = append(l[SegUVT],
			Var{Name: VarU, Level: lv, Scale: 0.5},
			Var{Name: VarV, Level: lv, Scale: 0.5},
			Var{Name: VarT, Level: lv, Scale: 0.1})
		l[SegZ] = append(l[SegZ], Var{Name: VarZ, Level: lv, Scale: 1})
		l[SegCloud] = append(l[SegCloud], Var{Name: VarCloud, Level: lv, Scale: 1})
	}
	return l
}

// Find locates a variable by key.
func (l Layout) Find(key string) (Segment, int, bool) {
	for s := range l {
		for i, v := range l[s] {
			if v.Key() == key {
				return Segment(s), i, true
			}
		}
	}
	return 0, 0, false
}

// Sundqvist derives a cloud fraction (percent) from relative humidity
// (percent) on a pressure level the way Open-Meteo does for the models that
// publish no cloud field (Sundqvist et al. 1989, Meteorology.swift's
// relativeHumidityToCloudCover): 1 - sqrt((1 - RH) / (1 - RHc)) above a
// critical humidity falling from 0.9 near the ground to 0.7 aloft,
// 0.7 + 0.2*exp(1 - (1013.25/p)^4).
func Sundqvist(rhPct, levelHpa float64) float64 {
	rhc := 0.7 + (0.9-0.7)*math.Exp(1-math.Pow(1013.25/levelHpa, 4))
	return math.Max(1-math.Sqrt(math.Max(1-rhPct/100, 0)/(1-rhc)), 0) * 100
}
