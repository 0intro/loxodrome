// activations.go: parse the "DATES ET HEURES D'ACTIVITÉ" section into per-zone
// activation periods. Each schedule is tied to its zone by name, in one of
// three layouts:
//
//   - a table whose columns are the zone names, one schedule per column;
//   - a single zone-name heading followed by date bullets;
//   - a "ZONE A / ZONE B / ..." name list followed by a shared schedule bullet
//     (one block can hold several such name-list / schedule pairs).
//
// A block with no zone name (a single-zone supplement) falls back to every
// zone that has no named schedule. Dates are French ("11 juin 2026"); times
// are UTC HHMM ranges ("1200-1800", "de 1200 à 1800"). A "Du <date> au <date>"
// range keeps both ends.

package main

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// activation is one scheduled window for a zone. date is YYYY-MM-DD; dateTo is
// set for a "Du <date> au <date>" range, else empty. from / to are "HH:MM"
// UTC, empty for an all-day / unspecified window.
type activation struct {
	date   string
	dateTo string
	from   string
	to     string
}

var frMonths = map[string]int{
	"janvier": 1, "fevrier": 2, "mars": 3, "avril": 4, "mai": 5, "juin": 6,
	"juillet": 7, "aout": 8, "septembre": 9, "octobre": 10, "novembre": 11,
	"decembre": 12,
}

var (
	// The accented months (février, août, décembre) often come through with
	// their accent as U+FFFD, the SIA fonts' unmapped-glyph stand-in.
	frDateRe = regexp.MustCompile(
		`(?i)(\d{1,2})\s*(janvier|f[eé\x{FFFD}]vrier|mars|avril|mai|juin|juillet|ao[uû\x{FFFD}]t|septembre|octobre|novembre|d[eé\x{FFFD}]cembre)\.?\s*(\d{4})?`)
	// A time range; the separator may be "-", "à" (or its U+FFFD garble), "au".
	timeRangeRe = regexp.MustCompile(`(\d{3,4})[^\d\n]{1,4}(\d{3,4})`)
	// A short all-caps fragment, e.g. the "ALPHA" left when "ZRT X ALPHA"
	// wraps across two rows: a heading continuation with no type token.
	nameTailRe = regexp.MustCompile(`^[A-Z0-9 ./'-]{1,25}$`)
)

// asciiMonth folds accents (and their U+FFFD garbles) so the month map keys
// match.
func asciiMonth(s string) string {
	s = strings.ToLower(s)
	s = strings.NewReplacer(
		"f�vrier", "fevrier",
		"ao�t", "aout",
		"d�cembre", "decembre",
	).Replace(s)
	return strings.NewReplacer("é", "e", "è", "e", "ê", "e", "û", "u", "ù", "u", "â", "a").Replace(s)
}

// parseFrDate turns a French date match (day, month, year) into YYYY-MM-DD.
// year carries the last-seen year when this date omits it.
func parseFrDate(m []string, year *int) string {
	day, _ := strconv.Atoi(m[1])
	mon := frMonths[asciiMonth(m[2])]
	if mon == 0 || day < 1 || day > 31 {
		return ""
	}
	if m[3] != "" {
		if y, err := strconv.Atoi(m[3]); err == nil {
			*year = y
		}
	}
	if *year == 0 {
		return ""
	}
	return fmt.Sprintf("%04d-%02d-%02d", *year, mon, day)
}

func hhmm(s string) string {
	if len(s) == 3 {
		s = "0" + s
	}
	if len(s) != 4 {
		return ""
	}
	return s[:2] + ":" + s[2:]
}

// activationSectionEnd reports the end of a DATES ET HEURES block.
func activationSectionEnd(r prow) bool {
	f := fold(r.text())
	if isPageNoise(f) {
		return true
	}
	for _, w := range []string{"conditions", "services", "gestionnaires", "informationdes", "limites", "dispositions", "organismes", "statut", "remarques", "generalites"} {
		if strings.Contains(f, w) {
			return true
		}
	}
	return false
}

// zoneInitRe marks where each zone name begins: a name-initial area-type token.
// LF-R / LF-D are deliberately excluded; they also appear mid-name (e.g.
// "ZRT AVEL LF-R 17 A 1"), where splitting would shatter the name. Case-
// sensitive: the jammed names are upper-case, so this won't split on a type
// token buried in a lower-case word (the "tra" in "Montreal").
var zoneInitRe = regexp.MustCompile(`(ZRT|ZIT|ZDT|TMA|CTR|CTA|TRA|CBA|SIV)`)

// splitZoneNames splits a heading into one piece per zone name: first on the
// explicit "/" separators, then on any further name-initial tokens (for names
// jammed together with no slash, e.g. a prose note sharing the heading row).
func splitZoneNames(s string) []string {
	var out []string
	for _, part := range strings.Split(s, "/") {
		out = append(out, splitAtInitials(part)...)
	}
	return out
}

func splitAtInitials(s string) []string {
	idx := zoneInitRe.FindAllStringIndex(s, -1)
	if len(idx) == 0 {
		// No type token (e.g. an "LF-D 18 MODIFIÉE" name); keep as one piece.
		if p := strings.Trim(s, " /.\t"); p != "" {
			return []string{p}
		}
		return nil
	}
	var out []string
	for i, m := range idx {
		end := len(s)
		if i+1 < len(idx) {
			end = idx[i+1][0]
		}
		if p := strings.Trim(s[m[0]:end], " /.\t"); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// namedActs holds each zone name's activation windows plus the order the
// document first named it. Two spellings of one zone fold to a single zone
// (110/2026 names ZIT LAC once in a list with ZRT SAVOIE and once on its own),
// and folding them in a Go map's iteration order made the merged schedule come
// out in a different order run to run.
type namedActs struct {
	order []string
	acts  map[string][]activation
}

func newNamedActs() *namedActs {
	return &namedActs{acts: map[string][]activation{}}
}

func (n *namedActs) add(name string, acts ...activation) {
	if _, seen := n.acts[name]; !seen {
		n.order = append(n.order, name)
	}
	n.acts[name] = append(n.acts[name], acts...)
}

// parseActivations extracts every zone's activation windows, keyed by the
// (jammed) zone name read from the table header, the block heading, or the
// "A / B / ..." name list. unnamed collects windows from a block with no zone
// name, to be applied to single-zone supplements.
func parseActivations(rows []prow) (named *namedActs, unnamed []activation) {
	named = newNamedActs()
	year := 0
	for i := 0; i < len(rows); i++ {
		if !strings.Contains(fold(rows[i].text()), "datesetheures") {
			continue
		}
		var curNames []string
		var heading strings.Builder // accumulates a wrapped name list
		sawDate := false
		flush := func() {
			if heading.Len() > 0 {
				curNames = splitZoneNames(heading.String())
				heading.Reset()
			}
		}
		j := i + 1
		for ; j < len(rows) && !activationSectionEnd(rows[j]); j++ {
			text := rows[j].text()
			// Table header: a "Dates" cell plus zone-name cells. The table
			// runs to the end of the section.
			if strings.Contains(fold(text), "dates") && looksLikeZoneNames(text) {
				j = readActivationTable(rows, j, &year, named)
				break
			}
			dm := frDateRe.FindStringSubmatch(text)
			if dm == nil {
				// Heading row(s): the zone name(s) for the schedule that
				// follows. A name list can wrap across rows, so accumulate the
				// text (including a bare wrapped tail like "ALPHA") and split it
				// into names only at the next date row. A heading after a date
				// row starts a fresh group.
				tail := heading.Len() > 0 && !sawDate && nameTailRe.MatchString(strings.TrimSpace(text))
				if looksLikeZoneNames(text) || tail {
					if sawDate {
						curNames, sawDate = nil, false
					}
					heading.WriteString(" ")
					heading.WriteString(text)
				}
				continue
			}
			if strings.Contains(fold(text), "inactif") {
				continue // a deactivation note, not an activation
			}
			flush()
			date := parseFrDate(dm, &year)
			if date == "" {
				continue
			}
			// A second date in the same bullet is the end of a range.
			dateTo := ""
			if all := frDateRe.FindAllStringSubmatch(text, -1); len(all) >= 2 {
				dateTo = parseFrDate(all[1], &year)
			}
			// Bullet: strip the date(s) so the year is not read as a time.
			// A bullet can list several windows for one date ("0800-1200 et
			// 1330-1700"): one activation per window, all-day when none.
			acts := []activation{{date: date, dateTo: dateTo}}
			if trs := timeRangeRe.FindAllStringSubmatch(frDateRe.ReplaceAllString(text, "  "), -1); len(trs) > 0 {
				acts = acts[:0]
				for _, tr := range trs {
					acts = append(acts, activation{date, dateTo, hhmm(tr[1]), hhmm(tr[2])})
				}
			}
			sawDate = true
			if len(curNames) == 0 {
				unnamed = append(unnamed, acts...)
				continue
			}
			for _, n := range curNames {
				named.add(n, acts...)
			}
		}
		i = j
	}
	return named, unnamed
}

// readActivationTable reads one schedule table, its header at rows[h]: a
// "Dates" cell and one cell per zone, then a row per date. It returns the
// index of the row that ends the section, which ends the table too.
//
// A cell can hold several windows, set one per line and centred on its date
// row (216/2026: "0900 - 1300" above the date, "1400 - 1800" on it, "1800 -
// 2100" below), so a window on a row with no date belongs to the date row
// nearest it on the page, whichever side it sits; the cell padding between
// two dates is wider than the line pitch inside one, which is what keeps
// that unambiguous. A window as near one date as another goes to both: the
// zone drawn in a window it may not hold, never missing from one it does.
// Reading only the date's own row lost every other window (CENTRE's second
// and third, TARN's every one) and drew a zone the table activates as
// inactive.
//
// A header cell can wrap onto the row below ("ZRT BELMONT -" over "TARN"):
// a row of capitals with no date and no window before the first date
// continues the names of the columns nearest its cells.
func readActivationTable(rows []prow, h int, year *int, named *namedActs) int {
	colName := map[float64]string{}
	var colXs []float64
	dateX, haveDateX := 0.0, false
	for _, c := range rows[h].cells {
		if strings.HasPrefix(fold(c.text), "dates") && !looksLikeZoneNames(c.text) {
			dateX, haveDateX = c.x, true
			continue
		}
		if looksLikeZoneNames(c.text) {
			colName[c.x] = c.text
			colXs = append(colXs, c.x)
		}
	}
	end := h + 1
	for end < len(rows) && !activationSectionEnd(rows[end]) {
		end++
	}
	if len(colXs) == 0 {
		return end
	}
	k := h + 1
	for ; k < end && isHeaderContinuation(rows[k]); k++ {
		for _, c := range rows[k].cells {
			cx := nearestX(colXs, c.x)
			colName[cx] += c.text
		}
	}
	// inDateColumn: a cell nearer the "Dates" header than any zone column
	// is the date cell, never a window.
	inDateColumn := func(x float64) bool {
		return haveDateX && absf(x-dateX) < absf(x-nearestX(colXs, x))
	}
	type dated struct {
		y            float64
		date, dateTo string
	}
	var dates []dated
	for r := k; r < end; r++ {
		text := rows[r].text()
		dm := frDateRe.FindStringSubmatch(text)
		if dm == nil || strings.Contains(fold(text), "inactif") {
			continue
		}
		date := parseFrDate(dm, year)
		if date == "" {
			continue
		}
		dateTo := ""
		if all := frDateRe.FindAllStringSubmatch(text, -1); len(all) >= 2 {
			dateTo = parseFrDate(all[1], year)
		}
		dates = append(dates, dated{rows[r].y, date, dateTo})
	}
	if len(dates) == 0 {
		return end
	}
	// windows[d] holds date d's windows in page order, per column.
	type window struct {
		col      float64
		from, to string
	}
	windows := make([][]window, len(dates))
	for r := k; r < end; r++ {
		var found []window
		for _, c := range rows[r].cells {
			if inDateColumn(c.x) {
				continue
			}
			bare := frDateRe.ReplaceAllString(c.text, "  ")
			for _, tr := range timeRangeRe.FindAllStringSubmatch(bare, -1) {
				found = append(found, window{nearestX(colXs, c.x), hhmm(tr[1]), hhmm(tr[2])})
			}
		}
		if len(found) == 0 {
			continue
		}
		best := math.Inf(1)
		for _, d := range dates {
			best = math.Min(best, absf(rows[r].y-d.y))
		}
		for di, d := range dates {
			if absf(rows[r].y-d.y) <= best+0.5 {
				windows[di] = append(windows[di], found...)
			}
		}
	}
	for di, d := range dates {
		for _, w := range windows[di] {
			named.add(colName[w.col], activation{d.date, d.dateTo, w.from, w.to})
		}
	}
	return end
}

// isHeaderContinuation reports a schedule table header's wrapped second
// line: capitals only (nameTailRe, cell by cell), no date and no window.
func isHeaderContinuation(r prow) bool {
	if len(r.cells) == 0 || frDateRe.MatchString(r.text()) || timeRangeRe.MatchString(r.text()) {
		return false
	}
	for _, c := range r.cells {
		if !nameTailRe.MatchString(strings.TrimSpace(c.text)) {
			return false
		}
	}
	return true
}

func nearestX(xs []float64, x float64) float64 {
	best, bd := xs[0], absf(x-xs[0])
	for _, c := range xs[1:] {
		if d := absf(x - c); d < bd {
			best, bd = c, d
		}
	}
	return best
}

func absf(x float64) float64 {
	if x < 0 {
		return -x
	}
	return x
}

// normalizeName collapses a zone name to lower-case alphanumerics so a jammed
// activation heading matches the prettified zone name.
func normalizeName(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// attachActivations gives each zone its schedule: by matching name where the
// block named one, else the un-named windows for any zone still without one
// (a single-zone supplement).
func attachActivations(zones []zone, named *namedActs, unnamed []activation) {
	byNorm := map[string][]activation{}
	for _, n := range named.order {
		k := normalizeName(n)
		byNorm[k] = append(byNorm[k], named.acts[n]...)
	}
	for i := range zones {
		if acts, ok := byNorm[normalizeName(zones[i].name)]; ok {
			zones[i].activations = acts
		}
	}
	if len(unnamed) == 0 {
		return
	}
	for i := range zones {
		if len(zones[i].activations) == 0 {
			zones[i].activations = unnamed
		}
	}
}
