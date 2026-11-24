/* Unit tests for the RAI (auto-info) frequency extraction that narrows a
 * military / activable controlled airspace's lumped radio list to the single
 * frequency the chart cites. Phrasings are taken verbatim from fr-airspaces
 * remarks (Orléans, Luxeuil, Lann-Bihoué, Évreux, Cognac, Phalsbourg,
 * Mont-de-Marsan). */

import { describe, it, expect } from 'vitest';
import { NO_ENTRY } from '$lib/data/airspaceEntry';
import {
	raiFrequency,
	raiRadioIndex,
	narrowToRai,
	workableAirspaceRadios,
	type Airspace,
	type AirspaceRadio,
} from '$lib/data/airspaces';
import { computeAirspaceSchedule } from '$lib/route/airspaces';
import type { Waypoint } from '$lib/state/route.svelte';

describe('raiFrequency', () => {
	it('reads the frequency bound to RAI across the published phrasings', () => {
		expect(raiFrequency('OAT/GAT procedures.# Activity known on RAI 122.7, PARIS ACC/FIC.')).toBe(
			'122.7',
		);
		expect(raiFrequency('Deactivation announced by RAI 129.925')).toBe('129.925');
		expect(raiFrequency('Deactivation announced on RAI 128.95 or ORLY APP.')).toBe('128.95');
		// optional FREQ / frequency word
		expect(raiFrequency('Manager announced by RAI FREQ 122.400.')).toBe('122.400');
		expect(raiFrequency('Actual activity known on RAI frequency 118.125 or by PARIS ACC/FIC.')).toBe(
			'118.125',
		);
		// a colon hugging the token, and a trailing MHz, are tolerated
		expect(raiFrequency('CTR deactivation announced by :RAI 132.450 or by AQUITAINE INFO.')).toBe(
			'132.450',
		);
		expect(raiFrequency('Deactivation is announced on RAI 118.450 MHz (PHALSBOURG APP).')).toBe(
			'118.450',
		);
		// case-insensitive
		expect(raiFrequency('deactivation announced by rai 134.775.')).toBe('134.775');
	});

	it('takes the RAI value, not a neighbouring FIS frequency (Mont-de-Marsan)', () => {
		const rmk =
			'Deactivation announced by RAI 119.7.# Activity known on:# - PYRENEES INFO 126.525,# - BORDEAUX INFO 120.575,# - BIARRITZ INFO 119.175.';
		expect(raiFrequency(rmk)).toBe('119.7');
	});

	it('returns null when no RAI frequency is cited', () => {
		expect(raiFrequency('OAT/GAT procedures.')).toBeNull();
		// a frequency present but not as an RAI is not picked up
		expect(raiFrequency('Contact TWR on 118.500.')).toBeNull();
		// "RAI" only matches as a whole word, never inside TERRAIN
		expect(raiFrequency('TERRAIN survol 122.500.')).toBeNull();
	});
});

const radio = (...freqs: string[]): AirspaceRadio[] =>
	freqs.map((freq) => ({ freq, unit: 'LFOJ BRICY', call: 'BRICY - APPROCHE' }));

describe('raiRadioIndex', () => {
	it('finds the cited RAI frequency in the lumped list, whatever its position', () => {
		const rmk = 'Activity known on RAI 122.7, PARIS ACC/FIC.';
		expect(raiRadioIndex({ rmk, radio: radio('122.7', '138.75', '265.9') })).toBe(0);
		expect(raiRadioIndex({ rmk, radio: radio('265.9', '138.75', '122.7') })).toBe(2);
	});

	it('matches across SIA-vs-AIXM trailing-zero formatting', () => {
		// remark "122.7" against a list value stored as "122.700"
		expect(raiRadioIndex({ rmk: 'RAI 122.7', radio: radio('122.700') })).toBe(0);
	});

	it('is null when the cited RAI frequency is not linked (the inject cases)', () => {
		// Lorient LFRH cites RAI 123.0 but the AIXM never linked it
		expect(raiRadioIndex({ rmk: 'RAI 123.0', radio: radio('122.4', '264.425') })).toBeNull();
	});

	it('is null when the remark cites no RAI', () => {
		expect(raiRadioIndex({ rmk: 'OAT/GAT procedures.', radio: radio('122.7', '265.9') })).toBeNull();
	});
});

describe('narrowToRai', () => {
	it('keeps only the indexed entry', () => {
		const rs = radio('122.7', '138.75', '265.9');
		expect(narrowToRai(rs, 0)).toEqual([rs[0]]);
		expect(narrowToRai(rs, 2)).toEqual([rs[2]]);
	});

	it('returns the list unchanged when there is no RAI index', () => {
		const rs = radio('122.7', '138.75');
		expect(narrowToRai(rs, null)).toBe(rs);
	});

	it('guards an out-of-range index by returning the full list', () => {
		const rs = radio('122.7');
		expect(narrowToRai(rs, 5)).toBe(rs);
	});
});

// A box airspace centred on a west->east route at lat 47.9, so the route enters
// and leaves it; vertical limits left open so altitude never excludes it.
function boxAirspace(over: Partial<Airspace>): Airspace {
	const ring: [number, number][] = [
		[47.8, 1.5],
		[48.0, 1.5],
		[48.0, 2.0],
		[47.8, 2.0],
	];
	return {
		id: 'LFOJ1.1',
		key: 'LFOJ1.1|ORLEANS 1.1',
		type: 'TMA',
		name: 'ORLEANS 1.1',
		airClass: 'D',
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
		ring,
		subtype: '',
		category: 'controlled',
		source: 'fr',
		area: 1,
		bbox: { minLat: 47.8, minLon: 1.5, maxLat: 48.0, maxLon: 2.0 },
		...over,
	};
}

const route: Waypoint[] = [
	{ id: 'a', lat: 47.9, lon: 1.0, kind: 'free', alt: 3000, altAuto: true },
	{ id: 'b', lat: 47.9, lon: 2.5, kind: 'free', alt: 3000, altAuto: true },
];

describe('computeAirspaceSchedule RAI narrowing', () => {
	it('narrows a military airspace to its RAI frequency in the schedule', () => {
		// Orléans BRICY APP lumps a dozen civil + military VHF/UHF freqs onto the TMA.
		const a = boxAirspace({
			rmk: 'OAT/GAT procedures.# Activity known on RAI 122.7, PARIS ACC/FIC or SEINE SIV.',
			radio: radio('122.7', '123.3', '138.75', '139.4', '265.9', '336.1', '362.3', '374.225'),
		});
		const events = computeAirspaceSchedule(route, [a], 100, 3000);
		expect(events.length).toBeGreaterThan(0);
		for (const ev of events) {
			expect(ev.radio).toHaveLength(1);
			expect(ev.radio[0].freq).toBe('122.7');
		}
	});

	it('leaves an airspace with no RAI citation untouched', () => {
		const a = boxAirspace({
			rmk: 'Class D controlled airspace.',
			radio: radio('120.5', '121.3'),
		});
		const events = computeAirspaceSchedule(route, [a], 100, 3000);
		expect(events.length).toBeGreaterThan(0);
		for (const ev of events) {
			expect(ev.radio).toHaveLength(2);
		}
	});
});

// The one recipe for "the channels this airspace offers" (makeEvent, the
// schedule's NOTAM path, the alert banner): the RAI narrowing FIRST, since
// its index points into the published order, then the civil VHF band with
// guard out. The rows are verbatim from fr-airspaces / uk-airspaces.
describe('workableAirspaceRadios', () => {
	const row = (rmk: string, freqs: [string, string][]) => ({
		rmk,
		radio: freqs.map(([freq, call]) => ({ freq, unit: 'U', call })),
	});

	it('narrows to the RAI channel before filtering (CTR EVREUX, guard first)', () => {
		const evreux = row('OAT/GAT procedures.#Deactivation announced by RAI 118.125 or by PARIS ACC FIC.', [
			['121.5', 'EVREUX - APPROCHE'],
			['243', 'EVREUX - APPROCHE'],
			['362.3', 'EVREUX - APPROCHE'],
			['142.45', 'EVREUX - APPROCHE'],
			['362.2', 'EVREUX - APPROCHE'],
			['118.125', 'EVREUX - APPROCHE'],
			['122.1', 'EVREUX - TOUR'],
			['119.7', 'EVREUX - TOUR'],
		]);
		expect(workableAirspaceRadios(evreux, evreux.radio).map((r) => r.freq)).toEqual(['118.125']);
	});

	it('drops UHF, VHF above the civil band and guard where no RAI narrows (CTA SALON 1)', () => {
		const salon = row('Possible activation every day from 0500 to 2359.', [
			['243', 'SALON - APPROCHE'],
			['362.3', 'SALON - APPROCHE'],
			['135.15', 'SALON - APPROCHE'],
			['142.175', 'SALON - APPROCHE'],
			['372.8', 'SALON - APPROCHE'],
		]);
		expect(workableAirspaceRadios(salon, salon.radio).map((r) => r.freq)).toEqual(['135.15']);
	});

	it('keeps a list with nothing workable as published (CTR LONDON GATWICK)', () => {
		const gatwick = row('', [['121.500', 'GATWICK DIRECTOR']]);
		expect(workableAirspaceRadios(gatwick, gatwick.radio).map((r) => r.freq)).toEqual(['121.500']);
	});

	it('narrows a resolved list by the row it came from', () => {
		// The schedule's NOTAM path passes the override-resolved rows, which
		// keep the published order, with the published row for the index.
		const evreux = row('Deactivation announced by RAI 118.125.', [
			['121.5', 'EVREUX - APPROCHE'],
			['118.125', 'EVREUX - APPROCHE'],
		]);
		const resolved = [
			{ freq: '121.5', unit: 'U', call: 'EVREUX - APPROCHE' },
			{ freq: '118.130', unit: 'U', call: 'EVREUX - APPROCHE' },
		];
		expect(workableAirspaceRadios(evreux, resolved).map((r) => r.freq)).toEqual(['118.130']);
	});
});
