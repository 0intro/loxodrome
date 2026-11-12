package main

import (
	"encoding/binary"
	"flag"
	"fmt"
	"math"
	"os"
	"strings"

	"github.com/0intro/loxodrome/internal/nwp"
	"github.com/0intro/loxodrome/internal/pmtiles"
)

// cmdInspect summarises a block archive (its levels and what each segment
// weighs) and, given -lat/-lon, prints a point's series.
func cmdInspect(args []string) error {
	fs := flag.NewFlagSet("inspect", flag.ExitOnError)
	lat := fs.Float64("lat", math.NaN(), "a point's latitude")
	lon := fs.Float64("lon", math.NaN(), "a point's longitude")
	vars := fs.String("vars", "elevation,pressure_msl,wind_u_10m,wind_v_10m,temperature@850,geopotential_height@850,wind_u@850,wind_v@850,cloud_cover@850", "variables to print at the point")
	fs.Parse(args)
	for _, path := range fs.Args() {
		a, err := nwp.OpenArchive(path)
		if err != nil {
			return err
		}
		d := a.D
		fmt.Printf("%s: %s run %s +%d..%dh, grid %dx%d, %d covered points\n", path, d.Model, d.Run.Format("2006-01-02T15Z"), d.First, d.Last, d.Grid.Ni, d.Grid.Nj, d.Covered)
		for _, l := range d.Levels {
			fmt.Printf("  level z%d x%d anchor %d,%d: %dx%d points, %dx%d tiles\n", l.Z, l.Factor, l.I0, l.J0, l.Ni, l.Nj, l.Tx, l.Ty)
		}
		for _, s := range d.Segments {
			fmt.Printf("  segment %s: %d vars, steps %v\n", s.Name, len(s.Vars), s.Steps)
		}
		// Weigh the segments over every stored tile.
		size, segBytes, perZ, tiles, err := weigh(path)
		if err != nil {
			a.Close()
			return err
		}
		fmt.Printf("  %d tiles, %.1f MB", tiles, float64(size)/1e6)
		// The payload's segments in the order the archive's own descriptor
		// lists them, which an older writer's archive does not share with
		// today's.
		for s, seg := range d.Segments {
			if s < len(segBytes) {
				fmt.Printf(", %s %.1f MB", seg.Name, float64(segBytes[s])/1e6)
			}
		}
		fmt.Println()
		for z, n := range perZ {
			fmt.Printf("  z%d: %.1f MB\n", z, float64(n)/1e6)
		}
		// Bytes per covered value, by segment, every level of the pyramid
		// counted against the native points.
		for s, seg := range d.Segments {
			ns := len(seg.Steps)
			if seg.Name == "static" {
				ns = 1
			}
			vals := float64(d.Covered) * float64(len(seg.Vars)*ns)
			if s >= len(segBytes) || vals == 0 {
				continue
			}
			fmt.Printf("  %s: %.3f B per covered value (all levels)\n", seg.Name, float64(segBytes[s])/vals)
		}
		if !math.IsNaN(*lat) {
			i, j, ok := d.Grid.Nearest(*lat, *lon)
			if !ok {
				fmt.Println("  point outside the grid")
			} else {
				fmt.Printf("  point %g,%g -> native %d,%d\n", *lat, *lon, i, j)
				for _, key := range strings.Split(*vars, ",") {
					v, steps, ok, err := a.Series(i, j, key)
					if err != nil {
						a.Close()
						return err
					}
					if !ok {
						fmt.Printf("    %s: no tile\n", key)
						continue
					}
					fmt.Printf("    %s @%v: %v\n", key, steps, v)
				}
			}
		}
		a.Close()
	}
	return nil
}

// weigh sums an archive's tile bytes by payload segment and by zoom, each
// stored tile counted as many times as its run repeats it.
func weigh(path string) (size int64, segBytes [nwp.NumSegments]int64, perZ map[uint8]int64, tiles int64, err error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, segBytes, nil, 0, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return 0, segBytes, nil, 0, err
	}
	rd, err := pmtiles.Open(f, st.Size())
	if err != nil {
		return 0, segBytes, nil, 0, err
	}
	perZ = map[uint8]int64{}
	err = rd.Walk(func(e pmtiles.Entry) error {
		b, err := rd.TileData(e)
		if err != nil {
			return err
		}
		z, _, _ := pmtiles.IDToZxy(e.TileID)
		perZ[z] += int64(len(b)) * int64(e.RunLength)
		if len(b) == 0 || len(b) < 1+4*int(b[0]) {
			return fmt.Errorf("tile %d: a payload of %d bytes", e.TileID, len(b))
		}
		for s := 0; s < int(b[0]) && s < int(nwp.NumSegments); s++ {
			segBytes[s] += int64(binary.LittleEndian.Uint32(b[1+4*s:])) * int64(e.RunLength)
		}
		tiles += int64(e.RunLength)
		return nil
	})
	return st.Size(), segBytes, perZ, tiles, err
}
