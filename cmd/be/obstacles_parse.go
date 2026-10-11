// obstacles_parse.go: the ENR 5.4 en-route obstacle table →
// aixm5.Obstacle features, through internal/eaip's reader, lifted from
// this file, which skeyes's headings (no unit: feet) read unchanged.

package main

import (
	"github.com/0intro/loxodrome/internal/aixm5"
	"github.com/0intro/loxodrome/internal/eaip"
)

// parseObstacles reads every ENR 5.4 table that carries an
// elevation/height column.
func parseObstacles(t *tree) []aixm5.Obstacle {
	doc := t.doc("eAIP/EB-ENR-5.4-en-GB.html")
	if doc == nil {
		return nil
	}
	return eaip.ParseObstacleTables(doc)
}
