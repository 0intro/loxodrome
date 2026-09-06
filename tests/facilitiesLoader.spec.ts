/* Tests for the AD-2 aerodrome-facilities loader (src/lib/data/facilities.ts):
 * the positional row -> object mapping (nested [cat,text] items, bilingual
 * "\\" preserved verbatim), the fail-soft path, and a structural sanity check
 * of the committed dataset. */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadFacilities } from '$lib/data/facilities';

function jsonResponse(body: unknown) {
	return {
		ok: true,
		status: 200,
		headers: { get: (): string => 'application/json' },
		json: () => Promise.resolve(body),
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('loadFacilities', () => {
	it('maps positional rows to AerodromeFacilities, preserving the bilingual form', async () => {
		const raw = {
			fields: ['ident', 'site', 'arp', 'hours', 'fireCat', 'services', 'passenger', 'contact'],
			itemFields: ['cat', 'text'],
			rows: [
				[
					'LFXX',
					'2 km N\\\\2 km N', // two backslashes at runtime
					'Tour.\\\\Tower.',
					'H24',
					'7',
					[['fuel', '100 LL\\\\Fuel'], ['handling', 'Ground\\\\Ground']],
					[['restaurant', 'At AD']],
					[['phone', '+33 1 23']],
					[['status', 'TPD'], ['remark', 'A.#B.']],
				],
				// An eighth-column-less row: an artifact from before the
				// helipad directory still loads.
				['LFYY', '', '', '', '', [], [], []],
			],
		};
		vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse(raw))));

		const list = await loadFacilities('/data/x.json');
		expect(list).toHaveLength(2);
		const f = list[0];
		expect(f.ident).toBe('LFXX');
		expect(f.site).toBe('2 km N\\\\2 km N');
		expect(f.arp).toBe('Tour.\\\\Tower.');
		expect(f.hours).toBe('H24');
		expect(f.fireCat).toBe('7');
		expect(f.services).toEqual([
			{ cat: 'fuel', text: '100 LL\\\\Fuel' },
			{ cat: 'handling', text: 'Ground\\\\Ground' },
		]);
		expect(f.passenger).toEqual([{ cat: 'restaurant', text: 'At AD' }]);
		expect(f.contact).toEqual([{ cat: 'phone', text: '+33 1 23' }]);
		// The directory column keeps its codes and its '#' breaks verbatim;
		// an absent column decodes to [].
		expect(f.directory).toEqual([
			{ cat: 'status', text: 'TPD' },
			{ cat: 'remark', text: 'A.#B.' },
		]);
		expect(list[1].directory).toEqual([]);
	});

	it('fails soft to [] on an HTTP error', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(() => Promise.resolve({ ok: false, status: 404, headers: { get: () => '' } })),
		);
		expect(await loadFacilities('/data/x.json')).toEqual([]);
	});
});

describe('committed fr-aerodrome-facilities.json', () => {
	const doc = JSON.parse(
		readFileSync('public/data/fr-aerodrome-facilities.json', 'utf8'),
	) as { fields: string[]; itemFields: string[]; rows: unknown[][] };

	it('has the expected schema and well-formed rows', () => {
		expect(doc.fields).toEqual([
			'ident', 'site', 'arp', 'hours', 'fireCat', 'services', 'passenger', 'contact', 'directory',
		]);
		expect(doc.itemFields).toEqual(['cat', 'text']);
		expect(doc.rows.length).toBeGreaterThan(100);
		for (const r of doc.rows) {
			expect(r).toHaveLength(9);
			expect(typeof r[0]).toBe('string'); // ident
			for (const section of [r[5], r[6], r[7], r[8]]) {
				expect(Array.isArray(section)).toBe(true);
				for (const item of section as unknown[][]) {
					expect(item).toHaveLength(2); // [cat, text]
					expect(item[1]).not.toBe(''); // NIL / empty dropped upstream
				}
			}
		}
	});

	it('carries the SIA helipad directory, Créteil included', () => {
		const withHeliport = doc.rows.filter((r) => (r[8] as unknown[]).length > 0);
		expect(withHeliport.length).toBeGreaterThan(250);
		const creteil = doc.rows.find((r) => r[0] === 'LF075');
		expect(creteil).toBeDefined();
		const pairs = (col: unknown) =>
			Object.fromEntries(col as [string, string][]) as Record<string, string>;
		// The coded values stay codes for the panel to label.
		const hel = pairs(creteil![8]);
		expect(hel.status).toBe('TPD');
		expect(hel.night).toBe('oui');
		expect(hel.terrace).toBe('oui');
		expect(hel.remark).toContain('MOULINEAUX');
		// Hours, fire cover, lighting and the operator reuse the AD 2 columns.
		expect(creteil![3]).toBe('H24');
		expect(pairs(creteil![5]).fire).toContain('extincteurs');
		expect(pairs(creteil![5]).lighting).toContain('Feux verts');
		expect(pairs(creteil![7]).operator).toContain('Henri Mondor');
	});
});

describe('per-publisher lookup', () => {
	it('serves each ident from its own publisher, and nothing from another', async () => {
		const rows = (ident: string) => ({
			fields: ['ident', 'site', 'arp', 'hours', 'fireCat', 'services', 'passenger', 'contact', 'directory'],
			itemFields: ['cat', 'text'],
			rows: [[ident, '', '', 'H24', '', [], [], [], []]],
		});
		const byUrl: Record<string, unknown> = {
			'/data/be-aerodrome-facilities.json': rows('EBAD'),
			'/data/es-aerodrome-facilities.json': rows('LEZL'),
		};
		vi.stubGlobal(
			'fetch',
			vi.fn((url: string) =>
				Promise.resolve(
					byUrl[url]
						? jsonResponse(byUrl[url])
						: { ok: false, status: 404, headers: { get: (): string => '' } },
				),
			),
		);
		const { ensureAerodromeFacilities, facilitiesForIdent } = await import(
			'$lib/state/referenceData.svelte'
		);

		await ensureAerodromeFacilities('be');
		expect(facilitiesForIdent('EBAD', 'be')?.hours).toBe('H24');
		// The ident is real, but not this publisher's: no cross-country hit.
		expect(facilitiesForIdent('EBAD', 'es')).toBeNull();
		// A publisher with no dataset at all resolves to nothing, and
		// fetches nothing (Austria, and every OurAirports baseline row).
		expect(await ensureAerodromeFacilities('at')).toEqual([]);
		expect(await ensureAerodromeFacilities(null)).toEqual([]);
		expect(facilitiesForIdent('LOWW', 'at')).toBeNull();
	});
});
