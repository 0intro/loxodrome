/* Cached per-locale Intl formatters. Construction is expensive, so each
 * locale builds its instances once. Policy (docs/i18n.md): prose integer
 * counts and prose dates localise; aviation values (frequencies, coordinates,
 * flight levels, QNH, masses) keep the invariant point-decimal notation. */

import type { Locale } from './locale';

/** BCP 47 tags behind the two UI locales: en-GB for day-first prose dates
 *  (the aviation convention), fr-FR for French grouping and month names. */
export const INTL_TAG: Record<Locale, string> = { en: 'en-GB', fr: 'fr-FR' };

const intFormats = new Map<Locale, Intl.NumberFormat>();

/** Locale-grouped integer formatter (thousands separators in prose counts). */
export function intFormat(locale: Locale): Intl.NumberFormat {
	let f = intFormats.get(locale);
	if (!f) {
		f = new Intl.NumberFormat(INTL_TAG[locale], {
			maximumFractionDigits: 0,
		});
		intFormats.set(locale, f);
	}
	return f;
}

const decimalFormats = new Map<string, Intl.NumberFormat>();

/** Locale decimal formatter with exactly `digits` fraction digits: the
 *  rain rate's "2.4 mm/h" reads "2,4 mm/h" in French (a display reading,
 *  not one of the invariant aviation figures). */
export function decimalFormat(locale: Locale, digits: number): Intl.NumberFormat {
	const key = `${locale}|${digits}`;
	let f = decimalFormats.get(key);
	if (!f) {
		f = new Intl.NumberFormat(INTL_TAG[locale], {
			minimumFractionDigits: digits,
			maximumFractionDigits: digits,
		});
		decimalFormats.set(key, f);
	}
	return f;
}

const byteFormats = new Map<string, Intl.NumberFormat>();

function byteFormat(locale: Locale, unit: 'kilobyte' | 'megabyte', digits: number): Intl.NumberFormat {
	const key = `${locale}|${unit}|${digits}`;
	let f = byteFormats.get(key);
	if (!f) {
		f = new Intl.NumberFormat(INTL_TAG[locale], {
			style: 'unit',
			unit,
			maximumFractionDigits: digits,
		});
		byteFormats.set(key, f);
	}
	return f;
}

/** Storage size in prose (the account quota line): kilobytes under a
 *  megabyte (an empty account reads "0 kB" / "0 ko", never a
 *  fabricated floor), one decimal up to 10 MB, whole megabytes past
 *  that. Intl carries the per-locale unit symbols (fr: ko / Mo). */
export function formatBytes(locale: Locale, bytes: number): string {
	const mb = bytes / 1_048_576;
	if (mb < 1) {
		return byteFormat(locale, 'kilobyte', 0).format(bytes / 1024);
	}
	return byteFormat(locale, 'megabyte', mb < 10 ? 1 : 0).format(mb);
}

const dayMonthFormats = new Map<Locale, Intl.DateTimeFormat>();

/** A calendar day 'YYYY-MM-DD' as its day and short month ("6 Oct",
 *  "6 oct."), read on the UTC calendar it was stamped on (the day a fuel
 *  reading was taken), the two held together by a no-break space so a
 *  narrow cell never parts them. Anything else comes back as it was. */
export function formatDayMonth(locale: Locale, isoDay: string): string {
	let f = dayMonthFormats.get(locale);
	if (!f) {
		f = new Intl.DateTimeFormat(INTL_TAG[locale], { day: 'numeric', month: 'short', timeZone: 'UTC' });
		dayMonthFormats.set(locale, f);
	}
	const d = /^\d{4}-\d{2}-\d{2}$/.test(isoDay) ? new Date(`${isoDay}T00:00:00Z`) : null;
	return d && !Number.isNaN(d.getTime()) ? f.format(d).replace(/\s/g, '\u00a0') : isoDay;
}

const collators = new Map<Locale, Intl.Collator>();

/** Accent-insensitive collator; every display-label sort goes through this
 *  rather than `<` so French accents order correctly (docs/i18n.md). */
export function collator(locale: Locale): Intl.Collator {
	let c = collators.get(locale);
	if (!c) {
		c = new Intl.Collator(INTL_TAG[locale], { sensitivity: 'base' });
		collators.set(locale, c);
	}
	return c;
}
