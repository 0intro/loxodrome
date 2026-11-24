package eaip

import (
	"fmt"
	"strings"
	"testing"
)

// ENR 4.4 in two States' headings, a numbering row under one, LPS SR's
// decimal comma: five-letter name-codes as waypoints, anything else
// counted and left out.
func TestParsePointTables(t *testing.T) {
	doc := adDoc(t, `<table><tr><td>Name-code designator</td><td>Coordinates</td><td>ATS route or other route</td><td>Remarks</td></tr>
		<tr><td>1</td><td>2</td><td>3</td><td>4</td></tr>
		<tr><td>ABITU</td><td>482000N 0181929E</td><td>P41, Z650</td><td>FRA (A): LKKU, LKTB</td></tr>
		<tr><td>ABRAG</td><td>490344,4N 0202826,5E</td><td>SID, STAR: LZTT</td><td></td></tr>
		<tr><td>LZIB1</td><td>481000N 0171000E</td><td></td><td></td></tr></table>
		<table><tr><td>REP</td><td>COORD</td><td>REF ATS RTE</td><td>FRA Relevance</td><td>RMK</td></tr>
		<tr><td>ABKEM</td><td>642855N 0254841E</td><td></td><td>FRA (I)</td><td></td></tr></table>`)
	st := NewNavaidStats()
	var got []string
	for _, n := range ParsePointTables(doc, st) {
		got = append(got, fmt.Sprintf("%s %s %g,%g", n.Type, n.Designator, n.Lat, n.Lon))
	}
	want := []string{
		"WAYPOINT ABITU 48.33333,18.32472",
		"WAYPOINT ABRAG 49.06233,20.47403",
		"WAYPOINT ABKEM 64.48194,25.81139",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("got\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	if st.SkippedKinds["ENR 4.4 LZIB1"] != 1 {
		t.Errorf("skipped = %v, want LZIB1 counted", st.SkippedKinds)
	}
}

// AirNav lists an aerodrome's visual reporting points as "VRP <name>"
// rows, with or without a colon, and the holding points at the same
// places beside them, which are not points of their own.
func TestReadVisualPoints(t *testing.T) {
	doc := adDoc(t, `<table><tr><td>Location</td><td>Coordinates</td></tr>
		<tr><td>Drumcliff Church Hold:</td><td>541934.42N 0082935.38W</td></tr></table>
		<table><tr><td>Location</td><td>Coordinates</td></tr>
		<tr><td>VRP Drumcliff Church:</td><td>541934.42N 0082935.38W</td></tr>
		<tr><td>VRP Ballymote Town</td><td>540522.03N 0083104.90W</td></tr>
		<tr><td>VRP Ballymote Town</td><td>540522.03N 0083104.90W</td></tr></table>`)
	var got []string
	for _, n := range ReadVisualPoints(doc, "EISG") {
		got = append(got, fmt.Sprintf("%s %s %s", n.Type, n.Designator, n.ID))
	}
	want := []string{
		"VFR_REPORTING_POINT DRUMCLIFF CHURCH VRP:EISG:DRUMCLIFF-CHURCH",
		"VFR_REPORTING_POINT BALLYMOTE TOWN VRP:EISG:BALLYMOTE-TOWN",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("got\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}
