package main

import (
	"strings"
	"testing"
	"time"
)

// The landing page as ANS CR prints it, 2026-09-24: the edition in force
// under actual/ (its date and label broken over lines), the next under
// its dated directory, each in both languages.
const manualLanding = `<div id="verze">
<div><a href="actual/gen_1_en.html" onclick="javascript: window.location=this.getAttribute('href');">17 SEP 2026 (1)
               <span> &ndash; CURRENT</span></a><a href="actual/20260917_1.zip" class="download"></a></div>
<div><a href="20261001_1/gen_1_en.html" onclick="javascript: window.location=this.getAttribute('href');">1 OCT 2026 (1)<span> &ndash; HTML</span></a>
<a href="20261001_1/pdf/amdt_en.pdf">1 OCT 2026 (1)<span> &ndash; PDF</span></a></div>
<div><a href="20261029_2/gen_1_cz.html">29 OCT 2026 (2)<span> &ndash; HTML</span></a></div>
</div>`

func TestManualEditions(t *testing.T) {
	eds := manualEditions(manualLanding, "en")
	var got []string
	for _, e := range eds {
		got = append(got, e.dir+"="+e.label+"@"+e.day.Format("2006-01-02"))
	}
	if want := "actual=17 SEP 2026 (1)@2026-09-17 20261001_1=1 OCT 2026 (1)@2026-10-01"; strings.Join(got, " ") != want {
		t.Fatalf("editions %q, want %q", strings.Join(got, " "), want)
	}
	now := time.Date(2026, 9, 24, 12, 0, 0, 0, time.UTC)
	if dir, label := pickManualEdition(eds, now, false); dir != "actual" || label != "17 SEP 2026 (1)" {
		t.Errorf("current: %s %s", dir, label)
	}
	if dir, _ := pickManualEdition(eds, now, true); dir != "20261001_1" {
		t.Errorf("next: %s", dir)
	}
	// On its own day an edition is in force, so no next remains.
	if dir, _ := pickManualEdition(eds, time.Date(2026, 10, 1, 6, 0, 0, 0, time.UTC), true); dir != "" {
		t.Errorf("next on the day: %s", dir)
	}
}

// The menu every page carries, in three parts: aerodromes under their
// ICAO indicator, the SLZ fields under longer local codes an airport row
// cannot carry, the heliports under theirs.
func TestManualAerodromes(t *testing.T) {
	menu := `<li><a href="enr_1_en.html">VFR-ENR <span>En route</span></a></li>
<li><a href="lkbe_text_en.html">VFR-AD <span>Aerodromes</span></a><ul>
<li><a href="ad_1_en.html">VFR-AD-1 <span>Aerodromes and SLZ fields - general</span></a></li>
<li><a href="lkbu_text_en.html">LKBU <span>Bubovice</span></a></li>
<li><a href="lkbe_text_en.html">LKBE <span>Benešov</span></a></li></ul></li>
<li><a href="lkbore_text_en.html">VFR-SLZ <span>SLZ fields</span></a><ul>
<li><a href="lkbole_text_en.html">LKBOLE <span>Boleradice</span></a></li></ul></li>
<li><a href="hel_1_en.html">VFR-HEL <span>Heliports</span></a><ul>
<li><a href="hel_1_en.html">VFR-HEL-1 <span>Heliports</span></a></li>
<li><a href="lkbd_text_en.html">LKBD <span>Brodek u Přerova</span></a></li>
<li><a href="lkbu_text_cz.html">LKBU</a></li></ul></li>`
	var got []string
	for _, f := range manualAerodromes(menu, "en") {
		got = append(got, f.code+":"+string(rune('0'+f.section)))
	}
	if strings.Join(got, " ") != "lkbd:3 lkbe:4 lkbu:4" {
		t.Errorf("fields %q", strings.Join(got, " "))
	}
}

// An aerodrome page: the "Charts" PDF beside the text one, titled by the
// tabs of its chart view, the overview map and the zoom buttons being no
// sheet.
func TestManualCharts(t *testing.T) {
	page := `<div id="iconsmenu"><a href="pdf/ad-lkvo_map_en.pdf"><img src="design/pdfprint.png" alt="">Charts</a><a href="pdf/ad-lkvo_text_en.pdf"><img src="design/pdfprint.png" alt="">Text</a></div>
<div id="chartview"><div id="vfrc-chart" class="chart"><img src="ad/lkvo_voc.jpg" alt="VOC" onError="this.src='ad/error.jpg';"></div>
<div id="adc-chart" class="chart"><img src="ad/lkvo_adc.jpg" alt="ADC"></div>
<div id="pdc-chart" class="chart"><img src="ad/lkvo_pdc.jpg" alt="PDC"></div>
<a href="#"><img src="design/zoomin.png" alt="Zoom in"></a><img src="ad/prehledove_mapky/lkvo.png" alt=""></div>`
	c, ok := manualCharts(page, "https://aim.rlp.cz/vfrmanual/actual/lkvo_text_en.html")
	if !ok {
		t.Fatal("no chart read")
	}
	if got := c.Code + "|" + c.Title + "|" + c.URL; got != "VAC|VOC, ADC, PDC|https://aim.rlp.cz/vfrmanual/actual/pdf/ad-lkvo_map_en.pdf" {
		t.Errorf("chart %q", got)
	}
	// A heliport's one PDF of text and sheets.
	c, ok = manualCharts(`<a href="pdf/LKBD_en.pdf"><img src="design/pdfprint.png" alt="">PDF/Print</a>
<div id="chartview"><img src="ad/lkbd_voc.jpg" alt="VOC"><img src="ad/lkbd_adc.jpg" alt="ADC"></div>`,
		"https://aim.rlp.cz/vfrmanual/actual/lkbd_text_en.html")
	if got := c.Code + "|" + c.Title + "|" + c.URL; !ok || got != "VAC|VOC, ADC|https://aim.rlp.cz/vfrmanual/actual/pdf/LKBD_en.pdf" {
		t.Errorf("heliport %q", got)
	}
	// A page naming no sheet keeps its PDF, and guesses no family.
	c, ok = manualCharts(`<a href="pdf/ad-lkxx_map_en.pdf">Charts</a>`, "https://aim.rlp.cz/vfrmanual/actual/lkxx_text_en.html")
	if !ok || c.Code != "MISC" || c.Title != "Charts" {
		t.Errorf("unnamed sheets: %+v %v", c, ok)
	}
	if _, ok := manualCharts(`<p>no charts</p>`, "https://aim.rlp.cz/vfrmanual/actual/lkxx_text_en.html"); ok {
		t.Error("a page with no charts PDF read one")
	}
}
