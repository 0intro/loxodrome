package main

import (
	"strings"
	"testing"
)

// An excerpt of the viewer page as ENAIRE prints it, 2026-09-24: the
// edition line, a GEN section that is no field, a field with its data
// row, its obstacle list and charts (one with a two-token code), a shared
// entry serving two fields, an entry whose data is a PDF alone, and a
// heliport.
const esViewerExcerpt = `<html><body>
<div id="actualizado" class="actualizado"> <!-- Parte generada automaticamente WEF !--> 03-SEP-26 (Incorporados AIRAC 08/26 and AMDT 410/26)<!-- FIN !--> </div>
<a id="GEN 0" class="anclaSeccion noPadding" migapan = "<a href='#AIP'>AIP</a> / <a href='#GEN'>GEN</a> / <a href='#GEN 0'>GEN 0</a>"></a>
<table class="enlaces"><tr class="undefined"><td class="id" onclick="openEnlace('contenido_AIP/GEN/LE_GEN_0_1_en.html');">GEN 0.1</td><td class="desc">Preface.</td><td class="iconos"><a href="contenido_AIP/GEN/LE_GEN_0_1_en.pdf" title="pdf"></a></td></tr></table>
<a id="LEAB" class="anclaSeccion noPadding" migapan = "<a href='#AIP'>AIP</a> / <a href='#AD'>AD</a> / <a href='#AD 2'>AD 2</a> / <a href='#LEAB'>LEAB</a>"></a>
<div class="seccionAIPTítulo"><h1 class="conDetalle">LEAB</h1><h2 class="conDescripcion">ALBACETE</h2></div>
<table class="enlaces">
<tr class="undefined"><td class="id" onclick="openEnlace('contenido_AIP/AD/AD2/LEAB/LE_AD_2_LEAB_en.html');">AD 2 LEAB</td><td class="CM"></td><td class="desc" colspan=1>Aerodrome data.</td><td class="iconos"><a href="contenido_AIP/AD/AD2/LEAB/LE_AD_2_LEAB_en.html" title="html"></a><a href="contenido_AIP/AD/AD2/LEAB/LE_AD_2_LEAB_en.pdf" title="pdf"></a></td></tr>
<tr class="undefined"><td class="id" onclick="openEnlace('contenido_AIP/AD/AD2/LEAB/LE_AD_2_10_LEAB_en.html');">AD 2 10 LEAB</td><td class="desc">Item 10: AERODROME OBSTACLES.</td><td class="iconos"><a href="contenido_AIP/AD/AD2/LEAB/LE_AD_2_10_LEAB_en.html" title="html"></a></td></tr>
<tr class="undefined"><td class="id" onclick="openEnlace('contenido_AIP/AD/AD2/LEAB/LE_AD_2_LEAB_ADC_1_en.pdf');">AD 2 LEAB ADC 1</td><td class="CM"></td><td class="desc" colspan=1>ADC 1</td><td class="iconos"><i class="fas fa-file-vacio"></i><a href="contenido_AIP/AD/AD2/LEAB/LE_AD_2_LEAB_ADC_1_en.pdf" target="_blank" title="pdf"></a></td></tr>
<tr class="undefined"><td class="id" onclick="openEnlace('contenido_AIP/AD/AD2/LEAB/LE_AD_2_LEAB_ARR_DEP_1_en.pdf');">AD 2 LEAB ARR DEP 1</td><td class="desc">ARR/DEP 1 - RWY 09 / 27</td><td class="iconos"><a href="contenido_AIP/AD/AD2/LEAB/LE_AD_2_LEAB_ARR_DEP_1_en.pdf" title="pdf"></a></td></tr>
<tr class="undefined"><td class="id" onclick="openEnlace('contenido_AIP/AD/AD2/LEAB/LE_AD_2_LEAB_VAC_1_en.html');">AD 2 LEAB VAC 1</td><td class="desc">VAC 1</td><td class="iconos"><a href="contenido_AIP/AD/AD2/LEAB/LE_AD_2_LEAB_VAC_1_en.html" title="html"></a><a href="contenido_AIP/AD/AD2/LEAB/LE_AD_2_LEAB_VAC_1_en.pdf" title="pdf"></a></td></tr>
</table>
<a id="LECU/LEVS" class="anclaSeccion noPadding" migapan = "<a href='#AIP'>AIP</a> / <a href='#AD'>AD</a> / <a href='#AD 2'>AD 2</a> / <a href='#LECU/LEVS'>LECU/LEVS</a>"></a>
<table class="enlaces">
<tr class="undefined"><td class="id">AD 2 LECU LEVS</td><td class="desc">Aerodrome data.</td><td class="iconos"><a href="contenido_AIP/AD/AD2/LECU_LEVS/LE_AD_2_LECU_LEVS_en.html" title="html"></a></td></tr>
<tr class="undefined"><td class="id">AD 2 LECU LEVS GMC 1.1</td><td class="desc">GMC 1.1 - WEST</td><td class="iconos"><a href="contenido_AIP/AD/AD2/LECU_LEVS/LE_AD_2_LECU_LEVS_GMC_1_1_en.pdf" title="pdf"></a></td></tr>
</table>
<a id="LXGB" class="anclaSeccion noPadding" migapan = "<a href='#AIP'>AIP</a> / <a href='#AD'>AD</a> / <a href='#AD 2'>AD 2</a> / <a href='#LXGB'>LXGB</a>"></a>
<table class="enlaces">
<tr class="undefined"><td class="id">AD 2 LXGB</td><td class="desc">Aerodrome data.</td><td class="iconos"><i class="fas fa-file-vacio"></i><a href="contenido_AIP/AD/AD2/LXGB/LE_AD_2_LXGB_en.pdf" title="pdf"></a></td></tr>
</table>
<a id="AD 3" class="anclaSeccion noPadding" migapan = "<a href='#AIP'>AIP</a> / <a href='#AD'>AD</a> / <a href='#AD 3'>AD 3</a>"></a>
<a id="LEAG" class="anclaSeccion noPadding" migapan = "<a href='#AIP'>AIP</a> / <a href='#AD'>AD</a> / <a href='#AD 3'>AD 3</a> / <a href='#LEAG'>LEAG</a>"></a>
<table class="enlaces">
<tr class="undefined"><td class="id">AD 3 LEAG HELC 1</td><td class="desc">HELC 1</td><td class="iconos"><a href="contenido_AIP/AD/AD3/LEAG/LE_AD_3_LEAG_HELC_1_en.pdf" title="pdf"></a></td></tr>
</table>
</body></html>`

func TestParseEsViewer(t *testing.T) {
	fields, effective, edition, err := parseEsViewer([]byte(esViewerExcerpt))
	if err != nil {
		t.Fatal(err)
	}
	if effective != "2026-09-03T00:00:00.000Z" || edition != "AIRAC 08/26 and AMDT 410/26" {
		t.Errorf("edition %q %q", effective, edition)
	}
	var got []string
	for _, f := range fields {
		line := strings.Join(f.idents, "/") + " AD " + string(rune('0'+f.part))
		if f.ad != "" {
			line += " " + f.ad
		}
		for _, c := range f.charts {
			line += "\n  " + c[0] + "|" + c[1] + "|" + c[2]
		}
		got = append(got, line)
	}
	want := `LEAB AD 2 contenido_AIP/AD/AD2/LEAB/LE_AD_2_LEAB_en.html
  ADC|ADC 1|contenido_AIP/AD/AD2/LEAB/LE_AD_2_LEAB_ADC_1_en.pdf
  MISC|ARR/DEP 1 - RWY 09 / 27|contenido_AIP/AD/AD2/LEAB/LE_AD_2_LEAB_ARR_DEP_1_en.pdf
  VAC|VAC 1|contenido_AIP/AD/AD2/LEAB/LE_AD_2_LEAB_VAC_1_en.pdf
LECU/LEVS AD 2 contenido_AIP/AD/AD2/LECU_LEVS/LE_AD_2_LECU_LEVS_en.html
  GMC|GMC 1.1 - WEST|contenido_AIP/AD/AD2/LECU_LEVS/LE_AD_2_LECU_LEVS_GMC_1_1_en.pdf
LXGB AD 2 contenido_AIP/AD/AD2/LXGB/LE_AD_2_LXGB_en.pdf
LEAG AD 3
  ADC|HELC 1|contenido_AIP/AD/AD3/LEAG/LE_AD_3_LEAG_HELC_1_en.pdf`
	if strings.Join(got, "\n") != want {
		t.Errorf("got\n%s\nwant\n%s", strings.Join(got, "\n"), want)
	}
}
