package eaip

import (
	"strings"
	"testing"
)

func chartsOf(t *testing.T, page, pageURL string) []Chart {
	t.Helper()
	doc, err := ParseHTML([]byte(page))
	if err != nil {
		t.Fatal(err)
	}
	return ParseAerodromeCharts(doc, pageURL, NodeText)
}

func chartSummary(cs []Chart) string {
	var parts []string
	for _, c := range cs {
		parts = append(parts, c.Code+"|"+c.Title+"|"+c.URL)
	}
	return strings.Join(parts, "\n")
}

// The three row shapes the cohort prints its charts table in, each from a
// live page, 2026-09-03.
func TestParseAerodromeCharts(t *testing.T) {
	cases := []struct {
		name, page, url, want string
	}{
		{
			// AirNav Ireland: the title cell spans the page-name row and the
			// link row; a table of contents names the heading first.
			"Ireland",
			`<table><tr><td><a href="#x">EIWT AD 2.24 CHARTS RELATED TO an AERODROME</a></td></tr>
			<tr><td><a href="#y">EIWT AD 2.25 VISUAL SEGMENT SURFACE</a></td></tr></table>
			<h4><span>EIWT AD 2.24</span> CHARTS RELATED TO an AERODROME</h4>
			<table><thead><tr><th>Name</th><th>Page </th></tr></thead><tbody>
			<tr><td rowspan="2">Aerodrome Chart – ICAO</td><td>Aerodrome Chart – ICAO</td></tr>
			<tr><td><a href="../../graphics/eAIP/EI_AD_2_EIWT_24-1_en.pdf">../graphics/eAIP/EI_AD_2_EIWT_24-1_en.pdf</a></td></tr>
			<tr><td rowspan="2">AERODROME OBSTACLE CHART – ICAO</td><td>AERODROME OBSTACLE CHART - ICAO</td></tr>
			<tr><td><a href="../../graphics/eAIP/EI_AD_2_EIWT_24-2_en.pdf">../graphics/eAIP/EI_AD_2_EIWT_24-2_en.pdf</a></td></tr>
			</tbody></table>
			<h4><span>EIWT AD 2.25</span> VISUAL SEGMENT SURFACE (VSS) PENETRATION.</h4>
			<table><tr><td>Other chart</td><td><a href="../../graphics/eAIP/other.pdf">x</a></td></tr></table>`,
			"https://www.airnav.ie/AIRAC/2026-09-03-AIRAC/html/eAIP/EI-AD-2.EIWT-en-IE.html",
			"ADC|Aerodrome Chart - ICAO|https://www.airnav.ie/AIRAC/2026-09-03-AIRAC/graphics/eAIP/EI_AD_2_EIWT_24-1_en.pdf\n" +
				"AOC|AERODROME OBSTACLE CHART - ICAO|https://www.airnav.ie/AIRAC/2026-09-03-AIRAC/graphics/eAIP/EI_AD_2_EIWT_24-2_en.pdf",
		},
		{
			// LPS SR: the title and the page reference holding the link.
			"Slovakia",
			`<h4>LZIB AD 2.24 CHARTS RELATED TO AN AERODROME</h4><table>
			<tr><th>Chart name</th><th>Page</th></tr>
			<tr><td>Aerodrome Chart - ICAO</td><td><a href="../pdf/aip/LZ_AD_2_LZIB_2-1_en.pdf">AD 2-LZIB-2-1</a></td></tr>
			<tr><td>Visual Approach Chart - ICAO</td><td><a href="../pdf/aip/LZ_AD_2_LZIB_7-1_en.pdf">AD 2-LZIB-7-1</a></td></tr>
			</table>`,
			"https://aim.lps.sk/web/eAIP_SR/AIP_SR_EFF_03SEP2026/html/LZ-AD-2.LZIB-en-SK.html",
			"ADC|Aerodrome Chart - ICAO|https://aim.lps.sk/web/eAIP_SR/AIP_SR_EFF_03SEP2026/pdf/aip/LZ_AD_2_LZIB_2-1_en.pdf\n" +
				"VAC|Visual Approach Chart - ICAO|https://aim.lps.sk/web/eAIP_SR/AIP_SR_EFF_03SEP2026/pdf/aip/LZ_AD_2_LZIB_7-1_en.pdf",
		},
		{
			// SMATSA: a title-only row, then a link-only row.
			"Serbia",
			`<h4>LYBE AD 2.24 CHARTS RELATED TO AN AERODROME</h4><table>
			<tr><td>Aerodrome Chart – ICAO</td></tr>
			<tr><td><a href="../../graphics/eAIP/7116087_LY_AD_2_LYBE_01-1-1_en.pdf">../graphics/eAIP/7116087_LY_AD_2_LYBE_01-1-1_en.pdf</a></td></tr>
			<tr><td>Chart for VFR flights – ICAO</td></tr>
			<tr><td><a href="../../graphics/eAIP/1_LY_AD_2_LYBE_14-1-1_en.pdf">../graphics/eAIP/1_LY_AD_2_LYBE_14-1-1_en.pdf</a></td></tr>
			</table>`,
			"https://smatsa.rs/upload/aip/published/03-Sep-2026-A/2026-09-03-AIRAC/html/eAIP/LY-AD-2.LYBE-en-GB.html",
			"ADC|Aerodrome Chart - ICAO|https://smatsa.rs/upload/aip/published/03-Sep-2026-A/2026-09-03-AIRAC/graphics/eAIP/7116087_LY_AD_2_LYBE_01-1-1_en.pdf\n" +
				"VAC|Chart for VFR flights - ICAO|https://smatsa.rs/upload/aip/published/03-Sep-2026-A/2026-09-03-AIRAC/graphics/eAIP/1_LY_AD_2_LYBE_14-1-1_en.pdf",
		},
		{
			// Fintraffic: the heading is a row of the table itself, and the
			// titles are ICAO's abbreviations.
			"Finland",
			`<table><tr><td>EFJY AD 2.24 CHARTS RELATED TO THE AERODROME</td></tr>
			<tr><td>Charts</td><td>Pages</td></tr>
			<tr><td><a href="../documents/Root_WePub/ANSFI/Charts/AD/EFJY/EF_AD_2_EFJY_ADC.pdf">ADC</a></td><td></td></tr>
			<tr><td><a href="../documents/Root_WePub/ANSFI/Charts/AD/EFJY/EF_AD_2_EFJY_30_ILSZ.pdf">ILS Z or LOC Z RWY 30</a></td><td></td></tr>
			<tr><td><a href="../documents/Root_WePub/ANSFI/Charts/AD/EFJY/EF_AD_2_EFJY_VAC.pdf">VAC</a></td><td></td></tr>
			<tr><td><a href="../documents/Root_WePub/ANSFI/Charts/AD/EFJY/EF_AD_2_EFJY_FAS_DB.pdf">FAS DATA BLOCK</a></td><td></td></tr>
			<tr><td>EFJY AD 2.25 VISUAL SEGMENT SURFACE (VSS) PENETRATIONS</td></tr></table>`,
			"https://www.ais.fi/eaip/06%20AUG%202026_2026_08_06/eAIP/EF-AD%202%20EFJY%20-%20JYV%C3%84SKYL%C3%84%201-en-GB.html",
			"ADC|ADC|https://www.ais.fi/eaip/06%20AUG%202026_2026_08_06/documents/Root_WePub/ANSFI/Charts/AD/EFJY/EF_AD_2_EFJY_ADC.pdf\n" +
				"IAC|ILS Z or LOC Z RWY 30|https://www.ais.fi/eaip/06%20AUG%202026_2026_08_06/documents/Root_WePub/ANSFI/Charts/AD/EFJY/EF_AD_2_EFJY_30_ILSZ.pdf\n" +
				"VAC|VAC|https://www.ais.fi/eaip/06%20AUG%202026_2026_08_06/documents/Root_WePub/ANSFI/Charts/AD/EFJY/EF_AD_2_EFJY_VAC.pdf\n" +
				"DATA|FAS DATA BLOCK|https://www.ais.fi/eaip/06%20AUG%202026_2026_08_06/documents/Root_WePub/ANSFI/Charts/AD/EFJY/EF_AD_2_EFJY_FAS_DB.pdf",
		},
	}
	cases = append(cases, struct{ name, page, url, want string }{
		// KANS: the table lists titles and page references only, and each
		// chart follows in a row of its own, a heading and its link.
		"Kosovo",
		`<table><tr><td>BKPR AD 2.24 CHARTS RELATED TO AN AERODROME</td></tr></table>
		<table><tr><td>Aerodrome, Heliport Chart - ICAO</td><td>BKPR AD 2.24-17</td></tr>
		<tr><td>IAC VOR-DME RWY 17</td><td>BKPR AD 2.24-53</td></tr></table>
		<table><tr><td><h3><span>AERODROME_HELIPORT_CHART_ICAO</span> <a href="../documents/Root_WePub/Charts/AD/BKPR AD 2/AERODROME_HELIPORT_CHART_ICAO.pdf"><img src="x.png"/></a></h3></td></tr>
		<tr><td><h3><span>IAC_VOR_DME_RWY17</span> <a href="../documents/Root_WePub/Charts/AD/BKPR AD 2/IAC_VOR_DME_RWY17.pdf"><img src="x.png"/></a></h3></td></tr>
		<tr><td>BKPR AD 2.25 VISUAL SEGMENT SURFACE</td></tr></table>`,
		"https://kans-ks.org/eAIP/AIRAC%20AMDT%2009-2026_2026_09_03/eAIP/BK-AD%202%20BKPR-en-GB.html",
		"ADC|AERODROME HELIPORT CHART ICAO|https://kans-ks.org/eAIP/AIRAC%20AMDT%2009-2026_2026_09_03/documents/Root_WePub/Charts/AD/BKPR%20AD%202/AERODROME_HELIPORT_CHART_ICAO.pdf\n" +
			"IAC|IAC VOR DME RWY17|https://kans-ks.org/eAIP/AIRAC%20AMDT%2009-2026_2026_09_03/documents/Root_WePub/Charts/AD/BKPR%20AD%202/IAC_VOR_DME_RWY17.pdf",
	})
	cases = append(cases, struct{ name, page, url, want string }{
		// Slovenia Control: the page reference spans the title row and the
		// link row, the title beside it.
		"Slovenia",
		`<h4><span>LJCE AD 2.24</span> Charts related to an aerodrome</h4><table>
		<tr><td rowspan="2">LJCE AD 2.24.01-1</td><td>Aerodrome Chart - ICAO</td></tr>
		<tr><td><a href="../../graphics/eAIP/LJ_AD_2_LJCE_01-1_en.pdf">../graphics/eAIP/LJ_AD_2_LJCE_01-1_en.pdf</a></td></tr>
		</table>`,
		"https://aim.sloveniacontrol.si/aim/eAIP/Operations/2026-09-03-AIRAC/html/eAIP/LJ-AD-2.LJCE-en-GB.html",
		"ADC|Aerodrome Chart - ICAO|https://aim.sloveniacontrol.si/aim/eAIP/Operations/2026-09-03-AIRAC/graphics/eAIP/LJ_AD_2_LJCE_01-1_en.pdf",
	})
	cases = append(cases, struct{ name, page, url, want string }{
		// LFV: the table, then the chart sections, which point a field at a
		// chart another aerodrome publishes, the link either the title or
		// the whole sentence, the page it names left outside.
		"Sweden",
		`<table><tr><td><h3>ESCM AD 2.24 AERONAUTICAL CHARTS RELATED TO AN AERODROME</h3></td></tr>
		<tr><td><table><thead><tr><th>Charts</th><th>Pages</th></tr></thead>
		<tr><td>VAC - ICAO</td><td><a class="ulink" href="../documents/Root/SWEDEN/Charts/AD/ESCM/9. VAC/ESCM VAC.pdf"><img src="../images/application_pdf.png"/></a></td></tr>
		</table></td></tr>
		<tr><td><h3>AREA CHART</h3></td></tr>
		<tr><td><div>See <a class="link" href="../documents/Root/SWEDEN/Charts/AD/ESSA/5. Area chart/ESSA Area Chart.pdf">Area Chart - ICAO STOCKHOLM TMA</a> (ESSA STOCKHOLM-ARLANDA 5) </div></td></tr>
		<tr><td><div><a class="link" href="../documents/Root/SWEDEN/Charts/AD/ESGG/5. Area Chart/ESGG Area Chart.pdf">See ESGG Area Chart - ICAO GÖTEBORG TMA</a> (ESGG GÖTEBORG-LANDVETTER 5) </div></td></tr>
		</table>`,
		"https://aro.lfv.se/content/eaip/AIP%20AMDT%201-2026_2026_08_07/eAIP/ES-AD%202%20ESCM%20UPPSALA%201-en-GB.html",
		"VAC|VAC - ICAO|https://aro.lfv.se/content/eaip/AIP%20AMDT%201-2026_2026_08_07/documents/Root/SWEDEN/Charts/AD/ESCM/9.%20VAC/ESCM%20VAC.pdf\n" +
			"ARC|Area Chart - ICAO STOCKHOLM TMA|https://aro.lfv.se/content/eaip/AIP%20AMDT%201-2026_2026_08_07/documents/Root/SWEDEN/Charts/AD/ESSA/5.%20Area%20chart/ESSA%20Area%20Chart.pdf\n" +
			"ARC|ESGG Area Chart - ICAO GÖTEBORG TMA|https://aro.lfv.se/content/eaip/AIP%20AMDT%201-2026_2026_08_07/documents/Root/SWEDEN/Charts/AD/ESGG/5.%20Area%20Chart/ESGG%20Area%20Chart.pdf",
	})
	cases = append(cases, struct{ name, page, url, want string }{
		// PANSA's AIP VFR: an AD 4 page, its charts section 4.13; a contents
		// line naming it first is closed by the next AD 4 subsection, whose
		// own link is no chart.
		"Poland VFR",
		`<table><tr><td>EPBA AD 4.13 CHARTS RELATED TO THE AERODROME</td></tr>
		<tr><td><h3>EPBA AD 4.10 VFR DEPARTURE AND ARRIVAL POINTS (ROUTES)</h3></td></tr>
		<tr><td>Procedures</td><td><a href="../documents/procedures.pdf">x</a></td></tr>
		<tr><td><h3>EPBA AD 4.13 CHARTS RELATED TO THE AERODROME</h3></td></tr>
		<tr><td><table><thead><tr><th>Charts</th><th>Pages</th></tr></thead>
		<tr><td>EPBA - AERODROME CHART</td><td><a href="../documents/Root_WePub/AIP VFR/AD/EPBA/2/AD_4_EPBA_2-1.pdf"><img src="../images/application_pdf.png"/></a></td></tr>
		<tr><td>EPBA - VISUAL OPERATION CHART (1: 50 000)</td><td><a href="../documents/Root_WePub/AIP VFR/AD/EPBA/3/AD_4_EPBA_3-1.pdf"><img src="../images/application_pdf.png"/></a></td></tr>
		</table></td></tr></table>`,
		"https://docs.pansa.pl/ais/eaipvfr/AIRAC%20AMDT%20VFR%2009-26_2026_09_03/eAIP/AD%204%20EPBA%201-en-GB.html",
		"ADC|EPBA - AERODROME CHART|https://docs.pansa.pl/ais/eaipvfr/AIRAC%20AMDT%20VFR%2009-26_2026_09_03/documents/Root_WePub/AIP%20VFR/AD/EPBA/2/AD_4_EPBA_2-1.pdf\n" +
			"VAC|EPBA - VISUAL OPERATION CHART (1: 50 000)|https://docs.pansa.pl/ais/eaipvfr/AIRAC%20AMDT%20VFR%2009-26_2026_09_03/documents/Root_WePub/AIP%20VFR/AD/EPBA/3/AD_4_EPBA_3-1.pdf",
	})
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := chartSummary(chartsOf(t, c.page, c.url)); got != c.want {
				t.Errorf("got\n%s\nwant\n%s", got, c.want)
			}
		})
	}
}

func TestChartFamily(t *testing.T) {
	cases := []struct{ title, file, want string }{
		{"AERODROME CHART - ICAO", "", "ADC"},
		{"AERODROME CHART - ICAO (A380 GROUND MOVEMENT)", "", "ADC"},
		{"Aircraft Parking/Docking Chart - ICAO", "", "APDC"},
		{"ATC SURVEILLANCE MINIMUM ALTITUDE CHART - ICAO", "", "ATCSMAC"},
		{"ATC SMAC", "", "ATCSMAC"},
		{"ATC Surveillnace Minimum Altitude Chart - ICAO", "", "ATCSMAC"},
		{"Standard Departure Chart - Instrument (SID) - ICAO", "", "SID"},
		{"RNAV STAR RWY 12", "", "STAR"},
		// ROMATSA's, which carry the RNAV the approach rule reads.
		{"RNAV Departure Chart RWY 27- ICAO", "", "SID"},
		{"RNAV Arrival Chart RWY 09 - ICAO", "", "STAR"},
		{"Visual Operations Chart - RWY 07/25 Aerodrome traffic circuit", "", "VAC"},
		{"INSTRUMENT APPROACH CHART RNP RWY 07 - ICAO", "", "IAC"},
		{"RNP RWY 30", "", "IAC"},
		{"VISUAL APPROACH CHART - ICAO", "", "VAC"},
		{"Chart for VFR flights - ICAO", "", "VAC"},
		{"VFR ARRIVAL / DEPARTURE ROUTES", "", "VAC"},
		{"OMNIDIRECTIONAL DEPARTURES", "", "DEP"},
		{"STAR CODING TABLE", "", "DATA"},
		{"WAYPOINTS AND FIXES", "", "DATA"},
		{"Omni-directional Departure RWY 06", "", "DEP"},
		{"Omnidirectional and visual departures chart", "", "DEP"},
		{"AGMC", "", "GMC"},
		{"AD 2-LHBC-AOCA-17L35R", "", "AOC"},
		{"AD 2-LHBP-PDC-1", "", "APDC"},
		{"ATC Surveillance Minimum Chart - ICAO", "", "ATCSMAC"},
		{"TMA chart Møre", "", "ARC"},
		{"BIAR WAYPOINT COORDINATES", "", "DATA"},
		// The file names what the title does not.
		{"Chart 7", "EF_AD_2_EFXX_VAC.pdf", "VAC"},
		{"CONTROL ZONE", "", "MISC"},
		// A word containing an abbreviation is not it.
		{"STARTING PROCEDURES", "", "MISC"},
	}
	for _, c := range cases {
		if got := ChartFamily(c.title, c.file); got != c.want {
			t.Errorf("ChartFamily(%q, %q) = %s, want %s", c.title, c.file, got, c.want)
		}
	}
}
