package gis

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
)

// A server that caps a response is paged for the rest, against its own
// total; an OWS exception is an error, never an empty type.
func TestFetchWFS(t *testing.T) {
	const total = 7
	feature := func(i int) string {
		return fmt.Sprintf(`{"type":"Feature","geometry":{"type":"Point","coordinates":[18.0,%d.5]},"properties":{"N":%d}}`, 59+i, i)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/wfs", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("typename") == "bad" {
			_, _ = w.Write([]byte(`<?xml version="1.0"?><ows:ExceptionReport xmlns:ows="http://www.opengis.net/ows"><ows:Exception exceptionCode="InvalidParameterValue" locator="typeName"><ows:ExceptionText>Feature type bad unknown</ows:ExceptionText></ows:Exception></ows:ExceptionReport>`))
			return
		}
		start, _ := strconv.Atoi(r.URL.Query().Get("startIndex"))
		limit := 3 // the server caps every response at three
		body := `{"type":"FeatureCollection","totalFeatures":7,"features":[`
		for i := start; i < start+limit && i < total; i++ {
			if i > start {
				body += ","
			}
			body += feature(i)
		}
		_, _ = w.Write([]byte(body + "]}"))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	feats, _, err := FetchWFS(context.Background(), srv.URL+"/wfs", "mais:OBSE")
	if err != nil {
		t.Fatal(err)
	}
	if len(feats) != total {
		t.Fatalf("got %d features, want %d", len(feats), total)
	}
	for i, f := range feats {
		if n, _ := PropNum(f.Properties, "N"); int(n) != i {
			t.Errorf("feature %d carries N=%v", i, n)
		}
		lat, lon, ok := Point(f.Geometry)
		if !ok || lon != 18 || lat != float64(59+i)+0.5 {
			t.Errorf("feature %d at (%v, %v)", i, lat, lon)
		}
	}

	if _, _, err := FetchWFS(context.Background(), srv.URL+"/wfs", "bad"); err == nil {
		t.Error("an OWS exception was read as an empty type")
	}
}
