// listing.go: parse a public SIA SUP AIP listing page into rows. Each table
// row carries "NNN/YYYY <subject>", a "Valide du <from> au <to> IFR VFR
// AIRAC" cell, and a /documents/download/f/d/<N> link that 302-redirects to
// the real lf_sup_*.pdf.

package main

import (
	"bytes"
	"regexp"
	"strconv"
	"strings"

	"golang.org/x/net/html"
)

// listingRow is one supplement as advertised on the listing page (before its
// PDF is fetched and parsed).
type listingRow struct {
	number      int
	year        int
	descFr      string
	validFrom   string // YYYY-MM-DD
	validTo     string
	ifr         bool
	vfr         bool
	airacLabel  bool
	downloadURL string // absolute /documents/download/f/d/<N>
}

var (
	numYearRe = regexp.MustCompile(`(\d{1,3})\s*/\s*(\d{4})`)
	validRe   = regexp.MustCompile(`(\d{4}-\d{2}-\d{2})\s+au\s+(\d{4}-\d{2}-\d{2})`)
	dlRe      = regexp.MustCompile(`/documents/download/f/d/\d+`)
)

// parseListing extracts every supplement row from a listing page. Pure.
func parseListing(data []byte) []listingRow {
	doc, err := html.Parse(bytes.NewReader(data))
	if err != nil {
		return nil
	}
	var rows []listingRow
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode && n.Data == "tr" {
			if r, ok := parseRow(n); ok {
				rows = append(rows, r)
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(doc)
	return rows
}

func parseRow(tr *html.Node) (listingRow, bool) {
	text := nodeText(tr)
	href := findDownload(tr)
	nm := numYearRe.FindStringSubmatch(text)
	if nm == nil || href == "" {
		return listingRow{}, false
	}
	num, _ := strconv.Atoi(nm[1])
	year, _ := strconv.Atoi(nm[2])
	r := listingRow{
		number:      num,
		year:        year,
		descFr:      extractDesc(text, nm[0]),
		ifr:         checkboxChecked(tr, "IFR"),
		vfr:         checkboxChecked(tr, "VFR"),
		airacLabel:  checkboxChecked(tr, "AIRAC"),
		downloadURL: siaHost + href,
	}
	if vm := validRe.FindStringSubmatch(text); vm != nil {
		r.validFrom, r.validTo = vm[1], vm[2]
	}
	return r, true
}

// nodeText returns the whitespace-collapsed text of a subtree.
func nodeText(n *html.Node) string {
	var b strings.Builder
	var rec func(*html.Node)
	rec = func(x *html.Node) {
		if x.Type == html.TextNode {
			b.WriteString(x.Data)
			b.WriteByte(' ')
		}
		for c := x.FirstChild; c != nil; c = c.NextSibling {
			rec(c)
		}
	}
	rec(n)
	return strings.Join(strings.Fields(b.String()), " ")
}

// findDownload returns the first /documents/download/f/d/<N> path in a subtree.
func findDownload(n *html.Node) string {
	var href string
	var rec func(*html.Node)
	rec = func(x *html.Node) {
		if href != "" {
			return
		}
		if x.Type == html.ElementNode && x.Data == "a" {
			for _, a := range x.Attr {
				if a.Key == "href" {
					if m := dlRe.FindString(a.Val); m != "" {
						href = m
						return
					}
				}
			}
		}
		for c := x.FirstChild; c != nil; c = c.NextSibling {
			rec(c)
		}
	}
	rec(n)
	return href
}

// checkboxChecked reports whether the row carries a CHECKED <input> of the
// given name. The listing renders each traffic badge as a checkbox plus its
// own label, so the label text "IFR" / "VFR" is on every row whether the badge
// applies or not; only the checked attribute distinguishes them. Reading the
// row's text instead made both flags true for every supplement.
func checkboxChecked(n *html.Node, name string) bool {
	found := false
	var rec func(*html.Node)
	rec = func(x *html.Node) {
		if found {
			return
		}
		if x.Type == html.ElementNode && x.Data == "input" {
			named, checked := false, false
			for _, a := range x.Attr {
				switch {
				case strings.EqualFold(a.Key, "name"):
					named = strings.EqualFold(a.Val, name)
				case strings.EqualFold(a.Key, "checked"):
					checked = true
				}
			}
			if named && checked {
				found = true
				return
			}
		}
		for c := x.FirstChild; c != nil; c = c.NextSibling {
			rec(c)
		}
	}
	rec(n)
	return found
}

// extractDesc returns the subject text between the "NNN/YYYY" token and the
// "Valide ..." validity clause.
func extractDesc(text, numYear string) string {
	i := strings.Index(text, numYear)
	if i < 0 {
		return ""
	}
	s := text[i+len(numYear):]
	if j := strings.Index(s, "Valide"); j >= 0 {
		s = s[:j]
	}
	return strings.TrimSpace(s)
}

// unescapeListing undoes the PHP-style addslashes escaping the SIA's CMS
// leaves in the listing subjects ("vols d\'aéronefs", ZRT AIRGHT and 18
// sibling rows) — applied TWICE on some of them (044/2026 arrives as
// "d\\'aéronefs"), so any run of backslashes before an apostrophe or double
// quote collapses to the bare character. Only the ASCII apostrophe is
// affected upstream (typographic ones pass clean), no legitimate backslash
// exists in these subjects, and the PDF-sourced texts never carry the
// artifact, so this applies to the listing subject alone. Idempotent, which
// the retained-row merge relies on.
var listingEscapeRe = regexp.MustCompile(`\\+(['"])`)

func unescapeListing(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	return listingEscapeRe.ReplaceAllString(s, "$1")
}
