// inventory.go lists the aerodrome pages of a package: what ENR reading
// never needed, since an ENR section's file name is derivable and an
// aerodrome's is not (Fintraffic names its pages after the aerodrome,
// "EF-AD 2 EFJY - JYVÄSKYLÄ 1-en-GB.html").
//
// Each generator publishes the list it navigates by. The EUROCONTROL
// package has a menu page, "<CC>-menu-<lang>.html", linking every
// "<CC>-AD-2.<ICAO>-<lang>.html"; IDS AIRNAV has v2/js/datasource.js, a
// JSON menu tree, whose aerodrome entries are titled three different ways
// ("AD 2 EFJY - JYVÄSKYLÄ", " BKPR ", "BI-AD BIAR AKUREYRI - ...") but all
// carry the same child, "<ICAO> AD 2.1 AERODROME LOCATION INDICATOR AND
// NAME", linking the aerodrome's text page. That child is the key, save in
// a VFR package filing its aerodromes as AD 4 (PANSA's AIP VFR), whose
// entry is titled "AD 4 EPBA" and whose children are numbered pages.

package eaip

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strings"
)

// Aerodrome is one aerodrome page a package lists.
type Aerodrome struct {
	ICAO string
	// Section is 2 for an AD 2 aerodrome, 3 for an AD 3 heliport, 4 for
	// an aerodrome a VFR package files as AD 4.
	Section int
	// URL is the aerodrome's text page, absolute.
	URL string
}

// Aerodromes lists the aerodrome pages of a resolved package, sorted by
// ICAO.
func (s *Site) Aerodromes(ctx context.Context, c Cycle) ([]Aerodrome, error) {
	var (
		out []Aerodrome
		err error
	)
	switch s.Family {
	case IDS:
		out, err = s.idsAerodromes(ctx, c)
	default:
		out, err = s.menuAerodromes(ctx, c)
	}
	if err != nil {
		return nil, err
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].ICAO != out[j].ICAO {
			return out[i].ICAO < out[j].ICAO
		}
		return out[i].Section < out[j].Section
	})
	return out, nil
}

// menuPageRe finds an aerodrome page in a EUROCONTROL menu:
// "EI-AD-2.EIWT-en-IE.html", "LZ-AD-3.LZXX-en-SK.html".
var menuPageRe = regexp.MustCompile(`href="([^"#]*?[A-Z]{2}-AD-([23])\.([A-Z0-9]{4})-[a-z]{2}-[A-Z]{2}\.html)`)

func (s *Site) menuAerodromes(ctx context.Context, c Cycle) ([]Aerodrome, error) {
	menu := s.PageURL(c, "menu")
	body, err := s.Get(ctx, menu)
	if err != nil {
		return nil, fmt.Errorf("menu %s: %w", menu, err)
	}
	base, err := url.Parse(menu)
	if err != nil {
		return nil, err
	}
	var out []Aerodrome
	seen := map[string]bool{}
	for _, m := range menuPageRe.FindAllStringSubmatch(string(body), -1) {
		u, err := base.Parse(m[1])
		if err != nil || seen[u.String()] {
			continue
		}
		seen[u.String()] = true
		out = append(out, Aerodrome{ICAO: m[3], Section: int(m[2][0] - '0'), URL: u.String()})
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("menu %s lists no aerodrome page", menu)
	}
	return out, nil
}

// idsAerodromeRe is the child entry that keys an IDS aerodrome: "EFJY AD
// 2.1 AERODROME LOCATION INDICATOR AND NAME", "... AD 3.1 HELIPORT ...",
// and LFV's "ESNX 2.1 AERODROME ...", which drops the AD.
var idsAerodromeRe = regexp.MustCompile(`^\s*([A-Z0-9]{4})\s+(?:AD\s*)?([23])\.1\b`)

// idsAD4Re is the entry a VFR package files an aerodrome under, "AD 4
// EPBA", the entry itself being the key: its children are the page's
// numbered parts (" EPBA 1 ", " EPBA 2 "), not ICAO's items.
var idsAD4Re = regexp.MustCompile(`^\s*AD\s*4\s+([A-Z0-9]{4})\s*$`)

type idsNode struct {
	Title    string    `json:"title"`
	Href     string    `json:"href"`
	Children []idsNode `json:"children"`
}

type idsDatasource struct {
	Tabs []struct {
		Contents map[string]struct {
			Menu []idsNode `json:"menu"`
		} `json:"contents"`
	} `json:"tabs"`
}

func (s *Site) idsAerodromes(ctx context.Context, c Cycle) ([]Aerodrome, error) {
	root := s.PackageRoot(c)
	src := root + "/v2/js/datasource.js"
	body, err := s.Get(ctx, src)
	if err != nil {
		return nil, fmt.Errorf("datasource %s: %w", src, err)
	}
	ds, err := parseIDSDatasource(body)
	if err != nil {
		return nil, fmt.Errorf("datasource %s: %w", src, err)
	}
	lang := c.Lang
	if lang == "" {
		lang = s.Lang
	}
	if lang == "" {
		lang = "en-GB"
	}
	pages, err := url.Parse(root + "/eAIP/")
	if err != nil {
		return nil, err
	}
	var out []Aerodrome
	seen := map[string]bool{}
	var walk func([]idsNode)
	walk = func(nodes []idsNode) {
		for _, n := range nodes {
			title := NormSpace(n.Title)
			m := idsAerodromeRe.FindStringSubmatch(title)
			if m4 := idsAD4Re.FindStringSubmatch(title); m == nil && m4 != nil {
				m = []string{m4[0], m4[1], "4"}
			}
			if m != nil && !seen[m[1]] {
				href := n.Href
				if i := strings.Index(href, "#"); i >= 0 {
					href = href[:i]
				}
				// The file names hold spaces and letters outside ASCII,
				// which a relative reference must carry escaped.
				if u, err := pages.Parse(escapePathSegment(href)); err == nil && href != "" {
					seen[m[1]] = true
					out = append(out, Aerodrome{ICAO: m[1], Section: int(m[2][0] - '0'), URL: u.String()})
				}
			}
			walk(n.Children)
		}
	}
	for _, tab := range ds.Tabs {
		if content, ok := tab.Contents[lang]; ok {
			walk(content.Menu)
			break
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("datasource %s lists no aerodrome in %s", src, lang)
	}
	return out, nil
}

// parseIDSDatasource reads the JSON object datasource.js assigns.
func parseIDSDatasource(body []byte) (idsDatasource, error) {
	var ds idsDatasource
	i := strings.IndexByte(string(body), '{')
	j := strings.LastIndexByte(string(body), '}')
	if i < 0 || j <= i {
		return ds, fmt.Errorf("no JSON object")
	}
	// PANSA's titles carry raw tabs, which JSON forbids inside a string.
	// A control character is whitespace between tokens and a space inside
	// a title, so reading every one as a space changes nothing else.
	obj := []byte(strings.Map(func(r rune) rune {
		if r < 0x20 {
			return ' '
		}
		return r
	}, string(body[i:j+1])))
	// And it is a JavaScript literal, whose lists may close on a comma.
	obj = trailingCommaRe.ReplaceAll(obj, []byte("$1"))
	if err := json.Unmarshal(obj, &ds); err != nil {
		return ds, err
	}
	return ds, nil
}

// trailingCommaRe is a comma closing a JavaScript list or object.
var trailingCommaRe = regexp.MustCompile(`,\s*([\]}])`)

// escapePathSegment escapes a relative file name for a URL reference,
// leaving any path separators as they are.
func escapePathSegment(p string) string {
	parts := strings.Split(p, "/")
	for i, s := range parts {
		parts[i] = url.PathEscape(s)
	}
	return strings.Join(parts, "/")
}
