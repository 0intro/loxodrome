// facilities.go produces fr-aerodrome-facilities.json from the AIXM 4.5 AD-2
// entities (Ahp header + Ahs / Pfy / Aha). One record per ICAO aerodrome that
// has any AD-2 content: the situation / ARP / operating-hours header strings
// plus category-tagged handling services, passenger facilities and operator
// contacts. Bilingual "French\\English" strings are emitted verbatim; the SPA
// splits them (formatAipRemark) per the AIP-remark language preference. NIL /
// empty entries are dropped.

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
	"time"
)

const (
	// Observed: ~350-450 aerodromes carry AD-2 content (the metropole plus the
	// larger overseas fields), and ~275 helipads their AD 1.3-2 directory.
	// The floor sits above the AD-2 half alone, so losing the proprietary
	// XML (or its <Helistation> block) fails the build instead of quietly
	// shipping a France whose helipads describe nothing. The ceiling stays
	// wide enough for normal cycle drift.
	defaultMinFacilities = 400
	defaultMaxFacilities = 1200
)

// facilitiesOutputFields is the positional row layout of
// fr-aerodrome-facilities.json.
//
//	ident:     ICAO
//	site:      situation, txtDescrSite (bilingual)
//	arp:       ARP reference-point description, txtDescrRefPt (bilingual)
//	hours:     operating-hours remark, Ahp Aht>txtRmkWorkHr (bilingual)
//	fireCat:   RFFS category ("7" / "H1"), or ""
//	services:  [][cat, text] handling / emergency services (Ahs)
//	passenger: [][cat, text] passenger facilities (Pfy)
//	contact:   [][cat, value] operator contacts (Aha)
//	directory: [][cat, text] the AIP directory items with no column of
//	           their own (the SIA <Helistation> block; the AIXM publishers'
//	           typed annotations)
//	fuel:      the AD 2.4 FUEL service, whole: ["yes"|"no", text], or null
//	           where the AIP files no such record. See fuelColumn.
var facilitiesOutputFields = []string{
	"ident", "site", "arp", "hours", "fireCat", "services", "passenger", "contact", "directory", "fuel",
}

// facilityItemFields is the shape of each nested services / passenger / contact
// entry.
var facilityItemFields = []string{"cat", "text"}

// FacilitiesArtifact is the fr-aerodrome-facilities.json document.
type FacilitiesArtifact struct {
	Fields     []string `json:"fields"`
	ItemFields []string `json:"itemFields"`
	Rows       []any    `json:"rows"`
}

// FacilitiesMeta is the fr-aerodrome-facilities.meta.json document.
type FacilitiesMeta struct {
	GeneratedAt    string `json:"generatedAt"`
	Source         string `json:"source"`
	SourceSha256   string `json:"sourceSha256"`
	Effective      string `json:"effective"`
	AerodromeCount int    `json:"aerodromeCount"`
	// HeliportCount; rows carrying the SIA helipad directory (AD 1.3-2).
	HeliportCount int            `json:"heliportCount"`
	Counts        map[string]int `json:"counts"` // per-category item counts
}

// FacilitiesOptions configures BuildAerodromeFacilities.
type FacilitiesOptions struct {
	Source string
	// SIASource; the proprietary XML_SIA_*.xml of the same export, which
	// carries the <Helistation> directory. Optional: without it the dataset
	// is the AD 2 half alone.
	SIASource     []byte
	Now           func() time.Time // overridable for tests
	MinAerodromes int              // sanity window; 0 uses the default
	MaxAerodromes int
}

// Category normalisation: SIA codeType -> the language-neutral code the SPA
// labels. Unknown codeTypes collapse to "other".
var (
	ahsCatMap = map[string]string{
		"FUEL": "fuel", "FIRE": "fire", "HANGAR": "hangar", "REPAIR": "repair",
		"DEICE": "deice", "CLEAR": "clear", "HAND": "handling", "SECUR": "security",
		"CUST": "customs", "SAN": "health", "OTHER": "other",
	}
	pfyCatMap = map[string]string{
		"REST": "restaurant", "TRANS": "transport", "HOTEL": "hotel", "MEDIC": "medical",
		"BANK": "bank", "INFO": "info", "POST": "post", "OTHER": "other",
	}
	ahaCatMap = map[string]string{
		"PHONE": "phone", "POST": "postal", "AFS": "afs", "FAX": "fax",
		"EMAIL": "email", "TLX": "telex", "SITA": "sita", "OTHER": "other",
	}
	// Fixed display order per section, for diff-stable output. "lighting"
	// and "operator" have no AIXM codeType: they are the SIA helipad
	// directory's Balisage and Exploitant (see helistations.go).
	ahsOrder = map[string]int{"fuel": 0, "handling": 1, "fire": 2, "lighting": 3, "hangar": 4, "repair": 5, "deice": 6, "clear": 7, "security": 8, "customs": 9, "health": 10, "other": 11}
	pfyOrder = map[string]int{"restaurant": 0, "transport": 1, "hotel": 2, "medical": 3, "bank": 4, "info": 5, "post": 6, "other": 7}
	ahaOrder = map[string]int{"operator": 0, "phone": 1, "fax": 2, "email": 3, "telex": 4, "sita": 5, "afs": 6, "postal": 7, "other": 8}
)

// facItem is one [cat, text] entry.
type facItem struct{ cat, text string }

// facRec accumulates one aerodrome's AD-2 content, plus the AD 1.3-2 helipad
// directory when the SIA publishes one for it.
type facRec struct {
	site, arp, hours, fireCat               string
	services, passenger, contact, directory []facItem
	fuel                                    *fuelEntry
}

// fuelEntry is the AD 2.4 FUEL service as the `fuel` column carries it.
//
// The services list beside it keeps showing the AIP directory as published,
// one field per item, unchanged. This column exists because that rendering
// answers a different question: cmd/fuel reads it to type the grades, and
// for that it needs the WHOLE record rather than the first of its fields
// that happens to be non-empty, and it needs the records that say NIL,
// which the directory drops as an absent facility.
//
// The NIL ones are not noise. The AIP stating a field is dry is worth as
// much to a pilot as a grade list, and 22 of the 29 such records are
// overseas, where no VAC plate exists to say it instead.
type fuelEntry struct {
	avail string // "yes" | "no"
	text  string
}

func (r *facRec) empty() bool {
	return r.site == "" && r.arp == "" && r.hours == "" && r.fireCat == "" &&
		len(r.services) == 0 && len(r.passenger) == 0 && len(r.contact) == 0 &&
		len(r.directory) == 0 && r.fuel == nil
}

// BuildAerodromeFacilities decodes the AIXM source and produces the AD-2
// facilities artefact + meta, one row per ICAO aerodrome with content.
func BuildAerodromeFacilities(src []byte, opts FacilitiesOptions) (FacilitiesArtifact, FacilitiesMeta, error) {
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	minN, maxN := opts.MinAerodromes, opts.MaxAerodromes
	if minN == 0 {
		minN = defaultMinFacilities
	}
	if maxN == 0 {
		maxN = defaultMaxFacilities
	}

	snap, err := decodeFacilitiesSnapshot(src)
	if err != nil {
		return FacilitiesArtifact{}, FacilitiesMeta{}, err
	}

	// Index the Ahp headers: codeId -> ICAO linker, plus the per-ICAO record
	// seeded with the header's situation / ARP / hours. Fictive AFS
	// pseudo-aerodromes (marked in txtDescrRefPt) and ICAO-less rows are skipped,
	// matching cmd/fr/airports.go's indexAhps.
	recs := make(map[string]*facRec)
	icaoByCodeId := make(map[string]string)
	// Helipad name -> ident, for the SIA <Helistation> join. It spans the
	// ICAO-less rows too, whose ident is their codeId (airports.go's rule),
	// which is nearly every helipad.
	identByHelName := make(map[string]string)
	for i := range snap.ahps {
		a := &snap.ahps[i]
		if strings.Contains(strings.ToLower(a.TxtDescrRefPt), "fictive airport only used for afs") {
			continue
		}
		icao := strings.TrimSpace(a.CodeIcao)
		if strings.EqualFold(strings.TrimSpace(a.CodeType), "HP") {
			ident := icao
			if ident == "" {
				ident = strings.TrimSpace(a.Uid.CodeId)
			}
			if name := strings.TrimSpace(a.TxtName); name != "" && ident != "" {
				identByHelName[name] = ident
			}
		}
		if icao == "" {
			continue
		}
		icaoByCodeId[strings.TrimSpace(a.Uid.CodeId)] = icao
		r := recs[icao]
		if r == nil {
			r = &facRec{}
			recs[icao] = r
		}
		r.site = keepText(a.TxtDescrSite)
		r.arp = keepText(a.TxtDescrRefPt)
		r.hours = keepText(a.TxtRmkWorkHr)
	}

	counts := make(map[string]int)

	for i := range snap.ahss {
		s := &snap.ahss[i]
		r := recs[icaoByCodeId[strings.TrimSpace(s.Uid.Ahp.CodeId)]]
		if r == nil {
			continue
		}
		cat := normCat(ahsCatMap, s.Uid.CodeType)
		if cat == "fire" {
			if fc := normFireCat(s.CodeCat); fc != "" {
				r.fireCat = fc
			}
		}
		if cat == "fuel" {
			// One record per aerodrome on every cycle so far, but the AIXM
			// does not forbid two (a field with two suppliers could file
			// one each). Overwriting would drop the first without a trace,
			// so they accumulate.
			r.fuel = addFuel(r.fuel, fuelColumn(s.TxtDescrFac, s.TxtRmkWorkHr, s.TxtRmk))
		}
		if text := firstText(s.TxtDescrFac, s.TxtRmkWorkHr, s.TxtRmk); text != "" {
			r.services = append(r.services, facItem{cat, text})
			counts[cat]++
		}
	}

	for i := range snap.pfys {
		p := &snap.pfys[i]
		r := recs[icaoByCodeId[strings.TrimSpace(p.Uid.Ahp.CodeId)]]
		if r == nil {
			continue
		}
		if text := firstText(p.TxtDescr, p.TxtRmk); text != "" {
			cat := normCat(pfyCatMap, p.Uid.CodeType)
			r.passenger = append(r.passenger, facItem{cat, text})
			counts[cat]++
		}
	}

	for i := range snap.ahas {
		a := &snap.ahas[i]
		r := recs[icaoByCodeId[strings.TrimSpace(a.Uid.Ahp.CodeId)]]
		if r == nil {
			continue
		}
		if text := keepText(a.TxtAddress); text != "" {
			cat := normCat(ahaCatMap, a.Uid.CodeType)
			r.contact = append(r.contact, facItem{cat, text})
			counts[cat]++
		}
	}

	// The helipad directory lives in the proprietary XML, not the AIXM.
	hels, err := parseHelistations(opts.SIASource)
	if err != nil {
		return FacilitiesArtifact{}, FacilitiesMeta{}, err
	}
	heliportCount := applyHelistations(recs, identByHelName, hels, counts)

	// Emit one row per aerodrome with content, ident-sorted for a stable diff.
	idents := make([]string, 0, len(recs))
	for icao, r := range recs {
		if !r.empty() {
			idents = append(idents, icao)
		}
	}
	sort.Strings(idents)

	rows := make([]any, 0, len(idents))
	for _, icao := range idents {
		r := recs[icao]
		sortItems(r.services, ahsOrder)
		sortItems(r.passenger, pfyOrder)
		sortItems(r.contact, ahaOrder)
		sortItems(r.directory, helOrder)
		rows = append(rows, []any{
			icao, r.site, r.arp, r.hours, r.fireCat,
			itemsToAny(r.services), itemsToAny(r.passenger), itemsToAny(r.contact),
			itemsToAny(r.directory), fuelToAny(r.fuel),
		})
	}

	if n := len(rows); n < minN || n > maxN {
		return FacilitiesArtifact{}, FacilitiesMeta{}, fmt.Errorf(
			"aerodrome-facilities count %d outside sanity window [%d, %d] - source format may have changed",
			n, minN, maxN)
	}

	sum := sha256.Sum256(src)
	meta := FacilitiesMeta{
		GeneratedAt:    now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Source:         opts.Source,
		SourceSha256:   hex.EncodeToString(sum[:]),
		Effective:      snap.effective,
		AerodromeCount: len(rows),
		HeliportCount:  heliportCount,
		Counts:         counts,
	}
	return FacilitiesArtifact{Fields: facilitiesOutputFields, ItemFields: facilityItemFields, Rows: rows}, meta, nil
}

// normCat maps a SIA codeType to its language-neutral code, defaulting to
// "other" for anything unrecognised.
func normCat(m map[string]string, raw string) string {
	if c, ok := m[strings.ToUpper(strings.TrimSpace(raw))]; ok {
		return c
	}
	return "other"
}

// normFireCat turns the RFFS codeCat into a display token: "A7" -> "7" (the
// aeroplane fire category), "H1" -> "H1" (helicopter), else the trimmed value.
func normFireCat(raw string) string {
	c := strings.ToUpper(strings.TrimSpace(raw))
	if strings.HasPrefix(c, "A") {
		return strings.TrimPrefix(c, "A")
	}
	return c
}

// keepText trims a field and drops the empty / NIL / NONE placeholders SIA uses
// for an absent facility; otherwise it returns the value verbatim (the
// bilingual "French\\English" form is preserved for the SPA to split).
func keepText(s string) string {
	t := strings.TrimSpace(s)
	switch strings.ToUpper(strings.TrimRight(t, ". ")) {
	case "", "NIL", "NONE", "NEANT", "NÉANT":
		return ""
	}
	return t
}

// firstText returns the first candidate that survives keepText.
func firstText(cands ...string) string {
	for _, c := range cands {
		if v := keepText(c); v != "" {
			return v
		}
	}
	return ""
}

// sortItems orders a section's items by the fixed category order, keeping the
// source order within a category (stable).
func sortItems(items []facItem, order map[string]int) {
	sort.SliceStable(items, func(i, j int) bool {
		return order[items[i].cat] < order[items[j].cat]
	})
}

// itemsToAny serialises the [cat, text] entries to the nested JSON rows.
func itemsToAny(items []facItem) []any {
	out := make([]any, 0, len(items))
	for _, it := range items {
		out = append(out, []string{it.cat, it.text})
	}
	return out
}

// fuelColumn assembles the AD 2.4 FUEL service into the `fuel` column, or
// nil where the AIP files no such record.
//
// It joins the record's three fields rather than taking the first that
// survives, because they carry different halves of the answer and which one
// holds the grades varies by aerodrome: Dieppe puts them in the service
// hours ("Carburant / Fuel : 100 LL#Possible sur demande prealable a l'ACB")
// with only the payment method in the description, and Bourg-Ceyzeriat puts
// them in the remark ("AVGAS 100 LL and UL 91 : H24 by TOTAL card"). One
// field wins and the other two are lost; on the current cycle that costs
// 134 aerodromes their fuel service hours.
//
// The join is PER LANGUAGE. Each field is bilingual "French\\English" on its
// own, so concatenating them whole would leave a French half followed by an
// English half followed by another French half, and the app's remark
// formatter splits on the first separator alone (src/lib/format/remark.ts).
func fuelColumn(descr, workHr, rmk string) *fuelEntry {
	if strings.TrimSpace(descr) == "" && strings.TrimSpace(workHr) == "" && strings.TrimSpace(rmk) == "" {
		return nil
	}
	var fr, en []string
	for _, f := range []string{descr, workHr, rmk} {
		v := keepText(f)
		if v == "" {
			continue
		}
		a, b, ok := strings.Cut(v, `\\`)
		if !ok {
			// A monolingual field is shown as-is in both locales, which is
			// what the app already does with one, so it joins both halves.
			b = a
		}
		if a = strings.TrimSpace(a); a != "" {
			fr = append(fr, a)
		}
		if b = strings.TrimSpace(b); b != "" {
			en = append(en, b)
		}
	}
	if len(fr) == 0 && len(en) == 0 {
		// The record exists and every field of it is NIL: the AIP saying
		// there is no fuel on this field.
		return &fuelEntry{avail: "no", text: ""}
	}
	return &fuelEntry{avail: "yes", text: bilingual(strings.Join(fr, "#"), strings.Join(en, "#"))}
}

// bilingual re-emits a French and an English half in the AIP's own
// "French\\English" form, dropping the separator where the two are the same
// (a monolingual field, which the app shows as-is in both locales).
func bilingual(fr, en string) string {
	if fr == en {
		return fr
	}
	return fr + `\\` + en
}

// joinBilingual concatenates two already-bilingual strings per language, so
// the result is still one French half followed by one English half.
func joinBilingual(a, b string) string {
	if a == "" {
		return b
	}
	if b == "" {
		return a
	}
	afr, aen := halves(a)
	bfr, ben := halves(b)
	return bilingual(afr+"#"+bfr, aen+"#"+ben)
}

// halves splits a bilingual string, giving a monolingual one to both sides.
func halves(s string) (fr, en string) {
	a, b, ok := strings.Cut(s, `\\`)
	if !ok {
		return a, a
	}
	return a, b
}

// addFuel folds a second FUEL record into the first. Fuel is available if
// either record says so, and the two descriptions join per language the way
// one record's own fields do.
func addFuel(prev, next *fuelEntry) *fuelEntry {
	switch {
	case prev == nil:
		return next
	case next == nil:
		return prev
	}
	out := &fuelEntry{avail: prev.avail, text: joinBilingual(prev.text, next.text)}
	if next.avail == "yes" {
		out.avail = "yes"
	}
	return out
}

// fuelToAny serialises the fuel column, JSON null where there is no record.
func fuelToAny(f *fuelEntry) any {
	if f == nil {
		return nil
	}
	return []string{f.avail, f.text}
}
