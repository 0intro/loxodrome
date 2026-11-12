package main

// sd_oracle_ad_test.go holds the aerodrome reader (eaip.ReadAerodrome)
// against the structured-data tags of the aerodrome pages, as
// sd_oracle_test.go holds the ENR readers: the runways' length and width
// (TRWY VAL_LEN, VAL_WID), their declared distances
// (TRWY_DIRECTION_DECL_DIST VAL_DIST) and the COM channels (TFREQUENCY
// VAL_FREQ_TRANS).
//
//	EAIP_SD=local/ad2snap EAIP_SD_DATE=2026-09-10 go test ./cmd/eaip -run SDOracleAerodromes -v
//
// Each figure is scored both ways. What the reader reports must be what the
// tags state (precision): a figure read that no tag carries is a misreading.
// What the tags state need not all be read (recall): a declared distance
// from an intersection is tagged beside the runway's own, and the reader
// keeps the runway's, and a page tags the channels of the units it only
// mentions.

import (
	"context"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/0intro/loxodrome/internal/aixm5"
	"github.com/0intro/loxodrome/internal/eaip"
)

// sdADFloors are the precision each State's reading reaches today, a
// little under what the 2026-09-03 packages measured: every figure read
// is tagged but one Czech channel (LKCV's 123.3).
var sdADFloors = map[string]map[string]float64{
	"uk": {"lengths": 0.99, "widths": 0.99, "distances": 0.99, "channels": 0.99},
	"cz": {"lengths": 0.99, "widths": 0.99, "distances": 0.99, "channels": 0.97},
	"no": {"lengths": 0.99, "widths": 0.99, "distances": 0.99, "channels": 0.99},
}

// sdADRecallFloors are the share of the tagged figures read today. What
// is left is by design: a runway's variants lettered X or S (Bournemouth's
// 26X, Old Warden's 02X/20X, Notodden's 12S/30S) and the helicopter
// areas, the declared distances from intersections, the channels of the
// units a page only mentions (Praha Information in Mošnov's remarks).
var sdADRecallFloors = map[string]map[string]float64{
	"uk": {"lengths": 0.96, "widths": 0.96, "distances": 0.65, "channels": 0.97},
	"cz": {"lengths": 0.99, "widths": 0.99, "distances": 0.63, "channels": 0.94},
	"no": {"lengths": 0.90, "widths": 0.90, "distances": 0.50, "channels": 0.95},
}

// sdTally is one figure's agreement, both ways.
type sdTally struct {
	read, readTagged          int // figures read, and of those the tags state
	tagged, taggedRead        int // figures tagged, and of those the reader read
	missSamples, extraSamples []string
}

func (t *sdTally) sample(dst *[]string, s string) {
	if len(*dst) < 10 {
		*dst = append(*dst, s)
	}
}

// compare scores one aerodrome's figures, as multisets of rounded values.
func (t *sdTally) compare(icao string, tagged, read []float64) {
	key := func(v float64) string { return strconv.FormatFloat(math.Round(v*1000)/1000, 'f', -1, 64) }
	left := map[string]int{}
	for _, v := range tagged {
		left[key(v)]++
	}
	for _, v := range read {
		t.read++
		if left[key(v)] > 0 {
			left[key(v)]--
			t.readTagged++
		} else {
			t.sample(&t.extraSamples, icao+" "+key(v))
		}
	}
	t.tagged += len(tagged)
	t.taggedRead = t.readTagged
	for k, n := range left {
		if n > 0 {
			t.sample(&t.missSamples, icao+" "+k)
		}
	}
}

func (t *sdTally) add(o sdTally) {
	t.read += o.read
	t.readTagged += o.readTagged
	t.tagged += o.tagged
	t.taggedRead += o.taggedRead
	for _, s := range o.missSamples {
		t.sample(&t.missSamples, s)
	}
	for _, s := range o.extraSamples {
		t.sample(&t.extraSamples, s)
	}
}

func TestSDOracleAerodromes(t *testing.T) {
	root := os.Getenv("EAIP_SD")
	if root == "" {
		t.Skip("EAIP_SD unset: point it at a -snapshot root holding cz or no")
	}
	date := time.Now()
	if d := os.Getenv("EAIP_SD_DATE"); d != "" {
		var err error
		if date, err = time.Parse("2006-01-02", d); err != nil {
			t.Fatal(err)
		}
	}
	for _, s := range append([]State{sdUK}, states...) {
		if s.CC != "uk" && s.CC != "cz" && s.CC != "no" {
			continue
		}
		if _, err := os.Stat(filepath.Join(root, s.CC)); err != nil {
			continue
		}
		t.Run(s.CC, func(t *testing.T) {
			fill := os.Getenv("EAIP_SD_FILL") != ""
			setReplay(&s, filepath.Join(root, s.CC), fill)
			ctx := context.Background()
			cyc, err := s.Site.Resolve(ctx, s.Sections[0], date, false)
			if err != nil {
				t.Fatalf("%s: %v", s.CC, err)
			}
			pkg := &eaipPackage{label: s.Label, s: &s.Site, cyc: cyc, spec: &s.Spec}
			ads, err := pkg.aerodromes(ctx)
			if err != nil {
				t.Fatalf("%s: %v", s.CC, err)
			}
			tallies := map[string]*sdTally{"lengths": {}, "widths": {}, "distances": {}, "channels": {}}
			pages := 0
			for _, ad := range ads {
				if ad.Section != 2 {
					continue
				}
				body, err := s.Site.Get(ctx, ad.URL)
				if err != nil {
					continue // not in the snapshot
				}
				doc, err := eaip.ParseHTML(body)
				if err != nil {
					t.Fatalf("%s: %v", ad.ICAO, err)
				}
				ap, ok := eaip.ReadAerodrome(doc, ad.ICAO, false)
				if !ok {
					continue
				}
				pages++
				tags := eaip.SDTags(doc)
				for name, fig := range sdAerodromeFigures(tags, ap) {
					var one sdTally
					one.compare(ad.ICAO, fig[0], fig[1])
					tallies[name].add(one)
				}
			}
			names := []string{"lengths", "widths", "distances", "channels"}
			for _, name := range names {
				tl := tallies[name]
				t.Logf("%s %s over %d pages: read %d, tagged %d of them (%.1f%%); tagged %d, read %d of them (%.1f%%)",
					s.CC, name, pages, tl.read, tl.readTagged, 100*ratio(tl.readTagged, tl.read),
					tl.tagged, tl.taggedRead, 100*ratio(tl.taggedRead, tl.tagged))
				if len(tl.extraSamples) > 0 {
					sort.Strings(tl.extraSamples)
					t.Logf("  read, not tagged: %s", strings.Join(tl.extraSamples, "; "))
				}
				if len(tl.missSamples) > 0 {
					sort.Strings(tl.missSamples)
					t.Logf("  tagged, not read: %s", strings.Join(tl.missSamples, "; "))
				}
				if floor, ok := sdADFloors[s.CC][name]; ok && ratio(tl.readTagged, tl.read) < floor {
					t.Errorf("%s %s: %d of %d read figures tagged, below the floor %.3f", s.CC, name, tl.readTagged, tl.read, floor)
				}
				if floor, ok := sdADRecallFloors[s.CC][name]; ok && ratio(tl.taggedRead, tl.tagged) < floor {
					t.Errorf("%s %s: %d of %d tagged figures read, below the floor %.3f", s.CC, name, tl.taggedRead, tl.tagged, floor)
				}
			}
		})
	}
}

// sdAerodromeFigures pairs, per figure, the tagged values with the read
// ones: metres for the runways, MHz for the channels.
func sdAerodromeFigures(tags []eaip.SDValue, ap aixm5.Airport) map[string][2][]float64 {
	out := map[string][2][]float64{}
	num := func(s string) (float64, bool) {
		v, err := strconv.ParseFloat(strings.Replace(strings.TrimSpace(s), ",", ".", 1), 64)
		return v, err == nil
	}
	rwys, order := sdRecords(tags, "TRWY")
	var lens, wids []float64
	for _, rec := range order {
		r := rwys[rec]
		ft := strings.EqualFold(r["UOM_DIM_RWY"], "FT")
		if v, ok := num(r["VAL_LEN"]); ok {
			if ft {
				v *= 0.3048
			}
			lens = append(lens, math.Round(v))
		}
		wft := ft || strings.EqualFold(r["UOM_WID"], "FT")
		if v, ok := num(r["VAL_WID"]); ok {
			if wft {
				v *= 0.3048
			}
			wids = append(wids, math.Round(v))
		}
	}
	var dists []float64
	for _, v := range tags {
		if v.Table == "TRWY_DIRECTION_DECL_DIST" && v.Column == "VAL_DIST" {
			if d, ok := num(v.Value); ok {
				dists = append(dists, math.Round(d))
			}
		}
	}
	var chans []float64
	seenChan := map[float64]bool{}
	for _, v := range tags {
		if v.Table == "TFREQUENCY" && v.Column == "VAL_FREQ_TRANS" {
			if f, ok := num(v.Value); ok && f >= 108 && f < 138 && !seenChan[f] {
				seenChan[f] = true
				chans = append(chans, f)
			}
		}
	}
	var rLens, rWids, rDists, rChans []float64
	for _, r := range ap.Runways {
		if r.LengthM != nil {
			rLens = append(rLens, math.Round(*r.LengthM))
		}
		if r.WidthM != nil {
			rWids = append(rWids, math.Round(*r.WidthM))
		}
		for _, d := range []*float64{r.LeToraM, r.LeTodaM, r.LeAsdaM, r.LeLdaM, r.HeToraM, r.HeTodaM, r.HeAsdaM, r.HeLdaM} {
			if d != nil {
				rDists = append(rDists, math.Round(*d))
			}
		}
	}
	readChan := map[float64]bool{}
	for _, r := range ap.Radio {
		if f, ok := num(r.Freq); ok && !readChan[f] {
			readChan[f] = true
			rChans = append(rChans, f)
		}
	}
	out["lengths"] = [2][]float64{lens, rLens}
	out["widths"] = [2][]float64{wids, rWids}
	out["distances"] = [2][]float64{dists, rDists}
	out["channels"] = [2][]float64{chans, rChans}
	return out
}
