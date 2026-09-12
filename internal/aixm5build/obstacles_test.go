package aixm5build

import "testing"

// TestObstacleTypeMapping pins the shared AIXM codelist mapping and the
// normalisation that feeds it. These cases moved here from cmd/de when
// the five per-command copies of the table were merged.
func TestObstacleTypeMapping(t *testing.T) {
	cases := []struct {
		raw, want string
	}{
		{"WIND_TURBINE", "windturbine"},
		{"WIND TURBINE", "windturbine"}, // space folded
		{"NUCLEAR_REACTOR", "building"},
		{"TRAMWAY", "cable"},
		{"OTHER:OFFSHORE_INSTALLATION_WITH_HELIPAD", "building"}, // OTHER: prefix stripped
		{"CHIMNEY", "chimney"},
		// Merged in from the other publishers' tables: every key the
		// five copies shared agreed on its value, so the union only
		// added mappings.
		{"OTROS", "other"},      // ENAIRE
		{"CABLE_CAR", "cable"},  // Austro Control
		{"SKI_LIFT", "cable"},   // Austro Control
		{"CATENARY", "cable"},   // DFS
		{"POWER_LINE", "cable"}, // DFS
		// Finland's register writes its types in prose, so the space fold
		// is what carries them into the codelist; "Built structure" is the
		// one spelling no AIXM publisher uses.
		{"Built structure", "building"}, // Fintraffic ANS
		{"Wind turbine", "windturbine"}, // Fintraffic ANS
		{"Pole", "pylon"},               // Fintraffic ANS
		{"SOMETHING_UNKNOWN", ""},       // unmapped -> "" (caller falls back to "other")
	}
	for _, c := range cases {
		if got := obstacleTypes[NormaliseObstacleType(c.raw)]; got != c.want {
			t.Errorf("obstacleTypes[normalise(%q)] = %q, want %q", c.raw, got, c.want)
		}
	}
}

// TestBuildObstaclesHeightFloor covers the MinHeightM option: rows below
// the floor drop, and so do rows with no published height at all, since
// the threshold cannot be checked without one. Zero keeps everything.
func TestBuildObstaclesHeightFloor(t *testing.T) {
	m := func(v float64) *float64 { return &v }
	msg := obstacleMessage(
		obs{id: "tall", typ: "MAST", height: m(45)},
		obs{id: "short", typ: "MAST", height: m(12)},
		obs{id: "unknown-height", typ: "MAST"},
	)

	art, meta, err := BuildObstacles(msg, "test", nil, "2026-08-06T00:00:00.000Z", ObstaclesOptions{
		IDPrefix:     "xx",
		Country:      "XX",
		Now:          testNow,
		MinObstacles: 1,
		MaxObstacles: 10,
		MinHeightM:   30,
	})
	if err != nil {
		t.Fatal(err)
	}
	if meta.ObstacleCount != 1 {
		t.Errorf("ObstacleCount = %d, want 1", meta.ObstacleCount)
	}
	if meta.SkippedTooShort != 2 {
		t.Errorf("SkippedTooShort = %d, want 2 (short + height-less)", meta.SkippedTooShort)
	}
	if got := art.Rows[0].([]any)[0].(string); got != "xx:tall" {
		t.Errorf("row id = %q, want the IDPrefix-namespaced id", got)
	}

	// No floor: every row survives, including the height-less one.
	_, meta, err = BuildObstacles(msg, "test", nil, "2026-08-06T00:00:00.000Z", ObstaclesOptions{
		IDPrefix: "xx", Country: "XX", Now: testNow, MinObstacles: 1, MaxObstacles: 10,
	})
	if err != nil {
		t.Fatal(err)
	}
	if meta.ObstacleCount != 3 || meta.SkippedTooShort != 0 {
		t.Errorf("no floor: count = %d, skipped = %d, want 3 and 0", meta.ObstacleCount, meta.SkippedTooShort)
	}
}

// TestBuildObstaclesUnknownTypes checks the drift signal: an unmapped
// type becomes "other" and its raw spelling is reported, while a literal
// OTHER is expected and stays quiet.
func TestBuildObstaclesUnknownTypes(t *testing.T) {
	msg := obstacleMessage(
		obs{id: "a", typ: "GANTRY"},
		obs{id: "b", typ: "OTHER"},
		obs{id: "c", typ: "MAST"},
	)
	_, meta, err := BuildObstacles(msg, "test", nil, "2026-08-06T00:00:00.000Z", ObstaclesOptions{
		IDPrefix: "xx", Country: "XX", Now: testNow, MinObstacles: 1, MaxObstacles: 10,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(meta.UnknownTypes) != 1 || meta.UnknownTypes[0] != "GANTRY" {
		t.Errorf("UnknownTypes = %v, want [GANTRY]", meta.UnknownTypes)
	}
	if meta.Counts["other"] != 2 || meta.Counts["mast"] != 1 {
		t.Errorf("counts = %v, want other:2 mast:1", meta.Counts)
	}
}

func TestBuildObstaclesSanityWindow(t *testing.T) {
	msg := obstacleMessage(obs{id: "a", typ: "MAST"})
	if _, _, err := BuildObstacles(msg, "test", nil, "", ObstaclesOptions{
		IDPrefix: "xx", Country: "XX", Now: testNow, MinObstacles: 5, MaxObstacles: 10,
	}); err == nil {
		t.Error("count below the floor should fail the sanity window")
	}
}
