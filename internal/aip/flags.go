// flags.go holds CLI helpers shared by the per-country build commands: the
// -only dataset filter and the -min-*/-max-* sanity-window flags.

package aip

import (
	"flag"
	"strings"
)

// DatasetFilter returns a predicate that matches dataset names against a
// comma-separated -only spec. An empty spec (the default) accepts every
// dataset.
func DatasetFilter(spec string) func(string) bool {
	spec = strings.TrimSpace(spec)
	if spec == "" {
		return func(string) bool { return true }
	}
	allow := map[string]bool{}
	for _, name := range strings.Split(spec, ",") {
		if n := strings.TrimSpace(name); n != "" {
			allow[strings.ToLower(n)] = true
		}
	}
	return func(name string) bool { return allow[strings.ToLower(name)] }
}

// SanityWindows holds the per-dataset count floors and ceilings that
// override each builder's default sanity check. A zero field means "use
// the builder's default".
type SanityWindows struct {
	MinAirspaces, MaxAirspaces int
	MinObstacles, MaxObstacles int
	MinAirports, MaxAirports   int
	MinNavaids, MaxNavaids     int
}

// Register binds the eight -min-*/-max-* flags to fs so every per-country
// command exposes an identical sanity-window CLI surface.
func (w *SanityWindows) Register(fs *flag.FlagSet) {
	fs.IntVar(&w.MinAirspaces, "min-airspaces", 0, "sanity window floor for airspace count (0 = default)")
	fs.IntVar(&w.MaxAirspaces, "max-airspaces", 0, "sanity window ceiling for airspace count (0 = default)")
	fs.IntVar(&w.MinObstacles, "min-obstacles", 0, "sanity window floor for obstacle count (0 = default)")
	fs.IntVar(&w.MaxObstacles, "max-obstacles", 0, "sanity window ceiling for obstacle count (0 = default)")
	fs.IntVar(&w.MinAirports, "min-airports", 0, "sanity window floor for airport count (0 = default)")
	fs.IntVar(&w.MaxAirports, "max-airports", 0, "sanity window ceiling for airport count (0 = default)")
	fs.IntVar(&w.MinNavaids, "min-navaids", 0, "sanity window floor for navaid count (0 = default)")
	fs.IntVar(&w.MaxNavaids, "max-navaids", 0, "sanity window ceiling for navaid count (0 = default)")
}
