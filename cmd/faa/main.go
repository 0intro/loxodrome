// Command faa builds the US airspace overlay artefact pair,
// public/data/faa-airspaces.json and faa-airspaces.meta.json, from the
// FAA Boundary_Airspace, Special_Use_Airspace, and Class_Airspace
// FeatureServers.
//
// Run directly:
//
//	go run ./cmd/faa
//
// Offline / test:
//
//	go run ./cmd/faa \
//	    -faa-bnd-file ./cmd/faa/testdata/faa-boundary-sample.json \
//	    -faa-sua-file ./cmd/faa/testdata/faa-sua-sample.json \
//	    -faa-class-file ./cmd/faa/testdata/faa-class-sample.json
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/overlay"
)

const (
	// Resolved relative to the working directory, which is expected to be
	// the repo root (`go run ./cmd/faa`). Workflows invoke it that way;
	// local users can override with -out.
	defaultOutDir   = "public/data"
	defaultFAABnd   = "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/Boundary_Airspace/FeatureServer/0/query"
	defaultFAASua   = "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/Special_Use_Airspace/FeatureServer/0/query"
	defaultFAAClass = "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/Class_Airspace/FeatureServer/0/query"
	// Class_Airspace is slow (each ~500-row page takes ~75 s of server
	// time on a cold cache); allow generous wall-clock budget so the run
	// can complete in one shot.
	fetchTimeout = 30 * time.Minute
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	out := flag.String("out", defaultOutDir, "output directory for faa-airspaces.json and faa-airspaces.meta.json")
	bndURL := flag.String("faa-bnd", defaultFAABnd, "FAA Boundary_Airspace /query URL")
	suaURL := flag.String("faa-sua", defaultFAASua, "FAA Special_Use_Airspace /query URL")
	classURL := flag.String("faa-class", defaultFAAClass, "FAA Class_Airspace /query URL (Class B/C/D/E around US airports)")
	bndFile := flag.String("faa-bnd-file", "", "use local FAA Boundary_Airspace geojson")
	suaFile := flag.String("faa-sua-file", "", "use local FAA Special_Use_Airspace geojson")
	classFile := flag.String("faa-class-file", "", "use local FAA Class_Airspace geojson")
	only := flag.String("only", "", "comma-separated dataset filter; empty means everything (airspaces, navaids, obstacles, airports, adcharts)")
	var win aip.SanityWindows
	win.Register(flag.CommandLine)
	dtppFile := flag.String("dtpp-file", "", "use a local d-TPP metafile for -only adcharts (offline / test, current slot only)")
	dtppNextFile := flag.String("dtpp-next-file", "", "use a local d-TPP metafile for the -only adcharts next slot (offline / test)")
	minUsAirports := flag.Int("min-us-airports", defaultMinUsAirports, "sanity floor for the d-TPP airport count")
	minUsCharts := flag.Int("min-us-charts", defaultMinUsCharts, "sanity floor for the d-TPP chart count")
	flag.Parse()

	ctx, cancel := context.WithTimeout(context.Background(), fetchTimeout)
	defer cancel()

	want := aip.DatasetFilter(*only)

	if want("adcharts") {
		if err := os.MkdirAll(*out, 0o755); err != nil {
			return err
		}
		if err := runAdCharts(ctx, *out, *dtppFile, *dtppNextFile, *minUsAirports, *minUsCharts); err != nil {
			return fmt.Errorf("adcharts: %w", err)
		}
	}
	if want("navaids") || want("obstacles") || want("airports") {
		if err := os.MkdirAll(*out, 0o755); err != nil {
			return err
		}
		if err := runPointDatasets(ctx, *out, want, win); err != nil {
			return err
		}
	}

	// The default (empty -only) is the airspace overlay; a named dataset
	// alone means that dataset only.
	if *only != "" && !want("airspaces") {
		return nil
	}

	bnd, err := loadOrFetch(ctx, *bndFile, *bndURL)
	if err != nil {
		return fmt.Errorf("FAA Boundary_Airspace: %w", err)
	}
	sua, err := loadOrFetch(ctx, *suaFile, *suaURL)
	if err != nil {
		return fmt.Errorf("FAA Special_Use_Airspace: %w", err)
	}
	cls, err := loadOrFetch(ctx, *classFile, *classURL)
	if err != nil {
		return fmt.Errorf("FAA Class_Airspace: %w", err)
	}

	// Class airspace hours ride the separate Airspace_Schedule layer.
	// Enrichment only: a failure here degrades the hours column, it must
	// not cost us the airspace overlay.
	schedules, err := fetchAirspaceSchedules(ctx)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Airspace_Schedule unavailable, hours column left empty: %v\n", err)
		schedules = nil
	}

	art, meta, err := Build(bnd, sua, cls, Options{
		BndURL:    *bndURL,
		SuaURL:    *suaURL,
		ClassURL:  *classURL,
		Now:       time.Now,
		Schedules: schedules,
	})
	if err != nil {
		return err
	}
	if err := os.MkdirAll(*out, 0o755); err != nil {
		return err
	}
	if err := overlay.WriteCompactJSON(filepath.Join(*out, "faa-airspaces.json"), art); err != nil {
		return err
	}
	if err := overlay.WritePrettyJSON(filepath.Join(*out, "faa-airspaces.meta.json"), meta); err != nil {
		return err
	}
	fmt.Printf("wrote faa-airspaces.json: %d airspaces (boundary %d, SUA %d, class %d; %d with published hours)\n",
		meta.AirspaceCount, meta.Boundary.Count, meta.SpecialUse.Count, meta.Class.Count, meta.ScheduledRows)
	return nil
}

func loadOrFetch(ctx context.Context, file, url string) ([]byte, error) {
	if file != "" {
		return os.ReadFile(file)
	}
	return fetchFAAPaginated(ctx, url)
}
