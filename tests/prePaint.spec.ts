/* The pre-paint scripts in index.html and notam.html decide the theme and
 * the UI language before any module loads; the modules then take over by
 * the same rules (state/theme.svelte.ts, browserLocale in i18n/locale.ts).
 * Two copies of one rule drift silently, so this runs the pages' inline
 * scripts over stubbed globals and holds them to those rules: the automatic
 * night first in the flight app only, then a pinned theme, then the device's
 * appearance, which is also the answer when storage fails; a pinned language,
 * else the browser's languages exactly as browserLocale reads them. */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { browserLocale } from '$lib/i18n/locale';

interface Env {
	stored?: Record<string, string>;
	throwing?: boolean;
	dark?: boolean;
	langs?: string[];
}

function run(page: string, env: Env): { theme: string | undefined; lang: string } {
	const store = env.stored ?? {};
	const localStorage = {
		getItem: (k: string): string | null => {
			if (env.throwing) {
				throw new Error('storage denied');
			}
			return store[k] ?? null;
		},
	};
	const documentElement = { dataset: {} as Record<string, string>, lang: '' };
	const langs = env.langs ?? ['en'];
	const globals = {
		localStorage,
		document: { documentElement },
		window: { matchMedia: (q: string) => ({ matches: q.includes('dark') && env.dark === true }) },
		navigator: { languages: langs, language: langs[0] },
	};
	const html = readFileSync(page, 'utf8');
	for (const [, code] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
		// eslint-disable-next-line @typescript-eslint/no-implied-eval -- the page's own inline script, run over stubbed globals
		const script = new Function(...Object.keys(globals), code ?? '') as (...args: unknown[]) => void;
		script(...Object.values(globals));
	}
	return { theme: documentElement.dataset.theme, lang: documentElement.lang };
}

describe("the flight app's pre-paint theme", () => {
	const page = 'index.html';

	it('follows the device while nothing is stored', () => {
		expect(run(page, {}).theme).toBe('day');
		expect(run(page, { dark: true }).theme).toBe('night');
	});

	it('takes a pinned theme over the device', () => {
		expect(run(page, { stored: { 'loxodrome:theme': 'night' } }).theme).toBe('night');
		expect(run(page, { stored: { 'loxodrome:theme': 'day' }, dark: true }).theme).toBe('day');
	});

	it("paints the recording's automatic night first, over a pinned day", () => {
		const stored = { 'loxodrome:theme': 'day', 'loxodrome:auto-night': '1' };
		expect(run(page, { stored }).theme).toBe('night');
	});

	it('paints the pick over a night the pick held', () => {
		const stored = { 'loxodrome:theme': 'day', 'loxodrome:auto-night': 'held' };
		expect(run(page, { stored }).theme).toBe('day');
	});

	it('follows the device when storage fails, rather than stamping nothing', () => {
		expect(run(page, { throwing: true, dark: true }).theme).toBe('night');
		expect(run(page, { throwing: true }).theme).toBe('day');
	});
});

describe("the viewer's pre-paint theme", () => {
	const page = 'notam.html';

	it("ignores the flight app's automatic night, which it never ends", () => {
		expect(run(page, { stored: { 'loxodrome:auto-night': '1' } }).theme).toBe('day');
	});

	it('takes a pinned theme, else the device, even when storage fails', () => {
		expect(run(page, { stored: { 'loxodrome:theme': 'night' } }).theme).toBe('night');
		expect(run(page, { throwing: true, dark: true }).theme).toBe('night');
	});
});

describe('the pre-paint UI language', () => {
	const lists = [['de-DE', 'fr-FR'], ['en-GB', 'fr'], ['FR-ca'], ['de', 'it'], [], ['frisian']];

	for (const page of ['index.html', 'notam.html']) {
		it(`${page} answers as browserLocale does`, () => {
			for (const langs of lists) {
				expect(run(page, { langs }).lang, langs.join(',')).toBe(browserLocale(langs));
				expect(run(page, { langs, throwing: true }).lang).toBe(browserLocale(langs));
			}
		});

		it(`${page} takes a pinned language over the browser`, () => {
			expect(run(page, { langs: ['en-GB'], stored: { 'loxodrome:locale': 'fr' } }).lang).toBe('fr');
			expect(run(page, { langs: ['fr-FR'], stored: { 'loxodrome:locale': 'en' } }).lang).toBe('en');
		});
	}
});
