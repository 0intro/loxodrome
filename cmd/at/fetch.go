// fetch.go acquires the two Austro Control downloads cmd/at reads: the
// Luftraumstruktur KMZ and the Obstacle Data Set (ICAO) zip. Two modes:
//   - live: scrape each AIM product page for its download links and take
//     the cycle in force plus the one that follows it, optionally dumping
//     both files to a snapshot directory (gitignored local/).
//   - offline (-in): read a snapshot directory back, no network. The Go
//     tests run on trimmed fixtures under testdata/.
//
// Both product pages stamp the AIRAC effective date into every filename,
// which is where the dataset effective dates come from, and both list
// several cycles at once: the one in force, sometimes the one before it,
// and (for airspace) one or two ahead. Taking the newest alone would put a
// pre-release in the current slot and leave the in-force cycle unbuilt, so
// the listing is split into a current / next PAIR against today's date,
// the way SelectEditions does it for the eAIP chart editions.

package main

import (
	"context"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	airspacePage = "https://www.austrocontrol.at/en/pilots/pre-flight_preparation/aim_products/airspace_structure"
	obstaclePage = "https://www.austrocontrol.at/en/pilots/pre-flight_preparation/aim_products/obstacle_data_set_icao"

	// documentBase resolves the relative download hrefs of both product
	// pages: the CMS serves its documents from one flat path, which the
	// page states in its <base href>.
	documentBase = "https://www.austrocontrol.at/jart/prj3/ac/data/dokumente/"

	// The Austro Control front end answers a browser header set; the
	// fetcher presents a consistent mainstream-browser one. The content
	// is the public AIP product listing, two page loads plus two file
	// downloads per 28-day cycle.
	userAgent      = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0"
	acceptHeader   = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
	acceptLanguage = "en-US,en;q=0.5"
	fetchInterval  = 250 * time.Millisecond
)

var (
	// kmzHrefRe matches the airspace download, "20260709LuftraumAT_2026-05-26_1105212.kmz".
	// The extension is not stable: Austro Control published the 2026-09-03
	// edition as a bare .kml between two .kmz ones, and matching .kmz alone
	// made that whole cycle invisible.
	kmzHrefRe = regexp.MustCompile(`href="([^"]*?(\d{8})Luftraum[^"]*?\.(?:kmz|kml))"`)
	// obsHrefRe matches the obstacle download, "LO_OBS_DS_AREA1_20260710_2026-06-30_0706137.zip".
	obsHrefRe = regexp.MustCompile(`href="([^"]*?LO_OBS_DS_AREA1_(\d{8})[^"]*?\.zip)"`)
	// snapshotDateRe reads the cycle back off a stored filename.
	snapshotDateRe = regexp.MustCompile(`(\d{8})`)
)

// download is one acquired file: its bytes, the name it was published
// under, and the AIRAC effective date stamped into that name.
type download struct {
	name      string
	data      []byte
	effective string // ISO-8601 midnight, aip.ResolveTarget's format
}

// sources bundles the downloads one run reads: for each product, the
// cycle in force and, when the page lists one, the cycle that follows it.
// A nil next field means the publisher has no pre-release out, which is
// the steady state for the obstacle product.
type sources struct {
	airspace     *download
	airspaceNext *download
	obstacle     *download
	obstacleNext *download
}

// editions returns the airspace downloads to build, oldest first, so a
// current slot is always written before the pre-release that follows it.
func (s *sources) airspaceEditions() []*download {
	return presentEditions(s.airspace, s.airspaceNext)
}

func (s *sources) obstacleEditions() []*download {
	return presentEditions(s.obstacle, s.obstacleNext)
}

func presentEditions(current, next *download) []*download {
	var out []*download
	if current != nil {
		out = append(out, current)
	}
	if next != nil {
		out = append(out, next)
	}
	return out
}

type fetcher struct {
	client   *http.Client
	interval time.Duration
	last     time.Time
}

func newFetcher() *fetcher {
	return &fetcher{
		client:   &http.Client{Timeout: 180 * time.Second},
		interval: fetchInterval,
	}
}

func (f *fetcher) wait(ctx context.Context) {
	if f.interval <= 0 || f.last.IsZero() {
		f.last = time.Now()
		return
	}
	if d := f.interval - time.Since(f.last); d > 0 {
		select {
		case <-time.After(d):
		case <-ctx.Done():
		}
	}
	f.last = time.Now()
}

// get fetches one URL with the browser header set, retrying transient
// failures.
func (f *fetcher) get(ctx context.Context, url string) ([]byte, error) {
	var lastErr error
	for attempt := range 3 {
		if attempt > 0 {
			select {
			case <-time.After(time.Duration(attempt) * 2 * time.Second):
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		f.wait(ctx)
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("User-Agent", userAgent)
		req.Header.Set("Accept", acceptHeader)
		req.Header.Set("Accept-Language", acceptLanguage)
		res, err := f.client.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		body, err := io.ReadAll(res.Body)
		res.Body.Close()
		switch {
		case res.StatusCode == http.StatusOK && err == nil:
			return body, nil
		case res.StatusCode == http.StatusNotFound:
			return nil, fmt.Errorf("GET %s: HTTP 404", url)
		default:
			if err != nil {
				lastErr = err
			} else {
				lastErr = fmt.Errorf("GET %s: HTTP %d", url, res.StatusCode)
			}
		}
	}
	return nil, lastErr
}

// acquireLive scrapes both product pages and downloads the cycle in force
// plus the pre-release each lists. snapshotDir, when non-empty, receives
// every file under its published name.
func acquireLive(ctx context.Context, f *fetcher, snapshotDir string, now time.Time, wantAirspace, wantObstacle bool) (*sources, error) {
	out := &sources{}
	if wantAirspace {
		cur, next, err := acquireProduct(ctx, f, airspacePage, kmzHrefRe, snapshotDir, now)
		if err != nil {
			return nil, fmt.Errorf("airspace structure: %w", err)
		}
		out.airspace, out.airspaceNext = cur, next
	}
	if wantObstacle {
		cur, next, err := acquireProduct(ctx, f, obstaclePage, obsHrefRe, snapshotDir, now)
		if err != nil {
			return nil, fmt.Errorf("obstacle data set: %w", err)
		}
		out.obstacle, out.obstacleNext = cur, next
	}
	return out, nil
}

// acquireProduct fetches one product page and retrieves the cycle in
// force and, when the page lists one, the cycle that follows it.
func acquireProduct(ctx context.Context, f *fetcher, page string, hrefRe *regexp.Regexp, snapshotDir string, now time.Time) (current, next *download, err error) {
	body, err := f.get(ctx, page)
	if err != nil {
		return nil, nil, err
	}
	curHref, nextHref := selectHrefs(string(body), hrefRe, now)
	if curHref.href == "" && nextHref.href == "" {
		return nil, nil, fmt.Errorf("%s lists no download matching %s", page, hrefRe)
	}
	fetch := func(m hrefMatch) (*download, error) {
		if m.href == "" {
			return nil, nil
		}
		name := filepath.Base(m.href)
		data, err := f.get(ctx, documentBase+strings.TrimPrefix(name, "/"))
		if err != nil {
			return nil, err
		}
		if snapshotDir != "" {
			if err := os.MkdirAll(snapshotDir, 0o755); err != nil {
				return nil, err
			}
			if err := os.WriteFile(filepath.Join(snapshotDir, name), data, 0o644); err != nil {
				return nil, err
			}
		}
		return &download{name: name, data: data, effective: isoFromStamp(m.stamp)}, nil
	}
	if current, err = fetch(curHref); err != nil {
		return nil, nil, err
	}
	if next, err = fetch(nextHref); err != nil {
		return nil, nil, err
	}
	return current, next, nil
}

// hrefMatch is one download link and the AIRAC stamp in its filename.
type hrefMatch struct {
	href  string
	stamp string // YYYYMMDD
}

// selectHrefs splits a product page's download links into the cycle in
// force and the one that follows it: current is the newest stamp at or
// before today, next the first stamp after it. When every listed cycle is
// still in the future (a product the page has only just started carrying)
// the oldest becomes current, so a run always has something to build.
// This is the SelectEditions rule in eaip.go, applied to filenames.
func selectHrefs(page string, hrefRe *regexp.Regexp, now time.Time) (current, next hrefMatch) {
	var found []hrefMatch
	seen := map[string]bool{}
	for _, m := range hrefRe.FindAllStringSubmatch(page, -1) {
		if seen[m[2]] {
			continue
		}
		seen[m[2]] = true
		found = append(found, hrefMatch{href: m[1], stamp: m[2]})
	}
	sort.Slice(found, func(i, j int) bool { return found[i].stamp < found[j].stamp })
	today := now.UTC().Format("20060102")
	for i, m := range found {
		if m.stamp <= today {
			current = m
			continue
		}
		next = found[i]
		break
	}
	if current.href == "" && len(found) > 0 {
		current = found[0]
		if len(found) > 1 {
			next = found[1]
		}
	}
	return current, next
}

// isoFromStamp turns the YYYYMMDD filename stamp into the ISO-8601
// midnight form aip.ResolveTarget parses.
func isoFromStamp(stamp string) string {
	if len(stamp) != 8 {
		return ""
	}
	return stamp[:4] + "-" + stamp[4:6] + "-" + stamp[6:8] + "T00:00:00.000Z"
}

// acquireOffline reads a snapshot directory (-in), splitting each product
// into the same current / next pair the live path builds: the airspace
// source is a .kmz / .kml, the obstacle source a LO_OBS_DS_* zip or bare
// .xml. The obstacle download ships a .kmz rendering of its own beside the
// AIXM, so the airspace candidates are the files the obstacle product does
// not name.
func acquireOffline(dir string, now time.Time) (*sources, error) {
	var kmls, obs []string
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		obstacleName := strings.Contains(strings.ToUpper(d.Name()), "OBS_DS")
		switch strings.ToLower(filepath.Ext(d.Name())) {
		case ".kmz", ".kml":
			if !obstacleName {
				kmls = append(kmls, path)
			}
		case ".zip", ".xml":
			if obstacleName {
				obs = append(obs, path)
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if len(kmls) == 0 && len(obs) == 0 {
		return nil, fmt.Errorf("%s holds no .kmz airspace or LO_OBS_DS obstacle file", dir)
	}
	out := &sources{}
	if out.airspace, out.airspaceNext, err = readSnapshotPair(kmls, now); err != nil {
		return nil, err
	}
	if out.obstacle, out.obstacleNext, err = readSnapshotPair(obs, now); err != nil {
		return nil, err
	}
	return out, nil
}

// readSnapshotPair applies the selectHrefs rule to stored filenames: the
// newest AIRAC stamp at or before today is the current edition, the first
// after it the pre-release. A directory holding one file yields one
// edition, which is what every test fixture and most snapshots hold.
func readSnapshotPair(paths []string, now time.Time) (current, next *download, err error) {
	if len(paths) == 0 {
		return nil, nil, nil
	}
	sorted := append([]string{}, paths...)
	sort.Slice(sorted, func(i, j int) bool {
		si := snapshotDateRe.FindString(filepath.Base(sorted[i]))
		sj := snapshotDateRe.FindString(filepath.Base(sorted[j]))
		if si != sj {
			return si < sj
		}
		return sorted[i] < sorted[j]
	})
	today := now.UTC().Format("20060102")
	curPath, nextPath := "", ""
	for i, p := range sorted {
		if stamp := snapshotDateRe.FindString(filepath.Base(p)); stamp != "" && stamp > today {
			nextPath = sorted[i]
			break
		}
		curPath = p
	}
	if curPath == "" {
		curPath, nextPath = sorted[0], ""
		if len(sorted) > 1 {
			nextPath = sorted[1]
		}
	}
	if current, err = readSnapshot(curPath); err != nil {
		return nil, nil, err
	}
	if nextPath != "" {
		if next, err = readSnapshot(nextPath); err != nil {
			return nil, nil, err
		}
	}
	return current, next, nil
}

func readSnapshot(path string) (*download, error) {
	data, err := readCapped(path)
	if err != nil {
		return nil, err
	}
	name := filepath.Base(path)
	return &download{
		name:      name,
		data:      data,
		effective: isoFromStamp(snapshotDateRe.FindString(name)),
	}, nil
}
