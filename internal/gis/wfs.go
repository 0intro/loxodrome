// wfs.go reads an OGC Web Feature Service as GeoJSON in WGS84.

package gis

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"github.com/0intro/loxodrome/internal/overlay"
)

// wfsPage is how many features one paged request asks for. LFV's server
// answers a whole feature type in one request (5 832 obstacles), so paging
// is the fallback for a server that caps a response, not the norm.
const wfsPage = 5000

// FetchWFS downloads one feature type whole, as GeoJSON in EPSG:4326
// ([lon, lat] coordinates, the GeoJSON order whatever the CRS name says),
// with the raw response bodies for the source hash.
//
// The server's own totalFeatures is the terminator, so a response a server
// cut short without saying so is paged for the rest, and a type that still
// comes back short is an error rather than a quietly truncated dataset. An
// OWS exception (an unknown typename, a bad parameter) arrives as XML with
// a 200 and would otherwise decode as nothing at all.
func FetchWFS(ctx context.Context, base, typeName string) ([]Feature, []byte, error) {
	var out []Feature
	var raw []byte
	total := -1
	for {
		q := url.Values{}
		q.Set("service", "WFS")
		q.Set("version", "1.1.0")
		q.Set("request", "GetFeature")
		q.Set("typename", typeName)
		q.Set("outputFormat", "application/json")
		q.Set("srsname", "EPSG:4326")
		if total >= 0 {
			q.Set("startIndex", strconv.Itoa(len(out)))
			q.Set("maxFeatures", strconv.Itoa(wfsPage))
		}
		body, err := overlay.HTTPGetAll(ctx, base+"?"+q.Encode())
		if err != nil {
			return nil, nil, err
		}
		raw = append(raw, body...)
		if msg, ok := owsException(body); ok {
			return nil, nil, fmt.Errorf("%s %s: %s", base, typeName, msg)
		}
		var page struct {
			TotalFeatures *int      `json:"totalFeatures"`
			Features      []Feature `json:"features"`
		}
		if err := json.Unmarshal(body, &page); err != nil {
			return nil, nil, fmt.Errorf("%s %s: decode: %w", base, typeName, err)
		}
		out = append(out, page.Features...)
		if total < 0 {
			if page.TotalFeatures == nil {
				// A server that states no total gives nothing to page
				// against: what came back is the type.
				return out, raw, nil
			}
			total = *page.TotalFeatures
		}
		if len(out) >= total || len(page.Features) == 0 {
			break
		}
	}
	if len(out) != total {
		return nil, nil, fmt.Errorf("%s %s: collected %d of %d features; the type paged short", base, typeName, len(out), total)
	}
	return out, raw, nil
}

// owsException reads an OWS ExceptionReport's text, reporting whether the
// body was one.
func owsException(body []byte) (string, bool) {
	trimmed := bytes.TrimSpace(body)
	if !bytes.HasPrefix(trimmed, []byte("<")) {
		return "", false
	}
	var rep struct {
		Exceptions []struct {
			Code    string   `xml:"exceptionCode,attr"`
			Locator string   `xml:"locator,attr"`
			Text    []string `xml:"ExceptionText"`
		} `xml:"Exception"`
	}
	if err := xml.Unmarshal(trimmed, &rep); err != nil || len(rep.Exceptions) == 0 {
		return "the server answered XML, not GeoJSON", true
	}
	e := rep.Exceptions[0]
	return strings.TrimSpace(fmt.Sprintf("%s (%s): %s", e.Code, e.Locator, strings.Join(e.Text, " "))), true
}
