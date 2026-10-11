/* The UI-language choice (state/i18n.svelte.ts, docs/preferences.md): Auto
 * follows the browser's preferred languages and is stored as the key's
 * absence, the toolbar's EN / FR and Settings pin a language, and Auto
 * follows a languagechange live. Node 24 has a real `navigator` carrying the
 * process locale, so every case stubs it. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserLocale } from '$lib/i18n/locale';
import { memoryStorage } from './helpers/storage';

function browserLanguages(langs: string[]): void {
	vi.stubGlobal('navigator', { languages: langs, language: langs[0] ?? 'en' });
}

beforeEach(() => {
	vi.resetModules();
	vi.stubGlobal('localStorage', memoryStorage());
	browserLanguages(['en-GB']);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('browserLocale', () => {
	it('takes the first French or English entry, else English', () => {
		expect(browserLocale(['de-DE', 'fr-FR', 'en-US'])).toBe('fr');
		expect(browserLocale(['en-GB', 'fr'])).toBe('en');
		expect(browserLocale(['FR-ca'])).toBe('fr');
		expect(browserLocale(['de', 'it'])).toBe('en');
		expect(browserLocale([])).toBe('en');
		// A prefix is not a language: "french" is no fr tag.
		expect(browserLocale(['frisian'])).toBe('en');
	});

	it("reads the browser's own list by default", () => {
		browserLanguages(['nl-BE', 'fr-BE']);
		expect(browserLocale()).toBe('fr');
	});
});

describe('the UI-language choice', () => {
	it('stores a pinned language and nothing for Auto', async () => {
		browserLanguages(['fr-FR']);
		const { i18n, localePref, setLocalePref } = await import('$lib/state/i18n.svelte');
		expect(localePref.value).toBe('auto');
		setLocalePref('en');
		expect(localStorage.getItem('loxodrome:locale')).toBe('en');
		expect(i18n.locale).toBe('en');
		setLocalePref('auto');
		expect(localStorage.getItem('loxodrome:locale')).toBeNull();
		expect(i18n.locale).toBe('fr');
	});

	it('reads a stored choice at load', async () => {
		localStorage.setItem('loxodrome:locale', 'fr');
		const { localePref } = await import('$lib/state/i18n.svelte');
		expect(localePref.value).toBe('fr');
	});

	it('follows a languagechange on Auto, and not once pinned', async () => {
		const listeners: (() => void)[] = [];
		vi.stubGlobal('window', {
			addEventListener: (type: string, f: () => void) => {
				if (type === 'languagechange') {
					listeners.push(f);
				}
			},
			removeEventListener: () => {},
		});
		const change = (langs: string[]): void => {
			browserLanguages(langs);
			for (const f of listeners) {
				f();
			}
		};
		const { i18n, setLocalePref, watchBrowserLanguage } = await import('$lib/state/i18n.svelte');
		const stop = watchBrowserLanguage();
		change(['fr-FR']);
		expect(i18n.locale).toBe('fr');
		change(['en-US']);
		expect(i18n.locale).toBe('en');
		setLocalePref('fr');
		change(['en-US']);
		expect(i18n.locale).toBe('fr');
		stop();
	});
});
