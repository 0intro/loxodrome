package main

import (
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/0intro/loxodrome/internal/grib2"
)

// cmdList prints every field of GRIB2 files, one line each: the reader's
// own view of a feed, what a model spec's keys are written against.
func cmdList(args []string) error {
	fs := flag.NewFlagSet("list", flag.ExitOnError)
	fs.Parse(args)
	for _, name := range fs.Args() {
		f := os.Stdin
		if name != "-" {
			var err error
			if f, err = os.Open(name); err != nil {
				return err
			}
		}
		r := grib2.NewReader(f)
		n := 0
		for {
			msg, off, err := r.Next()
			if err == io.EOF {
				break
			}
			if err != nil {
				f.Close()
				return err
			}
			fields, err := grib2.Parse(msg, off)
			if err != nil {
				f.Close()
				return err
			}
			for _, x := range fields {
				g := x.Grid
				fmt.Printf("%s %d %d %s drt%d bits%d ref%g e%d d%d bitmap=%v packed=%d grid=%dx%d n%g w%g di%g dj%g scan%#x\n",
					name, n, off, x.Key(), x.DRT, x.Bits, x.Ref, x.BinScale, x.DecScale, x.HasBitmap(), x.Packed,
					g.Ni, g.Nj, g.North, g.West, g.Di, g.Dj, g.ScanMode)
				n++
			}
		}
		f.Close()
	}
	return nil
}
