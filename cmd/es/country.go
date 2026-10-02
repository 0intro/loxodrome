// country.go holds what stays genuinely per-publisher once the airport
// and obstacle builders are shared: the ICAO-to-ISO map, the sanity
// windows and the height floor sized for this AIP's own products.

package main

import "github.com/0intro/loxodrome/internal/aixm5build"

const (
	// ENAIRE files obstacles per aerodrome, separately from the airspace
	// document, so the floor stays 0 and a run given only the airspace
	// slice does not trip the check.
	defaultMaxEsObstacles = 30000
	defaultMaxEsAirports  = 5000

	// esMinObstacleHeightM is the AGL height floor for emitted obstacles.
	// ENAIRE's raw feed has no lower bound and ~88 % of its 180 k rows
	// are below 30 m, small urban features that are not aeronautically
	// significant. 30 m matches three converging references:
	//
	//   - ICAO Annex 15 Appendix 8 area-charting minimums: Area 2 (the
	//     transition surface inside an aerodrome terminal area) reports
	//     obstacles >= 30 m AGL. Area 1 uses 100 m and Areas 3/4 use 0;
	//     30 m is where ICAO first recognises an obstacle as a hazard
	//     outside the immediate aerodrome.
	//   - The empirical floor of France's SIA dataset: 99.1 % of the
	//     13 766 published <Obs> records are >= 30 m AGL (123 below).
	//   - The obstacle layer's MIN_ZOOM (9), at which a 30 m structure is
	//     just barely worth drawing as a pixel.
	//
	// The floor slims the Spain feed from ~180 k rows / 20 MB to ~21 k /
	// 2.5 MB without losing anything SIA itself would have published.
	esMinObstacleHeightM = 30.0
)

// esCountryFromIcao maps the Spain / Canaries / North African enclave
// ICAO prefixes to ISO-3166.
var esCountryFromIcao = aixm5build.IcaoCountry(map[string]string{
	"LE": "ES", // mainland + Balearics
	"GC": "ES", // Canary Islands
	"GE": "ES", // Ceuta / Melilla
}, "ES")
