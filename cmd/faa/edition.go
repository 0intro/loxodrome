// edition.go decides which AIRAC slot a US dataset belongs in.
//
// The FAA gives us both cycles for free, but not symmetrically:
//
//   - the edition DATES come from the APRA API, which answers the
//     current and next 28-day subscription dates directly;
//   - the next cycle's CONTENT comes from the hub's Pending_* layers,
//     which are published during the FAA's pre-release window and then
//     left in place, going stale, until the next one opens.
//
// So a Pending_* layer is only the next cycle while its own edit stamp
// is at or past the current effective date. Measured on 14 August 2026,
// Pending_Class_Airspace's lastEditDate was 16 July, older than the live
// Class_Airspace's 6 August, because it still held the pre-release of
// the cycle that had since become current. Writing it to the .next slot
// then would republish the current cycle as if it were the next one.
//
// The rule below is the same fail-soft shape cmd/de applies to the DFS
// Amdt 1 tree: build the next slot when the pre-release is genuinely
// ahead, and say so and skip when it is not.

package main

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/overlay"
)

const apraChartURL = "https://external-api.faa.gov/apra/nfdc/nasr/chart"

// Edition is one NASR 28-day subscription edition.
type Edition struct {
	// Effective is the ISO-8601 UTC midnight of the edition date, the
	// form aip.ResolveTarget and the SPA slot picker both read.
	Effective string
	// Date is the edition day itself.
	Date time.Time
}

// fetchEdition asks the APRA API for the current or next NASR edition.
//
// The API answers XML unless asked for JSON through an Accept header,
// and the shared HTTP client sends none, so the XML form is what we
// parse. It is also the API's default, which makes it the more stable
// of the two.
func fetchEdition(ctx context.Context, which string) (Edition, error) {
	body, err := overlay.HTTPGetAll(ctx, apraChartURL+"?edition="+which)
	if err != nil {
		return Edition{}, err
	}
	var res struct {
		Edition []struct {
			EditionName string `xml:"editionName,attr"`
			EditionDate string `xml:"editionDate"`
		} `xml:"edition"`
	}
	if err := xml.Unmarshal(body, &res); err != nil {
		return Edition{}, fmt.Errorf("decode APRA %s edition: %w", which, err)
	}
	if len(res.Edition) == 0 {
		return Edition{}, fmt.Errorf("APRA reported no %s edition", which)
	}
	// The API formats the date MM/DD/YYYY.
	d, err := time.Parse("01/02/2006", strings.TrimSpace(res.Edition[0].EditionDate))
	if err != nil {
		return Edition{}, fmt.Errorf("APRA %s edition date %q: %w", which, res.Edition[0].EditionDate, err)
	}
	return Edition{
		Effective: d.UTC().Format("2006-01-02T15:04:05.000Z"),
		Date:      d.UTC(),
	}, nil
}

// layerEdited reads a FeatureServer layer's own dataLastEditDate.
func layerEdited(ctx context.Context, layerURL string) (time.Time, error) {
	// The URLs carried here end in /query; the layer document is its
	// parent.
	base := layerURL
	if n := len(base); n > len("/query") && base[n-len("/query"):] == "/query" {
		base = base[:n-len("/query")]
	}
	body, err := overlay.HTTPGetAll(ctx, base+"?f=json")
	if err != nil {
		return time.Time{}, err
	}
	var res struct {
		EditingInfo struct {
			DataLastEditDate *int64 `json:"dataLastEditDate"`
			LastEditDate     *int64 `json:"lastEditDate"`
		} `json:"editingInfo"`
	}
	if err := json.Unmarshal(body, &res); err != nil {
		return time.Time{}, fmt.Errorf("decode layer info: %w", err)
	}
	ms := res.EditingInfo.DataLastEditDate
	if ms == nil {
		ms = res.EditingInfo.LastEditDate
	}
	if ms == nil {
		return time.Time{}, fmt.Errorf("%s publishes no edit stamp", base)
	}
	return time.UnixMilli(*ms).UTC(), nil
}

// pendingIsAhead reports whether a Pending_* layer really holds the next
// cycle: its content must have been edited on or after the current
// edition's effective date. A layer that cannot be interrogated is
// treated as not ahead, so an unreadable stamp skips the next slot
// rather than publishing the wrong cycle into it.
func pendingIsAhead(ctx context.Context, layerURL string, current Edition) (bool, string) {
	edited, err := layerEdited(ctx, layerURL)
	if err != nil {
		return false, err.Error()
	}
	if edited.Before(current.Date) {
		return false, fmt.Sprintf("pre-release last edited %s, before the current edition %s",
			edited.Format("2006-01-02"), current.Date.Format("2006-01-02"))
	}
	return true, ""
}
