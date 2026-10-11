// registers.go reads the Area 1 obstacle data sets four States publish
// beside their eAIP, which stand in for ENR 5.4 where they exist, the
// section listing a sample of what the register holds or pointing at it:
// PANSA's eTOD CSV, EANS's KMZ, Avinor's AIXM and ALBCONTROL's workbook.
// All four States are held (states.go), so these build locally and never
// reach public/data; HungaroControl's register is sent on request only
// (GEN 3.1 6.2) and is not fetched.

package main

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/xml"
	"fmt"
	"io"
	neturl "net/url"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/aixm5"
	"github.com/0intro/loxodrome/internal/eaip"
	"github.com/0intro/loxodrome/internal/obstable"
	"github.com/0intro/loxodrome/internal/xlsx"
)

// obstacleRegister is where a State's Area 1 register is published and how
// it reads.
type obstacleRegister struct {
	// Index is the publisher's page listing the register's editions, Link
	// an edition's address on it, its first group the edition's date as
	// DateLayout writes it. Fixed is the address of a register published
	// once (ALBCONTROL's, not updated since 2022), with no index.
	Index      string
	Link       *regexp.Regexp
	DateLayout string
	Fixed      string
	Read       func(data []byte) ([]aixm5.Obstacle, error)
}

// edition picks the newest edition in force on day: its address and the
// date it is named by.
func (r *obstacleRegister) edition(ctx context.Context, s *State, day time.Time) (string, string, error) {
	if r.Fixed != "" {
		return r.Fixed, "", nil
	}
	page, err := s.Site.Get(ctx, r.Index)
	if err != nil {
		return "", "", err
	}
	base, err := neturl.Parse(r.Index)
	if err != nil {
		return "", "", err
	}
	best, bestDay := "", time.Time{}
	for _, m := range r.Link.FindAllStringSubmatch(string(page), -1) {
		d, err := time.Parse(r.DateLayout, m[2])
		if err != nil || d.After(day) || !d.After(bestDay) {
			continue
		}
		ref, err := neturl.Parse(strings.ReplaceAll(m[1], "&amp;", "&"))
		if err != nil {
			continue
		}
		best, bestDay = base.ResolveReference(ref).String(), d
	}
	if best == "" {
		return "", "", fmt.Errorf("%s lists no edition in force on %s", r.Index, day.Format("2006-01-02"))
	}
	return best, bestDay.Format("2006-01-02"), nil
}

// read fetches the edition in force on day and reads it.
func (r *obstacleRegister) read(ctx context.Context, s *State, day time.Time) ([]aixm5.Obstacle, string, error) {
	url, edition, err := r.edition(ctx, s, day)
	if err != nil {
		return nil, "", err
	}
	data, err := s.Site.Get(ctx, url)
	if err != nil {
		return nil, "", err
	}
	obs, err := r.Read(data)
	if err != nil {
		return nil, "", fmt.Errorf("%s: %w", url, err)
	}
	source := "Area 1 register " + url[strings.LastIndex(url, "/")+1:]
	if edition != "" {
		source += " (" + edition + ")"
	}
	return obs, source, nil
}

// registerSpec reads a register's kinds as the ENR 5.4 reader does.
var registerSpec = obstable.Spec{Kind: eaip.NormObstacleType}

// zipEntry returns the first entry of a zip whose name ends with one of
// the suffixes.
func zipEntry(data []byte, suffixes ...string) ([]byte, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, err
	}
	for _, f := range zr.File {
		name := strings.ToLower(f.Name)
		for _, s := range suffixes {
			if strings.HasSuffix(name, s) {
				rc, err := f.Open()
				if err != nil {
					return nil, err
				}
				defer rc.Close()
				return io.ReadAll(io.LimitReader(rc, 256<<20))
			}
		}
	}
	return nil, fmt.Errorf("no %s in the archive", strings.Join(suffixes, " or "))
}

// readPansaCSV reads PANSA's eTOD Area 1 CSV, a zip holding one
// semicolon-separated file under a metadata preamble.
func readPansaCSV(data []byte) ([]aixm5.Obstacle, error) {
	csv, err := zipEntry(data, ".csv")
	if err != nil {
		return nil, err
	}
	rows, err := obstable.CSV(csv, ';')
	if err != nil {
		return nil, err
	}
	obs, _, err := obstable.Read(rows, registerSpec)
	return obs, err
}

// kmlPlacemark is one KML placemark: its attributes are the rows of the
// HTML table its description carries, and its geometry's coordinates the
// position where the table states none (EANS's two line cranes).
type kmlPlacemark struct {
	Description string   `xml:"description"`
	Point       []string `xml:"Point>coordinates"`
	Line        []string `xml:"LineString>coordinates"`
	MultiPoint  []string `xml:"MultiGeometry>Point>coordinates"`
	MultiLine   []string `xml:"MultiGeometry>LineString>coordinates"`
}

// firstVertex is the first "lon,lat[,alt]" of the placemark's geometry.
func (p kmlPlacemark) firstVertex() (lat, lon string, ok bool) {
	for _, c := range append(append(append(p.Point, p.Line...), p.MultiPoint...), p.MultiLine...) {
		f := strings.Fields(c)
		if len(f) == 0 {
			continue
		}
		parts := strings.Split(f[0], ",")
		if len(parts) >= 2 {
			return parts[1], parts[0], true
		}
	}
	return "", "", false
}

// eansHeadings map EANS's attribute names onto the headings the table
// reader takes.
var eansHeadings = map[string]string{
	"ID":            "OBSTACLE IDENTIFIER",
	"TYPE":          "TYPE",
	"HOR_POS_N_DEG": "LATITUDE",
	"HOR_POS_E_DEG": "LONGITUDE",
	"ELEVATION_FT":  "ELEVATION (FT)",
	"HEIGHT_FT":     "HEIGHT (FT)",
	"LIGHTING":      "LIGHTING",
}

// readEansKMZ reads EANS's Area 1 KMZ, zipped with a spreadsheet in the
// legacy format beside it: each placemark's attributes, as a table.
func readEansKMZ(data []byte) ([]aixm5.Obstacle, error) {
	kmz, err := zipEntry(data, ".kmz")
	if err != nil {
		return nil, err
	}
	kml, err := zipEntry(kmz, ".kml")
	if err != nil {
		return nil, err
	}
	keys := make([]string, 0, len(eansHeadings))
	for k := range eansHeadings {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	head := make([]string, len(keys))
	for i, k := range keys {
		head[i] = eansHeadings[k]
	}
	rows := [][]string{head}
	dec := xml.NewDecoder(bytes.NewReader(kml))
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
		var p kmlPlacemark
		if err := dec.DecodeElement(&p, &se); err != nil {
			return nil, err
		}
		attrs, err := descriptionAttributes(p.Description)
		if err != nil {
			return nil, err
		}
		if attrs["HOR_POS_N_DEG"] == "" {
			// A line obstacle is placed at its first vertex, as the AIXM
			// decoder places a cable.
			if lat, lon, ok := p.firstVertex(); ok {
				attrs["HOR_POS_N_DEG"], attrs["HOR_POS_E_DEG"] = lat, lon
			}
		}
		row := make([]string, len(keys))
		for i, k := range keys {
			row[i] = attrs[k]
		}
		rows = append(rows, row)
	}
	obs, _, err := obstable.Read(rows, registerSpec)
	return obs, err
}

// descriptionAttributes reads a placemark description's table of name and
// value cells.
func descriptionAttributes(desc string) (map[string]string, error) {
	doc, err := eaip.ParseHTML([]byte(desc))
	if err != nil {
		return nil, err
	}
	attrs := map[string]string{}
	for _, tr := range eaip.Elems(doc, "tr") {
		var cells []string
		for c := tr.FirstChild; c != nil; c = c.NextSibling {
			if eaip.IsElem(c) && c.Data == "td" {
				cells = append(cells, eaip.NormSpace(eaip.NodeText(c)))
			}
		}
		if len(cells) == 2 {
			attrs[cells[0]] = cells[1]
		}
	}
	return attrs, nil
}

// readAvinorAIXM reads Avinor's Area 1 data set, AIXM 5.1 zipped.
func readAvinorAIXM(data []byte) ([]aixm5.Obstacle, error) {
	src, err := zipEntry(data, ".xml")
	if err != nil {
		return nil, err
	}
	msg, err := aixm5.Decode(src)
	if err != nil {
		return nil, err
	}
	return msg.Obstacles, nil
}

// readAlbcontrolXLSX reads ALBCONTROL's workbook: the register on one
// sheet, the obstacles added since on another and those deleted on a
// third, which come off.
func readAlbcontrolXLSX(data []byte) ([]aixm5.Obstacle, error) {
	wb, err := xlsx.Open(data)
	if err != nil {
		return nil, err
	}
	var kept []aixm5.Obstacle
	deleted := map[string]bool{}
	for _, name := range wb.SheetNames() {
		rows, err := wb.Rows(name)
		if err != nil {
			return nil, err
		}
		obs, _, err := obstable.Read(rows, registerSpec)
		if err != nil {
			return nil, fmt.Errorf("sheet %q: %w", name, err)
		}
		if strings.Contains(strings.ToLower(name), "delet") {
			for _, o := range obs {
				deleted[o.ID] = true
			}
			continue
		}
		kept = append(kept, obs...)
	}
	out := kept[:0]
	for _, o := range kept {
		if !deleted[o.ID] {
			out = append(out, o)
		}
	}
	return out, nil
}

// The registers, by State.
var (
	pansaRegister = &obstacleRegister{
		Index:      "https://ais.pansa.pl/en/publications/etod/",
		Link:       regexp.MustCompile(`href="(https://docs\.pansa\.pl/ais/etod/area1/eTOD_AREA1_Obstacles_(\d{4}-\d{2}-\d{2})\.zip)"`),
		DateLayout: "2006-01-02",
		Read:       readPansaCSV,
	}
	eansRegister = &obstacleRegister{
		Index:      "https://aim.eans.ee/en/obstacles",
		Link:       regexp.MustCompile(`href="(https://aim\.eans\.ee/sites/default/files/forms/aim_published_ao/ESTONIA_AREA_1_OBSTACLE_(\d{8})\.zip)"`),
		DateLayout: "02012006",
		Read:       readEansKMZ,
	}
	avinorRegister = &obstacleRegister{
		Index:      "https://aim-prod.avinor.no/no/Obstacle/",
		Link:       regexp.MustCompile(`href="(/no/Obstacle/Home/DownloadZip\?areaName=Norway&amp;effectiveDate=(\d{4}-\d{2}-\d{2})T[^"]*)"`),
		DateLayout: "2006-01-02",
		Read:       readAvinorAIXM,
	}
	albcontrolRegister = &obstacleRegister{
		Fixed: "https://albcontrol.al/wp-content/uploads/2024/01/LAAA_AREA-1_29-DEC-2022.xlsx",
		Read:  readAlbcontrolXLSX,
	}
)
