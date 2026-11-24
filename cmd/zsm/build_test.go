package main

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

// placemarkKML is one placemark in the STAC's schema, its fields those of
// the edition of 1 November 2026.
func placemarkKML(id, code, name string, active int, top, overfly float64, modified, coords string) string {
	return fmt.Sprintf(`<Placemark><ExtendedData><SchemaData schemaUrl="#zsm_tampon">
<SimpleData name="id_zsm_tampon">%s</SimpleData>
<SimpleData name="code_zsm">%s</SimpleData>
<SimpleData name="actif">%d</SimpleData>
<SimpleData name="h_max">%g</SimpleData>
<SimpleData name="h_survol_m">%g</SimpleData>
<SimpleData name="cd_nom">2852</SimpleData>
<SimpleData name="espece">Gypaète barbu</SimpleData>
<SimpleData name="nom_aire">%s</SimpleData>
<SimpleData name="date_modif">%s 00:00:00</SimpleData>
</SchemaData></ExtendedData>
<Polygon><outerBoundaryIs><LinearRing><coordinates>%s</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
`, id, code, active, top, overfly, name, modified, coords)
}

const square = "6.70,44.90 6.80,44.90 6.80,45.00 6.70,45.00 6.70,44.90"

func doc(placemarks ...string) []byte {
	return []byte(`<?xml version="1.0" encoding="utf-8" ?><kml xmlns="http://www.opengis.net/kml/2.2"><Document id="root_doc"><Folder><name>zsm</name>` +
		strings.Join(placemarks, "") + `</Folder></Document></kml>`)
}

func TestParseKML(t *testing.T) {
	zones, err := parseKML(doc(
		placemarkKML("5991", "ZSM C-05 SEC 1375 | N-27-0000288 | Le Rompeau - (5991)", "Le Rompeau", 1, 2110, 3110, "2026/10/31", square),
		placemarkKML("3051", "ZSM C-65 SEC 078 | F2 - Génos / Coume de Rougnoude - (3051)", "", 0, 2335, 3335, "2026/10/30", square),
	))
	if err != nil {
		t.Fatal(err)
	}
	if len(zones) != 2 {
		t.Fatalf("parseKML: %d zones, want 2", len(zones))
	}
	z := zones[0]
	if z.id != "zsm:5991" || z.name != "Le Rompeau" || !z.active || z.topM != 2110 || z.overflyM != 3110 || z.modified != "2026-10-31" || z.species != "Gypaète barbu" || z.taxon != "2852" {
		t.Errorf("parseKML first zone = %+v", z)
	}
	if got := z.ring[1]; got != [2]float64{44.90, 6.80} {
		t.Errorf("parseKML ring[1] = %v, want [lat lon] [44.9 6.8]", got)
	}
	if got := zones[1].name; got != "F2 - Génos / Coume de Rougnoude" {
		t.Errorf("unnamed zone's name = %q, want the code's last part", got)
	}
	if zones[1].active {
		t.Errorf("actif 0 read active")
	}
}

func TestParseKMLRefusesOtherGeometry(t *testing.T) {
	hole := strings.Replace(placemarkKML("1", "c", "n", 1, 1, 2, "2026/10/31", square),
		"</outerBoundaryIs>", "</outerBoundaryIs><innerBoundaryIs><LinearRing><coordinates>"+square+"</coordinates></LinearRing></innerBoundaryIs>", 1)
	if _, err := parseKML(doc(hole)); err == nil {
		t.Errorf("parseKML read a zone with a hole")
	}
	multi := strings.Replace(strings.Replace(placemarkKML("2", "c", "n", 1, 1, 2, "2026/10/31", square), "<Polygon>", "<MultiGeometry><Polygon>", 1), "</Polygon>", "</Polygon></MultiGeometry>", 1)
	if _, err := parseKML(doc(multi)); err == nil {
		t.Errorf("parseKML read a multi-part zone")
	}
}

func TestBuild(t *testing.T) {
	var pms []string
	for i := 30; i > 0; i-- {
		pms = append(pms, placemarkKML(fmt.Sprintf("%02d", i), "c | z - (1)", fmt.Sprintf("Z%d", i), i%2, 1000, 2000, fmt.Sprintf("2026/10/%02d", i), square))
	}
	now := func() time.Time { return time.Date(2026, 11, 23, 12, 0, 0, 0, time.UTC) }
	art, meta, err := build([]source{{url: "u.kml", body: doc(pms...)}}, "", now)
	if err != nil {
		t.Fatal(err)
	}
	if meta.ZoneCount != 30 || meta.ActiveCount != 15 || meta.Species["Gypaète barbu"] != 30 {
		t.Errorf("build meta = %+v", meta)
	}
	if meta.Edition != "2026-10-30" {
		t.Errorf("edition = %q, want the newest date_modif 2026-10-30", meta.Edition)
	}
	if got := art.Rows[0][0]; got != "zsm:01" {
		t.Errorf("first row id = %v, want rows sorted by id", got)
	}
	if strings.Join(art.Fields, ",") != "id,name,species,taxon,active,topM,overflyM,modified,ring" {
		t.Errorf("fields = %v", art.Fields)
	}
	if len(meta.BBox) != 4 || meta.BBox[0] != 6.7 || meta.BBox[3] != 45 {
		t.Errorf("bbox = %v", meta.BBox)
	}
	if _, _, err := build([]source{{url: "u.kml", body: doc(pms[:3]...)}}, "", now); err == nil {
		t.Errorf("build took 3 zones, under the sanity window")
	}
}

func TestPage(t *testing.T) {
	page := []byte(`<p>Téléchargement du fichier KML édité le 1<sup>er</sup> novembre 2026 : <a href="/sites/default/files/zsm_tampon__kml__11__2026__gbeut.kml">zsm_tampon__kml__11__2026__gbeut.kml</a> .</p>
<a href="/sites/default/files/zsm_tampon__kml__11__2026__gbeut.kml">again</a><a href="/sites/default/files/principe_zsm_13-10-25.pdf">principes</a>`)
	links := kmlLinks(page, "https://www.stac.aviation-civile.gouv.fr/fr/zsm")
	want := "https://www.stac.aviation-civile.gouv.fr/sites/default/files/zsm_tampon__kml__11__2026__gbeut.kml"
	if len(links) != 1 || links[0] != want {
		t.Errorf("kmlLinks = %v, want [%s]", links, want)
	}
	if got := editionDate(page); got != "2026-11-01" {
		t.Errorf("editionDate = %q, want 2026-11-01", got)
	}
	if got := editionDate([]byte("<p>Mise à jour le 2 nov 2026</p>")); got != "" {
		t.Errorf("editionDate without an edition = %q, want empty", got)
	}
}
