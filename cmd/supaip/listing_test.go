package main

import (
	"strings"
	"testing"
)

// The badges as the SIA actually renders them: a checkbox plus its own label,
// so the words IFR / VFR / AIRAC appear on EVERY row and only the checked
// attribute says which apply. Row 2 carries both labels with only VFR checked,
// which is what distinguishes reading the attribute from reading the text.
const sampleTable = `<table>
<tr>
  <td><img src="x"></td>
  <td>080/2026 Création de Zones Réglementées Temporaires (ZRT) pour l'exercice "LIBECCIU 26"</td>
  <td>Valide du 2026-05-11 au 2026-05-20</td>
  <td>
    <input type="checkbox" name="IFR" disabled checked/><label>IFR</label>
    <input type="checkbox" name="VFR" disabled checked/><label>VFR</label>
    <input type="checkbox" name="AIRAC" disabled checked/><label>AIRAC</label>
  </td>
  <td><a href="https://www.sia.aviation-civile.gouv.fr/documents/download/f/d/1504948/">PDF</a></td>
</tr>
<tr>
  <td><img src="x"></td>
  <td>075/2026 Modification temporaire de l'itinéraire hélicoptères</td>
  <td>Valide du 2026-04-30 au 2026-10-14</td>
  <td>
    <input type="checkbox" name="IFR" disabled/><label>IFR</label>
    <input type="checkbox" name="VFR" disabled checked/><label>VFR</label>
    <input type="checkbox" name="AIRAC" disabled/><label>AIRAC</label>
  </td>
  <td><a href="https://www.sia.aviation-civile.gouv.fr/documents/download/f/d/1504392/">PDF</a></td>
</tr>
<tr><td>header row, no link</td></tr>
</table>`

const sampleListing = `<html><body>` + sampleTable + `</body></html>`

func TestParseListing(t *testing.T) {
	rows := parseListing([]byte(sampleListing))
	if len(rows) != 2 {
		t.Fatalf("got %d rows, want 2", len(rows))
	}

	r := rows[0]
	if r.number != 80 || r.year != 2026 {
		t.Errorf("number/year = %d/%d, want 80/2026", r.number, r.year)
	}
	if r.validFrom != "2026-05-11" || r.validTo != "2026-05-20" {
		t.Errorf("validity = %s..%s", r.validFrom, r.validTo)
	}
	if !r.ifr || !r.vfr || !r.airacLabel {
		t.Errorf("flags ifr=%v vfr=%v airac=%v, want all true", r.ifr, r.vfr, r.airacLabel)
	}
	if r.downloadURL != siaHost+"/documents/download/f/d/1504948" {
		t.Errorf("downloadURL = %q", r.downloadURL)
	}
	if want := `Création de Zones Réglementées Temporaires (ZRT) pour l'exercice "LIBECCIU 26"`; r.descFr != want {
		t.Errorf("descFr = %q, want %q", r.descFr, want)
	}

	// The label is present on row 2 and its box is not checked: reading the
	// row text would call this IFR, which is the bug this pins.
	if rows[1].ifr {
		t.Errorf("row 2 ifr = true, want false (label present, box unchecked)")
	}
	if !rows[1].vfr {
		t.Errorf("row 2 vfr = false, want true (box checked)")
	}
}

// The SIA CMS leaves PHP addslashes escaping in the listing subjects
// (214/2025's ZRT AIRGHT: "au profit de vols d\'aéronefs"); the bare
// characters must reach the dataset, and clean text must pass unchanged so
// re-emitting a retained row stays byte-identical.
func TestUnescapeListing(t *testing.T) {
	cases := map[string]string{
		`vols d\'aéronefs sans équipage`:  `vols d'aéronefs sans équipage`,
		`Création d\'une ZRT d\'essai`:    `Création d'une ZRT d'essai`,
		`dite \"basse hauteur\"`:          `dite "basse hauteur"`,
		`au profit de vols d\\'aéronefs`:  `au profit de vols d'aéronefs`,
		`un anti\\slash reste`:            `un anti\\slash reste`,
		`Création d’une ZRT (ZRT AIRGHT)`: `Création d’une ZRT (ZRT AIRGHT)`,
		``:                                ``,
	}
	for in, want := range cases {
		if got := unescapeListing(in); got != want {
			t.Errorf("%q: got %q, want %q", in, got, want)
		}
	}
	// A trailing lone backslash stays (it escapes nothing).
	if got := unescapeListing(`fin\`); got != `fin\` {
		t.Errorf("trailing: got %q", got)
	}
}

// magentoPage wraps the listing table in the furniture the SIA's CMS stamps
// fresh on EVERY response: a form_key (twice on the real page), a random
// element id on the account link, and the login captcha's timestamp. Hashing
// the page bytes made those three the fingerprint, so the meta reported a
// changed listing on every run and could never report an unchanged one.
func magentoPage(formKey, elemID, captchaTS string) []byte {
	return []byte(`<html><head><script>window.checkout = ` +
		`{"captcha":{"user_login":{"isRequired":false,"timestamp":` + captchaTS + `}}}` +
		`</script></head><body>` +
		`<a href="https://www.sia.aviation-civile.gouv.fr/customer/account/create/" id="` + elemID + `">Créer mon compte</a>` +
		`<input name="form_key" type="hidden" value="` + formKey + `" />` +
		sampleTable +
		`<input name="form_key" type="hidden" value="` + formKey + `" /></body></html>`)
}

// The two pages carry the same supplements and differ only in CMS furniture,
// which is the state the SIA is in on any two consecutive requests.
func TestListingFingerprintIgnoresPageFurniture(t *testing.T) {
	a := magentoPage("d1us7snFmHemPtjw", "id1USAxN7G", "1789853797")
	b := magentoPage("NOYm1YvITWSPmIwW", "idZcfCzAtc", "1789853799")
	if sha(a) == sha(b) {
		t.Fatal("fixture does not reproduce the churn: the two pages hash alike")
	}
	fa, fb := listingFingerprint(parseListing(a)), listingFingerprint(parseListing(b))
	if fa != fb {
		t.Errorf("fingerprint moved on furniture alone:\n  %s\n  %s", fa, fb)
	}
}

// A page that re-orders the same supplements advertises the same thing, and
// Build sorts its own output regardless.
func TestListingFingerprintIgnoresRowOrder(t *testing.T) {
	rows := parseListing([]byte(sampleListing))
	if len(rows) != 2 {
		t.Fatalf("got %d rows, want 2", len(rows))
	}
	if listingFingerprint(rows) != listingFingerprint([]listingRow{rows[1], rows[0]}) {
		t.Error("fingerprint moved on row order alone")
	}
}

// Every advertised field is covered: each of these is a real upstream change.
func TestListingFingerprintTracksContent(t *testing.T) {
	base := listingFingerprint(parseListing([]byte(sampleListing)))
	cases := []struct{ name, from, to string }{
		{"download id", "1504948", "1504949"},
		{"validity", "2026-05-20", "2026-05-21"},
		{"subject", "LIBECCIU 26", "LIBECCIU 27"},
		{"number", "080/2026", "081/2026"},
		{"airac badge", `name="AIRAC" disabled checked/`, `name="AIRAC" disabled/`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			page := strings.Replace(sampleListing, c.from, c.to, 1)
			if page == sampleListing {
				t.Fatalf("fixture does not contain %q", c.from)
			}
			if got := listingFingerprint(parseListing([]byte(page))); got == base {
				t.Errorf("fingerprint unchanged after %s moved", c.name)
			}
		})
	}
}

// A region can legitimately advertise nothing (pac-n and run carry one
// supplement each), so an empty listing has to hash to a value of its own.
func TestListingFingerprintEmpty(t *testing.T) {
	empty := listingFingerprint(nil)
	if empty == "" {
		t.Error("empty listing has no fingerprint")
	}
	if empty == listingFingerprint(parseListing([]byte(sampleListing))) {
		t.Error("empty listing hashes like a populated one")
	}
}
