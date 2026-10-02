// adcharts.go writes es-adcharts.json (`-only adcharts`, network only, no
// -in): the charts of every aerodrome and heliport in AIP Spain, read off
// ENAIRE's AIP viewer page (aip.enaire.es/AIP/AIP-en.html), which carries
// the whole edition in force as one document. A field is a section,
// anchored and headed by its location indicators ("LEMD", or "LECU/LEVS"
// for two fields one entry serves), whose table lists the aerodrome data
// ("AD 2 LEMD"), the obstacle list ("AD 2 10 LEMD") and one row per chart,
// named by ENAIRE's own family code ("AD 2 LEMD ADC 1", "AD 2 LEBL GMC 1.1",
// "AD 2 LEAB ARR DEP 1") and linking the chart's PDF.
//
// The chart files are undated ("contenido_AIP/AD/AD2/LEMD/..._ADC_1_en.pdf")
// and always serve the edition in force, so the index has one slot. It is
// in at-adcharts.json's shape, read by $lib/data/aipCharts like the eAIP
// States' indexes, which finds an index by the aerodrome's location
// indicator series: the index covers Spain's own (LE, GC, GE), and the
// viewer's three entries outside them (LXGB, GSAI, GSVO) are left out and
// named in the meta. LINKS only: no chart is copied.

package main

import (
	"context"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/eaip"
	"golang.org/x/net/html"
)

// esViewerPage is the viewer page in English.
const esViewerPage = esAipBase + "AIP-en.html"

// defaultMinEsAdcharts is the sanity floor: AIP Spain publishes 72 fields
// (2026-09), so a page yielding far fewer changed its layout.
const defaultMinEsAdcharts = 40

// esAdChartsArtifact is at-adcharts.json's shape.
type esAdChartsArtifact struct {
	Fields      []string `json:"fields"`
	ChartFields []string `json:"chartFields"`
	Edition     string   `json:"edition"`
	Base        string   `json:"base"`
	Rows        []any    `json:"rows"`
}

// esAdChartsMeta is the sidecar; generatedAt lives here alone, so an
// unchanged edition yields a byte-identical artifact.
type esAdChartsMeta struct {
	GeneratedAt string         `json:"generatedAt"`
	Source      string         `json:"source"`
	Effective   string         `json:"effective"`
	Edition     string         `json:"edition"`
	Base        string         `json:"base"`
	Aerodromes  int            `json:"aerodromes"`
	Heliports   int            `json:"heliports"`
	WithCharts  int            `json:"withCharts"`
	WithVAC     int            `json:"withVac"`
	Charts      int            `json:"charts"`
	ByFamily    map[string]int `json:"byFamily"`
	LinkCheck   string         `json:"linkCheck"`
	// OutsideSeries names the entries left out for their series.
	OutsideSeries []string `json:"outsideSeries,omitempty"`
}

// esField is one field the viewer lists, with its charts.
type esField struct {
	idents []string
	part   int
	ad     string
	charts [][3]string
}

// esEditionRe reads the viewer's statement of its edition: "03-SEP-26
// (Incorporados AIRAC 08/26 and AMDT 410/26)".
var esEditionRe = regexp.MustCompile(`(\d{2}-[A-Z]{3}-\d{2})\s*\((?:Incorporados\s+)?([^)]*)\)`)

// esDay reads the viewer's "03-SEP-26".
func esDay(s string) (time.Time, error) {
	if len(s) != 9 {
		return time.Time{}, fmt.Errorf("date %q", s)
	}
	return time.Parse("02-Jan-06", s[:4]+strings.ToLower(s[4:6])+s[6:])
}

// esIdentRe is a location indicator in a section's anchor.
var esIdentRe = regexp.MustCompile(`^[A-Z]{4}$`)

// esSeriesRe is a location indicator of Spain's own series: the
// mainland and the Balearics, the Canaries, Ceuta and Melilla.
var esSeriesRe = regexp.MustCompile(`^(?:LE|GC|GE)[A-Z]{2}$`)

// esRowNumberRe is a chart's number within its family ("1", "1.1").
var esRowNumberRe = regexp.MustCompile(`^\d+(?:\.\d+)*$`)

// esChartFamilies maps ENAIRE's row codes onto the families the app
// groups by. The codes ICAO's chart catalogue does not define (DEP, ARR,
// ARR/DEP, CARR, CDEP, CDA, TRAN, VPT) stay MISC under their own titles
// rather than be filed with a family they only resemble.
var esChartFamilies = map[string]string{
	"VAC":     "VAC",
	"ADC":     "ADC",
	"HELC":    "ADC",
	"PDC":     "APDC",
	"GMC":     "GMC",
	"AOC":     "AOC",
	"PATC":    "PATC",
	"SID":     "SID",
	"STAR":    "STAR",
	"IAC":     "IAC",
	"ATCSMAC": "ATCSMAC",
}

// parseEsViewer reads the viewer page into its fields, and the edition it
// states.
func parseEsViewer(page []byte) (fields []esField, effective, edition string, err error) {
	doc, err := eaip.ParseHTML(page)
	if err != nil {
		return nil, "", "", err
	}
	var cur *esField
	var walk func(n *html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode {
			switch {
			case n.Data == "div" && eaip.Attr(n, "id") == "actualizado":
				if m := esEditionRe.FindStringSubmatch(eaip.NodeText(n)); m != nil {
					if t, err := esDay(m[1]); err == nil {
						effective = t.Format("2006-01-02") + "T00:00:00.000Z"
					}
					edition = strings.TrimSpace(m[2])
				}
			case n.Data == "a" && strings.Contains(eaip.Attr(n, "class"), "anclaSeccion"):
				cur = nil
				path := eaip.Attr(n, "migapan")
				part := 0
				switch {
				case strings.Contains(path, "#AD 2'"):
					part = 2
				case strings.Contains(path, "#AD 3'"):
					part = 3
				}
				idents := strings.Split(eaip.Attr(n, "id"), "/")
				ok := part != 0
				for _, id := range idents {
					ok = ok && esIdentRe.MatchString(id)
				}
				if ok {
					fields = append(fields, esField{idents: idents, part: part})
					cur = &fields[len(fields)-1]
				}
			case n.Data == "tr" && cur != nil:
				readEsRow(n, cur)
				return
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(doc)
	if effective == "" {
		return nil, "", "", fmt.Errorf("the viewer page states no edition")
	}
	return fields, effective, edition, nil
}

// readEsRow reads one row of a field's table: the aerodrome data, which
// is the field's page, or a chart; the obstacle list is neither.
func readEsRow(tr *html.Node, f *esField) {
	var id, desc, pdf, htmlPage string
	for _, td := range eaip.Elems(tr, "td") {
		switch eaip.Attr(td, "class") {
		case "id":
			id = eaip.NormSpace(eaip.NodeText(td))
		case "desc":
			desc = eaip.NormSpace(eaip.NodeText(td))
		case "iconos":
			for _, a := range eaip.Elems(td, "a") {
				switch eaip.Attr(a, "title") {
				case "pdf":
					pdf = eaip.Attr(a, "href")
				case "html":
					htmlPage = eaip.Attr(a, "href")
				}
			}
		}
	}
	tokens := strings.Fields(id)
	if len(tokens) < 2 || tokens[0] != "AD" {
		return
	}
	tokens = tokens[2:]
	for _, ident := range f.idents {
		if len(tokens) == 0 || tokens[0] != ident {
			// An item of the field, "AD 2 10 LEMD", not a chart.
			return
		}
		tokens = tokens[1:]
	}
	if len(tokens) == 0 {
		// The aerodrome data: its HTML page, else its PDF.
		f.ad = htmlPage
		if f.ad == "" {
			f.ad = pdf
		}
		return
	}
	if pdf == "" || len(tokens) < 2 || !esRowNumberRe.MatchString(tokens[len(tokens)-1]) {
		return
	}
	code := strings.Join(tokens[:len(tokens)-1], " ")
	family, ok := esChartFamilies[code]
	if !ok {
		family = "MISC"
	}
	title := desc
	if title == "" {
		title = strings.Join(tokens, " ")
	}
	f.charts = append(f.charts, [3]string{family, title, pdf})
}

// buildEsAdCharts fetches the viewer page and writes the index.
func buildEsAdCharts(outDir, target string, now func() time.Time, minN int) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	page, err := newEsFetcher().get(ctx, esViewerPage)
	if err != nil {
		return err
	}
	fields, effective, edition, err := parseEsViewer(page)
	if err != nil {
		return err
	}
	meta := esAdChartsMeta{
		Source:    "ENAIRE AIP Spain viewer, " + edition,
		Effective: effective,
		Edition:   edition,
		Base:      esAipBase,
		ByFamily:  map[string]int{},
	}
	var rows []any
	var sample []string
	for _, f := range fields {
		outside := false
		for _, ident := range f.idents {
			outside = outside || !esSeriesRe.MatchString(ident)
		}
		if outside {
			meta.OutsideSeries = append(meta.OutsideSeries, f.idents...)
			continue
		}
		charts := make([]any, 0, len(f.charts))
		vac := false
		for _, c := range f.charts {
			charts = append(charts, []string{c[0], c[1], c[2]})
			vac = vac || c[0] == "VAC"
		}
		// Two fields one entry serves each get the entry's row.
		for _, ident := range f.idents {
			rows = append(rows, []any{ident, f.ad, charts})
			if f.part == 3 {
				meta.Heliports++
			} else {
				meta.Aerodromes++
			}
			if len(f.charts) > 0 {
				meta.WithCharts++
			}
			if vac {
				meta.WithVAC++
			}
		}
		for _, c := range f.charts {
			meta.ByFamily[c[0]]++
			sample = append(sample, esAipBase+c[2])
		}
		meta.Charts += len(f.charts)
	}
	if minN <= 0 {
		minN = defaultMinEsAdcharts
	}
	if len(rows) < minN {
		return fmt.Errorf("es-adcharts: %d fields, fewer than %d; the viewer's layout may have changed", len(rows), minN)
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].([]any)[0].(string) < rows[j].([]any)[0].(string) })
	ok, tried := checkEsLinks(ctx, sample)
	meta.LinkCheck = fmt.Sprintf("%d/%d", ok, tried)
	if tried > 0 && ok*2 < tried {
		return fmt.Errorf("es-adcharts: chart links do not resolve (%d of %d sampled answered); nothing written", ok, tried)
	}
	meta.GeneratedAt = now().UTC().Format("2006-01-02T15:04:05.000Z")
	artifact := esAdChartsArtifact{
		Fields:      []string{"icao", "ad", "charts"},
		ChartFields: []string{"code", "title", "path"},
		Edition:     edition,
		Base:        esAipBase,
		Rows:        rows,
	}
	slot, err := aip.WriteDataset(outDir, "es-adcharts", target, effective, artifact, meta)
	if err != nil {
		return err
	}
	fmt.Printf("wrote %d aerodromes, %d heliports, %d charts (%d with a VAC, links %s); effective %s; slot=%s\n",
		meta.Aerodromes, meta.Heliports, meta.Charts, meta.WithVAC, meta.LinkCheck, effective, slot)
	return nil
}

// esLinkSample is how many chart links a build checks.
const esLinkSample = 6

// checkEsLinks fetches the head of a random sample of chart links and
// counts those answering with a PDF, so a moved tree fails the build
// instead of shipping dead links.
func checkEsLinks(ctx context.Context, urls []string) (ok, tried int) {
	pick := append([]string(nil), urls...)
	sort.Strings(pick)
	r := rand.New(rand.NewSource(int64(len(pick))))
	r.Shuffle(len(pick), func(i, j int) { pick[i], pick[j] = pick[j], pick[i] })
	if len(pick) > esLinkSample {
		pick = pick[:esLinkSample]
	}
	client := &http.Client{Timeout: 60 * time.Second}
	for _, u := range pick {
		tried++
		if esLinkAnswers(ctx, client, u) {
			ok++
		} else {
			fmt.Printf("es-adcharts: chart link does not answer: %s\n", u)
		}
	}
	return ok, tried
}

func esLinkAnswers(ctx context.Context, client *http.Client, u string) bool {
	if _, err := url.Parse(u); err != nil {
		return false
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return false
	}
	req.Header.Set("User-Agent", esUserAgent)
	req.Header.Set("Range", "bytes=0-1023")
	res, err := client.Do(req)
	if err != nil {
		return false
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK && res.StatusCode != http.StatusPartialContent {
		return false
	}
	head := make([]byte, 5)
	n, _ := io.ReadFull(res.Body, head)
	return n == 5 && string(head) == "%PDF-"
}
