// status.go: how a schedule's periods hold. The supplements print three
// ways, in words AIP France GEN 2.2 defines none of. A firm period is active
// throughout ("Du 02 mars 2026 au 27 mars 2026 de 0800 à 1700", "ZRT 1 et
// ZRT 2 actives les 09, 10 et 13"). An activable one may be activated, its
// real activity known from a unit ("Activable de SR à SS-1HR", "Possible
// activation H24", "Activables selon protocole"). And a NOTAM announces each
// activation of the third, at a notice ("Activable par NOTAM avec préavis
// de 48 h", "par Notam à J-7", "La confirmation d'activation ou annulation
// se fera par la voie de NOTAM à J-1 ouvré").

package main

import (
	"regexp"
	"strconv"
	"strings"
)

// Modes of a status: "firm" active throughout, "activable" may be
// activated, "notam" activated by NOTAM, "unread" stated in a form this
// reader cannot place. The empty mode states nothing.
const (
	modeFirm      = "firm"
	modeActivable = "activable"
	modeNotam     = "notam"
	modeUnread    = "unread"
)

// A status is the way a schedule's periods hold and the shortest notice
// its activations are announced at, in minutes, 0 for none stated.
type status struct {
	mode      string
	noticeMin int
}

// or returns s with t's mode where s states none, and the shorter of their
// notices: a briefing's silence is trusted no longer than the quickest way
// a zone may be activated.
func (s status) or(t status) status {
	if s.mode == "" {
		s.mode = t.mode
	}
	s.noticeMin = shorterNotice(s.noticeMin, t.noticeMin)
	return s
}

// shorterNotice returns the shorter of two notices, a notice of 0 being
// none.
func shorterNotice(a, b int) int {
	switch {
	case a == 0:
		return b
	case b == 0:
		return a
	}
	return min(a, b)
}

var (
	// notamChannelRe, over folded text, is a NOTAM announcing an activation:
	// "par NOTAM", "par la voie de NOTAM", "NOTAM d'activation". A NOTAM the
	// text names for something else (a crane "publiée par NOTAM obstacle")
	// counts only beside an activation's word or a notice.
	notamChannelRe = regexp.MustCompile(`par(?:la)?(?:voied[eu])?notam|notamd'?activation|notamdeconfirmation`)
	// activableRe, over folded text, is a period that may be activated:
	// "activable(s)", "possible activation", "pourra être activée", "selon
	// protocole", and one activated for part of it only, the slots a period
	// holds being counted ("2 créneaux de 3h max d'activation sur la
	// période", "activations de 2 heures max", "1h max dans le créneau",
	// "1 activation quotidienne au maximum").
	activableRe = regexp.MustCompile(`activables?|possibleactivation|activationpossible|pourra(?:e?tre)?active|selonprotocole|\dh(?:\d\d|eures?)?max|activations?(?:quotidiennes?)?aumaximum`)
	// activableWordRe, over folded text, is a word saying a zone may be
	// activated, which a NOTAM channel close after it ties to the NOTAM.
	activableWordRe = regexp.MustCompile(`activables?|possibleactivation|activationpossible|pourra(?:e?tre)?active`)
	// confirmationRe, over folded text, confirms every activation by NOTAM
	// ("La confirmation d'activation ou annulation se fera par la voie de
	// NOTAM"), its "fi" ligature dropped or read as a control byte.
	confirmationRe = regexp.MustCompile(`con(?:fi|[^a-z]{0,2})rmation[^.]{0,80}notam`)
	// confirmWordRe, folded, is the word "confirmation", its "fi" ligature
	// dropped or read as a control byte ("Con\x01rmation par NOTAM",
	// 222/2026).
	confirmWordRe = regexp.MustCompile(`con(?:fi|[^a-z]{0,2})rmation`)
	// firmRe, over the text lowercased with its accents, is "active" or
	// "actives" standing alone or jammed before the days it holds
	// ("ZRT2activesles09"): "activée", "activables" and "inactive" are none.
	firmRe = regexp.MustCompile(`(?:^|[^a-z\x{FFFD}])actives?(?:[^a-z\x{FFFD}]|les?|$)`)
	// noticeRe, over folded text, is a notice: "préavis de 48 h", "préavis
	// minimum de 48 heures", "préavis de 06h00", "préavis de 10 jours",
	// "préavis de 30 minutes", "préavis d'une heure", the days before "J-7",
	// "J-1 ouvré", and "15 minutes de préavis", "48h avant". The days before
	// are one figure: the supplements print none of two, and folded text
	// joins the next word's ("J-2 1 sauts", 061/2026, "J-1 15h00 Z",
	// 106/2026).
	noticeRe = regexp.MustCompile(`pravis(?:minimum)?(?:de|d'un|dun)?(\d{1,3})(h\d\d|heures?|hrs?|h|minutes?|min|mn|jours?)|j-(\d)|pravis(?:minimum)?d'?une?(heure|jour)|(\d{1,3})(heures?|h|minutes?|min|jours?)(?:depravis|avant)`)
)

// statusIn reads the status text prints: its mode, an activation by NOTAM
// before one that may be activated before a firm one, and the shortest
// notice it states. A text reads by NOTAM only where every way it names of
// activating a zone goes through a NOTAM (notamOnly): 053/2026's
// "Activables selon protocole" beside "Activables par NOTAM" may be
// activated, and a briefing's silence never settles it.
func statusIn(text string) status {
	// The native reader leaves an apostrophe as its low byte, 0x19, where
	// poppler's folds away ("préavis d’une heure", 162/2026).
	f := strings.ReplaceAll(fold(text), "\x19", "")
	var s status
	switch {
	case notamChannelRe.MatchString(f) && (strings.Contains(f, "activ") || confirmWordRe.MatchString(f) || strings.Contains(f, "pravis")) && notamOnly(f):
		s.mode = modeNotam
	// A period held while another zone is ("lorsque la TMA SAINT-YAN 1 est
	// active") may be active as that zone may.
	case activableRe.MatchString(f), strings.Contains(f, "lorsque") && strings.Contains(f, "activ"):
		s.mode = modeActivable
	case firmRe.MatchString(strings.ToLower(text)):
		s.mode = modeFirm
	}
	for _, m := range noticeRe.FindAllStringSubmatch(f, -1) {
		s.noticeMin = shorterNotice(s.noticeMin, noticeMinutes(m))
	}
	return s
}

// notamOnly reports whether folded text activates its zone through a NOTAM
// alone: a NOTAM channel follows each word saying it may be activated in its
// clause ("Activable H24 par NOTAM", "ZRT activables simultanément tous les
// jours : 0800-1800 par Notam à J-7"), or a confirmation by NOTAM covers them
// all, and no protocol stands beside it. 101/2026's "Zones activables H24,
// avec un préavis de 30 minutes" beside "Zones activables par NOTAM à J-1"
// has a way of its own.
func notamOnly(f string) bool {
	if strings.Contains(f, "selonprotocole") {
		return false
	}
	if confirmationRe.MatchString(f) {
		return true
	}
	for _, m := range activableWordRe.FindAllStringIndex(f, -1) {
		clause := f[m[1]:min(len(f), m[1]+80)]
		if end := strings.IndexAny(clause, ".;"); end >= 0 {
			clause = clause[:end]
		}
		if !notamChannelRe.MatchString(clause) {
			return false
		}
	}
	return true
}

// noticeMinutes returns a noticeRe match in minutes.
func noticeMinutes(m []string) int {
	switch {
	case m[3] != "":
		d, _ := strconv.Atoi(m[3])
		return d * 1440
	case m[4] == "heure":
		return 60
	case m[4] == "jour":
		return 1440
	}
	figure, unit := m[1], m[2]
	if m[5] != "" {
		figure, unit = m[5], m[6]
	}
	n, _ := strconv.Atoi(figure)
	switch {
	case strings.HasPrefix(unit, "j"):
		return n * 1440
	case strings.HasPrefix(unit, "m"):
		return n
	case len(unit) == 3 && unit[0] == 'h':
		mins, _ := strconv.Atoi(unit[1:])
		return n*60 + mins
	}
	return n * 60
}
