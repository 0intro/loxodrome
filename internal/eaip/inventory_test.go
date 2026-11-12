package eaip

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Every IDS AIRNAV history titles its aerodromes its own way, and the
// child entry for AD 2.1 is the key: Fintraffic's, KANS's, and LFV's with
// no "AD" and a no-break space. PANSA's AIP VFR files its aerodromes as AD
// 4, the entry itself the key. A JavaScript literal's tabs and trailing
// commas do not stop the read (PANSA).
func TestIDSAerodromes(t *testing.T) {
	ds := "const DATASOURCE = {\"tabs\": [{\"contents\": {\"en-GB\": {\"menu\": [\n" +
		`{"title": "AD 2 EFJY - JYVÄSKYLÄ ", "href": "EF-AD 2 EFJY - JYVÄSKYLÄ 1-en-GB.html#x", "children": [` +
		`{"title": "EFJY AD 2.1 AERODROME LOCATION INDICATOR AND NAME", "href": "EF-AD 2 EFJY - JYVÄSKYLÄ 1-en-GB.html#AD2.1"},]},` +
		`{"title": " BKPR ", "children": [{"title": "BKPR AD 2.1 AERODROME\tLOCATION INDICATOR", "href": "BK-AD 2 BKPR-en-GB.html#AD2.1"}]},` +
		"{\"title\": \"ESNX 2.1\u00a0 AERODROME LOCATION INDICATOR AND NAME\", \"href\": \"ES-AD 2 ESNX ARVIDSJAUR 1-en-GB.html#AD2.1_TITLE\"}," +
		`{"title": "EFHV AD 3.1 HELIPORT LOCATION INDICATOR AND NAME", "href": "EF-AD 3 EFHV 1-en-GB.html"},` +
		`{"title": "AD 4 LOTNISKA", "href": "AD 4-en-GB.html"},` +
		`{"title": "AD 4 EPBA ", "href": "AD 4 EPBA 1-en-GB.html#AD-4-EPBA-1", "children": [` +
		`{"title": " EPBA 1 ", "href": "AD 4 EPBA 1-en-GB.html#AD-4-EPBA-1"}, {"title": " EPBA 2 ", "href": "AD 4 EPBA 2-en-GB.html#AD-4-EPBA-2"}]}` +
		"]}}}]};"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/v2/js/datasource.js") {
			_, _ = w.Write([]byte(ds))
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()
	s := &Site{Family: IDS, Base: srv.URL, Lang: "en-GB"}
	ads, err := s.Aerodromes(context.Background(), Cycle{Dir: "06 AUG 2026_2026_08_06"})
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, a := range ads {
		got = append(got, a.ICAO+":"+string(rune('0'+a.Section))+":"+strings.TrimPrefix(a.URL, srv.URL))
	}
	want := []string{
		"BKPR:2:/06%20AUG%202026_2026_08_06/eAIP/BK-AD%202%20BKPR-en-GB.html",
		"EFHV:3:/06%20AUG%202026_2026_08_06/eAIP/EF-AD%203%20EFHV%201-en-GB.html",
		"EFJY:2:/06%20AUG%202026_2026_08_06/eAIP/EF-AD%202%20EFJY%20-%20JYV%C3%84SKYL%C3%84%201-en-GB.html",
		"EPBA:4:/06%20AUG%202026_2026_08_06/eAIP/AD%204%20EPBA%201-en-GB.html",
		"ESNX:2:/06%20AUG%202026_2026_08_06/eAIP/ES-AD%202%20ESNX%20ARVIDSJAUR%201-en-GB.html",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("got\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}
