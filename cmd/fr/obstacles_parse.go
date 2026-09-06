// obstacles_parse.go decodes the Obs element of an AIXM 4.5 snapshot.
// Streams the document so the ~280 MB SIA export never fully materialises.

package main

import (
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
)

// Obs is a single obstacle. Only the fields the overlay uses are decoded;
// the rest of the element is ignored by encoding/xml.
type Obs struct {
	Uid struct {
		Mid     int64  `xml:"mid,attr"`
		GeoLat  string `xml:"geoLat"`
		GeoLong string `xml:"geoLong"`
	} `xml:"ObsUid"`
	TxtName      string `xml:"txtName"`
	TxtDescrType string `xml:"txtDescrType"`
	// CodeGroup: Y when this obstacle is one of several at one site, N
	// when it stands alone. Kept verbatim so the SPA can badge clusters.
	CodeGroup string `xml:"codeGroup"`
	// CodeLgt: Y if lit, N otherwise.
	CodeLgt     string `xml:"codeLgt"`
	TxtDescrLgt string `xml:"txtDescrLgt"`
	// ValElev: elevation in feet AMSL (uomDistVer always FT in SIA).
	ValElev    string `xml:"valElev"`
	ValHgt     string `xml:"valHgt"`
	UomDistVer string `xml:"uomDistVer"`
	// TxtRmk is the obstacle remark. Since BMJ 08/2025 SIA emits new / updated
	// obstacle remarks bilingually as "French\\English" (two-backslash
	// separator); the SPA localises it. Emitted verbatim, like the airspace
	// remark (airspaces.go aseRow).
	TxtRmk string `xml:"txtRmk"`
}

// obstaclesSnapshot holds the decoded obstacles plus the snapshot's
// effective date.
type obstaclesSnapshot struct {
	effective string
	obs       []Obs
}

// decodeObstaclesSnapshot streams the AIXM XML and decodes only Obs
// elements.
func decodeObstaclesSnapshot(src []byte) (obstaclesSnapshot, error) {
	dec := xml.NewDecoder(bytes.NewReader(src))
	var snap obstaclesSnapshot

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
		if se.Name.Local != "Obs" {
			if err := dec.Skip(); err != nil {
				return snap, fmt.Errorf("skipping <%s>: %w", se.Name.Local, err)
			}
			continue
		}
		var v Obs
		if err := dec.DecodeElement(&v, &se); err != nil {
			return snap, fmt.Errorf("decoding Obs: %w", err)
		}
		snap.obs = append(snap.obs, v)
	}
	return snap, nil
}
