// The activity audit: every supplement of the audit years is re-parsed from
// its cached PDF, and a reading of its pdftotext -layout text with a grammar
// of its own is checked against what the parser reads of its schedules and
// telephone numbers:
//
//   - the status words of each schedule section ("activable", "possible
//     activation", "par NOTAM") against the modes of its zones' activations
//     and standing rules
//   - each zone mixing firm periods with periods that may be activated,
//     a short list each verified by hand
//   - each sentence outside the sections saying a zone it names may be
//     activated against that zone's periods
//   - the shortest notice the section prints ("préavis de 48 heures",
//     "J-1") against the notices read
//   - the rules read unread, a short list each verified by hand
//   - every telephone number the text prints against the numbers read
//
// Opt-in like the corpus audit: SUPAIP_AUDIT=<report dir> go test
// ./cmd/supaip -run TestAuditActivity
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"testing"
)

var (
	// censusSectionRe opens a schedule section, and censusHeadingRe is the
	// template's next section heading, set centred: a zone's name in
	// capitals ("ZRT PARA CUERS", 017/2026) is none.
	censusSectionRe = regexp.MustCompile(`^\s*(?:DATES?\s+ET\s+HEURES|HORAIRES?\s+D.ACTIVIT|P[ÉE]RIODES?\s+D.ACTIVIT)`)
	censusHeadingRe = regexp.MustCompile(`^\s{10,}(?:LIMITES|ORGANISMES?|GESTIONNAIRES?|CONDITIONS|INFORMATIONS?|SERVICES|STATUT|REMARQUES|DISPOSITIONS|CONTACTS?|ZONES?\s+TAMPON|CLASSE|OBSERVATIONS|PROC[ÉE]DURES|ANNEXE)\b`)
	censusActivable = regexp.MustCompile(`(?i)\bactivables?\b|\bpossibles?\s+activation|\bactivation\s+possible|\bpourr(?:a|ont)\s+[êe]tre\s+activ`)
	censusNotam     = regexp.MustCompile(`(?i)\bpar\s+(?:la\s+)?(?:voie\s+de\s+)?NOTAM\b|\bNOTAM\s+d['’]activation`)
	censusNoticeRe  = regexp.MustCompile(`(?i)pr[ée]avis\s+(?:minimum\s+)?(?:de\s+)?(\d+)\s*(h\b|heures?|min\b|minutes?|jours?)|\bJ\s*-\s*(\d)\b`)
	censusPhoneRe   = regexp.MustCompile(`(?:\+\s?33\s?(?:\(0\)\s?|0)?|\b0)([1-9])((?:[\s.]{0,2}\d\d){4})\b`)
	// censusStated is a sentence saying zones it names may be activated
	// ("La ZRT SOTAME BRAVO est activable", 162/2026).
	censusStated = regexp.MustCompile(`\bL(?:a|es)\s+((?:ZRT|ZDT|ZIT)\b[^.]*?)\s+(?:est|sont)\s+activables?\b`)
)

// censusOutside returns the text of a layout outside its schedule sections.
func censusOutside(text string) string {
	var b strings.Builder
	in := false
	for _, l := range strings.Split(text, "\n") {
		switch {
		case censusSectionRe.MatchString(l):
			in = true
		case in && censusHeadingRe.MatchString(l):
			in = false
		}
		if !in {
			b.WriteString(l)
			b.WriteByte('\n')
		}
	}
	return b.String()
}

// censusName is a zone's name as letters and figures in capitals, the way
// a census compares it with the text.
func censusName(s string) string {
	var b strings.Builder
	for _, r := range strings.ToUpper(s) {
		if r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// zoneModes returns whether a zone holds a period throughout (a firm
// activation or standing rule, or no schedule, its validity standing) and
// whether it holds one that may be activated.
func zoneModes(z zone) (firm, may bool) {
	if len(z.activations) == 0 && len(z.standing) == 0 {
		return true, false
	}
	for _, as := range [][]activation{z.activations, z.standing} {
		for _, a := range as {
			switch a.status.mode {
			case "", modeFirm:
				firm = true
			case modeActivable, modeNotam:
				may = true
			}
		}
	}
	return firm, may
}

// censusSections returns the text of a layout's schedule sections.
func censusSections(text string) string {
	var b strings.Builder
	in := false
	for _, l := range strings.Split(text, "\n") {
		switch {
		case censusSectionRe.MatchString(l):
			in = true
		case in && censusHeadingRe.MatchString(l):
			in = false
		}
		if in {
			b.WriteString(l)
			b.WriteByte('\n')
		}
	}
	return b.String()
}

// censusNotices returns the notices, in minutes, a text prints.
func censusNotices(text string) []int {
	var out []int
	for _, m := range censusNoticeRe.FindAllStringSubmatch(text, -1) {
		if m[3] != "" {
			n, _ := strconv.Atoi(m[3])
			out = append(out, n*24*60)
			continue
		}
		n, _ := strconv.Atoi(m[1])
		switch u := strings.ToLower(m[2]); {
		case strings.HasPrefix(u, "j"):
			n *= 24 * 60
		case strings.HasPrefix(u, "h"):
			n *= 60
		}
		out = append(out, n)
	}
	slices.Sort(out)
	return slices.Compact(out)
}

// censusPhones returns the numbers a text prints, ten figures each, those a
// fax answers left out.
func censusPhones(text string) []string {
	var out []string
	for _, l := range censusPhoneRe.FindAllStringSubmatchIndex(text, -1) {
		lead := strings.ToLower(text[max(0, l[0]-14):l[0]])
		if strings.Contains(lead, "fax") && !strings.Contains(lead, "tél") && !strings.Contains(lead, "tel") {
			continue
		}
		var d strings.Builder
		d.WriteByte('0')
		for _, c := range text[l[2]:l[5]] {
			if c >= '0' && c <= '9' {
				d.WriteRune(c)
			}
		}
		out = append(out, d.String())
	}
	slices.Sort(out)
	return slices.Compact(out)
}

type activityReport struct {
	ID       string   `json:"id"`
	Title    string   `json:"title"`
	Findings []string `json:"findings"`
}

func TestAuditActivity(t *testing.T) {
	outDir := os.Getenv("SUPAIP_AUDIT")
	if outDir == "" {
		t.Skip("set SUPAIP_AUDIT=<report dir> to run the corpus audit")
	}
	cacheDir := "../../local/supaip-cache"
	if _, err := os.Stat(cacheDir); err != nil {
		t.Skipf("no PDF cache: %v", err)
	}
	nav, err := loadNavaids("../../public/data/fr-navaids.json")
	if err != nil {
		t.Fatalf("navaids: %v", err)
	}
	if err := loadAerodromes("../../public/data/fr-airports.json", nav); err != nil {
		t.Fatalf("aerodromes: %v", err)
	}
	fields, rows := loadDataset(t)

	var reports []activityReport
	for _, raw := range rows {
		row := decodeRow(fields, raw)
		if rowYear(row.title) < auditFromYear {
			continue
		}
		data, err := os.ReadFile(filepath.Join(cacheDir, filepath.Base(row.urlPdf)))
		if err != nil {
			continue
		}
		text, err := runPdftotext(data, "-layout", "-", "-")
		if err != nil {
			t.Errorf("%s: pdftotext: %v", row.title, err)
			continue
		}
		gr := parsePDF(data, nav)
		rep := activityReport{ID: row.id, Title: row.title}

		modes := map[string]bool{}
		var notices []int
		unread := false
		for _, z := range gr.zones {
			for _, a := range z.activations {
				modes[a.status.mode] = true
				notices = append(notices, a.status.noticeMin)
			}
			for _, a := range z.standing {
				modes[a.status.mode] = true
				notices = append(notices, a.status.noticeMin)
				unread = unread || a.status.mode == modeUnread
			}
		}
		sec := censusSections(string(text))
		saysActivable, saysNotam := censusActivable.MatchString(sec), censusNotam.MatchString(sec)
		if len(gr.zones) > 0 && (saysActivable || saysNotam) && !modes[modeActivable] && !modes[modeNotam] {
			rep.Findings = append(rep.Findings, "status words read nowhere: "+
				strings.Join(append(censusActivable.FindAllString(sec, 2), censusNotam.FindAllString(sec, 2)...), ", "))
		}
		if modes[modeNotam] && !saysNotam {
			rep.Findings = append(rep.Findings, "by NOTAM with no NOTAM word")
		}
		// A zone mixing firm periods with periods that may be activated
		// (111/2026 lost a wrapped "ZRT activable", 166/2026's BUCK BRAVO a
		// status in its summer split), and one reading firm that a sentence
		// outside the sections says may be activated, each zone once.
		var stated []string
		for _, m := range censusStated.FindAllStringSubmatch(strings.Join(strings.Fields(censusOutside(string(text))), " "), -1) {
			stated = append(stated, censusName(m[1]))
		}
		seen := map[string]bool{}
		for _, z := range gr.zones {
			if seen[z.name] {
				continue
			}
			seen[z.name] = true
			firm, may := zoneModes(z)
			if firm && may {
				rep.Findings = append(rep.Findings, "firm beside activable periods: "+z.name)
			}
			if n := censusName(z.name); firm && slices.ContainsFunc(stated, func(s string) bool { return strings.Contains(s, n) }) {
				rep.Findings = append(rep.Findings, "firm where a sentence says activable: "+z.name)
			}
		}
		// The parser keeps the shortest notice a text states, for a zone
		// that may be activated: a printed notice shorter than every one
		// read is one it missed.
		read := slices.DeleteFunc(slices.Clone(notices), func(n int) bool { return n == 0 })
		if ns := censusNotices(sec); len(ns) > 0 && (modes[modeActivable] || modes[modeNotam]) &&
			(len(read) == 0 || ns[0] < slices.Min(read)) {
			rep.Findings = append(rep.Findings, fmt.Sprintf("notice %d min unread", ns[0]))
		}
		if unread {
			rep.Findings = append(rep.Findings, "unread")
		}

		var numbers []string
		for _, p := range gr.phones {
			for _, n := range p.numbers {
				numbers = append(numbers, strings.ReplaceAll(n, " ", ""))
			}
		}
		census := censusPhones(string(text))
		for _, n := range census {
			if !slices.Contains(numbers, n) {
				rep.Findings = append(rep.Findings, "number missed "+n)
			}
		}
		for _, n := range numbers {
			if !slices.Contains(census, n) {
				rep.Findings = append(rep.Findings, "number outside the census "+n)
			}
		}
		if len(rep.Findings) > 0 {
			reports = append(reports, rep)
		}
	}

	// The findings each verified by hand against its PDF, by row id, a
	// finding matching an entry it opens with. Each is a reading this parser
	// leaves stricter or wider than printed, or a text it cannot read.
	//
	//   094/2025  "à J-1 17h00" is when Raki and Bricy Approche know the
	//             forecast of activity, the NOTAM's notice 48 h: read.
	//   001/2026  the KRYPTON exercise lists days no month places: unread.
	//   038/2026  its months stand on rows of their own: unread.
	//   055/2026  the native text reverses the line "Téléphone Salle
	//             d’opérations : 05.79.20.03.00, poste".
	//   125/2026  its zones are named by designator (LFR1YP) where the
	//             schedule names them PIA, LUCKY, RAVEN: the validity stands.
	//   126/2026  "Les ZRT sont activables, sauf la ZRT AEROTORSHOW ALPHA qui
	//             sera active du 27 au 29 juin": read firm throughout.
	//   132/2026, 205/2026  an opening line "Activables 25-28 juin 2026 :
	//             0800-1800" over the zones' own dated bullets: read firm.
	//   099/2026  "Zones activables du 16 au 18 juin" over a bare envelope
	//             "Du 16 juin 2026 à 1000 au 17 juin 2026 à 1430": its zones
	//             read firm on the 16th and 17th, by NOTAM on the 18th.
	//             Ended 18 June 2026.
	//   104/2026  COGNAC DELTA LOW, named activable in the heading over the
	//             first group, takes that group's 28 to 31 May activable and
	//             its own 30 and 31 May firm. Ended 31 May 2026.
	//   142/2026  ZIT CONCORDE "active : 0600-1230" on 14 July reads by
	//             NOTAM, as ZRT PARA's slots that day. Ended 14 July 2026.
	//   196/2026  BREIZH AIRSHOW: activable on the 17th and 18th, bare on
	//             the 19th and 20th, as printed.
	//   200/2026  its zones are activated on 21 September "avec préavis de
	//             48h", firm, then activable by NOTAM to 28 October, as
	//             printed.
	//   184/2026  "pourront être activées simultanément" says the zones may
	//             be active together, and its periods read firm.
	want := map[string][]string{
		"metropole-2025-094": {"notice 1440 min unread"},
		"metropole-2026-001": {"status words read nowhere", "unread"},
		"metropole-2026-038": {"unread"},
		"metropole-2026-055": {"number missed 0579200300"},
		"metropole-2026-125": {"status words read nowhere"},
		"metropole-2026-126": {"status words read nowhere"},
		"metropole-2026-132": {"status words read nowhere"},
		"metropole-2026-099": {"firm beside activable periods"},
		"metropole-2026-104": {"firm beside activable periods"},
		"metropole-2026-142": {"firm beside activable periods"},
		"metropole-2026-184": {"status words read nowhere"},
		"metropole-2026-196": {"firm beside activable periods"},
		"metropole-2026-200": {"firm beside activable periods"},
		"metropole-2026-205": {"status words read nowhere"},
	}
	got := map[string][]string{}
	for _, r := range reports {
		got[r.ID] = r.Findings
		for _, f := range r.Findings {
			if !slices.ContainsFunc(want[r.ID], func(w string) bool { return strings.HasPrefix(f, w) }) {
				t.Errorf("%s (%s): %s, not in the verified list", r.Title, r.ID, f)
			}
		}
	}
	for id, ws := range want {
		for _, w := range ws {
			if !slices.ContainsFunc(got[id], func(f string) bool { return strings.HasPrefix(f, w) }) {
				t.Errorf("%s: %q no longer found, drop it from the verified list", id, w)
			}
		}
	}

	sort.Slice(reports, func(i, j int) bool { return reports[i].ID < reports[j].ID })
	var buf strings.Builder
	for _, r := range reports {
		b, _ := json.Marshal(r)
		buf.Write(b)
		buf.WriteByte('\n')
	}
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		t.Fatalf("report directory: %v", err)
	}
	path := filepath.Join(outDir, "supaip-activity.jsonl")
	if err := os.WriteFile(path, []byte(buf.String()), 0o644); err != nil {
		t.Fatalf("write report: %v", err)
	}
	t.Logf("%d supplements with findings; report %s", len(reports), path)
}
