// api.go declares the artifact and meta shapes fr-vacgeo.json is written in.

package main

// Artifact is public/data/fr-vacgeo.json: one row per georeferenced panel.
//
// A panel is placed by an AFFINE, six coefficients from page points to
// degrees. Over a panel's own extent the mapping is linear to well under
// the chart's drafting accuracy, so six numbers say the whole of it; the
// sw / ne pair is the envelope those six imply, which is what a map layer
// culls on and what a ROTATED panel does not get from two corners. A
// ground-movement chart is rotated, often heavily.
type Artifact struct {
	Fields []string `json:"fields"`
	Rows   []any    `json:"rows"`
}

// artifactFields names the columns, in row order. lat / lon are the panel
// centre and are named that way so aip.BBoxOfRows finds them.
var artifactFields = []string{
	"ident",   // ICAO indicator, or the SIA codeId for a helistation
	"section", // Atlas VAC section: 2 aerodromes, 3 helistations
	"page",    // 1-based page of the plate
	"kind",    // APP / ATT / GMC
	"clip",    // [x0, y0, x1, y1], PDF points, origin bottom left
	"sw",      // [south, west] of the panel's envelope
	"ne",      // [north, east] of the panel's envelope
	"lat",     // panel centre
	"lon",
	"aff",     // [A,B,C,D,E,F]: lon = Ax+Cy+E, lat = Bx+Dy+F
	"quality", // how the panel was placed and how well
}

// quality records what placed a panel, so a reader can say so and one
// method can be told from the other: "graticule" read the printed grid,
// "runway" fitted the drawn runway to its published ends, "override" was
// typed by hand.
type quality struct {
	Method   string  `json:"method"`
	LatN     int     `json:"latN,omitempty"`
	LonN     int     `json:"lonN,omitempty"`
	RMS      float64 `json:"rms,omitempty"`
	DevPct   float64 `json:"devPct,omitempty"`
	Forced   string  `json:"forced,omitempty"`
	Runways  int     `json:"runways,omitempty"`
	ResidM   float64 `json:"residM,omitempty"`
	ScaleDev float64 `json:"scaleDev,omitempty"`
	// How far the drawn runway moved this panel, and what its ends still
	// missed by afterwards. Both absent when no runway confirmed the panel.
	AnchorM      float64 `json:"anchorM,omitempty"`
	AnchorResidM float64 `json:"anchorResidM,omitempty"`
	ARPm         float64 `json:"arpM"`
	Src          string  `json:"src,omitempty"` // "override" when hand-placed
}

type sourceMeta struct {
	Site    string `json:"site"`
	Dataset string `json:"dataset"`
	Plates  string `json:"plates"`
}

// Meta is the fr-vacgeo.meta.json sidecar. generatedAt lives here and
// nowhere else, so an unchanged cycle rebuilds byte-identically.
type Meta struct {
	GeneratedAt string     `json:"generatedAt"`
	Effective   string     `json:"effective"`
	Source      sourceMeta `json:"source"`

	Plates       int            `json:"plates"`     // plates read
	Panels       int            `json:"panels"`     // panels emitted
	Aerodromes   int            `json:"aerodromes"` // idents with any panel
	ByKind       map[string]int `json:"byKind"`
	ByMethod     map[string]int `json:"byMethod"`
	Overrides    int            `json:"overrides"`    // panels placed by hand
	NoGraticule  int            `json:"noGraticule"`  // pages with no readable graticule
	GateRejected int            `json:"gateRejected"` // fits the ARP gate threw out
	MissingPlate int            `json:"missingPlate"` // enumerated but not on disk
	ByReason     map[string]int `json:"byReason"`     // why a page yielded nothing

	BBox aip5 `json:"bbox,omitempty"`

	ParserVersion int `json:"parserVersion"`
}

// aip5 mirrors aip.BBox without importing it into the type declaration, so
// the meta struct stays a plain description of the file.
type aip5 = []float64
