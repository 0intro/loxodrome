// Package geodesy: spherical-Earth geometry primitives shared between the
// AIXM 4.5 boundary decoder (cmd/fr) and the AIXM 5.1 GML decoder
// (internal/aixm5). Pure math; no AIXM coupling, no I/O.
package geodesy

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

const (
	EarthRadiusM = 6371000.0
	ArcStepDeg   = 5.0 // tessellation step for arcs
	CircleSteps  = 64  // points used to approximate a full circle
	// GreatCircleStepM is the densification step for declared
	// great-circle boundary segments (AIXM 4.5 codeType GRC, AIXM 5.1
	// GeodesicString). 25 km leaves a <= ~15 m bow between a chord and
	// the true geodesic at European latitudes, invisible at every map
	// zoom, while the undensified 450 km Channel-approaches segment
	// bowed 4.3 km. INVARIANT: both AIXM pipelines (cmd/fr and
	// internal/aixm5) densify through DensifyGreatCircle with THIS
	// step, so two states publishing the same boundary corners emit
	// identical polylines and their FIR limits coincide on the map.
	GreatCircleStepM = 25000.0
)

func radians(d float64) float64 { return d * math.Pi / 180 }
func degrees(r float64) float64 { return r * 180 / math.Pi }

// InitialBearing returns the initial bearing in degrees [0,360) from A to B.
func InitialBearing(latA, lonA, latB, lonB float64) float64 {
	lat1, lat2 := radians(latA), radians(latB)
	dLon := radians(lonB - lonA)
	y := math.Sin(dLon) * math.Cos(lat2)
	x := math.Cos(lat1)*math.Sin(lat2) - math.Sin(lat1)*math.Cos(lat2)*math.Cos(dLon)
	return math.Mod(degrees(math.Atan2(y, x))+360, 360)
}

// DestPoint returns the point at distanceM and bearingDeg from (lat, lon) on
// a sphere.
func DestPoint(lat, lon, bearingDeg, distanceM float64) (float64, float64) {
	d := distanceM / EarthRadiusM
	brng := radians(bearingDeg)
	lat1, lon1 := radians(lat), radians(lon)
	sinLat2 := math.Sin(lat1)*math.Cos(d) + math.Cos(lat1)*math.Sin(d)*math.Cos(brng)
	lat2 := math.Asin(sinLat2)
	y := math.Sin(brng) * math.Sin(d) * math.Cos(lat1)
	x := math.Cos(d) - math.Sin(lat1)*sinLat2
	lon2 := lon1 + math.Atan2(y, x)
	return degrees(lat2), degrees(lon2)
}

// DistanceM returns the great-circle (haversine) distance in metres.
func DistanceM(latA, lonA, latB, lonB float64) float64 {
	dLat := radians(latB - latA)
	dLon := radians(lonB - lonA)
	a := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(radians(latA))*math.Cos(radians(latB))*math.Sin(dLon/2)*math.Sin(dLon/2)
	return 2 * EarthRadiusM * math.Asin(math.Sqrt(a))
}

// DensifyGreatCircle returns the INTERMEDIATE points (endpoints
// excluded) every GreatCircleStepM along the great circle from a to b,
// [lat, lon] pairs. Following the initial bearing from a IS the great
// circle through a and b, so DestPoint along it stays on the declared
// boundary. Returns nil when the pair is within one step. See the
// GreatCircleStepM invariant: this is THE densifier both AIXM
// pipelines share.
func DensifyGreatCircle(a, b [2]float64) [][2]float64 {
	dist := DistanceM(a[0], a[1], b[0], b[1])
	if dist <= GreatCircleStepM {
		return nil
	}
	bearing := InitialBearing(a[0], a[1], b[0], b[1])
	steps := int(math.Ceil(dist / GreatCircleStepM))
	pts := make([][2]float64, 0, steps-1)
	for i := 1; i < steps; i++ {
		lat, lon := DestPoint(a[0], a[1], bearing, dist*float64(i)/float64(steps))
		pts = append(pts, [2]float64{lat, lon})
	}
	return pts
}

// ArcPoints tessellates a circular arc from start to end around centre at
// radiusM, returning the intermediate points only (endpoints excluded).
// clockwise selects a CWA arc; otherwise CCA.
func ArcPoints(startLat, startLon, endLat, endLon, cenLat, cenLon, radiusM float64, clockwise bool) [][2]float64 {
	b0 := InitialBearing(cenLat, cenLon, startLat, startLon)
	b1 := InitialBearing(cenLat, cenLon, endLat, endLon)
	var sweep float64
	if clockwise {
		sweep = math.Mod(b1-b0+360, 360)
	} else {
		sweep = math.Mod(b0-b1+360, 360)
	}
	if sweep < 1e-6 {
		sweep = 360 // start == end: render a full circle
	}
	steps := int(math.Ceil(sweep / ArcStepDeg))
	pts := make([][2]float64, 0, steps)
	for i := 1; i < steps; i++ {
		frac := float64(i) / float64(steps)
		var b float64
		if clockwise {
			b = b0 + frac*sweep
		} else {
			b = b0 - frac*sweep
		}
		lat, lon := DestPoint(cenLat, cenLon, b, radiusM)
		pts = append(pts, [2]float64{lat, lon})
	}
	return pts
}

// CircleRing returns a closed ring approximating a circle.
func CircleRing(cenLat, cenLon, radiusM float64) [][2]float64 {
	pts := make([][2]float64, 0, CircleSteps)
	for i := 0; i < CircleSteps; i++ {
		b := float64(i) * 360 / CircleSteps
		lat, lon := DestPoint(cenLat, cenLon, b, radiusM)
		pts = append(pts, [2]float64{lat, lon})
	}
	return pts
}

// ToMeters converts a length value to metres. Recognised units: NM / KM / M.
func ToMeters(val float64, uom string) (float64, bool) {
	switch strings.ToUpper(strings.TrimSpace(uom)) {
	case "NM":
		return val * 1852, true
	case "KM":
		return val * 1000, true
	case "M":
		return val, true
	default:
		return 0, false
	}
}

// RadiusMeters parses a radius value+unit string into metres.
func RadiusMeters(val, uom string) (float64, error) {
	v, err := strconv.ParseFloat(strings.TrimSpace(val), 64)
	if err != nil {
		return 0, fmt.Errorf("bad radius %q", val)
	}
	m, ok := ToMeters(v, uom)
	if !ok {
		return 0, fmt.Errorf("unknown radius unit %q", uom)
	}
	return m, nil
}
