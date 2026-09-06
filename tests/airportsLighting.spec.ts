/* Tests for runway-lighting loading (src/lib/data/airports.ts): the per-end
 * `le_lgt`/`he_lgt` object -> RunwayLighting mapping, the tolerance-load of an
 * older 14-column runway row (no lighting -> null), and a structural check of
 * the committed fr-airports.json. */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadAirports } from '$lib/data/airports';

const FIELDS = [
	'ident', 'type', 'name', 'lat', 'lon', 'elev_ft', 'iso_country', 'municipality',
	'iata', 'runways', 'access', 'military', 'vfr', 'ifr', 'joint', 'frequencies',
	'transition_alt_ft',
];
const RWY_FIELDS = [
	'le', 'he', 'length_ft', 'width_ft', 'surface', 'lit',
	'le_lda_ft', 'le_tora_ft', 'le_toda_ft', 'le_asda_ft',
	'he_lda_ft', 'he_tora_ft', 'he_toda_ft', 'he_asda_ft', 'le_lgt', 'he_lgt',
];

function airportDoc(runway: unknown[]) {
	return {
		fields: FIELDS,
		runwayFields: RWY_FIELDS,
		frequencyFields: ['freq', 'unit', 'call'],
		rows: [
			['LFXX', 'small_airport', 'Test', 48, 2, null, 'FR', 'Town', '',
				[runway], 'cap', false, true, true, false, [], null],
		],
	};
}
function stubFetch(body: unknown) {
	vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(body) })));
}

afterEach(() => vi.unstubAllGlobals());

describe('runway lighting loading', () => {
	it('maps the per-end lighting object to RunwayLighting', async () => {
		stubFetch(
			airportDoc([
				'09', '27', 3600, 45, 'ASP', 1, null, null, null, null, null, null, null, null,
				{ lines: [['EDGE', 'WHI', 'LIH'], ['THR', 'GRN', '']], papi: ['PAPI', 'LEFT'], als: ['A', 900] },
				null,
			]),
		);
		const [ap] = await loadAirports('/data/x.json');
		const r = ap.runways[0];
		expect(r.leLighting).toEqual({
			lines: [
				{ psn: 'EDGE', colour: 'WHI', intst: 'LIH' },
				{ psn: 'THR', colour: 'GRN', intst: '' },
			],
			papi: ['PAPI', 'LEFT'],
			als: ['A', 900],
		});
		expect(r.heLighting).toBeNull(); // 27 end unlit
	});

	it('leaves papi/als null when the object omits them', async () => {
		stubFetch(
			airportDoc([
				'09', '27', 3600, 45, 'ASP', 1, null, null, null, null, null, null, null, null,
				{ lines: [['EDGE', 'WHI', 'LIH']] }, null,
			]),
		);
		const [ap] = await loadAirports('/data/x.json');
		expect(ap.runways[0].leLighting).toEqual({
			lines: [{ psn: 'EDGE', colour: 'WHI', intst: 'LIH' }],
			papi: null,
			als: null,
		});
	});

	it('tolerance-loads an older 14-column runway row as null lighting', async () => {
		stubFetch(
			airportDoc(['09', '27', 3600, 45, 'ASP', 0, null, null, null, null, null, null, null, null]),
		);
		const [ap] = await loadAirports('/data/x.json');
		expect(ap.runways[0].leLighting).toBeNull();
		expect(ap.runways[0].heLighting).toBeNull();
	});
});

describe('committed fr-airports.json lighting', () => {
	const doc = JSON.parse(readFileSync('public/data/fr-airports.json', 'utf8')) as {
		runwayFields: string[];
		rows: unknown[][];
	};

	it('carries the two lighting columns and well-formed objects', () => {
		expect(doc.runwayFields.slice(-4)).toEqual(['le_lgt', 'he_lgt', 'le_pos', 'he_pos']);
		let lit = 0;
		for (const row of doc.rows) {
			for (const rw of row[9] as unknown[][]) {
				expect(rw).toHaveLength(18);
				for (const cell of [rw[14], rw[15]]) {
					if (cell == null) continue;
					lit++;
					const l = cell as { lines: unknown[]; papi?: unknown; als?: unknown };
					expect(Array.isArray(l.lines)).toBe(true);
				}
			}
		}
		expect(lit).toBeGreaterThan(100); // ~403 lit directions in the FR data
	});
});
