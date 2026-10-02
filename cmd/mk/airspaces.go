// airspaces.go builds mk-airspaces.json, held, from M-NAV's ENR PDFs: the
// ruled tables of ENR 2.1, 2.2 and 5.2 rebuilt by internal/pdftable and
// read by the generated eAIPs' zone reader, as cmd/ro reads Romania's.
// ENR 5.1 sets its two restricted areas out as prose, which that reader
// does not read (docs/aip-sources.md, the PDF States).

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/aixm5"
	"github.com/0intro/loxodrome/internal/aixm5build"
	"github.com/0intro/loxodrome/internal/eaip"
	"github.com/0intro/loxodrome/internal/pdftable"
	"github.com/0intro/loxodrome/internal/pdftext"
)

// mkBase is the package's section PDFs.
const mkBase = "https://ais.m-nav.info/eAIP/current/pdf/enr/"

// mkUserAgent and the headers beside it are a browser's: the server's
// Mod_Security answers 406 to a bare client.
const mkUserAgent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36"

// mkSections are the ENR sections holding airspace, by file.
var mkSections = []struct{ name, file string }{
	{"ENR 2.1", "LW_ENR_2_1_en.pdf"},
	{"ENR 2.2", "LW_ENR_2_2_en.pdf"},
	{"ENR 5.1", "LW_ENR_5_1_en.pdf"},
	{"ENR 5.2", "LW_ENR_5_2_en.pdf"},
	{"ENR 5.3", "LW_ENR_5_3_en.pdf"},
	{"ENR 5.5", "LW_ENR_5_5_en.pdf"},
}

// heldOut refuses the one directory held data must never reach.
func heldOut(outDir string) error {
	out, err := filepath.Abs(outDir)
	if err != nil {
		return err
	}
	public, err := filepath.Abs(defaultOutDir)
	if err != nil {
		return err
	}
	if out == public {
		return fmt.Errorf("mk airspaces are HELD until M-NAV permits them (docs/aip-permissions.md): give -out a local directory")
	}
	return nil
}

// mkDrop leaves out the Macedonian half of a zone the section prints in
// both languages, read as a zone of its own beside the English.
func mkDrop(section, designator, name string) string {
	for _, r := range name {
		if r >= 0x0400 && r <= 0x04FF {
			return "MACEDONIAN TWIN"
		}
	}
	return ""
}

// mkGet fetches one file with a browser's headers.
func mkGet(ctx context.Context, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", mkUserAgent)
	req.Header.Set("Accept", "*/*")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	res, err := (&http.Client{Timeout: 90 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET %s: HTTP %d", url, res.StatusCode)
	}
	return io.ReadAll(io.LimitReader(res.Body, 64<<20))
}

// buildMkAirspaces reads the sections and writes mk-airspaces.json.
func buildMkAirspaces(outDir, enrDir, keep, firs string, now func() time.Time) error {
	if err := heldOut(outDir); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	border, err := eaip.LoadBorderRing(firs, "LWSS")
	if err != nil {
		return err
	}
	spec := eaip.ZoneSpec{Type: eaip.SectionType, Drop: mkDrop, IDPrefix: "MK", IcaoPrefix: "LW", Border: border}
	st := eaip.NewZoneStats()
	h := sha256.New()
	counts := map[string]int{}
	var zones []aixm5.Airspace
	for _, s := range mkSections {
		var data []byte
		if enrDir != "" {
			data, err = os.ReadFile(filepath.Join(enrDir, s.file))
		} else {
			data, err = mkGet(ctx, mkBase+s.file)
		}
		if err != nil {
			return fmt.Errorf("%s: %w", s.name, err)
		}
		if keep != "" {
			dir := filepath.Join(keep, "current")
			if err := os.MkdirAll(dir, 0o755); err != nil {
				return err
			}
			if err := os.WriteFile(filepath.Join(dir, s.file), data, 0o644); err != nil {
				return err
			}
		}
		h.Write(data)
		bbox, err := pdftext.Run(data, "-bbox-layout", "-", "-")
		if err != nil {
			return fmt.Errorf("%s: %w", s.name, err)
		}
		html, err := pdftable.Document(data, bbox, s.name)
		if err != nil {
			return fmt.Errorf("%s: %w", s.name, err)
		}
		doc, err := eaip.ParseHTML(html)
		if err != nil {
			return fmt.Errorf("%s: %w", s.name, err)
		}
		got := eaip.ParseIcaoZoneTables(doc, s.name, spec, st)
		counts[s.name] = len(got)
		zones = append(zones, got...)
	}
	// The package states no edition beside its sections; the day read is
	// the day the build ran.
	effective := now().UTC().Format("2006-01-02") + "T00:00:00.000Z"
	source := "M-NAV AIP North Macedonia (current) ENR 2.1, 2.2, 5.1, 5.2, 5.3, 5.5"
	msg := aixm5.Message{Airspaces: zones}
	artifact, meta, err := aixm5build.BuildAirspaces(&msg, source, nil, effective, aixm5build.AirspacesOptions{
		Country:      "MK",
		Now:          now,
		MinAirspaces: 3,
		MaxAirspaces: 500,
	})
	if err != nil {
		return err
	}
	type heldMeta struct {
		aixm5build.AirspacesMeta
		Held          string         `json:"held"`
		SourceSha256  string         `json:"sourceSha256"`
		SectionCounts map[string]int `json:"sectionCounts"`
		SkippedTypes  map[string]int `json:"skippedTypes,omitempty"`
		ArcsUnread    int            `json:"arcsUnread"`
	}
	out := heldMeta{
		AirspacesMeta: meta,
		Held:          "GEN 0.1.5: no reproduction or storage in databases without M-NAV's written permission (docs/aip-permissions.md)",
		SourceSha256:  hex.EncodeToString(h.Sum(nil)),
		SectionCounts: counts,
		SkippedTypes:  st.SkippedTypes,
		ArcsUnread:    st.Boundary.ArcsUnread,
	}
	slot, err := aip.WriteDataset(outDir, "mk-airspaces", "current", effective, artifact, out)
	if err != nil {
		return err
	}
	var parts []string
	for _, s := range mkSections {
		parts = append(parts, fmt.Sprintf("%s %d", s.name, counts[s.name]))
	}
	fmt.Printf("mk: wrote %d airspaces, HELD (%s); slot=%s\n", meta.AirspaceCount, strings.Join(parts, ", "), slot)
	return nil
}
