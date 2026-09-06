/* Locale primitives shared by the catalogs and the state module. Pure and
 * node-safe: importable from anywhere, including vitest's node environment,
 * without touching the DOM unguarded. */

export type Locale = 'en' | 'fr';

export const LOCALES: readonly Locale[] = ['en', 'fr'];

/** The locale stamped on `<html lang>` by the pre-paint script in index.html
 *  (stored choice, else the browser's preferred languages); 'en' when
 *  unstamped (tests, node). `state/i18n.svelte.ts` reads this for the initial
 *  UI locale. */
export function docLocale(): Locale {
	return typeof document !== 'undefined' &&
		document.documentElement.lang === 'fr'
		? 'fr'
		: 'en';
}

/** A content-language preference for downloaded bilingual material (the SUP AIP
 *  subject, the SOFIA NOTAM free text): 'auto' follows the UI locale, 'en' /
 *  'fr' pin it. The default everywhere is 'auto', so a UI-language switch
 *  carries the content with it while an explicit choice stays put. */
export type LangPref = 'auto' | Locale;

/** Resolve a content-language preference against the current UI locale. */
export function resolveLangPref(pref: LangPref, locale: Locale): Locale {
	return pref === 'auto' ? locale : pref;
}
