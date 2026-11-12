// geonames.go reads the GeoNames gazetteer: cities500 (every populated
// place of more than 500 people, and the seats of the divisions), the
// names of the first-level divisions, and each country's alternate
// names, which carry a place's name in each language.

package main

import (
	"archive/zip"
	"bufio"
	"bytes"
	"cmp"
	"fmt"
	"io"
	"math"
	"slices"
	"strconv"
	"strings"
)

const (
	geoNamesDumpURL = "https://download.geonames.org/export/dump/"

	// dupRadiusKm is how far apart two places sharing a name must be to
	// be two places: GeoNames files some towns twice, as a populated
	// place and as the seat of its division, up to a couple of
	// kilometres apart.
	dupRadiusKm = 2.0

	// maxAlt is how many search names a row carries beside its own.
	maxAlt = 4
)

// A city is one row of cities500.txt, as far as this build reads it.
type city struct {
	id       int
	name     string
	lat, lon float64
	posOK    bool
	class    string // feature class
	code     string // feature code
	cc       string // country code
	admin1   string
	pop      int64
	modified string // the row's last modification, YYYY-MM-DD
}

// The cities500.txt columns, from the dump's readme.txt.
const (
	colID       = 0
	colName     = 1
	colLat      = 4
	colLon      = 5
	colClass    = 6
	colCode     = 7
	colCC       = 8
	colAdmin1   = 10
	colPop      = 14
	colModified = 18
	cityColumns = 19
)

// The feature codes the filter names (www.geonames.org/export/codes.html).
var (
	// seatCodes are kept whatever their population: the capital and the
	// seats of the first three levels of division.
	seatCodes = map[string]bool{"PPLC": true, "PPLA": true, "PPLA2": true, "PPLA3": true}

	// historicalCodes are places that no longer stand as they are named:
	// historical, a historical capital, abandoned, destroyed.
	historicalCodes = map[string]bool{"PPLH": true, "PPLCH": true, "PPLQ": true, "PPLW": true}
)

// sectionCode is a section of a populated place, a district the town it
// belongs to already names.
const sectionCode = "PPLX"

// parseCities reads cities500.zip.
func parseCities(zipped []byte) ([]city, error) {
	rc, err := openZipEntry(zipped, "cities500.txt")
	if err != nil {
		return nil, fmt.Errorf("geonames cities500: %w", err)
	}
	defer rc.Close()
	var out []city
	sc := newScanner(rc)
	for n := 1; sc.Scan(); n++ {
		line := sc.Text()
		if line == "" {
			continue
		}
		f := strings.Split(line, "\t")
		if len(f) != cityColumns {
			return nil, fmt.Errorf("geonames cities500 line %d: %d columns, want %d", n, len(f), cityColumns)
		}
		id, err := strconv.Atoi(f[colID])
		if err != nil || id <= 0 {
			return nil, fmt.Errorf("geonames cities500 line %d: geonameid %q", n, f[colID])
		}
		var pop int64
		if f[colPop] != "" {
			if pop, err = strconv.ParseInt(f[colPop], 10, 64); err != nil || pop < 0 {
				return nil, fmt.Errorf("geonames cities500 line %d: population %q", n, f[colPop])
			}
		}
		c := city{
			id:       id,
			name:     f[colName],
			class:    f[colClass],
			code:     f[colCode],
			cc:       f[colCC],
			admin1:   f[colAdmin1],
			pop:      pop,
			modified: f[colModified],
		}
		lat, latErr := strconv.ParseFloat(f[colLat], 64)
		lon, lonErr := strconv.ParseFloat(f[colLon], 64)
		if latErr == nil && lonErr == nil && validPosition(lat, lon) {
			c.lat, c.lon, c.posOK = lat, lon, true
		}
		if c.name == "" {
			return nil, fmt.Errorf("geonames cities500 line %d: geonameid %d has no name", n, id)
		}
		out = append(out, c)
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("geonames cities500: %w", err)
	}
	return out, nil
}

// parseAdmin1 reads admin1CodesASCII.txt: the English name of each
// first-level division, keyed "CC.code".
func parseAdmin1(b []byte) (map[string]string, error) {
	out := map[string]string{}
	sc := newScanner(bytes.NewReader(b))
	for n := 1; sc.Scan(); n++ {
		line := sc.Text()
		if line == "" {
			continue
		}
		f := strings.Split(line, "\t")
		if len(f) != 4 {
			return nil, fmt.Errorf("geonames admin1 line %d: %d columns, want 4", n, len(f))
		}
		if f[0] == "" || f[1] == "" {
			return nil, fmt.Errorf("geonames admin1 line %d: no code or no name", n)
		}
		out[f[0]] = f[1]
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("geonames admin1: %w", err)
	}
	return out, nil
}

// An altName is a name a place carries in one language.
type altName struct {
	id        int // the alternateNameId: the lower was entered first
	name      string
	preferred bool
}

// A langNames is everything a place is called in one language: the name
// it goes by there, and every name GeoNames files under the language.
type langNames struct {
	best altName
	all  []string
}

// has reports whether name is one of the names.
func (l *langNames) has(name string) bool {
	return l != nil && slices.Contains(l.all, name)
}

// better reports whether a beats b as a language's name: the preferred
// one, else the one entered first.
func (a altName) better(b altName) bool {
	if a.preferred != b.preferred {
		return a.preferred
	}
	return a.id < b.id
}

// The alternateNames columns, from the dump's readme.txt.
const (
	altColID         = 0
	altColGeonameID  = 1
	altColLang       = 2
	altColName       = 3
	altColPreferred  = 4
	altColColloquial = 6
	altColHistoric   = 7
	altColFrom       = 8
	altColTo         = 9
	altMinColumns    = 8
)

// parseAlternates reads alternatenames/<cc>.zip and returns, for each
// wanted place and each wanted language, the names it carries in that
// language. A colloquial name, a historic one and one dated to a period
// are never read.
func parseAlternates(zipped []byte, cc string, wanted map[int]bool, langs map[string]bool) (map[int]map[string]*langNames, error) {
	rc, err := openZipEntry(zipped, cc+".txt")
	if err != nil {
		return nil, fmt.Errorf("geonames alternatenames %s: %w", cc, err)
	}
	defer rc.Close()
	out := map[int]map[string]*langNames{}
	sc := newScanner(rc)
	for n := 1; sc.Scan(); n++ {
		line := sc.Text()
		if line == "" {
			continue
		}
		f := strings.Split(line, "\t")
		if len(f) < altMinColumns {
			return nil, fmt.Errorf("geonames alternatenames %s line %d: %d columns, want at least %d", cc, n, len(f), altMinColumns)
		}
		lang := f[altColLang]
		if !langs[lang] {
			continue
		}
		gid, err := strconv.Atoi(f[altColGeonameID])
		if err != nil {
			return nil, fmt.Errorf("geonames alternatenames %s line %d: geonameid %q", cc, n, f[altColGeonameID])
		}
		if !wanted[gid] {
			continue
		}
		if f[altColColloquial] == "1" || f[altColHistoric] == "1" || column(f, altColFrom) != "" || column(f, altColTo) != "" {
			continue
		}
		id, err := strconv.Atoi(f[altColID])
		if err != nil {
			return nil, fmt.Errorf("geonames alternatenames %s line %d: alternateNameId %q", cc, n, f[altColID])
		}
		a := altName{id: id, name: strings.TrimSpace(f[altColName]), preferred: f[altColPreferred] == "1"}
		if a.name == "" {
			continue
		}
		byLang := out[gid]
		if byLang == nil {
			byLang = map[string]*langNames{}
			out[gid] = byLang
		}
		l := byLang[lang]
		if l == nil {
			byLang[lang] = &langNames{best: a, all: []string{a.name}}
			continue
		}
		if a.better(l.best) {
			l.best = a
		}
		l.all = append(l.all, a.name)
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("geonames alternatenames %s: %w", cc, err)
	}
	return out, nil
}

// geoNamesDrops counts the GeoNames places of the table's countries not
// written, by reason.
type geoNamesDrops struct {
	BelowFloor   int `json:"belowFloor"`   // under the country's floor, and no seat
	Duplicate    int `json:"duplicate"`    // a second row for a place already kept
	Historical   int `json:"historical"`   // historical, abandoned or destroyed
	NoPosition   int `json:"noPosition"`   // no usable coordinates
	NotPopulated int `json:"notPopulated"` // not a populated place (class P)
	Section      int `json:"section"`      // a section of a populated place
}

// A candidate is a place that passed the filters, with its names.
type candidate struct {
	city
	display string
	alt     string
	keys    []string // the folded names it is a duplicate under
}

// buildGeoNames sorts the table's GeoNames countries out of cities500,
// keyed by ISO code. alternates holds each country's alternatenames zip
// by country code.
func buildGeoNames(cities []city, admins map[string]string, alternates map[string][]byte, table []country) (map[string][]place, geoNamesDrops, error) {
	var drops geoNamesDrops
	byCC := map[string]country{}
	out := map[string][]place{}
	for _, t := range table {
		if t.source == srcGeoNames {
			byCC[t.cc] = t
			out[t.iso] = nil
		}
	}
	passed := map[string][]city{}
	for _, c := range cities {
		t, ok := byCC[c.cc]
		if !ok {
			continue
		}
		switch {
		case c.class != "P":
			drops.NotPopulated++
		case c.code == sectionCode:
			drops.Section++
		case historicalCodes[c.code]:
			drops.Historical++
		case !c.posOK:
			drops.NoPosition++
		case c.pop < int64(t.minPop) && !seatCodes[c.code]:
			drops.BelowFloor++
		default:
			passed[c.cc] = append(passed[c.cc], c)
		}
	}
	for _, cc := range sortedKeys(byCC) {
		t := byCC[cc]
		zipped, ok := alternates[cc]
		if !ok {
			return nil, drops, fmt.Errorf("geonames: no alternate names for %s", cc)
		}
		wanted := map[int]bool{}
		for _, c := range passed[cc] {
			wanted[c.id] = true
		}
		names, err := parseAlternates(zipped, cc, wanted, t.languages())
		if err != nil {
			return nil, drops, err
		}
		cands := make([]candidate, 0, len(passed[cc]))
		for _, c := range passed[cc] {
			display := localName(c.name, names[c.id], t.displayIn(c.admin1), t.foreignLanguages())
			cands = append(cands, candidate{
				city:    c,
				display: display,
				alt:     searchNames(c.name, names[c.id], t.alt, display),
				keys:    uniqueKeys(fold(c.name), fold(display)),
			})
		}
		kept, dups := dedupe(cands)
		drops.Duplicate += dups
		for _, c := range kept {
			p := place{
				code: strconv.Itoa(c.id),
				num:  c.id,
				name: c.display,
				lat:  c.lat,
				lon:  c.lon,
				alt:  c.alt,
			}
			if c.pop > 0 {
				p.pop, p.hasPop = int(c.pop), true
			}
			if name, ok := admins[cc+"."+c.admin1]; ok && c.admin1 != "" {
				p.admin = c.admin1
				p.adminName = name
			}
			out[t.iso] = append(out[t.iso], p)
		}
	}
	return out, drops, nil
}

// localName is the name a place is shown under, given GeoNames' own
// name for it and its names by language.
//
// GeoNames names most places as their country does, but a few in
// another language: the large cities in English ("Munich", "Vienna",
// "Geneva"), some Irish towns in Irish, some Norwegian ones in Sami. The
// own name is replaced only when it is such a foreign name, one GeoNames
// also files under a foreign language and never under lang, and then by
// the name lang uses, the preferred one, else the first entered. Two
// replacements are refused, the own name standing: one that differs
// from it only in case (a lower-case entry is noise), and one that only
// adds or drops words ("Gmina Teresin", the municipality, for Teresin).
// On the 2026-10-18 dump, taking the display language's name wherever
// it differs changed 216 names in Germany, mostly for the worse (a
// municipality's name, a dated one, "Bad Wildbad im Schwarzwald"); this
// rule changes five there, München and Nürnberg among them.
func localName(own string, names map[string]*langNames, lang string, foreign []string) string {
	local := names[lang]
	if lang == "" || local == nil || local.has(own) {
		return own
	}
	isForeign := false
	for _, f := range foreign {
		if f != lang && names[f].has(own) {
			isForeign = true
			break
		}
	}
	if !isForeign {
		return own
	}
	pick := local.best.name
	if strings.EqualFold(pick, own) {
		return own
	}
	if a, b := fold(own), fold(pick); a != b && (containsWords(a, b) || containsWords(b, a)) {
		return own
	}
	return pick
}

// containsWords reports whether the folded name a holds the folded name
// b as whole words.
func containsWords(a, b string) bool {
	return strings.Contains(" "+a+" ", " "+b+" ")
}

// searchNames is the alt cell: up to maxAlt names a place is also found
// by, its own name first, then its name in each of langs. A name that
// folds to the one it is shown under, or to one already listed, is left
// out: the search folds what is typed, so "Celinac" adds nothing to
// "Čelinac".
func searchNames(own string, names map[string]*langNames, langs []string, display string) string {
	var out []string
	seen := []string{fold(display)}
	add := func(s string) {
		if s == "" || strings.ContainsRune(s, '|') || len(out) == maxAlt {
			return
		}
		f := fold(s)
		if slices.Contains(seen, f) {
			return
		}
		seen = append(seen, f)
		out = append(out, s)
	}
	add(own)
	for _, l := range langs {
		if n := names[l]; n != nil {
			add(n.best.name)
		}
	}
	return strings.Join(out, "|")
}

// dedupe keeps one place of each group sharing a folded name within
// dupRadiusKm: the higher seat, then the larger population, then the
// lower geonameid. The two rows are one place, so a kept row with no
// population takes its duplicate's. It returns the kept places and the
// number dropped.
func dedupe(cands []candidate) ([]candidate, int) {
	order := slices.Clone(cands)
	slices.SortFunc(order, func(a, b candidate) int {
		return cmp.Or(
			cmp.Compare(rank(a.code), rank(b.code)),
			cmp.Compare(b.pop, a.pop),
			cmp.Compare(a.id, b.id),
		)
	})
	var kept []candidate
	byKey := map[string][]int{} // indices into kept
	dropped := 0
	for _, c := range order {
		if i, ok := nearSameName(c, kept, byKey); ok {
			if kept[i].pop == 0 {
				kept[i].pop = c.pop
			}
			dropped++
			continue
		}
		kept = append(kept, c)
		for _, k := range c.keys {
			byKey[k] = append(byKey[k], len(kept)-1)
		}
	}
	return kept, dropped
}

// nearSameName returns the kept place sharing one of c's names within
// dupRadiusKm of it, if any.
func nearSameName(c candidate, kept []candidate, byKey map[string][]int) (int, bool) {
	for _, k := range c.keys {
		for _, i := range byKey[k] {
			if distanceKm(c.lat, c.lon, kept[i].lat, kept[i].lon) < dupRadiusKm {
				return i, true
			}
		}
	}
	return 0, false
}

// rank orders the feature codes for keeping one of two duplicates: the
// capital, then the seats from the highest division down, then every
// other place.
func rank(code string) int {
	switch code {
	case "PPLC":
		return 0
	case "PPLA":
		return 1
	case "PPLA2":
		return 2
	case "PPLA3":
		return 3
	case "PPLA4":
		return 4
	case "PPLA5":
		return 5
	}
	return 6
}

// distanceKm is the great-circle distance between two positions.
func distanceKm(lat1, lon1, lat2, lon2 float64) float64 {
	const earthRadiusKm = 6371.0088
	const rad = math.Pi / 180
	phi1, phi2 := lat1*rad, lat2*rad
	dPhi := phi2 - phi1
	dLambda := (lon2 - lon1) * rad
	h := math.Sin(dPhi/2)*math.Sin(dPhi/2) + math.Cos(phi1)*math.Cos(phi2)*math.Sin(dLambda/2)*math.Sin(dLambda/2)
	return 2 * earthRadiusKm * math.Asin(math.Sqrt(min(h, 1)))
}

// fold reduces a name to what two spellings of one place share: lower
// case, the Latin letters without their marks, every run of other
// characters one space.
func fold(s string) string {
	var b strings.Builder
	space := false
	for _, r := range strings.ToLower(s) {
		var part string
		switch f, ok := latinFold[r]; {
		case ok:
			part = f
		case isLetterOrDigit(r):
			part = string(r)
		default:
			space = b.Len() > 0
			continue
		}
		if space {
			b.WriteByte(' ')
			space = false
		}
		b.WriteString(part)
	}
	return b.String()
}

// latinFold maps the lower-case Latin letters a European place name
// carries to the letters they are typed as.
var latinFold = func() map[rune]string {
	m := map[rune]string{
		'ß': "ss", 'æ': "ae", 'œ': "oe", 'ø': "o", 'ł': "l",
		'đ': "d", 'ð': "d", 'þ': "th", 'ı': "i", 'ħ': "h",
	}
	for base, marked := range map[string]string{
		"a": "àáâãäåāăą", "c": "çćĉċč", "d": "ď", "e": "èéêëēĕėęě",
		"g": "ĝğġģ", "h": "ĥ", "i": "ìíîïĩīĭį", "j": "ĵ", "k": "ķ",
		"l": "ĺļľŀ", "n": "ñńņňŉ", "o": "òóôõöōŏő", "r": "ŕŗř",
		"s": "śŝşšș", "t": "ţťŧț", "u": "ùúûüũūŭůűų", "w": "ŵ",
		"y": "ýÿŷ", "z": "źżž",
	} {
		for _, r := range marked {
			m[r] = base
		}
	}
	return m
}()

// uniqueKeys returns its arguments without the empty one and without
// repeats, in order.
func uniqueKeys(keys ...string) []string {
	var out []string
	for _, k := range keys {
		if k != "" && !slices.Contains(out, k) {
			out = append(out, k)
		}
	}
	return out
}

// openZipEntry opens the named member of a zip held in memory.
func openZipEntry(zipped []byte, name string) (io.ReadCloser, error) {
	zr, err := zip.NewReader(bytes.NewReader(zipped), int64(len(zipped)))
	if err != nil {
		return nil, err
	}
	for _, f := range zr.File {
		if f.Name == name {
			return f.Open()
		}
	}
	return nil, fmt.Errorf("no %s in the archive", name)
}

// newScanner reads lines up to the 10,000-character alternatenames
// column and some.
func newScanner(r io.Reader) *bufio.Scanner {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	return sc
}

// column returns f[i], or "" past the end of a short row.
func column(f []string, i int) string {
	if i < len(f) {
		return f[i]
	}
	return ""
}
