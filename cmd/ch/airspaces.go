// airspaces.go builds ch-airspaces.json from the airspace layers FOCA
// serves on the federal geoportal (api3.geo.admin.ch, ch.bazl.luftraeume-*):
// the control zones, the terminal and control areas and the flight
// information zone, with their names, designators and limits, "indicated
// in feet / flight level". No class: the layers leave it to "the
// applicable official publication (AIP and ICAO Chart)", which skyguide
// sells, so the rows carry none. The FIR layer is left out, pruatlas
// drawing the FIRs with their chart arcs.
//
// HELD. The layers state no terms of use of their own: their geocat record
// still carries the placeholders "-- gebührenpflichtig --" and "-- URL
// Nutzungsbedingungen (s. Handbuch) --", and FOCA has been asked to publish
// them under the opendata.swiss terms its obstacle register already has
// (docs/aip-permissions.md). Until it answers, the build is local: it runs
// only when -only names it, it refuses to write into public/data, and
// TestNoHeldDataCommitted fails if its file ever lands there.
//
//	go run ./cmd/ch -only airspaces -out local/ch

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/aixm5"
	"github.com/0intro/loxodrome/internal/aixm5build"
	"github.com/0intro/loxodrome/internal/overlay"
)

// chLayers are the layers read, each with the type its rows take when a
// feature states none.
var chLayers = []struct{ id, typ string }{
	{"ch.bazl.luftraeume-kontrollzonen", "CTR"},
	{"ch.bazl.luftraeume-nahkontrollbezirke", "TMA"},
	{"ch.bazl.luftraeume-kontrollbezirke", "CTA"},
	{"ch.bazl.luftraeume-fluginformationszonen", "FIZ"},
}

// chIdentify asks the geoportal for every feature of a layer inside an
// envelope around Switzerland, a page at a time.
const chIdentify = "https://api3.geo.admin.ch/rest/services/api/MapServer/identify"

// chEnvelope is Switzerland with a margin, lon/lat.
const chEnvelope = "5.8,45.7,10.6,47.9"

const chPage = 200

const (
	defaultMinChAirspaces = 50
	defaultMaxChAirspaces = 1000
)

// chFeature is one identify result.
type chFeature struct {
	Geometry   json.RawMessage `json:"geometry"`
	Properties map[string]any  `json:"properties"`
}

// fetchChLayer reads one layer whole.
func fetchChLayer(ctx context.Context, layer string) ([]chFeature, []byte, error) {
	var out []chFeature
	var raw []byte
	for offset := 0; ; offset += chPage {
		q := url.Values{
			"geometryType":   {"esriGeometryEnvelope"},
			"geometry":       {chEnvelope},
			"mapExtent":      {chEnvelope},
			"imageDisplay":   {"1000,1000,96"},
			"tolerance":      {"0"},
			"layers":         {"all:" + layer},
			"returnGeometry": {"true"},
			"geometryFormat": {"geojson"},
			"sr":             {"4326"},
			"lang":           {"en"},
			"limit":          {strconv.Itoa(chPage)},
			"offset":         {strconv.Itoa(offset)},
		}
		body, err := overlay.HTTPGetAll(ctx, chIdentify+"?"+q.Encode())
		if err != nil {
			return nil, nil, fmt.Errorf("%s: %w", layer, err)
		}
		raw = append(raw, body...)
		var page struct {
			Results []chFeature `json:"results"`
		}
		if err := json.Unmarshal(body, &page); err != nil {
			return nil, nil, fmt.Errorf("%s: %w", layer, err)
		}
		out = append(out, page.Results...)
		if len(page.Results) < chPage {
			return out, raw, nil
		}
	}
}

// chZones maps a layer's features onto the shared airspace shape, one row
// per polygon of a multi-part zone.
func chZones(feats []chFeature, typ string) []aixm5.Airspace {
	var out []aixm5.Airspace
	for _, f := range feats {
		p := f.Properties
		name := strings.Join(strings.Fields(propString(p, "name")), " ")
		if name == "" {
			continue
		}
		t := strings.ToUpper(propString(p, "type"))
		if t == "" {
			t = typ
		}
		rings, err := overlay.GeomToRings(f.Geometry)
		if err != nil || len(rings) == 0 {
			continue
		}
		desig := strings.ToUpper(strings.TrimSpace(propString(p, "designator")))
		id := desig
		if id == "" {
			id = "CH-" + chSlug(name)
		}
		upper := chLimit(p["upli_value"], propString(p, "upli_type"))
		lower := chLimit(p["loli_value"], propString(p, "loli_type"))
		for _, ring := range rings {
			out = append(out, aixm5.Airspace{
				ID:         id,
				Designator: desig,
				Name:       name,
				Type:       t,
				UpperLimit: upper,
				LowerLimit: lower,
				Ring:       ring,
			})
		}
	}
	return out
}

// chLimit reads a limit's value and its type: FL, AMSL or AGL, in feet.
func chLimit(val any, typ string) *aixm5.VerticalLimit {
	v, ok := val.(float64)
	if !ok {
		return nil
	}
	n := strconv.FormatFloat(v, 'f', -1, 64)
	switch strings.ToUpper(strings.TrimSpace(typ)) {
	case "FL":
		return &aixm5.VerticalLimit{Value: n, Unit: "FL", Ref: "STD"}
	case "AMSL":
		return &aixm5.VerticalLimit{Value: n, Unit: "FT", Ref: "MSL"}
	case "AGL":
		if v == 0 {
			return &aixm5.VerticalLimit{Value: "GND"}
		}
		return &aixm5.VerticalLimit{Value: n, Unit: "FT", Ref: "SFC"}
	}
	return nil
}

func propString(p map[string]any, key string) string {
	switch v := p[key].(type) {
	case string:
		return strings.TrimSpace(v)
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	}
	return ""
}

func chSlug(s string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToUpper(s) {
		if r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' {
			b.WriteRune(r)
			dash = false
		} else if !dash && b.Len() > 0 {
			b.WriteByte('-')
			dash = true
		}
	}
	return strings.Trim(b.String(), "-")
}

// heldOut refuses the one directory the held build must never write to.
func heldOut(outDir string) error {
	out, err := filepath.Abs(outDir)
	if err != nil {
		return err
	}
	public, err := filepath.Abs(defaultOutDir)
	if err != nil {
		return err
	}
	if out == public {
		return fmt.Errorf("ch airspaces are HELD until FOCA states terms for the layers (docs/aip-permissions.md): give -out a local directory")
	}
	return nil
}

// buildChAirspaces reads the layers and writes ch-airspaces.json.
func buildChAirspaces(ctx context.Context, outDir, target string, win aip.SanityWindows, now func() time.Time) error {
	if err := heldOut(outDir); err != nil {
		return err
	}
	var zones []aixm5.Airspace
	var raw []byte
	for _, l := range chLayers {
		feats, body, err := fetchChLayer(ctx, l.id)
		if err != nil {
			return err
		}
		raw = append(raw, body...)
		zones = append(zones, chZones(feats, l.typ)...)
	}
	// The layers state a data status, not an AIRAC date: the day the build
	// read them is the honest effective date.
	effective := now().UTC().Format("2006-01-02") + "T00:00:00.000Z"
	artifact, meta, err := aixm5build.BuildAirspaces(&aixm5.Message{Airspaces: zones},
		"api3.geo.admin.ch ch.bazl.luftraeume-*", raw, effective,
		aixm5build.AirspacesOptions{
			Country:      "CH",
			Now:          now,
			MinAirspaces: orDefault(win.MinAirspaces, defaultMinChAirspaces),
			MaxAirspaces: orDefault(win.MaxAirspaces, defaultMaxChAirspaces),
		})
	if err != nil {
		return err
	}
	slot, err := aip.WriteDataset(outDir, "ch-airspaces", target, meta.Effective, artifact, meta)
	if err != nil {
		return err
	}
	fmt.Printf("wrote %d airspaces (HELD, local only); slot=%s\n", meta.AirspaceCount, slot)
	return nil
}

func orDefault(v, d int) int {
	if v != 0 {
		return v
	}
	return d
}
