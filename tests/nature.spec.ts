/* Tests for the nature-zone loader (src/lib/data/nature.ts): the positional
 * row mapping, the SIA legacy FL999 = unlimited normalisation (the committed
 * fr-nature.json carries one such row, PARC NATIONAL DE LA REUNION UAS), and
 * the minimum-overflight label vocabulary. */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { loadNature, natureMinAltLabel, type Nature } from '$lib/data/nature';

function jsonResponse(body: unknown) {
	return {
		ok: true,
		status: 200,
		headers: { get: () => 'application/json' },
		json: () => Promise.resolve(body),
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

const n = (over: Partial<Nature>): Nature => ({
	id: 'FM-PRN-001',
	type: 'NATURE',
	name: 'X',
	lat: 0,
	lon: 0,
	minAlt: 1000,
	minAltRef: 'AGL',
	...over,
});

describe('loadNature', () => {
	it('normalises the legacy FL999 encoding to UNL at read', async () => {
		const raw = {
			fields: ['id', 'type', 'name', 'lat', 'lon', 'minAlt', 'minAltRef'],
			rows: [
				['FM-PRN-030', 'NATURE', 'PARC NATIONAL DE LA REUNION UAS', -21.15, 55.5, 999, 'FL'],
				['LF-PRN-020', 'NATURE', 'PARC NATIONAL DES CEVENNES', 44.2, 3.6, 115, 'FL'],
			],
		};
		vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse(raw))));

		const list = await loadNature('/data/x.json');
		expect(list[0].minAltRef).toBe('UNL');
		expect(natureMinAltLabel(list[0])).toBe('UNL');
		// A genuine flight level stays numeric.
		expect(list[1].minAltRef).toBe('FL');
		expect(natureMinAltLabel(list[1])).toBe('FL 115');
	});
});

describe('natureMinAltLabel', () => {
	it('renders the SIA vocabulary', () => {
		expect(natureMinAltLabel(n({ minAlt: 1000, minAltRef: 'AGL' }))).toBe('1000 ft ASFC');
		expect(natureMinAltLabel(n({ minAlt: 3300, minAltRef: 'AMSL' }))).toBe('3300 ft AMSL');
		expect(natureMinAltLabel(n({ minAltRef: 'SFC' }))).toBe('SFC');
		expect(natureMinAltLabel(n({ minAltRef: 'UNL' }))).toBe('UNL');
		expect(natureMinAltLabel(n({ minAlt: 115, minAltRef: 'FL' }))).toBe('FL 115');
	});
});
