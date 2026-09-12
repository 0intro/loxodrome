/* Interpret the operating hours a French FIS sector publishes, so a flight
 * outside them is not told to call a unit that is not on watch.
 *
 * The AIP states them in two columns the dataset carries verbatim, `workHr`
 * (H24 / HX / HO) and `rmkWorkHr` (the schedule text). Across the 110 SIV and
 * FIC rows there are exactly three schedule shapes, and this reads those and
 * answers UNKNOWN for anything else:
 *
 *   0600-2100 (SUM : -1 HR)                       SEINE 1-8
 *   SAT-SUN : 0700-1900#(SUM -1 HR)               LE BOURGET
 *   SUM : 0800 - SS+30 (MAX 1730)#                CHEVREUSE 1-3
 *   WIN : 0900 - SS+30 (MAX 1830)
 *
 * The asymmetry is the same one notam/schedule.ts applies to a NOTAM's D)
 * item and for the same reason: a consumer that WITHDRAWS a published
 * frequency on a schedule must not do so on a guess, so an unread schedule
 * reads as unknown and the caller keeps briefing the sector. 46 of the rows
 * publish no schedule text at all (a bare HX), and they are exactly that
 * case.
 *
 * SUM / WIN are the European summer-time halves of the year, and the SIA
 * writes the two conventions the AIP uses: a season-prefixed line per half,
 * or one line plus a "(SUM -1 HR)" note, which shifts the stated UTC window
 * an hour earlier because the local clock does not move. Times are UTC
 * throughout, as the AIP publishes them.
 *
 * Pure, no Svelte, no I/O; pinned by tests/airspaceHours.spec.ts. The consumer
 * is the schedule's radio resolution (docs/siv-frequencies.md). */

import { permanentHours } from '$lib/data/airspaceEntry';
import { sunTimesUtc } from './sun';

/** A closing time: a clock time, or sunset plus an offset but never later
 *  than a stated cap ("SS+30 (MAX 1730)"). */
export type HoursClose =
	| { kind: 'clock'; min: number }
	| { kind: 'sunset'; offsetMin: number; capMin: number };

/** One season's daily window, minutes from 00:00 UTC. */
export interface HoursWindow {
	fromMin: number;
	to: HoursClose;
}

export interface SectorHours {
	/** UTC weekdays the sector operates (0 = Sunday … 6 = Saturday); null =
	 *  every day. */
	days: Set<number> | null;
	winter: HoursWindow;
	summer: HoursWindow;
}

const DAY_MS = 24 * 3600_000;
const MIN_MS = 60_000;

const WEEKDAYS: Record<string, number> = {
	SUN: 0,
	MON: 1,
	TUE: 2,
	WED: 3,
	THU: 4,
	FRI: 5,
	SAT: 6,
};

/** The instant European summer time begins and ends: the last Sunday of March
 *  and of October, 01:00 UTC. */
function lastSundayUtc(year: number, month: number): number {
	const last = new Date(Date.UTC(year, month + 1, 0));
	last.setUTCDate(last.getUTCDate() - last.getUTCDay());
	return last.getTime() + 3600_000;
}

/** Is this instant inside European summer time? */
export function isSummerUtc(ms: number): boolean {
	const y = new Date(ms).getUTCFullYear();
	return ms >= lastSundayUtc(y, 2) && ms < lastSundayUtc(y, 9);
}

function timeMin(hhmm: string): number | null {
	const h = Number(hhmm.slice(0, 2));
	const m = Number(hhmm.slice(2, 4));
	return Number.isFinite(h) && Number.isFinite(m) && h <= 24 && m <= 59 ? h * 60 + m : null;
}

/** "SAT-SUN", "MON-FRI", "SAT SUN", "SAT,SUN" -> the weekday numbers, or null
 *  when the text is not a day list. A range wraps through Sunday, which is how
 *  a published "SAT-SUN" reads. */
function parseDays(text: string): Set<number> | null {
	const toks = text.toUpperCase().split(/[\s,]+/).filter(Boolean);
	if (toks.length === 0) {
		return null;
	}
	const out = new Set<number>();
	for (const tok of toks) {
		const range = /^([A-Z]{3})-([A-Z]{3})$/.exec(tok);
		if (range) {
			const from = WEEKDAYS[range[1]];
			const to = WEEKDAYS[range[2]];
			if (from === undefined || to === undefined) {
				return null;
			}
			for (let d = from; ; d = (d + 1) % 7) {
				out.add(d);
				if (d === to) {
					break;
				}
			}
			continue;
		}
		const day = WEEKDAYS[tok];
		if (day === undefined) {
			return null;
		}
		out.add(day);
	}
	return out;
}

const CLOCK_RANGE_RE = /(\d{4})\s*-\s*(\d{4})/;
const SUNSET_RE = /(\d{4})\s*-\s*SS\s*\+\s*(\d{1,3})\s*\(\s*MAX\s*(\d{4})\s*\)/i;

/** One schedule line -> its window, or null. */
function parseWindow(line: string): HoursWindow | null {
	const ss = SUNSET_RE.exec(line);
	if (ss) {
		const from = timeMin(ss[1]);
		const cap = timeMin(ss[3]);
		const offset = Number(ss[2]);
		if (from == null || cap == null || !Number.isFinite(offset)) {
			return null;
		}
		return { fromMin: from, to: { kind: 'sunset', offsetMin: offset, capMin: cap } };
	}
	const clock = CLOCK_RANGE_RE.exec(line);
	if (clock) {
		const from = timeMin(clock[1]);
		const to = timeMin(clock[2]);
		if (from == null || to == null || to <= from) {
			return null; // a window crossing midnight is not a shape the corpus uses
		}
		return { fromMin: from, to: { kind: 'clock', min: to } };
	}
	return null;
}

/** Shift a window an hour earlier, the "(SUM : -1 HR)" note: the local clock
 *  does not move, so the UTC times do. */
function shifted(w: HoursWindow, deltaMin: number): HoursWindow {
	return {
		fromMin: w.fromMin + deltaMin,
		to:
			w.to.kind === 'clock'
				? { kind: 'clock', min: w.to.min + deltaMin }
				: { ...w.to, capMin: w.to.capMin + deltaMin },
	};
}

const SUMMER_SHIFT_RE = /\(\s*SUM\s*:?\s*-\s*1\s*HR?\s*\)/i;
const SEASON_LINE_RE = /^\s*(SUM|WIN)\s*:\s*(.*)$/i;

/** Read a sector's published hours. Returns 'always' for a permanently open
 *  one (the H24 rows, which is 52 of the 110), a SectorHours when the schedule
 *  text is one of the published shapes, and null for UNKNOWN, which every
 *  consumer must treat as "assume open".
 *
 *  Memoised on its two inputs, which take a handful of distinct values across
 *  every publisher (the French rows hold eight pairs between them), while the
 *  caller asks once per schedule event per evaluation and the live one
 *  evaluates at 1 Hz. A cached result is SHARED, so no consumer may mutate it;
 *  nothing does, `sectorActiveIn` only reads. */
const hoursCache = new Map<string, SectorHours | 'always' | null>();

export function parseSectorHours(workHr: string, rmkWorkHr: string): SectorHours | 'always' | null {
	const key = `${workHr}\u0000${rmkWorkHr}`;
	// `undefined` is never stored, so it means a miss and a cached `null` (a
	// schedule read as unknown) still answers from the cache.
	const hit = hoursCache.get(key);
	if (hit !== undefined) {
		return hit;
	}
	const parsed = parseSectorHoursUncached(workHr, rmkWorkHr);
	hoursCache.set(key, parsed);
	return parsed;
}

function parseSectorHoursUncached(
	workHr: string,
	rmkWorkHr: string,
): SectorHours | 'always' | null {
	if (permanentHours(workHr)) {
		return 'always';
	}
	const lines = rmkWorkHr
		.split(/[#\n\r]+/)
		.map((l) => l.trim())
		.filter(Boolean);
	if (lines.length === 0) {
		return null;
	}
	// Season-prefixed lines: each names its own half of the year.
	let summer: HoursWindow | null = null;
	let winter: HoursWindow | null = null;
	let days: Set<number> | null = null;
	let plain: HoursWindow | null = null;
	let shift = false;
	for (const line of lines) {
		if (SUMMER_SHIFT_RE.test(line)) {
			shift = true;
		}
		const season = SEASON_LINE_RE.exec(line);
		if (season) {
			const w = parseWindow(season[2]);
			if (w == null) {
				continue;
			}
			if (season[1].toUpperCase() === 'SUM') {
				summer ??= w;
			} else {
				winter ??= w;
			}
			continue;
		}
		if (plain != null) {
			continue;
		}
		const w = parseWindow(line);
		if (w == null) {
			continue;
		}
		// The day list is read off the SAME line as the window it qualifies
		// ("SAT-SUN : 0700-1900"), never carried across from an earlier one: a
		// line stating days and no window is a shape this does not know, and
		// binding its days to some later line's window would invent a schedule
		// neither line states.
		const head = line.split(':')[0];
		if (head !== line) {
			days = parseDays(head);
		}
		plain = w;
	}
	if (summer != null && winter != null) {
		return { days, summer, winter };
	}
	if (plain == null) {
		return null;
	}
	if (!shift) {
		return { days, winter: plain, summer: plain };
	}
	const summerShifted = shifted(plain, -60);
	// A window the summer shift would push back across midnight is outside the
	// shapes read here: evaluated as-is it would open on the previous UTC day,
	// so it reads as unknown and the sector goes on being briefed.
	if (summerShifted.fromMin < 0) {
		return null;
	}
	return { days, winter: plain, summer: summerShifted };
}

/** The window(s) that can be in force on a UTC day.
 *
 *  The season is read at the window's OWN opening instant, not at the start of
 *  the day. European summer time always switches on a Sunday at 01:00 UTC, so a
 *  day can begin in one season and run its whole published window in the other,
 *  and LE BOURGET is a Saturday/Sunday sector, which puts both transitions on an
 *  operational day: judged by its 00:00 season, 2026-03-29 would take the winter
 *  window opening at 0700Z while the sector is in fact working the summer one
 *  from 0600Z. Withdrawing a frequency a unit is on is the one thing this must
 *  not do.
 *
 *  Each candidate is kept only where the season at its own opening agrees with
 *  the season it belongs to, which on an ordinary day keeps exactly one and on a
 *  transition day picks the one actually in force. A window opening before the
 *  01:00 switch could satisfy neither (none in the corpus does); rather than
 *  read that as a closed day, both stand, which errs towards on watch. */
function windowsOn(hours: SectorHours, dayStart: number): HoursWindow[] {
	if (hours.summer === hours.winter) {
		return [hours.summer];
	}
	const inForce = ([w, isSummer]: [HoursWindow, boolean]) =>
		isSummerUtc(dayStart + w.fromMin * MIN_MS) === isSummer;
	const kept = ([[hours.summer, true], [hours.winter, false]] as [HoursWindow, boolean][])
		.filter(inForce)
		.map(([w]) => w);
	return kept.length > 0 ? kept : [hours.summer, hours.winter];
}

/** The window's closing minute on a given UTC day, resolving a sunset-relative
 *  one against `pos`. Null when it cannot be resolved (no position, or a polar
 *  day / night), which makes the whole answer unknown. */
function closeMin(w: HoursWindow, dayMs: number, pos: { lat: number; lon: number } | null): number | null {
	if (w.to.kind === 'clock') {
		return w.to.min;
	}
	if (pos == null) {
		return null;
	}
	const sun = sunTimesUtc(pos.lat, pos.lon, new Date(dayMs).toISOString().slice(0, 10));
	if (sun == null || sun.sunset.kind !== 'time') {
		return null;
	}
	return Math.min(sun.sunset.minutesUtc + w.to.offsetMin, w.to.capMin);
}

/** Is the sector on watch at some instant of [fromMs, toMs]? A live surface
 *  passes fromMs === toMs, a planning one the flight's own span.
 *
 *  null = UNKNOWN, which every caller must read as "assume open": an
 *  unpublished schedule, or a sunset-relative one with no position to resolve
 *  it against. Pure, UTC. */
export function sectorActiveIn(
	hours: SectorHours | 'always' | null,
	at: { fromMs: number; toMs: number },
	pos: { lat: number; lon: number } | null = null,
): boolean | null {
	if (hours == null) {
		return null;
	}
	if (hours === 'always') {
		return true;
	}
	const from = at.fromMs;
	const to = at.toMs;
	if (!(from <= to)) {
		return false;
	}
	// Any range of eight whole days contains every weekday, and with it every
	// day the schedule names, so one of its windows occurs. This is what bounds
	// the walk below against an unbounded evaluation range.
	if (to - from >= 8 * DAY_MS) {
		return true;
	}
	let unknown = false;
	for (let dayStart = Math.floor(from / DAY_MS) * DAY_MS; dayStart <= to; dayStart += DAY_MS) {
		if (hours.days !== null && !hours.days.has(new Date(dayStart).getUTCDay())) {
			continue;
		}
		for (const w of windowsOn(hours, dayStart)) {
			const close = closeMin(w, dayStart, pos);
			if (close == null) {
				unknown = true;
				continue;
			}
			const openMs = dayStart + w.fromMin * MIN_MS;
			const closeMs = dayStart + close * MIN_MS;
			if (closeMs > openMs && from <= closeMs && to >= openMs) {
				return true;
			}
		}
	}
	// No day answered yes, but one could not be read: that is not a "no".
	return unknown ? null : false;
}
