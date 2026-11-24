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
// zone that has no named schedule. Dates are French ("11 juin 2026", or "les
// 10 et 11 juin" for days sharing a month), and times are UTC ranges
// ("1200-1800", "de 1200 à 1800", "de 11h00 à 14h00"). A "Du <date> au
// <date>" range keeps both ends, and a row can hold several (dateRanges). A
// date bullet's windows are the ranges on its own row and on the hours rows
// under it ("- Activable de 0200 à 0400"), each run of dates on the row
// taking the hours printed after it (dateGroups), and a remark wrapped onto
// the next row is the bullet's own. A zone line ("- ZRT 'Low' Coulommiers :
// 0800-1930") names its zone and carries that zone's own hours for the
// bullet that follows. A season note moves the summer days an hour earlier
// (summerSplit): "(ETE : -1HR)" on a bullet, a zone line or before the
// section's first date, or the reverse "(HIV +1HR)".

package main

import (
	"fmt"
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// activation is one scheduled window for a zone. date is YYYY-MM-DD; dateTo is
// set for a "Du <date> au <date>" range, else empty. from / to are "HH:MM"
// UTC, empty for an all-day / unspecified window.
type activation struct {
	date   string
	dateTo string
	from   string
	to     string
	// sunFrom and sunTo are an end the sun sets, a sunCode ("SS+30",
	// "SR-120"). The clock end beside one is empty, or a bound the schedule
	// prints too: the latest close ("MAX 1930"), or its stretch's opening or
	// close on that stretch's end days.
	sunFrom, sunTo string
	dayRule
	// envelope marks a range from a bullet sending the reader to hours
	// printed elsewhere ("Du 19 février 2026 à 0000 au 16 janvier 2027 à
	// 2359 - Voir détail des horaires ci-dessus", 017/2026): it holds a zone
	// only when the zone has no other schedule (attachActivations).
	envelope bool
	// status is how its period holds (status.go): activable or by NOTAM,
	// and the notice an activation is announced at. The zero status is
	// firm.
	status status
	// season is a standing rule's season note: a rule printed with no dates
	// holds over its supplement's validity, which the reader of the rule
	// splits at the clock changes. A dated activation is split already.
	season seasonNote
	// cuts are the ends of its window that a weekly stretch's day boundary
	// makes (weeklyWindows): midnights a season note never moves.
	cuts cutEnds
	// dayShift is the days a season note moved its window's opening by
	// across midnight, which its weekdays follow (moved).
	dayShift int
}

// cutEnds marks the ends of a window a weekly stretch's day boundary makes.
type cutEnds uint8

const (
	cutOpen  cutEnds = 1 << iota // the last day's opening at 00:00
	cutClose                     // the first day's close at 24:00
)

// stretchCuts returns the ends of a weekly stretch's window w that are its
// day boundaries: its first day closing at 24:00, its last day opening at
// 00:00.
func stretchCuts(w [2]string) cutEnds {
	var c cutEnds
	if w[0] == "00:00" {
		c |= cutOpen
	}
	if w[1] == "24:00" {
		c |= cutClose
	}
	return c
}

// A dayRule is which of a range's days a schedule holds: the weekdays it
// prints ("tous les jours sauf Samedi, Dimanche et jours fériés", "du lundi
// au vendredi", "uniquement le Mardi, Jeudi"), off the French public
// holidays ("sauf JF") and off the eves of them ("hors veilles de jours
// fériés"). The zero rule holds every day.
type dayRule struct {
	days           daySet
	exceptHolidays bool
	exceptEves     bool
}

// A daySet holds weekdays, bit d for ISO weekday d (Monday 1 to Sunday 7),
// and none for every day.
type daySet uint8

const everyDay daySet = 0xfe

// isoDays returns the set's ISO weekdays in order.
func (s daySet) isoDays() []int {
	var out []int
	for d := 1; d <= 7; d++ {
		if s&(1<<d) != 0 {
			out = append(out, d)
		}
	}
	return out
}

// or returns r, or q where r says nothing.
func (r dayRule) or(q dayRule) dayRule {
	if r != (dayRule{}) {
		return r
	}
	return q
}

// moved returns r for a window whose opening a season note moved n days,
// its weekdays moved with it: "0000-0400 du lundi au vendredi (ETE : -1HR)"
// opens from Sunday to Thursday at 23:00 in summer. The holidays it excepts
// are read on the day the window opens.
func (r dayRule) moved(n int) dayRule {
	r.days = r.days.moved(n)
	return r
}

// moved returns s with each weekday n days later, n < 0 earlier.
func (s daySet) moved(n int) daySet {
	if s == 0 || n%7 == 0 {
		return s
	}
	var out daySet
	for d := 1; d <= 7; d++ {
		if s&(1<<d) != 0 {
			out |= 1 << ((d-1+n%7+7)%7 + 1)
		}
	}
	return out
}

var (
	// dayNameRe is a weekday named whole, singular or plural, spaced or
	// jammed ("saufSamedi,Dimanche").
	dayNameRe = regexp.MustCompile(`(?i)(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)s?`)
	// dayRangeRe is a run of weekdays: "du lundi au vendredi", "du dimanche
	// soir au samedi matin" (177/2026), "Lundi-jeudi", "LUN-VEN", "Lun-ven". A short name reads only in such a run: "MAR" is
	// March too, "MER" the sea, and "SAM" the CAR/SAM/NAM region.
	dayRangeRe = regexp.MustCompile(`(?i:du\s*(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\s*(?:soir|matin|midi)?\s*au\s*(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche))|(?i:(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\s*[-–]\s*(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche))|(LUN|MAR|MER|JEU|VEN|SAM|DIM|Lun|Mar|Mer|Jeu|Ven|Sam|Dim)\s*[-–]\s*(LUN|MAR|MER|JEU|VEN|SAM|DIM|lun|mar|mer|jeu|ven|sam|dim|Lun|Mar|Mer|Jeu|Ven|Sam|Dim)`)
	// dayOfMonthRe opens a date's day after its weekday: one or two digits,
	// "1er" among them, and never a time's four.
	dayOfMonthRe = regexp.MustCompile(`^[\s.]*\d{1,2}(?:\s*er)?(?:[^\dh:]|$)`)
	// weekendRe, holidayRe and eveRe are the other days a clause takes off.
	weekendRe = regexp.MustCompile(`(?i)week[-\s]?end`)
	holidayRe = regexp.MustCompile(`(?i)jours?\s*f[ée\x{FFFD}]ri[ée\x{FFFD}]s|JF`)
	eveRe     = regexp.MustCompile(`(?i)veilles?\s*(?:de|des)\s*jours?\s*f[ée\x{FFFD}]ri[ée\x{FFFD}]s`)
	// weeklyRe is a stretch from one weekday's time to another's, held each
	// week: "du lundi 10h00 au vendredi 10h00" (166/2026), "du LUN 0500 au VEN
	// 1100" (088/2025).
	weeklyRe = regexp.MustCompile(`(?i)du\s*(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|lun|mar|mer|jeu|ven|sam|dim)\.?\s*(\d{1,2}[h:]\d{2}|\d{4})\s*au\s*(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|lun|mar|mer|jeu|ven|sam|dim)\.?\s*(\d{1,2}[h:]\d{2}|\d{4})`)
)

// isoDay is a weekday's ISO number, whole or short.
func isoDay(name string) int {
	switch strings.ToLower(name)[:3] {
	case "lun":
		return 1
	case "mar":
		return 2
	case "mer":
		return 3
	case "jeu":
		return 4
	case "ven":
		return 5
	case "sam":
		return 6
	case "dim":
		return 7
	}
	return 0
}

// weekRun is the weekdays from a to b, round the week's end when b comes
// before a.
func weekRun(a, b int) daySet {
	var s daySet
	for d := a; ; d = d%7 + 1 {
		s |= 1 << d
		if d == b {
			return s
		}
	}
}

// ruleIn reads the day rule text prints, if any. A weekday it names inside
// a clause taking days off (exclusionSpans) is off, one outside it on, and
// one before a day of the month is a date's ("du samedi 19 décembre"). A
// stretch held each week is its windows' (weeklyWindows), no rule's.
// "jours fériés" and their eves are off inside such a clause.
func ruleIn(text string) (dayRule, bool) {
	var on, off daySet
	var r dayRule
	spans := exclusionSpans(text)
	inSpan := func(at int) bool {
		_, ok := spanAt(spans, at)
		return ok
	}
	// A weekday before a day of the month is a date's ("du samedi 19
	// décembre"), never one before a time ("Lundi-vendredi 0630-1430",
	// 092/2026).
	beforeDay := func(end int) bool {
		m := dayOfMonthRe.FindStringSubmatch(text[end:])
		return m != nil
	}
	used := make([]bool, len(text))
	for _, m := range weeklyRe.FindAllStringIndex(text, -1) {
		for i := m[0]; i < m[1]; i++ {
			used[i] = true
		}
	}
	for _, m := range dayRangeRe.FindAllStringSubmatchIndex(text, -1) {
		if used[m[0]] || beforeDay(m[1]) {
			continue
		}
		var a, b int
		for g := 1; g+1 < len(m)/2; g += 2 {
			if m[2*g] >= 0 {
				a, b = isoDay(text[m[2*g]:m[2*g+1]]), isoDay(text[m[2*g+2]:m[2*g+3]])
				break
			}
		}
		if a == 0 || b == 0 {
			continue
		}
		if inSpan(m[0]) {
			off |= weekRun(a, b)
		} else {
			on |= weekRun(a, b)
		}
		for i := m[0]; i < m[1]; i++ {
			used[i] = true
		}
	}
	for _, m := range dayNameRe.FindAllStringSubmatchIndex(text, -1) {
		if used[m[0]] || beforeDay(m[1]) {
			continue
		}
		d := isoDay(text[m[2]:m[3]])
		if inSpan(m[0]) {
			off |= 1 << d
		} else {
			on |= 1 << d
		}
	}
	for _, m := range eveRe.FindAllStringIndex(text, -1) {
		if inSpan(m[0]) {
			r.exceptEves = true
			for i := m[0]; i < m[1]; i++ {
				used[i] = true
			}
		}
	}
	for _, m := range weekendRe.FindAllStringIndex(text, -1) {
		if inSpan(m[0]) {
			off |= 1<<6 | 1<<7
		}
	}
	for _, m := range holidayRe.FindAllStringIndex(text, -1) {
		if used[m[0]] || !inSpan(m[0]) {
			continue
		}
		if text[m[0]:m[1]] == "JF" && m[0] > 0 && 'A' <= text[m[0]-1] && text[m[0]-1] <= 'Z' {
			continue
		}
		r.exceptHolidays = true
	}
	if on == 0 && off == 0 && !r.exceptHolidays && !r.exceptEves {
		return dayRule{}, false
	}
	if on == 0 {
		on = everyDay
	}
	if r.days = on &^ off; r.days == everyDay {
		r.days = 0
	}
	return r, true
}

// weeklyWindows reads a stretch held each week ("du lundi 10h00 au vendredi
// 10h00") as windows on its weekdays: its first day from its opening, the
// days between whole, its last day to its close.
func weeklyWindows(text string) (ws [][2]string, rules map[[2]string]dayRule) {
	m := weeklyRe.FindStringSubmatch(text)
	if m == nil {
		return nil, nil
	}
	a, b := isoDay(m[1]), isoDay(m[3])
	open, close := hhmm(m[2]), hhmm(m[4])
	if a == 0 || b == 0 || a == b || open == "" || close == "" {
		return nil, nil
	}
	rules = map[[2]string]dayRule{}
	add := func(w [2]string, days daySet) {
		ws = append(ws, w)
		rules[w] = dayRule{days: days}
	}
	add([2]string{open, "24:00"}, 1<<a)
	if between := weekRun(a, b) &^ (1<<a | 1<<b); between != 0 {
		add([2]string{"00:00", "24:00"}, between)
	}
	add([2]string{"00:00", close}, 1<<b)
	return ws, rules
}

var frMonths = map[string]int{
	"janvier": 1, "fevrier": 2, "fevier": 2, "mars": 3, "avril": 4, "mai": 5, "juin": 6,
	"juillet": 7, "aout": 8, "septembre": 9, "octobre": 10, "novembre": 11,
	"decembre": 12,
}

// weekdays are the days a schedule may name before a date.
const weekdays = `lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche`

var (
	// The accented months (février, août, décembre) often come through with
	// their accent as U+FFFD, the SIA fonts' unmapped-glyph stand-in, and
	// 002/2026 prints February as "févier". The first of a month is "1er",
	// which the native reader can print "1 er" ("audimanche1 ermars2200",
	// 003/2026).
	frDateRe = regexp.MustCompile(
		`(?i)(\d{1,2})\s*(?:er\s*)?(janvier|f[eé\x{FFFD}]vr?ier|mars|avril|mai|juin|juillet|ao[uû\x{FFFD}]t|septembre|octobre|novembre|d[eé\x{FFFD}]cembre)\.?\s*(\d{4})?`)
	// The days a row prints without their month, before the date that
	// carries it, each day with what joins it to the next: "les 10 et 11
	// juin" in 110/2026, "16,17,23,24,26 juin" in 119/2026, "mardi 2, jeudi
	// 4 décembre", "du 15 au 18 juin". The minutes of a time ("05h15 au")
	// are no day.
	bareDaysRe = regexp.MustCompile(`(?i)(?:^|[^\d:h])((?:\d{1,2}\s*(?:er)?\s*(?:,|et|au)\s*(?:(?:` + weekdays + `)\s*)?)+)$`)
	bareDayRe  = regexp.MustCompile(`(?i)(\d{1,2})\s*(?:er)?\s*(,|et|au)`)
	// Days a row lists with no month to place them, as 142/2026 prints
	// "actives les 09, 10 et 13 : 10h00-15h30" for July.
	unplacedDaysRe = regexp.MustCompile(`(?i)les\s*\d{1,2}(?:er)?(?:\s*(?:,|et)\s*\d{1,2}(?:er)?)+`)
	// A time range, each end HHMM, HHhMM or HH:MM ("de 11h00 à 14h00",
	// 110/2026, "Tous les jours 08:00-18:00", 132/2026), its separator "-",
	// "à" (or its U+FFFD garble) or "au". The capital H of "H24" is no time.
	timeRangeRe = regexp.MustCompile(`(\d{1,2}[h:]\d{2}|\d{3,4})(?:\s*(?:UTC|Z)\b)?[^\d\n]{1,4}(\d{1,2}[h:]\d{2}|\d{3,4})`)
	// A short all-caps fragment, e.g. the "ALPHA" left when "ZRT X ALPHA"
	// wraps across two rows: a heading continuation with no type token.
	nameTailRe = regexp.MustCompile(`^[A-Z0-9 ./'-]{1,25}$`)
	// AIP France's summer note in each spelling the supplements print:
	// "(ETE : -1HR)", "(été - 1H)", "(SUM -1HR)", "ETE – 1HR", "HOR ETE
	// -1H", "Horaires d'été -01h00", jammed or with the accent garbled to
	// U+FFFD.
	summerRe = regexp.MustCompile(`(?i)(?:[eé\x{FFFD}]t[eé\x{FFFD}]|sum)\s*:?\s*[-–−]\s*0?1\s*h`)
	// Its reverse, times stated in summer UTC and an hour later in winter:
	// "(HIV +1HR)", "HIV + 1HR", "(HIVER H+1)".
	winterRe = regexp.MustCompile(`(?i)hiv(?:er)?\s*:?\s*(?:h\s*)?\+\s*0?1(?:\D|$)`)
	// A zone line: a zone name, a colon, then the zone's own hours.
	zoneLineRe = regexp.MustCompile(`^\s*-?\s*(.*?)\s*:\s*((?:\d{1,2}[h:]\d{2}|\d{3,4})\s*-.*)$`)
	// statusRe opens what follows a zone line's names before its colon:
	// "active", "actives", "activable(s)", "inactive(s)", lower case after
	// a capital, a figure or a space ("ZRT 1 active", "ZRT2activesles09").
	statusRe = regexp.MustCompile(`(?:^|[^a-z])((?:in)?activ(?:es?|ables?))`)
	// A time standing alone, outside any window ("avant 1100 UTC"): a summer
	// note on its row qualifies that time, never the bullet's windows.
	loneTimeRe = regexp.MustCompile(`(?:^|\D)\d{3,4}(?:\D|$)`)
	// What joins the two ends of a range, folded: "au", after the first
	// end's time or before the second's weekday ("à 0700 au", "au dimanche"),
	// "jusqu'au", or the "et" of "entre ... et" ("1 créneau entre 16, 17 et
	// 18 novembre", 231/2026).
	rangeJoinRe = regexp.MustCompile(`(?:(?:^|[^a-z]|jusqu)au(?:` + weekdays + `)?|entre[\d,]*et)$`)
	entreJoinRe = regexp.MustCompile(`entre[\d,]*et$`)
	// gapEndRe is the end a range's first date prints before its join: a
	// clock time or a sun end ("à 0800", "à SR-15").
	gapEndRe = regexp.MustCompile(`^\s*(?:à|a|de|\x{FFFD})?\s*(?:` + sunEnd + `|\d{1,2}[h:]\d{2}|\d{4})(?:\s*UTC)?`)
)

// firstYear returns the year of the first date rows state one for, 0 when
// none does.
func firstYear(rows []prow) int {
	for _, r := range rows {
		text := r.text()
		for _, m := range dateMatches(text, 0) {
			if m[6] >= 0 {
				y, _ := strconv.Atoi(text[m[6]:m[7]])
				return y
			}
		}
	}
	return 0
}

// numericDateRe is a date set in figures, its month two of them:
// "20/01/2026" (006/2026), "26/02" (003/2026), "03/02/26".
var numericDateRe = regexp.MustCompile(`(\d{1,2})/(\d{2})(?:/(\d{4}|\d{2}))?`)

// numericMonths spells a month the way frDateRe reads it.
var numericMonths = [12]string{"janvier", "fevrier", "mars", "avril", "mai", "juin",
	"juillet", "aout", "septembre", "octobre", "novembre", "decembre"}

// spellDates writes the dates s sets in figures as frDateRe reads them,
// "20 janvier 2026" for "20/01/2026", so a schedule printed either way
// reads alike: 010/2026's "Du 03/02/2026 à 23h00 au 04/02/2026 à 02h00"
// and 017/2026's "Du 19/02/2026 au 30/04/2026" held none of their hours. A
// run of figures touching another figure, a slash or a coordinate's marks
// is no date, nor is a day or month out of range, nor a page number ("Page
// 9/12").
func spellDates(s string) string {
	ms := numericDateRe.FindAllStringSubmatchIndex(s, -1)
	if ms == nil {
		return s
	}
	mark := func(r rune) bool { return unicode.IsDigit(r) || strings.ContainsRune("/°º'′’\"″", r) }
	var b strings.Builder
	last := 0
	for _, m := range ms {
		if before, _ := utf8.DecodeLastRuneInString(s[:m[0]]); m[0] > 0 && mark(before) {
			continue
		}
		// A time may follow a four-figure year jammed ("04/02/202603h30",
		// 010/2026), and is set apart from it.
		after, _ := utf8.DecodeRuneInString(s[m[1]:])
		year4 := m[6] >= 0 && m[7]-m[6] == 4
		if m[1] < len(s) && mark(after) && !(year4 && unicode.IsDigit(after)) {
			continue
		}
		if strings.HasSuffix(strings.ToLower(strings.TrimRight(s[:m[0]], " ")), "page") {
			continue
		}
		day, _ := strconv.Atoi(s[m[2]:m[3]])
		mon, _ := strconv.Atoi(s[m[4]:m[5]])
		if day < 1 || day > 31 || mon < 1 || mon > 12 {
			continue
		}
		fmt.Fprintf(&b, "%s%d %s", s[last:m[0]], day, numericMonths[mon-1])
		if m[6] >= 0 {
			y := s[m[6]:m[7]]
			if len(y) == 2 {
				y = "20" + y
			}
			b.WriteString(" " + y)
			if m[1] < len(s) && unicode.IsDigit(after) {
				b.WriteString(" ")
			}
		}
		last = m[1]
	}
	b.WriteString(s[last:])
	return b.String()
}

// spellRows returns rows with their dates spelled (spellDates).
func spellRows(rows []prow) []prow {
	out := make([]prow, len(rows))
	for i, r := range rows {
		cells := make([]cell, len(r.cells))
		for j, c := range r.cells {
			cells[j] = cell{x: c.x, text: spellDates(c.text)}
		}
		out[i] = prow{y: r.y, cells: cells}
	}
	return out
}

// asciiMonth folds accents (and their U+FFFD garbles) so the month map keys
// match.
func asciiMonth(s string) string {
	s = strings.ToLower(s)
	s = strings.NewReplacer(
		"f�vrier", "fevrier",
		"f�vier", "fevier",
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

// dateItem is a date of a schedule row, or a range of two, and where the row
// prints it.
type dateItem struct {
	from, to string // YYYY-MM-DD, to empty for a day of its own
	at       int
	// fromTime and toTime are the clock times a range prints at its ends
	// ("Du 01 juin 2026 à 2100 au 05 juin 2026 à 0300"), "HH:MM", empty for
	// an end that prints none.
	fromTime, toTime string
}

// dateTok is a date of a row, or a day the row prints without its month,
// and whether it is the first end of a range.
type dateTok struct {
	date    string
	at, end int
	au      bool
}

// dateItems reads the dates of a schedule row in order: a date and the next
// are a range when rangeJoinRe joins them ("du ... au ...", "entre ... et
// ..."), and any other date is a day of its own. A day printed without its
// month takes the month of the date that closes its list (bareDays), unless
// that date is the second end of a range from the date before it ("à SR-15
// au 17 octobre", run 003/2026). year carries the last year read, for a date
// that omits it, and a date that cannot be placed is skipped.
func dateItems(text string, year *int) []dateItem {
	var all [][]string
	var at [][2]int
	for _, m := range dateMatches(text, *year) {
		y := ""
		if m[6] >= 0 {
			y = text[m[6]:m[7]]
		}
		all = append(all, []string{text[m[0]:m[1]], text[m[2]:m[3]], text[m[4]:m[5]], y})
		at = append(at, [2]int{m[0], m[1]})
	}
	joined := func(i int) bool {
		if i+1 >= len(all) {
			return false
		}
		gap := text[at[i][1]:at[i+1][0]]
		if !rangeJoinRe.MatchString(fold(gap)) {
			return false
		}
		if entreJoinRe.MatchString(fold(gap)) {
			return true
		}
		// Past a time or a sun end, a day number opens a range of its own
		// ("à 1600 - du 24 au 25 septembre", 205/2026), no join of the two
		// dates.
		if m := gapEndRe.FindStringIndex(gap); m != nil {
			gap = gap[m[1]:]
		}
		return !strings.ContainsAny(gap, "0123456789")
	}
	var toks []dateTok
	end := 0
	for i := range all {
		d := parseFrDate(all[i], year)
		if i == 0 || !joined(i-1) {
			toks = append(toks, bareDays(text[end:at[i][0]], end, all[i][2], year)...)
		}
		toks = append(toks, dateTok{d, at[i][0], at[i][1], joined(i)})
		end = at[i][1]
	}
	var out []dateItem
	for k := 0; k < len(toks); k++ {
		it := dateItem{from: toks[k].date, at: toks[k].at}
		first := k
		for toks[k].au && k+1 < len(toks) {
			k++
			it.to = toks[k].date
		}
		if it.to != "" {
			if m := endTimeRe.FindStringSubmatch(text[toks[first].end:toks[first+1].at]); m != nil && fromEndRe.MatchString(text[toks[first].end:toks[first+1].at]) {
				it.fromTime = hhmm(m[1])
			}
			rest := text[toks[k].end:]
			if k+1 < len(toks) {
				rest = text[toks[k].end:toks[k+1].at]
			}
			if m := endTimeRe.FindStringSubmatch(rest); m != nil && !windowStartRe.MatchString(rest) {
				it.toTime = hhmm(m[1])
			}
		}
		if it.from != "" {
			out = append(out, it)
		}
	}
	return out
}

var (
	// endTimeRe is the clock time a range prints right after one of its
	// dates: "à 2100", "05h00", "de 23h15" (010/2026), the "à" garbled to
	// U+FFFD or jammed.
	endTimeRe = regexp.MustCompile(`^\s*(?:à|a|de|\x{FFFD})?\s*(\d{1,2}[h:]\d{2}|\d{4})(?:\s*UTC)?`)
	// fromEndRe holds when that time ends at the word joining the range's
	// two ends ("à 2100 au", "05h00 au", "de 23h15 au", "2000 au mardi").
	fromEndRe = regexp.MustCompile(`^\s*(?:à|a|de|\x{FFFD})?\s*(?:\d{1,2}[h:]\d{2}|\d{4})(?:\s*UTC)?\s*(?:jusqu.?)?au`)
	// windowStartRe holds when the time after a range's last date opens a
	// window instead ("au 18 juin 1200-1800"), never a count ("à 0300 - 2
	// créneaux").
	windowStartRe = regexp.MustCompile(`^\s*(?:à|a|de|\x{FFFD})?\s*(?:\d{1,2}[h:]\d{2}|\d{4})(?:\s*UTC)?\s*(?:-|–|−|à|a|au|\x{FFFD})\s*(?:\d{1,2}[h:]\d{2}|\d{3,4})`)
)

// plausibleYear reports whether y, read after a date, is that date's year:
// within a year before and three after ctx, the year in force, or from 2010
// to 2039 before one is. Anything else is a clock time after a date printed
// without its year ("lundi 23 février 2000" for 20:00, 003/2026).
func plausibleYear(y, ctx int) bool {
	if ctx == 0 {
		return 2010 <= y && y <= 2039
	}
	return ctx-1 <= y && y <= ctx+3
}

// dateMatches returns the submatch indexes of text's dates as frDateRe
// finds them, a year that is no plausible year (plausibleYear) cut off its
// match and left in the text, a time. year is the year in force before
// text.
func dateMatches(text string, year int) [][]int {
	ms := frDateRe.FindAllStringSubmatchIndex(text, -1)
	for _, m := range ms {
		if m[6] < 0 {
			continue
		}
		if y, err := strconv.Atoi(text[m[6]:m[7]]); err == nil && plausibleYear(y, year) {
			year = y
			continue
		}
		m[1], m[6], m[7] = m[5], -1, -1
	}
	return ms
}

// bareDays reads the days gap prints without their month before a date in
// month mon, each in that month and the year in force, at its place in the
// row, which gap starts at off. "les 10 et 11 juin 2026" (110/2026) holds
// two days, and the date alone would lose 10 June.
func bareDays(gap string, off int, mon string, year *int) []dateTok {
	m := bareDaysRe.FindStringSubmatchIndex(gap)
	if m == nil {
		return nil
	}
	list := gap[m[2]:m[3]]
	var out []dateTok
	for _, d := range bareDayRe.FindAllStringSubmatchIndex(list, -1) {
		out = append(out, dateTok{
			date: parseFrDate([]string{"", list[d[2]:d[3]], mon, ""}, year),
			at:   off + m[2] + d[2],
			end:  off + m[2] + d[3],
			au:   strings.EqualFold(list[d[4]:d[5]], "au"),
		})
	}
	return out
}

// dateRanges reads the dates of a schedule row as ranges, each [date,
// dateTo], dateTo empty for a day of its own (dateItems). A bullet can hold
// several ranges: 005/2026's ZRT « PLOUHARNEL » is activable "Du 27 janvier
// 2026 au 11 juin 2026 et du 15 septembre 2026 au 21 janvier 2027".
func dateRanges(text string, year *int) [][2]string {
	var out [][2]string
	for _, it := range dateItems(text, year) {
		out = append(out, [2]string{it.from, it.to})
	}
	return out
}

// dateGroup is a run of dates a row prints with no hours between them, and
// the windows printed after it, up to the next run.
type dateGroup struct {
	ranges  []dateItem
	windows [][2]string
}

// hhmmWindowRe is a window whose ends print a colon or an h ("08:00-16:30").
var hhmmWindowRe = regexp.MustCompile(`\d{1,2}[h:]\d{2}\s*[-–]\s*\d{1,2}[h:]\d{2}`)

// tailDayRangeRe is a range of days of the month ending a text: "24-25".
var tailDayRangeRe = regexp.MustCompile(`(\d{1,2})\s*-\s*(\d{1,2})\s*$`)

// spellDayRanges writes the ranges of days a bullet sets before their
// hours, with no month ("24-25 08:00-16:30 26-27 10:00-16:00", 205/2026,
// jammed or spaced), as ranges in the month of the date printed last before
// each: "du 24 au 25 septembre 2026 08:00-16:30".
func spellDayRanges(s string, year int) string {
	var b strings.Builder
	last := 0
	for _, w := range hhmmWindowRe.FindAllStringIndex(s, -1) {
		m := tailDayRangeRe.FindStringSubmatchIndex(s[last:w[0]])
		var d1, d2 int
		month := ""
		if m != nil {
			d1, _ = strconv.Atoi(s[last+m[2] : last+m[3]])
			d2, _ = strconv.Atoi(s[last+m[4] : last+m[5]])
			month = monthBefore(s[:last+m[0]], year)
		}
		if month == "" || d1 < 1 || d2 > 31 || d1 >= d2 {
			b.WriteString(s[last:w[1]])
			last = w[1]
			continue
		}
		fmt.Fprintf(&b, "%s du %d au %d %s %s", s[last:last+m[0]], d1, d2, month, s[w[0]:w[1]])
		last = w[1]
	}
	b.WriteString(s[last:])
	return b.String()
}

// monthBefore returns the month and year of the last date s prints, the
// year its own or the running one ("septembre 2026"), or "".
func monthBefore(s string, year int) string {
	ms := frDateRe.FindAllStringSubmatch(s, -1)
	if len(ms) == 0 {
		return ""
	}
	m := ms[len(ms)-1]
	mo := frMonths[asciiMonth(m[2])]
	if mo == 0 {
		return ""
	}
	if m[3] != "" {
		year, _ = strconv.Atoi(m[3])
	}
	if year == 0 {
		return ""
	}
	return fmt.Sprintf("%s %d", numericMonths[mo-1], year)
}

// boundRuns drops the first range of a bullet whose days hold every other
// range, when the ranges after it set the hours, and gives its clock ends to
// the ranges sharing its end days: a stretch over day ranges that set their
// own hours ("Du 24 septembre 2026 à 0800 au 27 septembre 2026 à 1600 -
// 24-25 08:00-16:30 26-27 10:00-16:00", 205/2026). Read with the hours
// after it, every day of the stretch took every range's.
func boundRuns(groups []dateGroup) []dateGroup {
	if len(groups) == 0 || len(groups[0].ranges) == 0 {
		return groups
	}
	end := func(r dateItem) string {
		if r.to == "" {
			return r.from
		}
		return r.to
	}
	outer := groups[0].ranges[0]
	n := 0
	for gi, g := range groups {
		for ri, r := range g.ranges {
			if gi == 0 && ri == 0 {
				continue
			}
			if r.from < outer.from || end(r) > end(outer) {
				return groups
			}
			n++
		}
	}
	// The stretch alone with hours after it has hours of its own.
	if n == 0 || len(groups[0].ranges) == 1 && len(groups[0].windows) > 0 {
		return groups
	}
	out := slices.Clone(groups)
	out[0].ranges = slices.Clone(out[0].ranges[1:])
	if len(out[0].ranges) == 0 {
		out = out[1:]
	}
	for j := range out {
		out[j].ranges = slices.Clone(out[j].ranges)
		for i, r := range out[j].ranges {
			if r.from == outer.from && r.fromTime == "" {
				out[j].ranges[i].fromTime = outer.fromTime
			}
			if end(r) == end(outer) && r.toTime == "" {
				out[j].ranges[i].to, out[j].ranges[i].toTime = end(r), outer.toTime
			}
		}
	}
	return out
}

// dateGroups reads a bullet's text as runs of dates, each with the windows
// printed after it: 110/2026 schedules "les 10 et 11 juin 2026 de 11h00 à
// 14h00 et le 12 juin de 07h00 à 10h00". It also returns every window of the
// text, for a run that prints none, and the dates the text takes off
// (exclusionSpans), which name no run. A window in such a clause stays a
// window: 074/2026's "Activable LUN-VEN sauf JF entre 0700 et 1800" holds
// its hours there. A bullet whose every date it takes off gives those days
// off and no run. A row that prints
// hours before its first date reads in another order, and each of its runs
// keeps no windows of its own. A window never spans a date: "du 15 juin
// 05h00 au 18 juin 01h00" is one stretch, never 05:00 to 01:00 each day.
func dateGroups(text string, year *int) (groups []dateGroup, all [][2]string, off []dateItem) {
	y0 := *year
	items := dateItems(text, year)
	if len(items) == 0 {
		return nil, nil, nil
	}
	spans := exclusionSpans(text)
	var kept []dateItem
	for _, it := range items {
		switch sp, ok := spanAt(spans, it.at); {
		case !ok:
			kept = append(kept, it)
		case !sp.report:
			off = append(off, it)
		}
	}
	if len(kept) == 0 {
		return nil, nil, off
	}
	b := []byte(text)
	for _, m := range dateMatches(text, y0) {
		for i := m[0]; i < m[1]; i++ {
			b[i] = '\n'
		}
	}
	blank := string(b)
	pre := windowsIn(blank[:kept[0].at])
	all = pre
	closed := true
	for k, it := range kept {
		end := len(blank)
		if k+1 < len(kept) {
			end = kept[k+1].at
		}
		ws := windowsIn(blank[it.at:end])
		if closed {
			groups = append(groups, dateGroup{})
		}
		g := &groups[len(groups)-1]
		g.ranges = append(g.ranges, it)
		for _, w := range ws {
			g.windows = appendWindow(g.windows, w)
			all = appendWindow(all, w)
		}
		closed = len(ws) > 0
	}
	if len(pre) > 0 {
		for k := range groups {
			groups[k].windows = nil
		}
	}
	return groups, all, off
}

var (
	// exclusionRe opens a clause naming days a schedule takes off: "sauf",
	// "hors", "à l'exception des", "excepté", "inactives les" (107/2026),
	// spaced or jammed.
	exclusionRe = regexp.MustCompile(`(?i)(?:sauf|hors|l['’]?\s*exception|except[ée]|inacti[fv]|l['’]?\s*exclusion)`)
	// excludedZoneRe is a zone the clause names right after its marker, its
	// type in capitals, jammed or spaced ("saufla ZRTAEROTORSHOW").
	excludedZoneRe = regexp.MustCompile(`^\s*(?i:pour\s*)?(?i:les?|la|l['’])?\s*(?:ZRT|ZDT|ZIT|TRA|TSA|CBA)`)
	// excludedRe closes one: "Jeudi 19 mars 2026 et jeudi 16 avril 2026
	// exclus" (025/2026).
	excludedRe = regexp.MustCompile(`(?i)exclu(?:s|e|es)?(?:[^a-z]|$)`)
	// clauseEndRe ends a clause: a dash set apart by a space (never the
	// hyphen of "week-end" or "LUN-VEN"), a full stop, a semicolon, a closing
	// bracket.
	clauseEndRe = regexp.MustCompile(`\s[-–−]|[-–−]\s|[.;)]`)
	// reportedRe marks a clause about postponing a slot, which takes no day
	// off: "sauf la journée du 1er mars qui ne sera pas reportée" (003/2026).
	reportedRe = regexp.MustCompile(`(?i)report`)
	// reportRe is the 24-hour postponement a schedule allows: "Report
	// possible de 24 heures mêmes horaires", "(report possible 24h, ...)".
	reportRe = regexp.MustCompile(`(?i)report\w*\s*possible\s*(?:de\s*)?24\s*h`)
)

// An exclusion span is a clause a bullet's text takes days off in, from
// its marker to the clause's end, or from the clause's start to "exclus".
type exclusionSpan struct {
	from, to int
	report   bool // about postponing a slot: its dates are neither on nor off
}

// exclusionSpans returns the clauses of text that take days off. A clause
// naming a zone takes the zone out, never days: "Les ZRT sont activables,
// sauf la ZRT AEROTORSHOW ALPHA qui sera active du 27 au 29 juin"
// (126/2026).
func exclusionSpans(text string) []exclusionSpan {
	var out []exclusionSpan
	for _, m := range exclusionRe.FindAllStringIndex(text, -1) {
		if excludedZoneRe.MatchString(text[m[1]:]) {
			continue
		}
		end := len(text)
		if e := clauseEndRe.FindStringIndex(text[m[1]:]); e != nil {
			end = m[1] + e[0]
		}
		out = append(out, exclusionSpan{m[0], end, reportedRe.MatchString(text[m[0]:end])})
	}
	for _, m := range excludedRe.FindAllStringIndex(text, -1) {
		start := 0
		if ends := clauseEndRe.FindAllStringIndex(text[:m[0]], -1); len(ends) > 0 {
			start = ends[len(ends)-1][1]
		}
		out = append(out, exclusionSpan{start, m[0], reportedRe.MatchString(text[start:m[0]])})
	}
	return out
}

// spanAt returns the span holding position at, if one does.
func spanAt(spans []exclusionSpan, at int) (exclusionSpan, bool) {
	for _, sp := range spans {
		if sp.from <= at && at < sp.to {
			return sp, true
		}
	}
	return exclusionSpan{}, false
}

// offDays returns every day the dates cover.
func offDays(items []dateItem) map[string]bool {
	days := map[string]bool{}
	for _, it := range items {
		d, err := time.Parse("2006-01-02", it.from)
		if err != nil {
			continue
		}
		last := d
		if it.to != "" {
			if last, err = time.Parse("2006-01-02", it.to); err != nil {
				last = d
			}
		}
		for ; !d.After(last); d = d.AddDate(0, 0, 1) {
			days[d.Format("2006-01-02")] = true
		}
	}
	return days
}

// splitRange returns the runs of r's days that off leaves, each keeping
// r's clock time at an end it shares with r.
func splitRange(r dateItem, off map[string]bool) []dateItem {
	if len(off) == 0 {
		return []dateItem{r}
	}
	first, err := time.Parse("2006-01-02", r.from)
	if err != nil {
		return []dateItem{r}
	}
	last := first
	if r.to != "" {
		if last, err = time.Parse("2006-01-02", r.to); err != nil {
			return []dateItem{r}
		}
	}
	var out []dateItem
	var run *dateItem
	for d := first; !d.After(last); d = d.AddDate(0, 0, 1) {
		day := d.Format("2006-01-02")
		if off[day] {
			run = nil
			continue
		}
		if run == nil {
			out = append(out, dateItem{from: day, at: r.at})
			run = &out[len(out)-1]
			if d.Equal(first) {
				run.fromTime = r.fromTime
			}
		}
		if r.to != "" {
			run.to = day
		}
		if d.Equal(last) {
			run.toTime = r.toTime
		}
	}
	return out
}

// laterDay returns a held a day more, as a 24-hour postponement allows.
func laterDay(a activation) activation {
	end := a.dateTo
	if end == "" {
		end = a.date
	}
	a.dateTo = nextDay(end)
	return a
}

// hhmm turns an HHMM or HHhMM time into "HH:MM", or "" when it is no time
// of day: 205/2026's jammed "16:3026-27" reads as the range 3026 to 2710.
func hhmm(s string) string {
	s = strings.NewReplacer("h", "", ":", "").Replace(s)
	if len(s) == 3 {
		s = "0" + s
	}
	if len(s) != 4 {
		return ""
	}
	h, m := (s[0]-'0')*10+(s[1]-'0'), (s[2]-'0')*10+(s[3]-'0')
	if m > 59 || h > 24 || (h == 24 && m > 0) {
		return ""
	}
	return s[:2] + ":" + s[2:]
}

// sunRangeRe is a window the sun bounds at one end or both: "1300-SS",
// "SS+30 à SR-30", "SR à SS-1HR", "SR+2HR -SS", "SS moins 02h00 - SS",
// "0800-CS+30, MAX 1930" (SR and SS, or LS and CS in French, each with an
// offset in minutes or hours, and the latest close it prints). Its ends join as a clock window's do, and
// a "/" joins none: 031/2026's "SR / SS" is a remark.
var sunRangeRe = regexp.MustCompile(`(` + sunEnd + `|` + clockEnd + `)(?:\s*(?:UTC|Z)\b)?\s*(?:-|–|−|à|au|a|\x{FFFD})\s*(` +
	sunEnd + `|` + clockEnd + `)(?:\s*,?\s*MAX\s*(` + clockEnd + `))?`)

const (
	sunEnd   = `(?:SR|SS|LS|CS)(?:\s*(?:[+-]|plus|moins)\s*\d{1,3}(?:h\d{2})?\s*(?:HR?|MIN)?)?`
	clockEnd = `\d{1,2}[h:]\d{2}|\d{3,4}`
)

// sunOffsetRe is the offset a sun end prints: "+30", "-1HR", "+2HR", "plus
// 02h00", "moins 02h00", in minutes or in hours.
var sunOffsetRe = regexp.MustCompile(`(?i)^\s*([+-]|plus|moins)\s*(\d{1,3})(h\d{2}|\s*HR?)?`)

// sunCode writes a sun end as its event and its signed offset in minutes:
// "SR", "SS+30", "SR-120". LS and CS (lever and coucher du soleil) are SR and
// SS.
func sunCode(s string) string {
	ev := "SR"
	if strings.HasPrefix(s, "SS") || strings.HasPrefix(s, "CS") {
		ev = "SS"
	}
	m := sunOffsetRe.FindStringSubmatch(s[2:])
	if m == nil {
		return ev
	}
	n, _ := strconv.Atoi(m[2])
	if u := strings.ToUpper(strings.TrimSpace(m[3])); strings.HasPrefix(u, "H") {
		n *= 60
		if len(u) == 3 && u[1] >= '0' && u[1] <= '9' {
			mm, _ := strconv.Atoi(u[1:])
			n += mm
		}
	}
	if n == 0 {
		return ev
	}
	sign := "+"
	if m[1] == "-" || strings.EqualFold(m[1], "moins") {
		sign = "-"
	}
	return ev + sign + strconv.Itoa(n)
}

// dayOnlyRe and nightOnlyRe are a schedule held by day or by night alone,
// sunrise to sunset or the reverse: 108/2026's "ACTIVABLE DE JOUR
// UNIQUEMENT", the ICAO HJ and HN.
var (
	dayOnlyRe   = regexp.MustCompile(`(?i:de\s*jour\s*(?:uniquement|seulement))|(?:^|[^A-Za-z])HJ(?:[^A-Za-z]|$)`)
	nightOnlyRe = regexp.MustCompile(`(?i:de\s*nuit\s*(?:uniquement|seulement))|(?:^|[^A-Za-z])HN(?:[^A-Za-z]|$)`)
)

// isSunCode reports whether a window's end is a sunCode.
func isSunCode(s string) bool {
	return strings.HasPrefix(s, "SR") || strings.HasPrefix(s, "SS")
}

// isSunEnd reports whether a window's end is the sun's.
func isSunEnd(s string) bool {
	for _, p := range []string{"SR", "SS", "LS", "CS"} {
		if strings.HasPrefix(s, p) {
			return true
		}
	}
	return false
}

// windowsIn reads the windows of s, its dates already blanked, in the order
// s prints them, and skips a range either end of which is no time of day. A
// window the sun bounds reads to the edge of the day it could reach: from
// 00:00 for an opening at sunrise or sunset, to 24:00 or the latest close it
// prints for a close, so that it holds every day's sun.
func windowsIn(s string) [][2]string {
	type found struct {
		at int
		w  [2]string
	}
	var ws []found
	var sunSpans [][2]int
	for _, m := range sunRangeRe.FindAllStringSubmatchIndex(s, -1) {
		a, b := s[m[2]:m[3]], s[m[4]:m[5]]
		sa, sb := isSunEnd(a), isSunEnd(b)
		if !sa && !sb {
			continue
		}
		from, to := hhmm(a), hhmm(b)
		if sa {
			from = sunCode(a)
		}
		if sb {
			to = sunCode(b)
			if m[6] >= 0 {
				if c := hhmm(s[m[6]:m[7]]); c != "" {
					to += " " + c
				}
			}
		}
		sunSpans = append(sunSpans, [2]int{m[0], m[1]})
		if from != "" && to != "" {
			ws = append(ws, found{m[0], [2]string{from, to}})
		}
	}
	for _, m := range dayOnlyRe.FindAllStringSubmatchIndex(s, -1) {
		ws = append(ws, found{m[0], [2]string{"SR", "SS"}})
	}
	for _, m := range nightOnlyRe.FindAllStringSubmatchIndex(s, -1) {
		ws = append(ws, found{m[0], [2]string{"SS", "SR"}})
	}
	for _, m := range timeRangeRe.FindAllStringSubmatchIndex(s, -1) {
		if slices.ContainsFunc(sunSpans, func(sp [2]int) bool { return m[0] < sp[1] && sp[0] < m[1] }) {
			continue
		}
		from, to := hhmm(s[m[2]:m[3]]), hhmm(s[m[4]:m[5]])
		if from == "" || to == "" {
			continue
		}
		ws = append(ws, found{m[0], [2]string{from, to}})
	}
	slices.SortStableFunc(ws, func(x, y found) int { return x.at - y.at })
	var out [][2]string
	for _, f := range ws {
		out = appendWindow(out, f.w)
	}
	return out
}

// appendWindow appends w unless ws holds it already: 012/2026 restates its
// bullet's "0900-1600" on the line under it to add the summer note.
func appendWindow(ws [][2]string, w [2]string) [][2]string {
	for _, x := range ws {
		if x == w {
			return ws
		}
	}
	return append(ws, w)
}

// summerSplit applies AIP France's summer note to a: the times it publishes
// are winter UTC, and in summer an hour is withdrawn from them (GEN 2.1.2,
// "0700-1600 UTC (ETE : -1 HR)"). Summer time runs from 01:00 UTC on the last
// Sunday of March to 01:00 UTC on the last Sunday of October, the rule
// route/airspaceHours.ts isSummerUtc reads for the app. A day takes the
// summer window when it opens and closes in summer and the winter one when
// both ends fall in winter. The night the clocks change inside takes both,
// from the earlier opening to the later close. Runs of days read the same
// way come back as one activation each, in date order, and a summer window
// that opens before midnight opens the evening before, its weekdays with it
// (dayShift). An all-day window, or one of 23 hours or more, keeps no hours
// to shift and comes back whole, and an end a weekly stretch's day boundary
// makes stays where it is (cuts): "du lundi 11h00 au vendredi 11h00
// (horaires été : - 01h00)" runs from Monday 10:00 to Friday 10:00, its
// Friday from 00:00.
func summerSplit(a activation) []activation {
	from, ok1 := clockMin(a.from)
	to, ok2 := clockMin(a.to)
	first, err := time.Parse("2006-01-02", a.date)
	if !ok1 || !ok2 || err != nil {
		return []activation{a}
	}
	last := first
	if a.dateTo != "" {
		if last, err = time.Parse("2006-01-02", a.dateTo); err != nil {
			return []activation{a}
		}
	}
	dur := (to - from + 1440) % 1440
	if dur == 0 {
		dur = 1440
	}
	if dur >= 23*60 {
		return []activation{a}
	}
	// A day's reading: its window opens open minutes after its 00:00 UTC and
	// closes shift minutes before the winter close.
	type reading struct{ open, shift int }
	var out []activation
	var run reading
	var runFrom, runTo time.Time
	have := false
	for d := first; !d.After(last); d = d.AddDate(0, 0, 1) {
		at := func(min int) time.Time { return d.Add(time.Duration(min) * time.Minute) }
		r := reading{from, 0}
		switch {
		case isSummerUTC(at(from-60)) && isSummerUTC(at(from-60+dur)):
			r = reading{from - 60, 60}
		case isSummerUTC(at(from)) || isSummerUTC(at(from+dur)):
			// The change falls inside the window: the summer opening, the
			// winter close.
			r = reading{from - 60, 0}
		}
		if a.cuts&cutOpen != 0 {
			r.open = from
		}
		if a.cuts&cutClose != 0 {
			r.shift = 0
		}
		if have && r == run {
			runTo = d
			continue
		}
		if have {
			out = append(out, runActivation(a, runFrom, runTo, run.open, from+dur-run.shift))
		}
		run, runFrom, runTo, have = r, d, d, true
	}
	if have {
		out = append(out, runActivation(a, runFrom, runTo, run.open, from+dur-run.shift))
	}
	return out
}

// runActivation is a's reading for the days first to last, its window
// opening open and closing end minutes after each day's 00:00 UTC (dayRun),
// its weekdays moved with an opening on the day before.
func runActivation(a activation, first, last time.Time, open, end int) activation {
	b := a.as(dayRun(first, last, open, end))
	if open < 0 {
		b.dayShift--
		b.dayRule = b.dayRule.moved(-1)
	}
	return b
}

// dayRun is the activation for the days first to last whose window opens
// open minutes and closes end minutes after each day's 00:00 UTC, either of
// which may fall on the day before or after.
func dayRun(first, last time.Time, open, end int) activation {
	if open < 0 {
		first, last = first.AddDate(0, 0, -1), last.AddDate(0, 0, -1)
		open, end = open+1440, end+1440
	}
	a := activation{date: first.Format("2006-01-02"), from: clock(open), to: clock(end % 1440)}
	if !last.Equal(first) {
		a.dateTo = last.Format("2006-01-02")
	}
	return a
}

// isSummerUTC reports whether t falls in European summer time.
func isSummerUTC(t time.Time) bool {
	y := t.Year()
	return !t.Before(summerChange(y, time.March)) && t.Before(summerChange(y, time.October))
}

// summerChange is 01:00 UTC on the last Sunday of month m.
func summerChange(year int, m time.Month) time.Time {
	t := time.Date(year, m+1, 0, 1, 0, 0, 0, time.UTC)
	return t.AddDate(0, 0, -int(t.Weekday()))
}

// clockMin reads "HH:MM" as minutes after midnight.
func clockMin(s string) (int, bool) {
	if len(s) != 5 || s[2] != ':' {
		return 0, false
	}
	h, err1 := strconv.Atoi(s[:2])
	m, err2 := strconv.Atoi(s[3:])
	if err1 != nil || err2 != nil {
		return 0, false
	}
	return h*60 + m, true
}

// clock writes minutes after midnight as "HH:MM".
func clock(min int) string {
	return fmt.Sprintf("%02d:%02d", min/60, min%60)
}

// activationSectionEnd reports the end of a DATES ET HEURES block: the next
// section's heading, opening its row past its number ("7ORGANISMES
// ÀCONTACTER", 001/2026). A sentence naming the words runs on: 178/2026's
// "avec préavis de 48 h conformément aux dispositions complémentaires"
// carries its bullet's notice. A page break is no end: the caller skips the
// page furniture, and the schedule goes on past it.
func activationSectionEnd(r prow) bool {
	f := strings.TrimLeft(fold(r.text()), "0123456789.-)")
	for _, w := range []string{"conditions", "services", "gestionnaires", "informationdes", "limites", "dispositions", "organismes", "statut", "remarques", "gnralit"} {
		if strings.HasPrefix(f, w) {
			return true
		}
	}
	return false
}

// pageNumbers numbers each row's page. A page's rows run down it, and the
// next page's first row stands above the last one read, in the native
// reader's coordinates (Y up from the foot) and in poppler's (Y down from the
// head, negated) alike.
func pageNumbers(rows []prow) []int {
	page := make([]int, len(rows))
	for i := 1; i < len(rows); i++ {
		page[i] = page[i-1]
		if rows[i].y > rows[i-1].y {
			page[i]++
		}
	}
	return page
}

// The page furniture, folded: the head every page after the first opens on
// ("SUP AIP 211/26 Date de publication : 17 SEP 2026", "AIRAC SUP AIP N°
// 207/25 Date AIRAC : ..."), and a row of the foot that closes every page
// ("FR", "Page 1/3 © SIA", poppler's "Page 1/2 FR").
var (
	rowPageHead = regexp.MustCompile(`^(?:airac)?supaip.*\d+/\d+.*date(?:de)?(?:publication|airac)`)
	rowPageFoot = regexp.MustCompile(`^(?:fr|sia|page\d+/\d+)+$`)
)

// pageFurniture marks the page furniture by its SHAPE and its PLACE, as
// pageFurnitureLines does in the layout text: the head when it is its page's
// first row, and the run of foot rows that ends a page. Over the 2 383 page
// breaks both readers find in the cached corpus, the head opens every page
// bar one sheet that opens on its own text (043/2026), and the foot is two
// rows on every page bar one that prints none (094/2025). A row's words
// alone are never furniture: "équipage" and "découpage" hold "page" once
// folded, and a schedule once ended on them.
func pageFurniture(rows []prow, page []int) []bool {
	furn := make([]bool, len(rows))
	for i := range rows {
		if (i == 0 || page[i] != page[i-1]) && rowPageHead.MatchString(fold(rows[i].text())) {
			furn[i] = true
		}
		if i+1 < len(rows) && page[i+1] == page[i] {
			continue
		}
		for k := i; k >= 0 && page[k] == page[i] && rowPageFoot.MatchString(fold(rows[k].text())); k-- {
			furn[k] = true
		}
	}
	return furn
}

// zoneInitRe marks where each zone name begins: a name-initial area-type token.
// LF-R / LF-D are deliberately excluded; they also appear mid-name (e.g.
// "ZRT AVEL LF-R 17 A 1"), where splitting would shatter the name. Case-
// sensitive: the jammed names are upper-case, so this won't split on a type
// token buried in a lower-case word (the "tra" in "Montreal").
var zoneInitRe = regexp.MustCompile(`(ZRT|ZIT|ZDT|TMA|CTR|CTA|TRA|CBA|SIV)`)

// A nameKey is a name a schedule heading gives, matched to the zones by
// attachActivations.
type nameKey struct {
	text string // the name as printed
	// after is, for a name printed without its type ("BRAVO" in "ZRT RAPACE
	// ALPHA et BRAVO"), the full name before it in its list.
	after string
	// all is "*" for a heading naming every zone ("TOUTES LES ZONES"), or the
	// one type a heading names every zone of ("toutes les ZRT").
	all string
}

// headingKeys reads a schedule heading, its wrapped rows joined, as the
// names it gives. A colon separates its parts ("ZRT activable :", then the
// list 031/2026 prints a row further down), and each part's names start at
// its first type token ("Activation des ZIT PLUGUFFAN, ..."). A whole part is
// one name, for a zone whose own name holds a "/" or an "et" (107/2026's
// "ZRT AUBENAS ALPHA / BRAVO", 003/2026's "ZRT IVO BRETAGNE ALPHA et
// BRAVO"), and each name of its list is another (listItems, and each type
// token opens a name). A name printed without a type token after a full one
// is shorthand for it ("ZRT OLONNE A, B et C", "ZRT 3, 4 et 5"). Names a
// sentence sets in parentheses are no heading's: 125/2026's "activation par
// découpage géographique d'un bloc Ouest (ZRT PIA et ZRT LUCKY), d'un bloc
// Centre (ZRT RAVEN, ...)" gave ZRT RAVEN and ZRT NIET the windows of ZRT
// PIA's heading below it.
func headingKeys(s string) []nameKey {
	s = parenNamesRe.ReplaceAllString(s, " ")
	var keys []nameKey
	for _, part := range strings.Split(s, ":") {
		if loc := zoneInitRe.FindStringIndex(part); loc != nil {
			part = part[loc[0]:]
		}
		part = strings.Trim(part, " .,\t-")
		if part == "" {
			continue
		}
		var items []nameKey
		full := ""
		for _, li := range listItems(part) {
			for _, it := range typeItems(li) {
				if full != "" && !typeStartRe.MatchString(it) {
					items = append(items, nameKey{text: it, after: full})
					continue
				}
				full = it
				items = append(items, nameKey{text: it})
			}
		}
		if len(items) != 1 || items[0].text != part {
			keys = append(keys, nameKey{text: part})
		}
		keys = append(keys, items...)
	}
	return keys
}

// typeItems splits s before each type token, as a jammed list or a prose row
// ending on a name prints them ("ZRTpourraêtreactivée ZRTSEMNOZ"), except a
// token after a "/" that joins two ("ZRT/ZDT ROZ OUEST").
func typeItems(s string) []string {
	var out []string
	start := 0
	for _, loc := range zoneInitRe.FindAllStringIndex(s, -1) {
		i := loc[0]
		if i == start {
			continue
		}
		before := strings.TrimRight(s[:i], " ")
		if strings.HasSuffix(before, "/") && typeEndRe.MatchString(strings.TrimRight(strings.TrimSuffix(before, "/"), " ")) {
			continue
		}
		if it := strings.Trim(s[start:i], " .\t-"); it != "" {
			out = append(out, it)
		}
		start = i
	}
	if it := strings.Trim(s[start:], " .\t-"); it != "" {
		out = append(out, it)
	}
	return out
}

// parenNamesRe is a parenthesized group naming a zone.
var parenNamesRe = regexp.MustCompile(`\([^()]*(?:` + zoneInitRe.String() + `)[^()]*\)`)

// proseRow reports whether a row names a zone inside parentheses it opens
// or closes on another row, as a sentence wrapped over rows does (125/2026's
// "... d'un bloc Ouest (ZRT" over "PIA et ZRT LUCKY), ...").
func proseRow(s string) bool {
	if open := strings.LastIndexByte(s, '('); open >= 0 && !strings.Contains(s[open:], ")") && zoneInitRe.MatchString(s[open:]) {
		return true
	}
	close := strings.IndexByte(s, ')')
	return close >= 0 && !strings.Contains(s[:close], "(") && zoneInitRe.MatchString(s[:close])
}

// typeStartRe matches a name opening on its type token.
var typeStartRe = regexp.MustCompile(`^(?:` + zoneInitRe.String() + `)`)

// The type tokens a "/" can join into one zone's type: "ZRT/ZDT ROZ OUEST",
// "ZRT / ZDT BROMO".
var (
	typeEndRe  = regexp.MustCompile(`(?:ZRT|ZIT|ZDT)$`)
	typeOpenRe = regexp.MustCompile(`^(?:ZRT|ZIT|ZDT)`)
)

// listItems splits a list of zone names at what joins them: a comma, a "/"
// other than one joining two type tokens, and "et" or "ou", set apart by
// spaces or jammed between capitals or digits as the native reader prints
// them ("ZRTSAVOIEetZRTEVIAN", "ZRTOLONNEA,BetC"). The empty items go.
func listItems(s string) []string {
	var out []string
	start := 0
	cut := func(i, n int) {
		if it := strings.Trim(s[start:i], " .\t-"); it != "" {
			out = append(out, it)
		}
		start = i + n
	}
	for i := 0; i < len(s); i++ {
		switch {
		case s[i] == ',':
			cut(i, 1)
		case s[i] == '/':
			if !typeEndRe.MatchString(strings.TrimRight(s[:i], " ")) ||
				!typeOpenRe.MatchString(strings.TrimLeft(s[i+1:], " ")) {
				cut(i, 1)
			}
		case strings.HasPrefix(s[i:], "et") || strings.HasPrefix(s[i:], "ou"):
			spaced := i > 0 && s[i-1] == ' ' && (i+2 == len(s) || s[i+2] == ' ')
			jammed := i > 0 && capOrDigit(s[i-1]) && i+2 < len(s) && capOrDigit(s[i+2])
			if spaced || jammed {
				cut(i, 2)
				i++
			}
		}
	}
	cut(len(s), 0)
	return out
}

func capOrDigit(c byte) bool {
	return 'A' <= c && c <= 'Z' || '0' <= c && c <= '9'
}

// proseWords open the text a heading's name runs into: "activables :", "avec
// préavis de 48h", "sont activables", "actives les 09, 10 et 13".
var proseWords = []string{
	"activ", "sont", "seront", "sera", "est", "avec", "par", "sur", "pendant",
	"lors", "selon", "durant", "uniquement", "pour", "dès", "entre", "en",
	"et", "ou", "à", "au", "du", "des", "de", "le", "la", "les", "qui", "(",
}

// nameReadings returns the readings of a printed name, longest first: the
// name, then the name cut before each word of prose, spaced or jammed onto a
// capital ("BRAVOactivables"). Only a reading that is a zone's whole name
// counts, so a cut inside a real name matches nothing.
func nameReadings(s string) []string {
	out := []string{s}
	for i := len(s) - 1; i > 0; i-- {
		if s[i-1] != ' ' && !capOrDigit(s[i-1]) && s[i] != '(' {
			continue
		}
		for _, w := range proseWords {
			if strings.HasPrefix(s[i:], w) {
				if c := strings.Trim(s[:i], " .,\t-'’"); c != "" && c != out[len(out)-1] {
					out = append(out, c)
				}
				break
			}
		}
	}
	return out
}

// allZonesRe opens a heading that gives its schedule to every zone, or to
// every zone of one type, folded: "TOUTES LES ZONES" (the SIA's template),
// "Toutes zones, sauf ...", "toutes les ZRT sont activables ...", and a type
// with its status alone on its line ("ZRT activable :", 021/2026 and
// 225/2026, read as a zone of that name, gave theirs to none).
var allZonesRe = regexp.MustCompile(`^-?(?:(?:toutes(?:les)?|l'?ensembledes)(zones|zrt|zit|zdt)|(?:les)?(zones|zrt|zit|zdt)(?:/zdt)?s?(?:sont)?activ(?:es?|ables?):?$)`)

// allZonesHeading reports whether text is such a heading, and the type it
// names, "*" for every zone.
func allZonesHeading(text string) (string, bool) {
	m := allZonesRe.FindStringSubmatch(fold(text))
	if m == nil {
		return "", false
	}
	switch t := m[1] + m[2]; t {
	case "zones", "zone":
		return "*", true
	default:
		return strings.ToUpper(t), true
	}
}

// namedActs holds each zone name's activation windows plus the order the
// document first named it. Two spellings of one zone fold to a single zone
// (110/2026 names ZIT LAC once in a list with ZRT SAVOIE and once on its own),
// and folding them in a Go map's iteration order made the merged schedule come
// out in a different order run to run.
type namedActs struct {
	order []nameKey
	acts  map[nameKey][]activation
	// standing holds the rules each name's schedule states with no dates
	// (readSchedules' closeGroup), in standingOrder, and unnamedStanding
	// those of a group naming no zone.
	standingOrder   []nameKey
	standing        map[nameKey][]activation
	unnamedStanding []activation
	// unplaced holds the names a schedule row gives with days it prints
	// no month for (unplacedDays): their zones keep no schedule of part of
	// their days, and draw for the whole validity.
	unplaced map[nameKey]bool
	// stated holds the status a sentence outside the schedules gives the
	// zones it names (statedStatuses), which their firm periods take.
	stated map[nameKey]status
}

func newNamedActs() *namedActs {
	return &namedActs{acts: map[nameKey][]activation{}, standing: map[nameKey][]activation{}, unplaced: map[nameKey]bool{}}
}

// addStanding files rules a schedule states with no dates under a name.
func (n *namedActs) addStanding(k nameKey, acts ...activation) {
	if _, seen := n.standing[k]; !seen {
		n.standingOrder = append(n.standingOrder, k)
	}
	n.standing[k] = append(n.standing[k], acts...)
}

// unplacedDays reports whether a row lists days with no month to place them.
func unplacedDays(text string) bool {
	return !frDateRe.MatchString(text) && unplacedDaysRe.MatchString(text)
}

// add files acts under a name printed whole, as a table's column header is.
func (n *namedActs) add(name string, acts ...activation) {
	n.addKey(nameKey{text: name}, acts...)
}

func (n *namedActs) addKey(k nameKey, acts ...activation) {
	if _, seen := n.acts[k]; !seen {
		n.order = append(n.order, k)
	}
	n.acts[k] = append(n.acts[k], acts...)
}

// zones returns the indexes of the zones k names: every zone, or every zone
// of its type, for an all-zones heading, else the zones whose normalized
// name is one of k's readings, the longest that names one. A shorthand name
// that is no zone's whole name (040/2026's "LFR343L / LFR343M" are) is the
// list's full name before it with its tail replaced: the longest head of
// that name, down to its type token, that reads as a zone with it.
func (k nameKey) zones(zones []zone, byNorm map[string][]int) []int {
	if k.all != "" {
		var out []int
		for i := range zones {
			if k.all == "*" || strings.Contains(zones[i].name, k.all) {
				out = append(out, i)
			}
		}
		return out
	}
	after := normalizeName(k.after)
	for _, r := range nameReadings(k.text) {
		x := normalizeName(r)
		if x == "" {
			continue
		}
		if idx := byNorm[x]; len(idx) > 0 {
			return idx
		}
		if k.after == "" {
			continue
		}
		for n := len(after); n >= 3; n-- {
			if idx := byNorm[after[:n]+x]; len(idx) > 0 {
				return idx
			}
		}
	}
	// A name one "s" from a single zone's is that zone's, misprinted:
	// 003/2026 schedules "LANDES D'OUEE", after "ZRT PENTHIEVRE et", for its
	// ZRT LANDE D'OUEE.
	for _, r := range nameReadings(k.text) {
		x := normalizeName(r)
		if idx := oneS(x, byNorm); len(idx) > 0 {
			return idx
		}
		for n := len(after); n >= 3 && k.after != ""; n-- {
			if idx := oneS(after[:n]+x, byNorm); len(idx) > 0 {
				return idx
			}
		}
	}
	return nil
}

// oneS returns the zones whose folded name is x with one "s" more or less,
// when exactly one name is, and x is long enough to tell names apart.
func oneS(x string, byNorm map[string][]int) []int {
	if len(x) < 8 {
		return nil
	}
	var found []int
	var match string
	for name, idx := range byNorm {
		if name != match && (sDropped(x, name) || sDropped(name, x)) {
			if match != "" {
				return nil
			}
			match, found = name, idx
		}
	}
	return found
}

// sDropped reports whether short is long with one "s" taken out.
func sDropped(long, short string) bool {
	if len(long) != len(short)+1 {
		return false
	}
	for i := range len(long) {
		if long[i] == 's' && long[:i]+long[i+1:] == short {
			return true
		}
	}
	return false
}

// uniqueActivations returns acts with each activation once, in order:
// 200/2026 states its 21 September to 28 October window under its zones'
// names and again under "TOUTES LES ZONES".
func uniqueActivations(acts []activation) []activation {
	var out []activation
	for _, a := range acts {
		if !slices.Contains(out, a) {
			out = append(out, a)
		}
	}
	return out
}

// parseActivations extracts every zone's activation windows, keyed by the
// (jammed) zone name read from the table header, the block heading, or the
// "A / B / ..." name list. unnamed collects windows from a block with no zone
// name, to be applied to single-zone supplements.
// bullet is one dated line of a schedule: the names it applies to, whether
// it opens on a list marker, its dated row with the rows its remark wraps
// onto (dateGroups), the windows of the hours rows under it, and its text
// with the continuation rows that may carry its summer note.
type bullet struct {
	names   []nameKey
	marked  bool
	dates   string
	windows [][2]string
	text    string
	// rule is the day rule its own rows print, and heading the one its
	// heading printed when it opened. windowRules hold the rule an hours
	// row prints for its windows ("- de 0830 à 1000 uniquement le Mardi,
	// Mercredi, Jeudi", 062/2026).
	rule, heading dayRule
	windowRules   map[[2]string]dayRule
	// stretch holds the windows a weekly stretch it prints is cut into
	// (weeklyWindows), whose day boundaries a season note never moves.
	stretch map[[2]string]bool
	// line is the status its zone line prints before the colon, headStatus
	// the one its heading printed when it opened, and windowStatus the one
	// an hours row prints for its windows ("- de 0330 à 0600 - la
	// confirmation d'activation ou annulation se fera par voie de NOTAM
	// préavis 72h", 142/2026).
	line, headStatus status
	windowStatus     map[[2]string]status
	// rows counts the rows added, its dated row first.
	rows int
}

// exceptSlotsRe opens, folded, the slots a bullet takes off: "et sauf
// pendant les créneaux horaires suivants".
var exceptSlotsRe = regexp.MustCompile(`saufpendant(?:les)?(?:cr|plage|heure)`)

// addRow reads what a row of the bullet prints for it: the windows ws its
// hours row holds, each with the day rule the row prints, else the rule
// itself for the bullet, and a stretch it holds each week as windows on
// their weekdays (weeklyWindows).
func (b *bullet) addRow(text string, ws [][2]string) {
	if exceptSlotsRe.MatchString(fold(b.text)) {
		// The slots after "sauf pendant les créneaux horaires suivants"
		// (166/2026) are off: read as windows of activity, they would be the
		// zone's only ones.
		ws = nil
	}
	b.rows++
	// A row without a window under the dated row may finish its clause
	// ("... tous les jours sauf Samedi, Dimanche et jours" over "fériés",
	// 247/2026): the two are read as one for the bullet's rule.
	if b.rows == 2 && len(ws) == 0 {
		if jr, ok := ruleIn(b.text + " " + text); ok {
			b.rule = jr
		}
	}
	r, ok := ruleIn(text)
	st := statusIn(text)
	weekly, rules := weeklyWindows(text)
	for _, w := range weekly {
		b.windows = appendWindow(b.windows, w)
		b.setWindowRule(w, rules[w])
		b.setWindowStatus(w, st)
		if b.stretch == nil {
			b.stretch = map[[2]string]bool{}
		}
		b.stretch[w] = true
	}
	for _, w := range ws {
		b.windows = appendWindow(b.windows, w)
		if ok {
			b.setWindowRule(w, r)
		}
		b.setWindowStatus(w, st)
	}
	if ok && len(ws) == 0 {
		b.rule = b.rule.or(r)
	}
}

func (b *bullet) setWindowRule(w [2]string, r dayRule) {
	if b.windowRules == nil {
		b.windowRules = map[[2]string]dayRule{}
	}
	if _, set := b.windowRules[w]; !set {
		b.windowRules[w] = r
	}
}

func (b *bullet) setWindowStatus(w [2]string, st status) {
	if st == (status{}) {
		return
	}
	if b.windowStatus == nil {
		b.windowStatus = map[[2]string]status{}
	}
	if _, set := b.windowStatus[w]; !set {
		b.windowStatus[w] = st
	}
}

// marked reports whether a schedule row opens on a list marker ("- Du 02
// mars 2026 au 13 mars 2026 ...").
func marked(s string) bool {
	s = strings.TrimSpace(s)
	return strings.HasPrefix(s, "-") || strings.HasPrefix(s, "−")
}

// zoneHours is what a zone line states for its zone alone: its own windows,
// the season note that moves them, and the status it prints before its
// colon ("ZRT 3, 4 et 5 activables les 09, 10 et 13").
type zoneHours struct {
	windows [][2]string
	season  seasonNote
	status  status
}

// seasonNote is how a schedule's times move with the season.
type seasonNote int

const (
	noSeason seasonNote = iota
	// summerEarlier is AIP France's convention (GEN 2.1.2): the times are
	// winter UTC, an hour earlier in summer, "(ETE : -1 HR)".
	summerEarlier
	// winterLater is its reverse: the times are summer UTC, an hour later in
	// winter, "(HIV +1HR)".
	winterLater
)

// seasonIn reads the season note s carries, if any.
func seasonIn(s string) seasonNote {
	switch {
	case summerRe.MatchString(s):
		return summerEarlier
	case winterRe.MatchString(s):
		return winterLater
	}
	return noSeason
}

// or returns n, or m when n says nothing.
func (n seasonNote) or(m seasonNote) seasonNote {
	if n != noSeason {
		return n
	}
	return m
}

// activationsFor turns one bullet's dates and windows into activations, one
// per window and one all-day when there is none, each window moved by the
// season note, the ends cuts marks left where they are.
func activationsFor(date, dateTo string, windows [][2]string, season seasonNote, cuts cutEnds) []activation {
	if len(windows) == 0 {
		return []activation{{date: date, dateTo: dateTo}}
	}
	var out []activation
	for _, w := range windows {
		a := windowActivation(w)
		a.date, a.dateTo, a.cuts = date, dateTo, cuts
		out = append(out, seasoned(a, season)...)
	}
	return out
}

// windowActivation returns a window's ends as an activation's: none for
// the whole day, and an end the sun sets as its sunCode, the clock end
// beside it gone or the latest close printed ("SS+30" with to 19:30 for
// "0800-CS+30, MAX 1930"), so a reader of the clock ends widens it to the
// day.
func windowActivation(w [2]string) activation {
	a := activation{from: w[0], to: w[1]}
	if w == [2]string{"00:00", "24:00"} {
		a.from, a.to = "", ""
	}
	if isSunCode(w[0]) {
		a.sunFrom, a.from = w[0], ""
	}
	if isSunCode(w[1]) {
		f := strings.Fields(w[1])
		a.sunTo, a.to = f[0], ""
		if len(f) > 1 {
			a.to = f[1]
		}
	}
	return a
}

// as returns b with a's sun ends, day rule, status and marks, which a new
// reading of a's days and hours keeps.
func (a activation) as(b activation) activation {
	b.sunFrom, b.sunTo, b.dayRule = a.sunFrom, a.sunTo, a.dayRule
	b.envelope, b.status, b.cuts, b.dayShift = a.envelope, a.status, a.cuts, a.dayShift
	return b
}

// seasoned returns a moved by the season note.
func seasoned(a activation, season seasonNote) []activation {
	switch season {
	case summerEarlier:
		return summerSplit(a)
	case winterLater:
		return summerSplit(hourLater(a))
	}
	return []activation{a}
}

// rangeActivations turns a range and its windows into activations, each
// moved by the season note, then cut to the stretch between the clock
// times the range prints at its ends (clipActivations). The note moves the
// printed times, the ends among them, and never a midnight the cut makes:
// 177/2026 runs "à 0000 au 26 décembre 2026 à 0200 (HIVER H+1)" to 03:00.
// A stretch from 00:00 or to 23:59 holds its end days whole ("Du 01 mai 2026
// à 0000 au 30 avril 2027 à 2359", 077/2026). The ends cuts marks are a
// weekly stretch's day boundaries, which the note leaves in place.
func rangeActivations(r dateItem, windows [][2]string, season seasonNote, cuts cutEnds) []activation {
	to := r.to
	if to == r.from {
		to = ""
	}
	acts := activationsFor(r.from, to, windows, season, cuts)
	if r.fromTime == "00:00" {
		r.fromTime = ""
	}
	if r.toTime == "23:59" || r.toTime == "24:00" {
		r.toTime = ""
	}
	if r.fromTime == "" && r.toTime == "" {
		return acts
	}
	first, err1 := time.Parse("2006-01-02", r.from)
	last, err2 := time.Parse("2006-01-02", r.to)
	if err1 != nil || err2 != nil || last.Before(first) {
		return acts
	}
	n := int(last.Sub(first).Hours() / 24)
	open, close := 0, (n+1)*1440
	if m, ok := clockMin(r.fromTime); ok {
		open = seasonedEnd(first, m, season)
	}
	if m, ok := clockMin(r.toTime); ok {
		close = n*1440 + seasonedEnd(last, m, season)
	}
	if close <= open {
		return acts
	}
	if len(windows) == 0 && n == 1 && close-open < 1440 {
		// A stretch shorter than a day across one midnight: one window
		// over it, as the RTBA convention prints a night.
		to := clock(close - 1440)
		if close == 1440 {
			to = "24:00"
		}
		return []activation{{date: r.from, from: clock(open), to: to}}
	}
	return clipActivations(acts, first, open, close)
}

// seasonedEnd moves a clock time m, printed for day, by the season note.
func seasonedEnd(day time.Time, m int, season seasonNote) int {
	at := day.Add(time.Duration(m) * time.Minute)
	switch {
	case season == summerEarlier && isSummerUTC(at.Add(-time.Hour)):
		return m - 60
	case season == winterLater && !isSummerUTC(at):
		return m + 60
	}
	return m
}

// clipActivations cuts acts to the stretch from open to close, minutes
// after first's 00:00. A window outside the stretch goes and one across an
// end is cut there, and the days a window holds alike run as one
// activation. With no window the stretch is the activation: its end days
// cut, the days between all day. 107/2026's "Du 01 juin 2026 à 2100 au 05
// juin 2026 à 0300" drew five whole days, and its "Activable chaque jour sur
// le créneau 21h00 - 03h00" one night past the stretch.
func clipActivations(acts []activation, first time.Time, open, close int) []activation {
	// A piece is one day's window cut to the stretch, in minutes after that
	// day's 00:00, whole when it is the whole day uncut.
	type piece struct {
		day, from, to int
		whole         bool
	}
	day := func(d int) string { return first.AddDate(0, 0, d).Format("2006-01-02") }
	var out []activation
	for _, a := range acts {
		d0, err1 := time.Parse("2006-01-02", a.date)
		d1 := d0
		var err2 error
		if a.dateTo != "" {
			d1, err2 = time.Parse("2006-01-02", a.dateTo)
		}
		if err1 != nil || err2 != nil {
			out = append(out, a)
			continue
		}
		whole := a.from == "" && a.to == ""
		f, okf := clockMin(a.from)
		t, okt := clockMin(a.to)
		if !whole && (!okf || !okt) {
			out = append(out, a)
			continue
		}
		var ps []piece
		for at := d0; !at.After(d1); at = at.AddDate(0, 0, 1) {
			d := int(at.Sub(first).Hours() / 24)
			s, e := d*1440, (d+1)*1440
			if !whole {
				s, e = d*1440+f, d*1440+t
				if t <= f {
					e += 1440
				}
			}
			cs, ce := max(s, open), min(e, close)
			if cs >= ce {
				continue
			}
			ps = append(ps, piece{d, cs - d*1440, ce - d*1440, whole && cs == s && ce == e})
		}
		for i := 0; i < len(ps); {
			j := i
			for j+1 < len(ps) && ps[j+1].day == ps[j].day+1 && ps[j+1].from == ps[i].from && ps[j+1].to == ps[i].to && ps[j+1].whole == ps[i].whole {
				j++
			}
			c := a.as(activation{date: day(ps[i].day)})
			if j > i {
				c.dateTo = day(ps[j].day)
			}
			if !ps[i].whole {
				c.from = clock(ps[i].from)
				switch to := ps[i].to; {
				case to == 1440:
					c.to = "24:00"
				case to > 1440:
					c.to = clock(to - 1440)
				default:
					c.to = clock(to)
				}
			}
			out = append(out, c)
			i = j + 1
		}
	}
	return out
}

// hourLater moves a's window an hour later, its days and weekdays with it
// when the opening passes midnight: a time stated in summer UTC is its
// winter time less an hour.
func hourLater(a activation) activation {
	from, ok1 := clockMin(a.from)
	to, ok2 := clockMin(a.to)
	if !ok1 || !ok2 {
		return a
	}
	from, to = from+60, to+60
	if from >= 1440 {
		from -= 1440
		a.date = nextDay(a.date)
		if a.dateTo != "" {
			a.dateTo = nextDay(a.dateTo)
		}
		a.dayShift++
		a.dayRule = a.dayRule.moved(1)
	}
	a.from, a.to = clock(from), clock(to%1440)
	return a
}

// nextDay returns the ISO day after iso, or iso when it is no day.
func nextDay(iso string) string {
	t, err := time.Parse("2006-01-02", iso)
	if err != nil {
		return iso
	}
	return t.AddDate(0, 0, 1).Format("2006-01-02")
}

func parseActivations(rows []prow) (named *namedActs, unnamed []activation) {
	// The page furniture is known from the rows as printed, its "Page 9/12"
	// no date.
	page := pageNumbers(rows)
	furn := pageFurniture(rows, page)
	rows = spellRows(rows)
	// The year of the first date the supplement states one for, its cover's
	// "En vigueur" as a rule: a schedule may print its dates without it
	// (003/2026).
	named, unnamed = readSchedules(rows, page, furn, firstYear(rows))
	named.stated = statedStatuses(rows)
	return named, unnamed
}

// statedRe is a sentence saying zones it names may be activated, spaced or
// jammed: "La ZRT SOTAME BRAVO est activable avec un préavis d'une heure,
// uniquement lorsque la ZRT SOTAME ALPHA est active" (162/2026), "Les ZRT
// BUCK ALPHA 1, ALPHA 2, BRAVO 1 et BRAVO 2 sont activables" (166/2026).
var statedRe = regexp.MustCompile(`(?:^|[^\p{L}])L(?:a|es)\s*((?:ZRT|ZDT|ZIT)(?:/Z[DIR]T)?\s*[A-Z0-9][A-Z0-9'’ ,/-]*?(?:\s*et\s*[A-Z0-9][A-Z0-9'’ ,/-]*?)*)\s*(?:est|sont)\s*activables?`)

// statedStatuses returns the status each sentence outside the schedule
// sections gives the zones it names (statedRe), read to the sentence's
// end: 162/2026 states in its DISPOSITIONS COMPLEMENTAIRES what its
// schedule's bare "H24" leaves unsaid.
func statedStatuses(rows []prow) map[nameKey]status {
	var b strings.Builder
	for i := 0; i < len(rows); i++ {
		if scheduleHeadingRe.MatchString(fold(rows[i].text())) {
			for i++; i < len(rows) && !activationSectionEnd(rows[i]); i++ {
			}
			if i == len(rows) {
				break
			}
		}
		b.WriteString(" ")
		b.WriteString(rows[i].text())
	}
	text := b.String()
	var out map[nameKey]status
	for _, m := range statedRe.FindAllStringSubmatchIndex(text, -1) {
		sentence := text[m[2]:]
		if end := sentenceEndRe.FindStringIndex(sentence); end != nil {
			sentence = sentence[:end[0]]
		}
		st := statusIn(sentence)
		if st.mode == "" || st.mode == modeFirm {
			continue
		}
		for _, k := range headingKeys(text[m[2]:m[3]]) {
			if out == nil {
				out = map[nameKey]status{}
			}
			out[k] = out[k].or(st)
		}
	}
	return out
}

// sentenceEndRe ends a sentence: a full stop before a space or the end.
var sentenceEndRe = regexp.MustCompile(`\.(?:\s|$)`)

// dayListRe is a list of days of the month this reader cannot place, in
// a dateless row: opening it ("-8: 0800 -1100", "- 9, 10, 14, 15 : 0800
// -1100", 001/2026) or after a name ("ZRTFLOURAIR : -14,16:1245-1615"), or
// a day jammed with its hours ("Du81800au220500", 18:00 on the 8th to
// 05:00 on the 22nd). Read as a rule of every day, its windows would hold
// the zone on days the schedule never names.
var dayListRe = regexp.MustCompile(`(?i)(?:^|[\s:,])[-–]\s*\d{1,2}(?:\s*(?:,|et)\s*\d{1,2})*\s*:|^\s*\d{1,2}(?:\s*(?:,|et)\s*\d{1,2})*\s*:|du\s*\d{1,2}\s*[0-2]\d[0-5]\d\s*au\s*\d{1,2}\s*[0-2]\d[0-5]\d`)

// scheduleHeadingRe, folded, opens a schedule section: the heading opens
// its row, after a number at most. A sentence naming the dates and hours
// of other zones opens none (106/2026's "Des activités complémentaires sont
// programmées ... aux dates et heures mentionnées pour les ZRT").
var scheduleHeadingRe = regexp.MustCompile(`^[\d.)-]*datesetheures`)

// notHoursRe is a row whose figures are no hours: a supplement cited by
// number ("SUP AIP 237/2024"), a frequency ("119,825 MHz") or a telephone
// number.
var notHoursRe = regexp.MustCompile(`(?i)sup\s*aip|\d\s*mhz|t[ée\x{FFFD}]l[ée\x{FFFD}]phone|\d{2}[.\s]\d{2}[.\s]\d{2}[.\s]\d{2}[.\s]\d{2}`)

// danglingRe ends a row on the separator a bullet sets before what follows
// its hours, which the next row prints.
var danglingRe = regexp.MustCompile(`[-–−]\s*$`)

// onlyDaysOff reports whether every date text prints is one a clause takes
// off (exclusionSpans).
func onlyDaysOff(text string, year int) bool {
	groups, _, off := dateGroups(spellDayRanges(text, year), &year)
	return len(groups) == 0 && len(off) > 0
}

// h24Re is a statement holding at all hours.
var h24Re = regexp.MustCompile(`(?i)\bH\s*24\b`)

// otherHoursRe, folded, names the hours outside the ones a schedule states:
// "en dehors de ces horaires", "hors de ces horaires", "autres horaires".
var otherHoursRe = regexp.MustCompile(`endehorsde|horsdeces|autreshoraires|autresheures`)

// readSchedules reads every DATES ET HEURES section of rows, a date without
// its year taking year's, and the rules a section states with no dates
// (closeGroup).
func readSchedules(rows []prow, page []int, furn []bool, year int) (named *namedActs, unnamed []activation) {
	named = newNamedActs()
	for i := 0; i < len(rows); i++ {
		if !scheduleHeadingRe.MatchString(fold(rows[i].text())) {
			continue
		}
		var curNames []nameKey
		var heading strings.Builder // accumulates a wrapped name list
		var lineNames []nameKey     // names off zone lines, in their order
		hours := map[nameKey]zoneHours{}
		sawDate := false
		var cur *bullet
		// The section's activations are held until it ends, when the status
		// its rows left unsaid is settled (settleStatus).
		sec := newNamedActs()
		var secUnnamed []activation
		var secText strings.Builder
		// own marks an activation of the section stating its status in its
		// own rows, headingStatus the status the group's heading prints, and
		// sectionStatus the one printed before the section's zones.
		own := false
		var headingStatus, sectionStatus status
		// The dateless statements of the group being read, outside any
		// bullet: their windows, each with its row's day rule, status and
		// season (groupWins), the day rule a row states alone (groupRule),
		// whether a row states a status or H24 for all hours (groupSaid),
		// and whether one lists days this reader cannot place
		// (groupUnread). sawAnyDate marks a dated bullet in the section,
		// placedStanding a standing rule it filed.
		var groupWins []activation
		var groupRule dayRule
		var groupText strings.Builder
		groupSaid, groupUnread, sawAnyDate, placedStanding := false, false, false, false
		// dateHead holds the dates of a row naming no zone that the zone
		// lines under it take ("Cérémonies le 14 juillet :", 142/2026).
		var dateHead string
		month := sectionMonth(rows, i, year)
		// A season note printed before the section's first date holds for
		// the whole section ("Horaires été : - 01H00", 172/2026).
		var section seasonNote
		// sectionReport is a 24-hour postponement printed before the
		// section's zones (237/2026), for every bullet.
		sectionReport := false
		// sectionRule and headingRule are the day rules printed before the
		// section's zones ("Du lundi au vendredi sauf JF :", 242/2026) and on
		// the heading of the group being read.
		var sectionRule, headingRule dayRule
		sawBullet := false
		// headingUnplaced marks a heading listing days it prints no month
		// for (142/2026's "ZRT 3, 4 et 5 activables les 09, 10 et 13").
		headingUnplaced := false
		flush := func() {
			if heading.Len() > 0 || len(lineNames) > 0 {
				keys := headingKeys(heading.String())
				if headingUnplaced {
					for _, k := range keys {
						named.unplaced[k] = true
					}
				}
				curNames = append(keys, lineNames...)
				heading.Reset()
				headingUnplaced = false
				lineNames = nil
			}
		}
		// emit files the bullet being read under its names. Each run of its
		// dates takes the hours printed after it and those of the hours rows
		// under it, and a run with none takes all the bullet's. A zone
		// line's own hours stand for its zone, and the bullet's season note
		// goes before the zone line's, which goes before the section's. A
		// bullet files each activation once: 031/2026 restates its range in
		// the remark after it.
		emit := func() {
			if cur == nil {
				return
			}
			season := seasonIn(cur.text)
			groups, all, off := dateGroups(spellDayRanges(cur.dates, year), &year)
			groups = boundRuns(groups)
			days := offDays(off)
			report := sectionReport || reportRe.MatchString(cur.text)
			for _, w := range cur.windows {
				all = appendWindow(all, w)
			}
			for k := range groups {
				if len(groups[k].windows) == 0 {
					groups[k].windows = all
					continue
				}
				for _, w := range cur.windows {
					groups[k].windows = appendWindow(groups[k].windows, w)
				}
			}
			acts := func(h zoneHours) []activation {
				var out []activation
				for _, g := range groups {
					windows := g.windows
					if len(h.windows) > 0 {
						windows = h.windows
					}
					// Each window takes the rule its own row prints, else its
					// bullet's, its heading's, its section's.
					ws := windows
					if len(ws) == 0 {
						ws = [][2]string{{}}
					}
					for _, r := range g.ranges {
						for _, sub := range splitRange(r, days) {
							for _, w := range ws {
								var one [][2]string
								if w != ([2]string{}) {
									one = [][2]string{w}
								}
								rule := cur.windowRules[w].or(cur.rule).or(cur.heading).or(sectionRule)
								var cuts cutEnds
								if cur.stretch[w] {
									cuts = stretchCuts(w)
								}
								for _, a := range rangeActivations(sub, one, season.or(h.season).or(section), cuts) {
									a.dayRule = rule.moved(a.dayShift)
									a.status = cur.windowStatus[w]
									if report {
										a = laterDay(a)
									}
									if !slices.Contains(out, a) {
										out = append(out, a)
									}
								}
							}
						}
					}
				}
				return out
			}
			envelope := seeAboveRe.MatchString(fold(cur.text))
			bulletStatus := statusIn(cur.text)
			// Each activation takes the status its window's row prints, else
			// its bullet's, its zone line's, its heading's, its section's.
			mark := func(as []activation, h zoneHours) []activation {
				for k := range as {
					as[k].envelope = envelope
					st := as[k].status.or(bulletStatus).or(h.status).or(cur.line).or(cur.headStatus).or(sectionStatus)
					if st.mode != "" {
						own = true
					}
					as[k].status = st
				}
				return as
			}
			if len(cur.names) == 0 {
				secUnnamed = append(secUnnamed, mark(acts(zoneHours{}), zoneHours{})...)
			}
			for _, n := range cur.names {
				sec.addKey(n, mark(acts(hours[n]), hours[n])...)
			}
			cur = nil
		}
		// closeGroup files what a group stated with no dates, once it closes
		// on none: the hours each zone line gave (191/2025's "ZRT activable
		// par NOTAM avec un préavis minimum de 48 heures : 2030-0530"), the
		// windows its rows printed (088/2025's "du LUN 0500 au VEN 1100"),
		// or, in a section printing no date at all, the status it states for
		// all hours ("Possible activation H24", "H24"), each a standing rule
		// of the zones its heading names, or of every zone without one where
		// it names none. A group listing days with no month reads unread.
		closeGroup := func() {
			keys := headingKeys(heading.String())
			if len(keys) == 0 {
				keys = curNames
			}
			file := func(names []nameKey, acts []activation) {
				if len(acts) == 0 {
					return
				}
				placedStanding = true
				if len(names) == 0 {
					named.unnamedStanding = append(named.unnamedStanding, acts...)
					return
				}
				for _, n := range names {
					sec.addStanding(n, acts...)
				}
			}
			// The group's heading and statements read as one text: a way of
			// activating a zone stated in one row stands beside the NOTAM
			// another states (053/2026).
			groupStatus := statusIn(groupText.String()).or(headingStatus).or(sectionStatus)
			if !sawDate {
				for _, n := range lineNames {
					h := hours[n]
					var acts []activation
					for _, w := range h.windows {
						a := windowActivation(w)
						a.dayRule = headingRule.or(sectionRule)
						a.status = h.status.or(groupStatus)
						a.season = h.season.or(section)
						acts = append(acts, a)
					}
					file([]nameKey{n}, acts)
				}
				var acts []activation
				for _, a := range groupWins {
					a.status = a.status.or(groupStatus)
					acts = append(acts, a)
				}
				switch {
				case groupUnread:
					acts = []activation{{status: status{mode: modeUnread}}}
				case len(acts) == 0 && groupSaid && !sawAnyDate:
					acts = []activation{{dayRule: groupRule.or(headingRule).or(sectionRule), status: groupStatus}}
				}
				file(keys, acts)
			}
			groupWins, groupRule, groupSaid, groupUnread = nil, dayRule{}, false, false
			groupText.Reset()
		}
		// dateless reads a row stating hours or a status outside any bullet
		// for the group being read. A row stating a status for the hours
		// outside the others ("En dehors de ces horaires par NOTAM (préavis
		// 48 heures)", 232/2024) is a rule of all hours under them.
		dateless := func(text string, ws [][2]string) {
			if notHoursRe.MatchString(text) {
				return
			}
			if dayListRe.MatchString(text) || unplacedDays(text) {
				groupUnread = true
				return
			}
			st := statusIn(text)
			groupSaid = groupSaid || st.mode != "" || h24Re.MatchString(text)
			groupText.WriteString(" " + text)
			rule, hasRule := ruleIn(text)
			season := seasonIn(text)
			weekly, rules := weeklyWindows(text)
			if hasRule && len(ws) == 0 && len(weekly) == 0 {
				groupRule = groupRule.or(rule)
			}
			add := func(w [2]string, r dayRule, cuts cutEnds) {
				a := windowActivation(w)
				a.dayRule = r
				a.status = st
				a.season = season.or(section)
				a.cuts = cuts
				groupWins = append(groupWins, a)
			}
			for _, w := range weekly {
				r := rules[w]
				r.exceptHolidays = r.exceptHolidays || rule.exceptHolidays
				r.exceptEves = r.exceptEves || rule.exceptEves
				add(w, r, stretchCuts(w))
			}
			for _, w := range ws {
				add(w, rule.or(groupRule).or(headingRule).or(sectionRule), 0)
			}
			if len(ws) == 0 && len(weekly) == 0 && st.mode != "" && otherHoursRe.MatchString(fold(text)) {
				groupWins = append(groupWins, activation{status: st})
			}
		}
		// group starts a new group of names once a date has closed the last.
		group := func() {
			if sawDate {
				curNames, sawDate = nil, false
				hours = map[nameKey]zoneHours{}
				headingRule = dayRule{}
				headingStatus = status{}
			}
		}
		j := i + 1
		for ; j < len(rows) && !activationSectionEnd(rows[j]); j++ {
			if furn[j] {
				continue
			}
			text := rows[j].text()
			secText.WriteString(" ")
			secText.WriteString(text)
			// A column schedule: zone names, each in a cell of its own, over
			// the dates and hours of each column (010/2026's "ZRT LIMA 1"
			// beside "ZRT/ZDT LIMA 2"). It runs to the end of the section.
			// The rows a table or a column schedule reads are the section's
			// text too.
			readRest := func(h int) {
				for k := h + 1; k < j; k++ {
					if !furn[k] {
						secText.WriteString(" ")
						secText.WriteString(rows[k].text())
					}
				}
			}
			if cols := nameColumns(rows[j]); len(cols) >= 2 && columnsDated(rows, furn, j, cols) {
				emit()
				sawDate, sawAnyDate = true, true
				h := j
				j = readColumnSchedule(rows, furn, j, cols, year, sec)
				readRest(h)
				break
			}
			// Table header: a "Dates" cell plus zone-name cells. The table
			// runs to the end of the section.
			if strings.Contains(fold(text), "dates") && looksLikeZoneNames(text) {
				emit()
				sawDate, sawAnyDate = true, true
				h := j
				j = readActivationTable(rows, page, furn, j, &year, sec)
				readRest(h)
				break
			}
			dm := frDateRe.FindStringSubmatch(text)
			if dm == nil && cur != nil && danglingRe.MatchString(cur.text) {
				// A bullet's row ending on its separator runs on to the next:
				// 111/2026's "... jours fériés -" over "ZRT activable", read
				// as a heading naming every ZRT, left its period firm.
				cur.addRow(text, windowsIn(text))
				cur.text += " " + text
				continue
			}
			if dm == nil {
				// A heading giving its schedule to every zone, after a heading
				// naming some of them as before none ("TOUTES LES ZONES",
				// 200/2026). Under zone lines no date has closed yet, it opens
				// the bullet their hours are for, and they keep it (242/2026).
				if all, ok := allZonesHeading(text); ok {
					if len(lineNames) > 0 && !sawDate {
						continue
					}
					emit()
					if !sawDate && (len(groupWins) > 0 || groupUnread) {
						closeGroup()
					}
					group()
					heading.Reset()
					headingUnplaced = false
					lineNames = nil
					curNames = []nameKey{{all: all}}
					// Its status is every zone's: "toutes les ZRT sont
					// activables dans les horaires mentionnés ci-dessous"
					// (208/2026).
					st := statusIn(text)
					sectionStatus = sectionStatus.or(st)
					groupSaid = groupSaid || st.mode != ""
					continue
				}
				// A zone line: its name, and the hours that zone keeps for
				// the bullet that follows ("- ZRT 'Low' Coulommiers :
				// 0800-1930 (ETE : -1HR)", 242/2026). Read as a heading, its
				// hours would stay in the name and no zone would match it.
				if m := zoneLineRe.FindStringSubmatch(text); m != nil && looksLikeZoneNames(m[1]) && !dayListRe.MatchString(text) {
					// A zone line dated by its own days ("ZIT CONCORDE, ZRT 1 et
					// ZRT 2 actives les 09, 10 et 13 : 10h00-15h30") or by the
					// row naming no zone it falls under ("Cérémonies le 14
					// juillet :") is a schedule of its own (142/2026).
					names, days := splitStatus(m[1])
					line := statusIn(text)
					if cur != nil && len(cur.names) == 0 {
						dateHead, cur = cur.dates, nil
					}
					emit()
					group()
					dates := dateHead
					if days != "" {
						// Days no single month of the section places keep
						// their zones from a partial schedule (unplacedDays).
						if month == "" {
							for _, n := range headingKeys(names) {
								named.unplaced[n] = true
							}
							continue
						}
						dates = days + " " + month
					}
					if dates != "" {
						cur = &bullet{names: headingKeys(names), dates: dates, text: dates + " " + m[2], line: line, headStatus: headingStatus}
						cur.addRow(m[2], windowsIn(m[2]))
						emit()
						continue
					}
					h := zoneHours{windows: windowsIn(m[2]), season: seasonIn(m[2]), status: line}
					for _, n := range headingKeys(names) {
						lineNames = append(lineNames, n)
						hours[n] = h
					}
					continue
				}
				// Heading row(s): the zone name(s) for the schedule that
				// follows. A name list can wrap across rows, so accumulate the
				// text (including a bare wrapped tail like "ALPHA") and split it
				// into names only at the next date row. A heading after a date
				// row starts a fresh group.
				tail := heading.Len() > 0 && !sawDate && nameTailRe.MatchString(strings.TrimSpace(text))
				if looksLikeZoneNames(text) || tail {
					// A sentence wrapped over rows names no zone for a schedule.
					if proseRow(text) {
						continue
					}
					emit()
					// A heading after a dateless group's statements opens a
					// group of its own (150/2025's ZRT SOTAME BRAVO after
					// ALPHA's hours).
					if !sawDate && (len(groupWins) > 0 || groupUnread) {
						closeGroup()
						heading.Reset()
						headingRule, headingStatus = dayRule{}, status{}
					}
					group()
					if r, ok := ruleIn(text); ok {
						headingRule = headingRule.or(r)
					}
					headingStatus = headingStatus.or(statusIn(text))
					groupSaid = groupSaid || headingStatus.mode != "" || h24Re.MatchString(text)
					groupText.WriteString(" " + text)
					if ws, weekly := windowsIn(text), weeklyRe.MatchString(text); !sawDate && (len(ws) > 0 || weekly) {
						dateless(text, ws)
					}
					headingUnplaced = headingUnplaced || unplacedDays(text)
					heading.WriteString(" ")
					heading.WriteString(text)
					continue
				}
				// Under a date bullet: an hours row adds its windows ("-
				// Activable de 0200 à 0400", 243/2026), and any row may carry
				// the bullet's season note on, wrapped or not ("(ETE :" over
				// "-1HR)", 050/2026). A row holding a time of its own outside
				// any window states a deadline its note qualifies instead
				// ("avant 1100 UTC (été : - 1 HR)", 053/2026).
				ws := windowsIn(text)
				lone := len(ws) == 0 && loneTimeRe.MatchString(timeRangeRe.ReplaceAllString(text, " "))
				switch {
				case cur != nil:
					cur.addRow(text, ws)
					if !lone {
						cur.text += " " + text
					}
				case !sawBullet && !lone:
					section = section.or(seasonIn(text))
					if r, ok := ruleIn(text); ok && len(ws) == 0 {
						sectionRule = sectionRule.or(r)
					}
					sectionStatus = sectionStatus.or(statusIn(text))
				}
				if cur == nil && !lone && !sawDate {
					dateless(text, ws)
				}
				if !sawBullet && reportRe.MatchString(text) {
					sectionReport = true
				}
				continue
			}
			if cur == nil && onlyDaysOff(text, year) {
				// A row whose every date a clause takes off states no period:
				// 094/2025's "4 semaines / an à l'exclusion de la période du
				// 01/07 au 15/09", read as a bullet, closed the weekday hours
				// above it on no date, and its zones lost them.
				dateless(text, nil)
				continue
			}
			sawBullet = true
			if strings.Contains(fold(text), "inactif") {
				emit()
				continue // a deactivation note, not an activation
			}
			// A dated row printed without the list marker under a bullet
			// printed with one is that bullet's remark, wrapped: 031/2026's
			// "Du 02 mars 2026" ends a row and its "au 13 mars 2026" opens
			// the next, and read as a bullet of its own, the second row
			// would draw 13 March all day.
			if cur != nil && cur.marked && !marked(text) {
				cur.dates += "\n" + text
				cur.text += " " + text
				cur.addRow(text, nil)
				continue
			}
			emit()
			flush()
			dateHead = ""
			// A row opens a bullet only with a date it can place. emit
			// reads the dates for good, once the rows its remark wraps onto
			// have joined it, so the check reads them in a copy of the year.
			y := year
			if len(dateItems(text, &y)) == 0 {
				continue
			}
			sawDate, sawAnyDate = true, true
			cur = &bullet{
				names:      curNames,
				marked:     marked(text),
				dates:      text,
				text:       text,
				heading:    headingRule,
				headStatus: headingStatus,
			}
			cur.addRow(text, nil)
		}
		emit()
		closeGroup()
		if !sawAnyDate && !placedStanding && len(sec.order) == 0 && len(secUnnamed) == 0 && strings.TrimSpace(secText.String()) != "" {
			named.unnamedStanding = append(named.unnamedStanding, activation{status: status{mode: modeUnread}})
		}
		wide := statusIn(secText.String())
		for _, k := range sec.order {
			settleStatus(sec.acts[k], own, wide)
			named.addKey(k, sec.acts[k]...)
		}
		for _, k := range sec.standingOrder {
			named.addStanding(k, sec.standing[k]...)
		}
		for k := range sec.unplaced {
			named.unplaced[k] = true
		}
		settleStatus(secUnnamed, own, wide)
		unnamed = append(unnamed, secUnnamed...)
		i = j
	}
	return named, unnamed
}

// settleStatus gives each of a section's activations the status its rows
// left unsaid. Where other activations of the section state their own, the
// section tells its periods apart and an activation saying nothing is firm
// (153/2026's BLOIS: a bullet of fixed hours, then one "Activable de SR à
// SS-1HR"). Where none does, an activation takes what the section prints
// anywhere, a remark after the last bullet included ("Les ZRT sont
// activables"), and is firm only where the section says nothing. An
// activation by NOTAM or that may be activated and states no notice takes
// the section's. A firm activation's status is the zero status.
func settleStatus(acts []activation, own bool, wide status) {
	for k := range acts {
		st := &acts[k].status
		if st.mode == "" && !own {
			st.mode = wide.mode
		}
		if st.mode == "" || st.mode == modeFirm {
			*st = status{}
			continue
		}
		if st.noticeMin == 0 {
			st.noticeMin = wide.noticeMin
		}
	}
}

// readActivationTable reads one schedule table, its header at rows[h]: a
// "Dates" cell and one cell per zone, then a row per date. It returns the
// index of the row that ends the section, which ends the table too. page
// numbers the rows' pages and furn marks their page furniture.
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
// A table runs on over a page break, its header printed again (211/2026's
// RAPACE table, 3 of its 26 dates on its first page). Y restarts at the top
// of every page, so a window is matched only to the dates on its own page.
//
// splitStatus cuts a zone line's text before its colon at its status word:
// the names before it, and the days the rest lists ("les 09, 10 et 13"),
// if it lists any.
func splitStatus(s string) (names, days string) {
	m := statusRe.FindStringSubmatchIndex(s)
	if m == nil {
		return s, ""
	}
	names, rest := s[:m[2]], s[m[3]:]
	if d := unplacedDaysRe.FindString(rest); d != "" {
		days = d
	}
	return strings.TrimSpace(names), days
}

// sectionMonth returns the month and year every date of the schedule
// section opening at row i prints ("juillet 2026"), for days a row lists
// with no month of their own, or "" when its dates span several months.
func sectionMonth(rows []prow, i, year int) string {
	month := ""
	for j := i + 1; j < len(rows) && !activationSectionEnd(rows[j]); j++ {
		for _, m := range frDateRe.FindAllStringSubmatch(rows[j].text(), -1) {
			mo := frMonths[asciiMonth(m[2])]
			y := year
			if m[3] != "" {
				y, _ = strconv.Atoi(m[3])
			}
			cur := fmt.Sprintf("%s %d", numericMonths[mo-1], y)
			if month != "" && cur != month {
				return ""
			}
			month = cur
		}
	}
	return month
}

// seeAboveRe, folded, sends the reader to hours printed elsewhere: "voir
// détail des horaires ci-dessus", "voir le détail".
var seeAboveRe = regexp.MustCompile(`voir(?:le)?d.?tail|ci-?dessus`)

// nameColumns returns a row's cells when each names zones and none prints a
// date or a window: the header of a column schedule.
func nameColumns(r prow) []cell {
	if len(r.cells) < 2 {
		return nil
	}
	for _, c := range r.cells {
		if !zoneNameRe.MatchString(c.text) || frDateRe.MatchString(c.text) || len(windowsIn(c.text)) > 0 {
			return nil
		}
	}
	return r.cells
}

// nearestColumn returns the index of the column whose header starts nearest
// x.
func nearestColumn(cols []cell, x float64) int {
	best := 0
	for k := range cols {
		if math.Abs(cols[k].x-x) < math.Abs(cols[best].x-x) {
			best = k
		}
	}
	return best
}

// columnsDated reports whether two or more of the columns under the header
// at h hold a date: names over bullets set across the page head no columns.
func columnsDated(rows []prow, furn []bool, h int, cols []cell) bool {
	dated := map[int]bool{}
	for j := h + 1; j < len(rows) && !activationSectionEnd(rows[j]); j++ {
		if furn[j] {
			continue
		}
		for _, c := range rows[j].cells {
			if frDateRe.MatchString(c.text) {
				dated[nearestColumn(cols, c.x)] = true
			}
		}
	}
	return len(dated) >= 2
}

// readColumnSchedule reads the column schedule whose header is row h: each
// column's cells, in order, are a section of their own under the column's
// names, and a dateless row of one cell ("Report possible de 24 heures mêmes
// horaires", 010/2026) holds for every column. Read as one heading over
// every row, each zone took every column's hours (006/2026 gave ZRT
// BIZERTE ZRT CAMARAT's and ZRT DRAMONT's). It returns the row ending the
// section.
func readColumnSchedule(rows []prow, furn []bool, h int, cols []cell, year int, named *namedActs) int {
	per := make([][]prow, len(cols))
	j := h + 1
	for ; j < len(rows) && !activationSectionEnd(rows[j]); j++ {
		if furn[j] {
			continue
		}
		r := rows[j]
		if len(r.cells) == 1 && !frDateRe.MatchString(r.cells[0].text) {
			for k := range per {
				per[k] = append(per[k], r)
			}
			continue
		}
		// A row's cells in one column stay one row: poppler sets a stretch
		// over three cells ("Du03/02/2026", "à23h00au04/02/2026", "à02h00").
		byCol := make([][]cell, len(cols))
		for _, c := range r.cells {
			k := nearestColumn(cols, c.x)
			byCol[k] = append(byCol[k], c)
		}
		for k, cs := range byCol {
			if len(cs) > 0 {
				per[k] = append(per[k], prow{y: r.y, cells: cs})
			}
		}
	}
	for k, c := range cols {
		section := []prow{{cells: []cell{{text: "DATES ET HEURES D'ACTIVITE"}}}, {cells: []cell{c}}}
		section = append(section, per[k]...)
		section = append(section, prow{cells: []cell{{text: "INFORMATION DES USAGERS"}}})
		n, _ := readSchedules(section, pageNumbers(section), make([]bool, len(section)), year)
		for _, key := range n.order {
			named.addKey(key, n.acts[key]...)
			if n.unplaced[key] {
				named.unplaced[key] = true
			}
		}
	}
	return j
}

// A header cell can wrap onto the row below ("ZRT BELMONT -" over "TARN"):
// a row of capitals with no date and no window before the first date
// continues the names of the columns nearest its cells.
func readActivationTable(rows []prow, page []int, furn []bool, h int, year *int, named *namedActs) int {
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
	for ; k < end && (furn[k] || isHeaderContinuation(rows[k])); k++ {
		if furn[k] {
			continue
		}
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
		page   int
		y      float64
		ranges [][2]string
	}
	var dates []dated
	for r := k; r < end; r++ {
		text := rows[r].text()
		if furn[r] || strings.Contains(fold(text), "inactif") {
			continue
		}
		if ranges := dateRanges(text, year); len(ranges) > 0 {
			dates = append(dates, dated{page[r], rows[r].y, ranges})
		}
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
		if furn[r] {
			continue
		}
		var found []window
		for _, c := range rows[r].cells {
			if inDateColumn(c.x) {
				continue
			}
			for _, w := range windowsIn(frDateRe.ReplaceAllString(c.text, "  ")) {
				found = append(found, window{nearestX(colXs, c.x), w[0], w[1]})
			}
		}
		if len(found) == 0 {
			continue
		}
		best := math.Inf(1)
		for _, d := range dates {
			if d.page == page[r] {
				best = math.Min(best, absf(rows[r].y-d.y))
			}
		}
		for di, d := range dates {
			if d.page == page[r] && absf(rows[r].y-d.y) <= best+0.5 {
				windows[di] = append(windows[di], found...)
			}
		}
	}
	for di, d := range dates {
		for _, rg := range d.ranges {
			for _, w := range windows[di] {
				named.add(colName[w.col], activation{date: rg[0], dateTo: rg[1], from: w.from, to: w.to})
			}
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

// attachActivations gives each zone its schedule: the windows of every name
// that names it (nameKey.zones), each window once, else the un-named windows
// for any zone still without one (a single-zone supplement). A zone an
// unplaced name names keeps none.
// withoutEnvelope drops the envelope ranges of a zone that has a schedule of
// its own: read as whole days, 017/2026's "Voir détail des horaires
// ci-dessus" held ZRT PARA CUERS every day of its validity over its hours.
// An envelope printed before any range of the zone's own, on days none of
// them reaches, points at hours set out elsewhere, and is the zone's
// schedule on those days: a_099/2026 prints "Du 16 juin 2026 à 1000 au 17
// juin 2026 à 1430 - Détail des créneaux pour chaque zone dans le tableau
// ci-dessus" over the zones' own 18 June. Alone, an envelope is the zone's
// schedule (166/2026's BUCK BRAVO zones print their weekly hours with no
// dates).
func withoutEnvelope(as []activation) []activation {
	own := slices.DeleteFunc(slices.Clone(as), func(a activation) bool { return a.envelope })
	var out []activation
	seen := false
	for _, a := range as {
		switch {
		case !a.envelope:
			seen = true
		case seen || slices.ContainsFunc(own, func(o activation) bool { return datesMeet(a, o) }):
			continue
		}
		out = append(out, a)
	}
	return out
}

// datesMeet reports whether two activations share a day, one with no date
// sharing every day.
func datesMeet(a, b activation) bool {
	if a.date == "" || b.date == "" {
		return true
	}
	return a.date <= lastDay(b) && b.date <= lastDay(a)
}

// lastDay is the last day an activation holds.
func lastDay(a activation) string {
	if a.dateTo != "" {
		return a.dateTo
	}
	return a.date
}

func attachActivations(zones []zone, named *namedActs, unnamed []activation) {
	byNorm := map[string][]int{}
	for i := range zones {
		k := normalizeName(zones[i].name)
		byNorm[k] = append(byNorm[k], i)
	}
	got := make([][]activation, len(zones))
	for _, k := range named.order {
		for _, i := range k.zones(zones, byNorm) {
			got[i] = append(got[i], named.acts[k]...)
		}
	}
	unplaced := make([]bool, len(zones))
	for k := range named.unplaced {
		for _, i := range k.zones(zones, byNorm) {
			unplaced[i] = true
		}
	}
	for i := range zones {
		if len(got[i]) > 0 && !unplaced[i] {
			zones[i].activations = uniqueActivations(withoutEnvelope(got[i]))
		}
	}
	if len(unnamed) > 0 {
		for i := range zones {
			if len(zones[i].activations) == 0 && !unplaced[i] {
				zones[i].activations = unnamed
			}
		}
	}
	attachStanding(zones, named, byNorm, unplaced)
	attachStated(zones, named, byNorm)
}

// attachStated gives the firm periods of each zone a sentence outside the
// schedules names the status it states (statedStatuses), and a zone with no
// schedule of its own a standing rule in it.
func attachStated(zones []zone, named *namedActs, byNorm map[string][]int) {
	for k, st := range named.stated {
		for _, i := range k.zones(zones, byNorm) {
			z := &zones[i]
			if len(z.activations) == 0 && len(z.standing) == 0 {
				z.standing = []activation{{status: st}}
				continue
			}
			for _, as := range [][]activation{z.activations, z.standing} {
				for j := range as {
					if as[j].status == (status{}) {
						as[j].status = st
					}
				}
			}
		}
	}
}

// attachStanding gives each zone the rules its schedule states with no
// dates: those of every name that names it, else those of a group naming
// no zone, for a zone without a dated schedule. A heading whose names reach
// no zone ("ZRT activables par NOTAM", 067/2026) states its section's
// rules. A zone whose only dates are an envelope sending the reader to
// hours printed elsewhere (166/2026's "H24 pendant les créneaux horaires
// détaillés ci-dessus") holds its rules within the envelope's days, each
// split at the clock changes it states (inEnvelopes).
func attachStanding(zones []zone, named *namedActs, byNorm map[string][]int, unplaced []bool) {
	got := make([][]activation, len(zones))
	pool := slices.Clone(named.unnamedStanding)
	for _, k := range named.standingOrder {
		idx := k.zones(zones, byNorm)
		if len(idx) == 0 {
			pool = append(pool, named.standing[k]...)
			continue
		}
		for _, i := range idx {
			got[i] = append(got[i], named.standing[k]...)
		}
	}
	for i := range zones {
		if unplaced[i] {
			continue
		}
		st := got[i]
		if len(st) == 0 && len(zones[i].activations) == 0 {
			st = pool
		}
		if len(st) == 0 {
			continue
		}
		st = uniqueActivations(st)
		if dated, ok := inEnvelopes(zones[i].activations, st); ok {
			zones[i].activations = dated
			continue
		}
		zones[i].standing = st
	}
}

// inEnvelopes returns a zone's standing rules held within its envelopes'
// days, when its only activations are envelopes, each rule split at the
// clock changes its season note states.
func inEnvelopes(acts, standing []activation) ([]activation, bool) {
	if len(acts) == 0 || slices.ContainsFunc(acts, func(a activation) bool { return !a.envelope }) {
		return nil, false
	}
	var out []activation
	for _, e := range acts {
		for _, r := range standing {
			a := r
			a.date, a.dateTo, a.season = e.date, e.dateTo, noSeason
			a.status = a.status.or(e.status)
			out = append(out, seasoned(a, r.season)...)
		}
	}
	return uniqueActivations(out), true
}
