package main

import (
	"encoding/json"
	"path/filepath"
	"testing"
)

func TestChLimit(t *testing.T) {
	for _, c := range []struct {
		val  any
		typ  string
		want string
	}{
		{100.0, "FL", "100 FL STD"},
		{4500.0, "AMSL", "4500 FT MSL"},
		{0.0, "AGL", "GND  "},
		{2000.0, "AGL", "2000 FT SFC"},
		{nil, "FL", "-"},
		{100.0, "STD?", "-"},
	} {
		v := chLimit(c.val, c.typ)
		got := "-"
		if v != nil {
			got = v.Value + " " + v.Unit + " " + v.Ref
		}
		if got != c.want {
			t.Errorf("chLimit(%v, %q) = %q, want %q", c.val, c.typ, got, c.want)
		}
	}
}

// A synthetic feature in the shape the geoportal answers: a zone of two
// polygons is two rows under one id.
func TestChZones(t *testing.T) {
	var feats []chFeature
	if err := json.Unmarshal([]byte(`[{
		"properties": {"name": "CTR  EXAMPLE", "designator": "lsxx", "type": "CTR",
			"loli_value": 0, "loli_type": "AGL", "upli_value": 4500, "upli_type": "AMSL"},
		"geometry": {"type": "MultiPolygon", "coordinates": [
			[[[7.0, 46.0], [7.1, 46.0], [7.1, 46.1], [7.0, 46.0]]],
			[[[8.0, 47.0], [8.1, 47.0], [8.1, 47.1], [8.0, 47.0]]]]}
	}, {
		"properties": {"name": "TMA NO DESIGNATOR", "upli_value": 195, "upli_type": "FL",
			"loli_value": 3500, "loli_type": "AMSL"},
		"geometry": {"type": "Polygon", "coordinates": [[[9.0, 46.5], [9.1, 46.5], [9.1, 46.6], [9.0, 46.5]]]}
	}]`), &feats); err != nil {
		t.Fatal(err)
	}
	zones := chZones(feats, "TMA")
	if len(zones) != 3 {
		t.Fatalf("zones = %d, want 3", len(zones))
	}
	if z := zones[0]; z.ID != "LSXX" || z.Name != "CTR EXAMPLE" || z.Type != "CTR" || z.ClassCode != "" ||
		z.UpperLimit.Value != "4500" || z.LowerLimit.Value != "GND" || z.Ring[0] != [2]float64{46.0, 7.0} {
		t.Errorf("first zone = %+v", z)
	}
	if zones[1].ID != "LSXX" {
		t.Errorf("second polygon's id = %q, want the zone's", zones[1].ID)
	}
	if z := zones[2]; z.ID != "CH-TMA-NO-DESIGNATOR" || z.Type != "TMA" {
		t.Errorf("third zone = %s %s, want the layer's type and a slug id", z.ID, z.Type)
	}
}

// The held build must never write where the site publishes from.
func TestHeldOutRefusesPublicData(t *testing.T) {
	if err := heldOut(defaultOutDir); err == nil {
		t.Error("public/data accepted")
	}
	if err := heldOut(t.TempDir()); err != nil {
		t.Errorf("a local directory refused: %v", err)
	}
}

// Nothing FOCA has not cleared for re-use may be committed.
func TestNoHeldDataCommitted(t *testing.T) {
	held, err := filepath.Glob(filepath.Join("..", "..", "public", "data", "ch-airspaces*.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(held) > 0 {
		t.Errorf("held Swiss airspace in public/data: %v", held)
	}
}
