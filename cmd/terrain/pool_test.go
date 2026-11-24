package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/0intro/loxodrome/internal/terrain"
)

// flat builds a tile whose three bands all read v.
func flat(z, x, y int, v int16) *terrain.Tile {
	t := &terrain.Tile{
		Z: z, X: x, Y: y,
		Mean: make([]int16, terrain.Pixels),
		Max:  make([]int16, terrain.Pixels),
		Min:  make([]int16, terrain.Pixels),
	}
	for i := range t.Mean {
		t.Mean[i], t.Max[i], t.Min[i] = v, v, v
	}
	return t
}

// The property the whole build order rests on. The mosaic's tiers have
// DIFFERENT native levels: z12 where a 30 m or finer source reaches, z10 from
// the global floor everywhere else. One pool pass therefore meets levels that
// are somebody's native data and levels that are nobody's, and it must
// improve the first kind without touching the second.
func TestPoolPyramidLeavesANativeLevelNobodyCoversAlone(t *testing.T) {
	out := t.TempDir()
	world := [4]float64{-180, -85, 180, 85}

	// A native z10 tile with no finer tier over it: the global floor.
	if err := writeTile(out, flat(10, 100, 100, 800)); err != nil {
		t.Fatal(err)
	}
	// A different z10 footprint that a finer tier DID reach, so its four z11
	// children exist and are higher than any 90 m read would have been.
	for _, c := range [4][2]int{{0, 0}, {1, 0}, {0, 1}, {1, 1}} {
		if err := writeTile(out, flat(11, 200*2+c[0], 200*2+c[1], 2000)); err != nil {
			t.Fatal(err)
		}
	}

	if err := poolPyramid(out, world, 9, 0, 4, func(string, ...any) {}); err != nil {
		t.Fatal(err)
	}

	kept, err := readTile(out, 10, 100, 100)
	if err != nil {
		t.Fatal(err)
	}
	if kept == nil {
		t.Fatal("pooling deleted a native tile that had no children")
	}
	if kept.Max[0] != 800 {
		t.Fatalf("the native z10 now reads %d, want the 800 it was written with", kept.Max[0])
	}

	built, err := readTile(out, 10, 200, 200)
	if err != nil {
		t.Fatal(err)
	}
	if built == nil {
		t.Fatal("the z10 over the finer tier was not pooled from its children")
	}
	if built.Max[0] != 2000 {
		t.Fatalf("pooled z10 max %d, want the children's 2000", built.Max[0])
	}

	// And the level below sees both, which is what makes one pass global.
	for _, c := range []struct {
		x, y int
		want int16
	}{{50, 50, 800}, {100, 100, 2000}} {
		z9, err := readTile(out, 9, c.x, c.y)
		if err != nil {
			t.Fatal(err)
		}
		if z9 == nil {
			t.Fatalf("z9 %d/%d is missing", c.x, c.y)
		}
		if z9.Max[0] != c.want {
			t.Fatalf("z9 %d/%d max %d, want %d", c.x, c.y, z9.Max[0], c.want)
		}
	}
}

func TestDeepestLevelReadsWhatIsOnDisk(t *testing.T) {
	out := t.TempDir()
	if _, err := deepestLevel(out); err != nil {
		t.Fatal(err)
	}
	if err := writeTile(out, flat(6, 1, 1, 10)); err != nil {
		t.Fatal(err)
	}
	if err := writeTile(out, flat(12, 1, 1, 10)); err != nil {
		t.Fatal(err)
	}
	z, err := deepestLevel(out)
	if err != nil {
		t.Fatal(err)
	}
	if z != 12 {
		t.Fatalf("deepest level %d, want 12", z)
	}
}

// Priority is enforced by BUILD ORDER and by nothing else: writeTile
// overwrites, and a tile records nothing about which tier wrote it. So where
// two tiers publish the same level, the one that ran last is the one that
// stands, and the order the flag was typed in must not decide it.
//
// The case that matters is glo30 (50) against nasadem (55), both native z12
// over the Caucasus. Asked for in the wrong order, the run would bury 30 m
// Copernicus ground under NASADEM's 2000-era SRTM everywhere the two overlap,
// and nothing downstream would look wrong: every tile would be present, and
// every tile would be plausible.
func TestRegionsAreBuiltCoarsestFirst(t *testing.T) {
	got, err := orderedRegions("glo30,nasadem,glo90")
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, r := range got {
		ids = append(ids, r.ID)
	}
	want := []string{"glo90", "nasadem", "glo30"}
	for i := range want {
		if i >= len(ids) || ids[i] != want[i] {
			t.Fatalf("build order %v, want %v", ids, want)
		}
	}

	// And a national tier is written after the Copernicus it refines.
	got, err = orderedRegions("fr,glo30")
	if err != nil {
		t.Fatal(err)
	}
	if got[len(got)-1].ID != "fr" {
		t.Fatalf("last built is %q, want the national tier", got[len(got)-1].ID)
	}
}

func TestOrderedRegionsRefusesAnUnknownTier(t *testing.T) {
	if _, err := orderedRegions("glo30,atlantis"); err == nil {
		t.Fatal("an unknown region built silently")
	}
}

// The southern tiers only exist if glo30 reaches them: buildRegion intersects
// a -bbox with the region's own bounds, so bounds that stop at the equator
// would answer a box over Reunion or New Caledonia with nothing at all, and
// report it as "nothing inside the -bbox" rather than as an error.
func TestGlo30ReachesTheSouthernTerritories(t *testing.T) {
	r, ok := regionByID("glo30")
	if !ok {
		t.Fatal("no glo30 region")
	}
	for _, c := range []struct {
		name     string
		lon, lat float64
	}{
		{"Reunion", 55.5, -21.1},
		{"Mayotte", 45.2, -12.8},
		{"New Caledonia", 166.5, -22.0},
		{"French Polynesia", -149.5, -17.5},
		{"Wallis", -176.2, -13.3},
		{"Guyane", -52.6, 4.9},
	} {
		if c.lon < r.Bounds[0] || c.lon > r.Bounds[2] || c.lat < r.Bounds[1] || c.lat > r.Bounds[3] {
			t.Errorf("%s (%.1f,%.1f) is outside glo30's bounds %v", c.name, c.lon, c.lat, r.Bounds)
		}
	}
}

// The bug that cost 88 % of a tile. A tier's edge does not fall on a tile
// boundary, so a parent at the edge of the finer coverage has some children
// and not others: Pool4 answers with ground on one side and the sentinel on
// the other, and writing that out DELETES the coarser tier's native ground
// underneath. The levels below are pooled from this one, so the hole then
// propagates down and the point reads as "no terrain data" over ground the
// mosaic holds.
func TestPoolingNeverDeletesGroundItDoesNotCover(t *testing.T) {
	out := t.TempDir()
	world := [4]float64{-180, -85, 180, 85}

	// The coarser tier's native tile: ground everywhere.
	if err := writeTile(out, flat(10, 100, 100, 700)); err != nil {
		t.Fatal(err)
	}
	// A finer tier reaching only the north-west quarter of it.
	if err := writeTile(out, flat(11, 200, 200, 3000)); err != nil {
		t.Fatal(err)
	}

	if err := poolPyramid(out, world, 10, 0, 4, func(string, ...any) {}); err != nil {
		t.Fatal(err)
	}

	got, err := readTile(out, 10, 100, 100)
	if err != nil {
		t.Fatal(err)
	}
	if got == nil {
		t.Fatal("the tile vanished")
	}
	var pooled, kept, lost int
	for i, v := range got.Mean {
		switch {
		case v == terrain.NoData:
			lost++
		case v == 700:
			kept++
		case v == 3000 && i < terrain.Size*terrain.Size:
			pooled++
		}
	}
	if lost != 0 {
		t.Fatalf("%d pixels lost the ground the coarser tier held", lost)
	}
	if pooled == 0 {
		t.Fatal("the finer tier's ground did not reach the parent")
	}
	if kept == 0 {
		t.Fatal("the coarser tier's ground was not kept where nothing covered it")
	}
	// A quarter improved, three quarters preserved.
	if pooled != terrain.Pixels/4 || kept != terrain.Pixels*3/4 {
		t.Fatalf("pooled %d, kept %d of %d", pooled, kept, terrain.Pixels)
	}
}

// A parent pixel whose 2x2 block of child pixels is partly no-data was pooled
// from the valid part alone, and KeepUncovered left it, having some ground.
// The rest of its footprint is the coarser tier's, whose max can stand above
// the part pooled: kept below it, every coarser level read a max lower than
// the floor's own.
func TestPoolingKeepsTheFloorsExtremesOverAPartialBlock(t *testing.T) {
	out := t.TempDir()
	world := [4]float64{-180, -85, 180, 85}

	// The floor's native z10: 1450 m inside pixel 0's footprint, and inside
	// pixel 1's.
	floor := flat(10, 100, 100, 1000)
	floor.Mean[0], floor.Max[0], floor.Min[0] = 1300, 1450, 1100
	floor.Mean[1], floor.Max[1], floor.Min[1] = 1300, 1450, 1100
	if err := writeTile(out, floor); err != nil {
		t.Fatal(err)
	}
	// Its north-west child, from a finer tier: pixel 0's block is half
	// no-data, pixel 1's is whole.
	kid := flat(11, 200, 200, 1000)
	kid.Mean[0], kid.Max[0], kid.Min[0] = 1300, 1400, 1200
	kid.Mean[1], kid.Max[1], kid.Min[1] = 1300, 1350, 1250
	for _, k := range []int{terrain.Size, terrain.Size + 1} {
		kid.Mean[k], kid.Max[k], kid.Min[k] = terrain.NoData, terrain.NoData, terrain.NoData
	}
	if err := writeTile(out, kid); err != nil {
		t.Fatal(err)
	}

	if err := poolPyramid(out, world, 10, 0, 4, quiet); err != nil {
		t.Fatal(err)
	}
	got, err := readTile(out, 10, 100, 100)
	if err != nil || got == nil {
		t.Fatalf("readTile(10/100/100) = %v, %v", got, err)
	}
	// The partial pixel: the children's mean, the extremes of both.
	if got.Min[0] != 1100 || got.Mean[0] != 1300 || got.Max[0] != 1450 {
		t.Errorf("partial pixel is %d/%d/%d, want 1100/1300/1450", got.Min[0], got.Mean[0], got.Max[0])
	}
	// A whole block is exact: the finer tier read all of the footprint.
	if got.Min[1] != 1000 || got.Mean[1] != 1000 || got.Max[1] != 1000 {
		t.Errorf("whole pixel is %d/%d/%d, want 1000/1000/1000", got.Min[1], got.Mean[1], got.Max[1])
	}
}

// And a parent on disk that does not decode is not an empty one: the pass
// stops on it rather than write the pooled tile over whatever it held.
func TestPoolingStopsOnATileItCannotRead(t *testing.T) {
	out := t.TempDir()
	world := [4]float64{-180, -85, 180, 85}
	if err := writeTile(out, flat(11, 200, 200, 3000)); err != nil {
		t.Fatal(err)
	}
	p := tilePath(out, 10, 100, 100)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	junk := []byte("not a tile")
	if err := os.WriteFile(p, junk, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := poolPyramid(out, world, 10, 0, 4, quiet); err == nil {
		t.Fatal("pooling wrote over a tile it could not read")
	}
	if b, err := os.ReadFile(p); err != nil || !bytes.Equal(b, junk) {
		t.Fatalf("the unreadable tile was replaced: %q, %v", b, err)
	}
}

// -pool-from names the deepest level to REBUILD, so a value below the floor
// leaves the loop with nothing to do. Reporting success there would tell an
// operator repairing the pyramid that it had been rebuilt when no tile was
// touched, over the data that answers a minimum safe altitude.
func TestPoolFromOutsideTheRangeIsRefused(t *testing.T) {
	out := t.TempDir()
	world := [4]float64{-180, -85, 180, 85}
	if err := writeTile(out, flat(10, 100, 100, 700)); err != nil {
		t.Fatal(err)
	}
	// Its parent, so a rebuild starting at z8 has children to read: skipping
	// a level only works where the level above it is already on disk, which
	// is the whole contract of the flag.
	if err := writeTile(out, flat(9, 50, 50, 700)); err != nil {
		t.Fatal(err)
	}

	// Above the deepest level on disk: there is no finer level to pool from.
	if err := poolPyramid(out, world, 6, 10, 4, func(string, ...any) {}); err == nil {
		t.Fatal("-pool-from at the deepest level on disk was accepted")
	}
	// Below the floor: the loop would run zero times.
	if err := poolPyramid(out, world, 6, 5, 4, func(string, ...any) {}); err == nil {
		t.Fatal("-pool-from below the floor was accepted")
	}
	// And the range between the two still works.
	if err := poolPyramid(out, world, 6, 8, 4, func(string, ...any) {}); err != nil {
		t.Fatal(err)
	}
	if got, err := readTile(out, 8, 25, 25); err != nil || got == nil {
		t.Fatalf("z8 was not pooled: %v", err)
	}
}
