package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/0intro/loxodrome/internal/aixm5"
	"github.com/0intro/loxodrome/internal/aixm5build"
	"github.com/0intro/loxodrome/internal/eaip"
)

// runway is one runway row, in the builder's feet.
type runway struct {
	le, he        string
	length, width *float64
	surface       string
	// dists are le LDA, TORA, TODA, ASDA, then he's, as the rows set them.
	dists [8]*float64
}

// row is one aerodrome row, decoded by field name from either side.
type row struct {
	ident    string
	lat, lon float64
	elev, ta *float64
	runways  []runway
	freqs    map[string]bool
}

// readAirports reads every aerodrome page of the package and returns the
// rows the shared builder makes of them.
func readAirports(ctx context.Context, site *eaip.Site, cyc eaip.Cycle, workers int) (map[string]row, error) {
	ads, err := site.Aerodromes(ctx, cyc)
	if err != nil {
		return nil, err
	}
	var (
		mu  sync.Mutex
		msg aixm5.Message
		wg  sync.WaitGroup
	)
	jobs := make(chan eaip.Aerodrome)
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for ad := range jobs {
				body, err := site.Get(ctx, ad.URL)
				if err != nil {
					fmt.Fprintf(os.Stderr, "%s: %v\n", ad.ICAO, err)
					continue
				}
				doc, err := eaip.ParseHTML(body)
				if err != nil {
					continue
				}
				if ap, ok := eaip.ReadAerodrome(doc, ad.ICAO, ad.Section == 3); ok {
					mu.Lock()
					msg.Airports = append(msg.Airports, ap)
					mu.Unlock()
				}
			}
		}()
	}
	for _, ad := range ads {
		jobs <- ad
	}
	close(jobs)
	wg.Wait()
	art, _, err := aixm5build.BuildAirports(&msg, "aipdiff", nil, "", aixm5build.AirportsOptions{
		Country:         "XX",
		CountryFromIcao: func(string) string { return "XX" },
		Now:             time.Now,
		MinAirports:     1,
		MaxAirports:     5000,
	})
	if err != nil {
		return nil, err
	}
	b, err := json.Marshal(art)
	if err != nil {
		return nil, err
	}
	return decodeRows(b)
}

func loadRows(path string) (map[string]row, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return decodeRows(b)
}

// decodeRows reads an airports artifact by its field names.
func decodeRows(b []byte) (map[string]row, error) {
	var art struct {
		Fields          []string `json:"fields"`
		RunwayFields    []string `json:"runwayFields"`
		FrequencyFields []string `json:"frequencyFields"`
		Rows            [][]any  `json:"rows"`
	}
	if err := json.Unmarshal(b, &art); err != nil {
		return nil, err
	}
	idx := func(fields []string, name string) int {
		for i, f := range fields {
			if f == name {
				return i
			}
		}
		return -1
	}
	num := func(v any) *float64 {
		if f, ok := v.(float64); ok {
			return &f
		}
		return nil
	}
	str := func(v any) string {
		s, _ := v.(string)
		return s
	}
	fi := map[string]int{}
	for _, n := range []string{"ident", "lat", "lon", "elev_ft", "transition_alt_ft", "runways", "frequencies"} {
		fi[n] = idx(art.Fields, n)
	}
	ri := map[string]int{}
	for _, n := range []string{"le", "he", "length_ft", "width_ft", "surface", "le_lda_ft", "le_tora_ft", "le_toda_ft", "le_asda_ft", "he_lda_ft", "he_tora_ft", "he_toda_ft", "he_asda_ft"} {
		ri[n] = idx(art.RunwayFields, n)
	}
	freqAt := idx(art.FrequencyFields, "freq")
	get := func(r []any, i int) any {
		if i < 0 || i >= len(r) {
			return nil
		}
		return r[i]
	}
	out := map[string]row{}
	for _, r := range art.Rows {
		x := row{ident: str(get(r, fi["ident"])), freqs: map[string]bool{}}
		if f := num(get(r, fi["lat"])); f != nil {
			x.lat = *f
		}
		if f := num(get(r, fi["lon"])); f != nil {
			x.lon = *f
		}
		x.elev = num(get(r, fi["elev_ft"]))
		x.ta = num(get(r, fi["transition_alt_ft"]))
		if rws, ok := get(r, fi["runways"]).([]any); ok {
			for _, v := range rws {
				rr, _ := v.([]any)
				rw := runway{
					le: str(get(rr, ri["le"])), he: str(get(rr, ri["he"])),
					length: num(get(rr, ri["length_ft"])), width: num(get(rr, ri["width_ft"])),
					surface: str(get(rr, ri["surface"])),
				}
				for k, n := range []string{"le_lda_ft", "le_tora_ft", "le_toda_ft", "le_asda_ft", "he_lda_ft", "he_tora_ft", "he_toda_ft", "he_asda_ft"} {
					rw.dists[k] = num(get(rr, ri[n]))
				}
				x.runways = append(x.runways, rw)
			}
		}
		if fs, ok := get(r, fi["frequencies"]).([]any); ok {
			for _, v := range fs {
				ff, _ := v.([]any)
				if f, ok := comFreq(str(get(ff, freqAt))); ok {
					x.freqs[f] = true
				}
			}
		}
		out[x.ident] = x
	}
	return out, nil
}

// comFreq is a frequency as compared: in the VHF COM band the readers
// take, to three decimals, since cmd/fr writes "136.36" where the builder
// writes "136.360", and the SIA's AIXM lists the UHF channels beside.
func comFreq(s string) (string, bool) {
	var f float64
	if _, err := fmt.Sscanf(strings.TrimSpace(s), "%g", &f); err != nil || f < 117.975 || f > 137 {
		return "", false
	}
	return fmt.Sprintf("%.3f", f), true
}

// score is one metric's tally.
type score struct {
	name        string
	agree, seen int
	misses      []string
}

func (s *score) check(ok bool, ident, detail string) {
	s.seen++
	if ok {
		s.agree++
		return
	}
	s.misses = append(s.misses, ident+" "+detail)
}

// report compares the rows read with the truth's and prints the scores.
func report(w io.Writer, state string, cyc eaip.Cycle, read, truth map[string]row) {
	var both, onlyRead, onlyTruth []string
	for id := range read {
		if _, ok := truth[id]; ok {
			both = append(both, id)
		} else {
			onlyRead = append(onlyRead, id)
		}
	}
	for id := range truth {
		if _, ok := read[id]; !ok {
			onlyTruth = append(onlyTruth, id)
		}
	}
	sort.Strings(both)
	sort.Strings(onlyRead)
	sort.Strings(onlyTruth)
	arp := &score{name: "ARP within 100 m"}
	elev := &score{name: "elevation within 2 ft"}
	ta := &score{name: "transition altitude"}
	ends := &score{name: "runway designators"}
	dims := &score{name: "runway length and width within 3 ft"}
	surf := &score{name: "runway surface class"}
	dist := &score{name: "declared distances within 3 ft"}
	freq := &score{name: "frequencies (same set)"}
	freqIn := &score{name: "the AIXM's frequencies all read"}
	for _, id := range both {
		a, b := read[id], truth[id]
		d := metres(a.lat, a.lon, b.lat, b.lon)
		arp.check(d <= 100, id, fmt.Sprintf("%.0f m", d))
		if b.elev != nil {
			elev.check(a.elev != nil && math.Abs(*a.elev-*b.elev) <= 2, id, fmt.Sprintf("%s vs %s", f(a.elev), f(b.elev)))
		}
		if b.ta != nil {
			ta.check(a.ta != nil && *a.ta == *b.ta, id, fmt.Sprintf("%s vs %s", f(a.ta), f(b.ta)))
		}
		am, bm := byEnds(a.runways), byEnds(b.runways)
		ends.check(sameKeys(am, bm), id, fmt.Sprintf("%v vs %v", keys(am), keys(bm)))
		for k, rb := range bm {
			ra, ok := am[k]
			if !ok {
				continue
			}
			dims.check(near(ra.length, rb.length) && near(ra.width, rb.width), id+" "+k,
				fmt.Sprintf("%s x %s vs %s x %s", f(ra.length), f(ra.width), f(rb.length), f(rb.width)))
			surf.check(hard(ra.surface) == hard(rb.surface), id+" "+k, ra.surface+" vs "+rb.surface)
			if hasAny(rb.dists[:]) {
				okd := true
				for i := range rb.dists {
					okd = okd && near(ra.dists[i], rb.dists[i])
				}
				dist.check(okd, id+" "+k, fmt.Sprintf("%s vs %s", fs(ra.dists[:]), fs(rb.dists[:])))
			}
		}
		if len(b.freqs) > 0 {
			freq.check(sameSet(a.freqs, b.freqs), id, fmt.Sprintf("%v vs %v", setKeys(a.freqs), setKeys(b.freqs)))
			var missing []string
			for k := range b.freqs {
				if !a.freqs[k] {
					missing = append(missing, k)
				}
			}
			sort.Strings(missing)
			freqIn.check(len(missing) == 0, id, fmt.Sprintf("missing %v", missing))
		}
	}
	fmt.Fprintf(w, "%s eAIP %s against its AIXM: %d aerodromes read, %d in the AIXM, %d in both\n", state, cyc.Dir, len(read), len(truth), len(both))
	fmt.Fprintf(w, "  only in the eAIP read: %s\n", strings.Join(onlyRead, " "))
	fmt.Fprintf(w, "  only in the AIXM:      %s\n", strings.Join(onlyTruth, " "))
	for _, s := range []*score{arp, elev, ta, ends, dims, surf, dist, freq, freqIn} {
		pct := 100.0
		if s.seen > 0 {
			pct = 100 * float64(s.agree) / float64(s.seen)
		}
		fmt.Fprintf(w, "%-38s %4d / %-4d %5.1f%%\n", s.name, s.agree, s.seen, pct)
		for i, m := range s.misses {
			if i == 12 {
				fmt.Fprintf(w, "      ... %d more\n", len(s.misses)-i)
				break
			}
			fmt.Fprintf(w, "      %s\n", m)
		}
	}
}

// byEnds keys runways by their two ends, in order, leading zeros kept.
func byEnds(rs []runway) map[string]runway {
	out := map[string]runway{}
	for _, r := range rs {
		out[r.le+"/"+r.he] = r
	}
	return out
}

func sameKeys(a, b map[string]runway) bool {
	if len(a) != len(b) {
		return false
	}
	for k := range a {
		if _, ok := b[k]; !ok {
			return false
		}
	}
	return true
}

func keys(m map[string]runway) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func sameSet(a, b map[string]bool) bool {
	if len(a) != len(b) {
		return false
	}
	for k := range a {
		if !b[k] {
			return false
		}
	}
	return true
}

func setKeys(m map[string]bool) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// hard is the surface class the app draws by: paved or not, the AIXM's
// composite codes ("CONC_ASPH", "ASPH_GRASS") read by their first part.
func hard(s string) bool {
	parts := strings.FieldsFunc(s, func(r rune) bool { return r == '_' || r == '+' })
	if len(parts) == 0 {
		return false
	}
	switch strings.ToUpper(parts[0]) {
	case "ASPH", "CONC", "MACADAM", "BITUM", "BITUMINOUS", "PAVED", "BRICK", "TAR":
		return true
	}
	return false
}

func near(a, b *float64) bool {
	switch {
	case a == nil && b == nil:
		return true
	case a == nil || b == nil:
		return false
	}
	return math.Abs(*a-*b) <= 3
}

func hasAny(v []*float64) bool {
	for _, x := range v {
		if x != nil {
			return true
		}
	}
	return false
}

func f(p *float64) string {
	if p == nil {
		return "-"
	}
	return fmt.Sprintf("%.0f", *p)
}

func fs(v []*float64) string {
	var out []string
	for _, p := range v {
		out = append(out, f(p))
	}
	return strings.Join(out, ",")
}

// metres is the great-circle distance between two points.
func metres(lat1, lon1, lat2, lon2 float64) float64 {
	r := math.Pi / 180
	dlat, dlon := (lat2-lat1)*r, (lon2-lon1)*r
	a := math.Sin(dlat/2)*math.Sin(dlat/2) + math.Cos(lat1*r)*math.Cos(lat2*r)*math.Sin(dlon/2)*math.Sin(dlon/2)
	return 6371000 * 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
}
