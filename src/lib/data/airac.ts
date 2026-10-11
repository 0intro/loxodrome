/* AIRAC cycle math.
 *
 * The ICAO AIRAC ("Aeronautical Information Regulation And Control")
 * calendar is a global 28-day cycle that publishes the world's
 * aeronautical changes on synchronised dates. We anchor at cycle
 * 2401 on 2024-01-25 and walk forwards in 28-day steps; for the 2024..
 * 2030 window every calendar year contains exactly 13 cycles, so a
 * (year, cycle-of-year) split is a straight integer divmod.
 *
 * Single source of truth for the airports.ts SIA-VAC URL builder and
 * the About modal's data-source cards. */

/** First AIRAC cycle of 2024 began on this Thursday. Every other cycle
 *  in the supported range is computed from this anchor. */
export const AIRAC_EPOCH_MS = Date.UTC(2024, 0, 25);
/** AIRAC cycle length in milliseconds (exactly 28 days). */
export const AIRAC_PERIOD_MS = 28 * 86_400_000;

const AIRAC_MONTHS = [
	'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
	'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
];

/** Effective-date stamp -> the instant the cycle takes effect, as UTC
 *  midnight of the stamp's OWN calendar date (its year-month-day in the
 *  stamp's zone). AIRAC effectives are calendar dates; the SIA stamps them
 *  at local midnight (`2026-08-06T00:00:00.000+02:00`), an instant of
 *  22:00Z the EVE of the cycle date, so a raw `Date.parse` would flip a
 *  dataset slot two hours early. Null for unparseable input. */
export function parseEffectiveMs(iso: string): number | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
	if (m) {
		return Date.UTC(+m[1], +m[2] - 1, +m[3]);
	}
	const ms = Date.parse(iso);
	return Number.isFinite(ms) ? ms : null;
}

function toMs(when: Date | string | number): number {
	if (when instanceof Date) {
		return when.getTime();
	}
	if (typeof when === 'number') {
		return when;
	}
	// For ISO strings, prefer the calendar-date interpretation: this avoids
	// the SIA quirk where `effective="2026-05-14T00:00:00.000+02:00"` parses
	// to 2026-05-13T22:00 UTC and slips into the *previous* AIRAC cycle.
	return parseEffectiveMs(when) ?? NaN;
}

/** Absolute AIRAC cycle index for an instant (0 = cycle 2401, effective
 *  2024-01-25). Two instants in the same 28-day cycle share an index, so
 *  the difference of two indices is the number of cycles between them.
 *  Returns NaN for unparseable input. */
export function airacCycleIndex(when: Date | string | number): number {
	return Math.floor((toMs(when) - AIRAC_EPOCH_MS) / AIRAC_PERIOD_MS);
}

/** Return the ICAO YYNN four-digit cycle label for any instant within
 *  a cycle, e.g. `"2605"` for 2026-05-14T00:00:00+02:00 (and for
 *  every other moment up to but not including 2026-06-11). Returns an
 *  empty string for unparseable inputs. */
export function airacYYNN(when: Date | string | number): string {
	let idx = airacCycleIndex(when);
	if (!Number.isFinite(idx)) {
		return '';
	}
	let y = 2024;
	// 13 cycles per year holds for 2024..2030; the loops also bracket
	// inputs outside that window without exploding.
	while (idx >= 13) {
		idx -= 13;
		y += 1;
	}
	while (idx < 0) {
		idx += 13;
		y -= 1;
	}
	const cycle = idx + 1;
	const yy = String(y % 100).padStart(2, '0');
	const nn = String(cycle).padStart(2, '0');
	return yy + nn;
}

/** UTC Date when a YYNN cycle becomes effective, or null for malformed
 *  input. The inverse of `airacYYNN` for instants on cycle boundaries. */
export function airacEffective(yynn: string): Date | null {
	const m = /^(\d{2})(\d{2})$/.exec(yynn);
	if (!m) {
		return null;
	}
	const yy = parseInt(m[1], 10);
	const nn = parseInt(m[2], 10);
	if (nn < 1 || nn > 14) {
		return null;
	}
	const year = 2000 + yy;
	const idx = (year - 2024) * 13 + (nn - 1);
	return new Date(AIRAC_EPOCH_MS + idx * AIRAC_PERIOD_MS);
}

/** Effective date of the AIRAC cycle active at `now`, formatted
 *  `DD_MMM_YYYY` (e.g. `"14_MAY_2026"`). Matches the SIA URL template
 *  the VAC link in airports.ts uses. */
export function currentAiracString(now: number = Date.now()): string {
	const n = Math.floor((now - AIRAC_EPOCH_MS) / AIRAC_PERIOD_MS);
	const d = new Date(AIRAC_EPOCH_MS + n * AIRAC_PERIOD_MS);
	const dd = String(d.getUTCDate()).padStart(2, '0');
	return `${dd}_${AIRAC_MONTHS[d.getUTCMonth()]}_${d.getUTCFullYear()}`;
}

/** Effective date of the cycle AFTER the one active at `now`, in the same
 *  `DD_MMM_YYYY` form. What the offline VAC pack needs to name the
 *  pre-release slot: the SIA publishes the next cycle's Atlas VAC about a
 *  month ahead, under a path carrying that cycle's own date. */
export function nextAiracString(now: number = Date.now()): string {
	const n = Math.floor((now - AIRAC_EPOCH_MS) / AIRAC_PERIOD_MS) + 1;
	const d = new Date(AIRAC_EPOCH_MS + n * AIRAC_PERIOD_MS);
	const dd = String(d.getUTCDate()).padStart(2, '0');
	return `${dd}_${AIRAC_MONTHS[d.getUTCMonth()]}_${d.getUTCFullYear()}`;
}

/** Effective date of the AIRAC cycle active at `now`, formatted
 *  `YYYY-MM-DD` (e.g. `"2026-05-14"`). Matches the NATS UK eAIP URL
 *  template the UK aerodrome-chart link in airports.ts uses. */
export function currentAiracIso(now: number = Date.now()): string {
	const n = Math.floor((now - AIRAC_EPOCH_MS) / AIRAC_PERIOD_MS);
	const d = new Date(AIRAC_EPOCH_MS + n * AIRAC_PERIOD_MS);
	const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
	const dd = String(d.getUTCDate()).padStart(2, '0');
	return `${d.getUTCFullYear()}-${mm}-${dd}`;
}
