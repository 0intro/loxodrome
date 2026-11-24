package overlay

import (
	"testing"

	"github.com/0intro/loxodrome/internal/geodesy"
)

// lynchburg is Lynchburg's Class D, a 4.5 NM circle about the airport.
var lynchburg = struct{ lat, lon, radiusM float64 }{37.3267, -79.2004, 4.5 * 1852}

// circle tessellates the circle every step degrees, closed, the way the
// FAA layers file one (Lynchburg's carries 7275 vertices).
func circle(step float64) [][2]float64 {
	var ring [][2]float64
	for az := 0.0; az < 360; az += step {
		lat, lon := geodesy.DestPoint(lynchburg.lat, lynchburg.lon, az, lynchburg.radiusM)
		ring = append(ring, [2]float64{lat, lon})
	}
	return append(ring, ring[0])
}

// maxSagitta returns how far inside the circle the ring's chords reach,
// in metres: the circle's radius less the distance from the centre to
// the middle of the chord.
func maxSagitta(ring []any) float64 {
	worst := 0.0
	for i := 1; i < len(ring); i++ {
		a, b := ring[i-1].([2]float64), ring[i].([2]float64)
		d := geodesy.DistanceM(lynchburg.lat, lynchburg.lon, (a[0]+b[0])/2, (a[1]+b[1])/2)
		worst = max(worst, lynchburg.radiusM-d)
	}
	return worst
}

func artifactRing(t *testing.T, art Artifact) []any {
	t.Helper()
	if len(art.Rows) != 1 {
		t.Fatalf("RowsToArtifact wrote %d rows, want 1", len(art.Rows))
	}
	ring := art.Rows[0].([]any)[12].([][2]float64)
	out := make([]any, len(ring))
	for i, p := range ring {
		out[i] = p
	}
	return out
}

// TestRowsToArtifactTolerance pins the tolerance of the rings the
// position alerts test: a chord lies inside the arc it replaces, so a
// position inside the Class D by less than its sagitta tests as outside.
// The FIR rings keep their coarser tolerance.
func TestRowsToArtifactTolerance(t *testing.T) {
	rows := []Row{{ID: "LYH", Type: "CLASS", Name: "LYNCHBURG CLASS D", Ring: circle(0.05)}}

	art, _ := RowsToArtifact(rows, AlertTolerance)
	ring := artifactRing(t, art)
	if s := maxSagitta(ring); s > 25 {
		t.Errorf("RowsToArtifact(LYNCHBURG CLASS D, AlertTolerance) chords reach %.0f m inside the circle in %d vertices, want at most 25 m", s, len(ring))
	}

	art, _ = RowsToArtifact(rows, SimplifyTolerance)
	if n := len(artifactRing(t, art)); n > 20 {
		t.Errorf("RowsToArtifact(LYNCHBURG CLASS D, SimplifyTolerance) kept %d vertices, want at most 20", n)
	}

	art, _ = RowsToArtifact(rows, 0)
	if n, want := len(artifactRing(t, art)), len(rows[0].Ring); n != want {
		t.Errorf("RowsToArtifact(LYNCHBURG CLASS D, 0) kept %d vertices, want all %d", n, want)
	}
}
