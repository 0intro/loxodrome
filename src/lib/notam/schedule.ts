/* Interpret a NOTAM's D) item: the schedule WITHIN the B)-C) validity during
 * which the condition is actually in force. ICAO Doc 8126 / OPADD leave D) as
 * lightly-structured text, so this reads the shapes the corpus actually uses
 * and answers "unknown" for everything else:
 *
 *   0600-1800                          a daily UTC window
 *   01-07 09-12 14 16-26 28-31 H24     day-of-month list + whole-day marker
 *   MON-FRI 0000-0559, SAT-SUN H24     weekday selectors, one clause each
 *   SEP 21 28 0630-1000, OCT 01 H24    calendar dates
 *   AUG 03-OCT 24 0500-1600            a date range across months
 *   SR-SS, SR MINUS30-SS PLUS30        sunrise / sunset anchors
 *   0700-1000 EXC JUL 05 12            an exclusion of named dates
 *
 * A D) item is a list of CLAUSES separated by commas, each its own selector
 * and its own windows, and the schedule is their union. Reading the tokens
 * without the clauses is the one failure that is worse than answering
 * unknown: "19 1530-1830, 25 0800-1830" would merge into "the 19th or the
 * 25th, 1530-1830 or 0800-1830" and claim the 19th is in force at 09:00,
 * which the NOTAM never said. 93 of the 359 French D) items in the 2026-09
 * corpus carry several clauses.
 *
 * The asymmetry is deliberate and safety-directed: a consumer that CLOSES a
 * published frequency on a schedule must not do so on a guess, so an
 * unparseable D) reads as unknown (null), never as "always" or "never"
 * (docs/notam-relationships.md, service closures). Pure, UTC throughout, no
 * Svelte, no I/O; pinned by tests/notamSchedule.spec.ts. */

/** Minutes from UTC midnight, or an anchor on the day's own sun. `offsetMin`
 *  is signed, so "SS PLUS30" is `{ kind: 'ss', offsetMin: 30 }`. */
export type Anchor =
	| { kind: 'clock'; min: number }
	| { kind: 'sr' | 'ss'; offsetMin: number };

/** One daily window. `to` before `from` crosses midnight. */
export interface Window {
	from: Anchor;
	to: Anchor;
}

/** A calendar date the item names. `month` is 1-12. */
export interface DateSel {
	month: number;
	day: number;
}

/** Which days a clause picks out. Every field null means "every day". */
export interface Selector {
	/** Days of the month (1-31). */
	days: Set<number> | null;
	/** Weekdays, 0 = Sunday, the getUTCDay convention. */
	weekdays: Set<number> | null;
	/** Explicit calendar dates. */
	dates: DateSel[] | null;
	/** An inclusive range, which may run across months or the new year. */
	range: { from: DateSel; to: DateSel } | null;
}

/** One clause of a D) item: when it applies, and during which windows.
 *  `windows` null means H24. */
export interface Clause extends Selector {
	windows: Window[] | null;
	/** Days the clause takes back out: "EXC JUL 14", "EXC SAT SUN",
	 *  "EXC 14-18". Each is read by the same selector grammar. */
	exc: Selector[];
}

/** A parsed D) schedule: the union of its clauses. */
export interface ItemDSchedule {
	clauses: Clause[];
}

/** The day's sunrise and sunset in minutes from UTC midnight, for the
 *  position the NOTAM is about. Returning null makes an SR/SS clause
 *  unknown, which is what a caller with no position should do. */
export interface SunTimes {
	sunriseMin: number;
	sunsetMin: number;
}
export type SunLookup = (dayStartMs: number) => SunTimes | null;

// ICAO abbreviations only. The French weekday abbreviations are deliberately
// NOT accepted: MAR is Tuesday to a French reader and March to an ICAO one,
// and a D) item mixes weekdays with month names, so one table cannot hold
// both without guessing. D) is coded, not prose; the corpus writes MON-FRI in
// the French and the English publication alike.
const WEEKDAYS: Record<string, number> = {
	SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
};
const MONTHS: Record<string, number> = {
	JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
	JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

const TIME_RE = /\b(\d{4})-(\d{4})\b/g;
const SUN_TERM = String.raw`(SR|SS)(?:\s*(MINUS|PLUS|\+|-)\s*(\d{1,3}))?`;
const SUN_RE = new RegExp(String.raw`\b${SUN_TERM}\s*-\s*${SUN_TERM}`, 'g');
const SUN_CLOCK_RE = new RegExp(String.raw`\b${SUN_TERM}\s*-\s*(\d{4})\b|\b(\d{4})\s*-\s*${SUN_TERM}`, 'g');

function clockMin(hhmm: string): number | null {
	const h = Number(hhmm.slice(0, 2));
	const m = Number(hhmm.slice(2, 4));
	return h <= 24 && m <= 59 ? h * 60 + m : null;
}

function sunAnchor(kind: string, sign: string | undefined, value: string | undefined): Anchor {
	const n = value == null ? 0 : Number(value);
	const negative = sign === 'MINUS' || sign === '-';
	return { kind: kind.toLowerCase() as 'sr' | 'ss', offsetMin: negative ? -n : n };
}

/** Pull every window out of `text`, returning them with the text they
 *  occupied blanked so the selector can be read from what is left. */
function takeWindows(text: string): { windows: Window[] | null; rest: string; bad: boolean } {
	let rest = text;
	const windows: Window[] = [];
	let bad = false;
	const blank = (m: string, at: number): void => {
		rest = rest.slice(0, at) + ' '.repeat(m.length) + rest.slice(at + m.length);
	};
	for (const m of [...text.matchAll(SUN_RE)]) {
		windows.push({ from: sunAnchor(m[1], m[2], m[3]), to: sunAnchor(m[4], m[5], m[6]) });
		blank(m[0], m.index ?? 0);
	}
	for (const m of [...rest.matchAll(SUN_CLOCK_RE)]) {
		if (m[1] != null) {
			const to = clockMin(m[4]);
			if (to == null) {
				bad = true;
			} else {
				windows.push({ from: sunAnchor(m[1], m[2], m[3]), to: { kind: 'clock', min: to } });
			}
		} else {
			const from = clockMin(m[5]);
			if (from == null) {
				bad = true;
			} else {
				windows.push({ from: { kind: 'clock', min: from }, to: sunAnchor(m[6], m[7], m[8]) });
			}
		}
		blank(m[0], m.index ?? 0);
	}
	for (const m of [...rest.matchAll(TIME_RE)]) {
		const from = clockMin(m[1]);
		const to = clockMin(m[2]);
		if (from == null || to == null) {
			bad = true;
		} else {
			windows.push({ from: { kind: 'clock', min: from }, to: { kind: 'clock', min: to } });
		}
		blank(m[0], m.index ?? 0);
	}
	let h24 = false;
	rest = rest.replace(/\bH24\b/g, () => {
		h24 = true;
		return '   ';
	});
	// H24 beside windows contradicts itself; unknown rather than a pick.
	if (h24 && windows.length > 0) {
		bad = true;
	}
	return { windows: h24 || windows.length === 0 ? null : windows, rest, bad };
}

/** Read a date list ("JUL 05 12 AUG 02", "SEP 22-24 29-30 OCT 01") from
 *  tokens, or null when a token is not a date. */
function readDates(tokens: string[]): DateSel[] | null {
	const out: DateSel[] = [];
	let month: number | null = null;
	for (const t of tokens) {
		const m = MONTHS[t];
		if (m != null) {
			month = m;
			continue;
		}
		const range = /^(\d{1,2})(?:-(\d{1,2}))?$/.exec(t);
		if (!range || month == null) {
			return null;
		}
		const from = Number(range[1]);
		const to = range[2] != null ? Number(range[2]) : from;
		if (from < 1 || to > 31 || to < from) {
			return null;
		}
		for (let d = from; d <= to; d++) {
			out.push({ month, day: d });
		}
	}
	return out.length > 0 ? out : null;
}

/** Words that qualify a clause without selecting anything: DAILY and EVERY
 *  say "every day", which is already what an empty selector means. Belgium
 *  and Germany write them on three D) items in four ("DAILY 0700-1800",
 *  "EVERY MON-FRI H24"), and refusing the token used to make the whole
 *  schedule unknown; France writes neither, which is why the French corpus
 *  never showed it. */
const NOOP_RE = /\b(?:DAILY|EVERY|QUOTIDIEN(?:NEMENT)?|TOUS\s+LES\s+JOURS)\b/g;

/** The selector half of a clause: day numbers, weekdays or calendar dates. */
function readSelector(text: string): Selector | null {
	const empty = { days: null, weekdays: null, dates: null, range: null };
	const t = text.replace(NOOP_RE, ' ').trim();
	if (t === '') {
		return empty;
	}
	// A range across months: "AUG 03-OCT 24".
	const cross = /^([A-Z]{3})\s*(\d{1,2})\s*-\s*([A-Z]{3})\s*(\d{1,2})$/.exec(t);
	if (cross && MONTHS[cross[1]] != null && MONTHS[cross[3]] != null) {
		return {
			...empty,
			range: {
				from: { month: MONTHS[cross[1]], day: Number(cross[2]) },
				to: { month: MONTHS[cross[3]], day: Number(cross[4]) },
			},
		};
	}
	const tokens = t.split(/\s+/).filter(Boolean);
	if (tokens.some((x) => MONTHS[x] != null)) {
		const dates = readDates(tokens);
		return dates ? { ...empty, dates } : null;
	}
	let days: Set<number> | null = null;
	let weekdays: Set<number> | null = null;
	for (const token of tokens) {
		const wd = /^([A-Z]{3})(?:-([A-Z]{3}))?$/.exec(token);
		if (wd && WEEKDAYS[wd[1]] != null && (wd[2] == null || WEEKDAYS[wd[2]] != null)) {
			weekdays ??= new Set();
			const from = WEEKDAYS[wd[1]];
			const to = wd[2] != null ? WEEKDAYS[wd[2]] : from;
			// MON-SUN and FRI-SUN both walk forward, wrapping at Saturday.
			for (let i = 0; i < 7; i++) {
				const d = (from + i) % 7;
				weekdays.add(d);
				if (d === to) {
					break;
				}
			}
			continue;
		}
		const dayRange = /^(\d{1,2})(?:-(\d{1,2}))?$/.exec(token);
		if (dayRange) {
			const from = Number(dayRange[1]);
			const to = dayRange[2] != null ? Number(dayRange[2]) : from;
			if (from < 1 || to > 31 || to < from) {
				return null;
			}
			days ??= new Set();
			for (let d = from; d <= to; d++) {
				days.add(d);
			}
			continue;
		}
		return null;
	}
	return { ...empty, days, weekdays };
}

/** Parse a D) item's text, or null when any clause falls outside the
 *  supported subset (the whole schedule is then unknown: a half-read
 *  schedule would silently drop what it did not understand). Pure. */
export function parseItemD(text: string): ItemDSchedule | null {
	if (typeof text !== 'string' || text.trim() === '') {
		return null;
	}
	const clauses: Clause[] = [];
	for (const piece of text.trim().toUpperCase().split(',')) {
		if (piece.trim() === '') {
			continue;
		}
		// An exclusion runs to the end of its clause: "TUE-THU 0530-1000 EXC
		// JUL 14". It may itself carry commas, which the split above has
		// already cut, so a clause that is only dates extends the previous
		// clause's exclusion rather than opening a new clause.
		const cut = /\bEXC\b/.exec(piece);
		const head = cut ? piece.slice(0, cut.index) : piece;
		const excText = cut ? piece.slice(cut.index + 3) : '';
		const { windows, rest, bad } = takeWindows(head);
		if (bad) {
			return null;
		}
		const selector = readSelector(rest);
		if (!selector) {
			// A clause with neither a window nor a readable selector, sitting
			// after an exclusion, is that exclusion continuing ("EXC APR 06
			// MAY 01, 08 14"). Anything else is unknown.
			const more = clauses.length > 0 ? readSelector(piece) : null;
			if (more && windows === null) {
				clauses[clauses.length - 1].exc.push(more);
				continue;
			}
			return null;
		}
		// An exclusion is a selector too: the corpus writes "EXC JUL 14",
		// "EXC SAT SUN" and "EXC 14-18" for the same job.
		let exc: Selector[] = [];
		if (excText.trim() !== '') {
			const sel = readSelector(excText);
			if (!sel) {
				return null;
			}
			exc = [sel];
		}
		clauses.push({ ...selector, windows, exc });
	}
	return clauses.length > 0 ? { clauses } : null;
}

const DAY_MS = 24 * 3600_000;

/** How many days scheduleActiveIn walks at most: a year and a margin, which
 *  nearly every recurring selector repeats within (see the loop). */
const SCAN_DAYS = 400;

function dateMatches(sel: DateSel, month: number, day: number): boolean {
	return sel.month === month && sel.day === day;
}

/** Whether `sel` picks out the UTC day starting at `dayStart`. An all-null
 *  selector picks every day, which is what a windows-only clause means. */
function selectorMatchesDay(sel: Selector, dayStart: number): boolean {
	const d = new Date(dayStart);
	const month = d.getUTCMonth() + 1;
	const day = d.getUTCDate();
	if (sel.days !== null && !sel.days.has(day)) {
		return false;
	}
	if (sel.weekdays !== null && !sel.weekdays.has(d.getUTCDay())) {
		return false;
	}
	if (sel.dates !== null && !sel.dates.some((x) => dateMatches(x, month, day))) {
		return false;
	}
	if (sel.range !== null) {
		const at = month * 100 + day;
		const from = sel.range.from.month * 100 + sel.range.from.day;
		const to = sel.range.to.month * 100 + sel.range.to.day;
		// A range that ends before it starts runs over the new year.
		if (!(from <= to ? at >= from && at <= to : at >= from || at <= to)) {
			return false;
		}
	}
	return true;
}

/** Whether `clause` selects the UTC day starting at `dayStart`. */
function clauseSelectsDay(clause: Clause, dayStart: number): boolean {
	if (clause.exc.some((x) => selectorMatchesDay(x, dayStart))) {
		return false;
	}
	return selectorMatchesDay(clause, dayStart);
}

/** Resolve one anchor to minutes from the day's midnight, or null when the
 *  day's sun is unknown. */
function anchorMin(a: Anchor, sun: SunTimes | null): number | null {
	if (a.kind === 'clock') {
		return a.min;
	}
	if (!sun) {
		return null;
	}
	return (a.kind === 'sr' ? sun.sunriseMin : sun.sunsetMin) + a.offsetMin;
}

/** Whether the schedule is in force at some instant of [fromMs, toMs] within
 *  the B)-C) validity `span` (both inclusive; a live surface passes
 *  fromMs === toMs, a planning surface its evaluation window).
 *
 *  `d` is the parsed schedule: undefined = the NOTAM has no D) item (the
 *  validity alone decides), null = it has one that did not parse, which makes
 *  the answer UNKNOWN (null). `sun` resolves a day's sunrise and sunset for
 *  the position the NOTAM is about; without it an SR/SS clause is unknown
 *  too. A range longer than the walk's horizon (SCAN_DAYS) that nothing
 *  decided inside it is unknown as well. The caller must fall back to a flag,
 *  never to a guess. Pure, UTC. */
export function scheduleActiveIn(
	span: { start: number; end: number },
	d: ItemDSchedule | null | undefined,
	at: { fromMs: number; toMs: number },
	sun?: SunLookup,
): boolean | null {
	const from = Math.max(at.fromMs, span.start);
	const to = Math.min(at.toMs, span.end);
	if (!(from <= to)) {
		return false;
	}
	if (d === undefined) {
		return true;
	}
	if (d === null) {
		return null;
	}
	let unknown = false;
	// Any range spanning three whole months contains every day-of-month value
	// (three consecutive months always include a 31-day one) and every
	// weekday, so a clause with no calendar selector certainly occurs, and one
	// selecting on EITHER alone does too. Not one selecting on both, which is
	// their conjunction: "13 FRI" names a Friday the 13th, and 1 January to
	// 1 May 2027 holds none.
	const wide = to - from >= 93 * DAY_MS;
	for (const clause of d.clauses) {
		if (
			wide &&
			clause.dates === null &&
			clause.range === null &&
			clause.exc.length === 0 &&
			(clause.days === null || clause.weekdays === null)
		) {
			if (clause.windows === null || clause.windows.every((w) => w.from.kind === 'clock' && w.to.kind === 'clock')) {
				return true;
			}
		}
	}
	// A WINDOW IS NAMED BY THE DAY IT OPENS. "MON-FRI 2230-0300" is five
	// periods that each begin on a weekday and end the following morning, so
	// Friday's runs into Saturday and none of them runs into Monday's small
	// hours (ICAO Doc 8126 5.3.4: item D states periods of activity, and a
	// period is stated from its start). Each window is therefore turned into
	// ONE absolute interval anchored on its opening day rather than split
	// into two same-day halves, which attributed every tail to the day the
	// window opened on and so shifted the whole night one day early: A5855/26
	// closes Basel's runway MON-FRI 2230-0300 and it read open all Saturday
	// morning and closed on Monday's, neither of which the NOTAM says.
	//
	// The loop starts one day EARLY for the same reason: a period reaching
	// into the range may have opened before it.
	const firstDay = Math.floor(from / DAY_MS) * DAY_MS - DAY_MS;
	// The walk is day by day, so it is BOUNDED before it starts. The viewing
	// period's look-ahead is unbounded by default and so is a NOTAM with no
	// C) (PERM, or one that did not parse), and a clause that can never match
	// ("APR 31") or an SR/SS window with no position to read the sun at then
	// never let the loop end: the app froze inside a derived on one pasted
	// NOTAM. Nearly every selector this grammar reads recurs within a year (a
	// date, a cross-month range, a weekday, a day of the month), so a year and
	// a margin past the start decides them; the two that do not are a
	// day-of-month and weekday pair (a Friday 13th can come 14 months after
	// the last) and FEB 29 (four years). Past that horizon an undecided range
	// is UNKNOWN rather than "never", which the callers turn into a note, so
	// what the bound cuts short is never answered a wrong "no".
	const lastDay = Math.min(to, firstDay + SCAN_DAYS * DAY_MS);
	for (let dayStart = firstDay; dayStart <= lastDay; dayStart += DAY_MS) {
		let sunThatDay: SunTimes | null | undefined;
		for (const clause of d.clauses) {
			if (!clauseSelectsDay(clause, dayStart)) {
				continue;
			}
			if (clause.windows === null) {
				// H24 on the selected day, which cannot reach the next one.
				if (dayStart <= to && dayStart + DAY_MS - 1 >= from) {
					return true;
				}
				continue;
			}
			for (const w of clause.windows) {
				if (w.from.kind !== 'clock' || w.to.kind !== 'clock') {
					sunThatDay = sunThatDay === undefined ? (sun ? sun(dayStart) : null) : sunThatDay;
				}
				const a = anchorMin(w.from, sunThatDay ?? null);
				const b = anchorMin(w.to, sunThatDay ?? null);
				if (a == null || b == null) {
					unknown = true;
					continue;
				}
				// An end at or before the start runs into the next day. Both
				// anchors are resolved against the OPENING day, which is also
				// the day an SR/SS pair is measured at.
				const wFrom = dayStart + a * 60_000;
				const wTo = dayStart + (b > a ? b : b + 24 * 60) * 60_000;
				// Inclusive at both ends: the printed "0600-1500" names a
				// period that is still in force AT 1500, and for a closure or
				// an activation the closed interval is the conservative
				// reading. An exclusive end declared the field open on the
				// stroke of its own closing minute.
				if (wFrom <= to && wTo >= from) {
					return true;
				}
			}
		}
	}
	return unknown || to > lastDay ? null : false;
}
