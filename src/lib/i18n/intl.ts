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
