// kml.go reads the Austro Control "Luftraumstruktur" KML: the folder
// tree that types every placemark, the typed ExtendedData fields each
// placemark carries, and the extruded-prism geometry the airspace
// footprints are lifted out of.

package main

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/0intro/loxodrome/internal/aip"
)

// KMLPayload returns the KML document of a download: the first .kml
// member of a .kmz (a zip holding one .kml beside the legend images), or
// the bytes themselves when the download is a bare .kml. The inner
// member carries the cycle it was first generated for rather than the
// current one (20230907LuftraumAT.kml ships inside the 2026-07-09
// download), so the entry is taken by position rather than by name.
func KMLPayload(name string, data []byte) ([]byte, string, error) {
	if strings.EqualFold(filepath.Ext(name), ".kml") {
		return data, name, nil
	}
	member, inner, err := firstZipMember(data, func(f *zip.File) bool {
		return strings.EqualFold(filepath.Ext(f.Name), ".kml")
	})
	if err != nil {
		return nil, "", fmt.Errorf("%s: %w", name, err)
	}
	if member == nil {
		return nil, "", fmt.Errorf("%s has no .kml entry", name)
	}
	return member, inner, nil
}

// readCapped reads a file under the shared member-size limit.
func readCapped(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, aip.MaxMemberSize+1))
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	if int64(len(b)) > aip.MaxMemberSize {
		return nil, fmt.Errorf("%s exceeds %d byte limit", path, aip.MaxMemberSize)
	}
	return b, nil
}

// firstZipMember returns the bytes and base name of the first archive
// entry accepted by pick, under the same MaxMemberSize guard
// aip.ReadLargestXML enforces: a malformed or hostile member must not
// decompress unbounded.
func firstZipMember(data []byte, pick func(*zip.File) bool) ([]byte, string, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, "", fmt.Errorf("open zip: %w", err)
	}
	for _, f := range zr.File {
		if !pick(f) {
			continue
		}
		if f.UncompressedSize64 > aip.MaxMemberSize {
			return nil, "", fmt.Errorf("member %s declares %d bytes, exceeds %d limit",
				f.Name, f.UncompressedSize64, aip.MaxMemberSize)
		}
		fr, err := f.Open()
		if err != nil {
			return nil, "", fmt.Errorf("open %s in zip: %w", f.Name, err)
		}
		defer fr.Close()
		out, err := io.ReadAll(io.LimitReader(fr, aip.MaxMemberSize+1))
		if err != nil {
			return nil, "", fmt.Errorf("read %s in zip: %w", f.Name, err)
		}
		if int64(len(out)) > aip.MaxMemberSize {
			return nil, "", fmt.Errorf("member %s exceeds %d byte limit", f.Name, aip.MaxMemberSize)
		}
		return out, filepath.Base(f.Name), nil
	}
	return nil, "", nil
}

// Placemark is one decoded KML Placemark together with the folder path
// that types it (outermost folder first).
type Placemark struct {
	ID     string
	Name   string
	Folder []string
	// Data holds the ExtendedData SchemaData fields: IDENT, Name,
	// "Upper Limit", "Lower Limit" for airspaces; CODE / NAME /
	// ELEVATION / RWYLENGTH / FREQUENCY for airports; CODEID /
	// TXTNAME / frequency / channel for navaids.
	Data map[string]string
	// Desc is the description CDATA, the rendered HTML info bubble.
	// It restates the ExtendedData with unit labels, which is how the
	// airport elevation gets a trustworthy unit (see descField).
	Desc string
	// Rings are the horizontal footprints in [lat, lon] order, ready
	// for the SPA row schema.
	Rings [][][2]float64
	// Point is the [lat, lon] position of a point feature.
	Point *[2]float64
}

// Field returns a trimmed ExtendedData value.
func (p *Placemark) Field(name string) string {
	return strings.TrimSpace(p.Data[name])
}

type kmlPolygon struct {
	Coordinates string `xml:"outerBoundaryIs>LinearRing>coordinates"`
}

type kmlPoint struct {
	Coordinates string `xml:"coordinates"`
}

type kmlSimpleData struct {
	Name  string `xml:"name,attr"`
	Value string `xml:",chardata"`
}

type kmlPlacemark struct {
	ID          string          `xml:"id,attr"`
	Name        string          `xml:"name"`
	Description string          `xml:"description"`
	SimpleData  []kmlSimpleData `xml:"ExtendedData>SchemaData>SimpleData"`
	MultiPolys  []kmlPolygon    `xml:"MultiGeometry>Polygon"`
	Polys       []kmlPolygon    `xml:"Polygon"`
	MultiPoints []kmlPoint      `xml:"MultiGeometry>Point"`
	Points      []kmlPoint      `xml:"Point"`
}

// ParseKML walks the document and returns every placemark with the
// folder ids enclosing it. The folder path is the type carrier: Austro
// Control keys each category to a stable folder id (0101_Restricted_areas,
// 0207_Military_training_areas, 05_Airports, ...), which survives the
// per-cycle regeneration of the file.
func ParseKML(data []byte) ([]Placemark, error) {
	dec := xml.NewDecoder(bytes.NewReader(data))
	var stack []string
	var out []Placemark
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("parse kml: %w", err)
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "Folder":
				stack = append(stack, attr(t, "id"))
			case "Placemark":
				var pm kmlPlacemark
				if err := dec.DecodeElement(&pm, &t); err != nil {
					return nil, fmt.Errorf("parse placemark: %w", err)
				}
				out = append(out, buildPlacemark(pm, stack))
			}
		case xml.EndElement:
			if t.Name.Local == "Folder" && len(stack) > 0 {
				stack = stack[:len(stack)-1]
			}
		}
	}
	return out, nil
}

func attr(se xml.StartElement, name string) string {
	for _, a := range se.Attr {
		if a.Name.Local == name {
			return a.Value
		}
	}
	return ""
}

func buildPlacemark(pm kmlPlacemark, stack []string) Placemark {
	data := make(map[string]string, len(pm.SimpleData))
	for _, sd := range pm.SimpleData {
		data[sd.Name] = strings.TrimSpace(sd.Value)
	}
	polys := append(append([]kmlPolygon{}, pm.MultiPolys...), pm.Polys...)
	points := append(append([]kmlPoint{}, pm.MultiPoints...), pm.Points...)

	p := Placemark{
		ID:     pm.ID,
		Name:   strings.TrimSpace(pm.Name),
		Folder: append([]string{}, stack...),
		Data:   data,
		Desc:   pm.Description,
		Rings:  footprints(polys),
	}
	for _, pt := range points {
		if vs := parseCoords(pt.Coordinates); len(vs) > 0 {
			p.Point = &[2]float64{vs[0].lat, vs[0].lon}
			break
		}
	}
	return p
}

// vertex is one KML coordinate triple: lon/lat in degrees, alt in metres.
type vertex struct{ lon, lat, alt float64 }

// parseCoords reads a KML <coordinates> payload, "lon,lat,alt" triples
// separated by whitespace.
func parseCoords(s string) []vertex {
	fields := strings.Fields(s)
	out := make([]vertex, 0, len(fields))
	for _, f := range fields {
		parts := strings.Split(f, ",")
		if len(parts) < 2 {
			continue
		}
		lon, err1 := strconv.ParseFloat(parts[0], 64)
		lat, err2 := strconv.ParseFloat(parts[1], 64)
		if err1 != nil || err2 != nil {
			continue
		}
		v := vertex{lon: lon, lat: lat}
		if len(parts) > 2 {
			v.alt, _ = strconv.ParseFloat(parts[2], 64)
		}
		out = append(out, v)
	}
	return out
}

// altEpsilon is the tolerance for calling a ring's altitudes equal; the
// export writes exact converted metres (457.2 for 1500 ft), so the
// caps are flat to well under a millimetre.
const altEpsilon = 0.001

// footprints lifts the horizontal outlines out of the extruded prism
// each airspace is drawn as: a ring whose vertices share one altitude is
// a cap (the floor or the ceiling), the rings mixing two altitudes are
// the side walls between them. The ceiling repeats the floor with the
// winding reversed, so caps are deduplicated by a direction- and
// rotation-independent key and the first survivor keeps its own vertex
// order. The closing vertex is dropped: the SPA row schema stores open
// rings.
func footprints(polys []kmlPolygon) [][][2]float64 {
	var out [][][2]float64
	seen := map[string]bool{}
	for _, poly := range polys {
		vs := parseCoords(poly.Coordinates)
		if len(vs) < 4 || !flat(vs) {
			continue
		}
		ring := make([][2]float64, 0, len(vs))
		for _, v := range vs {
			ring = append(ring, [2]float64{v.lat, v.lon})
		}
		ring = openRing(ring)
		if len(ring) < 3 {
			continue
		}
		key := ringKey(ring)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, ring)
	}
	return out
}

// flat reports whether every vertex sits at the same altitude.
func flat(vs []vertex) bool {
	for _, v := range vs[1:] {
		if math.Abs(v.alt-vs[0].alt) > altEpsilon {
			return false
		}
	}
	return true
}

// openRing drops the repeated closing vertex KML rings carry.
func openRing(ring [][2]float64) [][2]float64 {
	for len(ring) > 1 && samePoint(ring[0], ring[len(ring)-1]) {
		ring = ring[:len(ring)-1]
	}
	return ring
}

func samePoint(a, b [2]float64) bool {
	return math.Abs(a[0]-b[0]) < 1e-9 && math.Abs(a[1]-b[1]) < 1e-9
}

// ringKey is a canonical form of a ring that ignores winding direction
// and start vertex, so the floor and ceiling caps of one prism collapse
// to a single footprint.
func ringKey(ring [][2]float64) string {
	pts := make([]string, len(ring))
	for i, p := range ring {
		pts[i] = strconv.FormatFloat(p[0], 'f', 6, 64) + "," + strconv.FormatFloat(p[1], 'f', 6, 64)
	}
	rev := make([]string, len(pts))
	for i := range pts {
		rev[i] = pts[len(pts)-1-i]
	}
	fwd, back := canonicalRotation(pts), canonicalRotation(rev)
	if back < fwd {
		return back
	}
	return fwd
}

// canonicalRotation joins pts starting from the lexicographically
// smallest element, so two rotations of one ring compare equal.
func canonicalRotation(pts []string) string {
	start := 0
	for i := 1; i < len(pts); i++ {
		if pts[i] < pts[start] {
			start = i
		}
	}
	var b strings.Builder
	for i := range pts {
		b.WriteString(pts[(start+i)%len(pts)])
		b.WriteByte(' ')
	}
	return b.String()
}

// headlineRe matches one labelled field of the description bubble,
// "<span class="headline">Höhe (FT)</span><br /> 2870".
var headlineRe = regexp.MustCompile(`(?s)<span class="headline">([^<]+)</span>\s*<br\s*/?>\s*([^<]*)`)

// descField returns a labelled value from the description bubble. The
// bubble is where the units live: the airport ELEVATION ExtendedData
// field is published in metres for a handful of aerodromes and in feet
// for the rest, while the bubble states "Höhe (FT)" and converts, so it
// is the trustworthy elevation source.
func descField(desc, label string) string {
	for _, m := range headlineRe.FindAllStringSubmatch(desc, -1) {
		if strings.TrimSpace(m[1]) == label {
			return strings.TrimSpace(m[2])
		}
	}
	return ""
}
