/* UI language: a single-field $state (an extra field here would re-fire
 * every t.* consumer) plus the reactive catalog accessor `t`. The pre-paint
 * script in index.html resolves the initial locale (stored explicit choice,
 * else the browser's preferred languages) onto <html lang> before first
 * paint; this module mirrors it. Node-safe: vitest runs in a node
 * environment and specs import state modules transitively, so every
 * document touch is guarded. Contract and authoring rules: docs/i18n.md. */

import { en, type Messages } from '$lib/i18n/en';
import { fr } from '$lib/i18n/fr';
import { intFormat } from '$lib/i18n/intl';
import { docLocale, type Locale } from '$lib/i18n/locale';
import { decodeQCodeWith } from '$lib/notam/qcode';
import { writeItem } from './persist';

export type { Locale } from '$lib/i18n/locale';

const STORAGE_KEY = 'loxodrome:locale';

export const i18n = $state<{ locale: Locale }>({ locale: docLocale() });

const catalogs: Record<Locale, Messages> = { en, fr };

/** Switch the UI language. A user action: the choice persists (initial
 *  resolution never writes, so an untouched preference keeps following the
 *  browser language) and <html lang> tracks it. The content-language
 *  preferences (SUP AIP subject, SOFIA NOTAM text) default to 'auto', so they
 *  follow this switch on their own; an explicit override stays put. */
export function setLocale(locale: Locale): void {
	i18n.locale = locale;
	if (typeof document !== 'undefined') {
		document.documentElement.lang = locale;
	}
	writeItem(STORAGE_KEY, locale);
}

/* The accessor: one getter per catalog domain, each reading i18n.locale, so
 * every t.* read is tracked and a locale switch invalidates exactly the
 * expressions that rendered text. The catalogs stay plain module consts
 * (never $state): only the locale is reactive. Generated over the en keys so
 * a new domain cannot silently miss its getter. */
function makeT(): Messages {
	const target = {} as Record<string, unknown>;
	for (const key of Object.keys(en)) {
		Object.defineProperty(target, key, {
			get: () => catalogs[i18n.locale][key as keyof Messages],
			enumerable: true,
		});
	}
	return target as Messages;
}

export const t: Messages = makeT();

/** Locale-grouped integer for prose counts; aviation values keep the
 *  invariant point-decimal notation (policy in docs/i18n.md). */
export function fmtInt(n: number): string {
	return intFormat(i18n.locale).format(n);
}

/** Locale-aware Q-code decode; the shared assembly keeps the raw-half
 *  fallback identical across languages. */
export function decodeQ(code: string): string {
	return decodeQCodeWith(t.qcode.subjects, t.qcode.conditions, code);
}
