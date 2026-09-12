// ofmx.go decodes an OFMX snapshot.
//
// OFMX is open flightmaps' fork of AIXM 4.5, and it keeps that schema's
// element vocabulary: Ase / AseUid for an airspace, Abd / Avx for its
// boundary, Ahp for an aerodrome, Rwy / Rdn for runways, Vor / Dme / Ndb
// / Tcn for navaids, Dpn for designated points, Gbr / Gbv for a
// geographical border. cmd/fr reads the same names out of the SIA's
// AIXM 4.5, but its decoder is welded to SIA-specific structure, so this
// is its own reader for the subset the datasets need.
//
// The one format difference worth naming: OFMX writes coordinates as
// decimal degrees with a hemisphere suffix ("45.84694444N",
// "006.92111111E") where the SIA writes DDMMSS.

package main

import (
	"encoding/xml"
	"fmt"
	"io"
	"strconv"
	"strings"
)

// Snapshot is the decoded subset of an OFMX document.
type Snapshot struct {
	Effective string
	Airspaces []Airspace
	Borders   map[string][]Point
	Airports  []Airport
	Navaids   []Navaid
}

// Point is a lat/lon pair in decimal degrees.
type Point struct{ Lat, Lon float64 }

// Vertex is one boundary vertex and how the edge reaching it is drawn.
type Vertex struct {
	// Kind is GRC (great circle), CWA / CCA (clockwise / anticlockwise
	// arc about Centre) or FNT (follow a named geographical border).
	Kind   string
	Pt     Point
	Centre Point
	// Border names the Gbr this FNT vertex follows.
	Border string
}

// Airspace is one Ase plus the boundary filed against it.
type Airspace struct {
	Mid      string
	CodeType string
	CodeID   string
	Name     string
	Class    string
	UpperRef string
	UpperVal string
	UpperUOM string
	LowerRef string
	LowerVal string
	LowerUOM string
	Remark   string
	Hours    string
	Vertices []Vertex
}

// Airport is one Ahp with the runways filed against it.
type Airport struct {
	Mid      string
	CodeID   string
	Name     string
	Type     string
	Lat, Lon float64
	Elev     string
	ElevUOM  string
	Runways  []Runway
}

// Runway is one Rwy, with its designator and dimensions.
type Runway struct {
	Designator string
	Length     string
	Width      string
	DimUOM     string
	Surface    string
}

// Navaid is one radio navaid or designated point.
type Navaid struct {
	Kind     string // VOR, DME, NDB, TCN, DPN
	CodeID   string
	Name     string
	Lat, Lon float64
	Freq     string
	FreqUOM  string
	Channel  string
	// PointType is the Dpn codeType (ICAO, VFR-RP, ...).
	PointType string
}

// DecodeOFMX reads a snapshot from an OFMX stream.
func DecodeOFMX(r io.Reader) (*Snapshot, error) {
	snap := &Snapshot{Borders: map[string][]Point{}}
	// A boundary is filed separately from its airspace and refers back by
	// mid, so both are collected and joined after the walk.
	boundaries := map[string][]Vertex{}
	runways := map[string][]Runway{}

	dec := xml.NewDecoder(r)
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		se, ok := tok.(xml.StartElement)
		if !ok {
			continue
		}
		switch se.Name.Local {
		case "OFMX-Snapshot":
			for _, a := range se.Attr {
				if a.Name.Local == "effective" {
					snap.Effective = a.Value
				}
			}
		case "Ase":
			var v xmlAse
			if err := dec.DecodeElement(&v, &se); err != nil {
				return nil, fmt.Errorf("Ase: %w", err)
			}
			snap.Airspaces = append(snap.Airspaces, Airspace{
				Mid:      v.UID.Mid,
				CodeType: strings.TrimSpace(v.UID.CodeType),
				CodeID:   strings.TrimSpace(v.UID.CodeID),
				Name:     strings.TrimSpace(v.Name),
				Class:    strings.TrimSpace(v.Class),
				UpperRef: strings.TrimSpace(v.UpperRef),
				UpperVal: strings.TrimSpace(v.UpperVal),
				UpperUOM: strings.TrimSpace(v.UpperUOM),
				LowerRef: strings.TrimSpace(v.LowerRef),
				LowerVal: strings.TrimSpace(v.LowerVal),
				LowerUOM: strings.TrimSpace(v.LowerUOM),
				Remark:   strings.TrimSpace(v.Remark),
			})
		case "Abd":
			var v xmlAbd
			if err := dec.DecodeElement(&v, &se); err != nil {
				return nil, fmt.Errorf("Abd: %w", err)
			}
			boundaries[v.UID.AseUID.Mid] = decodeVertices(v.Vertices)
		case "Gbr":
			var v xmlGbr
			if err := dec.DecodeElement(&v, &se); err != nil {
				return nil, fmt.Errorf("Gbr: %w", err)
			}
			pts := make([]Point, 0, len(v.Vertices))
			for _, gv := range v.Vertices {
				if p, ok := decodePoint(gv.Lat, gv.Lon); ok {
					pts = append(pts, p)
				}
			}
			if name := strings.TrimSpace(v.UID.Name); name != "" && len(pts) > 1 {
				snap.Borders[name] = pts
			}
		case "Ahp":
			var v xmlAhp
			if err := dec.DecodeElement(&v, &se); err != nil {
				return nil, fmt.Errorf("Ahp: %w", err)
			}
			p, ok := decodePoint(v.Lat, v.Lon)
			if !ok {
				continue
			}
			snap.Airports = append(snap.Airports, Airport{
				Mid:    v.UID.Mid,
				CodeID: strings.ToUpper(strings.TrimSpace(v.UID.CodeID)),
				Name:   strings.TrimSpace(v.Name),
				Type:   strings.TrimSpace(v.Type),
				Lat:    p.Lat, Lon: p.Lon,
				Elev:    strings.TrimSpace(v.Elev),
				ElevUOM: strings.ToUpper(strings.TrimSpace(v.ElevUOM)),
			})
		case "Rwy":
			var v xmlRwy
			if err := dec.DecodeElement(&v, &se); err != nil {
				return nil, fmt.Errorf("Rwy: %w", err)
			}
			owner := v.UID.AhpUID.Mid
			runways[owner] = append(runways[owner], Runway{
				Designator: strings.TrimSpace(v.UID.Designator),
				Length:     strings.TrimSpace(v.Length),
				Width:      strings.TrimSpace(v.Width),
				DimUOM:     strings.ToUpper(strings.TrimSpace(v.DimUOM)),
				Surface:    strings.TrimSpace(v.Surface),
			})
		case "Vor", "Ndb", "Dme", "Tcn":
			var v xmlNavaid
			if err := dec.DecodeElement(&v, &se); err != nil {
				return nil, fmt.Errorf("%s: %w", se.Name.Local, err)
			}
			kind := strings.ToUpper(se.Name.Local)
			uid := v.uid(kind)
			p, ok := decodePoint(uid.Lat, uid.Lon)
			if !ok {
				continue
			}
			snap.Navaids = append(snap.Navaids, Navaid{
				Kind:   kind,
				CodeID: strings.ToUpper(strings.TrimSpace(uid.CodeID)),
				Name:   strings.TrimSpace(v.Name),
				Lat:    p.Lat, Lon: p.Lon,
				Freq:    strings.TrimSpace(v.Freq),
				FreqUOM: strings.ToUpper(strings.TrimSpace(v.FreqUOM)),
				Channel: strings.TrimSpace(v.Channel),
			})
		case "Dpn":
			var v xmlDpn
			if err := dec.DecodeElement(&v, &se); err != nil {
				return nil, fmt.Errorf("Dpn: %w", err)
			}
			p, ok := decodePoint(v.UID.Lat, v.UID.Lon)
			if !ok {
				continue
			}
			snap.Navaids = append(snap.Navaids, Navaid{
				Kind:   "DPN",
				CodeID: strings.ToUpper(strings.TrimSpace(v.UID.CodeID)),
				Name:   strings.TrimSpace(v.Name),
				Lat:    p.Lat, Lon: p.Lon,
				PointType: strings.ToUpper(strings.TrimSpace(v.Type)),
			})
		}
	}

	for i := range snap.Airspaces {
		snap.Airspaces[i].Vertices = boundaries[snap.Airspaces[i].Mid]
	}
	for i := range snap.Airports {
		snap.Airports[i].Runways = runways[snap.Airports[i].Mid]
	}
	return snap, nil
}

func decodeVertices(in []xmlAvx) []Vertex {
	out := make([]Vertex, 0, len(in))
	for _, v := range in {
		p, ok := decodePoint(v.Lat, v.Lon)
		if !ok {
			continue
		}
		vx := Vertex{Kind: strings.ToUpper(strings.TrimSpace(v.CodeType)), Pt: p}
		if c, ok := decodePoint(v.LatArc, v.LonArc); ok {
			vx.Centre = c
		}
		vx.Border = strings.TrimSpace(v.Border.Name)
		out = append(out, vx)
	}
	return out
}

// decodePoint reads the OFMX coordinate form: decimal degrees with a
// trailing hemisphere letter, "45.84694444N" / "006.92111111E".
func decodePoint(lat, lon string) (Point, bool) {
	la, ok1 := decodeCoord(lat, "NS")
	lo, ok2 := decodeCoord(lon, "EW")
	if !ok1 || !ok2 {
		return Point{}, false
	}
	return Point{Lat: la, Lon: lo}, true
}

func decodeCoord(s, hemis string) (float64, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	last := s[len(s)-1]
	sign := 1.0
	if strings.IndexByte(hemis, last) >= 0 {
		if last == 'S' || last == 'W' {
			sign = -1
		}
		s = s[:len(s)-1]
	}
	v, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil {
		return 0, false
	}
	return sign * v, true
}

/* ---- the XML shapes, named as OFMX names them ---- */

type xmlAseUID struct {
	Mid      string `xml:"mid,attr"`
	CodeType string `xml:"codeType"`
	CodeID   string `xml:"codeId"`
}

type xmlAse struct {
	UID      xmlAseUID `xml:"AseUid"`
	Name     string    `xml:"txtName"`
	Class    string    `xml:"codeClass"`
	UpperRef string    `xml:"codeDistVerUpper"`
	UpperVal string    `xml:"valDistVerUpper"`
	UpperUOM string    `xml:"uomDistVerUpper"`
	LowerRef string    `xml:"codeDistVerLower"`
	LowerVal string    `xml:"valDistVerLower"`
	LowerUOM string    `xml:"uomDistVerLower"`
	Remark   string    `xml:"txtRmk"`
}

type xmlAvx struct {
	Border   xmlGbrUID `xml:"GbrUid"`
	CodeType string    `xml:"codeType"`
	Lat      string    `xml:"geoLat"`
	Lon      string    `xml:"geoLong"`
	LatArc   string    `xml:"geoLatArc"`
	LonArc   string    `xml:"geoLongArc"`
}

type xmlAbd struct {
	UID struct {
		AseUID xmlAseUID `xml:"AseUid"`
	} `xml:"AbdUid"`
	Vertices []xmlAvx `xml:"Avx"`
}

type xmlGbrUID struct {
	Name string `xml:"txtName"`
}

type xmlGbr struct {
	UID      xmlGbrUID `xml:"GbrUid"`
	Vertices []struct {
		Lat string `xml:"geoLat"`
		Lon string `xml:"geoLong"`
	} `xml:"Gbv"`
}

type xmlAhp struct {
	UID struct {
		Mid    string `xml:"mid,attr"`
		CodeID string `xml:"codeId"`
	} `xml:"AhpUid"`
	Name    string `xml:"txtName"`
	Type    string `xml:"codeType"`
	Lat     string `xml:"geoLat"`
	Lon     string `xml:"geoLong"`
	Elev    string `xml:"valElev"`
	ElevUOM string `xml:"uomDistVer"`
}

type xmlRwy struct {
	UID struct {
		AhpUID struct {
			Mid string `xml:"mid,attr"`
		} `xml:"AhpUid"`
		Designator string `xml:"txtDesig"`
	} `xml:"RwyUid"`
	Length  string `xml:"valLen"`
	Width   string `xml:"valWid"`
	DimUOM  string `xml:"uomDimRwy"`
	Surface string `xml:"codeComposition"`
}

// xmlNavaidUID is the identity-and-position block every navaid kind
// carries; only its element name differs (VorUid, NdbUid, DmeUid,
// TcnUid), so all four decode into the same shape and the non-empty one
// wins.
type xmlNavaidUID struct {
	CodeID string `xml:"codeId"`
	Lat    string `xml:"geoLat"`
	Lon    string `xml:"geoLong"`
}

type xmlNavaid struct {
	Vor     xmlNavaidUID `xml:"VorUid"`
	Ndb     xmlNavaidUID `xml:"NdbUid"`
	Dme     xmlNavaidUID `xml:"DmeUid"`
	Tcn     xmlNavaidUID `xml:"TcnUid"`
	Name    string       `xml:"txtName"`
	Freq    string       `xml:"valFreq"`
	FreqUOM string       `xml:"uomFreq"`
	Channel string       `xml:"codeChannel"`
}

// uid returns the identity block for the element this was decoded from.
// A DME or TACAN paired with a VOR also carries the VOR's block, so the
// element's own kind picks first.
func (n *xmlNavaid) uid(kind string) xmlNavaidUID {
	switch kind {
	case "NDB":
		return n.Ndb
	case "DME":
		return n.Dme
	case "TCN":
		return n.Tcn
	}
	return n.Vor
}

type xmlDpn struct {
	UID  xmlNavaidUID `xml:"DpnUid"`
	Name string       `xml:"txtName"`
	Type string       `xml:"codeType"`
}
