// helistations.go folds the SIA proprietary XML's <Helistation> directory onto
// the aerodrome-facilities rows. The AIP publishes helipads in AD 1.3-2 rather
// than AD 2, but for this dataset's purpose (the AIP directory text the airport
// panel shows) they are the same thing, so they share the artefact, the loader
// and the panel section instead of forking a sibling of each.
//
// Three of the fields land in columns the AD 2 side already has, rather than
// being duplicated: the operating hours, the fire cover (SSLIA, the existing
// "fire" service category) and the operator contact. The rest go to the
// directory column, which is a [cat, text] list shaped exactly like services /
// passenger / contact.

package main

import "strings"

// The directory-column categories, in the order they are emitted (fixed, for a
// stable diff and a sensible reading order): what the pad is, then what it is
// made of, then what the AIP says about using it.
const (
	helStatus   = "status"    // Statut, coded: TPD / RST / ADM
	helSubCat   = "subCat"    // SousCat
	helPerfCls  = "perfClass" // ClassePerf
	helRefType  = "helRef"    // HelRef, the reference helicopter
	helNight    = "night"     // Nuit, coded: oui / non
	helTerrace  = "terrace"   // EnTerrasse, coded: oui / non
	helBuiltUp  = "builtUp"   // ZoneHabitee, coded
	helHeight   = "height"    // HauteurFt
	helFato     = "fato"      // DimFato
	helTlof     = "tlof"      // DimTlof
	helSurface  = "surface"   // Revetement
	helStrength = "strength"  // Resistance
	helRemark   = "remark"    // Remarque
)

// helOrder is the emission order of the helipad half of the directory column.
var helOrder = map[string]int{
	helStatus: 0, helSubCat: 1, helPerfCls: 2, helRefType: 3,
	helNight: 4, helTerrace: 5, helBuiltUp: 6, helHeight: 7,
	helFato: 8, helTlof: 9, helSurface: 10, helStrength: 11,
	helRemark: 12,
}

// helKeepText is keepText plus the SIA's own "not defined" placeholders, which
// ClassePerf and HelRef carry for a pad whose performance class or reference
// helicopter the AIP does not state. They are French prose meaning nothing, so
// they are dropped rather than translated. The check is a prefix so it does not
// touch ZoneHabitee's "non hostile", a real value.
func helKeepText(s string) string {
	t := keepText(s)
	if strings.HasPrefix(strings.ToLower(t), "non défini") {
		return ""
	}
	return t
}

// helistationItems returns the directory-column entries of one record, in
// helOrder. Coded fields keep their code (the SPA labels them); everything else
// is AIP free text, verbatim.
func helistationItems(h *siaHelistation) []facItem {
	pairs := []struct {
		cat, raw string
	}{
		{helStatus, h.Statut},
		{helSubCat, h.SousCat},
		{helPerfCls, h.ClassePerf},
		{helRefType, h.HelRef},
		{helNight, h.Nuit},
		{helTerrace, h.EnTerrasse},
		{helBuiltUp, h.ZoneHabitee},
		{helHeight, h.HauteurFt},
		{helFato, h.DimFato},
		{helTlof, h.DimTlof},
		{helSurface, h.Revetement},
		{helStrength, h.Resistance},
		{helRemark, h.Remarque},
	}
	items := make([]facItem, 0, len(pairs))
	for _, p := range pairs {
		if v := helKeepText(p.raw); v != "" {
			items = append(items, facItem{p.cat, v})
		}
	}
	return items
}

// applyHelistations folds the SIA helipad directory onto the facility records,
// keyed by the ident its AIXM twin carries (the ICAO when the SIA coded one,
// else its own codeId, as cmd/fr/airports.go resolves it). A record whose name
// no AIXM helipad claims is skipped: the airport dataset would have no row to
// hang it on. Counts are folded into the shared per-category map.
//
// The 16 helipads the SIA also gives an AD 2 section (LFPI, LFWD, LFTL, LFWF,
// ...) merge into their existing record rather than shadowing it.
func applyHelistations(recs map[string]*facRec, identByName map[string]string, hels []siaHelistation, counts map[string]int) int {
	n := 0
	for i := range hels {
		h := &hels[i]
		ident := identByName[strings.TrimSpace(h.Nom)]
		if ident == "" {
			continue
		}
		r := recs[ident]
		if r == nil {
			r = &facRec{}
			recs[ident] = r
		}
		n++

		// Columns the AD 2 side already has. The AIXM never publishes any of
		// the three for a helipad, so these only ever fill a blank.
		if v := helKeepText(h.HorTxt); v != "" && r.hours == "" {
			r.hours = v
		}
		if v := helKeepText(h.Sslia); v != "" {
			r.services = append(r.services, facItem{"fire", v})
			counts["fire"]++
		}
		if v := helKeepText(h.Balisage); v != "" {
			r.services = append(r.services, facItem{"lighting", v})
			counts["lighting"]++
		}
		if v := helKeepText(h.Exploitant); v != "" {
			r.contact = append(r.contact, facItem{"operator", v})
			counts["operator"]++
		}

		for _, it := range helistationItems(h) {
			r.directory = append(r.directory, it)
			counts[it.cat]++
		}
	}
	return n
}
