/* Aeronautical date/time formatting; all NOTAM times are UTC (Zulu). */

/** Format a date as `2026-02-24 00:00Z`, or `–` when null. */
export function formatZulu(d: Date | null): string {
	if (!d || isNaN(d.getTime())) {
		return '–';
	}
	return d.toISOString().slice(0, 16).replace('T', ' ') + 'Z';
}

/** A compact UTC activation window, `11:30–12:30Z`, or `17:28–00:59Z (+1)` when
 *  it crosses midnight (the end falls on a later UTC day than the start). Both
 *  endpoints are UTC; used for RTBA per-zone activation times. Returns `–` when
 *  either endpoint is missing. */
/** A UTC span as "0600Z - 1200Z". The en dash is the app's range mark
 *  wherever a period is printed as one; the two viewing-conditions
 *  surfaces had spelled the same span with two different dashes. */
export function formatZuluSpan(fromMs: number, toMs: number): string {
	return `${formatZulu(new Date(fromMs))} – ${formatZulu(new Date(toMs))}`;
}

/** Thousands grouped with the narrow no-break space, the SIA chart style;
 *  locale-invariant, like the ft unit it is printed beside. */
export function groupThousands(n: number): string {
	return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f');
}

export function formatActivationWindow(
	start: Date | null,
	end: Date | null,
): string {
	if (!start || !end || isNaN(start.getTime()) || isNaN(end.getTime())) {
		return '–';
	}
	const clock = (d: Date) => d.toISOString().slice(11, 16);
	const overnight =
		end.toISOString().slice(0, 10) !== start.toISOString().slice(0, 10);
	return `${clock(start)}–${clock(end)}Z${overnight ? ' (+1)' : ''}`;
}

/** A NOTAM activation window for the SUP AIP detail cards. Same-UTC-day spans
 *  reuse the compact clock form (`11:30–12:30Z`); multi-day spans carry the
 *  date on each end (`2026-05-22 00:00Z – 2026-05-24 23:59Z`) since a SUP
 *  activation NOTAM commonly runs across several days. Returns `–` when either
 *  endpoint is missing. */
export function formatActivationSpan(start: Date | null, end: Date | null): string {
	if (!start || !end || isNaN(start.getTime()) || isNaN(end.getTime())) {
		return '–';
	}
	const sameDay =
		start.toISOString().slice(0, 10) === end.toISOString().slice(0, 10);
	if (sameDay) {
		return formatActivationWindow(start, end);
	}
	return `${formatZulu(start)} – ${formatZulu(end)}`;
}

export type NotamStatus = 'active' | 'future' | 'expired' | 'permanent';

/** Classify a NOTAM's validity window relative to now. */
export function notamStatus(
	start: Date | null,
	end: Date | null,
	permanent: boolean,
): NotamStatus {
	const now = Date.now();
	if (start && start.getTime() > now) {
		return 'future';
	}
	if (permanent) {
		return 'permanent';
	}
	if (end && end.getTime() < now) {
		return 'expired';
	}
	return 'active';
}

/* The status badge wording lives in the i18n catalogs (t.notam.status,
 * keyed by NotamStatus). */

/** Normalise a typed 24-hour clock entry to canonical `HH:MM`, or null when
 *  out of range / unparseable. Every time in this app is UTC (Zulu), entered
 *  24h with no AM/PM, so the parser is lenient about the forms a pilot types:
 *  `HH:MM`, `H:MM`, `HHMM`, `HMM`, or a bare hour `HH` (`1830`, `6:00`, `18`
 *  all resolve). Backs the shared TimeField and the dossier ETD entry. */
export function normalizeClock24(text: string): string | null {
	const t = text.trim();
	let h: number;
	let m: number;
	const colon = /^(\d{1,2}):(\d{1,2})$/.exec(t);
	if (colon) {
		h = Number(colon[1]);
		m = Number(colon[2]);
	} else if (/^\d+$/.test(t)) {
		// Digits only: 'HHMM' / 'HMM' without a separator, or a bare hour.
		if (t.length <= 2) {
			h = Number(t);
			m = 0;
		} else if (t.length === 3) {
			h = Number(t.slice(0, 1));
			m = Number(t.slice(1));
		} else if (t.length === 4) {
			h = Number(t.slice(0, 2));
			m = Number(t.slice(2));
		} else {
			return null;
		}
	} else {
		return null;
	}
	if (h > 23 || m > 59) {
		return null;
	}
	return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
