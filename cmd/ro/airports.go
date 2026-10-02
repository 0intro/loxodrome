// airports.go reads AIP Romania's aerodrome pages, one text PDF per field
// (AD 2, and AD 3 for the heliports), and writes ro-airports.json and
// ro-aerodrome-facilities.json; each field's control zone (AD 2.17, AD
// 3.16) joins ro-airspaces.json less what ENR 2.1 already publishes.
//
// The pages are ICAO's item tables under a line naming each section
// ("LRAR AD 2.2 AERODROME GEOGRAPHICAL AND ADMINISTRATIVE DATA"): the
// rebuild keeps those lines as the headings the aerodrome readers scope
// their sections by (eaip.ADSectionTables), and the one naming the field
// ("LRAR - ARAD / Arad"). And AD 2.12, 2.13 and 2.18 set their records in
// one ruled row, each record's key on a line of its own ("09", "27";
// "TWR", "APP"), which the rebuild splits (pdftable's AlignedRows). The
// readers are eaip.ReadAerodrome and eaip.ATSAirspace, those of the
// generated eAIPs.

package main

import (
	"context"
	"crypto/sha256"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/aixm5"
	"github.com/0intro/loxodrome/internal/aixm5build"
	"github.com/0intro/loxodrome/internal/eaip"
	"github.com/0intro/loxodrome/internal/pdftable"
	"github.com/0intro/loxodrome/internal/pdftext"
)

// roADFile is one field's text PDF.
type roADFile struct {
	icao string
	part int    // 2 aerodrome, 3 heliport
	name string // "LR_AD_2_LRAR_en.pdf"
	url  string // empty when read back from a -keep directory
}

// roADFileRe is a field's text PDF as a -keep run saves it.
var roADFileRe = regexp.MustCompile(`^LR_AD_([23])_([A-Z]{4})_en\.pdf$`)

// aerodromes lists the edition's fields: from ROMATSA's directories, or
// from the AD subdirectory a -keep run filled.
func (e *roENR) aerodromes(ctx context.Context) ([]roADFile, error) {
	if e.dir != "" {
		ents, err := os.ReadDir(filepath.Join(e.dir, "AD"))
		if err != nil {
			return nil, err
		}
		var out []roADFile
		for _, ent := range ents {
			if m := roADFileRe.FindStringSubmatch(ent.Name()); m != nil {
				out = append(out, roADFile{icao: m[2], part: int(m[1][0] - '0'), name: ent.Name()})
			}
		}
		return out, nil
	}
	c := &http.Client{Timeout: 90 * time.Second}
	var out []roADFile
	for _, part := range []int{2, 3} {
		listing, err := roGet(ctx, c, fmt.Sprintf("%sAD%d/", e.adBase, part))
		if err != nil {
			return nil, err
		}
		for _, f := range roFields(string(listing), part) {
			dir, err := roGet(ctx, c, e.adBase+f.dir+"/")
			if err != nil {
				return nil, err
			}
			m := roTextRe.FindStringSubmatch(string(dir))
			if m == nil {
				return nil, fmt.Errorf("%s holds no text PDF", f.dir)
			}
			out = append(out, roADFile{icao: f.icao, part: part, name: m[1], url: e.adBase + f.dir + "/" + m[1]})
		}
	}
	return out, nil
}

// readAD reads one field's text PDF, saving it to -keep.
func (e *roENR) readAD(ctx context.Context, c *http.Client, f roADFile) ([]byte, error) {
	var data []byte
	var err error
	if f.url == "" {
		data, err = os.ReadFile(filepath.Join(e.dir, "AD", f.name))
	} else {
		data, err = roGet(ctx, c, f.url)
	}
	if err != nil {
		return nil, err
	}
	if e.keep != "" {
		dir := filepath.Join(e.keep, e.edition, "AD")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, err
		}
		if err := os.WriteFile(filepath.Join(dir, f.name), data, 0o644); err != nil {
			return nil, err
		}
	}
	return data, nil
}

// roADPage is one field read.
type roADPage struct {
	f       roADFile
	airport *aixm5.Airport
	zones   []aixm5.Airspace
	zstats  *eaip.ZoneStats
	sum     [32]byte
	err     error
}

// roADPass is every field of an edition, read once for the datasets that
// need them.
type roADPass struct {
	pages []roADPage
}

// defaultMinRoFieldsRead is the floor on fields read: AIP Romania
// publishes 38 (2026-09), and a pass reading far fewer changed layout.
const defaultMinRoFieldsRead = 25

// readRoAerodromes reads every field of the edition.
func readRoAerodromes(ctx context.Context, e *roENR, spec eaip.ZoneSpec) (*roADPass, error) {
	files, err := e.aerodromes(ctx)
	if err != nil {
		return nil, err
	}
	sort.Slice(files, func(i, j int) bool { return files[i].icao < files[j].icao })
	c := &http.Client{Timeout: 90 * time.Second}
	pass := &roADPass{pages: make([]roADPage, len(files))}
	jobs := make(chan int)
	var wg sync.WaitGroup
	for w := 0; w < roWorkers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range jobs {
				p := roADPage{f: files[i]}
				data, err := e.readAD(ctx, c, files[i])
				if err == nil {
					p.sum = sha256.Sum256(data)
					err = readRoAerodrome(data, &p, spec)
				}
				p.err = err
				pass.pages[i] = p
			}
		}()
	}
	for i := range files {
		jobs <- i
	}
	close(jobs)
	wg.Wait()
	read := 0
	for _, p := range pass.pages {
		if p.airport != nil {
			read++
		}
	}
	if read < defaultMinRoFieldsRead {
		return nil, fmt.Errorf("%d of %d fields read, fewer than %d; the layout may have changed", read, len(files), defaultMinRoFieldsRead)
	}
	return pass, nil
}

// roADHeading accepts, for one field, the lines its readers key on: a
// section's ("LRAR AD 2.2 ...") and the one naming it ("LRAR - ARAD /
// Arad").
func roADHeading(icao string) func(string) bool {
	re := regexp.MustCompile(`^` + icao + `\s*(?:AD\s*[23]\s*\.\s*\d{1,2}\b|[-–]\s*\S)`)
	return re.MatchString
}

// roADNameRe reads the field's name off the line naming it.
var roADNameRe = regexp.MustCompile(`^[A-Z]{4}\s*[-–]\s*(.+?)\s*$`)

// readRoAerodrome rebuilds one field's PDF and reads it.
func readRoAerodrome(data []byte, p *roADPage, spec eaip.ZoneSpec) error {
	bbox, err := pdftext.Run(data, "-bbox-layout", "-", "-")
	if err != nil {
		return err
	}
	html, err := pdftable.DocumentWith(data, bbox, p.f.icao, pdftable.Options{
		Heading:     roADHeading(p.f.icao),
		AlignedRows: true,
	})
	if err != nil {
		return err
	}
	doc, err := eaip.ParseHTML(html)
	if err != nil {
		return err
	}
	ap, ok := eaip.ReadAerodrome(doc, p.f.icao, p.f.part == 3)
	if !ok {
		return fmt.Errorf("%s: no reference point read", p.f.icao)
	}
	if ap.Name == p.f.icao {
		for _, h := range eaip.FindAll(doc, func(n *eaip.Node) bool { return eaip.IsElem(n) && n.Data == "h4" }) {
			if m := roADNameRe.FindStringSubmatch(eaip.NormSpace(eaip.NodeText(h))); m != nil && strings.HasPrefix(eaip.NormSpace(eaip.NodeText(h)), p.f.icao) {
				ap.Name = m[1]
				break
			}
		}
	}
	p.airport = &ap
	p.zstats = eaip.NewZoneStats()
	p.zones = eaip.ATSAirspace(doc, ap, spec, p.zstats)
	return nil
}

// roAirportsMeta is the shared builder's sidecar, with the fields that
// gave no aerodrome.
type roAirportsMeta struct {
	aixm5build.AirportsMeta
	Edition string            `json:"edition"`
	Unread  map[string]string `json:"unread,omitempty"`
}

// writeRoAirports writes ro-airports.json from the pass.
func writeRoAirports(outDir, target string, e *roENR, pass *roADPass, win aip.SanityWindows, now func() time.Time) error {
	var msg aixm5.Message
	unread := map[string]string{}
	h := sha256.New()
	for _, p := range pass.pages {
		if p.airport == nil {
			unread[p.f.icao] = fmt.Sprint(p.err)
			continue
		}
		h.Write(p.sum[:])
		msg.Airports = append(msg.Airports, *p.airport)
	}
	effective := e.edition + "T00:00:00.000Z"
	art, meta, err := aixm5build.BuildAirports(&msg, "ROMATSA AIP Romania "+e.edition+" AD 2, AD 3", h.Sum(nil), effective,
		aixm5build.AirportsOptions{
			Country:         "RO",
			CountryFromIcao: func(string) string { return "RO" },
			Now:             now,
			MinAirports:     orDefault(win.MinAirports, defaultMinRoFieldsRead),
			MaxAirports:     orDefault(win.MaxAirports, 100),
		})
	if err != nil {
		return err
	}
	out := roAirportsMeta{AirportsMeta: meta, Edition: e.edition}
	if len(unread) > 0 {
		out.Unread = unread
	}
	slot, err := aip.WriteDataset(outDir, "ro-airports", target, meta.Effective, art, out)
	if err != nil {
		return err
	}
	fmt.Printf("ro: wrote %d airports (%d runways, %d radios, %d with a TA, %d unread); effective %s; slot=%s\n",
		meta.AhpCount, meta.RunwayCount, meta.RadioCount, meta.TransitionAltCount, len(unread), e.edition, slot)
	return nil
}

// writeRoFacilities writes ro-aerodrome-facilities.json from the pass:
// what the aerodrome reader reads of the site, the operator and its
// contacts, the hours and the remarks.
func writeRoFacilities(outDir, target string, e *roENR, pass *roADPass, now func() time.Time) error {
	var msg aixm5.Message
	h := sha256.New()
	for _, p := range pass.pages {
		if p.airport == nil {
			continue
		}
		h.Write(p.sum[:])
		msg.Airports = append(msg.Airports, *p.airport)
	}
	effective := e.edition + "T00:00:00.000Z"
	art, meta, err := aixm5build.BuildFacilities(&msg, "ROMATSA AIP Romania "+e.edition+" AD 2, AD 3", h.Sum(nil), effective,
		aixm5build.FacilitiesOptions{
			Country:       "RO",
			Now:           now,
			MinAerodromes: defaultMinRoFieldsRead,
			MaxAerodromes: 100,
		})
	if err != nil {
		return err
	}
	slot, err := aip.WriteDataset(outDir, "ro-aerodrome-facilities", target, meta.Effective, art, meta)
	if err != nil {
		return err
	}
	fmt.Printf("ro: wrote %d aerodrome facilities (%d heliports); effective %s; slot=%s\n",
		meta.AerodromeCount, meta.HeliportCount, e.edition, slot)
	return nil
}
