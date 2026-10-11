/* Locale primitives shared by the catalogs and the state module. Pure and
 * node-safe: importable from anywhere, including vitest's node environment,
 * without touching the DOM unguarded. */

export type Locale = 'en' | 'fr';

export const LOCALES: readonly Locale[] = ['en', 'fr'];

/** The locale stamped on `<html lang>` by the pre-paint script in index.html
 *  (stored choice, else browserLocale's rule); 'en' when
 *  unstamped (tests, node). `state/i18n.svelte.ts` reads this for the initial
 *  UI locale. */
export function docLocale(): Locale {
	return typeof document !== 'undefined' &&
		document.documentElement.lang === 'fr'
		? 'fr'
		: 'en';
}

/** The locale the browser's preferred languages ask for, by the rule the
 *  pre-paint scripts in index.html and notam.html apply before the first
 *  paint (tests/prePaint.spec.ts holds the three to one answer): the first
 *  French or English entry decides, English when neither appears. What the
 *  UI language follows while its choice is Auto. The list is a parameter,
 *  the browser's own by default, spelled as the pre-paint spells it. */
export function browserLocale(langs: readonly string[] = navigatorLanguages()): Locale {
	for (const lang of langs) {
		if (/^fr\b/i.test(lang)) {
			return 'fr';
		}
		if (/^en\b/i.test(lang)) {
			return 'en';
		}
	}
	return 'en';
}

function navigatorLanguages(): readonly string[] {
	if (typeof navigator === 'undefined') {
		return [];
	}
	// navigator.languages || [navigator.language || 'en'], as the pre-paint
	// reads it: an empty list stays empty, only an absent one falls back.
	const langs = navigator.languages as readonly string[] | undefined;
	return langs ?? [navigator.language || 'en'];
}

/** A language preference: 'auto' follows something else, 'en' / 'fr' pin it.
 *  For downloaded bilingual material (the SUP AIP subject, the SOFIA NOTAM
 *  free text, the AIP remarks) 'auto' follows the UI locale, so a
 *  UI-language switch carries the content with it while an explicit choice
 *  stays put; for the UI language itself it follows the browser
 *  (browserLocale). The default everywhere is 'auto'. */
export type LangPref = 'auto' | Locale;

/** Resolve a content-language preference against the current UI locale. */
export function resolveLangPref(pref: LangPref, locale: Locale): Locale {
	return pref === 'auto' ? locale : pref;
}
