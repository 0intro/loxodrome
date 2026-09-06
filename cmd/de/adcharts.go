// adcharts.go emits de-adcharts.json: per German aerodrome, a stable
// permalink into the DFS VFR eAIP. Unlike fr / at, there is no per-chart
// list to build: DFS renders each chart as an inline base64 image on the
// aerodrome page, so the aerodrome page is the finest link granularity.
//
// The DFS VFR AIP is a hash-addressed static site whose per-cycle chapter
// URLs rotate (aip.dfs.de/BasicVFR/<edition>/chapter/<hash>.html) and
// whose old editions are withdrawn, so those cannot be stored. But the
// site ships a permalinks index in js/config.js, and
// aip.dfs.de/BasicVFR/pages/<permalink>.html is a stable redirect stub
// DFS repoints to the current edition each cycle. That permalink is what
// this dataset stores; it never rots, so the file carries no AIRAC slot.

package main

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"sort"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
)

const (
	// dfsPermalinkURL is the js bundle that ships the aerodrome ->
	// permalink index; it is served off the un-dated BasicVFR root.
	dfsPermalinkURL = "https://aip.dfs.de/BasicVFR/js/config.js"
	// dfsPageBase resolves one permalink to its stable redirect stub.
	dfsPageBase = "https://aip.dfs.de/BasicVFR/pages/"

	defaultMinDeAdAerodromes = 300

	// dfsUserAgent identifies the tool; the DFS static site serves the
	// bundle without a WAF, so no browser headers are needed.
	dfsUserAgent = "loxodrome-de-adcharts/1.0 (+https://loxodrome.fr)"
)

// AdChartsArtifact is the de-adcharts.json document. Base pins the stub
// directory the app joins each permalink onto.
type AdChartsArtifact struct {
	Fields []string `json:"fields"`
	Base   string   `json:"base"`
	Rows   []any    `json:"rows"`
}

// AdChartsMeta is the de-adcharts.meta.json sidecar. generatedAt lives
// here alone, so an unchanged index yields a byte-identical artifact and
// the workflow's no-op gate holds.
type AdChartsMeta struct {
	GeneratedAt string `json:"generatedAt"`
	Source      string `json:"source"`
	Base        string `json:"base"`
	Aerodromes  int    `json:"aerodromes"`
	// Skipped counts the permalink entries with no ICAO in their label
	// (hospital helipads and the like, which the VFR AIP lists but the
	// airport dataset does not carry).
	Skipped int `json:"skipped"`
}

// AdChartsOptions configures BuildAdCharts.
type AdChartsOptions struct {
	Now           func() time.Time
	MinAerodromes int
}

// permalinkRe matches one entry of the config.js permalinks array,
// {label:"Aachen-Merzbrueck EDKA",value:"C0194C"}.
var permalinkRe = regexp.MustCompile(`\{label:"([^"]*)",value:"([^"]*)"\}`)

// labelIcaoRe pulls the ICAO out of a permalink label. German aerodromes
// carry an ED / ET indicator as the last token ("Aachen-Merzbrueck EDKA",
// "Laage ETNL"); hospital helipads carry none.
var labelIcaoRe = regexp.MustCompile(`\b(E[DT][A-Z]{2})\b`)

// BuildAdCharts parses the DFS permalinks index into one row per
// ICAO-identified aerodrome, sorted by ICAO. The first permalink wins on
// a duplicate ICAO (the index is publication order).
func BuildAdCharts(configJS []byte, source string, opts AdChartsOptions) (AdChartsArtifact, AdChartsMeta, error) {
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	minN := opts.MinAerodromes
	if minN == 0 {
		minN = defaultMinDeAdAerodromes
	}

	byICAO := map[string]string{}
	var icaos []string
	skipped := 0
	for _, m := range permalinkRe.FindAllStringSubmatch(string(configJS), -1) {
		label, value := m[1], m[2]
		icao := labelIcaoRe.FindString(label)
		if icao == "" {
			skipped++
			continue
		}
		if _, dup := byICAO[icao]; dup {
			continue
		}
		byICAO[icao] = value
		icaos = append(icaos, icao)
	}
	sort.Strings(icaos)

	if len(icaos) < minN {
		return AdChartsArtifact{}, AdChartsMeta{}, fmt.Errorf(
			"DE eAIP aerodrome count %d below floor %d - source format may have changed",
			len(icaos), minN)
	}

	art := AdChartsArtifact{Fields: []string{"icao", "permalink"}, Base: dfsPageBase}
	for _, icao := range icaos {
		art.Rows = append(art.Rows, []any{icao, byICAO[icao]})
	}
	meta := AdChartsMeta{
		GeneratedAt: now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Source:      source,
		Base:        dfsPageBase,
		Aerodromes:  len(icaos),
		Skipped:     skipped,
	}
	return art, meta, nil
}

// buildAdCharts fetches (or reads offline) the permalinks index and
// writes de-adcharts.json. The index is cycle-independent, so it always
// occupies the current slot.
func buildAdCharts(chartsIn, outDir string, opts AdChartsOptions) error {
	var configJS []byte
	var source string
	if chartsIn != "" {
		b, err := os.ReadFile(chartsIn)
		if err != nil {
			return err
		}
		configJS, source = b, chartsIn
	} else {
		b, err := fetchDfsConfig()
		if err != nil {
			return err
		}
		configJS, source = b, dfsPermalinkURL
	}

	artifact, meta, err := BuildAdCharts(configJS, source, opts)
	if err != nil {
		return err
	}
	if _, err := aip.WriteDataset(outDir, "de-adcharts", "current", "", artifact, meta); err != nil {
		return err
	}
	fmt.Printf("wrote %d aerodrome links from %s (%d entries without an ICAO skipped)\n",
		meta.Aerodromes, source, meta.Skipped)
	return nil
}

func fetchDfsConfig() ([]byte, error) {
	req, err := http.NewRequest(http.MethodGet, dfsPermalinkURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", dfsUserAgent)
	client := &http.Client{Timeout: 60 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET %s: HTTP %d", dfsPermalinkURL, res.StatusCode)
	}
	return io.ReadAll(io.LimitReader(res.Body, aip.MaxMemberSize))
}
