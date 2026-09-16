package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/0intro/loxodrome/internal/aixm5"
	"github.com/0intro/loxodrome/internal/aixm5build"
)

func TestBuildObstacles(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "LO_OBS_DS_AREA1_trimmed.xml"))
	if err != nil {
		t.Fatal(err)
	}
	// The data set is AIXM 5.1.1 and opens with the Area 1 coverage
	// polygon, which the shared decoder passes over.
	msg, err := aixm5.Decode(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(msg.Obstacles) != 3 {
		t.Fatalf("obstacles = %d, want 3", len(msg.Obstacles))
	}

	artifact, meta, err := aixm5build.BuildObstacles(msg, "fixture", raw, "2026-07-10T00:00:00.000Z",
		aixm5build.ObstaclesOptions{IDPrefix: "at", Country: "AT", Now: fixedNow, MinObstacles: 1, MaxObstacles: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(meta.UnknownTypes) != 0 {
		t.Errorf("unknownTypes = %v, want none", meta.UnknownTypes)
	}
	if meta.LitCount != 2 {
		t.Errorf("litCount = %d, want 2", meta.LitCount)
	}

	// The place name rides on the name-property annotation; aixm:name
	// carries the catalogue reference.
	names := map[string]bool{}
	for _, r := range artifact.Rows {
		names[r.([]any)[2].(string)] = true
	}
	for n := range names {
		if strings.HasPrefix(n, "LO_ODS_") {
			t.Errorf("row name %q is the catalogue reference, want the annotated place name", n)
		}
	}

	types := map[string]int{}
	for _, r := range artifact.Rows {
		row := r.([]any)
		id := row[0].(string)
		if len(id) < 3 || id[:3] != "at:" {
			t.Errorf("row id %q is missing the at: namespace", id)
		}
		types[row[1].(string)]++
	}
	// The Alpine set publishes aerial ropeways and wind farms under
	// codes the other national sets do not use.
	if types["cable"] != 1 {
		t.Errorf("cable rows = %d, want 1 (CABLE_CAR)", types["cable"])
	}
	if types["windturbine"] != 1 {
		t.Errorf("windturbine rows = %d, want 1 (WINDMILL_FARMS)", types["windturbine"])
	}
	if types["antenna"] != 1 {
		t.Errorf("antenna rows = %d, want 1", types["antenna"])
	}
}

// TestAustroControlObstacleCodes pins the Alpine codes through the
// shared codelist: aerial ropeways and wind farms are Austro Control's
// own spellings, and the normalisation strips the OTHER: extension
// prefix they sometimes carry.
func TestAustroControlObstacleCodes(t *testing.T) {
	cases := map[string]string{
		"CABLE_CAR":        "CABLE_CAR",
		"wind turbine":     "WIND_TURBINE",
		"OTHER:SKI_LIFT":   "SKI_LIFT",
		" WINDMILL_FARMS ": "WINDMILL_FARMS",
	}
	for in, want := range cases {
		if got := aixm5build.NormaliseObstacleType(in); got != want {
			t.Errorf("NormaliseObstacleType(%q) = %q, want %q", in, got, want)
		}
	}
}
