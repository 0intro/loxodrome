// build.go is the pure core: the downloads in, the country files and
// their index out. Nothing here touches the network or the disk, so the
// whole pipeline runs from fixtures.

package main

import (
	"cmp"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"maps"
	"math"
	"slices"
	"strings"
	"time"
	"unicode"

	"github.com/0intro/loxodrome/internal/aip"
)

// The names the GeoNames inputs carry in a -keep or -in directory; IGN's
// pages are named by their layer (ignLayer.pageName).
const (
	citiesName    = "cities500.zip"
	admin1Name    = "admin1CodesASCII.txt"
	alternatesDir = "alternatenames"
)

// alternatesName is the name of a country's alternate names.
func alternatesName(cc string) string {
	return alternatesDir + "/" + cc + ".zip"
}

// Inputs are the downloads one build reads.
type Inputs struct {
	ChefLieux    []named           // ign-chef_lieu-*.json, in order
	Communes     []named           // ign-commune-*.json
	Departements []named           // ign-departement-*.json
	Cities       []byte            // cities500.zip
	Admin1       []byte            // admin1CodesASCII.txt
	Alternates   map[string][]byte // alternatenames/<CC>.zip, by country code
}

// Options tune a build: the table, the GeoNames sanity window and the
// clock the index is stamped with.
type Options struct {
	Countries   []country
	GeoNamesMin int // the fewest GeoNames rows, all countries together
	GeoNamesMax int // the most
	Now         func() time.Time
}

// The production GeoNames window: some 70,000 rows on 2026-10-18.
const (
	defaultGeoNamesMin = 30000
	defaultGeoNamesMax = 200000
)

// fields is the row layout every country file shares.
var fields = []string{"id", "name", "lat", "lon", "pop", "admin", "alt"}

// File is one places-<iso>.json: the rows, positional under fields, and
// the names of the divisions their admin cells key.
type File struct {
	Fields []string          `json:"fields"`
	Admins map[string]string `json:"admins"`
	Rows   []any             `json:"rows"`
}

// Index is places.meta.json, the one sidecar of every country file.
type Index struct {
	GeneratedAt string                  `json:"generatedAt"`
	PlaceCount  int                     `json:"placeCount"`
	Sources     Sources                 `json:"sources"`
	Countries   map[string]CountryEntry `json:"countries"`
	Dropped     Dropped                 `json:"dropped"`
}

// Sources credits the two sources.
type Sources struct {
	IGN      Source `json:"ign"`
	GeoNames Source `json:"geonames"`
}

// Source is one source as the About credits it. SHA256 covers its
// inputs (digest); Date is the newest modification GeoNames lists. The
// WFS dates none of the layers the IGN source reads.
type Source struct {
	Name       string `json:"name"`
	URL        string `json:"url"`
	Licence    string `json:"licence"`
	LicenceURL string `json:"licenceUrl"`
	SHA256     string `json:"sha256"`
	Date       string `json:"date,omitempty"`
}

// CountryEntry is one country file as the index lists it. BBox is the
// rows' envelope; BBoxes splits it into the pieces the rows occupy, for
// a country whose territory is not connected, and is absent when the
// rows form one group.
type CountryEntry struct {
	Source string     `json:"source"`
	Rows   int        `json:"rows"`
	MinPop int        `json:"minPop"`
	BBox   aip.BBox   `json:"bbox,omitempty"`
	BBoxes []aip.BBox `json:"bboxes,omitempty"`
}

// Dropped counts, per source, the places not written and why.
type Dropped struct {
	IGN      ignDrops      `json:"ign"`
	GeoNames geoNamesDrops `json:"geonames"`
}

// Result is what a build returns: the files by ISO code, and the index.
type Result struct {
	Files map[string]File
	Index Index
}

// A place is one row of a country file before it is encoded.
type place struct {
	code      string // the source's id: the INSEE code, or the geonameid
	num       int    // the geonameid, which orders a GeoNames file
	name      string
	lat, lon  float64
	pop       int
	hasPop    bool
	admin     string // the key into the file's admins, "" for none
	adminName string
	alt       string
}

// build turns the downloads into the country files and their index, or
// fails, in which case nothing may be written.
func build(in Inputs, opts Options) (Result, error) {
	table := opts.Countries
	if err := checkTable(table); err != nil {
		return Result{}, err
	}
	now := opts.Now
	if now == nil {
		now = time.Now
	}

	french, ignDropped, err := buildIGN(in.ChefLieux, in.Communes, in.Departements, table)
	if err != nil {
		return Result{}, err
	}

	cities, err := parseCities(in.Cities)
	if err != nil {
		return Result{}, err
	}
	admins, err := parseAdmin1(in.Admin1)
	if err != nil {
		return Result{}, err
	}
	gazetteer, geoNamesDropped, err := buildGeoNames(cities, admins, in.Alternates, table)
	if err != nil {
		return Result{}, err
	}

	res := Result{
		Files: map[string]File{},
		Index: Index{
			GeneratedAt: now().UTC().Format("2006-01-02T15:04:05.000Z"),
			Countries:   map[string]CountryEntry{},
			Dropped:     Dropped{IGN: ignDropped, GeoNames: geoNamesDropped},
		},
	}
	geoNamesRows := 0
	for _, t := range table {
		var ps []place
		if t.source == srcIGN {
			ps = french[t.iso]
			slices.SortFunc(ps, func(a, b place) int { return strings.Compare(a.code, b.code) })
		} else {
			ps = gazetteer[t.iso]
			slices.SortFunc(ps, func(a, b place) int { return cmp.Compare(a.num, b.num) })
			geoNamesRows += len(ps)
		}
		if len(ps) < t.minRows || (t.maxRows > 0 && len(ps) > t.maxRows) {
			return Result{}, fmt.Errorf("%s: %d places outside the sanity window [%d, %s]; refusing to write", t.iso, len(ps), t.minRows, maxLabel(t.maxRows))
		}
		f := encode(t.iso, ps)
		res.Files[t.iso] = f
		res.Index.Countries[t.iso] = CountryEntry{
			Source: t.source,
			Rows:   len(ps),
			MinPop: t.minPop,
			BBox:   aip.BBoxOfRows(f.Fields, f.Rows),
			BBoxes: aip.BBoxClustersOfRows(f.Fields, f.Rows),
		}
		res.Index.PlaceCount += len(ps)
	}
	if geoNamesRows < opts.GeoNamesMin || (opts.GeoNamesMax > 0 && geoNamesRows > opts.GeoNamesMax) {
		return Result{}, fmt.Errorf("geonames: %d places outside the sanity window [%d, %s]; refusing to write", geoNamesRows, opts.GeoNamesMin, maxLabel(opts.GeoNamesMax))
	}

	var alternates []named
	for _, cc := range sortedKeys(in.Alternates) {
		alternates = append(alternates, named{alternatesName(cc), in.Alternates[cc]})
	}
	res.Index.Sources = Sources{
		IGN: Source{
			Name:       "IGN ADMIN EXPRESS COG",
			URL:        ignWFS,
			Licence:    "Licence Ouverte 2.0",
			LicenceURL: "https://www.data.gouv.fr/pages/legal/licences/etalab-2.0",
			SHA256:     digest(slices.Concat(in.ChefLieux, in.Communes, in.Departements)),
		},
		GeoNames: Source{
			Name:       "GeoNames",
			URL:        "https://www.geonames.org/",
			Licence:    "CC BY 4.0",
			LicenceURL: "https://creativecommons.org/licenses/by/4.0/",
			SHA256:     digest(append([]named{{citiesName, in.Cities}, {admin1Name, in.Admin1}}, alternates...)),
			Date:       newestModification(cities),
		},
	}
	return res, nil
}

// encode lays one country's places out as its file.
func encode(iso string, ps []place) File {
	f := File{Fields: fields, Admins: map[string]string{}, Rows: make([]any, 0, len(ps))}
	for _, p := range ps {
		var pop, admin any
		if p.hasPop {
			pop = p.pop
		}
		if p.admin != "" {
			admin = p.admin
			f.Admins[p.admin] = p.adminName
		}
		f.Rows = append(f.Rows, []any{iso + ":" + p.code, p.name, round3(p.lat), round3(p.lon), pop, admin, p.alt})
	}
	return f
}

// checkTable refuses a table a build cannot be read by: an ISO code
// twice, a département in two files, a GeoNames country twice or one IGN
// already lists.
func checkTable(table []country) error {
	isos := map[string]bool{}
	depts := map[string]string{}
	ccs := map[string]bool{}
	for _, t := range table {
		if t.iso == "" || t.iso != strings.ToLower(t.iso) || isos[t.iso] {
			return fmt.Errorf("country table: ISO code %q empty, not lower case or twice", t.iso)
		}
		isos[t.iso] = true
		switch t.source {
		case srcIGN:
			if len(t.depts) == 0 {
				return fmt.Errorf("country table: %s holds no département", t.iso)
			}
			for _, d := range t.depts {
				if prev, ok := depts[d]; ok {
					return fmt.Errorf("country table: département %s in both %s and %s", d, prev, t.iso)
				}
				depts[d] = t.iso
			}
		case srcGeoNames:
			if t.cc == "" || ccs[t.cc] || geoNamesFromIGN[t.cc] {
				return fmt.Errorf("country table: %s: GeoNames code %q empty, twice or read from IGN", t.iso, t.cc)
			}
			ccs[t.cc] = true
		default:
			return fmt.Errorf("country table: %s: unknown source %q", t.iso, t.source)
		}
	}
	return nil
}

// A named input is one download under its -keep name.
type named struct {
	name string
	data []byte
}

// digest is the SHA-256 of the sha256sum listing of the inputs, in
// order, so that running sha256sum over the same files in a -keep
// directory and hashing its output gives the same value (IGN's pages are
// in the order their names sort in).
func digest(files []named) string {
	var b strings.Builder
	for _, f := range files {
		fmt.Fprintf(&b, "%x  %s\n", sha256.Sum256(f.data), f.name)
	}
	sum := sha256.Sum256([]byte(b.String()))
	return hex.EncodeToString(sum[:])
}

// newestModification is the latest date a cities500 row was modified,
// which dates the dump without trusting the archive's clock.
func newestModification(cities []city) string {
	newest := ""
	for _, c := range cities {
		newest = max(newest, c.modified)
	}
	return newest
}

// round3 rounds a coordinate to 3 decimals, about 100 m, and never to
// the negative zero a place just west of Greenwich would print as -0.
func round3(x float64) float64 {
	r := math.Round(x*1000) / 1000
	if r == 0 {
		return 0
	}
	return r
}

// maxLabel prints a window's ceiling, 0 being none.
func maxLabel(n int) string {
	if n <= 0 {
		return "none"
	}
	return fmt.Sprint(n)
}

func isLetterOrDigit(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsDigit(r)
}

// sortedKeys returns a map's keys in order.
func sortedKeys[V any](m map[string]V) []string {
	return slices.Sorted(maps.Keys(m))
}
