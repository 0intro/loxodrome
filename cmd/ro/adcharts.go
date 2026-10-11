// adcharts.go writes ro-adcharts.json, the charts of every aerodrome and
// heliport in AIP Romania, in at-adcharts.json's shape so the app reads it
// like the eAIP States' indexes ($lib/data/aipCharts).
//
// ROMATSA serves each AIRAC edition as an open directory, dated by its
// effective day (/aip/2026-09-03/). Under DOCS/AIP/AD/AD2 each aerodrome
// has a directory ("AD_2_1_LRAR/") holding its text as one PDF
// ("LR_AD_2_LRAR_en.pdf") and every chart sheet as another, named by its
// page ("LR_AD_2_LRAR_1-20_en.pdf" is page AD 2.1-20; a heliport's under
// AD3 write "LR_AD_3_LRBG_2_20_en.pdf"). The sheets' names say nothing of
// what they are, so the titles come from the text's own AD 2.24 (AD 3.23)
// list, read with poppler's pdftotext -layout: a title, a dot leader and
// the page ("Aerodrome Chart - ICAO ...... AD 2.1-20"), a family's heading
// standing alone above its indented sheets ("Aerodrome Obstacle Chart -
// ICAO - Type A", then "RWY 09 ...... AD 2.1-25").
//
// LINKS only: no chart is copied. A sheet the list names and the
// directory lacks is left out, and a sheet the directory holds and the
// list does not name is kept under its page, both counted in the meta.

package main

import (
	"context"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/eaip"
	"github.com/0intro/loxodrome/internal/pdftext"
)

// roRoot is where ROMATSA publishes the editions.
const roRoot = "https://www.aisro.ro/aip/"

// roUserAgent is sent with every request: a public AIP served to browsers.
const roUserAgent = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0"

// defaultMinRoFields is the sanity floor: AIP Romania publishes 39 fields
// (2026-09), so an edition yielding far fewer changed its layout.
const defaultMinRoFields = 25

// roWorkers bounds the aerodromes read at once.
const roWorkers = 4

type roAdChartsArtifact struct {
	Fields      []string `json:"fields"`
	ChartFields []string `json:"chartFields"`
	Edition     string   `json:"edition"`
	Base        string   `json:"base"`
	Rows        []any    `json:"rows"`
}

type roAdChartsMeta struct {
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
	// Unlisted counts the sheets the directory holds and the list does
	// not name, kept under their page; Missing the pages the list names
	// and the directory lacks.
	Unlisted   int               `json:"unlisted"`
	Missing    int               `json:"missing"`
	MiscTitles []string          `json:"miscTitles,omitempty"`
	PageErrors map[string]string `json:"pageErrors,omitempty"`
	LinkCheck  string            `json:"linkCheck"`
}

// roEditionRe is an edition directory in the root listing.
var roEditionRe = regexp.MustCompile(`href="(\d{4}-\d{2}-\d{2})/"`)

// pickRoEdition picks the edition a slot reads: the latest in force on
// the day for the current one, the soonest after it for the next.
func pickRoEdition(listing string, now time.Time, next bool) string {
	today := now.UTC().Format("2006-01-02")
	var eds []string
	for _, m := range roEditionRe.FindAllStringSubmatch(listing, -1) {
		eds = append(eds, m[1])
	}
	sort.Strings(eds)
	pick := ""
	for _, e := range eds {
		switch {
		case !next && e <= today:
			pick = e
		case next && e > today && pick == "":
			pick = e
		}
	}
	return pick
}

// roFieldDirRe is a field's directory: "AD_2_1_LRAR/", "AD_3_2_LRBG/".
var roFieldDirRe = regexp.MustCompile(`href="(AD_([23])_\d+_([A-Z]{4}))/"`)

// roField is one field of an edition.
type roField struct {
	icao string
	part int
	dir  string // "AD2/AD_2_1_LRAR"
}

func roFields(listing string, part int) []roField {
	var out []roField
	for _, m := range roFieldDirRe.FindAllStringSubmatch(listing, -1) {
		if int(m[2][0]-'0') != part {
			continue
		}
		out = append(out, roField{icao: m[3], part: part, dir: fmt.Sprintf("AD%d/%s", part, m[1])})
	}
	return out
}

// roSheetRe is a chart sheet in a field's directory, keyed by its page:
// "LR_AD_2_LRAR_1-20_en.pdf", "LR_AD_3_LRBG_2_20_en.pdf".
var roSheetRe = regexp.MustCompile(`href="(LR_AD_[23]_[A-Z]{4}_(\d+)[-_](\d+)_en\.pdf)"`)

// roTextRe is the field's text PDF.
var roTextRe = regexp.MustCompile(`href="(LR_AD_[23]_[A-Z]{4}_en\.pdf)"`)

// roListRef is one page the AD 2.24 list names, and its title.
type roListRef struct {
	page  string // "1-20"
	title string
}

// roLeaderRe is a list line: a title, a leader of dots (or of ellipses,
// LRBM) and the pages it names, one or several for a chart printed over
// two ("Aerodrome Chart - ICAO ...... AD 2.1-20", "RWY 03 ... AD
// 2.29-31/AD 2.29-32").
var roLeaderRe = regexp.MustCompile(`^(\s*)(.*?)\s*(?:\.{3,}|…+)[.…\s]*((?:AD\s*[23]\.\d+\s*-\s*\d+\s*[/,]?\s*)+)$`)

// roPageRe is one page reference of a list line.
var roPageRe = regexp.MustCompile(`AD\s*[23]\.(\d+)\s*-\s*(\d+)`)

// roFurnitureRe is a page's running head or foot, which a list running
// over a page break carries in its middle: the foot ("ROMATSA ... AIRAC
// AIP AMDT 14/25") and the head ("AD 2.2-14 ... AIP", "25 DEC 2025 ...
// ROMANIA"), either way round.
var roFurnitureRe = regexp.MustCompile(`(?i)\bROMATSA\b|\bAMDT\b|^\s*AIP\b|\bAIP\s*$|\bROMANIA\s*$|^\s*AD\s*[23]\.\d+\s*-\s*\d+\b|\b\d{1,2}\s+[A-Z]{3}\s+\d{4}\b|^\s*\d+\s*$`)

// roChartsHeadRe opens the list; roNextHeadRe is the section after it.
var (
	roChartsHeadRe = regexp.MustCompile(`AD\s*[23]\.(?:24|23)\s+CHARTS\s+RELATED\s+TO`)
	roNextHeadRe   = regexp.MustCompile(`AD\s*[23]\.\d+\s+[A-Z]`)
)

// parseRoChartList reads the AD 2.24 (AD 3.23) list out of a field's text
// as pdftotext -layout prints it.
func parseRoChartList(text string) []roListRef {
	var out []roListRef
	in := false
	heading, headingIndent := "", -1
	for _, line := range strings.Split(text, "\n") {
		if !in {
			if roChartsHeadRe.MatchString(line) {
				in = true
			}
			continue
		}
		if strings.TrimSpace(line) == "" {
			continue
		}
		if m := roLeaderRe.FindStringSubmatch(line); m != nil {
			indent := len(m[1])
			title := strings.Join(strings.Fields(m[2]), " ")
			if heading != "" && indent > headingIndent {
				// A sheet of the family its heading names.
				title = heading + " " + title
			} else {
				heading, headingIndent = "", -1
			}
			for _, p := range roPageRe.FindAllStringSubmatch(m[3], -1) {
				out = append(out, roListRef{page: p[1] + "-" + p[2], title: title})
			}
			continue
		}
		if roNextHeadRe.MatchString(line) {
			break
		}
		if roFurnitureRe.MatchString(line) {
			continue
		}
		// A family's heading, standing alone above its sheets.
		heading = strings.Join(strings.Fields(line), " ")
		headingIndent = len(line) - len(strings.TrimLeft(line, " "))
	}
	return out
}

type roResult struct {
	f                 roField
	text              string
	charts            [][3]string
	unlisted, missing int
	err               error
}

// buildRoAdCharts resolves the edition, reads every field and writes the
// index.
func buildRoAdCharts(outDir, target string, now func() time.Time) error {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	c := &http.Client{Timeout: 90 * time.Second}
	rootListing, err := roGet(ctx, c, roRoot)
	if err != nil {
		return err
	}
	edition := pickRoEdition(string(rootListing), now(), target == "next")
	if edition == "" {
		if target == "next" {
			fmt.Println("ro: no pre-release edition published; nothing written")
			return nil
		}
		return fmt.Errorf("%s lists no edition in force", roRoot)
	}
	base := roRoot + edition + "/DOCS/AIP/AD/"
	var fields []roField
	for _, part := range []int{2, 3} {
		listing, err := roGet(ctx, c, fmt.Sprintf("%sAD%d/", base, part))
		if err != nil {
			return err
		}
		fields = append(fields, roFields(string(listing), part)...)
	}
	if len(fields) < defaultMinRoFields {
		return fmt.Errorf("edition %s lists %d fields, fewer than %d; the layout may have changed", edition, len(fields), defaultMinRoFields)
	}
	results := make([]roResult, len(fields))
	jobs := make(chan int)
	var wg sync.WaitGroup
	for w := 0; w < roWorkers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range jobs {
				results[i] = readRoField(ctx, c, base, fields[i])
			}
		}()
	}
	for i := range fields {
		jobs <- i
	}
	close(jobs)
	wg.Wait()

	meta := roAdChartsMeta{
		Source:    "ROMATSA AIP Romania " + edition,
		Effective: edition + "T00:00:00.000Z",
		Edition:   edition,
		Base:      base,
		ByFamily:  map[string]int{},
	}
	var rows []any
	var sample []string
	for _, r := range results {
		if r.err != nil {
			if meta.PageErrors == nil {
				meta.PageErrors = map[string]string{}
			}
			meta.PageErrors[r.f.icao] = r.err.Error()
			continue
		}
		if r.f.part == 3 {
			meta.Heliports++
		} else {
			meta.Aerodromes++
		}
		charts := make([]any, 0, len(r.charts))
		vac := false
		for _, ch := range r.charts {
			charts = append(charts, []string{ch[0], ch[1], ch[2]})
			meta.ByFamily[ch[0]]++
			vac = vac || ch[0] == "VAC"
			if ch[0] == "MISC" && len(meta.MiscTitles) < 40 {
				meta.MiscTitles = append(meta.MiscTitles, ch[1])
			}
			sample = append(sample, base+ch[2])
		}
		if len(charts) > 0 {
			meta.WithCharts++
		}
		if vac {
			meta.WithVAC++
		}
		meta.Charts += len(charts)
		meta.Unlisted += r.unlisted
		meta.Missing += r.missing
		rows = append(rows, []any{r.f.icao, r.text, charts})
	}
	if len(rows) < defaultMinRoFields {
		return fmt.Errorf("only %d fields could be read", len(rows))
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].([]any)[0].(string) < rows[j].([]any)[0].(string) })
	ok, tried := checkRoLinks(ctx, c, sample)
	meta.LinkCheck = fmt.Sprintf("%d/%d", ok, tried)
	if tried > 0 && ok*2 < tried {
		return fmt.Errorf("chart links do not resolve (%d of %d sampled answered); nothing written", ok, tried)
	}
	meta.GeneratedAt = now().UTC().Format("2006-01-02T15:04:05.000Z")
	artifact := roAdChartsArtifact{
		Fields:      []string{"icao", "ad", "charts"},
		ChartFields: []string{"code", "title", "path"},
		Edition:     edition,
		Base:        base,
		Rows:        rows,
	}
	slot, err := aip.WriteDataset(outDir, "ro-adcharts", target, meta.Effective, artifact, meta)
	if err != nil {
		return err
	}
	fmt.Printf("ro: wrote %d aerodromes, %d heliports, %d charts (%d with a VAC, %d unlisted, %d missing, links %s); effective %s; slot=%s\n",
		meta.Aerodromes, meta.Heliports, meta.Charts, meta.WithVAC, meta.Unlisted, meta.Missing, meta.LinkCheck, edition, slot)
	if len(meta.PageErrors) > 0 {
		fmt.Printf("ro: %d field(s) unread\n", len(meta.PageErrors))
	}
	return nil
}

// readRoField lists a field's directory, reads its text's chart list and
// joins the two.
func readRoField(ctx context.Context, c *http.Client, base string, f roField) roResult {
	r := roResult{f: f}
	listing, err := roGet(ctx, c, base+f.dir+"/")
	if err != nil {
		r.err = err
		return r
	}
	sheets := map[string]string{}
	var order []string
	for _, m := range roSheetRe.FindAllStringSubmatch(string(listing), -1) {
		key := m[2] + "-" + m[3]
		if _, dup := sheets[key]; !dup {
			sheets[key] = f.dir + "/" + m[1]
			order = append(order, key)
		}
	}
	tm := roTextRe.FindStringSubmatch(string(listing))
	if tm == nil {
		r.err = fmt.Errorf("%s holds no text PDF", f.dir)
		return r
	}
	r.text = f.dir + "/" + tm[1]
	pdf, err := roGet(ctx, c, base+r.text)
	if err != nil {
		r.err = err
		return r
	}
	text, err := pdftext.Run(pdf, "-layout", "-", "-")
	if err != nil {
		r.err = err
		return r
	}
	used := map[string]bool{}
	for _, ref := range parseRoChartList(string(text)) {
		path, ok := sheets[ref.page]
		if !ok {
			r.missing++
			continue
		}
		if used[ref.page] {
			continue
		}
		used[ref.page] = true
		r.charts = append(r.charts, [3]string{eaip.ChartFamily(ref.title, ""), ref.title, path})
	}
	for _, key := range order {
		if !used[key] {
			// A sheet the list does not name, kept under its page.
			r.unlisted++
			title := fmt.Sprintf("AD %d.%s", f.part, key)
			r.charts = append(r.charts, [3]string{"MISC", title, sheets[key]})
		}
	}
	return r
}

func roGet(ctx context.Context, c *http.Client, url string) ([]byte, error) {
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			select {
			case <-time.After(time.Duration(attempt) * 2 * time.Second):
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("User-Agent", roUserAgent)
		res, err := c.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		body, err := io.ReadAll(res.Body)
		res.Body.Close()
		if res.StatusCode == http.StatusOK && err == nil {
			return body, nil
		}
		if res.StatusCode == http.StatusNotFound {
			return nil, fmt.Errorf("GET %s: HTTP 404", url)
		}
		lastErr = fmt.Errorf("GET %s: HTTP %d", url, res.StatusCode)
	}
	return nil, lastErr
}

// checkRoLinks fetches the head of a random sample of chart links and
// counts those answering with a PDF.
func checkRoLinks(ctx context.Context, c *http.Client, urls []string) (ok, tried int) {
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
		req.Header.Set("User-Agent", roUserAgent)
		req.Header.Set("Range", "bytes=0-1023")
		res, err := c.Do(req)
		if err != nil {
			continue
		}
		head := make([]byte, 5)
		n, _ := io.ReadFull(res.Body, head)
		res.Body.Close()
		if (res.StatusCode == http.StatusOK || res.StatusCode == http.StatusPartialContent) && n == 5 && string(head) == "%PDF-" {
			ok++
		} else {
			fmt.Printf("ro: chart link does not answer: %s\n", u)
		}
	}
	return ok, tried
}
