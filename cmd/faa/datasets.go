// datasets.go drives the US navaid and obstacle datasets across both
// AIRAC slots.
//
// The current slot always builds. The next slot builds only when the
// hub's Pending_* layers really hold the next cycle, which edition.go
// decides; outside the FAA's pre-release window they are last cycle's
// leftovers and writing them to the .next slot would republish the
// current cycle as the next one.
//
// The obstacle file has no pre-release twin at all: the Digital Obstacle
// File is a rolling product, not an AIRAC one, so it writes the current
// slot only.

package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/overlay"
)

// runPointDatasets builds faa-navaids.json, faa-airports.json and
// faa-obstacles.json, each on its own: one that fails (a navaid build
// refused for want of its NASR register, buildNavaids) leaves the others
// written, and fails the run once they are.
func runPointDatasets(ctx context.Context, outDir string, want func(string) bool, win aip.SanityWindows) error {
	current, err := fetchEdition(ctx, "current")
	if err != nil {
		return fmt.Errorf("current edition: %w", err)
	}
	var errs []error
	if want("navaids") {
		errs = append(errs, buildNavaids(ctx, outDir, current, win))
	}
	if want("airports") {
		errs = append(errs, buildAirportSlots(ctx, outDir, current, win))
	}
	if want("obstacles") {
		errs = append(errs, buildObstacleFile(ctx, outDir, current, win))
	}
	return errors.Join(errs...)
}

// buildAirportSlots writes the current airport slot, and the next when the
// hub's pre-release layers are ahead of the current edition.
func buildAirportSlots(ctx context.Context, outDir string, current Edition, win aip.SanityWindows) error {
	if err := buildAirportSlot(ctx, outDir, "current", current, usAirportURL, usRunwayURL, win); err != nil {
		return err
	}
	ahead, why := pendingIsAhead(ctx, usAirportNextURL, current)
	if !ahead {
		fmt.Printf("faa-airports: no next slot (%s)\n", why)
		return nil
	}
	next, err := fetchEdition(ctx, "next")
	if err != nil {
		return fmt.Errorf("next edition: %w", err)
	}
	return buildAirportSlot(ctx, outDir, "next", next, usAirportNextURL, usRunwayNextURL, win)
}

// buildObstacleFile writes the one obstacle slot.
func buildObstacleFile(ctx context.Context, outDir string, current Edition, win aip.SanityWindows) error {
	raw, err := fetchFAAWhere(ctx, dofURL, fmt.Sprintf("AGL>=%d", usObstacleFloorFt))
	if err != nil {
		return fmt.Errorf("Digital_Obstacle_File: %w", err)
	}
	art, meta, err := BuildObstacles(raw, ObstaclesOptions{
		Source:       fmt.Sprintf("FAA Digital Obstacle File (>= %d ft AGL)", usObstacleFloorFt),
		Effective:    current.Effective,
		MinObstacles: win.MinObstacles,
		MaxObstacles: win.MaxObstacles,
	})
	if err != nil {
		return err
	}
	slot, err := aip.WriteDataset(outDir, "faa-obstacles", "current", meta.Effective, art, meta)
	if err != nil {
		return fmt.Errorf("obstacles: %w", err)
	}
	fmt.Printf("wrote %d US obstacles (%d lit, >= %d ft AGL); effective %s; slot=%s\n",
		meta.ObstacleCount, meta.LitCount, usObstacleFloorFt, meta.Effective, slot)
	return nil
}

// minNASRShare is the share of the radio navaids written that NASR must
// register: 1 331 of 1 367 in the 2026-09-03 edition, the rest foreign
// stations it does not list. Under it, the register read is not the one
// this builder knows (positions in another form, stations renamed), and
// the navaids would be written off the 2016 components.
const minNASRShare = 0.9

// buildNavaids writes both navaid slots, or neither when the current
// edition's NASR register cannot be read. The components beside it were
// last edited in 2016, 163 of their frequencies stale and 38 missing, so a
// build without it would publish wrong frequencies over the right ones
// already committed, and put them back the week after: the committed file
// stands and the run fails, which is what says so.
func buildNavaids(ctx context.Context, outDir string, current Edition, win aip.SanityWindows) error {
	cur, err := fetchNASRNavaids(ctx, current)
	if err != nil {
		return fmt.Errorf("faa-navaids left as committed, NASR %s unreadable: %w", current.Date.Format("2006-01-02"), err)
	}
	if err := buildNavaidSlot(ctx, outDir, "current", current, navaidSystemURL, designatedPointURL, win, cur); err != nil {
		return err
	}
	// The next slot rides the pre-release layers, when they are genuinely
	// ahead of the current edition.
	ahead, why := pendingIsAhead(ctx, navaidSystemNextURL, current)
	if !ahead {
		fmt.Printf("faa-navaids: no next slot (%s)\n", why)
		return nil
	}
	next, err := fetchEdition(ctx, "next")
	if err != nil {
		return fmt.Errorf("next edition: %w", err)
	}
	// The next edition's register once the FAA has put it out, the current
	// one's until then: a frequency changes rarely from one cycle to the
	// next, the 2016 components always.
	nextNASR, err := fetchNASRNavaids(ctx, next)
	if err != nil {
		state := "unreadable"
		var se *overlay.StatusError
		if errors.As(err, &se) && se.Status == http.StatusNotFound {
			state = "not out"
		}
		fmt.Fprintf(os.Stderr, "NASR %s %s, the next slot reads the current edition's: %v\n", next.Date.Format("2006-01-02"), state, err)
		nextNASR = cur
		nextNASR.source = cur.source + " (the next edition's is " + state + ")"
	}
	return buildNavaidSlot(ctx, outDir, "next", next, navaidSystemNextURL, designatedPointNextURL, win, nextNASR)
}

func buildAirportSlot(ctx context.Context, outDir, target string, ed Edition, airportURL, runwayURL string, win aip.SanityWindows) error {
	airports, runways, err := fetchAirportLayers(ctx, airportURL, runwayURL)
	if err != nil {
		return err
	}
	art, meta, err := BuildAirports(airports, runways, AirportsOptions{
		Source:      "FAA AIS US_Airport + Runways",
		Effective:   ed.Effective,
		MinAirports: win.MinAirports,
		MaxAirports: win.MaxAirports,
	})
	if err != nil {
		return err
	}
	slot, err := aip.WriteDataset(outDir, "faa-airports", target, meta.Effective, art, meta)
	if err != nil {
		return fmt.Errorf("airports: %w", err)
	}
	fmt.Printf("wrote %d US airports (%d runways, %d military, %d joint, %d private, %d with an ICAO code); effective %s; slot=%s\n",
		meta.AhpCount, meta.RunwayCount, meta.MilitaryCount, meta.JointCount,
		meta.PrivateCount, meta.IcaoCount, meta.Effective, slot)
	return nil
}

func buildNavaidSlot(ctx context.Context, outDir, target string, ed Edition, systemURL, pointURL string, win aip.SanityWindows, nasr nasrEdition) error {
	systems, components, points, err := fetchPointLayers(ctx, systemURL, pointURL)
	if err != nil {
		return err
	}
	art, meta, err := BuildNavaids(systems, components, points, NavaidsOptions{
		Source:     "FAA AIS NAVAIDSystem + NASR NAV_BASE + NavaidComponent + DesignatedPoints",
		Effective:  ed.Effective,
		MinNavaids: win.MinNavaids,
		MaxNavaids: win.MaxNavaids,
		NASR:       nasr.index,
		NASRSource: nasr.source,
		NASRDigest: nasr.digest,
	})
	if err != nil {
		return err
	}
	if float64(meta.NASRMatched) < minNASRShare*float64(meta.RadioCount) {
		return fmt.Errorf("faa-navaids %s left as committed: NASR registers %d of the %d radio navaids, under %.0f%%",
			target, meta.NASRMatched, meta.RadioCount, minNASRShare*100)
	}
	slot, err := aip.WriteDataset(outDir, "faa-navaids", target, meta.Effective, art, meta)
	if err != nil {
		return fmt.Errorf("navaids: %w", err)
	}
	fmt.Printf("wrote %d US navaids (%d radio, %d of them from NASR, %d closed skipped, %d points, %d CNF skipped); effective %s; slot=%s\n",
		meta.NavaidCount, meta.RadioCount, meta.NASRMatched, meta.SkippedClosed, meta.PointCount, meta.SkippedCnf, meta.Effective, slot)
	return nil
}
