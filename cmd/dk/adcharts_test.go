package main

import (
	"strings"
	"testing"
)

func TestDkFieldIdent(t *testing.T) {
	for title, want := range map[string]string{
		"Billund - EKBI":                             "EKBI",
		"Ilulissat (BGJN)":                           "BGJN",
		"Heliport Bornholms Hospital - EKRB":         "EKRB",
		"Karup / Midtjyllands Lufthavn - EKKA":       "EKKA",
		"AD 2 - PUBLIC AERODROMES":                   "",
		"AD 1 - AERODROMES_HELIPORTS - INTRODUCTION": "",
		"AD 1.1 Aerodrome and Heliport Availability": "",
	} {
		if got := dkFieldIdent(title); got != want {
			t.Errorf("dkFieldIdent(%q) = %q, want %q", title, got, want)
		}
	}
	if d, err := dkDay("03SEP2026"); err != nil || d.Format("2006-01-02") != "2026-09-03" {
		t.Errorf("dkDay: %v %v", d, err)
	}
}

// The VFR Flight Guide's documents for a field, then the AIP's: the text
// page is the first met, a chart both carry under one file name is kept
// once, and the number, the part and the indicator leave the title.
func TestAddDkField(t *testing.T) {
	href := func(s string) *string { return &s }
	fields := map[string]*dkField{}
	addDkField(fields, "EKBI", false, []dkNode{
		{Title: "01. AD 2 EKBI text", Name: "EK_AD_2_EKBI_en.pdf", Href: href("/media/files/gvq0cb0igw5/EK_AD_2_EKBI_en.pdf")},
		{Title: "02. AD 2 EKBI VAC", Name: "EK_AD_2_EKBI_VAC_en.pdf", Href: href("/media/files/fv0af4lu3cq/EK_AD_2_EKBI_VAC_en.pdf")},
		{Title: "03. AD 2 EKBI ADC", Name: "EK_AD_2_EKBI_ADC_en.pdf", Href: href("/media/files/iffgnmofhe1/EK_AD_2_EKBI_ADC_en.pdf")},
	})
	addDkField(fields, "EKBI", false, []dkNode{
		{Title: "01. EKBI Text", Name: "EK_AD_2_EKBI_en.pdf", Href: href("/media/files/yiuyehpapgz/EK_AD_2_EKBI_en.pdf")},
		{Title: "02. EKBI ADC", Name: "EK_AD_2_EKBI_ADC_en.pdf", Href: href("/media/files/0eib2gvxuq0/EK_AD_2_EKBI_ADC_en.pdf")},
		{Title: "12. EKBI SID (RNAV) RWY 09 - 1", Name: "EK_AD_2_EKBI_SID_RNAV_09_1_en.pdf", Href: href("/media/files/nqmzjzv2yex/EK_AD_2_EKBI_SID_RNAV_09_1_en.pdf")},
	})
	f := fields["EKBI"]
	var got []string
	for _, c := range f.charts {
		got = append(got, c[0]+"|"+c[1]+"|"+c[2])
	}
	want := strings.Join([]string{
		"VAC|VAC|fv0af4lu3cq/EK_AD_2_EKBI_VAC_en.pdf",
		"ADC|ADC|iffgnmofhe1/EK_AD_2_EKBI_ADC_en.pdf",
		"SID|SID (RNAV) RWY 09 - 1|nqmzjzv2yex/EK_AD_2_EKBI_SID_RNAV_09_1_en.pdf",
	}, "\n")
	if f.ad != "gvq0cb0igw5/EK_AD_2_EKBI_en.pdf" || strings.Join(got, "\n") != want {
		t.Errorf("page %q, charts\n%s\nwant\n%s", f.ad, strings.Join(got, "\n"), want)
	}
}
