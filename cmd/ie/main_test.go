package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/0intro/loxodrome/internal/aixm5"
	"github.com/0intro/loxodrome/internal/aixm5build"
)

func fixedNow() time.Time {
	return time.Date(2026, time.September, 24, 12, 0, 0, 0, time.UTC)
}

func day(y int, m time.Month, d int) time.Time {
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

func readFixture(t *testing.T, name string) *register {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	reg, err := readRegister(b, name)
	if err != nil {
		t.Fatal(err)
	}
	return reg
}

// build runs the fixture through the shared builder, as the command does,
// keyed by emitted id.
func build(t *testing.T, obstacles []aixm5.Obstacle) (map[string][]any, aixm5build.ObstaclesMeta) {
	t.Helper()
	artifact, meta, err := aixm5build.BuildObstacles(&aixm5.Message{Obstacles: obstacles},
		"fixture", nil, "2026-08-06T00:00:00.000Z",
		aixm5build.ObstaclesOptions{IDPrefix: "ie", Country: "IE", Now: fixedNow, MinObstacles: 1, MaxObstacles: 100})
	if err != nil {
		t.Fatal(err)
	}
	rows := map[string][]any{}
	for _, r := range artifact.Rows {
		row := r.([]any)
		rows[row[0].(string)] = row
	}
	return rows, meta
}

// The Area 1 fixture keeps the register's three heading rows, one row of
// every type and lighting spelling the August 2026 edition writes, and a
// wind farm whose own row repeats its highest turbine.
func TestArea1(t *testing.T) {
	reg := readFixture(t, "area1_trimmed.xlsx")
	if len(reg.obstacles) != 24 || reg.stats.SkippedNoPosition != 0 {
		t.Fatalf("obstacles = %d, skipped %d; want 24, 0", len(reg.obstacles), reg.stats.SkippedNoPosition)
	}
	if !reg.edition.Equal(day(2026, time.August, 6)) {
		t.Errorf("edition = %v, want 2026-08-06", reg.edition)
	}
	rows, meta := build(t, reg.obstacles)
	if len(meta.UnknownTypes) != 0 {
		t.Errorf("unknownTypes = %v, want none", meta.UnknownTypes)
	}
	// fields: id, type, name, lat, lon, elev, hgt, lit, group
	cases := []struct {
		id         string
		typ        string
		elev, hgt  int
		lit, group bool
		why        string
	}{
		// The Spire of Dublin, 121 m, which the IAA files as a mast.
		{"ie:EISN-0068", "mast", 413, 397, true, false, "a lone obstacle, in feet"},
		{"ie:EISN-0271", "windturbine", 1829, 460, true, true, "the farm's own row, at its highest turbine, with the farm's lighting"},
		{"ie:EISN-0271.015", "windturbine", 1829, 460, false, true, "that turbine, unlit on its own row"},
		{"ie:EISN-0271.018", "mast", 1218, 276, false, true, "a met mast numbered into the farm"},
	}
	for _, c := range cases {
		r, ok := rows[c.id]
		if !ok {
			t.Errorf("%s missing", c.id)
			continue
		}
		if r[1] != c.typ || r[5] != c.elev || r[6] != c.hgt || r[7] != c.lit || r[8] != c.group {
			t.Errorf("%s (%s): got %v", c.id, c.why, r)
		}
	}
	if r := rows["ie:EISN-0068"]; r[3] != 53.3498 || r[4] != -6.26025 {
		t.Errorf("Spire position = %v, %v; want the decimal columns rounded", r[3], r[4])
	}
}

// The Safety Significant list is headed over two rows, and some of its rows
// carry no position at all.
func TestSafetySignificant(t *testing.T) {
	reg := readFixture(t, "sso_trimmed.xlsx")
	if len(reg.obstacles) != 20 || reg.stats.SkippedNoPosition != 1 {
		t.Fatalf("obstacles = %d, skipped %d; want 20, 1", len(reg.obstacles), reg.stats.SkippedNoPosition)
	}
	if !reg.edition.Equal(day(2026, time.August, 6)) {
		t.Errorf("edition = %v, want 2026-08-06", reg.edition)
	}
	rows, meta := build(t, reg.obstacles)
	if len(meta.UnknownTypes) != 0 {
		t.Errorf("unknownTypes = %v, want none", meta.UnknownTypes)
	}
	if r := rows["ie:SSO-EISN-0004.1"]; r == nil || r[1] != "windturbine" || r[8] != true {
		t.Errorf("SSO-EISN-0004.1 = %v, want a grouped turbine", r)
	}
	if r := rows["ie:SSO-EISN-0001"]; r == nil || r[1] != "mast" || r[8] != false {
		t.Errorf("SSO-EISN-0001 = %v, want a lone met mast", r)
	}
}

// Every type the two registers wrote in September 2026 reaches the
// builder's codelist; a new spelling is the drift the meta's unknownTypes
// reports.
func TestEveryPublishedKindIsMapped(t *testing.T) {
	var obs []aixm5.Obstacle
	for i, k := range []string{
		"Wind Farm", "Wind Farms", "Wind Turbine", "Wind Turbines", "Turbine", "Turbines",
		"Met Mast", "Met Masts", "Mast", "Masts", "RTE Mast", "RTE Masts", "Towercom Mast",
		"Chimney", "Chimneys", "Tanks", "Control Tower", "Antenna", "Other",
	} {
		obs = append(obs, aixm5.Obstacle{ID: string(rune('A' + i)), Type: kind(k), Lat: 53, Lon: -7})
	}
	_, meta := build(t, obs)
	if len(meta.UnknownTypes) != 0 {
		t.Errorf("unknownTypes = %v, want none", meta.UnknownTypes)
	}
}

const page = `
<a href="https://www.iaa.ie/docs/default-source/default-document-library/airspace/obstacles/area1/enr-5-4-airac-amendment-011_-26-effective-nov-2026.xlsx?sfvrsn=2a827c57_1">Download</a>
<a href="https://www.iaa.ie/docs/default-source/default-document-library/airspace/obstacles/area1/enr-5-4-airac-amendment-008-26-effective-aug-2026.xlsx?sfvrsn=da1dc9eb_10">Download</a>
<a href="/docs/default-source/default-document-library/airspace/safety-significant-obstacles/safety-significant-obstacles-airac-amendment-011_26-effective-nov-2026.xlsx?sfvrsn=bd8c965_1">Download</a>
<a href="https://www.iaa.ie/docs/default-source/default-document-library/airspace/safety-significant-obstacles/safety-significant-obstacles-airac-amendment-008-26-effective-aug-2026.xlsx?sfvrsn=95f991ab_5">Download</a>
<a href="https://www.iaa.ie/docs/default-source/default-document-library/airspace/aip-charts/enr-6.xlsx">not ours</a>
`

func TestFindReleases(t *testing.T) {
	a1 := findReleases([]byte(page), area1)
	sso := findReleases([]byte(page), safetySignificant)
	if len(a1) != 2 || len(sso) != 2 {
		t.Fatalf("releases = %d, %d; want 2, 2", len(a1), len(sso))
	}
	if a1[0].Name != "enr-5-4-airac-amendment-011_-26-effective-nov-2026.xlsx" || a1[0].month != time.November || a1[0].year != 2026 {
		t.Errorf("first Area 1 = %+v", a1[0])
	}
	// A root-relative link resolves against the site; the version query
	// stays on the URL and off the name.
	if sso[0].URL != "https://www.iaa.ie/docs/default-source/default-document-library/airspace/safety-significant-obstacles/safety-significant-obstacles-airac-amendment-011_26-effective-nov-2026.xlsx?sfvrsn=bd8c965_1" {
		t.Errorf("url = %q", sso[0].URL)
	}
}

// A month holds one AIRAC date, except the one a year that holds two.
func TestAiracDays(t *testing.T) {
	for _, c := range []struct {
		y    int
		m    time.Month
		want []time.Time
	}{
		{2026, time.August, []time.Time{day(2026, time.August, 6)}},
		{2026, time.October, []time.Time{day(2026, time.October, 1), day(2026, time.October, 29)}},
		{2026, time.November, []time.Time{day(2026, time.November, 26)}},
		{2027, time.February, []time.Time{day(2027, time.February, 18)}},
	} {
		got := airacDays(c.y, c.m)
		if len(got) != len(c.want) {
			t.Errorf("%s %d: %v, want %v", c.m, c.y, got, c.want)
			continue
		}
		for i := range got {
			if !got[i].Equal(c.want[i]) {
				t.Errorf("%s %d: %v, want %v", c.m, c.y, got, c.want)
			}
		}
	}
}

func TestEffectiveOf(t *testing.T) {
	aug := release{Name: "aug", year: 2026, month: time.August}
	oct := release{Name: "oct", year: 2026, month: time.October}
	if e, err := effectiveOf(aug, time.Time{}); err != nil || !e.Equal(day(2026, time.August, 6)) {
		t.Errorf("aug = %v, %v", e, err)
	}
	// The change record names an earlier edition when the amendment
	// changed nothing: the name's date stands.
	if e, err := effectiveOf(aug, day(2026, time.April, 16)); err != nil || !e.Equal(day(2026, time.August, 6)) {
		t.Errorf("aug with an older edition = %v, %v", e, err)
	}
	if e, err := effectiveOf(oct, day(2026, time.October, 29)); err != nil || !e.Equal(day(2026, time.October, 29)) {
		t.Errorf("oct = %v, %v", e, err)
	}
	// Two dates and a record naming neither: refused rather than guessed.
	if _, err := effectiveOf(oct, day(2026, time.September, 3)); err == nil {
		t.Error("an undatable October file accepted")
	}
	// A record dating an edition after the file's own: mislabelled.
	if _, err := effectiveOf(aug, day(2026, time.November, 26)); err == nil {
		t.Error("an edition after the file's date accepted")
	}
}

func resolved(name string, eff time.Time) release {
	return release{Name: name, year: eff.Year(), month: eff.Month(), Effective: eff}
}

func TestPickSet(t *testing.T) {
	aug, nov := day(2026, time.August, 6), day(2026, time.November, 26)
	a1 := []release{resolved("a1-nov", nov), resolved("a1-aug", aug)}
	sso := []release{resolved("sso-nov", nov), resolved("sso-aug", aug)}
	now := fixedNow()
	for _, c := range []struct {
		target, a1, sso string
		eff             time.Time
	}{
		{"auto", "a1-aug", "sso-aug", aug},
		{"current", "a1-aug", "sso-aug", aug},
		{"next", "a1-nov", "sso-nov", nov},
	} {
		p, err := pickSet(a1, sso, c.target, now)
		if err != nil || p == nil {
			t.Fatalf("%s: %v, %v", c.target, p, err)
		}
		if p.area1.Name != c.a1 || p.safetySignificant.Name != c.sso || !p.effective().Equal(c.eff) {
			t.Errorf("%s: %s + %s at %v, want %s + %s at %v", c.target,
				p.area1.Name, p.safetySignificant.Name, p.effective(), c.a1, c.sso, c.eff)
		}
	}

	// The registers are amended apart: a pre-release of one carries the
	// other's edition in force.
	p, err := pickSet(a1, sso[1:], "next", now)
	if err != nil || p == nil || p.area1.Name != "a1-nov" || p.safetySignificant.Name != "sso-aug" || !p.effective().Equal(nov) {
		t.Errorf("next with one register amended = %+v, %v", p, err)
	}

	// Nothing future posted is normal, not an error.
	if p, err := pickSet(a1[1:], sso[1:], "next", now); err != nil || p != nil {
		t.Errorf("next with nothing posted = %v, %v; want nil, nil", p, err)
	}

	// A register missing from the page is an error: the data set would
	// otherwise lose a third of its obstacles without a word.
	if _, err := pickSet(a1, nil, "current", now); err == nil {
		t.Error("a missing register accepted")
	}
}

// A replay dates its files off their published names, which -keep keeps.
func TestLocalPickNeedsPublishedNames(t *testing.T) {
	dir := t.TempDir()
	good := filepath.Join(dir, "enr-5-4-airac-amendment-008-26-effective-aug-2026.xlsx")
	bad := filepath.Join(dir, "area1.xlsx")
	for _, p := range []string{good, bad} {
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := localPick(good, good); err != nil {
		t.Errorf("published names refused: %v", err)
	}
	if _, err := localPick(good, bad); err == nil {
		t.Error("a name stating no month accepted")
	}
}

// The site refuses Go's own "Accept-Encoding: gzip" and now and then
// answers 403 to a request it serves a minute later: every request asks
// for identity, and a 403 is waited out.
func TestGetWaitsOutForbidden(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if got := r.Header.Get("Accept-Encoding"); got != "identity" {
			t.Errorf("Accept-Encoding = %q, want identity", got)
		}
		if calls < 3 {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		_, _ = w.Write([]byte("ok"))
	}))
	defer srv.Close()
	defer func(d time.Duration) { forbiddenWait = d }(forbiddenWait)
	forbiddenWait = time.Millisecond

	body, err := get(context.Background(), srv.URL)
	if err != nil || string(body) != "ok" || calls != 3 {
		t.Errorf("get = %q, %v after %d calls; want ok after 3", body, err, calls)
	}

	// A 403 that outlasts the attempts is an error.
	calls = -10
	if _, err := get(context.Background(), srv.URL); err == nil {
		t.Error("a lasting 403 accepted")
	}
}
