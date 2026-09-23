// inputs.go reads every DFS input file and decodes them together with
// aixm5.DecodeAll. DFS publishes one AIP dataset split across per-
// feature-type files (AirportHeliport, Runway, Service, Navaids,
// Waypoints, Airspace) plus a separate Obstacles Area 1 file; decoding
// them in one pass lets the runway / radio xlink resolution attach
// runways and frequencies to their parent airport.

package main

import (
	"fmt"
	"strings"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/aixm5"
)

// decodeInputs reads and DecodeAll-decodes every input file. It returns
// the merged message, the concatenated source bytes (for the meta
// sidecar's SHA-256), and a composite source label: the single
// filename, "a+b+c", or "a+b+c (+N more)" past three inputs. Unlike
// ENAIRE (cmd/es), which decodes each self-contained per-aerodrome file
// separately and concatenates the output slices, DFS splits
// AirportHeliport / Runway / Service across files, so they must be
// decoded together (aixm5.DecodeAll) for the runway / radio xlink
// resolution to see all three at once.
func decodeInputs(inputs []string) (*aixm5.Message, []byte, string, error) {
	srcs := make([][]byte, 0, len(inputs))
	sources := make([]string, 0, len(inputs))
	var allSrc []byte
	for _, path := range inputs {
		data, srcName, err := aip.ReadLargestXML(path)
		if err != nil {
			return nil, nil, "", err
		}
		srcs = append(srcs, data)
		sources = append(sources, srcName)
		allSrc = append(allSrc, data...)
	}
	msg, err := aixm5.DecodeAll(srcs...)
	if err != nil {
		return nil, nil, "", fmt.Errorf("decode: %w", err)
	}
	// Single-source: the filename verbatim. Multi-source: the first
	// three joined plus a "+N more" tail so the meta sidecar stays
	// readable; the full list is recoverable from the DFS metadata.
	var name string
	switch n := len(sources); {
	case n == 1:
		name = sources[0]
	case n <= 3:
		name = strings.Join(sources, "+")
	default:
		name = strings.Join(sources[:3], "+") + fmt.Sprintf(" (+%d more)", n-3)
	}
	return msg, allSrc, name, nil
}
