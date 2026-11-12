// adcharts.go writes <cc>-adcharts.json: for every aerodrome page the
// package lists, the page itself and the charts its AD 2.24 (AD 3.23)
// table links, in at-adcharts.json's shape so one app loader reads them
// all (src/lib/data/aipCharts.ts). A State whose small aerodromes sit in
// a package of their own (PANSA's AIP VFR, as AD 4) names it among its
// ChartSites, and those pages join the same index, stored whole since
// they lie outside its base.
//
// The dataset is LINKS: a chart's family, its title and the address the
// publisher serves it at. No chart is copied, which is why a State held
// for consent still gets one (docs/aip-sources.md, "Chart links are not
// copies"): what is re-served is a list of the publisher's own URLs.

package main

import (
	"context"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"net/url"
	"os"
	"path"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/eaip"
)

// adChartsWorkers bounds the pages fetched at once from one publisher.
const adChartsWorkers = 4

// adChartsArtifact is the <cc>-adcharts.json document: Base pins the tree
// the paths belong to, and the app builds each URL as Base + path (a path
// already absolute is kept).
type adChartsArtifact struct {
	Fields      []string `json:"fields"`
	ChartFields []string `json:"chartFields"`
	Edition     string   `json:"edition"`
	Base        string   `json:"base"`
	Rows        []any    `json:"rows"`
}

// adChartsMeta is the sidecar. generatedAt lives here alone, so an
// unchanged edition yields a byte-identical artifact and the weekly job's
// no-op gate holds.
type adChartsMeta struct {
	GeneratedAt string `json:"generatedAt"`
	Source      string `json:"source"`
	Effective   string `json:"effective"`
	Edition     string `json:"edition"`
	Base        string `json:"base"`
	resolution
	Aerodromes int `json:"aerodromes"`
	Heliports  int `json:"heliports"`
	WithCharts int `json:"withCharts"`
	// WithVAC counts the aerodromes with a visual chart, the link the
	// panel puts first.
	WithVAC  int            `json:"withVac"`
	Charts   int            `json:"charts"`
	ByFamily map[string]int `json:"byFamily"`
	// MiscTitles samples the titles no family rule read, so a new
	// wording is nameable.
	MiscTitles []string `json:"miscTitles,omitempty"`
	// PageErrors names the aerodrome pages that could not be read.
	PageErrors map[string]string `json:"pageErrors,omitempty"`
	// LinkCheck is how many of a sample of chart links answered.
	LinkCheck string `json:"linkCheck"`
	// AlsoRead names the further packages whose aerodrome pages the
	// index carries (State.ChartSites), each by its edition.
	AlsoRead []string `json:"alsoRead,omitempty"`
}

// aerodromePage is one aerodrome page of the pass, and what it gave.
type aerodromePage struct {
	ad  eaip.Aerodrome
	src int
	pageRead
	err error
}

// adPass is one pass over a State's aerodrome pages, each read once for
// the chart index and for the aerodromes.
type adPass struct {
	sources  []chartPackage
	alsoRead []string
	pages    []aerodromePage
	// chartsWait is set when a further package has no pre-release: a next
	// chart index without its aerodromes would drop them on the day it
	// takes over, so it waits for it. The State's own pages are read all
	// the same, for its aerodromes.
	chartsWait string
}

// readAerodromePages lists and reads every aerodrome page: the State's
// own package, already resolved, then its ChartSites, which only the
// chart index reads.
func readAerodromePages(ctx context.Context, s *State, cyc eaip.Cycle, target string, charts bool) (*adPass, error) {
	pass := &adPass{sources: []chartPackage{&eaipPackage{label: s.Label, s: &s.Site, cyc: cyc, spec: &s.Spec}}}
	sites := s.ChartSites
	if !charts {
		sites = nil
	}
	for _, p := range sites {
		edition, err := p.open(ctx, target == "next")
		if err != nil {
			return nil, fmt.Errorf("%s: %w", p.name(), err)
		}
		if edition == "" {
			pass.chartsWait = p.name()
			continue
		}
		pass.sources = append(pass.sources, p)
		pass.alsoRead = append(pass.alsoRead, p.name()+" "+edition)
	}
	sources := pass.sources
	var ads []eaip.Aerodrome
	var adSrc []int
	listed := map[string]bool{}
	for i, src := range sources {
		got, err := src.aerodromes(ctx)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", src.name(), err)
		}
		for _, a := range got {
			// A field two packages list keeps the first one's page.
			if !listed[a.ICAO] {
				listed[a.ICAO] = true
				ads = append(ads, a)
				adSrc = append(adSrc, i)
			}
		}
	}
	text := eaip.NodeText
	if s.Spec.Bilingual {
		text = eaip.EnglishText
	}
	pass.pages = make([]aerodromePage, len(ads))
	jobs := make(chan int)
	var wg sync.WaitGroup
	for w := 0; w < adChartsWorkers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range jobs {
				r := aerodromePage{ad: ads[i], src: adSrc[i]}
				r.pageRead, r.err = sources[r.src].read(ctx, ads[i], text)
				pass.pages[i] = r
			}
		}()
	}
	for i := range ads {
		jobs <- i
	}
	close(jobs)
	wg.Wait()
	return pass, nil
}

// writeAdCharts builds and writes one State's chart index from the pass.
func writeAdCharts(ctx context.Context, s *State, pass *adPass, cyc eaip.Cycle, dir, effective string, resolved resolution, outDir, target string) error {
	if pass.chartsWait != "" {
		fmt.Printf("%s: %s has no pre-release edition; the next chart index waits for it\n", s.CC, pass.chartsWait)
		return nil
	}
	sources, alsoRead := pass.sources, pass.alsoRead
	base := packageBase(s, cyc)
	meta := adChartsMeta{
		Source:     s.Label + " eAIP " + dir,
		Effective:  effective,
		Edition:    dir,
		Base:       base,
		resolution: resolved,
		ByFamily:   map[string]int{},
		AlsoRead:   alsoRead,
	}
	var rows []any
	var sample []linkRef
	for _, r := range pass.pages {
		if r.err != nil {
			if meta.PageErrors == nil {
				meta.PageErrors = map[string]string{}
			}
			meta.PageErrors[r.ad.ICAO] = r.err.Error()
			continue
		}
		if r.ad.Section == 3 {
			meta.Heliports++
		} else {
			meta.Aerodromes++
		}
		// The State's own package dates the index; a further package's
		// pages do not.
		if r.src == 0 && (meta.Effective == "" || cyc.FromPages && r.eff != "" && r.eff+"T00:00:00.000Z" > meta.Effective) {
			if r.eff != "" {
				meta.Effective = r.eff + "T00:00:00.000Z"
			}
		}
		inForce := meta.Effective
		if inForce == "" {
			inForce = r.eff
		}
		r.charts = currentVersions(r.charts, inForce)
		charts := make([]any, 0, len(r.charts))
		vac := false
		for _, c := range r.charts {
			charts = append(charts, []string{c.Code, c.Title, relativeTo(base, c.URL)})
			meta.ByFamily[c.Code]++
			vac = vac || c.Code == "VAC"
			if c.Code == "MISC" && len(meta.MiscTitles) < 40 && !contains(meta.MiscTitles, c.Title) {
				meta.MiscTitles = append(meta.MiscTitles, c.Title)
			}
			sample = append(sample, linkRef{url: c.URL, site: sources[r.src].site()})
		}
		if len(r.charts) > 0 {
			meta.WithCharts++
		}
		if vac {
			meta.WithVAC++
		}
		meta.Charts += len(r.charts)
		rows = append(rows, []any{r.ad.ICAO, relativeTo(base, r.ad.URL), charts})
	}
	if len(rows) == 0 {
		return fmt.Errorf("no aerodrome page could be read (%d listed)", len(pass.pages))
	}
	if meta.Effective == "" {
		return fmt.Errorf("no effective date: neither the package nor its pages state one")
	}
	if s.Site.Replay != "" {
		// A replayed snapshot holds the pages, not the charts, and a
		// replay must not reach the network.
		sample = nil
	}
	ok, tried := checkLinks(ctx, s.CC, sample)
	meta.LinkCheck = fmt.Sprintf("%d/%d", ok, tried)
	if tried > 0 && ok*2 < tried {
		return fmt.Errorf("chart links do not resolve (%d of %d sampled answered); nothing written", ok, tried)
	}
	meta.GeneratedAt = time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	artifact := adChartsArtifact{
		Fields:      []string{"icao", "ad", "charts"},
		ChartFields: []string{"code", "title", "path"},
		Edition:     dir,
		Base:        base,
		Rows:        rows,
	}
	slot, err := aip.WriteDataset(outDir, s.CC+"-adcharts", target, meta.Effective, artifact, meta)
	if err != nil {
		return err
	}
	fmt.Printf("%s: wrote %d aerodromes, %d heliports, %d charts (%d with a VAC, links %s); effective %s; slot=%s\n",
		s.CC, meta.Aerodromes, meta.Heliports, meta.Charts, meta.WithVAC, meta.LinkCheck, meta.Effective, slot)
	if len(meta.PageErrors) > 0 {
		fmt.Printf("%s: %d aerodrome page(s) unread: %s\n", s.CC, len(meta.PageErrors), strings.Join(sortedKeys(meta.PageErrors), ", "))
	}
	return nil
}

// versionRe reads a chart file carrying its version's date, and the
// document serial some prefix it with: LGS lists each chart in the
// version in force and the one before it ("1564_EVAD_2_24_14_20250710.pdf",
// "1795_EVAD_2_24_14_20260903.pdf").
var versionRe = regexp.MustCompile(`^(?:\d+_)?(.+?)_(20\d{6})\.pdf$`)

// currentVersions keeps, of a chart listed in several dated versions, the
// latest one in force on the effective date (the earliest, where none is
// yet), and every chart whose file names no date.
func currentVersions(charts []eaip.Chart, effective string) []eaip.Chart {
	day := strings.ReplaceAll(strings.SplitN(effective, "T", 2)[0], "-", "")
	type pick struct {
		i    int
		date string
	}
	best := map[string]pick{}
	var order []string
	keep := make([]bool, len(charts))
	for i, c := range charts {
		m := versionRe.FindStringSubmatch(path.Base(c.URL))
		if m == nil {
			keep[i] = true
			continue
		}
		key, date := m[1], m[2]
		b, ok := best[key]
		if !ok {
			best[key] = pick{i, date}
			order = append(order, key)
			continue
		}
		better := false
		switch {
		case date <= day && b.date > day:
			better = true
		case date <= day && b.date <= day:
			better = date > b.date
		case date > day && b.date > day:
			better = date < b.date
		}
		if better {
			best[key] = pick{i, date}
		}
	}
	for _, k := range order {
		keep[best[k].i] = true
	}
	out := make([]eaip.Chart, 0, len(charts))
	for i, c := range charts {
		if keep[i] {
			out = append(out, c)
		}
	}
	return out
}

// packageBase is the package's root, escaped, ending in a slash.
func packageBase(s *State, cyc eaip.Cycle) string {
	root := strings.TrimSuffix(s.Site.PackageRoot(cyc), "/")
	if u, err := url.Parse(root); err == nil {
		root = u.String()
	}
	return root + "/"
}

// relativeTo stores a URL under base as its path below it, and any other
// URL whole.
func relativeTo(base, u string) string {
	if strings.HasPrefix(u, base) {
		return u[len(base):]
	}
	return u
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// linkSample is how many chart links a build checks.
const linkSample = 6

// linkRef is a chart link and the site serving it, whose headers and
// certificates the check needs.
type linkRef struct {
	url  string
	site *eaip.Site
}

// checkLinks fetches a random sample of chart links and counts those that
// answer with a PDF, so a publisher that moved its files fails the build
// instead of shipping dead links. Only the head of each file is read.
func checkLinks(ctx context.Context, cc string, links []linkRef) (ok, tried int) {
	if len(links) == 0 {
		return 0, 0
	}
	pick := append([]linkRef(nil), links...)
	sort.Slice(pick, func(i, j int) bool { return pick[i].url < pick[j].url })
	r := rand.New(rand.NewSource(int64(len(pick))))
	r.Shuffle(len(pick), func(i, j int) { pick[i], pick[j] = pick[j], pick[i] })
	if len(pick) > linkSample {
		pick = pick[:linkSample]
	}
	for _, l := range pick {
		tried++
		if linkAnswers(ctx, l.site, l.url) {
			ok++
		} else {
			fmt.Fprintf(os.Stderr, "%s: chart link does not answer: %s\n", cc, l.url)
		}
	}
	return ok, tried
}

// linkAnswers reports a URL answering 200 with a PDF: its first bytes are
// the PDF magic, whatever content type the server states.
func linkAnswers(ctx context.Context, site *eaip.Site, u string) bool {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return false
	}
	for k, v := range site.Header {
		req.Header.Set(k, v)
	}
	req.Header.Set("Range", "bytes=0-1023")
	client, err := site.HTTPClient()
	if err != nil {
		return false
	}
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
