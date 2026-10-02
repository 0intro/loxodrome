// airspaces_parse.go decodes the AIXM 4.5 elements the airspace overlay
// needs; Ase (airspace), Abd (boundary), Sae (service↔airspace link) and
// Fqy (frequency). It uses typed encoding/xml structs and a streaming
// decoder so the 43 MB document never fully materialises.

package main

import (
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
)

// Ase is an airspace. Only the fields the overlay uses are decoded; unmapped
// XML elements are ignored by encoding/xml.
type Ase struct {
	Uid struct {
		Mid      int64  `xml:"mid,attr"`
		CodeType string `xml:"codeType"`
		CodeId   string `xml:"codeId"`
	} `xml:"AseUid"`
	TxtName      string `xml:"txtName"`
	TxtLocalType string `xml:"txtLocalType"`
	// CodeActivity tags sporting / recreational D-OTHER zones with a
	// specific activity (PARAGLIDER, GLIDER, BALLOON, PARACHUTE, TOWING).
	// Most D-OTHER rows leave it blank; airspaces.go falls back to a generic
	// "ACTIVITY" type for those.
	CodeActivity     string `xml:"codeActivity"`
	CodeClass        string `xml:"codeClass"`
	CodeDistVerUpper string `xml:"codeDistVerUpper"`
	ValDistVerUpper  string `xml:"valDistVerUpper"`
	UomDistVerUpper  string `xml:"uomDistVerUpper"`
	CodeDistVerLower string `xml:"codeDistVerLower"`
	ValDistVerLower  string `xml:"valDistVerLower"`
	UomDistVerLower  string `xml:"uomDistVerLower"`
	CodeDistVerMax   string `xml:"codeDistVerMax"`
	ValDistVerMax    string `xml:"valDistVerMax"`
	UomDistVerMax    string `xml:"uomDistVerMax"`
	CodeDistVerMnm   string `xml:"codeDistVerMnm"`
	ValDistVerMnm    string `xml:"valDistVerMnm"`
	UomDistVerMnm    string `xml:"uomDistVerMnm"`
	WorkHr           string `xml:"Att>codeWorkHr"`
	RmkWorkHr        string `xml:"Att>txtRmkWorkHr"`
	TxtRmk           string `xml:"txtRmk"`
}

// Avx is one boundary vertex. For arc segments (CWA/CCA) the arc fields hold
// the centre and radius of the arc that reaches the next vertex.
type Avx struct {
	CodeType     string `xml:"codeType"`
	GeoLat       string `xml:"geoLat"`
	GeoLong      string `xml:"geoLong"`
	GeoLatArc    string `xml:"geoLatArc"`
	GeoLongArc   string `xml:"geoLongArc"`
	ValRadiusArc string `xml:"valRadiusArc"`
	UomRadiusArc string `xml:"uomRadiusArc"`
}

// Circle is the alternative boundary form: a single centre and radius.
type Circle struct {
	GeoLatCen  string `xml:"geoLatCen"`
	GeoLongCen string `xml:"geoLongCen"`
	ValRadius  string `xml:"valRadius"`
	UomRadius  string `xml:"uomRadius"`
}

// Abd is an airspace boundary, linked to its Ase by mid. It carries either a
// list of Avx vertices or a single Circle.
type Abd struct {
	Uid struct {
		AseUid struct {
			Mid int64 `xml:"mid,attr"`
		} `xml:"AseUid"`
	} `xml:"AbdUid"`
	Avx    []Avx   `xml:"Avx"`
	Circle *Circle `xml:"Circle"`
}

// Adg is an airspace aggregation. The one form the overlay uses is
// AseUidSameExtent: a vertically split volume the SIA models as one
// boundary-bearing Ase (the base) plus twin Ase rows that carry no Abd of
// their own and borrow the base's lateral extent (e.g. the class E part
// under a class D TMA, or the class E LTA Alps slabs under their class D
// upper). AdgUid>AseUid is the twin; AseUidSameExtent is the base. The
// AseUidBase / codeOpr / AseUidComponent union form (the bare parent rows
// like "TMA SEINE" whose numbered parts already carry geometry) is left
// undecoded on purpose: SameExtent.Mid is then zero and buildRing skips it.
type Adg struct {
	Uid struct {
		AseUid struct {
			Mid int64 `xml:"mid,attr"`
		} `xml:"AseUid"`
	} `xml:"AdgUid"`
	SameExtent struct {
		Mid int64 `xml:"mid,attr"`
	} `xml:"AseUidSameExtent"`
}

// Sae links an airspace to a service. SaeUid embeds the full SerUid inline,
// including the unit name and the service kind, so no separate Ser lookup is
// needed. CodeType ("APP", "TWR", "FIS", "ATIS", ...) is what lets
// airspaces_sectors.go tell an approach-only volume from an aerodrome one.
type Sae struct {
	Uid struct {
		Ser struct {
			Mid      int64  `xml:"mid,attr"`
			UniName  string `xml:"UniUid>txtName"`
			CodeType string `xml:"codeType"`
		} `xml:"SerUid"`
		AseUid struct {
			Mid int64 `xml:"mid,attr"`
		} `xml:"AseUid"`
	} `xml:"SaeUid"`
}

// Fqy is a radio frequency for a service, with multilingual call signs.
type Fqy struct {
	Uid struct {
		Ser struct {
			Mid int64 `xml:"mid,attr"`
		} `xml:"SerUid"`
		ValFreqTrans string `xml:"valFreqTrans"`
	} `xml:"FqyUid"`
	Cdl []struct {
		TxtCallSign string `xml:"txtCallSign"`
		CodeLang    string `xml:"codeLang"`
	} `xml:"Cdl"`
}

// airspacesSnapshot holds the decoded airspace elements plus the snapshot's
// effective date.
type airspacesSnapshot struct {
	effective string
	ases      []Ase
	abds      []Abd
	adgs      []Adg
	saes      []Sae
	fqys      []Fqy
}

// decodeAirspacesSnapshot streams the AIXM XML, decoding the four element
// types the airspace overlay needs and skipping every other top-level
// feature.
func decodeAirspacesSnapshot(src []byte) (airspacesSnapshot, error) {
	dec := xml.NewDecoder(bytes.NewReader(src))
	var snap airspacesSnapshot

	// Advance to the <AIXM-Snapshot> root and capture its effective date.
	for {
		tok, err := dec.Token()
		if err != nil {
			return snap, fmt.Errorf("reading XML: %w", err)
		}
		se, ok := tok.(xml.StartElement)
		if !ok {
			continue
		}
		if se.Name.Local != "AIXM-Snapshot" {
			return snap, fmt.Errorf("unexpected root element %q, want AIXM-Snapshot", se.Name.Local)
		}
		for _, a := range se.Attr {
			if a.Name.Local == "effective" {
				snap.effective = a.Value
			}
		}
		break
	}

	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return snap, fmt.Errorf("reading XML: %w", err)
		}
		se, ok := tok.(xml.StartElement)
		if !ok {
			continue
		}
		switch se.Name.Local {
		case "Ase":
			var v Ase
			if err := dec.DecodeElement(&v, &se); err != nil {
				return snap, fmt.Errorf("decoding Ase: %w", err)
			}
			snap.ases = append(snap.ases, v)
		case "Abd":
			var v Abd
			if err := dec.DecodeElement(&v, &se); err != nil {
				return snap, fmt.Errorf("decoding Abd: %w", err)
			}
			snap.abds = append(snap.abds, v)
		case "Adg":
			var v Adg
			if err := dec.DecodeElement(&v, &se); err != nil {
				return snap, fmt.Errorf("decoding Adg: %w", err)
			}
			snap.adgs = append(snap.adgs, v)
		case "Sae":
			var v Sae
			if err := dec.DecodeElement(&v, &se); err != nil {
				return snap, fmt.Errorf("decoding Sae: %w", err)
			}
			snap.saes = append(snap.saes, v)
		case "Fqy":
			var v Fqy
			if err := dec.DecodeElement(&v, &se); err != nil {
				return snap, fmt.Errorf("decoding Fqy: %w", err)
			}
			snap.fqys = append(snap.fqys, v)
		default:
			if err := dec.Skip(); err != nil {
				return snap, fmt.Errorf("skipping <%s>: %w", se.Name.Local, err)
			}
		}
	}
	return snap, nil
}
