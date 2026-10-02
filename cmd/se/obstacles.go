// obstacles.go maps LFV's en-route obstacle register (OBSE) onto
// aixm5.Obstacle, so the shared builder emits it like every other.

package main

import (
	"strconv"
	"strings"

	"github.com/0intro/loxodrome/internal/aixm5"
	"github.com/0intro/loxodrome/internal/eaip"
	"github.com/0intro/loxodrome/internal/gis"
)

// obstacleTypeAlias folds LFV's type words the shared codelist does not
// carry onto one it does. A church is charted by its spire.
var obstacleTypeAlias = map[string]string{
	"CHURCH": "SPIRE",
}

func parseObstacles(feats []gis.Feature, st *navaidStats) []aixm5.Obstacle {
	var out []aixm5.Obstacle
	for _, f := range feats {
		p := f.Properties
		lat, lon, ok := gis.Point(f.Geometry)
		if !ok {
			st.NoPosition++
			continue
		}
		// A compound kind ("Tower, Chimney", "Pylon, power line") is read by
		// its first word, the structure; the rest describes it.
		kind, _, _ := strings.Cut(gis.Prop(p, "TYPE_DESC"), ",")
		kind = strings.TrimSpace(kind)
		if a, ok := obstacleTypeAlias[strings.ToUpper(kind)]; ok {
			kind = a
		}
		o := aixm5.Obstacle{
			ID:   "OBSE:" + posID(p),
			Name: gis.Prop(p, "NAME"),
			Type: kind,
			Lat:  eaip.Round5(lat),
			Lon:  eaip.Round5(lon),
			// FR, FW, FLGR, FLGW and their pairs; "unknown" and a blank are
			// not known to be lit.
			Lighted: litCode(gis.Prop(p, "LIGHTING_DESC")),
		}
		o.HeightM = metres(p, "HEIGHT_VALUE", "HEIGHT_UNIT")
		o.ElevM = metres(p, "MSL_VALUE", "MSL_UNIT")
		out = append(out, o)
	}
	return out
}

// posID is the obstacle's stable position id, else its row id.
func posID(p map[string]any) string {
	if v, ok := gis.PropNum(p, "POSITIONID"); ok {
		return strconv.FormatFloat(v, 'f', 0, 64)
	}
	return gis.Prop(p, "IDNR")
}

func litCode(s string) bool {
	s = strings.ToUpper(strings.TrimSpace(s))
	return strings.HasPrefix(s, "F") && s != "FALSE"
}

// metres reads a value in its stated unit as metres.
func metres(p map[string]any, valueKey, unitKey string) *float64 {
	v, ok := gis.PropNum(p, valueKey)
	if !ok {
		return nil
	}
	switch strings.ToUpper(gis.Prop(p, unitKey)) {
	case "M", "":
	case "FT":
		v = eaip.FtToM(v)
	default:
		return nil
	}
	return &v
}
