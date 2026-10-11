package eaip

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func day(s string) time.Time {
	t, err := time.Parse("2006-01-02", s)
	if err != nil {
		panic(err)
	}
	return t
}

func TestAiracLag(t *testing.T) {
	now := day("2026-09-24")
	cases := []struct {
		eff  string
		want int
	}{
		{"2026-09-03", 0}, // the cycle in force
		{"2026-10-01", 0}, // a pre-release is not behind
		{"2026-08-06", 1},
		{"2026-08-07", 1}, // off the grid (Sweden's non-AIRAC amendment)
		{"2026-07-09", 2},
	}
	for _, c := range cases {
		if got := airacLag(day(c.eff), now); got != c.want {
			t.Errorf("airacLag(%s) = %d, want %d", c.eff, got, c.want)
		}
	}
}

// The judgement that stops a moved package shipping the previous cycle as
// current, and lets a State that did not amend keep its package.
func TestJudge(t *testing.T) {
	aug := Cycle{Dir: "aug", Effective: "2026-08-06T00:00:00.000Z"}
	sep := Cycle{Dir: "sep", Effective: "2026-09-03T00:00:00.000Z"}
	inGrace := day("2026-09-05")
	pastGrace := day("2026-09-24")
	pointer := func(d string) Pointer {
		return func(context.Context, *Site, time.Time) (time.Time, error) { return day(d), nil }
	}
	cases := []struct {
		name    string
		site    Site
		c       Cycle
		now     time.Time
		stated  time.Time
		wantErr bool
		confirm bool
		lag     int
	}{
		{name: "current package", c: sep, now: pastGrace},
		// Ireland, September 2026: a package moved, the look-back read
		// August, and nothing the publisher states says otherwise.
		{name: "unconfirmed lag past the grace", c: aug, now: pastGrace, wantErr: true},
		{name: "unconfirmed lag inside the grace", c: aug, now: inGrace, lag: 1},
		{name: "two cycles behind", c: Cycle{Dir: "jul", Effective: "2026-07-09T00:00:00.000Z"}, now: inGrace, wantErr: true},
		// Bosnia, September 2026: no amendment, and updates.json says so.
		{name: "pointer confirms the lag", site: Site{Pointer: pointer("2026-08-06")}, c: aug, now: pastGrace, confirm: true, lag: 1},
		{name: "pointer names a newer package", site: Site{Pointer: pointer("2026-09-03")}, c: aug, now: inGrace, wantErr: true},
		{name: "index names a newer package", c: aug, now: inGrace, stated: day("2026-09-03"), wantErr: true},
		{name: "index confirms", c: aug, now: pastGrace, stated: day("2026-08-06"), confirm: true, lag: 1},
		// A publisher's pointer lagging the package it already serves is
		// no reason to refuse the current one.
		{name: "pointer behind the package read", site: Site{Pointer: pointer("2026-08-06")}, c: sep, now: pastGrace},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			site := c.site
			by := ""
			if !c.stated.IsZero() {
				by = "cycle index"
			}
			got, err := site.judge(context.Background(), c.c, c.now, c.stated, by)
			if (err != nil) != c.wantErr {
				t.Fatalf("err = %v, want error %v", err, c.wantErr)
			}
			if err != nil {
				return
			}
			if got.Confirmed != c.confirm || got.Lag != c.lag {
				t.Errorf("confirmed %v lag %d, want %v %d", got.Confirmed, got.Lag, c.confirm, c.lag)
			}
		})
	}
}

func TestPageEffective(t *testing.T) {
	cases := []struct{ page, want string }{
		{`<meta name="EM.effectiveDateStart" content="2026-09-03"/>`, "2026-09-03"},
		{`<title>AIP for PORTUGAL (section ENR-2.1)valid from 06 AUG 2026</title>`, "2026-08-06"},
		{`<title>AIP for BELGIUM (section ENR-2.1) valid from 9 JUL 2026</title>`, "2026-07-09"},
		{`<title>nothing dated</title>`, ""},
	}
	for _, c := range cases {
		if got := PageEffective([]byte(c.page)); got != c.want {
			t.Errorf("PageEffective(%q) = %q, want %q", c.page, got, c.want)
		}
	}
}

// Each publisher names its packages its own way; the pointer reads them
// all for their date.
func TestPointerDates(t *testing.T) {
	now := day("2026-09-24")
	cases := []struct{ page, want string }{
		// SMATSA's start page.
		{`<a href="./03-Sep-2026-A/2026-09-03-AIRAC/html/index_commands.html">`, "2026-09-03"},
		// LPS SR's portal: the package in force and the next.
		{`AIP_SR_EFF_03SEP2026 AIP_SR_EFF_01OCT2026_amdt`, "2026-09-03"},
		// ALBCONTROL's AIP page: the current folder and the pre-release.
		{`06-AUG-2026-A 01-OCT-2026-A`, "2026-08-06"},
	}
	for _, c := range cases {
		got, ok := newestInForce(pointerDates(c.page), now)
		if !ok || got != day(c.want) {
			t.Errorf("pointerDates(%q) in force = %v %v, want %s", c.page, got, ok, c.want)
		}
	}
}

func TestIssueListAndRedirectPointers(t *testing.T) {
	mux := http.NewServeMux()
	// Bosnia's updates.json: the publication dates are older than the
	// effective ones and must never be taken for them.
	mux.HandleFunc("/updates.json", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`[
			{"effectiveDate": "01 OCT 2026", "publicationDate": "20 AUG 2026"},
			{"effectiveDate": "06 AUG 2026", "publicationDate": "25 JUN 2026"}
		]`))
	})
	// Estonia's root answers with a redirect to the package in force.
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		http.Redirect(w, r, "/2026-08-06/html/", http.StatusFound)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	s := &Site{}
	now := day("2026-09-24")
	got, err := IssueListPointer(srv.URL+"/updates.json")(context.Background(), s, now)
	if err != nil || got != day("2026-08-06") {
		t.Errorf("issue list: %v %v, want 2026-08-06", got, err)
	}
	got, err = RedirectPointer(srv.URL+"/")(context.Background(), s, now)
	if err != nil || got != day("2026-08-06") {
		t.Errorf("redirect: %v %v, want 2026-08-06", got, err)
	}
}

// Portugal, 2026: the frameset loads -en-PT while the June -en-GB files
// stay online beside it. The package's own frameset decides, and a Site
// that pins its suffix never falls back to en-GB.
func TestResolveFixedReadsTheFramesetLanguage(t *testing.T) {
	mux := http.NewServeMux()
	page := func(eff string) string {
		return `<html><head><meta name="EM.effectiveDateStart" content="` + eff +
			`"/></head><body><h1>ENR 2.1</h1><table><tr><td>x</td></tr></table></body></html>`
	}
	mux.HandleFunc("/cur/html/", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`<frameset><frame src="eAIP/LP-menu-en-PT.html"/><frame src="LP-cover-en-PT.html"/></frameset>`))
	})
	mux.HandleFunc("/cur/html/eAIP/LP-ENR-2.1-en-PT.html", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(page("2026-08-06")))
	})
	mux.HandleFunc("/cur/html/eAIP/LP-ENR-2.1-en-GB.html", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(page("2026-06-11"))) // the stale leftover
	})
	mux.HandleFunc("/next/html/", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`<frameset><frame src="eAIP/LP-menu-en-PT.html"/></frameset>`))
	})
	mux.HandleFunc("/next/html/eAIP/LP-ENR-2.1-en-PT.html", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(page("2026-10-01")))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	s := &Site{Country: "LP", Family: Eurocontrol, Base: srv.URL + "/cur", NextBase: srv.URL + "/next", Lang: "en-PT"}
	now := day("2026-09-24")

	cur, err := s.Resolve(context.Background(), "ENR 2.1", now, false)
	if err != nil {
		t.Fatal(err)
	}
	if cur.Lang != "en-PT" || !strings.HasPrefix(cur.Effective, "2026-08-06") || !cur.Confirmed || !cur.FromPages {
		t.Errorf("current = %+v", cur)
	}
	if got := s.PageURL(cur, "ENR 5.1"); got != srv.URL+"/cur/html/eAIP/LP-ENR-5.1-en-PT.html" {
		t.Errorf("PageURL = %s", got)
	}

	next, err := s.Resolve(context.Background(), "ENR 2.1", now, true)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(next.Effective, "2026-10-01") || next.base(s) != srv.URL+"/next" {
		t.Errorf("next = %+v", next)
	}

	// Once the forthcoming alias serves the package in force, it is not
	// a pre-release any more.
	later, err := s.Resolve(context.Background(), "ENR 2.1", day("2026-10-02"), true)
	if err != nil || later.Effective != "" {
		t.Errorf("forthcoming in force = %+v, %v; want nothing", later, err)
	}
}

// Ireland, September 2026, reproduced: the package moved to a layout no
// template knew, the previous cycle stayed online, and the look-back read
// it. Past the grace this must now fail, and the template that knows the
// new layout must find the September package.
func TestResolveRefusesAMovedPackage(t *testing.T) {
	mux := http.NewServeMux()
	section := `<h1>ENR 2.1</h1><table><tr><td>x</td></tr></table>`
	mux.HandleFunc("/AIRAC_AUGUST_2026/26-08-06-AIRAC/html/eAIP/EI-ENR-2.1-en-IE.html", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(section))
	})
	mux.HandleFunc("/AIRAC/2026-09-03-AIRAC/html/eAIP/EI-ENR-2.1-en-IE.html", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(section))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	now := day("2026-09-24")

	old := &Site{Country: "EI", Family: Eurocontrol, Base: srv.URL, Lang: "en-IE",
		Templates: []string{"AIRAC_{MONTH}_{YYYY}/{YY}-{MM}-{DD}-AIRAC"}}
	if _, err := old.Resolve(context.Background(), "ENR 2.1", now, false); err == nil {
		t.Error("the August package was taken for September's")
	}

	fixed := &Site{Country: "EI", Family: Eurocontrol, Base: srv.URL, Lang: "en-IE",
		Templates: []string{"AIRAC/{ISO}-AIRAC", "AIRAC_{MONTH}_{YYYY}/{YY}-{MM}-{DD}-AIRAC"}}
	c, err := fixed.Resolve(context.Background(), "ENR 2.1", now, false)
	if err != nil {
		t.Fatal(err)
	}
	if c.Dir != "AIRAC/2026-09-03-AIRAC" || c.Lag != 0 {
		t.Errorf("resolved %+v, want the September package", c)
	}
}

// Ireland, 2026-09-24: October's package took the flat AIRAC/ folder and
// September was moved to AIRAC_SEPT_2026/, a spelling no template had.
// AirNav's AIM page links both by their full URL, which is what now finds
// them, and states which is in force.
func TestResolveFromLinkedPackages(t *testing.T) {
	mux := http.NewServeMux()
	section := `<h1>ENR 2.1</h1><table><tr><td>x</td></tr></table>`
	var srv *httptest.Server
	mux.HandleFunc("/aim", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = fmt.Fprintf(w, `<a href="%[1]s/AIRAC/2026-10-01-AIRAC/html/index.html">October</a>
<a href="%[1]s/AIRAC_SEPT_2026/2026-09-03-AIRAC/html/index.html">September</a>
<a href="%[1]s/AIRAC_AUGUST_2026/26-08-06-AIRAC/html/index.html">August</a>
<a href="https://elsewhere.example/AIRAC/2026-09-03-AIRAC/html/index.html">mirror</a>`, srv.URL)
	})
	for _, dir := range []string{"AIRAC/2026-10-01-AIRAC", "AIRAC_SEPT_2026/2026-09-03-AIRAC", "AIRAC_AUGUST_2026/26-08-06-AIRAC"} {
		mux.HandleFunc("/"+dir+"/html/eAIP/EI-ENR-2.1-en-IE.html", func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(section))
		})
	}
	srv = httptest.NewServer(mux)
	defer srv.Close()
	now := day("2026-09-24")
	s := &Site{Country: "EI", Family: Eurocontrol, Base: srv.URL, Index: srv.URL + "/aim", Lang: "en-IE"}

	cur, err := s.Resolve(context.Background(), "ENR 2.1", now, false)
	if err != nil {
		t.Fatal(err)
	}
	if cur.Dir != "AIRAC_SEPT_2026/2026-09-03-AIRAC" || cur.Lag != 0 || !cur.Confirmed {
		t.Errorf("current = %+v, want the September package, confirmed", cur)
	}
	next, err := s.Resolve(context.Background(), "ENR 2.1", now, true)
	if err != nil {
		t.Fatal(err)
	}
	if next.Dir != "AIRAC/2026-10-01-AIRAC" {
		t.Errorf("next = %+v, want the October package", next)
	}
	// The two-digit year reads as this century's.
	for _, c := range cyclesIn(`<a href="/AIRAC_AUGUST_2026/26-08-06-AIRAC/html/index.html">`) {
		if c.Dir != "/AIRAC_AUGUST_2026/26-08-06-AIRAC" || !strings.HasPrefix(c.Effective, "2026-08-06") {
			t.Errorf("August = %+v", c)
		}
	}
}

// Every IDS AIRNAV history page names its packages its own way, and the one
// thing they share is the effective date the generator appends.
func TestCyclesInIDSHistoryPages(t *testing.T) {
	cases := []struct{ page, dir, eff string }{
		// LFV: a backslash separator, AIRAC and non-AIRAC labels.
		{`<a href="AIP AMDT 1-2026_2026_08_07\index-v2.html">`, "AIP AMDT 1-2026_2026_08_07", "2026-08-07"},
		{`<a href="AIRAC AIP AMDT 6-2026_2026_10_29\index-v2.html">`, "AIRAC AIP AMDT 6-2026_2026_10_29", "2026-10-29"},
		// Fintraffic and Avians.
		{`<a href="06%20AUG%202026_2026_08_06/index-v2.html">`, "06 AUG 2026_2026_08_06", "2026-08-06"},
		{`<a href="./A_08-2026_2026_09_03/index-v2.html">`, "A_08-2026_2026_09_03", "2026-09-03"},
		// Avians' new host links the packages on the old one, absolutely
		// and with a stray leading space.
		{`<a href=" https://eaip.isavia.is/A_09-2026_2026_10_01/">`, "A_09-2026_2026_10_01", "2026-10-01"},
		// PANSA / KANS, which the older pattern already read.
		{`<a href="AIRAC%20AMDT%2009-2026_2026_09_03/index.html">`, "AIRAC AMDT 09-2026_2026_09_03", "2026-09-03"},
	}
	for _, c := range cases {
		got := cyclesIn(c.page)
		if len(got) != 1 || got[0].Dir != c.dir || !strings.HasPrefix(got[0].Effective, c.eff) {
			t.Errorf("cyclesIn(%q) = %+v, want %s effective %s", c.page, got, c.dir, c.eff)
		}
	}
}

// LGS links each issue by its path, the effective date its last segment,
// and issued an AIRAC and a non-AIRAC amendment for one date: the AIRAC
// one is the package.
func TestCyclesInPackagePaths(t *testing.T) {
	page := `<a href="eAIPfiles/2026_003_03-SEP-2026-Non-AIRAC/data/2026-09-03/html/index.html ">` +
		`<a href="eAIPfiles/2026_006_03-SEP-2026/data/2026-09-03/html/index.html">` +
		`<a href="eAIPfiles/2026_007_29-OCT-2026/data/2026-10-29/html/index.html">`
	got := cyclesIn(page)
	want := []string{
		"eAIPfiles/2026_007_29-OCT-2026/data/2026-10-29",
		"eAIPfiles/2026_006_03-SEP-2026/data/2026-09-03",
		"eAIPfiles/2026_003_03-SEP-2026-Non-AIRAC/data/2026-09-03",
	}
	if len(got) != len(want) {
		t.Fatalf("cyclesIn = %+v", got)
	}
	for i, c := range got {
		if c.Dir != want[i] {
			t.Errorf("cycle %d = %s, want %s", i, c.Dir, want[i])
		}
	}
	if !strings.HasPrefix(got[1].Effective, "2026-09-03") {
		t.Errorf("effective = %s", got[1].Effective)
	}
}

// Avinor's base carries an edition number that moves (/View/Index/155):
// the root's redirect names it, and the history page it lands on lists
// the packages beside it.
func TestResolveLocatesTheBase(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/no/AIP/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/no/AIP/" {
			http.NotFound(w, r)
			return
		}
		http.Redirect(w, r, "/no/AIP/View/Index/155/history-no-NO.html", http.StatusFound)
	})
	mux.HandleFunc("/no/AIP/View/Index/155/history-no-NO.html", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`<a href="2026-10-01-AIRAC/html/index-no-NO.html">` +
			`<a href="2026-09-03-AIRAC/html/index-no-NO.html">`))
	})
	mux.HandleFunc("/no/AIP/View/Index/155/2026-09-03-AIRAC/html/eAIP/EN-ENR-2.1-en-GB.html", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`<h1>ENR 2.1</h1><table><tr><td>x</td></tr></table>`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	s := &Site{Country: "EN", Family: Eurocontrol, BaseFrom: srv.URL + "/no/AIP/", Lang: "en-GB"}
	c, err := s.Resolve(context.Background(), "ENR 2.1", day("2026-09-24"), false)
	if err != nil {
		t.Fatal(err)
	}
	if s.Base != srv.URL+"/no/AIP/View/Index/155" || c.Dir != "2026-09-03-AIRAC" || c.Lag != 0 || !c.Confirmed {
		t.Errorf("base %s, cycle %+v", s.Base, c)
	}
}

// Avians posts two editions ahead. The pre-release slot is the one that
// takes effect next; the later one in it would keep the one between from
// ever being shown.
func TestNextSlotIsTheSoonestEdition(t *testing.T) {
	// One handler: a ServeMux pattern holding a space reads as a method.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/":
			_, _ = w.Write([]byte(`<a href="A_08-2026_2026_09_03/">` +
				`<a href="A_09-2026_2026_10_01/"><a href="A_10-2026_2026_10_29/">`))
		case strings.HasSuffix(r.URL.Path, "/eAIP/BI-ENR 2.1-en-GB.html"):
			_, _ = w.Write([]byte(`<h1>ENR 2.1</h1><table><tr><td>x</td></tr></table>`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	s := &Site{Country: "BI", Family: IDS, Base: srv.URL, Index: srv.URL + "/", Lang: "en-GB"}
	c, err := s.Resolve(context.Background(), "ENR 2.1", day("2026-09-24"), true)
	if err != nil {
		t.Fatal(err)
	}
	if c.Dir != "A_09-2026_2026_10_01" {
		t.Errorf("next slot = %s, want the 2026-10-01 edition", c.Dir)
	}
}
