// api.go: the SUP AIP record types, the committed dataset schema, and the
// .meta.json document.

package main

const siaHost = "https://www.sia.aviation-civile.gouv.fr"

// pdfStore is the root of the SIA media store the supplement PDFs live in.
// A file is NOT served from the root: the store shards by the filename's
// first two characters, which pdfURL applies.
const pdfStore = siaHost + "/media/store/documents/file/"

// pdfURL is where the media store serves one supplement PDF. The two path
// segments before the filename are its first two characters, so
// lf_sup_2026_183_fr.pdf resolves under /l/f/ but run_sup_2026_002_fr.pdf
// under /r/u/ and pacp_sup_2026_004_fr.pdf under /p/a/.
//
// Taking the metropole bucket for every region is what gave every overseas
// supplement a urlPdf that 404s, in the dataset and so in the panel that
// links it, and what kept the backfill sweep from ever probing an overseas
// number successfully. The SPA's own builder (src/lib/notam/aipSup.ts) is
// unaffected: it constructs lf_ filenames only, so its bucket is always
// /l/f/.
func pdfURL(filename string) string {
	if len(filename) < 2 {
		return pdfStore + filename
	}
	return pdfStore + filename[0:1] + "/" + filename[1:2] + "/" + filename
}

// regions are the five SUP AIP listing pages, keyed by the SIA "id" segment.
// The key is stored verbatim on each row; the SPA maps it to a display name.
var regions = []struct {
	key string // metropole, car-sam-nam, pac-n, pac-p, run
	id  string // /documents/supaip/aip/id/<id>
}{
	{"metropole", "6"},
	{"car-sam-nam", "7"},
	{"pac-n", "8"},
	{"pac-p", "9"},
	{"run", "10"},
}

// rawSup is one supplement assembled from a listing row plus its PDF, before
// geometry parsing.
type rawSup struct {
	region    string
	number    int
	year      int
	descFr    string
	validFrom string // YYYY-MM-DD
	validTo   string
	ifr       bool
	vfr       bool
	airac     bool   // from the resolved filename (_a_ marker)
	filename  string // lf_sup[_a]_YYYY_NNN_fr.pdf
	pdf       []byte
	pdfEn     []byte // the parallel _en.pdf, nil when none exists
	// swept marks a supplement recovered from the media store by number
	// (backfill.go) rather than from a listing row: its subject and validity
	// were read off the cover page, so they predate any later amendment the
	// listing would have carried.
	swept bool
}

// outputFields is the columnar schema for fr-supaip.json. Mirrors the
// {fields, rows} convention every dataset uses; rowToSupAip in
// src/lib/data/supaip.ts decodes it positionally.
var outputFields = []string{
	"id", "title", "region", "descriptionFr", "descriptionEn", "lieu",
	"urlPdf", "validFrom", "validTo", "ifr", "vfr", "airac", "fir", "adhp",
	"zones", "bbox", "geometrySource", "parseConfidence", "warnings",
	"urlPdfEn",
	// SUP-level coordination block (contacts.go). Appended after urlPdfEn so the
	// SPA loader's positional rowToSupAip (r[0..19]) is unaffected; the SPA wires
	// these once the data shape is confirmed.
	"contacts", "penetration", "manager",
	// The telephone numbers it prints (phones.go), empty once its validity
	// has ended (lapsePhones).
	"phones",
}

// polyJSON / multiJSON / circJSON are the geometry shapes emitted into a row.
type polyJSON struct {
	Type string       `json:"type"` // "polygon"
	Ring [][2]float64 `json:"ring"`
}

type multiJSON struct {
	Type  string         `json:"type"` // "multipolygon"
	Rings [][][2]float64 `json:"rings"`
}

type circJSON struct {
	Type    string     `json:"type"` // "circle"
	Center  [2]float64 `json:"center"`
	RadiusM float64    `json:"radiusM"`
}

func geomJSON(g *geometry) any {
	switch {
	case g == nil:
		return nil
	case g.kind == "circle":
		return circJSON{Type: "circle", Center: g.center, RadiusM: g.radiusM}
	case g.kind == "multipolygon":
		return multiJSON{Type: "multipolygon", Rings: g.rings}
	default:
		return polyJSON{Type: "polygon", Ring: g.ring}
	}
}

// activationJSON is one scheduled window in a zone's "activations" array.
// dateTo / from / to are omitted when empty (a single all-day date).
type activationJSON struct {
	Date   string `json:"date"`
	DateTo string `json:"dateTo,omitempty"`
	From   string `json:"from,omitempty"`
	To     string `json:"to,omitempty"`
	// Days are the ISO weekdays (Monday 1) the activation holds, none for
	// every day, and ExceptHolidays and ExceptHolidayEves take the French
	// public holidays and the days before them off.
	Days              []int `json:"days,omitempty"`
	ExceptHolidays    bool  `json:"exceptHolidays,omitempty"`
	ExceptHolidayEves bool  `json:"exceptHolidayEves,omitempty"`
	// SunFrom and SunTo are an end the sun sets ("SS+30", "SR-120": the
	// event and its offset in minutes), From or To then absent or the latest
	// clock time printed.
	SunFrom string `json:"sunFrom,omitempty"`
	SunTo   string `json:"sunTo,omitempty"`
	// Mode is "activable" for a period the zone may be activated in, its
	// real activity known from a unit, and "notam" for one each activation
	// of which a NOTAM announces, NoticeMin the shortest notice in minutes
	// it is announced at. Absent, the period is firm.
	Mode      string `json:"mode,omitempty"`
	NoticeMin int    `json:"noticeMin,omitempty"`
}

// standingJSON is one rule a zone's schedule states with no dates: its
// hours, its day rule, its status, and SummerEarlier for hours printed in
// winter UTC and held an hour earlier in summer (AIP France GEN 2.1.2).
type standingJSON struct {
	From              string `json:"from,omitempty"`
	To                string `json:"to,omitempty"`
	Days              []int  `json:"days,omitempty"`
	ExceptHolidays    bool   `json:"exceptHolidays,omitempty"`
	ExceptHolidayEves bool   `json:"exceptHolidayEves,omitempty"`
	SunFrom           string `json:"sunFrom,omitempty"`
	SunTo             string `json:"sunTo,omitempty"`
	SummerEarlier     bool   `json:"summerEarlier,omitempty"`
	Mode              string `json:"mode,omitempty"`
	NoticeMin         int    `json:"noticeMin,omitempty"`
}

// zoneJSON is one named sub-area in a row's "zones" array.
type zoneJSON struct {
	Name           string           `json:"name"`
	Geometry       any              `json:"geometry"`
	Bbox           []float64        `json:"bbox"`
	Lower          any              `json:"lower"`
	Upper          any              `json:"upper"`
	GeometrySource string           `json:"geometrySource"`
	Activations    []activationJSON `json:"activations,omitempty"`
	// Standing are the rules its schedule states with no dates, held over
	// the supplement's validity.
	Standing []standingJSON `json:"standing,omitempty"`
	// The designators whose published lateral limits the zone adopts, for a
	// zone stated "Identiques à celles de la zone LF-D5" with no coordinates
	// of its own.
	SameAs string `json:"sameAs,omitempty"`
	// The sectors the zone takes out of its volume, each between its own
	// limits ("à l'exclusion du secteur d'aérodrome de Condom").
	Exclusions []exclusionJSON `json:"exclusions,omitempty"`
	// The airspaces the zone's lateral limits take out of it ("à
	// l'exclusion de la LF-D595 lorsqu'elle est active").
	Excluded []excludedJSON `json:"excluded,omitempty"`
}

// excludedJSON is one airspace a zone takes out of it: a P, R or D zone by
// its fr-airspaces.json id or a zone of the same supplement by its name, and
// whether only while it is active.
type excludedJSON struct {
	ID         string `json:"id,omitempty"`
	Zone       string `json:"zone,omitempty"`
	WhenActive bool   `json:"whenActive,omitempty"`
}

// exclusionJSON is one sector a zone takes out of its volume: its outline,
// its vertical limits, and the daily hours it holds in, none for all day.
type exclusionJSON struct {
	Name     string      `json:"name"`
	Geometry any         `json:"geometry"`
	Bbox     []float64   `json:"bbox"`
	Lower    any         `json:"lower"`
	Upper    any         `json:"upper"`
	Hours    []hoursJSON `json:"hours,omitempty"`
}

// hoursJSON is one daily window, its ends as an activation's.
type hoursJSON struct {
	From    string `json:"from,omitempty"`
	To      string `json:"to,omitempty"`
	SunFrom string `json:"sunFrom,omitempty"`
	SunTo   string `json:"sunTo,omitempty"`
}

func exclusionsJSON(es []exclusion) []exclusionJSON {
	if len(es) == 0 {
		return nil
	}
	out := make([]exclusionJSON, len(es))
	for i, e := range es {
		var hours []hoursJSON
		for _, w := range e.hours {
			a := windowActivation(w)
			hours = append(hours, hoursJSON{From: a.from, To: a.to, SunFrom: a.sunFrom, SunTo: a.sunTo})
		}
		out[i] = exclusionJSON{
			Name: e.name, Geometry: geomJSON(e.geom), Bbox: e.bbox,
			Lower: tripleOrNull(e.lower), Upper: tripleOrNull(e.upper), Hours: hours,
		}
	}
	return out
}

func excludedJSONs(es []excludedAirspace) []excludedJSON {
	if len(es) == 0 {
		return nil
	}
	out := make([]excludedJSON, len(es))
	for i, e := range es {
		out[i] = excludedJSON{ID: e.id, Zone: e.zone, WhenActive: e.whenActive}
	}
	return out
}

func zonesJSON(zs []zone) []zoneJSON {
	out := make([]zoneJSON, len(zs))
	for i, z := range zs {
		out[i] = zoneJSON{
			Name:           z.name,
			Geometry:       geomJSON(z.geom),
			Bbox:           z.bbox,
			Lower:          tripleOrNull(z.lower),
			Upper:          tripleOrNull(z.upper),
			GeometrySource: z.source,
			Activations:    activationsJSON(z.activations),
			Standing:       standingsJSON(z.standing),
			SameAs:         z.sameAs,
			Exclusions:     exclusionsJSON(z.exclusions),
			Excluded:       excludedJSONs(z.excluded),
		}
	}
	return out
}

// standingsJSON writes a zone's standing rules, a rule printed in summer
// UTC ("(HIV +1HR)") as its winter hours held earlier in summer.
func standingsJSON(as []activation) []standingJSON {
	if len(as) == 0 {
		return nil
	}
	out := make([]standingJSON, len(as))
	for i, a := range as {
		if a.season == winterLater {
			a = hourLater(a)
		}
		out[i] = standingJSON{
			From: a.from, To: a.to,
			Days: a.days.isoDays(), ExceptHolidays: a.exceptHolidays, ExceptHolidayEves: a.exceptEves,
			SunFrom: a.sunFrom, SunTo: a.sunTo,
			SummerEarlier: a.season != noSeason,
			Mode:          a.status.mode, NoticeMin: a.status.noticeMin,
		}
		if out[i].Mode == modeFirm {
			out[i].Mode = ""
		}
	}
	return out
}

func activationsJSON(as []activation) []activationJSON {
	if len(as) == 0 {
		return nil
	}
	out := make([]activationJSON, len(as))
	for i, a := range as {
		out[i] = activationJSON{
			Date: a.date, DateTo: a.dateTo, From: a.from, To: a.to,
			Days: a.days.isoDays(), ExceptHolidays: a.exceptHolidays, ExceptHolidayEves: a.exceptEves,
			SunFrom: a.sunFrom, SunTo: a.sunTo,
			Mode: a.status.mode, NoticeMin: a.status.noticeMin,
		}

	}
	return out
}

// contactJSON is one "Activité réelle connue de" radio entry in a row's
// "contacts" array: a control unit and the frequencies to reach it on. note
// holds a non-numeric value ("fréquences de contrôle") when the SUP gives one.
type contactJSON struct {
	Unit  string   `json:"unit"`
	Freqs []string `json:"freqs"`
	Note  string   `json:"note,omitempty"`
	Users bool     `json:"users,omitempty"`
}

// penetrationJSON is the row's "penetration" object (or null): the rule kind
// plus the verbatim rule text. refused is present, and true, when the
// supplement prints a rule this parser would not publish; text is then "",
// and the panel says so instead of letting the tag stand for the whole rule.
type penetrationJSON struct {
	Kind    string `json:"kind"`
	Text    string `json:"text"`
	Refused bool   `json:"refused,omitempty"`
}

// phoneJSON is one entry of a row's "phones" array: the role of the
// section it is printed in, the label beside it, and its numbers.
type phoneJSON struct {
	Role    string   `json:"role"`
	Label   string   `json:"label,omitempty"`
	Numbers []string `json:"numbers"`
}

func phonesJSON(ps []phoneEntry) []phoneJSON {
	out := make([]phoneJSON, len(ps))
	for i, p := range ps {
		out[i] = phoneJSON{Role: p.role, Label: p.labelText(), Numbers: p.numbers}
	}
	return out
}

func contactsJSON(cs []contactFreq) []contactJSON {
	out := make([]contactJSON, len(cs))
	for i, c := range cs {
		out[i] = contactJSON{Unit: c.unit, Freqs: emptyStrings(c.freqs), Note: c.note, Users: c.users}
	}
	return out
}

func penetrationOrNull(p *penetrationRule) any {
	if p == nil {
		return nil
	}
	return penetrationJSON{Kind: p.kind, Text: p.text, Refused: p.refused}
}

// Meta is fr-supaip.meta.json: provenance plus parse-coverage counts that
// surface how well the PDF extraction is doing this cycle.
type Meta struct {
	GeneratedAt     string         `json:"generatedAt"`
	Source          sourceMeta     `json:"source"`
	Total           int            `json:"total"`
	Active          int            `json:"active"`
	Upcoming        int            `json:"upcoming"`
	WithGeometry    int            `json:"withGeometry"`
	WithVertical    int            `json:"withVertical"`
	WithEnglish     int            `json:"withEnglish"`
	WithContacts    int            `json:"withContacts"`
	WithPenetration int            `json:"withPenetration"`
	WithManager     int            `json:"withManager"`
	WithPhones      int            `json:"withPhones"`
	Polygon         int            `json:"polygon"`
	Circle          int            `json:"circle"`
	Mixed           int            `json:"mixed"`
	None            int            `json:"none"`
	ByRegion        map[string]int `json:"byRegion"`
	PdfFetched      int            `json:"pdfFetched"`
	PdfCached       int            `json:"pdfCached"`
	ParseErrors     int            `json:"parseErrors"`
	PopplerFallback int            `json:"popplerFallback"`
	// Retained counts the supplements carried forward from the previous
	// artefact because the SIA no longer lists them. They are included in
	// Total and in the dataset counters, but not in the fetch / parse ones:
	// this run neither downloaded nor re-parsed them.
	Retained      int `json:"retained"`
	ParserVersion int `json:"parserVersion"`
}

type sourceMeta struct {
	Site    string `json:"site"`
	PdfBase string `json:"pdfBase"`
	// ListingShas fingerprints each region's listing by its PARSED rows and
	// not by the bytes of the page that carried them (listingFingerprint).
	// The CMS rewrites that page on every request, so the raw hash moved
	// whether or not a supplement had.
	ListingShas map[string]string `json:"listingShas,omitempty"`
}

// emptyStrings returns s, or a non-nil empty slice so json.Marshal emits [].
func emptyStrings(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}
