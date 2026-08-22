// eaip.go reads the Austro Control digital AIP: the edition table on the
// landing page, the AD 2 / AD 3 aerodrome indexes, and the per-aerodrome
// chart pages.
//
// The eAIP tree lives under a per-edition dated path with no stable alias
// (https://eaip.austrocontrol.at/lo/<YYMMDD>/), and a superseded edition
// is withdrawn, so a stored absolute URL lives exactly one cycle. Two
// editions are online at any time, the one in force and the one that
// follows it, which is what lets cmd/at fill both the current and the
// .next dataset slot and hand the app a link that stays live across the
// changeover.
//
// The pages are ISO-8859-1 with no charset declaration, so every one of
// them is decoded through latin1 before parsing.

package main

import (
	"context"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"golang.org/x/net/html"
)

const (
	eaipBase = "https://eaip.austrocontrol.at/"
	// eaipEditionPath is the per-edition directory under eaipBase.
	eaipEditionPath = "lo/"
)

// Edition is one published AIP edition: the dated path segment plus the
// validity the landing page states for it.
type Edition struct {
	Segment string // "260710"
	From    string // ISO-8601 midnight, aip.ResolveTarget's format
	Until   string // ISO date, or "" for UFN
}

// Base returns the edition's URL prefix, the base every stored chart path
// resolves against.
func (e Edition) Base() string {
	return eaipBase + eaipEditionPath + e.Segment + "/"
}

// adEntry is one aerodrome of an AD 2 / AD 3 index.
type adEntry struct {
	ICAO string
	// Section is 2 for aerodromes, 3 for heliports.
	Section int
	// ADPath is the edition-relative path of the AD text PDF, published
	// for every aerodrome of the index.
	ADPath string
	// ChartsPage is the edition-relative charts page, published for the
	// minority of aerodromes that have charts.
	ChartsPage string
}

// chartRef is one published chart: Code is the family the ICAO Annex 4
// chart number resolves to (IAC / SID / ADC / ...), Title the published
// description, Path the edition-relative href.
type chartRef struct {
	Code  string
	Title string
	Path  string
}

// latin1 decodes an ISO-8859-1 page into a UTF-8 string. Every byte of
// that encoding is one code point, so the conversion is a widening.
func latin1(b []byte) string {
	runes := make([]rune, len(b))
	for i, c := range b {
		runes[i] = rune(c)
	}
	return string(runes)
}

func parsePage(b []byte) (*html.Node, error) {
	return html.Parse(strings.NewReader(latin1(b)))
}

var monthNum = map[string]string{
	"JAN": "01", "FEB": "02", "MAR": "03", "APR": "04", "MAY": "05", "JUN": "06",
	"JUL": "07", "AUG": "08", "SEP": "09", "OCT": "10", "NOV": "11", "DEC": "12",
}

// editionDateRe matches the validity dates of the landing page table,
// "10 JUL 2026".
var editionDateRe = regexp.MustCompile(`(\d{1,2})\s+([A-Z]{3})\s+(\d{4})`)

// editionSegmentRe matches the dated path segment of an edition link,
// "./lo/260710/index.htm".
var editionSegmentRe = regexp.MustCompile(`lo/(\d{6})/`)

// isoDate turns "10 JUL 2026" into "2026-07-10"; empty when the text
// carries no parseable date (the open-ended "UFN" of the future edition).
func isoDate(s string) string {
	m := editionDateRe.FindStringSubmatch(strings.ToUpper(s))
	if m == nil {
		return ""
	}
	mon, ok := monthNum[m[2]]
	if !ok {
		return ""
	}
	return fmt.Sprintf("%s-%s-%02s", m[3], mon, m[1])
}

// ParseEditions reads the landing page's edition table. Rows come back in
// publication order, the edition in force first.
func ParseEditions(doc *html.Node) []Edition {
	var out []Edition
	seen := map[string]bool{}
	for _, row := range elements(doc, "tr") {
		cells := elements(row, "td")
		if len(cells) < 2 {
			continue
		}
		var seg string
		for _, a := range elements(row, "a") {
			if m := editionSegmentRe.FindStringSubmatch(attrOf(a, "href")); m != nil {
				seg = m[1]
				break
			}
		}
		if seg == "" || seen[seg] {
			continue
		}
		from := isoDate(textOf(cells[0]))
		if from == "" {
			continue
		}
		seen[seg] = true
		out = append(out, Edition{
			Segment: seg,
			From:    from + "T00:00:00.000Z",
			Until:   isoDate(textOf(cells[1])),
		})
	}
	return out
}

// SelectEditions picks the two editions the app has slots for: the one
// in force at now, and the one that takes effect after it. Austro Control
// publishes several editions ahead, occasionally a one-day one (06 AUG
// 2026 is valid for its own date alone, replaced on the 7th), so the
// choice follows the stated validity rather than the listing order. The
// weekly refresh re-slots both, which is what keeps the pair aligned
// across a short edition.
func SelectEditions(editions []Edition, now time.Time) (current, next *Edition) {
	sorted := append([]Edition{}, editions...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].From < sorted[j].From })
	stamp := now.UTC().Format("2006-01-02") + "T00:00:00.000Z"
	for i := range sorted {
		if sorted[i].From <= stamp {
			current = &sorted[i]
			continue
		}
		next = &sorted[i]
		break
	}
	if current == nil && len(sorted) > 0 {
		current = &sorted[0]
		if len(sorted) > 1 {
			next = &sorted[1]
		}
	}
	return current, next
}

var (
	// adPdfRe matches an AD text PDF href, keeping the aerodrome code:
	// "PART_3/AD_2/PRI/AD_2_LOWW/LO_AD_2_LOWW_en.pdf". The PRI / SRY
	// split is the publisher's own grouping of international against
	// secondary aerodromes and cannot be derived from the code, which is
	// why the path is stored rather than rebuilt.
	adPdfRe = regexp.MustCompile(`(?i)^PART_3/AD_(\d)/.*/LO_AD_\d_([A-Z]{4})_[a-z]{2}\.pdf$`)
	// adChartsPageRe matches a per-aerodrome charts page, "ad_2_loww.htm".
	adChartsPageRe = regexp.MustCompile(`(?i)^ad_(\d)_([a-z]{4})\.htm$`)
	// chartPdfRe matches one chart file, "Charts/LOWW/LO_AD_2_LOWW_1-1_en.pdf",
	// keeping the ICAO Annex 4 chart number.
	chartPdfRe = regexp.MustCompile(`(?i)/LO_AD_\d_[A-Z]{4}_([\d-]+)_[a-z]{2}\.pdf$`)
)

// ParseADIndex reads one AD 2 / AD 3 index page into its aerodrome
// entries, in publication order. An aerodrome is listed by its text PDF;
// the charts page beside it is optional.
func ParseADIndex(doc *html.Node) []adEntry {
	var out []adEntry
	byICAO := map[string]int{}
	for _, a := range elements(doc, "a") {
		href := strings.TrimSpace(attrOf(a, "href"))
		if m := adPdfRe.FindStringSubmatch(href); m != nil {
			icao := strings.ToUpper(m[2])
			if _, dup := byICAO[icao]; dup {
				continue
			}
			byICAO[icao] = len(out)
			out = append(out, adEntry{ICAO: icao, Section: atoiSafe(m[1]), ADPath: escapePath(href)})
			continue
		}
		if m := adChartsPageRe.FindStringSubmatch(href); m != nil {
			icao := strings.ToUpper(m[2])
			if i, ok := byICAO[icao]; ok {
				out[i].ChartsPage = href
			}
		}
	}
	return out
}

// ParseChartsPage reads one per-aerodrome charts page. Each row links the
// chart file and states its description in German, with the English
// wording in italics beside it; the English half is kept where published,
// the app being English and French.
func ParseChartsPage(doc *html.Node) []chartRef {
	var out []chartRef
	for _, row := range elements(doc, "tr") {
		cells := elements(row, "td")
		if len(cells) < 2 {
			continue
		}
		links := elements(cells[0], "a")
		if len(links) == 0 {
			continue
		}
		href := strings.TrimSpace(attrOf(links[0], "href"))
		m := chartPdfRe.FindStringSubmatch(href)
		if m == nil {
			continue
		}
		title := textOf(cells[1])
		if en := elements(cells[1], "i"); len(en) > 0 {
			if v := textOf(en[0]); v != "" {
				title = v
			}
		}
		out = append(out, chartRef{
			Code:  chartFamily(m[1]),
			Title: title,
			Path:  escapePath(href),
		})
	}
	return out
}

/* ---- HTML helpers ---------------------------------------------------- */

// elements returns every descendant element of n with the given tag, in
// document order.
func elements(n *html.Node, tag string) []*html.Node {
	var out []*html.Node
	var walk func(*html.Node)
	walk = func(cur *html.Node) {
		for c := cur.FirstChild; c != nil; c = c.NextSibling {
			if c.Type == html.ElementNode && c.Data == tag {
				out = append(out, c)
			}
			walk(c)
		}
	}
	walk(n)
	return out
}

func attrOf(n *html.Node, name string) string {
	for _, a := range n.Attr {
		if strings.EqualFold(a.Key, name) {
			return a.Val
		}
	}
	return ""
}

// textOf joins the text of a subtree with single spaces.
func textOf(n *html.Node) string {
	var b strings.Builder
	var walk func(*html.Node)
	walk = func(cur *html.Node) {
		for c := cur.FirstChild; c != nil; c = c.NextSibling {
			if c.Type == html.TextNode {
				b.WriteString(c.Data)
				b.WriteByte(' ')
			}
			walk(c)
		}
	}
	walk(n)
	return strings.Join(strings.Fields(b.String()), " ")
}

// escapePath percent-encodes each segment of a stored path. A fifth of
// the chart directories carry a space in their name
// ("Charts/SECONDARY_ LOAV/"), which browsers encode on their own but a
// plain string concatenation hands on verbatim, so the dataset stores the
// encoded form and every consumer gets a valid URL.
func escapePath(href string) string {
	parts := strings.Split(href, "/")
	for i, p := range parts {
		parts[i] = url.PathEscape(p)
	}
	return strings.Join(parts, "/")
}

func atoiSafe(s string) int {
	n := 0
	for _, r := range s {
		if r < '0' || r > '9' {
			return n
		}
		n = n*10 + int(r-'0')
	}
	return n
}

/* ---- acquisition ------------------------------------------------------ */

// eaipTree is one acquired edition: its pages keyed by the name they are
// published under, relative to the edition base.
type eaipTree struct {
	edition Edition
	pages   map[string][]byte
}

func (t *eaipTree) doc(name string) (*html.Node, error) {
	data, ok := t.pages[name]
	if !ok {
		return nil, fmt.Errorf("%s: page missing", name)
	}
	return parsePage(data)
}

const (
	eaipIndexPage = "index.htm"
	ad2IndexPage  = "ad_2.htm"
	ad3IndexPage  = "ad_3.htm"
)

// acquireEaipLive fetches the landing page and every page of the editions
// it lists. snapshotDir, when non-empty, receives all of them under
// eaip/<edition>/.
func acquireEaipLive(ctx context.Context, f *fetcher, snapshotDir string, now func() time.Time) ([]*eaipTree, error) {
	landing, err := f.get(ctx, eaipBase)
	if err != nil {
		return nil, fmt.Errorf("eAIP landing page: %w", err)
	}
	if err := snapshotWrite(snapshotDir, filepath.Join("eaip", eaipIndexPage), landing); err != nil {
		return nil, err
	}
	doc, err := parsePage(landing)
	if err != nil {
		return nil, err
	}
	editions := ParseEditions(doc)
	if len(editions) == 0 {
		return nil, fmt.Errorf("eAIP landing page lists no edition")
	}
	current, next := SelectEditions(editions, now())
	wanted := []Edition{*current}
	if next != nil {
		wanted = append(wanted, *next)
	}

	var out []*eaipTree
	for _, ed := range wanted {
		t := &eaipTree{edition: ed, pages: map[string][]byte{}}
		fetch := func(name string) error {
			data, err := f.get(ctx, ed.Base()+name)
			if err != nil {
				return err
			}
			t.pages[name] = data
			return snapshotWrite(snapshotDir, filepath.Join("eaip", ed.Segment, name), data)
		}
		for _, name := range []string{ad2IndexPage, ad3IndexPage} {
			if err := fetch(name); err != nil {
				return nil, fmt.Errorf("%s %s: %w", ed.Segment, name, err)
			}
			doc, err := t.doc(name)
			if err != nil {
				return nil, err
			}
			for _, e := range ParseADIndex(doc) {
				if e.ChartsPage == "" {
					continue
				}
				if err := fetch(e.ChartsPage); err != nil {
					return nil, fmt.Errorf("%s %s: %w", ed.Segment, e.ChartsPage, err)
				}
			}
		}
		out = append(out, t)
	}
	return out, nil
}

func snapshotWrite(dir, name string, data []byte) error {
	if dir == "" {
		return nil
	}
	path := filepath.Join(dir, name)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

// acquireEaipOffline reads a snapshot back: eaip/index.htm states the
// editions, eaip/<edition>/ holds their pages.
func acquireEaipOffline(dir string, now func() time.Time) ([]*eaipTree, error) {
	root := filepath.Join(dir, "eaip")
	landing, err := os.ReadFile(filepath.Join(root, eaipIndexPage))
	if err != nil {
		return nil, fmt.Errorf("eAIP snapshot: %w", err)
	}
	doc, err := parsePage(landing)
	if err != nil {
		return nil, err
	}
	editions := ParseEditions(doc)
	if len(editions) == 0 {
		return nil, fmt.Errorf("%s lists no edition", filepath.Join(root, eaipIndexPage))
	}

	current, next := SelectEditions(editions, now())
	wanted := []Edition{*current}
	if next != nil {
		wanted = append(wanted, *next)
	}

	var out []*eaipTree
	for _, ed := range wanted {
		t := &eaipTree{edition: ed, pages: map[string][]byte{}}
		base := filepath.Join(root, ed.Segment)
		err := filepath.WalkDir(base, func(path string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() || !strings.HasSuffix(strings.ToLower(d.Name()), ".htm") {
				return err
			}
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			rel, err := filepath.Rel(base, path)
			if err != nil {
				return err
			}
			t.pages[filepath.ToSlash(rel)] = data
			return nil
		})
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return nil, err
		}
		if len(t.pages) > 0 {
			out = append(out, t)
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("%s holds no edition pages", root)
	}
	return out, nil
}
