// country.go holds what stays genuinely per-publisher once the airport
// and obstacle builders are shared: the ICAO-to-ISO map and the sanity
// windows sized for this AIP's own products.

package main

import "github.com/0intro/loxodrome/internal/aixm5build"

const (
	// The obstacle data comes from the separate ED_Obstacles_Area_1_*
	// download, so the floor stays 0 and a run given only the AIP files
	// does not trip the check; the workflow passes -min-obstacles when it
	// expects the obstacle file. The ceiling is generous: DFS Obstacles
	// Area 1 is an eTOD national product, larger than the UK Area 1
	// aerodrome set.
	//
	// No height floor is applied, unlike cmd/es: the DFS Area 1 dataset
	// already ships against an eTOD collection threshold, so every
	// published row is aeronautically significant.
	defaultMaxDeObstacles = 300000
	defaultMaxDeAirports  = 5000
)

// deCountryFromIcao maps the German ICAO prefix scheme to ISO-3166. ED is
// the civil family and ET the military family; both are Germany, and the
// DFS AIP dataset publishes only German aerodromes, so everything falls
// back to DE.
var deCountryFromIcao = aixm5build.IcaoCountry(map[string]string{
	"ED": "DE",
	"ET": "DE",
}, "DE")
