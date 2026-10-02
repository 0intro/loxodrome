// adcharts.go writes dk-adcharts.json, in at-adcharts.json's shape so the
// app reads it like the eAIP States' indexes ($lib/data/aipCharts).
//
// Naviair's AIM page is an AngularJS tree over one endpoint,
// /umbraco/api/naviairapi/getnodesforparent?parentId=<id>, answering a
// node's children: directories, and documents whose href is the PDF
// (/media/files/<id>/<name>.pdf, a new id for each new edition of a
// file). The root lists the publications ("01. AIP Danmark", "02. VFR
// Flight Guide Danmark", "03. AIP Færøerne", "04. AIP Grønland"), each
// with its aerodromes part ("... (AD)"), under which every field is a
// directory titled by its name and location indicator ("Billund - EKBI",
// "Ilulissat (BGJN)") holding numbered documents: "01. EKBI Text", then
// its charts ("02. AD 2 EKBI VAC", "12. EKBI SID (RNAV) RWY 09 - 1").
//
// The VFR Flight Guide is read first: it is where the visual approach
// charts are, for its 32 aerodromes, the AIP adding the instrument charts
// of the 13 it also publishes. A chart two publications both carry (the
// same file name) is kept once. LINKS only: no chart is copied.

package main

import (
	"context"
	"encoding/json"
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
)

const (
	dkSite      = "https://aim.naviair.dk"
	dkNodesAPI  = dkSite + "/umbraco/api/naviairapi/getnodesforparent?parentId="
	dkMediaBase = dkSite + "/media/files/"
	dkUserAgent = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0"
)

// defaultMinDkFields is the sanity floor: the four publications carry 56
// fields (2026-09), so a tree yielding far fewer changed its layout.
const defaultMinDkFields = 35

// dkPublications are the publications read, in the order their charts
// are merged, by the name each root directory carries.
var dkPublications = []string{
	"VFR Flight Guide Danmark",
	"AIP Danmark",
	"AIP Færøerne",
	"AIP Grønland",
}

// dkNode is one node the API answers.
type dkNode struct {
	ID          int     `json:"id"`
	Name        string  `json:"name"`
	Title       string  `json:"title"`
	IsDir       bool    `json:"isDir"`
	Href        *string `json:"href"`
	HasChildren bool    `json:"hasChildren"`
}

type dkAdChartsArtifact struct {
	Fields      []string `json:"fields"`
	ChartFields []string `json:"chartFields"`
	Edition     string   `json:"edition"`
	Base        string   `json:"base"`
	Rows        []any    `json:"rows"`
}

type dkAdChartsMeta struct {
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
	MiscTitles  []string       `json:"miscTitles,omitempty"`
	LinkCheck   string         `json:"linkCheck"`
}

// dkField is one field, merged across the publications.
type dkField struct {
	icao   string
	heli   bool
	ad     string
	charts [][3]string
	seen   map[string]bool
}

// dkFieldTitleRe reads a field's directory title: "Billund - EKBI",
// "Ilulissat (BGJN)", "Heliport Bornholms Hospital - EKRB".
var dkFieldTitleRe = regexp.MustCompile(`^(.*?)\s*(?:-\s*([A-Z]{4})|\(([A-Z]{4})\))\s*$`)

// dkDocTitleRe strips a document's number and part: "02. AD 2 EKAT VAC",
// "17: SUP ...", "01. EKBI Text".
var dkDocTitleRe = regexp.MustCompile(`^\s*\d+\s*[.:]\s*(?:AD\s*[234]\s+)?(.*)$`)

// dkEditionRe reads the AIRAC edition off the whole publication's file
// name ("AIP_DK_AIRAC_AMDT_03SEP2026_SUP_07SEP2026.pdf").
var dkEditionRe = regexp.MustCompile(`AIRAC_AMDT_(\d{2}[A-Z]{3}\d{4})`)

// dkDay reads "03SEP2026".
func dkDay(s string) (time.Time, error) {
	if len(s) != 9 {
		return time.Time{}, fmt.Errorf("date %q", s)
	}
	return time.Parse("02Jan2006", s[:3]+strings.ToLower(s[3:5])+s[5:])
}

// dkPartRe is a publication's aerodromes part.
var dkPartRe = regexp.MustCompile(`\(AD\)\s*$`)

// dkHeliRe is a directory of heliports.
var dkHeliRe = regexp.MustCompile(`^AD\s*[34]\b.*HELI`)

type dkClient struct {
	c *http.Client
}

func (d *dkClient) nodes(ctx context.Context, parent string) ([]dkNode, error) {
	body, err := d.get(ctx, dkNodesAPI+url.QueryEscape(parent))
	if err != nil {
		return nil, err
	}
	var out []dkNode
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("nodes of %q: %w", parent, err)
	}
	return out, nil
}

func (d *dkClient) get(ctx context.Context, u string) ([]byte, error) {
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			select {
			case <-time.After(time.Duration(attempt) * 2 * time.Second):
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("User-Agent", dkUserAgent)
		req.Header.Set("Accept", "application/json")
		res, err := d.c.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		body, err := io.ReadAll(res.Body)
		res.Body.Close()
		if res.StatusCode == http.StatusOK && err == nil {
			return body, nil
		}
		lastErr = fmt.Errorf("GET %s: HTTP %d", u, res.StatusCode)
	}
	return nil, lastErr
}

// buildDkAdCharts walks the four publications and writes the index.
func buildDkAdCharts(outDir string, now func() time.Time) error {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	d := &dkClient{c: &http.Client{Timeout: 60 * time.Second}}
	root, err := d.nodes(ctx, "")
	if err != nil {
		return err
	}
	fields := map[string]*dkField{}
	// The edition is the latest one a whole-publication file names: the
	// VFG folder also keeps an older test file ("..._06AUG2026_... -
	// TEST.pdf"), listed first.
	var edition string
	var day time.Time
	for _, pub := range dkPublications {
		var node *dkNode
		for i := range root {
			if root[i].IsDir && root[i].Name == pub {
				node = &root[i]
			}
		}
		if node == nil {
			return fmt.Errorf("the tree lists no %q", pub)
		}
		parts, err := d.nodes(ctx, fmt.Sprint(node.ID))
		if err != nil {
			return err
		}
		for _, part := range parts {
			switch {
			case part.IsDir && dkPartRe.MatchString(part.Title):
				if err := d.walkFields(ctx, part, false, fields); err != nil {
					return err
				}
			case part.IsDir && (part.Name == "AIP" || part.Name == "VFG"):
				// The whole publication as one file names its edition.
				docs, err := d.nodes(ctx, fmt.Sprint(part.ID))
				if err != nil {
					return err
				}
				for _, doc := range docs {
					if m := dkEditionRe.FindStringSubmatch(doc.Name); m != nil {
						if t, err := dkDay(m[1]); err == nil && t.After(day) {
							edition, day = m[1], t
						}
					}
				}
			}
		}
	}
	if edition == "" {
		return fmt.Errorf("no publication names its AIRAC edition")
	}
	effective := day.Format("2006-01-02") + "T00:00:00.000Z"

	var list []*dkField
	for _, f := range fields {
		list = append(list, f)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].icao < list[j].icao })
	if len(list) < defaultMinDkFields {
		return fmt.Errorf("%d fields, fewer than %d; the tree's layout may have changed", len(list), defaultMinDkFields)
	}
	meta := dkAdChartsMeta{
		Source:    "Naviair AIM, AIRAC AMDT " + edition,
		Effective: effective,
		Edition:   "AIRAC AMDT " + edition,
		Base:      dkMediaBase,
		ByFamily:  map[string]int{},
	}
	var rows []any
	var sample []string
	for _, f := range list {
		charts := make([]any, 0, len(f.charts))
		vac := false
		for _, c := range f.charts {
			charts = append(charts, []string{c[0], c[1], c[2]})
			meta.ByFamily[c[0]]++
			vac = vac || c[0] == "VAC"
			if c[0] == "MISC" && len(meta.MiscTitles) < 40 {
				meta.MiscTitles = append(meta.MiscTitles, c[1])
			}
			sample = append(sample, dkMediaBase+c[2])
		}
		if f.heli {
			meta.Heliports++
		} else {
			meta.Aerodromes++
		}
		if len(charts) > 0 {
			meta.WithCharts++
		}
		if vac {
			meta.WithVAC++
		}
		meta.Charts += len(charts)
		rows = append(rows, []any{f.icao, f.ad, charts})
	}
	ok, tried := checkDkLinks(ctx, d, sample)
	meta.LinkCheck = fmt.Sprintf("%d/%d", ok, tried)
	if tried > 0 && ok*2 < tried {
		return fmt.Errorf("chart links do not resolve (%d of %d sampled answered); nothing written", ok, tried)
	}
	meta.GeneratedAt = now().UTC().Format("2006-01-02T15:04:05.000Z")
	artifact := dkAdChartsArtifact{
		Fields:      []string{"icao", "ad", "charts"},
		ChartFields: []string{"code", "title", "path"},
		Edition:     meta.Edition,
		Base:        dkMediaBase,
		Rows:        rows,
	}
	slot, err := aip.WriteDataset(outDir, "dk-adcharts", "current", effective, artifact, meta)
	if err != nil {
		return err
	}
	fmt.Printf("dk: wrote %d aerodromes, %d heliports, %d charts (%d with a VAC, links %s); effective %s; slot=%s\n",
		meta.Aerodromes, meta.Heliports, meta.Charts, meta.WithVAC, meta.LinkCheck, effective[:10], slot)
	return nil
}

// walkFields descends an aerodromes part: a directory titled by a field
// is that field; any other directory is descended (AD 2, AD 3), a heliport
// part marking the fields under it.
func (d *dkClient) walkFields(ctx context.Context, dir dkNode, heli bool, fields map[string]*dkField) error {
	kids, err := d.nodes(ctx, fmt.Sprint(dir.ID))
	if err != nil {
		return err
	}
	for _, k := range kids {
		icao := dkFieldIdent(k.Title)
		switch {
		case k.IsDir && icao != "":
			docs, err := d.nodes(ctx, fmt.Sprint(k.ID))
			if err != nil {
				return err
			}
			addDkField(fields, icao, heli, docs)
		case k.IsDir:
			if err := d.walkFields(ctx, k, heli || dkHeliRe.MatchString(k.Title), fields); err != nil {
				return err
			}
		case icao != "" && k.Href != nil:
			// A field published as its text alone ("Frodba (EKFA)").
			addDkField(fields, icao, heli, []dkNode{{Title: "01. " + icao + " Text", Name: k.Name, Href: k.Href}})
		}
	}
	return nil
}

// dkFieldIdent is the location indicator a field's title ends with, "" for
// anything else.
func dkFieldIdent(title string) string {
	m := dkFieldTitleRe.FindStringSubmatch(title)
	if m == nil {
		return ""
	}
	if m[2] != "" {
		return m[2]
	}
	return m[3]
}

// addDkField merges one publication's documents for a field: the first
// text page it meets, and every chart not already held under its file
// name.
func addDkField(fields map[string]*dkField, icao string, heli bool, docs []dkNode) {
	f := fields[icao]
	if f == nil {
		f = &dkField{icao: icao, heli: heli, seen: map[string]bool{}}
		fields[icao] = f
	}
	for _, doc := range docs {
		if doc.IsDir || doc.Href == nil {
			continue
		}
		path := strings.TrimPrefix(*doc.Href, "/media/files/")
		if path == *doc.Href {
			continue
		}
		title := doc.Title
		if m := dkDocTitleRe.FindStringSubmatch(title); m != nil {
			title = m[1]
		}
		title = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(title), icao))
		if strings.EqualFold(title, "text") {
			if f.ad == "" {
				f.ad = path
			}
			continue
		}
		key := strings.ToLower(doc.Name)
		if f.seen[key] {
			continue
		}
		f.seen[key] = true
		f.charts = append(f.charts, [3]string{eaip.ChartFamily(title, doc.Name), title, path})
	}
}

// checkDkLinks fetches the head of a random sample of chart links and
// counts those answering with a PDF.
func checkDkLinks(ctx context.Context, d *dkClient, urls []string) (ok, tried int) {
	pick := append([]string(nil), urls...)
	sort.Strings(pick)
	r := rand.New(rand.NewSource(int64(len(pick))))
	r.Shuffle(len(pick), func(i, j int) { pick[i], pick[j] = pick[j], pick[i] })
	if len(pick) > 6 {
		pick = pick[:6]
	}
	for _, u := range pick {
		tried++
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
		if err != nil {
			continue
		}
		req.Header.Set("User-Agent", dkUserAgent)
		req.Header.Set("Range", "bytes=0-1023")
		res, err := d.c.Do(req)
		if err != nil {
			continue
		}
		head := make([]byte, 5)
		n, _ := io.ReadFull(res.Body, head)
		res.Body.Close()
		if (res.StatusCode == http.StatusOK || res.StatusCode == http.StatusPartialContent) && n == 5 && string(head) == "%PDF-" {
			ok++
		} else {
			fmt.Printf("dk: chart link does not answer: %s\n", u)
		}
	}
	return ok, tried
}
