package main

import (
	"strings"
	"testing"
	"time"
)

func TestPickRoEdition(t *testing.T) {
	listing := `<a href="2026-08-06/">2026-08-06/</a> <a href="2026-09-03/">2026-09-03/</a>
<a href="2026-10-01/">2026-10-01/</a> <a href="2026-10-29/">2026-10-29/</a> <a href="aip.php">aip.php</a>`
	now := time.Date(2026, 9, 24, 12, 0, 0, 0, time.UTC)
	if got := pickRoEdition(listing, now, false); got != "2026-09-03" {
		t.Errorf("current %q", got)
	}
	if got := pickRoEdition(listing, now, true); got != "2026-10-01" {
		t.Errorf("next %q", got)
	}
	// On its effective day an edition is in force.
	if got := pickRoEdition(listing, time.Date(2026, 10, 1, 0, 30, 0, 0, time.UTC), false); got != "2026-10-01" {
		t.Errorf("on the day %q", got)
	}
}

func TestRoFields(t *testing.T) {
	listing := `<a href="/aip/2026-09-03/DOCS/AIP/AD/">Parent</a> <a href="AD_2_1_LRAR/">AD_2_1_LRAR/</a> <a href="AD_2_36_LRZN/">AD_2_36_LRZN/</a>`
	var got []string
	for _, f := range roFields(listing, 2) {
		got = append(got, f.icao+"="+f.dir)
	}
	if strings.Join(got, " ") != "LRAR=AD2/AD_2_1_LRAR LRZN=AD2/AD_2_36_LRZN" {
		t.Errorf("fields %q", strings.Join(got, " "))
	}
	sheets := roSheetRe.FindAllStringSubmatch(`<a href="LR_AD_2_LRAR_1-20_en.pdf"> <a href="LR_AD_3_LRBG_2_20_en.pdf"> <a href="LR_AD_2_LRAR_en.pdf">`, -1)
	if len(sheets) != 2 || sheets[0][2]+"-"+sheets[0][3] != "1-20" || sheets[1][2]+"-"+sheets[1][3] != "2-20" {
		t.Errorf("sheets %q", sheets)
	}
}

// The list as pdftotext -layout prints it (Arad, Brașov, Baia Mare and
// Bacău, 2026-09-03): titles with their page, family headings above
// indented sheets, a chart over two pages, a leader of ellipses, a page
// break's foot and head inside a family, and the next section closing it.
func TestParseRoChartList(t *testing.T) {
	text := `                                   LRAR AD 2.24 CHARTS RELATED TO THE AERODROME

     Aerodrome Chart - ICAO ................................................................ AD 2.1-20
     Aerodrome Obstacle Chart - ICAO - Type A
                    RWY 09 ......................................................... AD 2.1-25
                    RWY 27 ......................................................... AD 2.1-26
     RNAV Departure Chart RWY 27- ICAO .............................................. AD 2.1-35
     Standard Departure Charts - Instrument - ICAO
                    RWY 03  ...........................................  AD 2.1-31/AD 2.1-32
     Visual Operations Chart - Aircraft categories A and H ………………………… ........ AD 2.1-40
     Instrument Approach Charts - ICAO
                    RWY 27 ILS CAT A, B ....................................... ........ AD 2.1-53
ROMATSA                                                                   AIRAC AIP AMDT 14/25
AD 2.1-14                                                                                  AIP
25 DEC 2025                                                                            ROMANIA
               NDB Y RWY 16 ...  AD 2.1-92

                            LRAR AD 2.25 VISUAL SEGMENT SURFACE (VSS) PENETRATION
     Not in the list ......................................................... AD 2.1-99
`
	var got []string
	for _, r := range parseRoChartList(text) {
		got = append(got, r.page+"|"+r.title)
	}
	want := strings.Join([]string{
		"1-20|Aerodrome Chart - ICAO",
		"1-25|Aerodrome Obstacle Chart - ICAO - Type A RWY 09",
		"1-26|Aerodrome Obstacle Chart - ICAO - Type A RWY 27",
		"1-35|RNAV Departure Chart RWY 27- ICAO",
		"1-31|Standard Departure Charts - Instrument - ICAO RWY 03",
		"1-32|Standard Departure Charts - Instrument - ICAO RWY 03",
		"1-40|Visual Operations Chart - Aircraft categories A and H",
		"1-53|Instrument Approach Charts - ICAO RWY 27 ILS CAT A, B",
		"1-92|Instrument Approach Charts - ICAO NDB Y RWY 16",
	}, "\n")
	if strings.Join(got, "\n") != want {
		t.Errorf("got\n%s\nwant\n%s", strings.Join(got, "\n"), want)
	}
}
