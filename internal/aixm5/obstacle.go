package aixm5

import (
	"encoding/xml"
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
	SrsName   string       `xml:"srsName,attr"`
	Pos       string       `xml:"pos"`
	Elevation *xmlUOMValue `xml:"elevation"`
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
// element and appends one Obstacle per BASELINE timeslice.
//
// A multi-part obstacle is decoded as ONE row, at the first part that
// carries a usable position. Taking literally the first part instead
// used to drop whole classes of obstacle: FOCA files a Swiss power line
// with its spans first and its pylons after, so every transmission
// line, catenary and cableway in the country vanished. The part
// breakdown itself is not useful for an overlay map, but which part the
// row is placed at is.
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
		if len(s.Parts) == 0 {
			continue
		}
		if len(s.Parts) > 1 {
			msg.MultiPartObstacles++
		}
		p, pt, curve := locatedPart(s.Parts)
		if p == nil {
			continue
		}
		raw, srs := "", ""
		if pt != nil {
			raw, srs = pt.Pos, pt.SrsName
		} else {
			raw, srs = curve.firstPos(), curve.SrsName
		}
		lat, lon, ok := parsePos(raw)
		if !ok {
			continue
		}
		if posOrderSwapped(srs) {
			lat, lon = lon, lat
		}
		o := Obstacle{
			ID:       featureIdentifier(f.GMLID, f.Identifier),
			Name:     strings.TrimSpace(s.Name),
			NameNote: propertyNote(s.Annotations, "name"),
			Type:     strings.TrimSpace(p.Type),
			Lat:      round5(lat),
			Lon:      round5(lon),
			Lighted:  strings.EqualFold(strings.TrimSpace(s.Lighted), "YES"),
			Group:    strings.EqualFold(strings.TrimSpace(s.Group), "YES"),
		}
		// Fall back to the parent VerticalStructure type when the
		// part omits it; that's the common shape for single-part
		// structures.
		if o.Type == "" {
			o.Type = strings.TrimSpace(s.Type)
		}
		if h, ok := metresFromUOM(p.VerticalExtent); ok {
			o.HeightM = &h
		}
		elev := (*xmlUOMValue)(nil)
		if pt != nil {
			elev = pt.Elevation
		} else {
			elev = curve.Elevation
		}
		if e, ok := metresFromUOM(elev); ok {
			o.ElevM = &e
		}
		msg.Obstacles = append(msg.Obstacles, o)
	}
	return nil
}

// locatedPart picks the part the obstacle's row is placed at: the first
// one carrying a point, and failing that the first carrying a curve. A
// point is preferred over a curve because it is the structure itself (a
// pylon) rather than the span between two of them.
func locatedPart(parts []xmlObstaclePart) (*xmlObstaclePart, *xmlElevatedPoint, *xmlElevatedCurve) {
	for i := range parts {
		p := &parts[i]
		if pt := p.PointA; pt != nil {
			return p, pt, nil
		}
		if pt := p.PointB; pt != nil {
			return p, pt, nil
		}
	}
	for i := range parts {
		p := &parts[i]
		if p.Curve != nil && p.Curve.firstPos() != "" {
			return p, nil, p.Curve
		}
	}
	return nil, nil, nil
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
