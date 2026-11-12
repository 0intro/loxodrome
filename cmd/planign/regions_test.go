package main

import "testing"

func TestEnumerateCounts(t *testing.T) {
	// Counted independently (a Python transcription of the same boxes and
	// margin): the request volume the workflow's timeout and the docs are
	// sized on.
	want := map[uint8]int{
		0: 1, 1: 4, 2: 16, 3: 64, 4: 256, 5: 1024,
		6: 283, 7: 413, 8: 656, 9: 1296, 10: 3333, 11: 8175, 12: 31834, 13: 126006,
	}
	tiles := enumerate(minZoom, maxZoom, worldMaxZoom, regions, lowZoomMargin, lowZoomMarginMaxZoom)
	got := map[uint8]int{}
	seen := map[tile]bool{}
	for _, tl := range tiles {
		if seen[tl] {
			t.Fatalf("%s listed twice", tl)
		}
		seen[tl] = true
		got[tl.z]++
	}
	for z, n := range want {
		if got[z] != n {
			t.Errorf("z%d: %d tiles, want %d", z, got[z], n)
		}
	}
	if len(tiles) != 173361 {
		t.Errorf("%d tiles, want 173361", len(tiles))
	}
}

func TestLowZoomMargin(t *testing.T) {
	// A box inside one tile at zooms 10 and 11 (central Paris): a margin of
	// 3 makes it 7 x 7 up to zoom 10 and leaves zoom 11 the box alone.
	paris := []region{{"paris", 2.35, 48.85, 2.36, 48.86}}
	got := map[uint8]int{}
	for _, tl := range enumerate(10, 11, 0, paris, 3, 10) {
		got[tl.z]++
	}
	if got[10] != 49 || got[11] != 1 {
		t.Errorf("z10 %d tiles (want 49), z11 %d (want 1)", got[10], got[11])
	}
	// At the grid's edge the margin stops there rather than wrapping.
	corner := []region{{"corner", -180, 84.9, -179.9, 85}}
	for _, tl := range enumerate(6, 6, 0, corner, 3, 10) {
		if tl.x > 3 || tl.y > 3 {
			t.Fatalf("%s outside the corner's reach", tl)
		}
	}
	if n := len(enumerate(6, 6, 0, corner, 3, 10)); n != 16 {
		t.Errorf("corner z6: %d tiles, want 16", n)
	}
}

func TestTileRangeBoundaries(t *testing.T) {
	if lonToX(-180, 5) != 0 || lonToX(180, 5) != 31 || lonToX(179.999, 5) != 31 {
		t.Error("longitude edges")
	}
	if latToY(85.06, 5) != 0 || latToY(-85.06, 5) != 31 {
		t.Error("latitude edges")
	}
	// Paris at zoom 12, the tile the probes fetched (column 2074, row 1409).
	if x, y := lonToX(2.3488, 12), latToY(48.8534, 12); x != 2074 || y != 1409 {
		t.Errorf("Paris z12 = %d/%d, want 2074/1409", x, y)
	}
}

func TestRegionsHoldTheOffshoreIslets(t *testing.T) {
	// The islets IGN draws at the edges of each territory, which a box drawn
	// on the mainland's coast alone would cut off.
	for _, p := range []struct {
		name     string
		lat, lon float64
	}{
		{"Ouessant", 48.46, -5.10},
		{"Roches-Douvres", 49.10, -2.82},
		{"Lavezzi", 41.33, 9.26},
		{"Dunkerque", 51.05, 2.37},
		{"Menton", 43.77, 7.50},
		{"Îles du Salut", 5.29, -52.58},
		{"Grand Connétable", 4.82, -51.93},
		{"Petite-Terre (Guadeloupe)", 16.17, -61.12},
		{"Rocher du Diamant", 14.44, -61.04},
		{"Île Fourchue", 17.96, -62.90},
		{"Saint-Pierre", 46.78, -56.17},
		{"Petite-Terre (Mayotte)", -12.79, 45.28},
		{"Saint-Gilles (Réunion)", -21.05, 55.22},
	} {
		in := false
		for _, r := range regions {
			if p.lon >= r.West && p.lon <= r.East && p.lat >= r.South && p.lat <= r.North {
				in = true
			}
		}
		if !in {
			t.Errorf("%s (%.2f, %.2f) is outside every region", p.name, p.lat, p.lon)
		}
	}
}

func TestSelectRegions(t *testing.T) {
	if r, err := selectRegions([]string{"all"}); err != nil || len(r) != len(regions) {
		t.Fatal("all")
	}
	if r, err := selectRegions([]string{"mayotte", "reunion"}); err != nil || len(r) != 2 || r[0].Name != "mayotte" {
		t.Fatalf("named: %v %v", r, err)
	}
	if _, err := selectRegions([]string{"tahiti"}); err == nil {
		t.Fatal("an unknown region was accepted")
	}
}
