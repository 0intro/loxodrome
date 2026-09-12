// helistations_parse.go decodes the <Helistation> block of the SIA proprietary
// XML (XML_SIA_*.xml, the second file in the boutique export). It is the AIP's
// AD 1.3-2 "Répertoire des hélistations" as structured data, and the only place
// the operator, operating hours, FATO / TLOF dimensions, surface, strength,
// fire cover, lighting and the free-text remark of a helipad are published: the
// AIXM 4.5 half of the same export carries the position and the FATO geometry
// and nothing else.
//
// One streaming pass, every other element skipped. The file ships as
// ISO-8859-1, so the decoder borrows airspaces_sia.go's newCharsetReader.

package main

import (
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
)

// siaHelistation is one <Helistation> record. Nom is the join key: it equals
// the AIXM Ahp txtName exactly, for all 275 records in both directions
// (verified on the 2026-08-06 export), so no normalisation is needed.
//
// Statut / Nuit / EnTerrasse / ZoneHabitee are CODED values, kept as codes for
// the SPA to label; every other field is AIP free text carried verbatim, the
// '#' line separators included (formatAipRemark renders them).
type siaHelistation struct {
	Nom         string `xml:"Nom"`
	Statut      string `xml:"Statut"`      // TPD / RST / ADM
	SousCat     string `xml:"SousCat"`     // HB
	ClassePerf  string `xml:"ClassePerf"`  // 1 / 2 / 3
	HelRef      string `xml:"HelRef"`      // reference helicopter type, "EC 145"
	Nuit        string `xml:"Nuit"`        // oui / non
	EnTerrasse  string `xml:"EnTerrasse"`  // oui / non
	ZoneHabitee string `xml:"ZoneHabitee"` // hostile habitée / hostile non habitée / non hostile
	HauteurFt   string `xml:"HauteurFt"`
	DimFato     string `xml:"DimFato"`
	DimTlof     string `xml:"DimTlof"`
	Revetement  string `xml:"Revetement"`
	Resistance  string `xml:"Resistance"`
	HorTxt      string `xml:"HorTxt"`
	Sslia       string `xml:"Sslia"`
	Balisage    string `xml:"Balisage"`
	Exploitant  string `xml:"Exploitant"`
	Remarque    string `xml:"Remarque"`
}

// parseHelistations streams the SIA XML and returns its <Helistation> records
// in document order. An empty source yields no records and no error: the SIA
// file is optional on the cmd/fr command line, and the facilities dataset still
// builds from the AIXM alone.
func parseHelistations(src []byte) ([]siaHelistation, error) {
	if len(src) == 0 {
		return nil, nil
	}
	dec := xml.NewDecoder(bytes.NewReader(src))
	dec.CharsetReader = newCharsetReader
	var out []siaHelistation
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("reading SIA XML: %w", err)
		}
		se, ok := tok.(xml.StartElement)
		if !ok || se.Name.Local != "Helistation" {
			continue
		}
		var h siaHelistation
		if err := dec.DecodeElement(&h, &se); err != nil {
			return nil, fmt.Errorf("decoding Helistation: %w", err)
		}
		out = append(out, h)
	}
	return out, nil
}
