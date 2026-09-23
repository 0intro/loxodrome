// obstacles.go holds what stays Austro-Control-specific about the
// obstacle data set once the row builder is shared: unwrapping the
// published download, and the sanity window sized for this product.
//
// The rows themselves come from aixm5build.BuildObstacles: the Area 1
// data set is AIXM 5.1.1, so it decodes and builds like every other
// publisher's.

package main

import (
	"archive/zip"
	"fmt"
	"path/filepath"
	"strings"
)

const (
	// The Area 1 data set covers Austrian territory down to the eTOD
	// collection threshold, so every published row is aeronautically
	// significant and rides through without a height filter.
	defaultMinAtObstacles = 1000
	defaultMaxAtObstacles = 50000
)

// ObstacleXML returns the AIXM document of an obstacle download: the
// data set XML inside the published zip (which also carries the Excel
// and KML renderings plus the data product specification), or the bytes
// themselves when the download is a bare .xml.
func ObstacleXML(name string, data []byte) ([]byte, string, error) {
	if strings.EqualFold(filepath.Ext(name), ".xml") {
		return data, name, nil
	}
	member, inner, err := firstZipMember(data, func(f *zip.File) bool {
		return strings.EqualFold(filepath.Ext(f.Name), ".xml")
	})
	if err != nil {
		return nil, "", fmt.Errorf("%s: %w", name, err)
	}
	if member == nil {
		return nil, "", fmt.Errorf("%s has no .xml entry", name)
	}
	return member, inner, nil
}
