/* UI language: a single-field $state (an extra field here would re-fire
 * every t.* consumer) plus the reactive catalog accessor `t`. The pre-paint
 * script in index.html resolves the initial locale (stored explicit choice,
 * else the browser's preferred languages) onto <html lang> before first
 * paint; this module mirrors it. Node-safe: vitest runs in a node
 * environment and specs import state modules transitively, so every
 * document touch is guarded. Contract and authoring rules: docs/i18n.md. */

import { en, type Messages } from '$lib/i18n/en';
import { fr } from '$lib/i18n/fr';
import { decimalFormat, intFormat } from '$lib/i18n/intl';
import { browserLocale, docLocale, type LangPref, type Locale } from '$lib/i18n/locale';
import { decodeQCodeWith } from '$lib/notam/qcode';
import { readItem, removeItem, writeItem } from './persist';

export type { Locale } from '$lib/i18n/locale';

const STORAGE_KEY = 'loxodrome:locale';

export const i18n = $state<{ locale: Locale }>({ locale: docLocale() });

function storedLocalePref(): LangPref {
	const v = readItem(STORAGE_KEY);
	return v === 'en' || v === 'fr' ? v : 'auto';
}

/** The pilot's CHOICE of UI language, kept out of `i18n` for the
 *  single-field rule above (docs/preferences.md, "Auto is a state"): 'auto'
 *  follows the browser's preferred languages and is stored as the key's
 *  absence, 'en' / 'fr' pin it. `i18n.locale` is the language in force. */
export const localePref = $state<{ value: LangPref }>({ value: storedLocalePref() });

const catalogs: Record<Locale, Messages> = { en, fr };

function applyLocale(locale: Locale): void {
	i18n.locale = locale;
	if (typeof document !== 'undefined') {
		document.documentElement.lang = locale;
	}
}

/** Set the UI-language choice: Auto (the key removed, the browser followed)
 *  or a pinned language. The toolbar's EN / FR button pins the other
 *  language; Settings > Languages offers Auto. Initial resolution never
 *  writes, so an untouched choice keeps following the browser. The
 *  content-language preferences (SUP AIP subject, SOFIA NOTAM text, AIP
 *  remarks) default to 'auto', so they follow the language in force on their
 *  own; an explicit override stays put. */
export function setLocalePref(pref: LangPref): void {
	localePref.value = pref;
	if (pref === 'auto') {
		removeItem(STORAGE_KEY);
	} else {
		writeItem(STORAGE_KEY, pref);
	}
	applyLocale(pref === 'auto' ? browserLocale() : pref);
}

/** Follow the browser's preferred languages live while the choice is Auto
 *  (the languagechange event). Mounted once by each App shell; returns the
 *  cleanup. */
export function watchBrowserLanguage(): () => void {
	if (typeof window === 'undefined') {
		return () => {};
	}
	const onChange = (): void => {
		if (localePref.value === 'auto') {
			applyLocale(browserLocale());
		}
	};
	window.addEventListener('languagechange', onChange);
	return () => window.removeEventListener('languagechange', onChange);
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

/** A decimal with exactly `digits` fraction digits in the current locale. */
export function fmtDecimal(n: number, digits: number): string {
	return decimalFormat(i18n.locale, digits).format(n);
}

/** Locale-aware Q-code decode; the shared assembly keeps the raw-half
 *  fallback identical across languages. */
export function decodeQ(code: string): string {
	return decodeQCodeWith(t.qcode.subjects, t.qcode.conditions, code);
}
