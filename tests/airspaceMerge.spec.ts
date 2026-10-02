/* Pins the merged-airspace contract (src/lib/data/airspaceMerge.ts): a row
 * is dropped iff its id already appears in a HIGHER-priority source, while
 * same-id siblings within one source all survive (ENAIRE files FIR + UIR +
 * TMA under one LECM/LECB/GCCC id; ELMIRA TRSA ships three rings), and the
 * `#N` key suffixing keeps every ring individually addressable. */
import { describe, expect, it } from 'vitest';
import { NO_ENTRY } from '$lib/data/airspaceEntry';
import { mergeAirspaces } from '$lib/data/airspaceMerge';
import type { Airspace } from '$lib/data/airspaces';

function mk(id: string, name: string, type = 'CTR', category: Airspace['category'] = 'controlled'): Airspace {
	return {
		id,
		key: `${id}|${name}`,
		type,
		name,
		airClass: '',
		upper: null,
		lower: null,
		vUpper: null,
		vLower: null,
		vMax: null,
		vMnm: null,
		workHr: '',
		rmkWorkHr: '',
		rmk: '',
		entry: NO_ENTRY,
		radio: [],
		ring: [],
		subtype: '',
		category,
		source: 'fr',
		area: 0,
		bbox: { minLat: 0, minLon: 0, maxLat: 0, maxLon: 0 },
	};
}

describe('mergeAirspaces', () => {
	it('keeps same-id siblings within one source (the ENAIRE LECM shape)', () => {
		const es = [mk('LECM', 'TMA MADRID', 'TMA'), mk('LECM', 'UIR MADRID', 'UIR'), mk('LECM', 'FIR MADRID', 'FIR')];
		const merged = mergeAirspaces([[], es]);
		expect(merged.map((a) => a.type)).toEqual(['TMA', 'UIR', 'FIR']);
	});

	it('drops a row whose id appears in ANY higher-priority source', () => {
		const fr = [mk('LFFF', 'PARIS', 'FIR')];
		const uk = [mk('EGTT', 'LONDON', 'FIR')];
		const pru = [mk('LFFF', 'PARIS FIR', 'FIR'), mk('EGTT', 'LONDON FIR', 'FIR'), mk('EBBU', 'BRUSSELS FIR', 'FIR')];
		const merged = mergeAirspaces([fr, uk, pru]);
		expect(merged.map((a) => a.name)).toEqual(['PARIS', 'LONDON', 'BRUSSELS FIR']);
	});

	it('never lets a source block its own siblings (snapshot semantics)', () => {
		// The first GCCC row must not shadow the later GCCC rows of the SAME
		// source; only the source BELOW loses its GCCC ring.
		const es = [mk('GCCC', 'UIR CANARIAS PARTE 1', 'UIR'), mk('GCCC', 'FIR CANARIAS', 'FIR'), mk('GCCC', 'UIR CANARIAS PARTE 2', 'UIR')];
		const pru = [mk('GCCC', 'CANARIAS FIR', 'FIR')];
		const merged = mergeAirspaces([[], es, pru]);
		expect(merged.map((a) => a.name)).toEqual(['UIR CANARIAS PARTE 1', 'FIR CANARIAS', 'UIR CANARIAS PARTE 2']);
	});

	it('never drops seed rows, including same-id pieces', () => {
		const fr = [mk('LFR45', 'R 45 A', 'R'), mk('LFR45', 'R 45 B', 'R')];
		expect(mergeAirspaces([fr]).map((a) => a.name)).toEqual(['R 45 A', 'R 45 B']);
	});

	it('suffixes colliding id|name keys with #N, first keeps the clean key', () => {
		const faa = [mk('KELM', 'ELMIRA TRSA', 'TRSA'), mk('KELM', 'ELMIRA TRSA', 'TRSA'), mk('KELM', 'ELMIRA TRSA', 'TRSA')];
		const merged = mergeAirspaces([[], faa]);
		expect(merged.map((a) => a.key)).toEqual([
			'KELM|ELMIRA TRSA',
			'KELM|ELMIRA TRSA#2',
			'KELM|ELMIRA TRSA#3',
		]);
	});

	it('dedupes FIR-family rows by ICAO indicator (EGTT001 shadows EGTT)', () => {
		const uk = [mk('EGTT001', 'LONDON FIR', 'FIR', 'fir')];
		const pru = [mk('EGTT', 'LONDON FIR', 'FIR', 'fir'), mk('EHAA', 'AMSTERDAM FIR', 'FIR', 'fir')];
		const merged = mergeAirspaces([[], uk, pru]);
		expect(merged.map((a) => a.id)).toEqual(['EGTT001', 'EHAA']);
	});

	it('never lets a suffixed NON-fir id shadow a FIR by indicator', () => {
		const uk = [mk('EGTT001', 'SOME CTA', 'CTA', 'controlled')];
		const pru = [mk('EGTT', 'LONDON FIR', 'FIR', 'fir')];
		const merged = mergeAirspaces([[], uk, pru]);
		expect(merged.map((a) => a.id)).toEqual(['EGTT001', 'EGTT']);
	});

	it('falls back to the raw id for FIR-family rows with no 4-letter head', () => {
		const fr = [mk('OCA4521', 'TAHITI', 'OCA', 'fir')];
		const pru = [mk('OCA4521', 'TAHITI COPY', 'OCA', 'fir'), mk('OCA4693', 'OTHER OCA', 'OCA', 'fir')];
		const merged = mergeAirspaces([fr, pru]);
		expect(merged.map((a) => a.name)).toEqual(['TAHITI', 'OTHER OCA']);
	});

	it('keys stay distinct without suffixes when names differ', () => {
		const es = [mk('LECB', 'FIR BARCELONA', 'FIR'), mk('LECB', 'UIR BARCELONA', 'UIR'), mk('LECB', 'TMA BARCELONA', 'TMA')];
		const merged = mergeAirspaces([[], es]);
		expect(merged.map((a) => a.key)).toEqual([
			'LECB|FIR BARCELONA',
			'LECB|UIR BARCELONA',
			'LECB|TMA BARCELONA',
		]);
	});
});
