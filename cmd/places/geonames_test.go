package main

import (
	"strings"
	"testing"
)

// cityLine is one cities500.txt row with the columns the build reads.
func cityLine(id, name, lat, lon, code, cc, admin1, pop string) string {
	return strings.Join([]string{id, name, name, "", lat, lon, "P", code, cc, "", admin1, "", "", "", pop, "", "0", "Europe/Berlin", "2026-10-01"}, "\t")
}

// altLine is one alternate-names row: id, geonameid, language, name and
// the four flags, preferred, short, colloquial, historic, as "1" or "".
func altLine(id, geonameid, lang, name, preferred, colloquial, historic, from string) string {
	return strings.Join([]string{id, geonameid, lang, name, preferred, "", colloquial, historic, from, ""}, "\t")
}

func buildGeoNamesFrom(t *testing.T, cities []string, alternates []string) (map[string]place, geoNamesDrops) {
	t.Helper()
	parsed, err := parseCities(zipStored(t, "cities500.txt", []byte(strings.Join(cities, "\n")+"\n")))
	if err != nil {
		t.Fatal(err)
	}
	admins := map[string]string{"DE.02": "Bavaria"}
	alt := map[string][]byte{
		"DE": zipStored(t, "DE.txt", []byte(strings.Join(alternates, "\n")+"\n")),
		"US": zipStored(t, "US.txt", nil),
	}
	files, drops, err := buildGeoNames(parsed, admins, alt, testTable)
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]place{}
	for _, p := range files["de"] {
		out[p.code] = p
	}
	return out, drops
}

func TestBuildGeoNamesFilters(t *testing.T) {
	de, drops := buildGeoNamesFrom(t, []string{
		cityLine("1", "Schwabing", "48.16", "11.58", "PPLX", "DE", "02", "100000"),
		cityLine("2", "Altenburg", "48.70", "11.20", "PPLH", "DE", "02", "2000"),
		cityLine("3", "Kleindorf", "48.50", "11.00", "PPL", "DE", "02", "600"),
		cityLine("4", "Amtsdorf", "48.60", "11.10", "PPLA3", "DE", "02", "0"),
		cityLine("5", "Grossdorf", "48.40", "11.30", "PPL", "DE", "02", "1000"),
		cityLine("6", "Kleinsitz", "48.30", "11.40", "PPLA4", "DE", "02", "900"),
		cityLine("7", "Nirgendwo", "", "11.30", "PPL", "DE", "02", "5000"),
		cityLine("8", "Toronto", "43.70", "-79.39", "PPLA", "CA", "08", "2600000"),
		cityLine("9", "Paris", "48.85", "2.35", "PPLC", "FR", "11", "2138551"),
	}, nil)
	if _, ok := de["4"]; !ok {
		t.Error("the seat Amtsdorf, of unknown population, was dropped")
	} else if de["4"].hasPop {
		t.Errorf("Amtsdorf population = %d, want none: GeoNames' 0 is unknown", de["4"].pop)
	}
	if p, ok := de["5"]; !ok || p.pop != 1000 || p.admin != "02" || p.adminName != "Bavaria" {
		t.Errorf("Grossdorf = %+v, want it kept at the floor, in Bavaria", p)
	}
	if len(de) != 2 {
		t.Errorf("kept %v, want Amtsdorf and Grossdorf", de)
	}
	want := geoNamesDrops{Section: 1, Historical: 1, BelowFloor: 2, NoPosition: 1}
	if drops != want {
		t.Errorf("drops = %+v, want %+v (Toronto and Paris are no country of the table)", drops, want)
	}
}

func TestBuildGeoNamesDuplicate(t *testing.T) {
	de, drops := buildGeoNamesFrom(t, []string{
		// The seat, of unknown population, and the town, 700 m apart:
		// one place, kept as the seat with the town's population.
		cityLine("10", "Dachau", "48.2603", "11.4342", "PPLA3", "DE", "02", "0"),
		cityLine("11", "Dachau", "48.2650", "11.4400", "PPL", "DE", "02", "47400"),
		// The same name 20 km off is another place.
		cityLine("12", "Dachau", "48.4400", "11.4400", "PPL", "DE", "02", "1200"),
		// Spellings that fold alike are one name.
		cityLine("13", "Sankt Märgen", "48.0100", "8.0900", "PPL", "DE", "02", "1900"),
		cityLine("14", "Sankt-Margen", "48.0110", "8.0910", "PPL", "DE", "02", "1800"),
	}, nil)
	if p, ok := de["10"]; !ok || p.pop != 47400 {
		t.Errorf("Dachau seat = %+v, want it kept with 47400 people", p)
	}
	if _, ok := de["11"]; ok {
		t.Error("the second Dachau 700 m from the first was kept")
	}
	if _, ok := de["12"]; !ok {
		t.Error("the Dachau 20 km away was dropped")
	}
	if _, ok := de["14"]; ok || de["13"].name != "Sankt Märgen" {
		t.Errorf("Sankt Märgen = %+v, Sankt-Margen kept %t: want the larger alone", de["13"], ok)
	}
	if drops.Duplicate != 2 {
		t.Errorf("drops = %+v, want 2 duplicates", drops)
	}
}

func TestBuildGeoNamesMunich(t *testing.T) {
	de, _ := buildGeoNamesFrom(t, []string{
		cityLine("2867714", "Munich", "48.13743", "11.57549", "PPLA", "DE", "02", "1260391"),
	}, []string{
		// A historic, a colloquial and a dated name, each preferred and
		// entered first, never become the name.
		altLine("1", "2867714", "de", "Monachium", "1", "", "1", ""),
		altLine("2", "2867714", "de", "Minga", "1", "1", "", ""),
		altLine("3", "2867714", "de", "Muenchen", "1", "", "", "1900"),
		altLine("4", "2867714", "de", "München", "1", "", "", ""),
		altLine("5", "2867714", "en", "Munich", "1", "", "", ""),
		altLine("6", "2867714", "fr", "Munich", "", "", "", ""),
		altLine("7", "2867714", "post", "80331", "", "", "", ""),
	})
	p := de["2867714"]
	if p.name != "München" {
		t.Errorf("Munich shown as %q, want München", p.name)
	}
	if p.alt != "Munich" {
		t.Errorf("Munich alt = %q, want Munich", p.alt)
	}
}

func TestLocalName(t *testing.T) {
	names := func(pairs ...string) map[string]*langNames {
		out := map[string]*langNames{}
		for i := 0; i+1 < len(pairs); i += 2 {
			lang, name := pairs[i], pairs[i+1]
			if l := out[lang]; l != nil {
				l.all = append(l.all, name)
				continue
			}
			out[lang] = &langNames{best: altName{id: i, name: name}, all: []string{name}}
		}
		return out
	}
	for _, c := range []struct {
		name    string
		own     string
		names   map[string]*langNames
		lang    string
		foreign []string
		want    string
	}{
		{"an English exonym", "Vienna", names("en", "Vienna", "fr", "Vienne", "de", "Wien"), "de", enFr, "Wien"},
		{"a French name is foreign too", "Genève", names("fr", "Genève", "de", "Genf"), "de", enFr, "Genf"},
		{"the first entered when none is preferred", "Geneva", names("en", "Geneva", "fr", "Genève", "fr", "Genève-Ville"), "fr", enFr, "Genève"},
		{"no display language", "Brussels", names("en", "Brussels", "fr", "Bruxelles"), "", enFr, "Brussels"},
		{"no name in the display language", "Lugano", names("en", "Lugano"), "it", enFr, "Lugano"},
		{"the own name is local too", "Basel", names("en", "Basel", "de", "Basel", "de", "Basle"), "de", enFr, "Basel"},
		{"not a foreign name", "Zerbst", names("de", "Zerbst/Anhalt"), "de", enFr, "Zerbst"},
		// The municipality Wartberg merged into: only the trigger keeps
		// the town's own name, no guard would.
		{"another place's name", "Wartberg", names("de", "St. Barbara"), "de", enFr, "Wartberg"},
		{"case alone", "Livno", names("en", "Livno", "bs", "livno"), "bs", enFr, "Livno"},
		{"words added", "Teresin", names("en", "Teresin", "pl", "Gmina Teresin"), "pl", enFr, "Teresin"},
		{"words dropped", "Velturno - Feldthurns", names("en", "Velturno - Feldthurns", "it", "Velturno"), "it", enFr, "Velturno - Feldthurns"},
		{"marks restored", "Meissen", names("en", "Meissen", "de", "Meißen"), "de", enFr, "Meißen"},
		{"an Irish name in Ireland", "An Muileann gCearr", names("ga", "An Muileann gCearr", "en", "Mullingar"), "en", []string{"ga"}, "Mullingar"},
		{"the display language is never foreign", "Mullingar", names("en", "Mullingar", "ga", "An Muileann gCearr"), "en", []string{"en", "ga"}, "Mullingar"},
	} {
		if got := localName(c.own, c.names, c.lang, c.foreign); got != c.want {
			t.Errorf("%s: localName(%q, %q) = %q, want %q", c.name, c.own, c.lang, got, c.want)
		}
	}
}

func TestSearchNames(t *testing.T) {
	names := map[string]*langNames{
		"en": {best: altName{name: "Vienna"}},
		"fr": {best: altName{name: "Vienne"}},
		"de": {best: altName{name: "Wien"}},
		"it": {best: altName{name: "Vienna"}},
		"es": {best: altName{name: "Viena"}},
		"nl": {best: altName{name: "Wenen"}},
		"cs": {best: altName{name: "Vídeň"}},
	}
	if got := searchNames("Vienna", names, []string{"en", "fr", "de", "it", "es", "nl", "cs"}, "Wien"); got != "Vienna|Vienne|Viena|Wenen" {
		t.Errorf("searchNames = %q, want four names, none shown or repeated", got)
	}
	if got := searchNames("Čelinac", map[string]*langNames{"en": {best: altName{name: "Celinac"}}}, enFr, "Čelinac"); got != "" {
		t.Errorf("searchNames = %q, want nothing: Celinac folds to the name shown", got)
	}
	if got := searchNames("A|B", nil, nil, "C"); got != "" {
		t.Errorf("searchNames = %q, want a name holding the separator left out", got)
	}
}

func TestFold(t *testing.T) {
	for in, want := range map[string]string{
		"Saint-Étienne":           "saint etienne",
		"Straße":                  "strasse",
		"Łódź":                    "lodz",
		"  --Bad   Tölz-- ":       "bad tolz",
		"Ħaż-Żebbuġ":              "haz zebbug",
		"Sant'Agata de' Goti":     "sant agata de goti",
		"Târgu Mureș / Mureş":     "targu mures mures",
		"Αθήνα":                   "αθήνα",
		"Biel/Bienne":             "biel bienne",
		"Øvre Årdal":              "ovre ardal",
		"Œuilly":                  "oeuilly",
		"Þórshöfn":                "thorshofn",
		"Kraljevec Kupinečki 2nd": "kraljevec kupinecki 2nd",
	} {
		if got := fold(in); got != want {
			t.Errorf("fold(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestDistanceKm(t *testing.T) {
	// One minute of latitude is a nautical mile, 1.852 km, to within the
	// sphere's flattening.
	if d := distanceKm(48, 2, 48+1.0/60, 2); d < 1.84 || d > 1.86 {
		t.Errorf("distanceKm over one minute of latitude = %v, want about 1.852", d)
	}
	if d := distanceKm(48, 2, 48, 2); d != 0 {
		t.Errorf("distanceKm to itself = %v, want 0", d)
	}
}

func TestParseCitiesRefuses(t *testing.T) {
	for name, line := range map[string]string{
		"short row":      "1\tShort\tShort",
		"bad geonameid":  cityLine("x", "Bad", "48", "2", "PPL", "DE", "02", "1"),
		"bad population": cityLine("1", "Bad", "48", "2", "PPL", "DE", "02", "many"),
	} {
		if _, err := parseCities(zipStored(t, "cities500.txt", []byte(line+"\n"))); err == nil {
			t.Errorf("%s: parseCities accepted %q", name, line)
		}
	}
	if _, err := parseCities(zipStored(t, "other.txt", nil)); err == nil {
		t.Error("parseCities accepted an archive without cities500.txt")
	}
}
