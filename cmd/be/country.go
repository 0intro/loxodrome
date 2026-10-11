// country.go holds what stays genuinely per-publisher once the airport
// and obstacle builders are shared: the ICAO-to-ISO map, the sanity
// windows, and the conversion of the scraped chart references into the
// shared builder's optional trailing column.

package main

import "github.com/0intro/loxodrome/internal/aixm5build"

const (
	defaultMinBeObstacles = 80
	defaultMaxBeObstacles = 5000
	defaultMinBeAirports  = 20
	defaultMaxBeAirports  = 500
)

// beCountryFromIcao maps the joint Belgium / Luxembourg AIP's ICAO
// prefixes to ISO-3166. skeyes publishes both States in one eAIP.
var beCountryFromIcao = aixm5build.IcaoCountry(map[string]string{
	"EB": "BE",
	"EL": "LU",
}, "BE")

// beChartFields is the shape of one entry in the trailing chart column.
var beChartFields = []string{"code", "title", "url"}

// beChartColumn converts the scraped AD 2.24 / AD 3.23 chart references
// into the shape aixm5build.BuildAirports appends as its optional
// trailing column.
func beChartColumn(charts map[string][]chartRef) map[string][]any {
	out := make(map[string][]any, len(charts))
	for icao, refs := range charts {
		rows := make([]any, 0, len(refs))
		for _, c := range refs {
			rows = append(rows, []string{c.Code, c.Title, c.URL})
		}
		out[icao] = rows
	}
	return out
}
