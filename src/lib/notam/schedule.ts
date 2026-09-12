/* Interpret a NOTAM's D) item: the schedule WITHIN the B)-C) validity during
 * which the condition is actually in force. ICAO Doc 8126 / OPADD leave D) as
 * lightly-structured text, so this reads only the shapes the corpus actually
 * uses and answers "unknown" for everything else:
 *
 *   01-07 09-12 14 16-26 28-31 H24     day-of-month list + whole-day marker
 *   0600-1800                          a daily UTC time window
 *   MON-FRI 0800-1600, SR-SS, dates    -> null (unparseable, the caller flags)
 *
 * The asymmetry is deliberate and safety-directed: a consumer that CLOSES a
 * published frequency on a schedule must not do so on a guess, so an
 * unparseable D) reads as unknown (null), never as "always" or "never"
 * (docs/notam-relationships.md, service closures). Pure, UTC throughout, no
 * Svelte, no I/O; pinned by tests/notamSchedule.spec.ts. */

/** A parsed D) schedule. Both fields null means H24 every day (the marker
 *  alone), which is also what a bare `H24` parses to. */
export interface ItemDSchedule {
	/** Days of month (UTC, 1-31) the schedule names; null = every day. */
	days: Set<number> | null;
	/** Daily UTC windows in minutes from midnight, end exclusive; null = the
	 *  whole day (H24). A window crossing midnight is split at it. */
	daily: { fromMin: number; toMin: number }[] | null;
}

const DAY_RE = /^(\d{1,2})(?:-(\d{1,2}))?$/;
const TIME_RE = /^(\d{4})-(\d{4})$/;

function timeMin(hhmm: string): number | null {
	const h = Number(hhmm.slice(0, 2));
	const m = Number(hhmm.slice(2, 4));
	return h <= 24 && m <= 59 ? h * 60 + m : null;
}

/** Parse a D) item's text, or null when any token falls outside the supported
 *  subset (the whole schedule is then unknown: a half-read schedule would
 *  silently drop the tokens it did not understand). Pure. */
export function parseItemD(text: string): ItemDSchedule | null {
	if (typeof text !== 'string' || text.trim() === '') {
		return null;
	}
	let days: Set<number> | null = null;
	let daily: { fromMin: number; toMin: number }[] | null = null;
	let h24 = false;
	for (const token of text.trim().toUpperCase().split(/[\s,]+/)) {
		if (token === 'H24') {
			h24 = true;
			continue;
		}
		const t = TIME_RE.exec(token);
		if (t) {
			const from = timeMin(t[1]);
			const to = timeMin(t[2]);
			if (from == null || to == null) {
				return null;
			}
			daily ??= [];
			if (to > from) {
				daily.push({ fromMin: from, toMin: to });
			} else {
				// Crosses midnight (2200-0400): split at it so the per-day
				// evaluation stays a plain interval test.
				daily.push({ fromMin: from, toMin: 24 * 60 });
				if (to > 0) {
					daily.push({ fromMin: 0, toMin: to });
				}
			}
			continue;
		}
		const d = DAY_RE.exec(token);
		if (d) {
			const from = Number(d[1]);
			const to = d[2] != null ? Number(d[2]) : from;
			// A calendar day, not a time: two digits at most and within a
			// month. A descending "range" is not a wrap convention in D)
			// items, so it reads as unknown.
			if (from < 1 || to > 31 || to < from) {
				return null;
			}
			days ??= new Set();
			for (let day = from; day <= to; day++) {
				days.add(day);
			}
			continue;
		}
		return null;
	}
	// H24 beside daily windows contradicts itself; unknown rather than a pick.
	if (h24 && daily != null) {
		return null;
	}
	return { days, daily };
}

const DAY_MS = 24 * 3600_000;

/** Whether the schedule is in force at some instant of [fromMs, toMs] within
 *  the B)-C) validity `span` (both inclusive; a live surface passes
 *  fromMs === toMs, a planning surface its evaluation window).
 *
 *  `d` is the parsed schedule: undefined = the NOTAM has no D) item (the
 *  validity alone decides), null = it has one that did not parse, which makes
 *  the answer UNKNOWN (null) whenever the validity overlaps: the caller must
 *  fall back to a flag, never to a guess. Pure, UTC. */
export function scheduleActiveIn(
	span: { start: number; end: number },
	d: ItemDSchedule | null | undefined,
	at: { fromMs: number; toMs: number },
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
	if (d.days === null && d.daily === null) {
		return true;
	}
	// Any range spanning three whole months contains every day-of-month value
	// (three consecutive months always include a 31-day one), so every listed
	// day, and with it every daily window, occurs. This is what bounds the
	// day-by-day walk below.
	if (to - from >= 93 * DAY_MS) {
		return true;
	}
	for (let dayStart = Math.floor(from / DAY_MS) * DAY_MS; dayStart <= to; dayStart += DAY_MS) {
		if (d.days !== null && !d.days.has(new Date(dayStart).getUTCDate())) {
			continue;
		}
		const winFrom = Math.max(from, dayStart);
		const winTo = Math.min(to, dayStart + DAY_MS - 1);
		if (winFrom > winTo) {
			continue;
		}
		if (d.daily === null) {
			return true;
		}
		for (const w of d.daily) {
			const wFrom = dayStart + w.fromMin * 60_000;
			const wTo = dayStart + w.toMin * 60_000;
			if (winFrom < wTo && winTo >= wFrom) {
				return true;
			}
		}
	}
	return false;
}
