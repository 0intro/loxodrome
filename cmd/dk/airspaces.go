// airspaces.go builds dk-airspaces.json from the AIP of Denmark's ENR 2.1,
// 2.2, 5.1, 5.2, 5.3 and 5.5, one PDF per section in Naviair's tree, their
// ruled tables rebuilt by internal/pdftable and read by the generated
// eAIPs' zone reader, as cmd/ro reads Romania's. Denmark's GEN 0.1 forbids
// reproduction without the Danish CAA's written permission, so the build
// is HELD: it refuses public/data, and its output stays local until the
// permission docs/aip-permissions.md asks for is given.

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/0intro/loxodrome/internal/aip"
	"github.com/0intro/loxodrome/internal/aixm5"
	"github.com/0intro/loxodrome/internal/aixm5build"
	"github.com/0intro/loxodrome/internal/eaip"
	"github.com/0intro/loxodrome/internal/pdftable"
	"github.com/0intro/loxodrome/internal/pdftext"
)

// dkSections are the ENR sections holding airspace to draw, by the name
// of their file in the tree.
var dkSections = []struct{ name, file string }{
	{"ENR 2.1", "EK_ENR_2_1_en.pdf"},
	{"ENR 2.2", "EK_ENR_2_2_en.pdf"},
	{"ENR 5.1", "EK_ENR_5_1_en.pdf"},
	{"ENR 5.2", "EK_ENR_5_2_en.pdf"},
	{"ENR 5.3", "EK_ENR_5_3_en.pdf"},
	{"ENR 5.5", "EK_ENR_5_5_en.pdf"},
}

// dkENRPart is the AIP's en-route part in the tree.
var dkENRPart = regexp.MustCompile(`\(ENR\)\s*$`)

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
		return fmt.Errorf("dk airspaces are HELD until the Danish CAA permits them (docs/aip-permissions.md): give -out a local directory")
	}
	return nil
}

// dkDrop leaves out ENR 5's flight-plan buffer zones, each a wider ring
// under its area's designator and a Z ("EKR11Z", "EKTSAJY2Z JYL B - TSA
// FBZ"), a filing construct and no airspace to draw, as Finland's.
func dkDrop(section, designator, name string) string {
	if strings.HasPrefix(section, "ENR 5") && strings.HasSuffix(strings.ToUpper(strings.TrimSpace(designator)), "Z") {
		return "FLIGHT PLAN BUFFER ZONE"
	}
	return ""
}

// dkSectionFiles finds each section's file in the tree, or in a directory
// a -keep run filled.
func dkSectionFiles(ctx context.Context, d *dkClient, dir string) (map[string]string, string, error) {
	files := map[string]string{}
	if dir != "" {
		for _, s := range dkSections {
			files[s.file] = filepath.Join(dir, s.file)
		}
		return files, filepath.Base(dir), nil
	}
	root, err := d.nodes(ctx, "")
	if err != nil {
		return nil, "", err
	}
	var aipNode *dkNode
	for i := range root {
		if root[i].IsDir && root[i].Name == "AIP Danmark" {
			aipNode = &root[i]
		}
	}
	if aipNode == nil {
		return nil, "", fmt.Errorf("the tree lists no AIP Danmark")
	}
	parts, err := d.nodes(ctx, fmt.Sprint(aipNode.ID))
	if err != nil {
		return nil, "", err
	}
	var edition string
	var day time.Time
	for _, part := range parts {
		switch {
		case part.IsDir && part.Name == "AIP":
			docs, err := d.nodes(ctx, fmt.Sprint(part.ID))
			if err != nil {
				return nil, "", err
			}
			for _, doc := range docs {
				if m := dkEditionRe.FindStringSubmatch(doc.Name); m != nil {
					if t, err := dkDay(m[1]); err == nil && t.After(day) {
						edition, day = m[1], t
					}
				}
			}
		case part.IsDir && dkENRPart.MatchString(part.Name):
			chapters, err := d.nodes(ctx, fmt.Sprint(part.ID))
			if err != nil {
				return nil, "", err
			}
			for _, ch := range chapters {
				docs, err := d.nodes(ctx, fmt.Sprint(ch.ID))
				if err != nil {
					return nil, "", err
				}
				for _, doc := range docs {
					if doc.Href != nil {
						files[doc.Name] = dkSite + *doc.Href
					}
				}
			}
		}
	}
	if edition == "" {
		return nil, "", fmt.Errorf("no AIP file names its AIRAC edition")
	}
	return files, day.Format("2006-01-02"), nil
}

// buildDkAirspaces reads the sections and writes dk-airspaces.json.
func buildDkAirspaces(outDir, enrDir, keep, firs string, now func() time.Time) error {
	if err := heldOut(outDir); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	d := &dkClient{c: &http.Client{Timeout: 90 * time.Second}}
	files, edition, err := dkSectionFiles(ctx, d, enrDir)
	if err != nil {
		return err
	}
	border, err := eaip.LoadBorderRing(firs, "EKDK")
	if err != nil {
		return err
	}
	spec := eaip.ZoneSpec{Type: eaip.SectionType, Drop: dkDrop, IDPrefix: "DK", IcaoPrefix: "EK", Border: border}
	st := eaip.NewZoneStats()
	h := sha256.New()
	counts := map[string]int{}
	var zones []aixm5.Airspace
	for _, s := range dkSections {
		src, ok := files[s.file]
		if !ok {
			return fmt.Errorf("the tree lists no %s", s.file)
		}
		var data []byte
		if strings.HasPrefix(src, "http") {
			data, err = d.get(ctx, src)
		} else {
			data, err = os.ReadFile(src)
		}
		if err != nil {
			return fmt.Errorf("%s: %w", s.name, err)
		}
		if keep != "" {
			dir := filepath.Join(keep, edition)
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
	effective := edition + "T00:00:00.000Z"
	source := "Danish CAA AIP Denmark " + edition + " ENR 2.1, 2.2, 5.1, 5.2, 5.3, 5.5"
	msg := aixm5.Message{Airspaces: zones}
	artifact, meta, err := aixm5build.BuildAirspaces(&msg, source, nil, effective, aixm5build.AirspacesOptions{
		Country:      "DK",
		Now:          now,
		MinAirspaces: 20,
		MaxAirspaces: 2000,
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
		UnreadArcs    []string       `json:"unreadArcs,omitempty"`
	}
	out := heldMeta{
		AirspacesMeta: meta,
		Held:          "GEN 0.1 §6: no reproduction without the Danish CAA's written permission (docs/aip-permissions.md)",
		SourceSha256:  hex.EncodeToString(h.Sum(nil)),
		SectionCounts: counts,
		SkippedTypes:  st.SkippedTypes,
		ArcsUnread:    st.Boundary.ArcsUnread,
		UnreadArcs:    st.UnreadArcs,
	}
	slot, err := aip.WriteDataset(outDir, "dk-airspaces", "current", effective, artifact, out)
	if err != nil {
		return err
	}
	var names []string
	for _, s := range dkSections {
		names = append(names, fmt.Sprintf("%s %d", s.name, counts[s.name]))
	}
	sort.Strings(names)
	fmt.Printf("dk: wrote %d airspaces, HELD (%s); effective %s; slot=%s\n", meta.AirspaceCount, strings.Join(names, ", "), edition, slot)
	return nil
}
