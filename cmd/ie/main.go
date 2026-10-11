// Command ie reads the Irish Aviation Authority's obstacle registers and
// emits ie-obstacles.json.
//
// Obstacles only: Ireland's airspace, aerodromes and navaids come from
// AirNav Ireland's eAIP through cmd/eaip. Its ENR 5.4 prints no table and
// points instead at the IAA's obstacle page, which publishes the register
// as a spreadsheet per AIRAC amendment, the way cmd/fi reads Finland's
// from Fintraffic's. Both go through internal/obstable, the one reader for
// the eTOD registers the States publish as tables.
//
// The page carries two registers and this command reads both:
//
//   - Area 1, the obstacles 100 m AGL or higher over the whole of the
//     Shannon FIR, which is what ICAO Annex 15 and the EU rules require
//     (about 2200, nine in ten of them wind-farm turbines);
//   - the Safety Significant Obstacles, "an obstacle that falls outside
//     the scope of ICAO standards & EU regulations (below 100m AGL), but
//     has been deemed safety significant to air navigation through the
//     charting workshops in consultation with the Aviation community"
//     (about 900): the masts and turbines under 100 m the IAA judged a
//     VFR pilot must know of, which is the traffic this app serves.
//
// The two are amended apart, so a slot is built from each register's
// edition in force on its date (fetch.go).
//
// Licence: the obstacle page states no terms of re-use, its footer
// reserving the copyright ("© Irish Aviation Authority"), and the IAA's
// disclaimer speaks of the accuracy of the legislation it publishes and
// nothing else. That is the class Ireland's eAIP is in, whose GEN 0.1
// carries no copyright item (docs/aip-sources.md): copyright reserved
// without a prohibition, so the data ships, credited to the IAA.
//
// Run directly:
//
//	go run ./cmd/ie
//	go run ./cmd/ie -target next
//	go run ./cmd/ie -keep local/ie-obstacles
//	go run ./cmd/ie -in local/ie-obstacles/enr-5-4-airac-amendment-008-26-effective-aug-2026.xlsx \
//	    -sso local/ie-obstacles/safety-significant-obstacles-airac-amendment-008-26-effective-aug-2026.xlsx
package main

import (
	"cmp"
	"context"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/aixm5"
	"github.com/0intro/loxodrome/internal/aixm5build"
)

const (
	// defaultOutDir is resolved relative to the working directory,
	// expected to be the repo root (`go run ./cmd/ie`).
	defaultOutDir = "public/data"

	// About 3100 rows in September 2026; the window is wide enough for
	// real growth and tight enough to catch a truncated download or a
	// register gone missing.
	defaultMinIeObstacles = 2000
	defaultMaxIeObstacles = 10000

	fetchTimeout = 10 * time.Minute
)

// obstaclesMeta is the sidecar: the shared builder's, with what each
// register contributed.
type obstaclesMeta struct {
	aixm5build.ObstaclesMeta
	// Area1 and SafetySignificant count the rows each register
	// contributed, under the source file each was read from.
	Area1                   int    `json:"area1"`
	Area1Source             string `json:"area1Source"`
	SafetySignificant       int    `json:"safetySignificant"`
	SafetySignificantSource string `json:"safetySignificantSource"`
	// SkippedNoPosition counts rows with an identifier and no position,
	// which cannot be drawn.
	SkippedNoPosition int `json:"skippedNoPosition"`
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	in := flag.String("in", "", "path to a local Area 1 register .xlsx (skips the fetch; needs -sso)")
	sso := flag.String("sso", "", "path to a local Safety Significant Obstacles .xlsx (with -in)")
	outDir := flag.String("out", defaultOutDir, "output directory for ie-obstacles.json and ie-obstacles.meta.json")
	target := flag.String("target", "auto", `release and output slot: "current" (ie-obstacles.json), "next" (ie-obstacles.next.json), or "auto"`)
	only := flag.String("only", "", "comma-separated dataset filter; empty means all (obstacles)")
	keep := flag.String("keep", "", "write the downloaded spreadsheets into this directory, under their published names (offline replay with -in / -sso)")
	var win aip.SanityWindows
	win.Register(flag.CommandLine)
	flag.Parse()

	want := aip.DatasetFilter(*only)
	if !want("obstacles") {
		return nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), fetchTimeout)
	defer cancel()

	var p *pick
	if *in != "" || *sso != "" {
		if *in == "" || *sso == "" {
			return fmt.Errorf("-in and -sso go together: the data set is both registers")
		}
		var err error
		if p, err = localPick(*in, *sso); err != nil {
			return err
		}
	} else {
		var err error
		if p, err = resolvePick(ctx, *target, time.Now(), *keep); err != nil {
			return err
		}
		if p == nil {
			// A pre-release the IAA has not posted yet is normal, not a
			// failure: the current slot stays on the edition in force.
			fmt.Println("no pre-release published; nothing to do")
			return nil
		}
		for _, r := range []*release{p.area1, p.safetySignificant} {
			if r.body == nil {
				if r.body, err = download(ctx, *r, *keep); err != nil {
					return err
				}
			}
		}
	}

	var regs [2]*register
	for i, r := range []*release{p.area1, p.safetySignificant} {
		reg, err := readRegister(r.body, r.Name)
		if err != nil {
			return err
		}
		// Re-dated against the change record now it is read: the pick
		// dated the unambiguous months off the name alone.
		if r.Effective, err = effectiveOf(*r, reg.edition); err != nil {
			return err
		}
		regs[i] = reg
	}

	obstacles := append(append([]aixm5.Obstacle(nil), regs[0].obstacles...), regs[1].obstacles...)
	source := p.area1.Name + " + " + p.safetySignificant.Name
	raw := append(append([]byte(nil), p.area1.body...), p.safetySignificant.body...)
	effective := p.effective().Format("2006-01-02") + "T00:00:00.000Z"

	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		return err
	}
	artifact, meta, err := aixm5build.BuildObstacles(&aixm5.Message{Obstacles: obstacles}, source, raw, effective,
		aixm5build.ObstaclesOptions{
			IDPrefix:     "ie",
			Country:      "IE",
			Now:          time.Now,
			MinObstacles: cmp.Or(win.MinObstacles, defaultMinIeObstacles),
			MaxObstacles: cmp.Or(win.MaxObstacles, defaultMaxIeObstacles),
		})
	if err != nil {
		return err
	}
	slot, err := aip.WriteDataset(*outDir, "ie-obstacles", *target, meta.Effective, artifact, obstaclesMeta{
		ObstaclesMeta:           meta,
		Area1:                   len(regs[0].obstacles),
		Area1Source:             p.area1.Name,
		SafetySignificant:       len(regs[1].obstacles),
		SafetySignificantSource: p.safetySignificant.Name,
		SkippedNoPosition:       regs[0].stats.SkippedNoPosition + regs[1].stats.SkippedNoPosition,
	})
	if err != nil {
		return err
	}
	fmt.Printf("wrote %d obstacles (%d lit; Area 1 %d, safety significant %d) from %s; effective %s; slot=%s\n",
		meta.ObstacleCount, meta.LitCount, len(regs[0].obstacles), len(regs[1].obstacles), source, meta.Effective, slot)
	if n := regs[0].stats.SkippedNoPosition + regs[1].stats.SkippedNoPosition; n > 0 {
		fmt.Printf("skipped %d rows with no readable position\n", n)
	}
	if len(meta.UnknownTypes) > 0 {
		fmt.Printf("unmapped obstacle types: %v\n", meta.UnknownTypes)
	}
	return nil
}

// localPick reads a replay's two files, dated off their published names.
func localPick(area1Path, ssoPath string) (*pick, error) {
	var p pick
	for _, f := range []struct {
		path string
		dst  **release
	}{{area1Path, &p.area1}, {ssoPath, &p.safetySignificant}} {
		b, err := os.ReadFile(f.path)
		if err != nil {
			return nil, err
		}
		name := filepath.Base(f.path)
		y, mon, ok := monthOf(name)
		if !ok {
			return nil, fmt.Errorf("%s: no effective-<month>-<year> in the name (keep the published name, as -keep does)", name)
		}
		*f.dst = &release{Name: name, year: y, month: mon, body: b}
	}
	return &p, nil
}
