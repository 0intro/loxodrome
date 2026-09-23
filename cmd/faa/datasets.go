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
	"fmt"

	"github.com/0intro/loxodrome/internal/aip"
)

// runPointDatasets builds faa-navaids.json and faa-obstacles.json.
func runPointDatasets(ctx context.Context, outDir string, want func(string) bool, win aip.SanityWindows) error {
	current, err := fetchEdition(ctx, "current")
	if err != nil {
		return fmt.Errorf("current edition: %w", err)
	}

	if want("navaids") {
		if err := buildNavaidSlot(ctx, outDir, "current", current, navaidSystemURL, designatedPointURL, win); err != nil {
			return err
		}
		// The next slot rides the pre-release layers, when they are
		// genuinely ahead of the current edition.
		ahead, why := pendingIsAhead(ctx, navaidSystemNextURL, current)
		if !ahead {
			fmt.Printf("faa-navaids: no next slot (%s)\n", why)
		} else {
			next, err := fetchEdition(ctx, "next")
			if err != nil {
				return fmt.Errorf("next edition: %w", err)
			}
			if err := buildNavaidSlot(ctx, outDir, "next", next, navaidSystemNextURL, designatedPointNextURL, win); err != nil {
				return err
			}
		}
	}

	if want("airports") {
		if err := buildAirportSlot(ctx, outDir, "current", current, usAirportURL, usRunwayURL, win); err != nil {
			return err
		}
		ahead, why := pendingIsAhead(ctx, usAirportNextURL, current)
		if !ahead {
			fmt.Printf("faa-airports: no next slot (%s)\n", why)
		} else {
			next, err := fetchEdition(ctx, "next")
			if err != nil {
				return fmt.Errorf("next edition: %w", err)
			}
			if err := buildAirportSlot(ctx, outDir, "next", next, usAirportNextURL, usRunwayNextURL, win); err != nil {
				return err
			}
		}
	}

	if want("obstacles") {
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
	}
	return nil
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

func buildNavaidSlot(ctx context.Context, outDir, target string, ed Edition, systemURL, pointURL string, win aip.SanityWindows) error {
	systems, components, points, err := fetchPointLayers(ctx, systemURL, pointURL)
	if err != nil {
		return err
	}
	art, meta, err := BuildNavaids(systems, components, points, NavaidsOptions{
		Source:     "FAA AIS NAVAIDSystem + NavaidComponent + DesignatedPoints",
		Effective:  ed.Effective,
		MinNavaids: win.MinNavaids,
		MaxNavaids: win.MaxNavaids,
	})
	if err != nil {
		return err
	}
	slot, err := aip.WriteDataset(outDir, "faa-navaids", target, meta.Effective, art, meta)
	if err != nil {
		return fmt.Errorf("navaids: %w", err)
	}
	fmt.Printf("wrote %d US navaids (%d radio, %d points, %d CNF skipped); effective %s; slot=%s\n",
		meta.NavaidCount, meta.RadioCount, meta.PointCount, meta.SkippedCnf, meta.Effective, slot)
	return nil
}
