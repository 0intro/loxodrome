// obstacles.go writes ro-obstacles.json from ROMATSA's Area 1 obstacle
// data set, the ENR 5.4 list as the eTOD attribute table, published as a
// CSV beside the AIP rather than inside it:
//
//	https://www.aisro.ro/publications/obst.php
//	  -> /files/obst/Obstacle_Data_LRBB_Area_1_16_APR_2026.csv
//	  -> /files/obst/Obstacle_Data_LRBB_Area_1_16_APR_2026.csv.crc32q
//
// The file is the one in force, dated by its effective day; the page lists
// it alone. Beside it, the .crc32q file states the CSV's CRC-32Q and its
// SHA-1, both checked before anything is read, since that is what they are
// published for: a truncated or damaged download is refused, not drawn.
//
// The table is internal/obstable's, with three things of ROMATSA's own,
// which that reader handles: the position is packed ("441039N 0282448E",
// and "265546.1821E" in the aerodrome sets, a longitude's degrees in two
// digits), the unit is stated row by row ("Feet", or "METER" for the
// aerodrome sets folded into the list), and lighting reads YES or NO. What
// is left to this file is the identifier and the type. The "Obstacle
// identifier" is a code only for the aerodrome sets (LRIA_4450); for the
// rest it is the place ("Fantanele" names 141 turbines), which becomes the
// obstacle's name, its id then derived from the name and the position. The
// type is free text with a count in front where a row stands for several
// ("2 chimneys", "102 eolian power plants").

package main

import (
	"cmp"
	"context"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/aixm5"
	"github.com/0intro/loxodrome/internal/aixm5build"
	"github.com/0intro/loxodrome/internal/eaip"
	"github.com/0intro/loxodrome/internal/obstable"
)

// roObstPage is ROMATSA's obstacle page, the one the site's menu opens.
const roObstPage = "https://www.aisro.ro/publications/obst.php"

// The window: 1575 rows on 2026-09-24, nine in ten of them wind turbines.
const (
	defaultMinRoObstacles = 1000
	defaultMaxRoObstacles = 10000
)

// roObstFileRe is a data set on the page.
var roObstFileRe = regexp.MustCompile(`href="([^"]*?(Obstacle_Data_[A-Z]{4}_Area_1_(\d{2})_([A-Za-z]{3})_(\d{4})\.csv))"`)

// roObstNameRe dates a local file by the same name.
var roObstNameRe = regexp.MustCompile(`_(\d{2})_([A-Za-z]{3})_(\d{4})\.csv$`)

type roObstFile struct {
	URL, Name string
	Effective time.Time
}

var roMonths = map[string]time.Month{
	"JAN": time.January, "FEB": time.February, "MAR": time.March,
	"APR": time.April, "MAY": time.May, "JUN": time.June,
	"JUL": time.July, "AUG": time.August, "SEP": time.September,
	"OCT": time.October, "NOV": time.November, "DEC": time.December,
}

func roObstDate(dd, mon, yyyy string) (time.Time, bool) {
	m, ok := roMonths[strings.ToUpper(mon)]
	d, err1 := strconv.Atoi(dd)
	y, err2 := strconv.Atoi(yyyy)
	if !ok || err1 != nil || err2 != nil || d < 1 || d > 31 {
		return time.Time{}, false
	}
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC), true
}

// findRoObstFiles reads the page's data sets, their links resolved
// against the page.
func findRoObstFiles(page []byte) []roObstFile {
	base, _ := url.Parse(roObstPage)
	var out []roObstFile
	for _, m := range roObstFileRe.FindAllStringSubmatch(string(page), -1) {
		ref, err := url.Parse(m[1])
		if err != nil {
			continue
		}
		eff, ok := roObstDate(m[3], m[4], m[5])
		if !ok {
			continue
		}
		out = append(out, roObstFile{URL: base.ResolveReference(ref).String(), Name: m[2], Effective: eff})
	}
	return out
}

// pickRoObstFile chooses the target's file: the newest in force by today,
// or for "next" the nearest after it. Nil when none fits, which for "next"
// is the normal state: ROMATSA lists the file in force alone.
func pickRoObstFile(files []roObstFile, target string, now time.Time) *roObstFile {
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	var pick *roObstFile
	for i := range files {
		f := &files[i]
		future := f.Effective.After(today)
		switch {
		case target == "next" && future && (pick == nil || f.Effective.Before(pick.Effective)):
			pick = f
		case target != "next" && !future && (pick == nil || f.Effective.After(pick.Effective)):
			pick = f
		}
	}
	return pick
}

// hex8Re and hex40Re are the two sums the .crc32q file states.
var (
	hex8Re  = regexp.MustCompile(`\b[0-9A-Fa-f]{8}\b`)
	hex40Re = regexp.MustCompile(`\b[0-9A-Fa-f]{40}\b`)
)

// roIntegrity is what the check found, for the meta.
type roIntegrity struct {
	CRC32Q string `json:"crc32q"`
	SHA1   string `json:"sha1"`
}

// verifyRoObst checks the CSV against the CRC-32Q and the SHA-1 its
// .crc32q file states. Both must be stated and both must match.
func verifyRoObst(data, sums []byte) (roIntegrity, error) {
	text := string(sums)
	var crc string
	for _, m := range hex8Re.FindAllString(text, -1) {
		if !hex40Re.MatchString(m) {
			crc = strings.ToUpper(m)
			break
		}
	}
	sha := strings.ToLower(hex40Re.FindString(text))
	if crc == "" || sha == "" {
		return roIntegrity{}, fmt.Errorf("the .crc32q file states no CRC-32Q and SHA-1: %q", strings.TrimSpace(text))
	}
	got := roIntegrity{CRC32Q: fmt.Sprintf("%08X", aip.CRC32Q(data))}
	s := sha1.Sum(data)
	got.SHA1 = hex.EncodeToString(s[:])
	if got.CRC32Q != crc || got.SHA1 != sha {
		return got, fmt.Errorf("integrity check failed: CRC-32Q %s, SHA-1 %s; the publisher states %s, %s", got.CRC32Q, got.SHA1, crc, sha)
	}
	return got, nil
}

// latin2 is ISO 8859-2 from 0xA0 up, the encoding ROMATSA's CSV is saved
// in ("Bârlad"); below 0xA0 it is ASCII, and 0x80-0x9F are controls no
// name carries.
var latin2 = []rune("\u00a0\u0104\u02d8\u0141\u00a4\u013d\u015a\u00a7\u00a8\u0160\u015e\u0164\u0179\u00ad\u017d\u017b\u00b0\u0105\u02db\u0142\u00b4\u013e\u015b\u02c7\u00b8\u0161\u015f\u0165\u017a\u02dd\u017e\u017c\u0154\u00c1\u00c2\u0102\u00c4\u0139\u0106\u00c7\u010c\u00c9\u0118\u00cb\u011a\u00cd\u00ce\u010e\u0110\u0143\u0147\u00d3\u00d4\u0150\u00d6\u00d7\u0158\u016e\u00da\u0170\u00dc\u00dd\u0162\u00df\u0155\u00e1\u00e2\u0103\u00e4\u013a\u0107\u00e7\u010d\u00e9\u0119\u00eb\u011b\u00ed\u00ee\u010f\u0111\u0144\u0148\u00f3\u00f4\u0151\u00f6\u00f7\u0159\u016f\u00fa\u0171\u00fc\u00fd\u0163\u02d9")

// decodeRo returns the CSV as UTF-8: as it stands when it already is,
// else read as ISO 8859-2.
func decodeRo(b []byte) []byte {
	if utf8.Valid(b) {
		return b
	}
	var sb strings.Builder
	sb.Grow(len(b) + len(b)/16)
	for _, c := range b {
		switch {
		case c < 0x80:
			sb.WriteByte(c)
		case c >= 0xA0:
			sb.WriteRune(latin2[c-0xA0])
		default:
			sb.WriteRune(utf8.RuneError)
		}
	}
	return []byte(sb.String())
}

// roKind is one type spelling: the builder's codelist key, and whether
// the spelling stands for several obstacles.
type roKind struct {
	code    string
	several bool
}

// roKinds maps the types the data set writes, in upper case with spaces
// collapsed and any leading count removed. A type this misses reaches the
// builder as written and lands in the meta's unknownTypes. An "eolian power
// plant" is one wind turbine (a "centrală eoliană"), an antenna mast the
// structure carrying antennas, an anemometric tower a met mast; a building
// with an antenna on it is charted at the antenna's top.
var roKinds = map[string]roKind{
	"EOLIAN POWER PLANT":  {"WIND_TURBINE", false},
	"EOLIAN POWER PLANTS": {"WIND_TURBINE", true},
	"EOLIAN POWERPLANT":   {"WIND_TURBINE", false},
	"EOLIAN POWERPLANTS":  {"WIND_TURBINE", true},
	"WINDMILL":            {"WIND_TURBINE", false},
	"ANTENNA MAST":        {"MAST", false},
	"ANTENNA MASTS":       {"MAST", true},
	"ANTENNA":             {"ANTENNA", false},
	"BUILDING + ANTENNA":  {"ANTENNA", false},
	"ANEMOMETRIC TOWER":   {"MAST", false},
	"ANEMOMETRIC TOWERS":  {"MAST", true},
	"CHIMNEY":             {"CHIMNEY", false},
	"CHIMNEYS":            {"CHIMNEY", true},
	"STACK":               {"STACK", false},
	"BUILDING":            {"BUILDING", false},
	"BUILDINGS":           {"BUILDING", true},
	"TOWER":               {"TOWER", false},
}

// roCountRe is a leading count, "102 eolian power plants".
var roCountRe = regexp.MustCompile(`^(\d+)\s+`)

// kindOf maps a published type; an unknown one is returned as written.
func kindOf(s string) (string, bool) {
	t := strings.ToUpper(strings.Join(strings.Fields(strings.ReplaceAll(s, "+", " + ")), " "))
	n := 0
	if m := roCountRe.FindStringSubmatch(t); m != nil {
		n, _ = strconv.Atoi(m[1])
		t = t[len(m[0]):]
	}
	k, ok := roKinds[t]
	if !ok {
		return strings.TrimSpace(s), n > 1
	}
	return k.code, k.several || n > 1
}

// roCodeRe is an identifier that is a code rather than a place: the
// aerodrome sets' LRIA_4450, 562_LRBV. A digit alone does not make one: "23
// August" is a commune in Constanța county.
var roCodeRe = regexp.MustCompile(`^[A-Z0-9]+(?:_[A-Z0-9]+)+$`)

// roFold spells a place without its diacritics, for its id.
var roFold = strings.NewReplacer("\u0102", "A", "\u0103", "a", "\u00c2", "A", "\u00e2", "a", "\u00ce", "I", "\u00ee", "i", "\u0218", "S", "\u0219", "s", "\u015e", "S", "\u015f", "s", "\u021a", "T", "\u021b", "t", "\u0162", "T", "\u0163", "t")

// packedPos prints a position as packed sexagesimal to the second, which
// is how the data set states it: "441039N0282448E".
func packedPos(lat, lon float64) string {
	part := func(v float64, deg int, pos, neg byte) string {
		h := pos
		if v < 0 {
			h, v = neg, -v
		}
		s := int(math.Round(v * 3600))
		return fmt.Sprintf("%0*d%02d%02d%c", deg, s/3600, s/60%60, s%60, h)
	}
	return part(lat, 2, 'N', 'S') + part(lon, 3, 'E', 'W')
}

// roShape finishes the rows the shared reader returns: the type mapped,
// the place moved into the name with an id of its own, and the rows that
// stand for several obstacles, or share a wind farm's place, grouped.
func roShape(obs []aixm5.Obstacle) {
	turbines := map[string]int{}
	for i := range obs {
		o := &obs[i]
		code, several := kindOf(o.Type)
		o.Type, o.Group = code, several
		if !roCodeRe.MatchString(o.ID) {
			o.Name = o.ID
			if code == "WIND_TURBINE" {
				turbines[o.Name]++
			}
		}
	}
	byID := map[string][]int{}
	for i := range obs {
		o := &obs[i]
		if o.Name != "" {
			if o.Type == "WIND_TURBINE" && turbines[o.Name] > 1 {
				o.Group = true
			}
			o.ID = eaip.Slug(roFold.Replace(o.Name)) + "-" + packedPos(o.Lat, o.Lon)
		}
		byID[o.ID] = append(byID[o.ID], i)
	}
	// Two turbines of one place within a second of each other, or a code
	// filed twice, still get an id each, ordered by their content: in the
	// file's order, the same turbine changed ids whenever ROMATSA listed
	// the pair the other way round.
	for _, members := range byID {
		if len(members) < 2 {
			continue
		}
		slices.SortStableFunc(members, func(i, j int) int { return compareObstacles(&obs[i], &obs[j]) })
		for k, i := range members[1:] {
			obs[i].ID += "-" + strconv.Itoa(k+2)
		}
	}
}

// compareObstacles orders two obstacles by content: the position, then the
// heights, the type, the name and its note, the lighting and the group
// flag, so two records differing in any field the row carries keep one
// order whichever ROMATSA lists first.
func compareObstacles(a, b *aixm5.Obstacle) int {
	if c := cmp.Compare(a.Lat, b.Lat); c != 0 {
		return c
	}
	if c := cmp.Compare(a.Lon, b.Lon); c != 0 {
		return c
	}
	if c := cmpFloatPtr(a.ElevM, b.ElevM); c != 0 {
		return c
	}
	if c := cmpFloatPtr(a.HeightM, b.HeightM); c != 0 {
		return c
	}
	if c := cmp.Compare(a.Type, b.Type); c != 0 {
		return c
	}
	if c := cmp.Compare(a.Name, b.Name); c != 0 {
		return c
	}
	if c := cmp.Compare(a.NameNote, b.NameNote); c != 0 {
		return c
	}
	if c := cmpBool(a.Lighted, b.Lighted); c != 0 {
		return c
	}
	return cmpBool(a.Group, b.Group)
}

// cmpBool orders false before true.
func cmpBool(a, b bool) int {
	switch {
	case a == b:
		return 0
	case !a:
		return -1
	}
	return 1
}

// cmpFloatPtr orders two optional figures, an absent one first.
func cmpFloatPtr(a, b *float64) int {
	switch {
	case a == nil && b == nil:
		return 0
	case a == nil:
		return -1
	case b == nil:
		return 1
	}
	return cmp.Compare(*a, *b)
}

// roObstaclesMeta is the sidecar: the shared builder's, with the checks
// the file passed and what the reading skipped.
type roObstaclesMeta struct {
	aixm5build.ObstaclesMeta
	Integrity         roIntegrity `json:"integrity"`
	SkippedNoPosition int         `json:"skippedNoPosition"`
	SkippedNoUnit     int         `json:"skippedNoUnit"`
}

// buildRoObstacles fetches (or, with in, reads) the data set in force or
// the next one, checks it, and writes ro-obstacles.json.
func buildRoObstacles(outDir, target, in, keep string, win aip.SanityWindows, now func() time.Time) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	var (
		data, sums []byte
		name       string
		eff        time.Time
	)
	if in != "" {
		var err error
		if data, err = os.ReadFile(in); err != nil {
			return err
		}
		if sums, err = os.ReadFile(in + ".crc32q"); err != nil {
			return fmt.Errorf("the check file beside the data set: %w", err)
		}
		name = filepath.Base(in)
		m := roObstNameRe.FindStringSubmatch(name)
		if m == nil {
			return fmt.Errorf("%s: no _DD_MMM_YYYY.csv effective date in the name", name)
		}
		var ok bool
		if eff, ok = roObstDate(m[1], m[2], m[3]); !ok {
			return fmt.Errorf("%s: no effective date in the name", name)
		}
	} else {
		c := &http.Client{Timeout: 90 * time.Second}
		page, err := roGet(ctx, c, roObstPage)
		if err != nil {
			return err
		}
		files := findRoObstFiles(page)
		if len(files) == 0 {
			return fmt.Errorf("no Area 1 data set on %s (page layout may have changed)", roObstPage)
		}
		f := pickRoObstFile(files, target, now())
		if f == nil {
			if target == "next" {
				fmt.Println("ro: no pre-release obstacle data set published; nothing written")
				return nil
			}
			return fmt.Errorf("no Area 1 data set in force on %s", roObstPage)
		}
		if data, err = roGet(ctx, c, f.URL); err != nil {
			return err
		}
		if sums, err = roGet(ctx, c, f.URL+".crc32q"); err != nil {
			return err
		}
		name, eff = f.Name, f.Effective
		if keep != "" {
			if err := os.MkdirAll(keep, 0o755); err != nil {
				return err
			}
			for _, k := range []struct {
				file string
				b    []byte
			}{{name, data}, {name + ".crc32q", sums}} {
				if err := os.WriteFile(filepath.Join(keep, k.file), k.b, 0o644); err != nil {
					return err
				}
			}
		}
	}
	integrity, err := verifyRoObst(data, sums)
	if err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	rows, err := obstable.CSV(decodeRo(data), ',')
	if err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	obs, st, err := obstable.Read(rows, obstable.Spec{})
	if err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	roShape(obs)

	effective := eff.Format("2006-01-02") + "T00:00:00.000Z"
	artifact, meta, err := aixm5build.BuildObstacles(&aixm5.Message{Obstacles: obs}, name, data, effective,
		aixm5build.ObstaclesOptions{
			IDPrefix:     "ro",
			Country:      "RO",
			Now:          now,
			MinObstacles: orDefault(win.MinObstacles, defaultMinRoObstacles),
			MaxObstacles: orDefault(win.MaxObstacles, defaultMaxRoObstacles),
		})
	if err != nil {
		return err
	}
	slot, err := aip.WriteDataset(outDir, "ro-obstacles", target, meta.Effective, artifact, roObstaclesMeta{
		ObstaclesMeta:     meta,
		Integrity:         integrity,
		SkippedNoPosition: st.SkippedNoPosition,
		SkippedNoUnit:     st.SkippedNoUnit,
	})
	if err != nil {
		return err
	}
	fmt.Printf("ro: wrote %d obstacles (%d lit) from %s, CRC-32Q %s checked; effective %s; slot=%s\n",
		meta.ObstacleCount, meta.LitCount, name, integrity.CRC32Q, meta.Effective, slot)
	if st.SkippedNoPosition+st.SkippedNoUnit > 0 {
		fmt.Printf("ro: skipped %d rows with no readable position, %d with no readable unit\n", st.SkippedNoPosition, st.SkippedNoUnit)
	}
	if len(meta.UnknownTypes) > 0 {
		fmt.Printf("ro: unmapped obstacle types: %v\n", meta.UnknownTypes)
	}
	return nil
}

func orDefault(v, d int) int {
	if v != 0 {
		return v
	}
	return d
}
