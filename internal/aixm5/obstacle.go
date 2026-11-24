package aixm5

import (
	"encoding/xml"
	"fmt"
	"strconv"
	"strings"
)

// xmlObstacle mirrors aixm:VerticalStructure.
type xmlObstacle struct {
	GMLID      string             `xml:"id,attr"`
	Identifier string             `xml:"identifier"`
	TimeSlices []xmlObstacleSlice `xml:"timeSlice>VerticalStructureTimeSlice"`
}

type xmlObstacleSlice struct {
	Interpretation string            `xml:"interpretation"`
	Name           string            `xml:"name"`
	Type           string            `xml:"type"`
	Lighted        string            `xml:"lighted"`
	Group          string            `xml:"group"` // "YES" / "NO"
	Parts          []xmlObstaclePart `xml:"part>VerticalStructurePart"`
	Annotations    []xmlNote         `xml:"annotation>Note"`
}

type xmlObstaclePart struct {
	VerticalExtent *xmlUOMValue `xml:"verticalExtent"`
	Type           string       `xml:"type"`
	// Location alternatives observed in real AIP datasets:
	//   - horizontalProjection_location > ElevatedPoint (Donlon)
	//   - horizontalProjection > ElevatedPoint (some publishers)
	// Decode both into the same slot.
	PointA *xmlElevatedPoint `xml:"horizontalProjection_location>ElevatedPoint"`
	PointB *xmlElevatedPoint `xml:"horizontalProjection>ElevatedPoint"`
	// A LINEAR obstacle files its geometry as a curve instead: a power
	// line's span, a cableway, an aerial ropeway. FOCA publishes the
	// Swiss register that way, and those are exactly the obstacles an
	// Alpine VFR layer exists for, so a curve counts as a position.
	Curve *xmlElevatedCurve `xml:"horizontalProjection_linearExtent>ElevatedCurve"`
}

type xmlElevatedPoint struct {
	// SrsName names the coordinate reference system. Absent, or an
	// EPSG:4326 form, means AIXM's own latitude-then-longitude order;
	// CRS84 means the opposite, and reading one as the other puts
	// Switzerland in Somalia. See posOrderSwapped.
	SrsName     string       `xml:"srsName,attr"`
	Pos         string       `xml:"pos"`
	Elevation   *xmlUOMValue `xml:"elevation"`
	Annotations []xmlNote    `xml:"annotation>Note"`
}

// xmlElevatedCurve is a linear obstacle's geometry. Only the first
// vertex is read: the row schema carries one position per obstacle, and
// the start of the span is a real point on it.
type xmlElevatedCurve struct {
	SrsName   string       `xml:"srsName,attr"`
	PosList   string       `xml:"segments>GeodesicString>posList"`
	Pos       string       `xml:"segments>GeodesicString>pos"`
	LinePos   string       `xml:"segments>LineStringSegment>posList"`
	Elevation *xmlUOMValue `xml:"elevation"`
}

// firstPos returns the curve's first vertex as a raw "a b" pair.
func (c *xmlElevatedCurve) firstPos() string {
	for _, s := range []string{c.PosList, c.Pos, c.LinePos} {
		if f := strings.Fields(s); len(f) >= 2 {
			return f[0] + " " + f[1]
		}
	}
	return ""
}

// posOrderSwapped reports whether a gml:pos in this CRS is written
// longitude first. AIXM's own convention, and the EPSG:4326 axis order,
// is latitude first; the OGC CRS84 identifier means the opposite. Any
// publisher that names CRS84 is taken at its word.
func posOrderSwapped(srsName string) bool {
	return strings.Contains(strings.ToUpper(srsName), "CRS84")
}

// decodeObstacleFeature consumes the <aixm:VerticalStructure>
// element and appends one Obstacle per located part of each BASELINE
// timeslice: a wind farm's turbines, a power line's pylons and a
// cableway's stations each at its own position, with its own height and
// elevation. The DFS's SEILBAHNEN 25 rises from its valley station at
// 3276 ft to its mountain station at 9720.8 ft.
//
// The point parts come first, in the order filed, then the curves: the
// first keeps the structure's id and the others take <id>#2, #3. A point
// is the structure itself, a pylon or a station, where a curve is the
// span between two of them, and FOCA files a power line with its spans
// first and its pylons after. A span stating neither height nor
// elevation adds nothing to its pylons and is left out, unless the
// structure has nothing else (a cableway filed as a span alone).
func decodeObstacleFeature(dec *xml.Decoder, start *xml.StartElement, msg *Message) error {
	var f xmlObstacle
	if err := dec.DecodeElement(&f, start); err != nil {
		return err
	}
	for i := range f.TimeSlices {
		s := &f.TimeSlices[i]
		if !strings.EqualFold(strings.TrimSpace(s.Interpretation), "BASELINE") {
			msg.SkippedNonBaseline++
			continue
		}
		if len(s.Parts) > 1 {
			msg.MultiPartObstacles++
		}
		id := featureIdentifier(f.GMLID, f.Identifier)
		n := 0
		for _, p := range locatedParts(s.Parts) {
			o, ok := partObstacle(s, p)
			if !ok {
				continue
			}
			n++
			o.ID = id
			if n > 1 {
				o.ID = fmt.Sprintf("%s#%d", id, n)
			}
			msg.Obstacles = append(msg.Obstacles, o)
		}
	}
	return nil
}

// partObstacle reads one located part of a structure as an obstacle:
// false when its position does not parse. The type is the part's, else
// the structure's, an untyped point of a structure that also files spans
// being one of their supports (FOCA types neither the pylons of a power
// line nor its spans). Where the part's elevation is measured at the base,
// Austro Control's note on a cableway's stations ("ELEV measured at the
// base of the OBST."), its height is added to it, the row's elevation
// being the obstacle's top.
func partObstacle(s *xmlObstacleSlice, p *xmlObstaclePart) (Obstacle, bool) {
	raw, srs, elev, notes := "", "", (*xmlUOMValue)(nil), []xmlNote(nil)
	if pt := p.point(); pt != nil {
		raw, srs, elev, notes = pt.Pos, pt.SrsName, pt.Elevation, pt.Annotations
	} else {
		raw, srs, elev = p.Curve.firstPos(), p.Curve.SrsName, p.Curve.Elevation
	}
	lat, lon, ok := parsePos(raw)
	if !ok {
		return Obstacle{}, false
	}
	if posOrderSwapped(srs) {
		lat, lon = lon, lat
	}
	o := Obstacle{
		Name:     strings.TrimSpace(s.Name),
		NameNote: propertyNote(s.Annotations, "name"),
		Type:     strings.TrimSpace(p.Type),
		Lat:      round5(lat),
		Lon:      round5(lon),
		Lighted:  strings.EqualFold(strings.TrimSpace(s.Lighted), "YES"),
		Group:    strings.EqualFold(strings.TrimSpace(s.Group), "YES"),
	}
	if o.Type == "" {
		o.Type = strings.TrimSpace(s.Type)
		o.Support = p.point() != nil && hasSpans(s.Parts)
	}
	if h, ok := metresFromUOM(p.VerticalExtent); ok {
		o.HeightM = &h
	}
	if e, ok := metresFromUOM(elev); ok {
		if o.HeightM != nil && measuredAtBase(notes) {
			e += *o.HeightM
		}
		o.ElevM = &e
	}
	return o, true
}

// measuredAtBase reports whether an elevation's notes say it is the
// obstacle's foot rather than its top.
func measuredAtBase(notes []xmlNote) bool {
	for _, n := range notes {
		if !strings.EqualFold(strings.TrimSpace(n.PropertyName), "elevation") {
			continue
		}
		for _, t := range n.LinguisticTxt {
			if strings.Contains(strings.ToUpper(t.Note), "MEASURED AT THE BASE") {
				return true
			}
		}
	}
	return false
}

// hasSpans reports whether a structure files a curve part, a span between
// two of its points.
func hasSpans(parts []xmlObstaclePart) bool {
	for i := range parts {
		if parts[i].point() == nil && parts[i].Curve != nil {
			return true
		}
	}
	return false
}

// point returns the part's position when it is a point, nil otherwise.
func (p *xmlObstaclePart) point() *xmlElevatedPoint {
	if p.PointA != nil {
		return p.PointA
	}
	return p.PointB
}

// locatedParts returns the parts of a structure its rows are placed at:
// every part carrying a point, then every curve that states a height or an
// elevation, or the first curve where the structure has nothing else.
func locatedParts(parts []xmlObstaclePart) []*xmlObstaclePart {
	var out, curves []*xmlObstaclePart
	for i := range parts {
		if parts[i].point() != nil {
			out = append(out, &parts[i])
		}
	}
	for i := range parts {
		p := &parts[i]
		if p.point() != nil || p.Curve == nil || p.Curve.firstPos() == "" {
			continue
		}
		curves = append(curves, p)
		_, hasHeight := metresFromUOM(p.VerticalExtent)
		_, hasElev := metresFromUOM(p.Curve.Elevation)
		if hasHeight || hasElev {
			out = append(out, p)
		}
	}
	if len(out) == 0 && len(curves) > 0 {
		out = curves[:1]
	}
	return out
}

// metresFromUOM parses a length value+uom into metres; ok=false when
// the value is missing / unparseable / has an unsupported unit.
// AIXM 5.1 length units commonly used in obstacle data:
//   - M / m  (metres)
//   - FT / ft (feet)
func metresFromUOM(v *xmlUOMValue) (float64, bool) {
	if v == nil {
		return 0, false
	}
	val := strings.TrimSpace(v.Value)
	if val == "" {
		return 0, false
	}
	x, err := strconv.ParseFloat(val, 64)
	if err != nil {
		return 0, false
	}
	switch strings.ToUpper(strings.TrimSpace(v.UOM)) {
	case "M", "":
		return x, true
	case "FT":
		return x * 0.3048, true
	default:
		return 0, false
	}
}

// propertyNote returns the text of the first DESCRIPTION annotation
// attached to the named property, the AIXM way of carrying a
// human-readable rendering of a coded field. Austro Control publishes
// the obstacle's place name this way, its aixm:name being the catalogue
// reference. Empty when the publisher annotates nothing.
func propertyNote(notes []xmlNote, property string) string {
	for _, n := range notes {
		if !strings.EqualFold(strings.TrimSpace(n.PropertyName), property) {
			continue
		}
		if p := strings.ToUpper(strings.TrimSpace(n.Purpose)); p != "" && p != "DESCRIPTION" {
			continue
		}
		for _, t := range n.LinguisticTxt {
			if v := strings.TrimSpace(t.Note); v != "" {
				return v
			}
		}
	}
	return ""
}
