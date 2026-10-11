// nasr.go reads the navaid half of the FAA's NASR 28-day subscription:
// NAV_BASE.csv, the register a radio navaid's frequency, channel,
// elevation and status are taken from (BuildNavaids).
//
// The hub's NavaidComponent layer, which they were read from, was last
// edited on 2016-03-07, while the NAVAIDSystem layer beside it follows each
// edition. Against the 2026-09-03 NASR, 163 of the frequencies it gave
// were stale and 38 missing: Little Rock on 113.900 / 086X where NASR says
// 115.1 / 98X, Riverside on 112.400 for 108.6, Vernal on 108.200 for
// 114.15, Taos on 117.600 for 115.8 and Gardner on 110.600 for 116.95 (the
// last two as AirNav prints them). NASR registers 1 331 of the 1 367
// stations drawn, a median of 1 m and at most 190 m from the layer's own
// point; the rest, foreign stations the FAA does not register, keep the
// component path.
//
// The extract is the subscription's CSV zip for the edition, named by its
// date (03_Sep_2026_CSV.zip, 23 MB). Only GET answers: a HEAD is refused
// with a 503.
//
// The register is REQUIRED (datasets.go): a build without it would publish
// the components' stale frequencies over the right ones already committed,
// so an extract that cannot be read, or reads as something else (a moved
// member, a changed column, positions that no longer parse, too few
// stations matched), leaves faa-navaids as it stands and fails the run.

package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/csv"
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/overlay"
)

const (
	// nasrFetchTimeout bounds the extract's download, every attempt
	// included: 23 MB takes seconds, and a stalled nfdc.faa.gov must not
	// spend the run's budget, which the layers beside it need.
	nasrFetchTimeout = 5 * time.Minute
	// maxNASRExtract and maxNASRNavBase cap what is read: the extract is
	// 23 MB and NAV_BASE.csv 0.7 MB.
	maxNASRExtract = 256 << 20
	maxNASRNavBase = 64 << 20
)

// nasrCSVURL is an edition's NASR CSV extract.
func nasrCSVURL(d time.Time) string {
	return "https://nfdc.faa.gov/webContent/28DaySub/extra/" + d.Format("02_Jan_2006") + "_CSV.zip"
}

// nasrNavaid is one NAV_BASE.csv row, the fields the navaids take.
type nasrNavaid struct {
	ident, kind string
	lat, lon    float64
	// freq is MHz for a VHF navaid and kHz for an NDB, 0 when blank.
	freq float64
	// channel is the TACAN / DME channel, zero-padded as the rest of the
	// column is ("098X"), "" when blank.
	channel string
	// elevFt is whole feet, or nil when blank.
	elevFt any
	// shutdown: NASR lists the station, no longer in service.
	shutdown bool
}

// nasrIndex is NAV_BASE.csv by ident.
type nasrIndex map[string][]nasrNavaid

// nasrKinds maps a navaid's type to the NAV_BASE kinds it is filed under.
var nasrKinds = map[string][]string{
	"NDB":     {"NDB", "NDB/DME", "MARINE NDB"},
	"DME":     {"DME"},
	"VOR-DME": {"VOR/DME"},
	"VOR":     {"VOR"},
	"VORTAC":  {"VORTAC"},
	"TACAN":   {"TACAN"},
}

// match is the NAV_BASE row of a navaid: its ident, a kind its type is filed
// under, the nearest within sameSiteNM. Two stations sharing an ident (the
// NDB pairs AA, BR, CO, IL and VV) are hundreds of NM apart.
func (ix nasrIndex) match(typ, ident string, lat, lon float64) (nasrNavaid, bool) {
	var best nasrNavaid
	found := false
	bestD := float64(sameSiteNM)
	for _, n := range ix[ident] {
		if !containsString(nasrKinds[typ], n.kind) {
			continue
		}
		if d := distanceNM(lat, lon, n.lat, n.lon); d <= bestD {
			best, bestD, found = n, d, true
		}
	}
	return best, found
}

func containsString(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// nasrEdition is an edition's register as the navaids take it: the rows,
// what the meta says they are, and the digest of NAV_BASE.csv, which the
// meta's source digest covers beside the layers' (the frequencies are its).
type nasrEdition struct {
	index  nasrIndex
	source string
	digest []byte
}

// fetchNASRNavaids reads an edition's NAV_BASE.csv off its CSV extract.
func fetchNASRNavaids(ctx context.Context, ed Edition) (nasrEdition, error) {
	ctx, cancel := context.WithTimeout(ctx, nasrFetchTimeout)
	defer cancel()
	body, err := overlay.HTTPGetAllLimited(ctx, nasrCSVURL(ed.Date), maxNASRExtract)
	if err != nil {
		return nasrEdition{}, err
	}
	ix, digest, err := nasrFromZip(body)
	if err != nil {
		return nasrEdition{}, err
	}
	return nasrEdition{index: ix, source: "NASR " + ed.Date.Format("2006-01-02") + " NAV_BASE.csv", digest: digest}, nil
}

// nasrFromZip reads NAV_BASE.csv out of a NASR CSV extract, with the
// file's digest.
func nasrFromZip(body []byte) (nasrIndex, []byte, error) {
	zr, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		return nil, nil, fmt.Errorf("NASR extract: %w", err)
	}
	for _, f := range zr.File {
		if !strings.EqualFold(f.Name, "NAV_BASE.csv") {
			continue
		}
		if f.UncompressedSize64 > maxNASRNavBase {
			return nil, nil, fmt.Errorf("NASR extract: NAV_BASE.csv declares %d bytes, over %d", f.UncompressedSize64, maxNASRNavBase)
		}
		rc, err := f.Open()
		if err != nil {
			return nil, nil, err
		}
		defer rc.Close()
		data, err := io.ReadAll(io.LimitReader(rc, maxNASRNavBase+1))
		if err != nil {
			return nil, nil, err
		}
		if len(data) > maxNASRNavBase {
			return nil, nil, fmt.Errorf("NASR extract: NAV_BASE.csv over %d bytes", maxNASRNavBase)
		}
		ix, err := parseNASRNavBase(data)
		if err != nil {
			return nil, nil, err
		}
		sum := sha256.Sum256(data)
		return ix, sum[:], nil
	}
	return nil, nil, fmt.Errorf("NASR extract holds no NAV_BASE.csv")
}

// parseNASRNavBase reads NAV_BASE.csv. A byte order mark is read past,
// should an edition carry one: the header's first field is quoted, and one
// in front of its quote would make the whole header a parse error. A file
// whose positions no longer read as decimal degrees is refused rather than
// read as a register listing nothing (every row of the 2026-09-03 edition
// carries one).
func parseNASRNavBase(data []byte) (nasrIndex, error) {
	r := csv.NewReader(bytes.NewReader(bytes.TrimPrefix(data, []byte("\xef\xbb\xbf"))))
	r.FieldsPerRecord = -1
	head, err := r.Read()
	if err != nil {
		return nil, fmt.Errorf("NAV_BASE.csv: %w", err)
	}
	col := map[string]int{}
	for i, h := range head {
		col[strings.TrimSpace(h)] = i
	}
	for _, need := range []string{"NAV_ID", "NAV_TYPE", "NAV_STATUS", "LAT_DECIMAL", "LONG_DECIMAL", "FREQ", "CHAN", "ELEV"} {
		if _, ok := col[need]; !ok {
			return nil, fmt.Errorf("NAV_BASE.csv: no %s column", need)
		}
	}
	get := func(rec []string, name string) string {
		if i := col[name]; i < len(rec) {
			return strings.TrimSpace(rec[i])
		}
		return ""
	}
	ix := nasrIndex{}
	read, unplaced := 0, 0
	for {
		rec, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("NAV_BASE.csv: %w", err)
		}
		read++
		lat, err1 := strconv.ParseFloat(get(rec, "LAT_DECIMAL"), 64)
		lon, err2 := strconv.ParseFloat(get(rec, "LONG_DECIMAL"), 64)
		ident := get(rec, "NAV_ID")
		if err1 != nil || err2 != nil || ident == "" || math.Abs(lat) > 90 || math.Abs(lon) > 180 {
			unplaced++
			continue
		}
		n := nasrNavaid{
			ident:    ident,
			kind:     strings.ToUpper(get(rec, "NAV_TYPE")),
			lat:      lat,
			lon:      lon,
			shutdown: nasrShutdown(get(rec, "NAV_STATUS")),
		}
		if v, err := strconv.ParseFloat(get(rec, "FREQ"), 64); err == nil && v > 0 {
			n.freq = v
		}
		if c, mode, ok := parseChannel(get(rec, "CHAN")); ok {
			n.channel = fmt.Sprintf("%03d%s", c, mode)
		}
		if v, err := strconv.ParseFloat(get(rec, "ELEV"), 64); err == nil {
			n.elevFt = int(math.Round(v))
		}
		ix[ident] = append(ix[ident], n)
	}
	if read == 0 || unplaced*100 > read {
		return nil, fmt.Errorf("NAV_BASE.csv: %d of %d rows carry no ident or decimal position", unplaced, read)
	}
	return ix, nil
}

// nasrShutdown reads a NAV_STATUS: "SHUTDOWN", and a decommissioning
// should NASR ever list one, is no station to draw.
func nasrShutdown(status string) bool {
	s := strings.ToUpper(status)
	return strings.Contains(s, "SHUTDOWN") || strings.Contains(s, "DECOMM")
}
