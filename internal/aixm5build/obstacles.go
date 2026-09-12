// obstacles.go builds the <cc>-obstacles.json artifact every publisher
// shares. The row schema mirrors cmd/fr's fr-obstacles.json, so the SPA
// loader treats each national file uniformly and keys the source off the
// id prefix (obstacleSourceFromId in src/lib/data/obstacles.ts).
//
// This was a per-command file in cmd/uk, cmd/es, cmd/de, cmd/at and
// cmd/be. The five copies differed in the id prefix, the sanity window, a
// height floor and their share of the AIXM type codelist. The first three
// are options; the codelist is now one table, because
// aixm:CodeVerticalStructureType is a standard and a publisher's absence
// from a row is not a reason to lose it. Every key the five copies shared
// agreed on its value, so merging them changed no existing mapping.

package aixm5build

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/aixm5"
)

const (
	defaultMinObstacles = 0
	defaultMaxObstacles = 300000
)

// obstaclesOutputFields mirrors cmd/fr/obstacles.go.
var obstaclesOutputFields = []string{
	"id", "type", "name", "lat", "lon", "elev", "hgt", "lit", "group",
}

// obstacleTypes maps the AIXM VerticalStructure type onto the SPA's own
// obstacle vocabulary (the glyph set in src/lib/map/obstacleSymbols.ts).
// Keys are the normalised form: uppercase, spaces folded to underscores,
// publisher-extension prefixes stripped. Anything unmapped becomes
// "other" and is recorded in meta.unknownTypes, which is the drift
// signal when a publisher extends the codelist.
var obstacleTypes = map[string]string{
	"ANTENNA":                            "antenna",
	"ARCH":                               "building",
	"BRIDGE":                             "bridge",
	"BUILDING":                           "building",
	"BUILT_STRUCTURE":                    "building",
	"CABLE":                              "cable",
	"CABLE_CAR":                          "cable",
	"CATENARY":                           "cable",
	"CHIMNEY":                            "chimney",
	"CONTROL_TOWER":                      "tower",
	"COOLING_TOWER":                      "tower",
	"CRANE":                              "crane",
	"DAM":                                "building",
	"DERRICK":                            "derrick",
	"DOME":                               "building",
	"ELECTRICAL_EXIT_LIGHT":              "other",
	"ELECTRICAL_SYSTEM":                  "building",
	"FENCE":                              "building",
	"FLARE_STACK":                        "flarestack",
	"GENERAL_UTILITY":                    "building",
	"GRAIN_ELEVATOR":                     "silo",
	"GRANARY":                            "silo",
	"HILL":                               "other",
	"INDUSTRIAL_SYSTEM":                  "building",
	"LIGHTHOUSE":                         "lighthouse",
	"MAST":                               "mast",
	"MOBILE_OBSTACLE":                    "other",
	"MONUMENT":                           "building",
	"NATURAL_HIGHPOINT":                  "other",
	"NAVAID":                             "antenna",
	"NUCLEAR_REACTOR":                    "building",
	"OBSERVATION_TOWER":                  "tower",
	"OFFSHORE_INSTALLATION_WITH_HELIPAD": "building",
	"OTHER":                              "other",
	"OTROS":                              "other",
	"OVERHEAD_CABLE":                     "cable",
	"POLE":                               "pylon",
	"POWER_LINE":                         "cable",
	"POWER_PLANT":                        "powerplant",
	"PYLON":                              "pylon",
	"RADIO_MAST":                         "mast",
	"RADIO_TOWER":                        "tower",
	"REFINERY":                           "building",
	"RIG":                                "derrick",
	"SIGN":                               "other",
	"SILO":                               "silo",
	"SKI_LIFT":                           "cable",
	"SPIRE":                              "tower",
	"STACK":                              "chimney",
	"STADIUM":                            "building",
	"TANK":                               "silo",
	"TETHERED_BALLOON":                   "other",
	"TOWER":                              "tower",
	"TRAMWAY":                            "cable",
	"TRANSMISSION_LINE":                  "cable",
	"TREE":                               "other",
	"VEGETATION":                         "other",
	"WALL":                               "building",
	"WATER_TOWER":                        "watertower",
	"WINDMILL":                           "windturbine",
	"WINDMILL_FARMS":                     "windturbine",
	"WINDTURBINE":                        "windturbine",
	"WIND_TURBINE":                       "windturbine",
}

// ObstaclesArtifact is the <cc>-obstacles.json document.
type ObstaclesArtifact struct {
	Fields []string `json:"fields"`
	Rows   []any    `json:"rows"`
}

// ObstaclesMeta is the <cc>-obstacles.meta.json document.
type ObstaclesMeta struct {
	GeneratedAt        string `json:"generatedAt"`
	Source             string `json:"source"`
	SourceSha256       string `json:"sourceSha256"`
	Effective          string `json:"effective"`
	ObstacleCount      int    `json:"obstacleCount"`
	LitCount           int    `json:"litCount"`
	SkippedNonBaseline int    `json:"skippedNonBaseline"`
	MultiPartObstacles int    `json:"multiPartObstacles"`
	// SkippedTooShort counts rows dropped by MinHeightM. Surfaced so a
	// publisher that starts filtering upstream shows up as a sudden
	// change rather than a silent one.
	SkippedTooShort int            `json:"skippedTooShort"`
	UnknownTypes    []string       `json:"unknownTypes"`
	Counts          map[string]int `json:"counts"`
	// BBox is the emitted rows' lat/lon envelope (bbox.go).
	BBox aip.BBox `json:"bbox,omitempty"`
	// BBoxes splits that envelope into the pieces the rows really
	// occupy, for a publisher whose territory is not connected; absent
	// when the rows form one group.
	BBoxes []aip.BBox `json:"bboxes,omitempty"`
}

// ObstaclesOptions configures BuildObstacles.
type ObstaclesOptions struct {
	// IDPrefix namespaces the emitted ids ("de", "uk", ...). The SPA
	// reads the source publisher back off it.
	IDPrefix string
	// Country labels the sanity-window error.
	Country      string
	Now          func() time.Time
	MinObstacles int
	MaxObstacles int
	// MinHeightM drops obstacles below this AGL height, and drops rows
	// with no height at all (the threshold cannot be checked without
	// one). Zero keeps everything, which is right for a publisher whose
	// feed is already filtered to an eTOD collection threshold.
	MinHeightM float64
}

// BuildObstacles emits one row per BASELINE VerticalStructure.
func BuildObstacles(msg *aixm5.Message, source string, raw []byte, effective string, opts ObstaclesOptions) (ObstaclesArtifact, ObstaclesMeta, error) {
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	minN, maxN := opts.MinObstacles, opts.MaxObstacles
	if minN == 0 {
		minN = defaultMinObstacles
	}
	if maxN == 0 {
		maxN = defaultMaxObstacles
	}

	rows := make([]any, 0, len(msg.Obstacles))
	counts := make(map[string]int)
	unknownSet := map[string]bool{}
	litCount := 0
	skippedTooShort := 0
	for i := range msg.Obstacles {
		o := &msg.Obstacles[i]
		if opts.MinHeightM > 0 && (o.HeightM == nil || *o.HeightM < opts.MinHeightM) {
			skippedTooShort++
			continue
		}
		typeCode := obstacleTypes[NormaliseObstacleType(o.Type)]
		if typeCode == "" {
			typeCode = "other"
			if t := strings.TrimSpace(o.Type); t != "" && !strings.EqualFold(t, "OTHER") {
				unknownSet[t] = true
			}
		}
		counts[typeCode]++
		if o.Lighted {
			litCount++
		}
		rows = append(rows, []any{
			opts.IDPrefix + ":" + o.ID,
			typeCode,
			obstacleName(o),
			o.Lat,
			o.Lon,
			metresToFeet(o.ElevM),
			metresToFeet(o.HeightM),
			o.Lighted,
			o.Group,
		})
	}

	if n := len(rows); n < minN || n > maxN {
		return ObstaclesArtifact{}, ObstaclesMeta{}, fmt.Errorf(
			"%s obstacle count %d outside sanity window [%d, %d] - source format may have changed",
			opts.Country, n, minN, maxN)
	}

	unknownList := make([]string, 0, len(unknownSet))
	for k := range unknownSet {
		unknownList = append(unknownList, k)
	}
	sort.Strings(unknownList)

	sum := sha256.Sum256(raw)
	meta := ObstaclesMeta{
		GeneratedAt:        now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Source:             source,
		SourceSha256:       hex.EncodeToString(sum[:]),
		Effective:          effective,
		ObstacleCount:      len(rows),
		LitCount:           litCount,
		SkippedNonBaseline: msg.SkippedNonBaseline,
		MultiPartObstacles: msg.MultiPartObstacles,
		SkippedTooShort:    skippedTooShort,
		UnknownTypes:       unknownList,
		Counts:             counts,
	}
	meta.BBox = aip.BBoxOfRows(obstaclesOutputFields, rows)
	meta.BBoxes = aip.BBoxClustersOfRows(obstaclesOutputFields, rows)
	return ObstaclesArtifact{Fields: obstaclesOutputFields, Rows: rows}, meta, nil
}

// obstacleName prefers the DESCRIPTION annotation on the name property
// when the publisher put one there. Austro Control files a catalogue
// reference in aixm:name and the human-readable place name in the
// annotation; everyone else leaves the annotation empty, so the rule is
// inert for them.
func obstacleName(o *aixm5.Obstacle) string {
	if o.NameNote != "" {
		return o.NameNote
	}
	return o.Name
}

// NormaliseObstacleType folds AIXM and publisher quirks into a stable
// key for the codelist lookup: uppercase and trim, fold internal spaces
// to underscores so "WIND TURBINE" and "WIND_TURBINE" agree, and strip
// the "OTHER:" / "EXTENSION:" prefixes used for extension values.
func NormaliseObstacleType(s string) string {
	s = strings.ToUpper(strings.TrimSpace(s))
	s = strings.ReplaceAll(s, " ", "_")
	s = strings.TrimPrefix(s, "OTHER:")
	s = strings.TrimPrefix(s, "EXTENSION:")
	return s
}

// metresToFeet rounds metres to feet, keeping nil for a value the AIP
// did not publish; cmd/fr emits null for those and the SPA reads it.
func metresToFeet(m *float64) any {
	if m == nil {
		return nil
	}
	return int(math.Round(*m / ftPerM))
}
