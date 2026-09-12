// country.go holds what stays genuinely per-publisher once the airport
// and obstacle builders are shared: the ICAO-to-ISO map and the sanity
// windows sized for this AIP's own products.

package main

import "github.com/0intro/loxodrome/internal/aixm5build"

const (
	// NATS publishes the Obstacle Dataset Area 1 as a separate download
	// from the AIP dataset, so the floor stays 0 and a run given only
	// the AIP does not trip the check. The workflow passes
	// -min-obstacles explicitly when it expects the obstacle file.
	defaultMaxUkObstacles = 30000
	defaultMaxUkAirports  = 5000
)

// ukCountryFromIcao maps the UK / Crown Dependencies / Overseas
// Territories ICAO prefix scheme to ISO-3166. EI is Ireland, which the
// UK AIP carries as cross-border reference.
var ukCountryFromIcao = aixm5build.IcaoCountry(map[string]string{
	"EG": "GB",
	"EI": "IE",
}, "GB")
