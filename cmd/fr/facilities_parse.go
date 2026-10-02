// facilities_parse.go decodes the AIXM 4.5 AD-2 aerodrome-directory elements:
// the Ahp header (situation / ARP / operating-hours remark), Ahs (handling and
// emergency services), Pfy (passenger facilities) and Aha (operator contact).
// One streaming pass; every other feature is skipped. Each facility links to
// its aerodrome by AhpUid > codeId, resolved to ICAO through the Ahp headers.

package main

import (
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
)

// aixmAhpHdr is the slice of the Ahp header the facilities dataset needs: the
// codeId linker, the ICAO, and the three AD-2 free-text fields. Working hours
// sit in a nested <Aht> the same way airspaces nest <Att>.
type aixmAhpHdr struct {
	Uid struct {
		CodeId string `xml:"codeId"`
	} `xml:"AhpUid"`
	CodeIcao string `xml:"codeIcao"`
	// TxtName / CodeType; not AD-2 content, but the join to the SIA
	// proprietary XML's <Helistation> directory, which keys by name and
	// covers the codeType HP records (see helistations.go).
	TxtName       string `xml:"txtName"`
	CodeType      string `xml:"codeType"`
	TxtDescrRefPt string `xml:"txtDescrRefPt"` // ARP description (also the fictive-AFS marker)
	TxtDescrSite  string `xml:"txtDescrSite"`  // situation (AD 2.2)
	TxtRmkWorkHr  string `xml:"Aht>txtRmkWorkHr"`
}

// aixmAhs is one handling / service record (AD 2.4 / 2.6 / 2.7). codeType is
// the service kind (FUEL / FIRE / HANGAR / ...); FIRE carries the RFFS codeCat.
// The description lives in txtDescrFac, with the service-time remark (nested in
// <Ast>) and the general remark as fallbacks.
type aixmAhs struct {
	Uid struct {
		Ahp struct {
			CodeId string `xml:"codeId"`
		} `xml:"AhpUid"`
		CodeType string `xml:"codeType"`
	} `xml:"AhsUid"`
	CodeCat      string `xml:"codeCat"` // A1-A10 / H1-H2 on FIRE
	TxtDescrFac  string `xml:"txtDescrFac"`
	TxtRmkWorkHr string `xml:"Ast>txtRmkWorkHr"`
	TxtRmk       string `xml:"txtRmk"`
}

// aixmPfy is one passenger-facility record (AD 2.5): restaurant, transport,
// hotels, medical, bank, tourist info, post.
type aixmPfy struct {
	Uid struct {
		Ahp struct {
			CodeId string `xml:"codeId"`
		} `xml:"AhpUid"`
		CodeType string `xml:"codeType"`
	} `xml:"PfyUid"`
	TxtDescr string `xml:"txtDescr"`
	TxtRmk   string `xml:"txtRmk"`
}

// aixmAha is one operator-contact record (AD 2.2): phone, postal address, AFS,
// fax, email, telex, SITA. The value is language-neutral.
type aixmAha struct {
	Uid struct {
		Ahp struct {
			CodeId string `xml:"codeId"`
		} `xml:"AhpUid"`
		CodeType string `xml:"codeType"`
	} `xml:"AhaUid"`
	TxtAddress string `xml:"txtAddress"`
}

// facilitiesSnapshot bundles the decoded AD-2 streams plus the effective date.
type facilitiesSnapshot struct {
	effective string
	ahps      []aixmAhpHdr
	ahss      []aixmAhs
	pfys      []aixmPfy
	ahas      []aixmAha
}

// decodeFacilitiesSnapshot streams the AIXM XML, decoding the four AD-2
// element types the facilities overlay needs and skipping every other feature.
func decodeFacilitiesSnapshot(src []byte) (facilitiesSnapshot, error) {
	dec := xml.NewDecoder(bytes.NewReader(src))
	var snap facilitiesSnapshot

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
		case "Ahp":
			var v aixmAhpHdr
			if err := dec.DecodeElement(&v, &se); err != nil {
				return snap, fmt.Errorf("decoding Ahp: %w", err)
			}
			snap.ahps = append(snap.ahps, v)
		case "Ahs":
			var v aixmAhs
			if err := dec.DecodeElement(&v, &se); err != nil {
				return snap, fmt.Errorf("decoding Ahs: %w", err)
			}
			snap.ahss = append(snap.ahss, v)
		case "Pfy":
			var v aixmPfy
			if err := dec.DecodeElement(&v, &se); err != nil {
				return snap, fmt.Errorf("decoding Pfy: %w", err)
			}
			snap.pfys = append(snap.pfys, v)
		case "Aha":
			var v aixmAha
			if err := dec.DecodeElement(&v, &se); err != nil {
				return snap, fmt.Errorf("decoding Aha: %w", err)
			}
			snap.ahas = append(snap.ahas, v)
		default:
			if err := dec.Skip(); err != nil {
				return snap, fmt.Errorf("skipping <%s>: %w", se.Name.Local, err)
			}
		}
	}
	return snap, nil
}
