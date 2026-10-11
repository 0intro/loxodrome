// obstacles.go writes <cc>-obstacles.json from ENR 5.4, for the States
// whose obstacles this command owns (State.ObstacleSection): Finland's
// are cmd/fi's, from the Area 1 register, which ENR 5.4 only samples.

package main

import (
	"fmt"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/aixm5"
	"github.com/0intro/loxodrome/internal/aixm5build"
)

// obstaclesMeta is the sidecar: the shared builder's, with how the
// package was found.
type obstaclesMeta struct {
	aixm5build.ObstaclesMeta
	resolution
}

func writeObstacles(s *State, outDir, target, source, effective string, resolved resolution,
	obstacles []aixm5.Obstacle, win aip.SanityWindows,
) error {
	msg := aixm5.Message{Obstacles: obstacles}
	artifact, meta, err := aixm5build.BuildObstacles(&msg, s.Label+" "+source, nil, effective,
		aixm5build.ObstaclesOptions{
			IDPrefix:     strings.ToLower(s.CC),
			Country:      strings.ToUpper(s.CC),
			Now:          time.Now,
			MinObstacles: orDefault(win.MinObstacles, 1),
			MaxObstacles: orDefault(win.MaxObstacles, 20000),
		})
	if err != nil {
		return err
	}
	slot, err := aip.WriteDataset(outDir, s.CC+"-obstacles", target, meta.Effective, artifact,
		obstaclesMeta{ObstaclesMeta: meta, resolution: resolved})
	if err != nil {
		return err
	}
	fmt.Printf("%s: wrote %d obstacles (%d lit); slot=%s\n", s.CC, meta.ObstacleCount, meta.LitCount, slot)
	return nil
}
