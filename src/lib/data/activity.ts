/* A zone's activity as its publication states it, and the one reading of it
 * over a range of time.
 *
 * A zone states its activity as RULES. A rule is a mode and the days and
 * hours it holds on, in the shape a supplement's activation has
 * (data/supaip.ts SupAipActivation) with its dates optional, between the two
 * instants its source bounds it with, if any. A rule with no dates, no
 * bounds, no hours and no day rule holds at all times.
 *
 * The modes are the publications' own words. A FIRM period is active
 * throughout. An ACTIVABLE one may be activated, its real activity known
 * from a unit ("Activable", "Possible activation", "Activité réelle connue
 * de"). A NOTAM one may be activated, each activation announced by NOTAM.
 * An UNREAD one is published in a form this reader has yet to read.
 *
 * resolveActivity reads the rules over a range, first match winning, and
 * says why: every uncertain reading lands on activable, and only a firm
 * period, a NOTAM, the RTBA programme or a rule holding at all times makes
 * a zone active (docs/nav-alerts.md, "Activation"). Pure. */

import { activationHolds, hasDayRule, hasSunEnd, sunWindow, type SupAipActivation } from './supaip';
import { scheduleWindows, type ItemDSchedule, type SunLookup } from '$lib/notam/schedule';
import type { VLimit } from '$lib/vertical/limits';
import { isSummerUtc } from '$lib/route/airspaceHours';

export type ActivityMode = 'firm' | 'activable' | 'notam' | 'unread';

/** A zone's state over a range: certainly active, possibly active, or
 *  certainly inactive. */
export type ActivityState = 'active' | 'activable' | 'inactive';

/** One period, epoch ms UTC, both ends inclusive. */
export interface ActivePeriod {
	startMs: number;
	endMs: number;
}

/** A period a NOTAM or the RTBA programme confirms. A NOTAM's holds in
 *  the windows of its D) item (`schedule`, its sun at `sun`), and whole
 *  where it has none or its D) is unread (null). */
/** The levels an activation NOTAM states in its F) and G) items. */
export interface NotamLevels {
	lower: VLimit | null;
	upper: VLimit | null;
}

export interface ConfirmedPeriod extends ActivePeriod {
	by: 'notam' | 'rtba';
	schedule?: ItemDSchedule | null | undefined;
	sun?: SunLookup | undefined;
	/** The levels the activating NOTAM states: the zone is active whole,
	 *  and its panel prints them. */
	levels?: NotamLevels | undefined;
}

export interface ActivityRule extends Omit<SupAipActivation, 'date' | 'mode'> {
	mode: ActivityMode;
	/** The first day it holds on, YYYY-MM-DD, absent for every day. */
	date?: string | undefined;
	/** Its clock hours are winter UTC, an hour earlier in summer
	 *  (cmd/supaip's standing rules, "(ETE : -1HR)"). */
	summerEarlier?: boolean | undefined;
	/** The instants its source bounds it with, absent for unbounded. */
	startMs?: number | undefined;
	endMs?: number | undefined;
	/** A NOTAM's D) item: the rule holds in its windows between its bounds,
	 *  and whole where it is unread (null). A rule with one carries no days
	 *  or hours of its own. */
	schedule?: ItemDSchedule | null | undefined;
}

/** A zone's rules, and the sun their SR and SS ends are set on. */
export interface ZoneActivity {
	rules: readonly ActivityRule[];
	sun?: SunLookup | undefined;
}

/** Why a zone reads as it does over a range, worded by the surfaces. */
export type ActivityReason =
	/** A rule holding at all times. */
	| 'permanent'
	/** A period an activation NOTAM confirms. */
	| 'notam'
	/** The same, held whole: its D) schedule is unread. */
	| 'notam-unread'
	/** A period of the RTBA programme. */
	| 'rtba'
	/** A firm published period. */
	| 'published'
	/** A period published as activable. */
	| 'activable'
	/** A period published in a form this reader has yet to read. */
	| 'unread'
	/** A period of activation by NOTAM the briefing is silent on. */
	| 'notam-unbriefed'
	| 'rtba-unbriefed'
	/** A period of activation by NOTAM the briefing covers, with none in it. */
	| 'notam-none'
	| 'rtba-none'
	/** The same, past the briefing's time plus the zone's notice: a NOTAM
	 *  published since may activate it there. */
	| 'notam-notice'
	/** A zone a loaded NOTAM changes, whose published periods are in doubt. */
	| 'amended'
	/** The pilot's note of what the unit said, settling a zone that may be
	 *  active. */
	| 'noted'
	/** Outside every period. */
	| 'outside';

export interface ActivityInput extends ZoneActivity {
	/** The zone is of the RTBA, whose activations are its programme. */
	rtba?: boolean | undefined;
	confirmed?: readonly ConfirmedPeriod[] | undefined;
	/** Does the briefing cover the zone over the range, with the RTBA day's
	 *  release for an RTBA zone? Only then is a NOTAM it lacks a NOTAM that
	 *  was never published. */
	briefed: boolean;
	/** When the briefing was made: its fetch, or a bulletin's loading. An
	 *  activation published since takes effect no earlier than its time plus
	 *  the zone's notice (a rule's `noticeMin`), so the briefing's silence
	 *  holds that long. A rule stating no notice keeps it over the
	 *  briefing's period. */
	briefedAtMs?: number | undefined;
	/** Does a loaded NOTAM change the zone over the range (a restricted area
	 *  "changed", QR?CH)? Its published periods are then in doubt. */
	amended?: boolean | undefined;
	/** The pilot's note of what a unit said of the zone. */
	note?: NotedState | undefined;
}

/** What a unit said of a zone, as the pilot noted it: its state from the
 *  minute the note was taken to the instant it holds until, inclusive. */
export interface NotedState {
	state: 'active' | 'inactive';
	notedAtMs: number;
	untilMs: number;
}

export interface ActivityAnswer {
	state: ActivityState;
	reason: ActivityReason;
	/** The period behind the answer, null for a permanent zone and for one
	 *  outside every period. */
	period: ActivePeriod | null;
	/** The levels the activating NOTAM states, on an answer it gives. */
	levels?: NotamLevels | undefined;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** The most days a dateless rule is walked over for one question: a year
 *  and a margin, which every weekly rule repeats within. */
const SCAN_DAYS = 400;

function dayStartMs(date: string): number | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
	if (!m) {
		return null;
	}
	return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function timeOfDayMs(t: string | undefined): number | null {
	if (!t) {
		return null;
	}
	const m = /^(\d{2}):(\d{2})$/.exec(t);
	if (!m) {
		return null;
	}
	const min = Number(m[1]) * 60 + Number(m[2]);
	return Number(m[2]) < 60 && min <= 24 * 60 ? min * 60_000 : null;
}

/** Does the rule print hours: a clock end, or an end the sun sets? */
function hasHours(r: ActivityRule): boolean {
	return timeOfDayMs(r.from) !== null || timeOfDayMs(r.to) !== null || hasSunEnd(r);
}

/** Does the rule hold at all times? */
function holdsAlways(r: ActivityRule): boolean {
	return (
		r.date === undefined &&
		r.dateTo === undefined &&
		r.startMs === undefined &&
		r.endMs === undefined &&
		r.schedule === undefined &&
		!hasHours(r) &&
		!hasDayRule(r)
	);
}

/** One rule's days from `d0` to `d1` as periods, in time order, read
 *  strictly per day: "Du 3 au 7, 0800-1200" is one period a day, a range
 *  with no hours one period over all its days however long, and one with a
 *  day rule one period per run of the days it holds. A day the rule takes
 *  off (its weekdays, the public holidays and their eves) holds none. A slot
 *  whose end reads before its start rolls past midnight, an end the sun
 *  sets is the sun's that day (data/supaip.ts sunWindow), and clock hours
 *  printed in winter UTC, a sun window's clock ends with them, are an hour
 *  earlier in summer. `emit` returns false to stop. */
function dayPeriods(
	r: ActivityRule,
	d0: number,
	d1: number,
	sun: SunLookup | undefined,
	emit: (p: ActivePeriod) => boolean,
): void {
	const rule = hasDayRule(r);
	if (hasSunEnd(r)) {
		for (let d = d0; d <= d1; d += DAY_MS) {
			if (rule && !activationHolds(r, d)) {
				continue;
			}
			const early = r.summerEarlier && isSummerUtc(d + DAY_MS / 2) ? HOUR_MS : 0;
			const [startMs, endMs] = sunWindow(r, d, sun, early);
			if (!emit({ startMs, endMs })) {
				return;
			}
		}
		return;
	}
	const from = timeOfDayMs(r.from);
	const to = timeOfDayMs(r.to);
	if (from === null && to === null) {
		if (!rule) {
			if (d1 >= d0) {
				emit({ startMs: d0, endMs: d1 + DAY_MS });
			}
			return;
		}
		let run: number | null = null;
		for (let d = d0; d <= d1 + DAY_MS; d += DAY_MS) {
			const held = d <= d1 && activationHolds(r, d);
			if (held && run === null) {
				run = d;
			} else if (!held && run !== null) {
				if (!emit({ startMs: run, endMs: d })) {
					return;
				}
				run = null;
			}
		}
		return;
	}
	const open = from ?? 0;
	const close = to ?? DAY_MS;
	for (let d = d0; d <= d1; d += DAY_MS) {
		if (rule && !activationHolds(r, d)) {
			continue;
		}
		const early = r.summerEarlier && isSummerUtc(d + open) ? HOUR_MS : 0;
		const endMs = close > open ? d + close : d + close + DAY_MS;
		if (!emit({ startMs: d + open - early, endMs: endMs - early })) {
			return;
		}
	}
}

/** A dated rule's periods, read whole once: a supplement's schedule is
 *  bounded, and the alerts ask about the same zones at every fix. */
const datedCache = new WeakMap<ActivityRule, { sun: SunLookup | undefined; periods: ActivePeriod[] }>();

function datedPeriods(r: ActivityRule, d0: number, d1: number, sun: SunLookup | undefined): ActivePeriod[] {
	const hit = datedCache.get(r);
	if (hit && hit.sun === sun) {
		return hit.periods;
	}
	const periods: ActivePeriod[] = [];
	dayPeriods(r, d0, d1, sun, (p) => {
		periods.push(p);
		return true;
	});
	datedCache.set(r, { sun, periods });
	return periods;
}

/** The periods of `r` that reach into [fromMs, toMs], in time order, `max`
 *  of them at most. A period is whole, the range asked about cutting none,
 *  and the rule's own bounds cut it. A dated rule is read whole; a dateless
 *  one is walked over the days of the question, from the first day of a run
 *  of held days reaching into it to its last, a year and a margin at most;
 *  a NOTAM's D) over the days of the question (notam/schedule.ts
 *  scheduleWindows). */
export function rulePeriods(
	r: ActivityRule,
	fromMs: number,
	toMs: number,
	sun?: SunLookup,
	max = Infinity,
): ActivePeriod[] {
	const lo = r.startMs ?? -Infinity;
	const hi = r.endMs ?? Infinity;
	const out: ActivePeriod[] = [];
	const take = (p: ActivePeriod): boolean => {
		const startMs = Math.max(p.startMs, lo);
		const endMs = Math.min(p.endMs, hi);
		if (startMs <= endMs && startMs <= toMs && endMs >= fromMs) {
			out.push(startMs === p.startMs && endMs === p.endMs ? p : { startMs, endMs });
		}
		return out.length < max;
	};
	if (r.schedule !== undefined) {
		const d = r.schedule;
		const span = { start: lo, end: hi };
		const slots = d === null ? null : scheduleWindows(span, d, { fromMs, toMs }, sun);
		let last: ActivePeriod | null = null;
		for (const w of slots ?? [{ startMs: lo, endMs: hi }]) {
			const p = d === null ? w : stretchOf(r, span, d, w, sun);
			if (p === last) {
				continue;
			}
			last = p;
			if (!take(p)) {
				break;
			}
		}
		return out;
	}
	const first = r.date !== undefined ? dayStartMs(r.date) : null;
	const last = r.dateTo !== undefined ? dayStartMs(r.dateTo) : first;
	if (r.date !== undefined) {
		if (first === null) {
			return out;
		}
		for (const p of datedPeriods(r, first, last ?? first, sun)) {
			if (!take(p)) {
				break;
			}
		}
		return out;
	}
	if (!hasHours(r) && !hasDayRule(r)) {
		take({ startMs: lo, endMs: last !== null ? Math.min(hi, last + DAY_MS) : hi });
		return out;
	}
	// Two days early: a slot opening the day before, or a night the sun sets
	// over two days, may reach into the range. A day late for hours an hour
	// earlier in summer: Friday's "00:00-11:00" opens on Thursday at 23:00.
	const start = Math.max(fromMs, lo);
	const end = Math.min(toMs, hi);
	if (!Number.isFinite(start) || !(start <= end)) {
		return out;
	}
	const late = r.summerEarlier ? DAY_MS : 0;
	let d0 = Math.floor(start / DAY_MS) * DAY_MS - 2 * DAY_MS;
	let d1 = Math.min(Math.floor(end / DAY_MS) * DAY_MS + late, d0 + SCAN_DAYS * DAY_MS);
	if (last !== null) {
		d1 = Math.min(d1, last);
	}
	if (!hasHours(r)) {
		for (let k = 0; k < SCAN_DAYS && activationHolds(r, d0 - DAY_MS); k++) {
			d0 -= DAY_MS;
		}
		for (let k = 0; k < SCAN_DAYS && (last === null || d1 < last) && activationHolds(r, d1 + DAY_MS); k++) {
			d1 += DAY_MS;
		}
	}
	dayPeriods(r, d0, d1, sun, take);
	return out;
}

/** The first period of a rule of `mode` reaching into the range. */
function firstPeriod(
	rules: readonly ActivityRule[],
	mode: ActivityMode,
	fromMs: number,
	toMs: number,
	sun: SunLookup | undefined,
): ActivePeriod | null {
	for (const r of rules) {
		if (r.mode !== mode) {
			continue;
		}
		const p = rulePeriods(r, fromMs, toMs, sun, 1)[0];
		if (p) {
			return p;
		}
	}
	return null;
}

/** A zone's state over [fromMs, toMs], first match winning:
 *
 *  1. a firm rule holding at all times: active, permanent;
 *  2. a period a NOTAM or the RTBA programme confirms: active, a NOTAM's
 *     in the windows of its D) item, whole where its D) is unread;
 *  3. a firm period: active;
 *  4. a period published as activable: activable;
 *  5. a period this reader has yet to read: activable;
 *  6. a period of activation by NOTAM: inactive where the briefing covers
 *     the zone over the range and holds no NOTAM for it, up to its time
 *     plus the zone's notice where the zone states one, else activable;
 *  7. outside every period: inactive.
 *
 *  An inactive answer for a zone a loaded NOTAM changes (`amended`) reads
 *  activable: its periods are in doubt. An active answer stays. Last, an
 *  activable answer over a range the pilot's note covers (`note`) takes
 *  the note's state: the unit asked has settled what the publication left
 *  open. A firm answer, active or inactive, stays. */
export function resolveActivity(input: ActivityInput, fromMs: number, toMs: number): ActivityAnswer {
	const read = readActivity(input, fromMs, toMs);
	const answer: ActivityAnswer =
		read.state === 'inactive' && input.amended === true ? { state: 'activable', reason: 'amended', period: null } : read;
	const note = input.note;
	if (answer.state === 'activable' && note && note.notedAtMs <= fromMs && note.untilMs >= toMs) {
		return { state: note.state, reason: 'noted', period: { startMs: note.notedAtMs, endMs: note.untilMs } };
	}
	return answer;
}

function readActivity(input: ActivityInput, fromMs: number, toMs: number): ActivityAnswer {
	const { rules, sun } = input;
	if (rules.some((r) => r.mode === 'firm' && holdsAlways(r))) {
		return { state: 'active', reason: 'permanent', period: null };
	}
	for (const c of input.confirmed ?? []) {
		const hit = confirmedIn(c, fromMs, toMs);
		if (hit) {
			const answer: ActivityAnswer = { state: 'active', reason: hit.unread ? 'notam-unread' : c.by, period: hit.period };
			return c.levels ? { ...answer, levels: c.levels } : answer;
		}
	}
	const firm = firstPeriod(rules, 'firm', fromMs, toMs, sun);
	if (firm) {
		return { state: 'active', reason: 'published', period: firm };
	}
	const activable = firstPeriod(rules, 'activable', fromMs, toMs, sun);
	if (activable) {
		return { state: 'activable', reason: 'activable', period: activable };
	}
	const unread = firstPeriod(rules, 'unread', fromMs, toMs, sun);
	if (unread) {
		return { state: 'activable', reason: 'unread', period: unread };
	}
	const byNotam = firstPeriod(rules, 'notam', fromMs, toMs, sun);
	if (byNotam) {
		const rtba = input.rtba === true;
		if (!input.briefed) {
			return { state: 'activable', reason: rtba ? 'rtba-unbriefed' : 'notam-unbriefed', period: byNotam };
		}
		const late = pastNotice(rules, input.briefedAtMs, fromMs, toMs, sun);
		return late
			? { state: 'activable', reason: 'notam-notice', period: late }
			: { state: 'inactive', reason: rtba ? 'rtba-none' : 'notam-none', period: byNotam };
	}
	return { state: 'inactive', reason: 'outside', period: null };
}

/** The first period of a by-NOTAM rule stating a notice that reaches past
 *  the briefing's time plus that notice, inside the range: an activation
 *  published after the briefing may hold there. */
function pastNotice(
	rules: readonly ActivityRule[],
	briefedAtMs: number | undefined,
	fromMs: number,
	toMs: number,
	sun: SunLookup | undefined,
): ActivePeriod | null {
	if (briefedAtMs === undefined) {
		return null;
	}
	for (const r of rules) {
		if (r.mode !== 'notam' || r.noticeMin === undefined) {
			continue;
		}
		const from = Math.max(fromMs, briefedAtMs + r.noticeMin * 60_000);
		const p = from <= toMs ? rulePeriods(r, from, toMs, sun, 1)[0] : undefined;
		if (p) {
			return p;
		}
	}
	return null;
}

/** The part of a confirmed period reaching into the range: its first D)
 *  window there, or the whole of it where it states no D) or its D) is
 *  unread over the range (`unread`). */
function confirmedIn(
	c: ConfirmedPeriod,
	fromMs: number,
	toMs: number,
): { period: ActivePeriod; unread: boolean } | null {
	if (c.startMs > toMs || c.endMs < fromMs) {
		return null;
	}
	const whole = { startMs: c.startMs, endMs: c.endMs };
	const d = c.schedule;
	if (d === undefined) {
		return { period: whole, unread: false };
	}
	const span = { start: c.startMs, end: c.endMs };
	const slots = d === null ? null : scheduleWindows(span, d, { fromMs, toMs }, c.sun);
	if (d === null || slots === null) {
		return { period: whole, unread: true };
	}
	const first = slots[0];
	return first ? { period: stretchOf(c, span, d, first, c.sun), unread: false } : null;
}

/** How many D) windows a stretch joins each way at most: two months of days. */
const STRETCH_MAX = 62;

const stretchCache = new WeakMap<object, Map<number, ActivePeriod>>();

/** The stretch a D) window belongs to: it and the windows continuing it,
 *  each opening the millisecond after the one before closes (an H24 day, a
 *  window closing at 2359 before one opening at 0000), read from the
 *  schedule on either side within `span`, STRETCH_MAX windows at most each
 *  way. One period, as a dated rule's run of held days is. Cached by its
 *  owner, a rule or a confirmed period, the alerts asking at every fix. */
function stretchOf(
	owner: object,
	span: { start: number; end: number },
	d: ItemDSchedule,
	w: ActivePeriod,
	sun: SunLookup | undefined,
): ActivePeriod {
	let byStart = stretchCache.get(owner);
	const hit = byStart?.get(w.startMs);
	if (hit) {
		return hit;
	}
	let start = w.startMs;
	let end = w.endMs;
	for (let i = 0; i < STRETCH_MAX && end < span.end; i++) {
		const next = scheduleWindows(span, d, { fromMs: end + 1, toMs: end + 1 }, sun)?.find((x) => x.startMs === end + 1);
		if (!next) {
			break;
		}
		end = next.endMs;
	}
	for (let i = 0; i < STRETCH_MAX && start > span.start; i++) {
		const prev = scheduleWindows(span, d, { fromMs: start - 1, toMs: start - 1 }, sun)?.find((x) => x.endMs === start - 1);
		if (!prev) {
			break;
		}
		start = prev.startMs;
	}
	const out = start === w.startMs && end === w.endMs ? w : { startMs: start, endMs: end };
	if (!byStart) {
		byStart = new Map();
		stretchCache.set(owner, byStart);
	}
	byStart.set(w.startMs, out);
	return out;
}

/** The first instant in (afterMs, untilMs] a confirmed period comes into
 *  force: its start, or a window of its D) item opening, read over
 *  SCAN_DAYS at most. Null where none does: the map draws a zone it finds
 *  as activated later in the viewing period. */
export function nextConfirmedStart(
	confirmed: readonly ConfirmedPeriod[] | undefined,
	afterMs: number,
	untilMs: number,
): number | null {
	const toMs = Math.min(untilMs, afterMs + SCAN_DAYS * DAY_MS);
	let first: number | null = null;
	for (const c of confirmed ?? []) {
		if (c.startMs > toMs || c.endMs <= afterMs) {
			continue;
		}
		const slots =
			c.schedule === undefined || c.schedule === null
				? null
				: scheduleWindows({ start: c.startMs, end: c.endMs }, c.schedule, { fromMs: afterMs, toMs }, c.sun);
		for (const w of slots ?? [{ startMs: c.startMs, endMs: c.endMs }]) {
			if (w.startMs > afterMs && w.startMs <= toMs && (first === null || w.startMs < first)) {
				first = w.startMs;
			}
		}
	}
	return first;
}

/** The first instant in (afterMs, untilMs] a period of the zone's own
 *  rules begins that may make it active (firm, activable or unread; a
 *  period by NOTAM waits for its NOTAM), read over SCAN_DAYS at most. Null
 *  where none does: a temporary zone the map draws as later in the
 *  viewing period. */
export function nextRuleStart(
	activity: ZoneActivity,
	afterMs: number,
	untilMs: number,
): number | null {
	const toMs = Math.min(untilMs, afterMs + SCAN_DAYS * DAY_MS);
	let first: number | null = null;
	for (const r of activity.rules) {
		if (r.mode === 'notam') {
			continue;
		}
		// The period in force at afterMs, if any, comes first: the next
		// one is the second.
		for (const p of rulePeriods(r, afterMs, toMs, activity.sun, 2)) {
			if (p.startMs > afterMs && p.startMs <= toMs && (first === null || p.startMs < first)) {
				first = p.startMs;
			}
		}
	}
	return first;
}

/** How many period boundaries nextChange reads at most. */
const MAX_CHANGES = 32;

/** The first instant after `afterMs`, up to `untilMs`, at which the zone's
 *  state changes, with the answer from then: the boundaries of its periods,
 *  a confirmed period's D) windows and the end of a briefing's notice, in
 *  time order, MAX_CHANGES of them at most. Null where the state holds
 *  through. */
export function nextChange(
	input: ActivityInput,
	afterMs: number,
	untilMs: number,
): { atMs: number; answer: ActivityAnswer } | null {
	const now = resolveActivity(input, afterMs, afterMs).state;
	const marks = new Set<number>();
	const mark = (p: ActivePeriod): void => {
		marks.add(p.startMs);
		marks.add(p.endMs + 1);
	};
	for (const r of input.rules) {
		rulePeriods(r, afterMs, untilMs, input.sun, MAX_CHANGES).forEach(mark);
		if (r.mode === 'notam' && r.noticeMin !== undefined && input.briefedAtMs !== undefined) {
			marks.add(input.briefedAtMs + r.noticeMin * 60_000);
		}
	}
	for (const c of input.confirmed ?? []) {
		const slots =
			c.schedule === undefined || c.schedule === null
				? null
				: scheduleWindows({ start: c.startMs, end: c.endMs }, c.schedule, { fromMs: afterMs, toMs: untilMs }, c.sun);
		(slots ?? [c]).forEach(mark);
	}
	if (input.note) {
		marks.add(input.note.untilMs + 1);
	}
	const at = [...marks].filter((t) => Number.isFinite(t) && t > afterMs && t <= untilMs).sort((a, b) => a - b);
	for (const t of at.slice(0, MAX_CHANGES)) {
		const answer = resolveActivity(input, t, t);
		if (answer.state !== now) {
			return { atMs: t, answer };
		}
	}
	return null;
}
