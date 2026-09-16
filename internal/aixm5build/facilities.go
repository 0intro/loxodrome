// facilities.go turns the AIP directory content of a decoded AIXM 5.1
// message into the row schema cmd/fr/facilities.go defines, so every
// publisher's <cc>-aerodrome-facilities.json reads through one loader and
// renders in one panel section.
//
// What the publishers actually annotate differs, and the propertyName on
// each note is what makes that tractable: DFS types nearly all of its
// (ARP / type / usage / timeInterval), NATS types most of its and leans on
// the purpose for the rest, and ENAIRE types only translations of the name
// and the served city, which we already have. So a note reaches the
// artefact only when this file recognises what it is; the rest are counted
// in the meta rather than guessed at, which is what keeps Spain honest
// (contacts and nothing else) without special-casing it.

package aixm5build

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/aixm5"
)

// facilitiesOutputFields mirrors cmd/fr/facilities.go's row layout.
var facilitiesOutputFields = []string{
	"ident", "site", "arp", "hours", "fireCat", "services", "passenger", "contact", "directory",
}

// facilityItemFields is the shape of each nested [cat, text] entry.
var facilityItemFields = []string{"cat", "text"}

// FacilitiesArtifact is the <cc>-aerodrome-facilities.json document.
type FacilitiesArtifact struct {
	Fields     []string `json:"fields"`
	ItemFields []string `json:"itemFields"`
	Rows       []any    `json:"rows"`
}

// FacilitiesMeta is the sidecar. SkippedNotes counts the annotations this
// file did not recognise: a publisher adding a propertyName shows up there
// rather than silently vanishing.
type FacilitiesMeta struct {
	GeneratedAt    string         `json:"generatedAt"`
	Source         string         `json:"source"`
	SourceSha256   string         `json:"sourceSha256"`
	Effective      string         `json:"effective"`
	AerodromeCount int            `json:"aerodromeCount"`
	HeliportCount  int            `json:"heliportCount"`
	SkippedNotes   int            `json:"skippedNotes"`
	Counts         map[string]int `json:"counts"`
}

// FacilitiesOptions configures BuildFacilities. Country labels the
// sanity-window error ("UK" / "ES" / "DE").
type FacilitiesOptions struct {
	Country       string
	Now           func() time.Time
	MinAerodromes int
	MaxAerodromes int
}

// noteColumn maps a note's propertyName onto one of the row's own text
// columns, where the AIP content belongs to a heading the schema already
// has.
var noteColumn = map[string]string{
	"airportLocation": "site",  // NATS: "0.6 NM W of Portland Port."
	"ARP":             "arp",   // DFS: the ARP site and its bearing from town
	"timeInterval":    "hours", // both: the operating-hours prose
}

// noteCategory maps a propertyName onto a directory-column category. The
// keys are the AIXM property the note annotates, so this is publisher-
// neutral even though each publisher uses a different subset.
var noteCategory = map[string]string{
	"type":                        "kind",             // DFS: "Heliport/Hospital"
	"usage":                       "usage",            // DFS: the traffic a field accepts
	"windDirectionIndicator":      "windIndicator",    // NATS
	"landingDirectionIndicator":   "landingIndicator", // NATS
	"secondaryPowerSupply":        "powerSupply",      // NATS + skeyes
	"altimeterCheckLocation":      "altimeterCheck",   // NATS
	"certificationExpirationDate": "certification",    // NATS
	// The skeyes AD 3.2 "Heliport Data" table, which states the physical
	// pad where the others state only how it may be used.
	"dimension":          "dimensions",
	"slope":              "slope",
	"surfaceComposition": "surface",
	"strength":           "strength",
	"arrivalRoute":       "arrivalRoutes",
}

// purposeCategory maps the purpose of an UNTYPED note, which is where NATS
// puts the one field the AIXM property list has no room for.
var purposeCategory = map[string]string{
	"OTHER:HELIPORT_TLOF_AREA_TYPE": "tlofType",
}

// noteIgnored are the propertyNames deliberately dropped: translations and
// coordinate restatements of columns the airport dataset already carries.
// They are not counted as skipped, being a known and permanent no.
var noteIgnored = map[string]bool{
	"name": true, "servedCity": true, "geoLat": true, "geoLong": true,
}

// directoryOrder is the emission order of the directory column, chosen to
// read as a description: what the field is, then how it may be used, then
// its equipment, then the free remark.
var directoryOrder = map[string]int{
	"kind": 0, "usage": 1, "dimensions": 2, "slope": 3, "surface": 4,
	"strength": 5, "tlofType": 6, "arrivalRoutes": 7, "windIndicator": 8,
	"landingIndicator": 9, "powerSupply": 10, "altimeterCheck": 11,
	"certification": 12, "remark": 13,
}

// contactOrder mirrors cmd/fr's, the operator first.
var contactOrder = map[string]int{"operator": 0, "phone": 1, "fax": 2, "email": 3, "web": 4}

type facItem struct{ cat, text string }

// BuildFacilities emits one row per aerodrome the message annotates.
func BuildFacilities(msg *aixm5.Message, source string, raw []byte, effective string, opts FacilitiesOptions) (FacilitiesArtifact, FacilitiesMeta, error) {
	now := opts.Now
	if now == nil {
		now = time.Now
	}

	counts := map[string]int{}
	skipped := 0
	heliports := 0
	rows := make([]any, 0, len(msg.Airports))
	type row struct {
		ident              string
		site, arp, hours   string
		contact, directory []facItem
		heliport           bool
	}
	built := make([]row, 0, len(msg.Airports))

	for i := range msg.Airports {
		a := &msg.Airports[i]
		ident := strings.TrimSpace(a.Designator)
		if ident == "" {
			continue
		}
		r := row{ident: ident, heliport: strings.EqualFold(a.Type, "HP")}

		var hourNotes []string
		seenDir := map[facItem]bool{}
		for _, n := range a.Notes {
			prop := strings.TrimSpace(n.PropertyName)
			text := strings.TrimSpace(n.Text)
			if text == "" || noteIgnored[prop] {
				continue
			}
			if col, ok := noteColumn[prop]; ok {
				switch col {
				case "site":
					r.site = appendText(r.site, text)
				case "arp":
					r.arp = appendText(r.arp, text)
				case "hours":
					hourNotes = append(hourNotes, text)
				}
				continue
			}
			cat, ok := noteCategory[prop]
			if !ok && prop == "" {
				cat, ok = purposeCategory[n.Purpose]
				if !ok {
					// An untyped remark is the publisher's general note:
					// DFS files its PPR / O/R conditions there.
					cat, ok = "remark", strings.EqualFold(n.Purpose, "REMARK")
				}
			}
			if !ok {
				skipped++
				continue
			}
			if it := (facItem{cat, text}); !seenDir[it] {
				seenDir[it] = true
				r.directory = append(r.directory, it)
				counts[cat]++
			}
		}

		// The structured schedule wins over the prose, which then rides
		// along as the condition it usually states ("H24" plus "PPR").
		r.hours = strings.Join(append(append([]string{}, a.Hours...), hourNotes...), "; ")

		// One aerodrome commonly carries several ContactInformation
		// blocks naming the same operator once per role (ENAIRE files
		// four for a helipad), so an entry already on the row is not
		// repeated.
		seen := map[facItem]bool{}
		add := func(cat, text string) {
			it := facItem{cat, strings.TrimSpace(text)}
			if it.text == "" || seen[it] {
				return
			}
			seen[it] = true
			r.contact = append(r.contact, it)
			counts[cat]++
		}
		for _, c := range a.Contacts {
			name := strings.TrimSpace(c.Name)
			if addr := strings.TrimSpace(c.Address); addr != "" {
				name = strings.TrimPrefix(strings.TrimSpace(name+", "+addr), ", ")
			}
			// A publisher filing the operator once per role gives the
			// address on some blocks and the bare name on others, so a
			// name that only restates a longer entry is the same operator
			// said twice ("SEVILLA" beside "SEVILLA, Aeropuerto de
			// Sevilla, 41020 Sevilla.").
			if name != "" {
				replaced := false
				for i, it := range r.contact {
					if it.cat != "operator" {
						continue
					}
					switch {
					case strings.HasPrefix(it.text, name):
						replaced = true
					case strings.HasPrefix(name, it.text):
						r.contact[i].text = name
						replaced = true
					}
					if replaced {
						break
					}
				}
				if replaced {
					name = ""
				}
			}
			add("operator", name)
			for _, pair := range []struct {
				cat  string
				vals []string
			}{{"phone", c.Phone}, {"fax", c.Fax}, {"email", c.Email}, {"web", c.Web}} {
				for _, v := range pair.vals {
					add(pair.cat, v)
				}
			}
		}

		if r.site == "" && r.arp == "" && r.hours == "" && len(r.contact) == 0 && len(r.directory) == 0 {
			continue
		}
		if r.heliport {
			heliports++
		}
		built = append(built, r)
	}

	sort.Slice(built, func(i, j int) bool { return built[i].ident < built[j].ident })
	for _, r := range built {
		sortItems(r.contact, contactOrder)
		sortItems(r.directory, directoryOrder)
		rows = append(rows, []any{
			r.ident, r.site, r.arp, r.hours, "",
			[]any{}, []any{}, itemsToAny(r.contact), itemsToAny(r.directory),
		})
	}

	if n := len(rows); n < opts.MinAerodromes || (opts.MaxAerodromes > 0 && n > opts.MaxAerodromes) {
		return FacilitiesArtifact{}, FacilitiesMeta{}, fmt.Errorf(
			"%s aerodrome-facilities count %d outside sanity window [%d, %d] - source format may have changed",
			opts.Country, n, opts.MinAerodromes, opts.MaxAerodromes)
	}

	sum := sha256.Sum256(raw)
	meta := FacilitiesMeta{
		GeneratedAt:    now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Source:         source,
		SourceSha256:   hex.EncodeToString(sum[:]),
		Effective:      effective,
		AerodromeCount: len(rows),
		HeliportCount:  heliports,
		SkippedNotes:   skipped,
		Counts:         counts,
	}
	return FacilitiesArtifact{
		Fields:     facilitiesOutputFields,
		ItemFields: facilityItemFields,
		Rows:       rows,
	}, meta, nil
}

// appendText joins two texts for the same column, keeping both: DFS files
// two ARP notes per aerodrome (the site, then the state it lies in).
func appendText(have, add string) string {
	if have == "" {
		return add
	}
	if strings.Contains(have, add) {
		return have
	}
	return have + "; " + add
}

func sortItems(items []facItem, order map[string]int) {
	sort.SliceStable(items, func(i, j int) bool {
		return order[items[i].cat] < order[items[j].cat]
	})
}

func itemsToAny(items []facItem) []any {
	out := make([]any, 0, len(items))
	for _, it := range items {
		out = append(out, []string{it.cat, it.text})
	}
	return out
}
