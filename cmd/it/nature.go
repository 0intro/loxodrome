// nature.go emits it-nature.json: the protected natural sites the
// Italian snapshot files as airspace.
//
// OFMX puts 481 volumes under codeType P and 123 under NRA. Only the 277
// P rows carrying a prohibited-area designator ("LI P215 - SALUZZO") are
// ICAO prohibited areas; the rest are national and regional parks and
// nature reserves whose overflight the AIP regulates with a MINIMUM
// HEIGHT rather than a prohibition. They belong in the same dataset as
// France's PRN parks and Belgium's bird areas, drawn with the nature
// bullseye carrying its minimum overflight altitude, not with the
// prohibited-area crosshatch.
//
// The row schema is the one cmd/fr and cmd/be emit.

package main

import (
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
)

// NatureArtifact is the it-nature.json document, in the layout every
// nature dataset shares (aip.NatureFields).
type NatureArtifact = aip.NatureArtifact

// NatureMeta is the it-nature.meta.json document.
type NatureMeta struct {
	GeneratedAt  string         `json:"generatedAt"`
	Source       string         `json:"source"`
	SourceSha256 string         `json:"sourceSha256"`
	Effective    string         `json:"effective"`
	ZoneCount    int            `json:"zoneCount"`
	SkippedNoGeo int            `json:"skippedNoGeo"`
	Counts       map[string]int `json:"counts"`
	BBox         aip.BBox       `json:"bbox,omitempty"`
	// BBoxes splits that envelope into the pieces the rows really
	// occupy, for a publisher whose territory is not connected;
	// absent when the rows form one group.
	BBoxes []aip.BBox `json:"bboxes,omitempty"`
}

// buildNature turns the split-off sites into nature rows.
//
// The minimum overflight altitude is the site's own published lower
// limit, which is what the AIP regulates it with: a park filed 0-3000 ft
// AGL is asking to be overflown above 3000 ft AGL.
func buildNature(sites []Airspace, source, sum, effective string, now func() time.Time, minN, maxN int) (NatureArtifact, NatureMeta, error) {
	rows := make([]aip.NatureRow, 0, len(sites))
	counts := map[string]int{}
	skipped := 0
	for i := range sites {
		s := &sites[i]
		lat, lon, ok := centroid(s.Vertices)
		if !ok {
			skipped++
			continue
		}
		// NRA is a nature reserve; a park filed under P is the same kind
		// of site. Both take the SPA's NATURE type, the one cmd/fr uses
		// for the French PRN parks.
		typ := "NATURE"
		counts[typ]++
		minAlt, ref := minimumAltitude(s)
		name := s.Name
		if name == "" {
			name = s.CodeID
		}
		rows = append(rows, aip.NatureRow{
			ID: "it:" + s.CodeID, Type: typ, Name: name,
			Lat: round5(lat), Lon: round5(lon), MinAlt: minAlt, MinAltRef: ref,
		})
	}
	art, bbox, bboxes, err := aip.BuildNature(rows, "nature", minN, maxN)
	if err != nil {
		return NatureArtifact{}, NatureMeta{}, err
	}
	meta := NatureMeta{
		GeneratedAt:  now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Source:       source,
		SourceSha256: sum,
		Effective:    effective,
		ZoneCount:    len(art.Rows),
		SkippedNoGeo: skipped,
		Counts:       counts,
		BBox:         bbox,
		BBoxes:       bboxes,
	}
	return art, meta, nil
}

// minimumAltitude reads the site's published upper limit as the height
// to stay above. A protected site is filed from the surface up to the
// altitude overflight is restricted below, so it is the UPPER limit that
// states the minimum overflight height.
func minimumAltitude(s *Airspace) (any, string) {
	val := strings.TrimSpace(s.UpperVal)
	if val == "" {
		return nil, ""
	}
	switch strings.ToUpper(strings.TrimSpace(s.UpperRef)) {
	case "ALT":
		return val, "AMSL"
	case "HEI":
		return val, "AGL"
	case "STD":
		return val, "FL"
	}
	return nil, ""
}

// centroid is the mean of a boundary's vertices, which is where the
// nature layer draws its bullseye.
func centroid(vs []Vertex) (lat, lon float64, ok bool) {
	if len(vs) == 0 {
		return 0, 0, false
	}
	var sLat, sLon float64
	for _, v := range vs {
		sLat += v.Pt.Lat
		sLon += v.Pt.Lon
	}
	n := float64(len(vs))
	return sLat / n, sLon / n, true
}
