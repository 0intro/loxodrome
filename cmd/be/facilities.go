// facilities.go lifts the AIP directory rows off the skeyes AD 2 / AD 3
// pages the scrape already fetches, onto the same aixm5.Airport fields the
// AIXM 5.1 publishers fill, so internal/aixm5build/facilities.go emits
// be-aerodrome-facilities.json through one code path with the others.
//
// The AD 3 pages are the reason: skeyes publishes each helipad as a
// numbered "Heliport Data" table (dimensions, slope, surface, strength,
// arrival routes, operator, TEL / FAX / email, hours, remarks), which is
// the richest helipad directory of any publisher here and the only one
// that states a slope. The AD 2 pages carry a thinner version of the same
// idea, and the rows this file reads are the ones both kinds share.

package main

import (
	"github.com/0intro/loxodrome/internal/eaip"
	"strings"

	"github.com/0intro/loxodrome/internal/aixm5"
)

// facilityRow is one labelled row of an AD 2 / AD 3 table and where it
// lands. Prop is the AIXM propertyName the shared builder files it under,
// so a skeyes row and a DFS annotation reach the same panel heading; an
// empty Prop with a REMARK purpose is the builder's general-remark bucket.
var facilityRows = []struct {
	label string // uppercase prefix, as labelledPrefix matches
	prop  string
}{
	{"DIRECTION AND DISTANCE FROM", "airportLocation"},
	{"DIMENSIONS", "dimension"},
	{"SLOPE", "slope"},
	{"SURFACE", "surfaceComposition"},
	{"STRENGTH", "strength"},
	{"ARRIVAL ROUTES", "arrivalRoute"},
	{"SECONDARY POWER SUPPLY", "secondaryPowerSupply"},
	{"REMARKS", ""},
}

// parseFacilityDetail fills the AIP-directory fields of one aerodrome from
// its page. Absent rows simply contribute nothing: the AD 2 pages carry
// only a few of these, and a page with none produces no facilities row.
func parseFacilityDetail(doc *eaip.Node, ap *aixm5.Airport) {
	for _, r := range facilityRows {
		v := keepFacilityText(docLabelled(doc, r.label))
		if v == "" {
			continue
		}
		n := aixm5.Note{PropertyName: r.prop, Text: v}
		if r.prop == "" {
			n.Purpose = "REMARK"
		}
		ap.Notes = append(ap.Notes, n)
	}
	if v := keepFacilityText(docLabelled(doc, "OPERATIONAL HOURS")); v != "" {
		ap.Hours = append(ap.Hours, v)
	}

	// The operator block: skeyes prints the name and its postal address in
	// one cell on AD 3 ("Algemeen Ziekenhuis Delta (AZ Delta) VZW,
	// Deltalaan 1, 8800 Roeselare, BELGIUM"), and names it differently on
	// AD 2.
	c := aixm5.Contact{Name: keepFacilityText(docLabelled(doc, "OPERATOR"))}
	if c.Name == "" {
		c.Name = keepFacilityText(docLabelled(doc, "NAME OF AD OPERATOR"))
	}
	if v := keepFacilityText(docLabelled(doc, "TEL")); v != "" {
		c.Phone = append(c.Phone, v)
	}
	if v := keepFacilityText(docLabelled(doc, "FAX")); v != "" {
		c.Fax = append(c.Fax, v)
	}
	if v := keepFacilityText(docLabelled(doc, "EMAIL")); v != "" {
		c.Email = append(c.Email, v)
	}
	if c.Name != "" || len(c.Phone) > 0 || len(c.Fax) > 0 || len(c.Email) > 0 {
		ap.Contacts = append(ap.Contacts, c)
	}
}

// keepFacilityText drops the placeholders skeyes prints for an absent row,
// so the panel shows nothing rather than the word "NIL".
func keepFacilityText(s string) string {
	t := strings.Join(strings.Fields(s), " ")
	switch strings.ToUpper(strings.TrimRight(t, ". ")) {
	case "", "NIL", "NONE", "N/A", "INFO NOT AVBL", "NOT AVBL":
		return ""
	}
	return t
}
