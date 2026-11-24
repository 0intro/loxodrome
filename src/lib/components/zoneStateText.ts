/* A zone's state as a panel says it: the state over the viewed time, why,
 * and what changes next (state/activity.svelte.ts zoneActivity, read by
 * detail/ZoneStatus.svelte). Every function reads the reactive `t` at call
 * time, so callers invoke them from templates and deriveds. */

import type { ActivityAnswer, ActivityReason, NotamLevels } from '$lib/data/activity';
import { whoKnows, type KnownUnit } from '$lib/data/knownFrom';
import { fmtClockUtc } from '$lib/route/format';
import { fmtDayMonth, t } from '$lib/state/i18n.svelte';
import { formatVLimit } from '$lib/vertical/limits';
import type { ZoneNote } from '$lib/state/zoneNotes.svelte';

/** What the panel speaks for: an instant, the planned flight, a typed
 *  period. */
export type ZoneSpan = 'now' | 'flight' | 'period';

export interface ZoneState {
	answer: ActivityAnswer;
	/** The first change after the viewed time, a week ahead at most. */
	next: { atMs: number; answer: ActivityAnswer } | null;
	/** The smallest notice the zone's rules by NOTAM state, in minutes. */
	noticeMin: number | null;
	/** When the briefing was made: its fetch, or a bulletin's loading. */
	briefedAtMs: number | undefined;
	/** The pilot's note in force on the zone, null where there is none. */
	note: ZoneNote | null;
}

export interface ZoneStateLines {
	state: string;
	reason: string | null;
	next: string | null;
}

const DAY_MS = 86_400_000;

/** A UTC instant as the panels and the alert line print it: "14:02Z" on
 *  `nowMs`'s UTC day, "22 Nov 14:02Z" on another. */
export function zuluAt(ms: number, nowMs: number): string {
	const day = new Date(ms).toISOString().slice(0, 10);
	const clock = `${fmtClockUtc(ms)}Z`;
	return day === new Date(nowMs).toISOString().slice(0, 10) ? clock : `${fmtDayMonth(day)} ${clock}`;
}

/** Is `ms` on another UTC day than `nowMs`? */
function otherDay(ms: number, nowMs: number): boolean {
	return Math.floor(ms / DAY_MS) !== Math.floor(nowMs / DAY_MS);
}

/** A period's end as "until" prints it, `dated` where it carries its date
 *  (French says "jusqu'au" then). */
export function untilWords(endMs: number, nowMs: number): { to: string; dated: boolean } {
	return { to: zuluAt(endMs, nowMs), dated: otherDay(endMs, nowMs) };
}

/** A period's two ends as a line prints them: bare clocks on `nowMs`'s UTC
 *  day, the one other day they share named once (`on`: "on 25 Nov from
 *  09:00Z to 11:00Z"), each end with its date where they fall on two days
 *  (`dated`: "from 23 Nov 22:00Z to 24 Nov 05:00Z", French "du ... au"). */
export function periodWords(
	startMs: number,
	endMs: number,
	nowMs: number,
): { from: string; to: string; on: string | null; dated: boolean } {
	const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
	const clock = (ms: number): string => `${fmtClockUtc(ms)}Z`;
	if (day(startMs) !== day(endMs)) {
		const dated = (ms: number): string => `${fmtDayMonth(day(ms))} ${clock(ms)}`;
		return { from: dated(startMs), to: dated(endMs), on: null, dated: true };
	}
	return { from: clock(startMs), to: clock(endMs), on: day(startMs) === day(nowMs) ? null : fmtDayMonth(day(startMs)), dated: false };
}

/** A notice in its own unit: "30 min", "48 h", "7 days". */
export function noticeText(min: number): string {
	const z = t.zones;
	if (min % 1440 === 0 && min > 3 * 1440) {
		return z.noticeDays(String(min / 1440));
	}
	return min % 60 === 0 && min >= 60 ? z.noticeHours(String(min / 60)) : z.noticeMin(String(min));
}

/** The three lines of a zone's state over `at`. */
export function zoneStateLines(s: ZoneState, span: ZoneSpan, at: { fromMs: number; toMs: number }): ZoneStateLines {
	const now = at.fromMs;
	return { state: stateLine(s.answer, span, now), reason: reasonLine(s, now), next: nextLine(s, now) };
}

function stateLine(a: ActivityAnswer, span: ZoneSpan, now: number): string {
	const z = t.zones;
	const p = a.period && Number.isFinite(a.period.startMs) && Number.isFinite(a.period.endMs) ? a.period : null;
	if (a.state === 'inactive' && p && span === 'now' && p.startMs <= now) {
		const u = untilWords(p.endMs, now);
		return z.inactiveNowUntil(u.to, u.dated);
	}
	if (a.state === 'inactive') {
		return span === 'now' ? z.inactiveNow : span === 'flight' ? z.inactiveFlight : z.inactivePeriod;
	}
	const active = a.state === 'active';
	if (active && a.reason === 'permanent') {
		return z.activePermanent;
	}
	if (p && span === 'now' && p.startMs <= now) {
		const u = untilWords(p.endMs, now);
		return active ? z.activeNowUntil(u.to, u.dated) : z.mayNowUntil(u.to, u.dated);
	}
	if (p) {
		const w = periodWords(p.startMs, p.endMs, now);
		return active ? z.activeFromTo(w.from, w.to, w.on, w.dated) : z.mayFromTo(w.from, w.to, w.on, w.dated);
	}
	if (span === 'now') {
		return active ? z.activeNow : z.mayNow;
	}
	if (span === 'flight') {
		return active ? z.activeFlight : z.mayFlight;
	}
	return active ? z.activePeriod : z.mayPeriod;
}

/** A NOTAM's reason, followed by the levels its F) and G) items state. */
function withLevels(reason: string, levels: NotamLevels | undefined): string {
	if (!levels) {
		return reason;
	}
	const z = t.zones;
	const { lower, upper } = levels;
	const band =
		lower && upper
			? z.notamLevels(formatVLimit(lower), formatVLimit(upper))
			: lower
				? z.notamLevelsFrom(formatVLimit(lower))
				: z.notamLevelsUpTo(formatVLimit(upper));
	return `${reason} ${band}`;
}

function reasonLine(s: ZoneState, now: number): string | null {
	const z = t.zones;
	const time = s.briefedAtMs !== undefined ? zuluAt(s.briefedAtMs, now) : '';
	const notice = s.noticeMin !== null ? noticeText(s.noticeMin) : null;
	switch (s.answer.reason) {
		case 'permanent':
			return null;
		case 'notam':
			return withLevels(z.reasonNotam, s.answer.levels);
		case 'notam-unread':
			return withLevels(z.reasonNotamUnread, s.answer.levels);
		case 'rtba':
			return z.reasonRtba;
		case 'published':
			return z.reasonPublished;
		case 'activable':
			return z.reasonActivable;
		case 'unread':
			return z.reasonUnread;
		case 'notam-unbriefed':
			return z.reasonNotamUnbriefed;
		case 'rtba-unbriefed':
			return z.reasonRtbaUnbriefed;
		case 'notam-none':
			return notice ? z.reasonNotamNoneNotice(time, notice) : z.reasonNotamNone(time);
		case 'rtba-none':
			return z.reasonRtbaNone(time);
		case 'notam-notice':
			return z.reasonNotamNotice(notice ?? '', time);
		case 'amended':
			return z.reasonAmended;
		case 'noted':
			return s.note ? z.reasonNoted(s.note.unit, clockAt(s.note.notedAtMs)) : z.reasonNotedBare;
		case 'outside':
			return z.reasonOutside;
		default:
			return null;
	}
}

function nextLine(s: ZoneState, now: number): string | null {
	if (!s.next) {
		return null;
	}
	const z = t.zones;
	const at = zuluAt(s.next.atMs, now);
	const dated = otherDay(s.next.atMs, now);
	switch (s.next.answer.state) {
		case 'active':
			return z.nextActive(at, dated);
		case 'activable':
			return z.nextMay(at, dated);
		default:
			return z.nextInactive(at, dated);
	}
}

/** An instant's UTC clock, "08:40Z". */
function clockAt(ms: number): string {
	return `${fmtClockUtc(ms)}Z`;
}

/** The pilot's note as the lists say it: "Inactive until 16:00Z, BLOIS
 *  INFO, noted 08:40Z.", its end dated on another day than the note. */
export function noteLine(n: ZoneNote): string {
	const until = zuluAt(n.untilMs, n.notedAtMs);
	return t.zones.notedLine(n.state === 'active', until, otherDay(n.untilMs, n.notedAtMs), n.unit, clockAt(n.notedAtMs));
}

/** The same, short, after a zone's name: "inactive until 16:00Z, BLOIS
 *  INFO". */
export function noteShort(n: ZoneNote): string {
	const until = zuluAt(n.untilMs, n.notedAtMs);
	return t.zones.notedShort(n.state === 'active', until, otherDay(n.untilMs, n.notedAtMs), n.unit);
}

/** The note as a list apart from its zone says it: "ZRT BLOIS inactive
 *  until 16:00Z, BLOIS INFO, noted 08:40Z." */
export function noteNamedLine(n: ZoneNote): string {
	return t.zones.notedNamed(n.name, noteShort(n), clockAt(n.notedAtMs));
}

/** The word a crossing the pilot's note settles wears beside its state,
 *  on the strip and the schedule: "noted until 16:00Z". `period` is the
 *  note's, the answer's own. */
export function notedWord(period: { startMs: number; endMs: number }): string {
	return t.zones.notedUntil(zuluAt(period.endMs, period.startMs), otherDay(period.endMs, period.startMs));
}

/** What the crossings strip says of a crossing beside its word: the state
 *  at the crossing with its period, who knows the zone's real activity
 *  while it may be active or once it may become so, and the change after
 *  the crossing that raises its state, with how long after the planned
 *  exit (`exitMs`). A crossing the pilot's note settles says the note in
 *  place of its state and who knows, and one a note leaves open says it
 *  after them. Empty for a zone inactive and staying so, or in force at all
 *  times. `at` is the range the crossing was judged over. */
export function crossingNoteLines(
	answer: ActivityAnswer,
	known: readonly KnownUnit[],
	next: { atMs: number; answer: ActivityAnswer } | null,
	exitMs: number | null,
	at: { fromMs: number; toMs: number },
	note: ZoneNote | null = null,
): string[] {
	const z = t.zones;
	const out: string[] = [];
	if (answer.reason === 'noted' && note) {
		out.push(noteLine(note));
	} else if (answer.state !== 'inactive' && answer.reason !== 'permanent') {
		out.push(stateLine(answer, 'flight', at.fromMs));
	}
	if (answer.reason !== 'noted' && (answer.state === 'activable' || next?.answer.state === 'activable')) {
		const k = whoKnows(known, [], []);
		if (k === 'phone') {
			out.push(z.knownByPhone);
		} else if (k) {
			out.push(z.knownOn(k.freq ? `${k.unit} ${k.freq}` : k.unit));
		}
	}
	if (answer.reason !== 'noted' && note) {
		// A note that leaves this crossing open still says what it holds.
		out.push(noteLine(note));
	}
	if (next && exitMs !== null && next.atMs > exitMs) {
		const when = zuluAt(next.atMs, at.fromMs);
		const dated = otherDay(next.atMs, at.fromMs);
		const after = noticeText(Math.max(1, Math.round((next.atMs - exitMs) / 60_000)));
		out.push(next.answer.state === 'active' ? z.afterActive(when, after, dated) : z.afterMay(when, after, dated));
	}
	return out;
}

/** The word a crossing to confirm wears, on the profile's strip and the nav
 *  log's schedule: "activity unknown" where the briefing leaves a zone
 *  activated by NOTAM open (a fetch cures it), "may be active" where the
 *  publication says so (the unit knows). */
export function cautionWord(reason: ActivityReason | null): string {
	return reason === 'notam-unbriefed' || reason === 'rtba-unbriefed'
		? t.route.activityUnknownShort
		: t.route.mayBeActiveShort;
}
