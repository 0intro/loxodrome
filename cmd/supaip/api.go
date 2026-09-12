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
	// The designators whose published lateral limits the zone adopts, for a
	// zone stated "Identiques à celles de la zone LF-D5" with no coordinates
	// of its own.
	SameAs string `json:"sameAs,omitempty"`
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
			SameAs:         z.sameAs,
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
		out[i] = activationJSON{Date: a.date, DateTo: a.dateTo, From: a.from, To: a.to}
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
}

// penetrationJSON is the row's "penetration" object (or null): the rule kind
// plus the verbatim rule text.
type penetrationJSON struct {
	Kind string `json:"kind"`
	Text string `json:"text"`
}

func contactsJSON(cs []contactFreq) []contactJSON {
	out := make([]contactJSON, len(cs))
	for i, c := range cs {
		out[i] = contactJSON{Unit: c.unit, Freqs: emptyStrings(c.freqs), Note: c.note}
	}
	return out
}

func penetrationOrNull(p *penetrationRule) any {
	if p == nil {
		return nil
	}
	return penetrationJSON{Kind: p.kind, Text: p.text}
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
	Site        string            `json:"site"`
	PdfBase     string            `json:"pdfBase"`
	ListingShas map[string]string `json:"listingShas,omitempty"`
}

// emptyStrings returns s, or a non-nil empty slice so json.Marshal emits [].
func emptyStrings(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}
