package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"io"
	"math"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
)

// The sanity window on the zones an edition holds: 234 on 1 November
// 2026, the start of the bearded vulture's season.
const (
	minZones = 20
	maxZones = 5000
)

// outputFields is the row layout of fr-zsm.json, read positionally by
// src/lib/data/zsm.ts. The ring is [lat, lon] pairs, rounded to 1e-5
// degree. topM is the zone's highest point and overflyM the height to
// overfly it at (the STAC's h_survol_m, topM plus 1000 m for powered
// flights and gliders), both in metres above mean sea level. modified is
// the record's date_modif as YYYY-MM-DD.
var outputFields = []string{"id", "name", "species", "taxon", "active", "topM", "overflyM", "modified", "ring"}

// A source is one KML file and where it was read.
type source struct {
	url  string
	body []byte
}

// Meta is fr-zsm.meta.json.
type Meta struct {
	GeneratedAt  string `json:"generatedAt"`
	Source       string `json:"source"`
	SourceSha256 string `json:"sourceSha256"`
	// Edition is the date the STAC's page gives the KML ("édité le 1er
	// novembre 2026"), else the newest date_modif, as YYYY-MM-DD.
	Edition     string         `json:"edition"`
	ZoneCount   int            `json:"zoneCount"`
	ActiveCount int            `json:"activeCount"`
	Species     map[string]int `json:"species"`
	BBox        aip.BBox       `json:"bbox,omitempty"`
}

type artifact struct {
	Fields []string `json:"fields"`
	Rows   [][]any  `json:"rows"`
}

// build reads the KML files into the dataset and its sidecar.
func build(src []source, edition string, now func() time.Time) (artifact, Meta, error) {
	var rows [][]any
	species := make(map[string]int)
	active := 0
	newest := ""
	box := aip.NewBBox()
	hash := sha256.New()
	urls := make([]string, 0, len(src))
	for _, s := range src {
		hash.Write(s.body)
		urls = append(urls, s.url)
		zones, err := parseKML(s.body)
		if err != nil {
			return artifact{}, Meta{}, fmt.Errorf("%s: %w", s.url, err)
		}
		for _, z := range zones {
			box.AddRing(z.ring)
			species[z.species]++
			if z.active {
				active++
			}
			newest = max(newest, z.modified)
			rows = append(rows, z.row())
		}
	}
	if n := len(rows); n < minZones || n > maxZones {
		return artifact{}, Meta{}, fmt.Errorf("%d zones outside the sanity window [%d, %d]: the source format may have changed", n, minZones, maxZones)
	}
	slices.SortFunc(rows, func(a, b []any) int { return strings.Compare(a[0].(string), b[0].(string)) })
	if edition == "" {
		edition = newest
	}
	meta := Meta{
		GeneratedAt:  now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Source:       strings.Join(urls, " + "),
		SourceSha256: hex.EncodeToString(hash.Sum(nil)),
		Edition:      edition,
		ZoneCount:    len(rows),
		ActiveCount:  active,
		Species:      species,
		BBox:         box.Result(),
	}
	return artifact{Fields: outputFields, Rows: rows}, meta, nil
}

// A zone is one placemark of the KML.
type zone struct {
	id, name, species, taxon, modified string
	active                             bool
	topM, overflyM                     int
	ring                               [][2]float64
}

func (z zone) row() []any {
	ring := make([][2]float64, len(z.ring))
	for i, p := range z.ring {
		ring[i] = [2]float64{round5(p[0]), round5(p[1])}
	}
	return []any{z.id, z.name, z.species, z.taxon, z.active, z.topM, z.overflyM, z.modified, ring}
}

func round5(v float64) float64 { return math.Round(v*1e5) / 1e5 }

type placemark struct {
	Data   []simpleData `xml:"ExtendedData>SchemaData>SimpleData"`
	Outer  []string     `xml:"Polygon>outerBoundaryIs>LinearRing>coordinates"`
	Inner  []string     `xml:"Polygon>innerBoundaryIs>LinearRing>coordinates"`
	Multi  []struct{}   `xml:"MultiGeometry"`
	Points []struct{}   `xml:"Point"`
}

type simpleData struct {
	Name  string `xml:"name,attr"`
	Value string `xml:",chardata"`
}

// parseKML reads every placemark of a KML document, at any depth. A
// placemark whose geometry is anything but one polygon without a hole is
// refused: the app draws one ring per zone.
func parseKML(body []byte) ([]zone, error) {
	dec := xml.NewDecoder(bytes.NewReader(body))
	var out []zone
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		se, ok := tok.(xml.StartElement)
		if !ok || se.Name.Local != "Placemark" {
			continue
		}
		var p placemark
		if err := dec.DecodeElement(&p, &se); err != nil {
			return nil, err
		}
		z, err := p.zone()
		if err != nil {
			return nil, err
		}
		out = append(out, z)
	}
	return out, nil
}

func (p placemark) zone() (zone, error) {
	d := make(map[string]string, len(p.Data))
	for _, s := range p.Data {
		d[s.Name] = strings.TrimSpace(s.Value)
	}
	z := zone{
		id:       "zsm:" + d["id_zsm_tampon"],
		name:     d["nom_aire"],
		species:  d["espece"],
		taxon:    d["cd_nom"],
		active:   d["actif"] == "1",
		modified: isoDate(d["date_modif"]),
	}
	if d["id_zsm_tampon"] == "" {
		return zone{}, fmt.Errorf("placemark %q: no id_zsm_tampon", d["code_zsm"])
	}
	if z.name == "" {
		z.name = nameFromCode(d["code_zsm"])
	}
	if len(p.Outer) != 1 || len(p.Inner) > 0 || len(p.Multi) > 0 || len(p.Points) > 0 {
		return zone{}, fmt.Errorf("zone %s: geometry other than one polygon without a hole", z.id)
	}
	ring, err := coordinates(p.Outer[0])
	if err != nil {
		return zone{}, fmt.Errorf("zone %s: %w", z.id, err)
	}
	z.ring = ring
	if z.topM, err = metres(d["h_max"]); err != nil {
		return zone{}, fmt.Errorf("zone %s: h_max: %w", z.id, err)
	}
	if z.overflyM, err = metres(d["h_survol_m"]); err != nil {
		return zone{}, fmt.Errorf("zone %s: h_survol_m: %w", z.id, err)
	}
	return z, nil
}

// coordinates reads a KML coordinates list, "lon,lat[,alt]" tuples
// separated by blanks, into [lat, lon] pairs.
func coordinates(s string) ([][2]float64, error) {
	var ring [][2]float64
	for _, t := range strings.Fields(s) {
		f := strings.Split(t, ",")
		if len(f) < 2 {
			return nil, fmt.Errorf("coordinate %q", t)
		}
		lon, err1 := strconv.ParseFloat(f[0], 64)
		lat, err2 := strconv.ParseFloat(f[1], 64)
		if err1 != nil || err2 != nil || lat < -90 || lat > 90 || lon < -180 || lon > 180 {
			return nil, fmt.Errorf("coordinate %q", t)
		}
		ring = append(ring, [2]float64{lat, lon})
	}
	if len(ring) < 4 {
		return nil, fmt.Errorf("ring of %d points", len(ring))
	}
	return ring, nil
}

func metres(s string) (int, error) {
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, err
	}
	return int(math.Round(v)), nil
}

// isoDate turns date_modif's "2026/10/31 00:00:00" into "2026-10-31".
func isoDate(s string) string {
	d, _, _ := strings.Cut(s, " ")
	return strings.ReplaceAll(d, "/", "-")
}

// nameFromCode names a zone the KML leaves unnamed from its code's last
// part: "ZSM C-65 SEC 078 | F2 - Génos / Coume de Rougnoude - (3051)"
// gives "F2 - Génos / Coume de Rougnoude".
func nameFromCode(code string) string {
	parts := strings.Split(code, "|")
	last := strings.TrimSpace(parts[len(parts)-1])
	return strings.TrimSpace(codeNumberRe.ReplaceAllString(last, ""))
}

var codeNumberRe = regexp.MustCompile(`\s*-\s*\(\d+\)\s*$`)

// kmlLinks returns the KML files a page links, absolute, in page order.
func kmlLinks(page []byte, base string) []string {
	b, err := url.Parse(base)
	if err != nil {
		return nil
	}
	var out []string
	for _, m := range hrefRe.FindAllSubmatch(page, -1) {
		u, err := b.Parse(string(m[1]))
		if err != nil {
			continue
		}
		if s := u.String(); !slices.Contains(out, s) {
			out = append(out, s)
		}
	}
	return out
}

var hrefRe = regexp.MustCompile(`(?i)href="([^"]+\.kml)"`)

// editionDate reads the KML's edition off the page ("Téléchargement du
// fichier KML édité le 1er novembre 2026") as YYYY-MM-DD, or "" where
// the page states none.
func editionDate(page []byte) string {
	text := tagRe.ReplaceAll(page, nil)
	m := editionRe.FindSubmatch(text)
	if m == nil {
		return ""
	}
	day, _ := strconv.Atoi(string(m[1]))
	month := slices.Index(frMonths, strings.ToLower(string(m[2]))) + 1
	year, _ := strconv.Atoi(string(m[3]))
	if month == 0 || day < 1 || day > 31 {
		return ""
	}
	return fmt.Sprintf("%04d-%02d-%02d", year, month, day)
}

var (
	tagRe     = regexp.MustCompile(`<[^>]*>`)
	editionRe = regexp.MustCompile(`(?i)édité le\s+(\d{1,2})\s*(?:er)?\s+(\pL+)\s+(\d{4})`)
	frMonths  = []string{"janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"}
)
