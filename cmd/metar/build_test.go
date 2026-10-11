package main

import (
	"context"
	"testing"
	"time"
)

func TestParseStationPage(t *testing.T) {
	in := []byte(`[
		{"id":"EGLL","icaoId":"EGLL","iataId":"LHR","faaId":null,"wmoId":"03772","site":"London/Heathrow Intl","lat":51.477,"lon":-0.461,"elev":26,"state":"EN","country":"GB","priority":0,"siteType":["METAR","TAF"]},
		{"id":"62050","icaoId":"","iataId":null,"faaId":null,"wmoId":"62050","site":"North Sea Platform","lat":30.0,"lon":19.0,"elev":null,"state":"","country":"LY","priority":9,"siteType":["METAR"]},
		{"id":"KXYZ","icaoId":"KXYZ","iataId":"XYZ","faaId":"XYZ","wmoId":"","site":"Taf Only","lat":40.0,"lon":-100.0,"elev":300,"state":"KS","country":"US","priority":5,"siteType":["TAF"]}
	]`)
	got, err := parseStationPage(in)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 {
		t.Fatalf("got %d stations, want 3", len(got))
	}
	if got[0].ICAOID != "EGLL" || got[0].IATAID != "LHR" || got[0].FAAID != "" {
		t.Errorf("EGLL decode: %+v", got[0])
	}
	if got[0].Elev == nil || *got[0].Elev != 26 {
		t.Errorf("EGLL elev = %v, want 26", got[0].Elev)
	}
	// null elev -> nil pointer; empty icaoId keeps the numeric id as the key.
	if got[1].Elev != nil {
		t.Errorf("platform elev = %v, want nil", got[1].Elev)
	}
	if stationKey(got[1]) != "62050" {
		t.Errorf("platform key = %q, want 62050", stationKey(got[1]))
	}

	if empty, err := parseStationPage([]byte("  ")); err != nil || empty != nil {
		t.Errorf("empty body: got (%v, %v), want (nil, nil)", empty, err)
	}
}

func TestBuildArtifact(t *testing.T) {
	stations := []Station{
		{ID: "EGLL", ICAOID: "EGLL", IATAID: "LHR", WMOID: "03772", Site: "London/Heathrow Intl", Lat: 51.477, Lon: -0.461, Elev: f(26), State: "EN", Country: "GB", SiteType: []string{"METAR", "TAF"}},
		{ID: "62050", WMOID: "62050", Site: "North Sea Platform", Lat: 30, Lon: 19, Country: "LY", Priority: 9, SiteType: []string{"METAR"}},
		{ID: "KXYZ", ICAOID: "KXYZ", IATAID: "XYZ", FAAID: "XYZ", Site: "Taf Only", Lat: 40, Lon: -100, Elev: f(300), State: "KS", Country: "US", SiteType: []string{"TAF"}},
		// duplicate EGLL (tile-edge overlap) must collapse to one row
		{ID: "EGLL", ICAOID: "EGLL", Site: "dup", Lat: 51.477, Lon: -0.461, Country: "GB", SiteType: []string{"METAR"}},
	}
	res, err := buildArtifact(stations, Options{
		MinStations: 1,
		MaxStations: 100,
		Requests:    13,
		Now:         func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) },
	})
	if err != nil {
		t.Fatal(err)
	}

	// KXYZ (TAF only, no METAR) dropped; duplicate EGLL collapsed => 2 rows.
	if res.Meta.StationCount != 2 || len(res.Catalog.Rows) != 2 {
		t.Fatalf("station count = %d / %d rows, want 2", res.Meta.StationCount, len(res.Catalog.Rows))
	}
	if res.Meta.TafCount != 1 {
		t.Errorf("tafCount = %d, want 1 (EGLL)", res.Meta.TafCount)
	}
	if res.Meta.CountryCount != 2 {
		t.Errorf("countryCount = %d, want 2 (GB, LY)", res.Meta.CountryCount)
	}
	if res.Meta.GeneratedAt != "2026-01-01T00:00:00.000Z" {
		t.Errorf("generatedAt = %q", res.Meta.GeneratedAt)
	}
	if res.Meta.Requests != 13 {
		t.Errorf("requests = %d, want 13", res.Meta.Requests)
	}

	// Sorted by key: "62050" (digit) sorts before "EGLL".
	r0 := res.Catalog.Rows[0].([]any)
	if r0[0] != "62050" || r0[7] != nil || r0[10] != 9 || r0[11] != false {
		t.Errorf("platform row = %v", r0)
	}
	r1 := res.Catalog.Rows[1].([]any)
	if r1[0] != "EGLL" || r1[1] != "LHR" || r1[2] != "" || r1[3] != "03772" || r1[7] != 26 || r1[11] != true {
		t.Errorf("EGLL row = %v", r1)
	}
}

func TestBuildArtifactSanityWindow(t *testing.T) {
	// Default window is [4000, 30000]; two stations must be refused.
	_, err := buildArtifact([]Station{
		{ICAOID: "EGLL", SiteType: []string{"METAR"}},
		{ICAOID: "KDEN", SiteType: []string{"METAR"}},
	}, Options{})
	if err == nil {
		t.Fatal("expected a sanity-window error, got nil")
	}
}

func TestCrawlStationsQuadtree(t *testing.T) {
	// Four stations packed in the SW corner; a low cap forces the seed box to
	// split. S2/S3/S4 sit on quadrant boundaries, so the inclusive-edge fake
	// hands them back from several tiles: the dedup must collapse them.
	planted := []Station{
		{ICAOID: "S1", Lat: 1, Lon: 1},
		{ICAOID: "S2", Lat: 1, Lon: 2},
		{ICAOID: "S3", Lat: 2, Lon: 1},
		{ICAOID: "S4", Lat: 2, Lon: 2},
	}
	fake := func(_ context.Context, b Bbox) ([]Station, error) {
		var out []Station
		for _, s := range planted {
			if s.Lat >= b.MinLat && s.Lat <= b.MaxLat && s.Lon >= b.MinLon && s.Lon <= b.MaxLon {
				out = append(out, s)
			}
		}
		return out, nil
	}
	got, reqs, err := crawlStations(context.Background(), fake, CrawlOptions{
		MinCellDeg:   2,
		CapThreshold: 3,
		SeedBoxes:    []Bbox{{0, 0, 16, 16}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 4 {
		t.Fatalf("got %d unique stations, want 4 (dedup across tile edges)", len(got))
	}
	keys := map[string]bool{}
	for _, s := range got {
		keys[s.ICAOID] = true
	}
	for _, want := range []string{"S1", "S2", "S3", "S4"} {
		if !keys[want] {
			t.Errorf("missing station %s", want)
		}
	}
	// More requests than stations proves the quadtree engaged (root + splits).
	if reqs <= 4 {
		t.Errorf("reqs = %d, expected the box to split (> 4)", reqs)
	}
}

func f(v float64) *float64 { return &v }
