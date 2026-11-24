/* Who knows a zone's activity on its panel: the units with their
 * frequencies, a telephone as a link a phone dials (format/phone.ts telHref,
 * detail/ContactTable.svelte, detail/KnownFrom.svelte), and a supplement's
 * telephone numbers as the shipped data carries them. */

import { readFileSync } from 'node:fs';
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import { knownFrom } from '$lib/data/knownFrom';
import { loadSupAip, SUPAIP_URL } from '$lib/data/supaip';
import { telHref } from '$lib/format/phone';
import ContactTable from '$lib/components/detail/ContactTable.svelte';
import KnownFrom from '$lib/components/detail/KnownFrom.svelte';

describe('telHref', () => {
	it('dials a French number with the +33 prefix in place of its trunk 0', () => {
		expect(telHref('03 87 15 58 87')).toBe('tel:+33387155887');
		expect(telHref('06.94.38.42.36')).toBe('tel:+33694384236');
		expect(telHref('+33 1 34 91 21 64')).toBe('tel:+33134912164');
		expect(telHref('TEL')).toBeNull();
	});
});

describe('the panel names who knows', () => {
	it('lists each unit with its frequency and links a telephone', () => {
		const units = knownFrom(
			'Activity known on :#- ETAIN APP or RAI : 120.125 MHz#- Beynes camp duty office.#TEL : +33(0)1 34 91 21 64',
		);
		const html = render(KnownFrom, { props: { units } }).body;
		expect(html).toContain('Activity known on');
		expect(html).toContain('ETAIN APP');
		expect(html).toContain('120.125');
		expect(html).toContain('href="tel:+33134912164"');
		expect(html).toContain('BEYNES CAMP DUTY OFFICE');
	});

	it('links every number of a row, a note where there is none', () => {
		const rows = [
			{ label: 'COMALAT Section Espace Aérien', freq: '', phones: ['03 87 15 58 87', '06 94 38 42 36'], note: '' },
			{ label: 'SEINE INFO', freq: '', phones: [], note: 'per ATS' },
		];
		const html = render(ContactTable, { props: { rows } }).body;
		expect(html.match(/href="tel:/g)).toHaveLength(2);
		expect(html).toContain('href="tel:+33694384236"');
		expect(html).toContain('per ATS');
	});

	it('reads a supplement\'s telephone numbers from the shipped data', async () => {
		vi.stubGlobal('fetch', (url: string) =>
			Promise.resolve(
				new Response(readFileSync(new URL(`../public${url}`, import.meta.url), 'utf-8'), {
					headers: { 'content-type': 'application/json' },
				}),
			),
		);
		try {
			const sups = await loadSupAip(SUPAIP_URL);
			const s = sups.find((x) => x.title === '001/2026');
			expect(s?.phones).toEqual([
				{ role: 'before', label: 'COMALAT Section Espace Aérien', numbers: ['03 87 15 58 87'] },
				{ role: 'during', label: 'GESTIONNAIRE', numbers: ['06 94 38 42 36'] },
			]);
			// A row the build retained from before the column reads none.
			expect(sups.every((x) => Array.isArray(x.phones))).toBe(true);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
