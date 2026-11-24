// ign.go reads France's communes from IGN's ADMIN EXPRESS COG, through
// the Géoplateforme's WFS: every current commune of the metropole,
// Corsica and the five overseas départements, under its official name,
// with its population and its chef-lieu, the point IGN places the town
// at.

package main

import (
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"strconv"

	"github.com/0intro/loxodrome/internal/gis"
)

// ignWFS is the Géoplateforme's WFS, a variable so that a test can serve
// the pages.
var ignWFS = "https://data.geopf.fr/wfs/ows"

const (
	// ignPageSize is the most features the WFS returns in one answer.
	ignPageSize = 5000

	// ignMaxPages bounds a layer's paging: the 34,877 communes of 2026
	// are seven pages.
	ignMaxPages = 50
)

// An ignLayer is one WFS layer the build reads.
type ignLayer struct {
	file   string // its pages' names under -keep: ign-<file>-001.json, ...
	name   string // the WFS type name
	props  string // the properties asked for: the geometry only where it is read
	sortBy string // the key the pages are ordered by, so that they tile the layer
}

var (
	ignChefLieux    = ignLayer{"chef_lieu", "ADMINEXPRESS-COG.LATEST:chef_lieu_de_commune", "code_insee_de_la_commune,geometrie", "code_insee_de_la_commune"}
	ignCommunes     = ignLayer{"commune", "ADMINEXPRESS-COG.LATEST:commune", "code_insee,nom_officiel,population,code_insee_du_departement", "code_insee"}
	ignDepartements = ignLayer{"departement", "ADMINEXPRESS-COG.LATEST:departement", "code_insee,nom_officiel", "code_insee"}
)

// pageName is the name page i (from 0) of the layer is kept under.
func (l ignLayer) pageName(i int) string {
	return fmt.Sprintf("ign-%s-%03d.json", l.file, i+1)
}

// pageURL asks the WFS for the layer's page starting at feature start.
// Without an order the server pages in no stable one, and two pages
// could repeat a feature and miss another.
func (l ignLayer) pageURL(start int) string {
	q := url.Values{}
	q.Set("SERVICE", "WFS")
	q.Set("VERSION", "2.0.0")
	q.Set("REQUEST", "GetFeature")
	q.Set("TYPENAMES", l.name)
	q.Set("outputFormat", "application/json")
	q.Set("propertyName", l.props)
	q.Set("sortBy", l.sortBy+" ASC")
	q.Set("count", strconv.Itoa(ignPageSize))
	q.Set("startIndex", strconv.Itoa(start))
	return ignWFS + "?" + q.Encode()
}

// A wfsPage is what paging reads of an answer: how many features the
// query matched, and how many this page returned.
type wfsPage struct {
	NumberMatched  int `json:"numberMatched"`
	NumberReturned int `json:"numberReturned"`
}

// A wfsFeature is one feature of an answer. The geometry is decoded only
// where it is read.
type wfsFeature[P any] struct {
	Geometry   json.RawMessage `json:"geometry"`
	Properties P               `json:"properties"`
}

// readLayer decodes a layer's pages into its features, refusing pages
// that do not tile the layer: each must count the same total, and
// together they must hold that many features.
func readLayer[P any](pages []named) ([]wfsFeature[P], error) {
	var out []wfsFeature[P]
	matched := -1
	for _, pg := range pages {
		var p struct {
			NumberMatched int             `json:"numberMatched"`
			Features      []wfsFeature[P] `json:"features"`
		}
		if err := json.Unmarshal(pg.data, &p); err != nil {
			return nil, fmt.Errorf("ign %s: %w", pg.name, err)
		}
		if matched >= 0 && p.NumberMatched != matched {
			return nil, fmt.Errorf("ign %s: %d features matched, %d on the first page: the layer changed while it was read", pg.name, p.NumberMatched, matched)
		}
		matched = p.NumberMatched
		out = append(out, p.Features...)
	}
	if len(pages) == 0 || len(out) != matched {
		return nil, fmt.Errorf("ign: %d features read in %d pages, %d matched", len(out), len(pages), matched)
	}
	return out, nil
}

// The properties each layer is read for.
type (
	chefLieuProps struct {
		Commune string `json:"code_insee_de_la_commune"`
	}
	communeProps struct {
		Code       string `json:"code_insee"`
		Name       string `json:"nom_officiel"`
		Population *int   `json:"population"`
		Dept       string `json:"code_insee_du_departement"`
	}
	departementProps struct {
		Code string `json:"code_insee"`
		Name string `json:"nom_officiel"`
	}
)

// ignDrops counts the communes not written, by reason.
type ignDrops struct {
	Collectivity int `json:"collectivity"` // in an overseas collectivity (collectivities)
	NoPosition   int `json:"noPosition"`   // no chef-lieu
}

// buildIGN sorts the communes into the table's IGN files, keyed by ISO
// code. Every commune of a held département is kept, the thousands
// sharing a name with another included: they are different places,
// which the département tells apart. A commune is placed at its
// chef-lieu and never elsewhere: one without (the six villages destroyed
// at Verdun in 1916, which have no inhabitant) is dropped. A commune in a
// département that is neither held nor a collectivity's fails the build,
// and so does one placed outside its file's envelope.
func buildIGN(chefLieux, communes, departements []named, table []country) (map[string][]place, ignDrops, error) {
	var drops ignDrops
	heads, err := readLayer[chefLieuProps](chefLieux)
	if err != nil {
		return nil, drops, err
	}
	points := map[string][2]float64{}
	for _, f := range heads {
		code := f.Properties.Commune
		if code == "" {
			return nil, drops, fmt.Errorf("ign: a chef-lieu without a commune")
		}
		if _, dup := points[code]; dup {
			return nil, drops, fmt.Errorf("ign: two chefs-lieux for commune %s", code)
		}
		// GeoJSON's [lon, lat], the order the WFS writes whatever CRS
		// it names; the envelopes below catch a server that changed it.
		if lat, lon, ok := gis.Point(f.Geometry); ok && validPosition(lat, lon) {
			points[code] = [2]float64{lat, lon}
		}
	}

	rows, err := readLayer[departementProps](departements)
	if err != nil {
		return nil, drops, err
	}
	deptNames := map[string]string{}
	for _, f := range rows {
		if f.Properties.Code == "" || f.Properties.Name == "" {
			return nil, drops, fmt.Errorf("ign: a département without a code or a name: %+v", f.Properties)
		}
		deptNames[f.Properties.Code] = f.Properties.Name
	}

	byDept := map[string]country{}
	out := map[string][]place{}
	for _, t := range table {
		if t.source != srcIGN {
			continue
		}
		out[t.iso] = nil
		for _, d := range t.depts {
			byDept[d] = t
		}
	}
	communeRows, err := readLayer[communeProps](communes)
	if err != nil {
		return nil, drops, err
	}
	seen := map[string]bool{}
	for _, f := range communeRows {
		c := f.Properties
		if c.Code == "" || c.Name == "" {
			return nil, drops, fmt.Errorf("ign: a commune without a code or a name: %+v", c)
		}
		if seen[c.Code] {
			return nil, drops, fmt.Errorf("ign: commune %s listed twice", c.Code)
		}
		seen[c.Code] = true
		t, ok := byDept[c.Dept]
		if !ok {
			if isCollectivity(c) {
				drops.Collectivity++
				continue
			}
			return nil, drops, fmt.Errorf("ign commune %s %q: département %q is in no country of the table", c.Code, c.Name, c.Dept)
		}
		deptName, ok := deptNames[c.Dept]
		if !ok {
			return nil, drops, fmt.Errorf("ign commune %s %q: département %q has no name", c.Code, c.Name, c.Dept)
		}
		pt, ok := points[c.Code]
		if !ok {
			drops.NoPosition++
			continue
		}
		if !t.inEnvelope(pt[0], pt[1]) {
			return nil, drops, fmt.Errorf("ign commune %s %q: chef-lieu %v, %v outside %s's envelope %v", c.Code, c.Name, pt[0], pt[1], t.iso, t.envelope)
		}
		p := place{
			code:      c.Code,
			name:      c.Name,
			lat:       pt[0],
			lon:       pt[1],
			admin:     c.Dept,
			adminName: deptName,
		}
		if c.Population != nil {
			p.pop, p.hasPop = *c.Population, true
		}
		out[t.iso] = append(out[t.iso], p)
	}
	return out, drops, nil
}

// isCollectivity reports whether the commune is an overseas
// collectivity's: by its département code, or by its INSEE code's first
// three digits, ADMIN EXPRESS filing Saint-Pierre-et-Miquelon's two
// communes under the département "NR".
func isCollectivity(c communeProps) bool {
	return collectivities[c.Dept] || (len(c.Code) >= 3 && collectivities[c.Code[:3]])
}

// validPosition reports whether lat, lon is a finite position on the
// globe other than the (0, 0) a failed parse lands on.
func validPosition(lat, lon float64) bool {
	if math.IsNaN(lat) || math.IsNaN(lon) || math.IsInf(lat, 0) || math.IsInf(lon, 0) {
		return false
	}
	if lat < -90 || lat > 90 || lon < -180 || lon > 180 {
		return false
	}
	return lat != 0 || lon != 0
}
