package main

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
)

// The fetcher reads a layer's pages until they have returned what the
// first said matched, under the names -keep gave them.
func TestFetcherPages(t *testing.T) {
	src := &fetcher{in: replayDir}
	for _, c := range []struct {
		layer ignLayer
		want  []string
	}{
		{ignChefLieux, []string{"ign-chef_lieu-001.json", "ign-chef_lieu-002.json"}},
		{ignCommunes, []string{"ign-commune-001.json", "ign-commune-002.json"}},
		{ignDepartements, []string{"ign-departement-001.json"}},
	} {
		pages, err := src.pages(t.Context(), c.layer)
		if err != nil {
			t.Fatal(err)
		}
		var got []string
		for _, p := range pages {
			got = append(got, p.name)
		}
		if !slices.Equal(got, c.want) {
			t.Errorf("%s pages = %v, want %v", c.layer.name, got, c.want)
		}
	}
}

// A page the WFS answers with something other than JSON is asked for
// again, and when every ask fails the error quotes the answer.
func TestFetcherPageNotJSON(t *testing.T) {
	good, err := os.ReadFile(filepath.Join(replayDir, "ign-departement-001.json"))
	if err != nil {
		t.Fatal(err)
	}
	const notJSON = "# not GeoJSON\n"
	var bad atomic.Int32 // the answers still to go wrong
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if bad.Add(-1) >= 0 {
			fmt.Fprint(w, notJSON)
			return
		}
		w.Write(good)
	}))
	defer srv.Close()
	wfs, pause := ignWFS, pagePause
	ignWFS, pagePause = srv.URL, 0
	t.Cleanup(func() { ignWFS, pagePause = wfs, pause })

	src := &fetcher{lim: &limiter{}}
	bad.Store(1)
	pages, err := src.pages(t.Context(), ignDepartements)
	if err != nil {
		t.Fatalf("pages after one answer not JSON: %v", err)
	}
	if len(pages) != 1 || !bytes.Equal(pages[0].data, good) {
		t.Errorf("pages after one answer not JSON = %d pages, want the one good page", len(pages))
	}

	const many = 1 << 20
	bad.Store(many)
	_, err = src.pages(t.Context(), ignDepartements)
	if err == nil || !strings.Contains(err.Error(), strconv.Quote(notJSON)) {
		t.Errorf("pages with every answer not JSON: err = %v, want it to quote %q", err, notJSON)
	}
	if asked := many - bad.Load(); asked != int32(pageAttempts) {
		t.Errorf("pages with every answer not JSON asked %d times, want %d", asked, pageAttempts)
	}
}

func TestPageURL(t *testing.T) {
	u, err := url.Parse(ignCommunes.pageURL(5000))
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	for k, want := range map[string]string{
		"SERVICE":      "WFS",
		"VERSION":      "2.0.0",
		"REQUEST":      "GetFeature",
		"TYPENAMES":    "ADMINEXPRESS-COG.LATEST:commune",
		"outputFormat": "application/json",
		"propertyName": "code_insee,nom_officiel,population,code_insee_du_departement",
		"sortBy":       "code_insee ASC",
		"count":        "5000",
		"startIndex":   "5000",
	} {
		if got := q.Get(k); got != want {
			t.Errorf("pageURL %s = %q, want %q", k, got, want)
		}
	}
	if u.Scheme+"://"+u.Host+u.Path != ignWFS {
		t.Errorf("pageURL = %s, want the WFS %s", u, ignWFS)
	}
}

// wfsPageJSON is one answer of the communes layer.
func wfsPageJSON(matched int, codes ...string) []byte {
	var feats []string
	for _, c := range codes {
		feats = append(feats, fmt.Sprintf(`{"type":"Feature","geometry":null,"properties":{"code_insee":%q,"nom_officiel":"X","population":1,"code_insee_du_departement":"91"}}`, c))
	}
	return fmt.Appendf(nil, `{"type":"FeatureCollection","features":[%s],"numberMatched":%d,"numberReturned":%d}`, strings.Join(feats, ","), matched, len(codes))
}

func TestReadLayerRefuses(t *testing.T) {
	for name, pages := range map[string][]named{
		"a page short": {{"p1", wfsPageJSON(3, "1", "2")}},
		"the total moved": {
			{"p1", wfsPageJSON(3, "1", "2")},
			{"p2", wfsPageJSON(4, "3")},
		},
		"no page":     nil,
		"not GeoJSON": {{"p1", []byte(`<ows:ExceptionReport/>`)}},
	} {
		if _, err := readLayer[communeProps](pages); err == nil {
			t.Errorf("%s: readLayer accepted the pages", name)
		}
	}
	got, err := readLayer[communeProps]([]named{{"p1", wfsPageJSON(3, "1", "2")}, {"p2", wfsPageJSON(3, "3")}})
	if err != nil || len(got) != 3 || got[2].Properties.Code != "3" {
		t.Errorf("readLayer over two pages = %v, %v, want three features", got, err)
	}
}

func readIGN(t *testing.T) (map[string]place, map[string]place, ignDrops) {
	t.Helper()
	in := readInputs(t)
	files, drops, err := buildIGN(in.ChefLieux, in.Communes, in.Departements, testTable)
	if err != nil {
		t.Fatal(err)
	}
	return byCode(files["fr"]), byCode(files["gp"]), drops
}

func byCode(ps []place) map[string]place {
	out := map[string]place{}
	for _, p := range ps {
		out[p.code] = p
	}
	return out
}

func TestBuildIGN(t *testing.T) {
	fr, gp, drops := readIGN(t)
	if len(fr) != 6 {
		t.Errorf("fr holds %d communes, want 6: %v", len(fr), fr)
	}
	// Two communes sharing a name are two places, told apart by the
	// département.
	for code, dept := range map[string]string{"05135": "05", "17319": "17"} {
		if p, ok := fr[code]; !ok || p.name != "Sainte-Colombe" || p.admin != dept {
			t.Errorf("Sainte-Colombe %s = %+v, want it kept under %s", code, p, dept)
		}
	}
	// The chef-lieu places a commune, read [lon, lat].
	if p := fr["91223"]; p.name != "Étampes" || p.lat != 48.43451965 || p.lon != 2.16129463 || p.pop != 26857 || !p.hasPop || p.adminName != "Essonne" {
		t.Errorf("Étampes = %+v, want its chef-lieu 48.43451965, 2.16129463, 26857 people, Essonne", p)
	}
	// A destroyed village has no chef-lieu: it is dropped, never placed
	// on its outline.
	if _, ok := fr["55189"]; ok {
		t.Error("Fleury-devant-Douaumont, without a chef-lieu, was written")
	}
	// A population IGN does not give stays unknown.
	if p := fr["39421"]; p.hasPop {
		t.Errorf("Le Pin = %+v, want no population", p)
	}
	// Corsica is metropolitan France.
	if p, ok := fr["2A004"]; !ok || p.admin != "2A" || p.adminName != "Corse-du-Sud" {
		t.Errorf("Ajaccio = %+v, want it in fr under 2A", p)
	}
	// Guadeloupe has its own file.
	if p, ok := gp["97101"]; !ok || len(gp) != 1 || p.adminName != "Guadeloupe" {
		t.Errorf("gp = %v, want Les Abymes alone", gp)
	}
	// Saint-Pierre, filed under the département "NR", is a
	// collectivity's: GeoNames covers it.
	if drops != (ignDrops{Collectivity: 1, NoPosition: 1}) {
		t.Errorf("drops = %+v, want Saint-Pierre and Fleury-devant-Douaumont", drops)
	}
}

func TestBuildIGNRefuses(t *testing.T) {
	head := func(code string, lon, lat float64) named {
		return named{"head", fmt.Appendf(nil, `{"numberMatched":1,"features":[{"geometry":{"type":"Point","coordinates":[%v,%v]},"properties":{"code_insee_de_la_commune":%q}}]}`, lon, lat, code)}
	}
	commune := func(code, dept string) named {
		return named{"commune", fmt.Appendf(nil, `{"numberMatched":1,"features":[{"geometry":null,"properties":{"code_insee":%q,"nom_officiel":"X","population":1,"code_insee_du_departement":%q}}]}`, code, dept)}
	}
	depts := []named{{"departements", []byte(`{"numberMatched":2,"features":[{"properties":{"code_insee":"91","nom_officiel":"Essonne"}},{"properties":{"code_insee":"972","nom_officiel":"Martinique"}}]}`)}}
	for _, c := range []struct {
		name     string
		head     named
		commune  named
		wantText string
	}{
		{"an unknown département", head("98001", 2, 48), commune("98001", "980"), "in no country"},
		// Martinique is held, but not by this table.
		{"a département in no file", head("97209", -61, 14.6), commune("97209", "972"), "in no country"},
		{"a département without a name", head("2A004", 8.7, 41.9), commune("2A004", "2A"), "has no name"},
		// A WFS answering [lat, lon] would put Étampes in the Indian Ocean.
		{"a swapped axis", head("91223", 48.4345, 2.1613), commune("91223", "91"), "outside fr's envelope"},
	} {
		_, _, err := buildIGN([]named{c.head}, []named{c.commune}, depts, testTable)
		if err == nil || !strings.Contains(err.Error(), c.wantText) {
			t.Errorf("%s: buildIGN = %v, want an error saying %q", c.name, err, c.wantText)
		}
	}
	twice := named{"heads", []byte(`{"numberMatched":2,"features":[{"geometry":{"type":"Point","coordinates":[2,48]},"properties":{"code_insee_de_la_commune":"91223"}},{"geometry":{"type":"Point","coordinates":[2,48]},"properties":{"code_insee_de_la_commune":"91223"}}]}`)}
	if _, _, err := buildIGN([]named{twice}, []named{commune("91223", "91")}, depts, testTable); err == nil {
		t.Error("buildIGN accepted two chefs-lieux for one commune")
	}
}

func TestIsCollectivity(t *testing.T) {
	for _, c := range []struct {
		code, dept string
		want       bool
	}{
		{"97502", "NR", true},
		{"97701", "977", true},
		{"98818", "988", true},
		{"97101", "971", false},
		{"91223", "91", false},
		{"99999", "NR", false},
	} {
		if got := isCollectivity(communeProps{Code: c.code, Dept: c.dept}); got != c.want {
			t.Errorf("isCollectivity(%s, %s) = %t, want %t", c.code, c.dept, got, c.want)
		}
	}
}
