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

// decodeInputs decodes every input file and merges them into one Message
// (aixm5.Message.Merge). It returns the merged message, the
// concatenated source bytes (for the meta sidecar's SHA-256), and a
// composite source label: the single filename, "a+b+c", or
// "a+b+c (+N more)" past three inputs. The effective date is the first
// file's (first non-empty wins). The merge is a plain concatenation, and
// ENAIRE does repeat a feature across its files: 216 obstacles are filed in
// its ENR set and again in their aerodrome's. The builders own that
// (aip.DropRepeatedRows keeps a record filed twice once, and
// aip.SeparateConflictingRows keeps two records under one id each under its
// own), so the merge stays a concatenation.
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
		// Every feature and every counter: a hand-kept list lost the
		// geometry's own unresolved count, and Spain's sidecar read 0
		// whatever its boundaries lost.
		combined.Merge(m)
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
