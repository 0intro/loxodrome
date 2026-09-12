// navaids_parse.go decodes the AIXM 4.5 navaid elements: Vor (VHF
// omni-directional ranges), Dme (distance measuring equipment), Ndb
// (non-directional beacons), Tcn (TACANs), and Dpn (designated
// points / 5LNC waypoints). One streaming pass over the AIXM
// snapshot; everything else is skipped.

package main

import (
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
)

// aixmVor; standalone VOR record (codeId is the navaid ICAO identifier).
type aixmVor struct {
	Uid struct {
		Mid     int64  `xml:"mid,attr"`
		CodeId  string `xml:"codeId"`
		GeoLat  string `xml:"geoLat"`
		GeoLong string `xml:"geoLong"`
	} `xml:"VorUid"`
	TxtName    string `xml:"txtName"`
	CodeType   string `xml:"codeType"` // "VOR" or "DVOR"
	ValFreq    string `xml:"valFreq"`
	UomFreq    string `xml:"uomFreq"`
	ValElev    string `xml:"valElev"`
	UomDistVer string `xml:"uomDistVer"`
}

// aixmNdb; non-directional beacon (LF/MF). codeId is 2-3 letter ICAO.
type aixmNdb struct {
	Uid struct {
		Mid     int64  `xml:"mid,attr"`
		CodeId  string `xml:"codeId"`
		GeoLat  string `xml:"geoLat"`
		GeoLong string `xml:"geoLong"`
	} `xml:"NdbUid"`
	TxtName    string `xml:"txtName"`
	ValFreq    string `xml:"valFreq"`
	UomFreq    string `xml:"uomFreq"`
	ValElev    string `xml:"valElev"`
	UomDistVer string `xml:"uomDistVer"`
}

// aixmDme; distance measuring equipment. France's AIXM embeds a VorUid
// reference for VOR-paired DMEs (the common case); standalone DMEs
// (rare) leave VorUid empty.
type aixmDme struct {
	Uid struct {
		Mid     int64  `xml:"mid,attr"`
		CodeId  string `xml:"codeId"`
		GeoLat  string `xml:"geoLat"`
		GeoLong string `xml:"geoLong"`
	} `xml:"DmeUid"`
	// VorUid is present on VOR-paired DMEs; the codeId references the
	// companion VOR. Used to fold the DME into a VOR-DME row.
	VorUid *struct {
		CodeId string `xml:"codeId"`
	} `xml:"VorUid"`
	TxtName      string `xml:"txtName"`
	CodeChannel  string `xml:"codeChannel"`  // e.g. "103X" (TACAN-style channel)
	ValGhostFreq string `xml:"valGhostFreq"` // pseudo-VHF freq of the paired VOR
	UomGhostFreq string `xml:"uomGhostFreq"`
	ValElev      string `xml:"valElev"`
	UomDistVer   string `xml:"uomDistVer"`
}

// aixmTcn; TACAN. Distinguished from a co-located VOR by the codeId
// scope (TCN at military fields; the rare civilian TACAN pairs with
// a VOR for VORTAC).
type aixmTcn struct {
	Uid struct {
		Mid     int64  `xml:"mid,attr"`
		CodeId  string `xml:"codeId"`
		GeoLat  string `xml:"geoLat"`
		GeoLong string `xml:"geoLong"`
	} `xml:"TcnUid"`
	TxtName     string `xml:"txtName"`
	CodeChannel string `xml:"codeChannel"`
	ValElev     string `xml:"valElev"`
	UomDistVer  string `xml:"uomDistVer"`
}

// aixmDpn; designated point / 5LNC waypoint. codeType is "ICAO" for
// standard 5-letter ICAO waypoints; other values mark named points
// (VOR co-locations, runway thresholds, etc.) we currently treat as
// generic waypoints.
type aixmDpn struct {
	Uid struct {
		Mid     int64  `xml:"mid,attr"`
		CodeId  string `xml:"codeId"`
		GeoLat  string `xml:"geoLat"`
		GeoLong string `xml:"geoLong"`
	} `xml:"DpnUid"`
	TxtName  string `xml:"txtName"`
	CodeType string `xml:"codeType"` // ICAO / COORD / ...
}

// aixmRwyDesig is the runway an Ils / Mkr serves, reached through the
// IlsUid > RdnUid > RwyUid > AhpUid chain: the aerodrome codeId and the
// two txtDesig (runway pair "05/23", then the served direction "05")
// name the aid.
type aixmRwyDesig struct {
	Rdn struct {
		Rwy struct {
			Ahp struct {
				CodeId string `xml:"codeId"`
			} `xml:"AhpUid"`
			TxtDesig string `xml:"txtDesig"` // "05/23"
		} `xml:"RwyUid"`
		TxtDesig string `xml:"txtDesig"` // "05"
	} `xml:"RdnUid"`
}

// aixmIls; instrument landing system. The Ilz localizer carries the
// ident, frequency and position; the Igp glidepath's presence separates
// a full ILS from a localizer-only approach (LOC); a co-located DmeUid
// makes it an ILS-DME. IlsUid names the served runway.
type aixmIls struct {
	Uid struct {
		Mid string `xml:"mid,attr"`
		aixmRwyDesig
	} `xml:"IlsUid"`
	// DmeUid marks a co-located DME (ILS-DME).
	DmeUid *struct {
		CodeId string `xml:"codeId"`
	} `xml:"DmeUid"`
	Ilz struct {
		CodeId     string `xml:"codeId"`
		ValFreq    string `xml:"valFreq"`
		UomFreq    string `xml:"uomFreq"`
		GeoLat     string `xml:"geoLat"`
		GeoLong    string `xml:"geoLong"`
		ValElev    string `xml:"valElev"`
		UomDistVer string `xml:"uomDistVer"`
	} `xml:"Ilz"`
	// Igp is the glidepath; absent for a localizer-only (LOC) approach.
	Igp *struct {
		ValFreq string `xml:"valFreq"`
	} `xml:"Igp"`
}

// aixmMkr; ILS marker beacon (outer / middle / inner). codePsnIls gives
// the position (O / M / I); the served runway comes from IlsUid.
type aixmMkr struct {
	Uid struct {
		Mid     string `xml:"mid,attr"`
		CodeId  string `xml:"codeId"`
		GeoLat  string `xml:"geoLat"`
		GeoLong string `xml:"geoLong"`
	} `xml:"MkrUid"`
	Ils        aixmRwyDesig `xml:"IlsUid"`
	CodePsnIls string       `xml:"codePsnIls"` // O / M / I
	ValFreq    string       `xml:"valFreq"`
	UomFreq    string       `xml:"uomFreq"`
}

// navaidsSnapshot bundles the decoded navaid streams plus the AIXM
// effective date.
type navaidsSnapshot struct {
	effective string
	vors      []aixmVor
	dmes      []aixmDme
	ndbs      []aixmNdb
	tcns      []aixmTcn
	dpns      []aixmDpn
	ilss      []aixmIls
	mkrs      []aixmMkr
}

// decodeNavaidsSnapshot streams the AIXM XML and decodes only the
// navaid elements. Other features (Ase, Abd, Obs, Ahp, ...) are
// skipped.
func decodeNavaidsSnapshot(src []byte) (navaidsSnapshot, error) {
	dec := xml.NewDecoder(bytes.NewReader(src))
	var snap navaidsSnapshot

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
		case "Vor":
			var v aixmVor
			if err := dec.DecodeElement(&v, &se); err != nil {
				return snap, fmt.Errorf("decoding Vor: %w", err)
			}
			snap.vors = append(snap.vors, v)
		case "Dme":
			var v aixmDme
			if err := dec.DecodeElement(&v, &se); err != nil {
				return snap, fmt.Errorf("decoding Dme: %w", err)
			}
			snap.dmes = append(snap.dmes, v)
		case "Ndb":
			var v aixmNdb
			if err := dec.DecodeElement(&v, &se); err != nil {
				return snap, fmt.Errorf("decoding Ndb: %w", err)
			}
			snap.ndbs = append(snap.ndbs, v)
		case "Tcn":
			var v aixmTcn
			if err := dec.DecodeElement(&v, &se); err != nil {
				return snap, fmt.Errorf("decoding Tcn: %w", err)
			}
			snap.tcns = append(snap.tcns, v)
		case "Dpn":
			var v aixmDpn
			if err := dec.DecodeElement(&v, &se); err != nil {
				return snap, fmt.Errorf("decoding Dpn: %w", err)
			}
			snap.dpns = append(snap.dpns, v)
		case "Ils":
			var v aixmIls
			if err := dec.DecodeElement(&v, &se); err != nil {
				return snap, fmt.Errorf("decoding Ils: %w", err)
			}
			snap.ilss = append(snap.ilss, v)
		case "Mkr":
			var v aixmMkr
			if err := dec.DecodeElement(&v, &se); err != nil {
				return snap, fmt.Errorf("decoding Mkr: %w", err)
			}
			snap.mkrs = append(snap.mkrs, v)
		default:
			if err := dec.Skip(); err != nil {
				return snap, fmt.Errorf("skipping <%s>: %w", se.Name.Local, err)
			}
		}
	}
	return snap, nil
}
