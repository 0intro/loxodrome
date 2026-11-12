package main

import (
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/0intro/loxodrome/internal/aixm5"
	"github.com/0intro/loxodrome/internal/aixm5build"
)

// TestBuildRadios drives a NATS-shaped aerodrome through both builders and
// pins the radio columns cmd/uk writes. The control zone carries every
// channel GATWICK DIRECTOR works, in the published order with guard last:
// read as one link, it carried 121.500 alone. The aerodrome row carries the
// director's channels, the tower's, and the tower's delivery and ground
// channels as DEL and GND rows under their own call signs (the AIP does not
// say which of the two is whose, so each is listed under both), never as
// TWR, and never 121.500 alone.
func TestBuildRadios(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("testdata", "radio", "gatwick.xml"))
	if err != nil {
		t.Fatalf("fixture: %v", err)
	}
	msg, err := aixm5.Decode(src)
	if err != nil {
		t.Fatal(err)
	}
	fixedNow := func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) }

	spaces, meta, err := aixm5build.BuildAirspaces(msg, "gatwick.xml", src, msg.Effective, aixm5build.AirspacesOptions{
		Country:      "UK",
		Now:          fixedNow,
		MinAirspaces: 1,
		MaxAirspaces: 10,
	})
	if err != nil {
		t.Fatal(err)
	}
	if meta.UnresolvedXlinks != 0 || meta.SkippedRadioChannels != 0 {
		t.Errorf("meta counters = %d unresolved / %d skipped, want 0/0", meta.UnresolvedXlinks, meta.SkippedRadioChannels)
	}
	if len(spaces.Rows) != 1 {
		t.Fatalf("airspace rows = %d, want 1", len(spaces.Rows))
	}
	radioCol := slices.Index(spaces.Fields, "radio")
	if radioCol < 0 {
		t.Fatalf("no radio column in %v", spaces.Fields)
	}
	director := func(f string) []string { return []string{f, "GATWICK DIRECTOR", "GATWICK DIRECTOR"} }
	wantCtr := []any{director("126.825"), director("118.950"), director("129.025"), director("121.500")}
	if got := spaces.Rows[0].([]any)[radioCol]; !reflect.DeepEqual(got, wantCtr) {
		t.Errorf("CTR radio =\n  %v\nwant\n  %v", got, wantCtr)
	}

	ports, _, err := aixm5build.BuildAirports(msg, "gatwick.xml", src, msg.Effective, aixm5build.AirportsOptions{
		Country:         "UK",
		CountryFromIcao: ukCountryFromIcao,
		Now:             fixedNow,
		MinAirports:     1,
		MaxAirports:     10,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(ports.Rows) != 1 {
		t.Fatalf("airport rows = %d, want 1", len(ports.Rows))
	}
	freqCol := slices.Index(ports.Fields, "frequencies")
	if freqCol < 0 {
		t.Fatalf("no frequencies column in %v", ports.Fields)
	}
	row := func(f, label, call string) []any { return []any{f, label, call} }
	wantEgkk := []any{
		row("126.825", "APP", "GATWICK DIRECTOR"),
		row("118.950", "APP", "GATWICK DIRECTOR"),
		row("129.025", "APP", "GATWICK DIRECTOR"),
		row("121.500", "APP", "GATWICK DIRECTOR"),
		row("124.230", "TWR", "GATWICK TOWER"),
		row("134.230", "TWR", "GATWICK TOWER"),
		row("121.955", "DEL", "GATWICK DELIVERY"),
		row("121.955", "GND", "GATWICK GROUND"),
		row("121.805", "DEL", "GATWICK DELIVERY"),
		row("121.805", "GND", "GATWICK GROUND"),
		row("121.500", "TWR", "GATWICK TOWER"),
		row("136.525", "ATIS", "GATWICK INFORMATION"),
	}
	if got := ports.Rows[0].([]any)[freqCol]; !reflect.DeepEqual(got, wantEgkk) {
		t.Errorf("EGKK frequencies =\n  %v\nwant\n  %v", got, wantEgkk)
	}
}
