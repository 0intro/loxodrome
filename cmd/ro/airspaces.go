// airspaces.go writes ro-airspaces.json from AIP Romania's ENR sections,
// which ROMATSA publishes only as PDF: ENR 2.1 (the CTAs and the TMAs),
// ENR 5.1 (the prohibited, restricted and danger areas) and ENR 5.2 (the
// TRAs and the TSAs). Each section's ruled tables are rebuilt into the
// HTML the eAIP readers read (internal/pdftable, the words placed by
// pdftotext -bbox-layout) and read by the grammar the generated eAIPs are
// read by (eaip.ParseIcaoZoneTables), so a fix to one serves both.
//
// The other sections hold no airspace to draw: ENR 2.2 is the fuel
// dumping areas, ENR 5.3 two radiosonde sites and ENR 5.5 "to be
// developed". The control zones are the aerodromes' own (AD 2.17), not
// read yet, and the FIR is pruatlas's, drawn with its arcs; its ring is
// what a zone published "except where inside SOFIA FIR" is cut back to.

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

// roSection is one ENR section read for its airspace.
type roSection struct {
	name, dir, file string
	// min is the section's floor: fewer zones than this and its layout
	// has changed under the reader.
	min int
}

// roAirspaceSections are the sections holding airspace. The 2026-09-03
// edition reads 19, 204 and 270 zones.
var roAirspaceSections = []roSection{
	{"ENR 2.1", "ENR2", "LR_ENR_2_1_en.pdf", 10},
	{"ENR 5.1", "ENR5", "LR_ENR_5_1_en.pdf", 100},
	{"ENR 5.2", "ENR5", "LR_ENR_5_2_en.pdf", 100},
}

const (
	defaultMinRoAirspaces = 300
	defaultMaxRoAirspaces = 1500
)

// roEditionNameRe is an edition as ROMATSA names it, its effective day.
var roEditionNameRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

type roAirspacesMeta struct {
	aixm5build.AirspacesMeta
	Edition string `json:"edition"`
	// ADZones counts the zones the aerodrome pages publish for themselves
	// (AD 2.17, AD 3.16), ADRepublished those ENR 2.1 already carries,
	// left out.
	ADZones       int            `json:"adZones"`
	ADRepublished int            `json:"adRepublished"`
	SectionCounts map[string]int `json:"sectionCounts"`
	Tables        int            `json:"tables"`
	WithRadio     int            `json:"withRadio"`
	// LimitsUnparsed counts the zones whose limits no grammar read, their
	// text kept with the remarks; LimitsTextual the limits stated in
	// words ("Lower limit of ATS routes"); ClassStacks the zones whose
	// class varies by level or area, no single one claimed.
	LimitsUnparsed int `json:"limitsUnparsed"`
	LimitsTextual  int `json:"limitsTextual"`
	LimitsSwapped  int `json:"limitsSwapped"`
	ClassStacks    int `json:"classStacks"`
	// Aggregates counts the wholes dropped for the parts beside them
	// ("NAPOC TMA" over "NAPOC TMA 1" to "8").
	Aggregates int      `json:"aggregates"`
	ArcsUnread int      `json:"arcsUnread"`
	UnreadArcs []string `json:"unreadArcs,omitempty"`
	// ArcSensesInferred counts the rings an arc of unstated sense closes
	// only the long way round (Baia Mare CTR).
	ArcSensesInferred int `json:"arcSensesInferred,omitempty"`
	// ClippedToFIR counts the zones cut back at the Bucharest FIR ("except
	// where inside SOFIA FIR"), ClippedAway those the cut left empty and
	// ClipRefused those it could not take, kept whole.
	ClippedToFIR int            `json:"clippedToFir"`
	ClippedAway  int            `json:"clippedAway"`
	ClipRefused  int            `json:"clipRefused"`
	SkippedTypes map[string]int `json:"skippedTypes,omitempty"`
}

// roENR reads one edition's ENR sections: fetched from ROMATSA, or read
// back from a -keep directory named by the edition, and saved to -keep as
// they are read.
type roENR struct {
	edition string
	keep    string
	dir     string // the -enr directory replayed, empty when fetching
	adBase  string // the edition's AD directory, when fetching
	fetch   func(s roSection) ([]byte, error)
}

// openRoENR picks the edition a slot reads. It returns nil, and no error,
// for a pre-release slot ROMATSA has not posted yet.
func openRoENR(ctx context.Context, target, enrDir, keep string, now func() time.Time) (*roENR, error) {
	e := &roENR{keep: keep, dir: enrDir}
	if enrDir != "" {
		e.edition = filepath.Base(filepath.Clean(enrDir))
		e.fetch = func(s roSection) ([]byte, error) { return os.ReadFile(filepath.Join(enrDir, s.file)) }
	} else {
		c := &http.Client{Timeout: 90 * time.Second}
		listing, err := roGet(ctx, c, roRoot)
		if err != nil {
			return nil, err
		}
		e.edition = pickRoEdition(string(listing), now(), target == "next")
		if e.edition == "" {
			if target == "next" {
				fmt.Println("ro: no pre-release edition published; nothing written")
				return nil, nil
			}
			return nil, fmt.Errorf("%s lists no edition in force", roRoot)
		}
		base := roRoot + e.edition + "/DOCS/AIP/ENR/"
		e.adBase = roRoot + e.edition + "/DOCS/AIP/AD/"
		e.fetch = func(s roSection) ([]byte, error) { return roGet(ctx, c, base+s.dir+"/"+s.file) }
	}
	if !roEditionNameRe.MatchString(e.edition) {
		return nil, fmt.Errorf("edition %q is no effective day", e.edition)
	}
	return e, nil
}

// read reads one section, saving it to -keep.
func (e *roENR) read(s roSection) ([]byte, error) {
	data, err := e.fetch(s)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", s.name, err)
	}
	if e.keep != "" {
		dir := filepath.Join(e.keep, e.edition)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, err
		}
		if err := os.WriteFile(filepath.Join(dir, s.file), data, 0o644); err != nil {
			return nil, err
		}
	}
	return data, nil
}

// rebuildRoSection rebuilds one PDF section's tables into the HTML the
// eAIP readers read.
func rebuildRoSection(data []byte, section string) (*eaip.Node, error) {
	bbox, err := pdftext.Run(data, "-bbox-layout", "-", "-")
	if err != nil {
		return nil, err
	}
	html, err := pdftable.Document(data, bbox, section)
	if err != nil {
		return nil, err
	}
	return eaip.ParseHTML(html)
}

// roZoneSpec is the zone readers' spec for Romania, its FIR ring the one
// a zone excepting a neighbour's FIR is cut back to.
func roZoneSpec(firs string) (eaip.ZoneSpec, error) {
	border, err := eaip.LoadBorderRing(firs, "LRBB")
	if err != nil {
		return eaip.ZoneSpec{}, err
	}
	if border == nil {
		return eaip.ZoneSpec{}, fmt.Errorf("%s carries no LRBB ring", firs)
	}
	return eaip.ZoneSpec{Type: eaip.SectionType, IDPrefix: "RO", IcaoPrefix: "LR", Border: border}, nil
}

// buildRoAirspaces reads an edition's airspace sections and writes
// ro-airspaces.json, the aerodromes' own zones joining the ENR's less what
// an ENR section already publishes.
func buildRoAirspaces(outDir, target string, enr *roENR, pass *roADPass, spec eaip.ZoneSpec, win aip.SanityWindows, now func() time.Time) error {
	edition := enr.edition
	st := eaip.NewZoneStats()
	h := sha256.New()
	counts := map[string]int{}
	var zones []aixm5.Airspace
	for _, s := range roAirspaceSections {
		data, err := enr.read(s)
		if err != nil {
			return err
		}
		h.Write(data)
		got, err := readRoSection(data, s.name, spec, st)
		if err != nil {
			return fmt.Errorf("%s: %w", s.name, err)
		}
		if len(got) < s.min {
			return fmt.Errorf("%s: %d zones, fewer than %d; the layout may have changed", s.name, len(got), s.min)
		}
		counts[s.name] = len(got)
		zones = append(zones, got...)
	}

	var adZones []aixm5.Airspace
	for _, p := range pass.pages {
		adZones = append(adZones, p.zones...)
		if p.zstats != nil {
			st.Add(p.zstats)
		}
	}
	adKept, republished := eaip.DropRepublished(zones, adZones)
	counts["AD 2.17"] = len(adKept)
	zones = append(zones, adKept...)

	msg := aixm5.Message{Airspaces: dedupeRoZones(zones)}
	effective := edition + "T00:00:00.000Z"
	source := "ROMATSA AIP Romania " + edition + " " + strings.Join(sectionNames(), ", ") + ", AD 2.17"
	artifact, shared, err := aixm5build.BuildAirspaces(&msg, source, nil, effective,
		aixm5build.AirspacesOptions{
			Country:      "RO",
			Now:          now,
			MinAirspaces: orDefault(win.MinAirspaces, defaultMinRoAirspaces),
			MaxAirspaces: orDefault(win.MaxAirspaces, defaultMaxRoAirspaces),
		})
	if err != nil {
		return err
	}
	shared.SourceSha256 = hex.EncodeToString(h.Sum(nil))
	withRadio := 0
	for _, z := range msg.Airspaces {
		if len(z.Radio) > 0 {
			withRadio++
		}
	}
	meta := roAirspacesMeta{
		AirspacesMeta:     shared,
		Edition:           edition,
		ADZones:           len(adZones),
		ADRepublished:     republished,
		SectionCounts:     counts,
		Tables:            st.Tables,
		WithRadio:         withRadio,
		LimitsUnparsed:    st.LimitsUnparsed,
		LimitsTextual:     st.LimitsTextual,
		LimitsSwapped:     st.LimitsSwapped,
		ClassStacks:       st.ClassStacks,
		Aggregates:        st.Aggregates,
		ArcsUnread:        st.Boundary.ArcsUnread,
		UnreadArcs:        st.UnreadArcs,
		ArcSensesInferred: st.Boundary.ArcSensesInferred,
		ClippedToFIR:      st.Boundary.ClippedToFIR,
		ClippedAway:       st.Boundary.ClippedAway,
		ClipRefused:       st.Boundary.ClipRefused,
	}
	if len(st.SkippedTypes) > 0 {
		meta.SkippedTypes = st.SkippedTypes
	}
	slot, err := aip.WriteDataset(outDir, "ro-airspaces", target, meta.Effective, artifact, meta)
	if err != nil {
		return err
	}
	fmt.Printf("ro: wrote %d airspaces (%s); %d unread arcs, %d limits unparsed, %d clipped to the FIR; effective %s; slot=%s\n",
		meta.AirspaceCount, sectionSummary(counts), meta.ArcsUnread, meta.LimitsUnparsed, meta.ClippedToFIR, edition, slot)
	return nil
}

// readRoSection rebuilds one PDF section's tables and reads its zones.
func readRoSection(data []byte, section string, spec eaip.ZoneSpec, st *eaip.ZoneStats) ([]aixm5.Airspace, error) {
	doc, err := rebuildRoSection(data, section)
	if err != nil {
		return nil, err
	}
	return eaip.ParseIcaoZoneTables(doc, section, spec, st), nil
}

// dedupeRoZones drops a zone repeated exactly, ring and all.
func dedupeRoZones(in []aixm5.Airspace) []aixm5.Airspace {
	seen := map[string]bool{}
	out := make([]aixm5.Airspace, 0, len(in))
	for _, z := range in {
		key := fmt.Sprintf("%s|%s|%v|%v|%v", z.ID, z.Type, z.UpperLimit, z.LowerLimit, z.Ring)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, z)
	}
	return out
}

func sectionNames() []string {
	var out []string
	for _, s := range roAirspaceSections {
		out = append(out, s.name)
	}
	return out
}

func sectionSummary(counts map[string]int) string {
	var parts []string
	for _, s := range roAirspaceSections {
		parts = append(parts, fmt.Sprintf("%s %d", s.name, counts[s.name]))
	}
	parts = append(parts, fmt.Sprintf("AD 2.17 %d", counts["AD 2.17"]))
	sort.Strings(parts)
	return strings.Join(parts, ", ")
}
