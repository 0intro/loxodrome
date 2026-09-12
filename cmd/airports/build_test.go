package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"testing"
	"time"
)

var updateWant = flag.Bool("update", false, "update *.want.json files in testdata/")

// TestAirports runs the full transform on a France-only fixture and compares
// the serialised JSON byte-for-byte against checked-in *.want.json files.
// This is the actual contract with the browser: any format drift (key order,
// float printing, `null` vs `[]`, trailing newline) breaks the consumer
// silently in production but loudly here.
//
// Run `go test -update` to refresh the *.want.json files after an intentional
// change to fixtures or output format.
func TestAirports(t *testing.T) {
	airportsCsv, err := os.ReadFile(filepath.Join("testdata", "airports.csv"))
	if err != nil {
		t.Fatal(err)
	}
	runwaysCsv, err := os.ReadFile(filepath.Join("testdata", "runways.csv"))
	if err != nil {
		t.Fatal(err)
	}
	frequenciesCsv, err := os.ReadFile(filepath.Join("testdata", "frequencies.csv"))
	if err != nil {
		t.Fatal(err)
	}

	fixedNow := func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) }
	res, err := buildArtifact(string(airportsCsv), Options{
		MinRows:        1,
		MaxRows:        100,
		RunwaysCsv:     string(runwaysCsv),
		FrequenciesCsv: string(frequenciesCsv),
		Now:            fixedNow,
	})
	if err != nil {
		t.Fatal(err)
	}

	gotAirports, err := json.Marshal(res.Airports)
	if err != nil {
		t.Fatal(err)
	}
	gotMeta, err := json.MarshalIndent(res.Meta, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	gotMeta = append(gotMeta, '\n')

	checkWant(t, filepath.Join("testdata", "airports.want.json"), gotAirports)
	checkWant(t, filepath.Join("testdata", "airports.meta.want.json"), gotMeta)
}

func checkWant(t *testing.T, path string, got []byte) {
	t.Helper()
	if *updateWant {
		if err := os.WriteFile(path, got, 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("updated %s", path)
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v (run `go test -update` to create it)", path, err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("%s mismatch (run `go test -update` to refresh)\n--- got ---\n%s\n--- want ---\n%s",
			path, got, want)
	}
}

// TestShortRowSkipped: a data row shorter than the columns the parser reads
// (RFC 4180 allows embedded newlines that would split a record; upstream
// truncation looks the same) is skipped and counted, never indexed.
func TestShortRowSkipped(t *testing.T) {
	csv := "id,ident,type,name,latitude_deg,longitude_deg,elevation_ft,continent,iso_country,iso_region,municipality,scheduled_service,icao_code,iata_code,gps_code,local_code,home_link,wikipedia_link,keywords\n" +
		"1,LFPG,large_airport,Paris CDG,49.01278,2.55,392,EU,FR,FR-IDF,Paris,yes,LFPG,CDG,LFPG,CDG,,,\n" +
		"2,LFPO\n" // truncated fragment: must not panic
	parsed, err := parseRowsFromCsv(csv, map[string][]any{}, map[string][]any{}, 1, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(parsed.rows) != 1 {
		t.Errorf("rows = %d, want 1 (the complete record)", len(parsed.rows))
	}
	if parsed.shortRows != 1 {
		t.Errorf("shortRows = %d, want 1", parsed.shortRows)
	}
	if parsed.rawRowCount != 1 {
		t.Errorf("rawRowCount = %d, want 1 (short rows don't count)", parsed.rawRowCount)
	}
	// Runway / frequency parsers share the guard: a short row is dropped.
	rws, err := parseRunways("airport_ident,length_ft,width_ft,surface,lighted,closed,le_ident,he_ident\nLFPG\n")
	if err != nil {
		t.Fatal(err)
	}
	if len(rws) != 0 {
		t.Errorf("runways = %v, want none from a short row", rws)
	}
	fqs, err := parseFrequencies("airport_ident,type,frequency_mhz\nLFPG,TWR\n")
	if err != nil {
		t.Fatal(err)
	}
	if len(fqs) != 0 {
		t.Errorf("frequencies = %v, want none from a short row", fqs)
	}
}
