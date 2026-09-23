// inputs.go decodes and merges the ENAIRE input files. ENAIRE publishes
// airspaces, en-route and per-aerodrome obstacles as separate files;
// merging them lets each builder emit one es-*.json per dataset covering
// every aerodrome.

package main

import (
	"fmt"
	"strings"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/aixm5"
)

// decodeInputs decodes every input file and concatenates the per-type
// feature slices into one Message. It returns the merged message, the
// concatenated source bytes (for the meta sidecar's SHA-256), and a
// composite source label: the single filename, "a+b+c", or
// "a+b+c (+N more)" past three inputs. The effective date is the first
// file's (first non-empty wins). The merge is a plain concatenation:
// ENAIRE never repeats a feature across its files, so there is no
// cross-file de-duplication.
func decodeInputs(inputs []string) (*aixm5.Message, []byte, string, error) {
	combined := &aixm5.Message{}
	sources := make([]string, 0, len(inputs))
	var allSrc []byte
	for _, path := range inputs {
		data, srcName, err := aip.ReadLargestXML(path)
		if err != nil {
			return nil, nil, "", err
		}
		m, err := aixm5.Decode(data)
		if err != nil {
			return nil, nil, "", fmt.Errorf("decode %s: %w", srcName, err)
		}
		combined.Airspaces = append(combined.Airspaces, m.Airspaces...)
		combined.Obstacles = append(combined.Obstacles, m.Obstacles...)
		combined.Airports = append(combined.Airports, m.Airports...)
		combined.Navaids = append(combined.Navaids, m.Navaids...)
		combined.SkippedNonBaseline += m.SkippedNonBaseline
		combined.UnresolvedXlinks += m.UnresolvedXlinks
		combined.MultiPartObstacles += m.MultiPartObstacles
		if combined.Effective == "" {
			combined.Effective = m.Effective
		}
		sources = append(sources, srcName)
		allSrc = append(allSrc, data...)
	}
	// Single-source: the filename verbatim. Multi-source: the first
	// three joined plus a "+N more" tail so the meta sidecar stays
	// readable; the full list is recoverable from the AIRAC index page.
	var name string
	switch n := len(sources); {
	case n == 1:
		name = sources[0]
	case n <= 3:
		name = strings.Join(sources, "+")
	default:
		name = strings.Join(sources[:3], "+") + fmt.Sprintf(" (+%d more)", n-3)
	}
	return combined, allSrc, name, nil
}
