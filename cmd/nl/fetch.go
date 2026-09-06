// fetch.go pulls the LVNL ArcGIS FeatureServers.
//
// LVNL publishes the Dutch AIP's spatial data as ArcGIS FeatureServers,
// with WFS 2.0 twins, under CC BY 4.0 with no registration. Layer ids are
// stable and each carries one feature kind, so a layer number IS the
// airspace type: the per-layer tables in airspaces.go are the mapping.
//
// The paging shape is the same as cmd/faa's, but the services are
// different tenants with different quotas, so the two keep their own
// fetchers rather than sharing one that would have to be parameterised
// on both.

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"github.com/0intro/loxodrome/internal/overlay"
)

const (
	lvnlRoot = "https://services-eu1.arcgis.com/OtUwzhpKSdeXgRIB/arcgis/rest/services"
	// Well under the service's own maxRecordCount so a page cannot come
	// back truncated for size.
	pageSize = 1000
)

// layerURL is the /query endpoint of one layer of one service.
func layerURL(service string, layer int) string {
	return fmt.Sprintf("%s/%s/FeatureServer/%d/query", lvnlRoot, service, layer)
}

// feature is the slice of a GeoJSON feature the builders need.
type feature struct {
	Geometry   json.RawMessage `json:"geometry"`
	Properties map[string]any  `json:"properties"`
}

type collection struct {
	Features []feature `json:"features"`
}

// fetchLayer downloads one layer whole, paging until the row count the
// service reported is in hand. The count is the terminator rather than a
// short page, for the reason cmd/faa records: a service under load can
// answer short without saying so, and the walk would then stop early and
// yield a quietly truncated layer.
func fetchLayer(ctx context.Context, base string) ([]feature, []byte, error) {
	want, err := layerCount(ctx, base)
	if err != nil {
		return nil, nil, err
	}
	var out []feature
	var raw []byte
	for offset := 0; ; offset += pageSize {
		q := url.Values{}
		q.Set("where", "1=1")
		q.Set("outFields", "*")
		q.Set("f", "geojson")
		q.Set("outSR", "4326")
		q.Set("resultOffset", strconv.Itoa(offset))
		q.Set("resultRecordCount", strconv.Itoa(pageSize))
		body, err := overlay.HTTPGetAll(ctx, base+"?"+q.Encode())
		if err != nil {
			return nil, nil, err
		}
		raw = append(raw, body...)
		var page struct {
			Features []feature `json:"features"`
			Error    *struct {
				Code    int    `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal(body, &page); err != nil {
			return nil, nil, fmt.Errorf("decode page at offset %d: %w", offset, err)
		}
		// An ArcGIS error arrives as HTTP 200 with an error object and no
		// features; undetected it reads as an empty page.
		if page.Error != nil {
			return nil, nil, fmt.Errorf("%s at offset %d: server error %d: %s",
				base, offset, page.Error.Code, page.Error.Message)
		}
		out = append(out, page.Features...)
		if len(out) >= want || len(page.Features) == 0 {
			break
		}
	}
	if len(out) != want {
		return nil, nil, fmt.Errorf("%s: collected %d of %d rows; the layer paged short", base, len(out), want)
	}
	return out, raw, nil
}

func layerCount(ctx context.Context, base string) (int, error) {
	q := url.Values{}
	q.Set("where", "1=1")
	q.Set("returnCountOnly", "true")
	q.Set("f", "json")
	body, err := overlay.HTTPGetAll(ctx, base+"?"+q.Encode())
	if err != nil {
		return 0, err
	}
	var res struct {
		Count *int `json:"count"`
	}
	if err := json.Unmarshal(body, &res); err != nil {
		return 0, fmt.Errorf("decode count: %w", err)
	}
	if res.Count == nil {
		return 0, fmt.Errorf("count absent from %s", base)
	}
	return *res.Count, nil
}

// prop reads a string property, trimmed. ArcGIS nulls decode to nil.
func prop(p map[string]any, key string) string {
	switch v := p[key].(type) {
	case string:
		return strings.TrimSpace(v)
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	}
	return ""
}

// propNum reads a numeric property.
func propNum(p map[string]any, key string) (float64, bool) {
	switch v := p[key].(type) {
	case float64:
		return v, true
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
		return f, err == nil
	}
	return 0, false
}
