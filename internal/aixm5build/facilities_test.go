package aixm5build

import (
	"reflect"
	"testing"
	"time"

	"github.com/0intro/loxodrome/internal/aixm5"
)

func facRow(t *testing.T, art FacilitiesArtifact, ident string) []any {
	t.Helper()
	for _, r := range art.Rows {
		row := r.([]any)
		if row[0].(string) == ident {
			return row
		}
	}
	t.Fatalf("no row for %s", ident)
	return nil
}

func pairs(col any) map[string]string {
	out := map[string]string{}
	for _, e := range col.([]any) {
		p := e.([]string)
		if _, dup := out[p[0]]; !dup {
			out[p[0]] = p[1]
		}
	}
	return out
}

func TestBuildFacilities(t *testing.T) {
	msg := &aixm5.Message{Airports: []aixm5.Airport{
		{
			// The DFS shape: everything typed, the schedule structured and
			// the condition stated in a timeInterval note beside it.
			Designator: "ED1587", Type: "HP",
			Hours: []string{"H24"},
			Notes: []aixm5.Note{
				{PropertyName: "ARP", Purpose: "REMARK", Text: "1.5 NM SE Bremen"},
				{PropertyName: "ARP", Purpose: "REMARK", Text: "State: Bremen"},
				{PropertyName: "type", Purpose: "REMARK", Text: "Heliport/Hospital"},
				{PropertyName: "timeInterval", Purpose: "REMARK", Text: "PPR"},
				{PropertyName: "usage", Purpose: "REMARK", Text: "HEMS only"},
				{PropertyName: "name", Purpose: "OTHER:TRANSLATION", Text: "ignored"},
			},
			Contacts: []aixm5.Contact{
				{Name: "STADT BREMEN", Address: "Contrescarpe 22", Phone: []string{"+49 421 30300"}},
				// ENAIRE files the same operator once per role.
				{Name: "STADT BREMEN", Address: "Contrescarpe 22"},
			},
		},
		{
			// The NATS shape: the site prose in airportLocation, the
			// equipment in its own properties, one untyped remark.
			Designator: "EGDP", Type: "HP",
			Notes: []aixm5.Note{
				{PropertyName: "airportLocation", Purpose: "DESCRIPTION", Text: "0.6 NM W of Portland Port."},
				{PropertyName: "windDirectionIndicator", Purpose: "DESCRIPTION", Text: "503406N (unlit)."},
				{PropertyName: "timeInterval", Purpose: "OTHER:AIXM45_MAPPING", Text: "Mon-Thu 0900-1600"},
				{PropertyName: "", Purpose: "OTHER:HELIPORT_TLOF_AREA_TYPE", Text: "Level surface."},
				{PropertyName: "", Purpose: "REMARK", Text: "Helicopters only."},
				{PropertyName: "somethingNew", Purpose: "REMARK", Text: "unrecognised"},
			},
			Contacts: []aixm5.Contact{{
				Email: []string{"ops@portland.test"},
				Web:   []string{"www.portland.test"},
			}},
		},
		// Annotated by nothing: no row at all, rather than an empty one.
		{Designator: "EGXX", Type: "AD"},
		// No designator: nothing to key a row on.
		{Name: "NAMELESS", Type: "AD"},
	}}

	art, meta, err := BuildFacilities(msg, "sample.xml", []byte("raw"), "2026-08-06", FacilitiesOptions{
		Country:       "TEST",
		Now:           func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) },
		MinAerodromes: 1,
		MaxAerodromes: 10,
	})
	if err != nil {
		t.Fatal(err)
	}

	idents := make([]string, 0, len(art.Rows))
	for _, r := range art.Rows {
		idents = append(idents, r.([]any)[0].(string))
	}
	if want := []string{"ED1587", "EGDP"}; !reflect.DeepEqual(idents, want) {
		t.Fatalf("idents = %v, want %v", idents, want)
	}
	if meta.HeliportCount != 2 || meta.AerodromeCount != 2 {
		t.Errorf("counts = %d aerodromes / %d heliports", meta.AerodromeCount, meta.HeliportCount)
	}
	// Exactly the one propertyName this file does not know; the
	// translations are a known no and are not counted.
	if meta.SkippedNotes != 1 {
		t.Errorf("SkippedNotes = %d, want 1", meta.SkippedNotes)
	}

	de := facRow(t, art, "ED1587")
	// Two ARP notes join rather than one overwriting the other.
	if de[2].(string) != "1.5 NM SE Bremen; State: Bremen" {
		t.Errorf("arp = %q", de[2])
	}
	// The structured schedule leads, the published condition follows.
	if de[3].(string) != "H24; PPR" {
		t.Errorf("hours = %q, want \"H24; PPR\"", de[3])
	}
	if got := pairs(de[8]); got["kind"] != "Heliport/Hospital" || got["usage"] != "HEMS only" {
		t.Errorf("directory = %v", got)
	}
	if n := len(de[7].([]any)); n != 2 {
		t.Errorf("contact entries = %d, want 2 (the repeated operator collapsed)", n)
	}

	uk := facRow(t, art, "EGDP")
	if uk[1].(string) != "0.6 NM W of Portland Port." {
		t.Errorf("site = %q", uk[1])
	}
	if uk[3].(string) != "Mon-Thu 0900-1600" {
		t.Errorf("hours = %q", uk[3])
	}
	dir := pairs(uk[8])
	// An untyped note is filed by its purpose where we know it, and as a
	// plain remark where the purpose is just REMARK.
	if dir["tlofType"] != "Level surface." || dir["remark"] != "Helicopters only." ||
		dir["windIndicator"] != "503406N (unlit)." {
		t.Errorf("directory = %v", dir)
	}
	if c := pairs(uk[7]); c["email"] != "ops@portland.test" || c["web"] != "www.portland.test" {
		t.Errorf("contact = %v", c)
	}
	// The AIXM 5.1 publishers have no equivalent of the France-only
	// columns, which stay at their absent values.
	if uk[4].(string) != "" || len(uk[5].([]any)) != 0 || len(uk[6].([]any)) != 0 {
		t.Errorf("fireCat / services / passenger should be empty: %v %v %v", uk[4], uk[5], uk[6])
	}
}

func TestBuildFacilitiesSanityWindow(t *testing.T) {
	msg := &aixm5.Message{Airports: []aixm5.Airport{
		{Designator: "EGAA", Notes: []aixm5.Note{{PropertyName: "usage", Text: "x"}}},
	}}
	_, _, err := BuildFacilities(msg, "s", nil, "", FacilitiesOptions{
		Country: "TEST", MinAerodromes: 50, MaxAerodromes: 100,
	})
	if err == nil {
		t.Error("expected a sanity-window error")
	}
}
