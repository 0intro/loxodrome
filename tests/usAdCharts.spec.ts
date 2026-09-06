import { describe, expect, it } from 'vitest';
import { dtppBase, usAdChartUrl, rowToAerodromeCharts } from '$lib/data/usAdcharts';
import { chartLink } from '$lib/data/airports';
import type { Airport } from '$lib/data/airports';

// 2026-07-09 is AIRAC cycle 2607 (the FAA d-TPP cycle uses the same YYNN).
const NOW = Date.UTC(2026, 6, 15);
const BASE = 'https://aeronav.faa.gov/d-tpp/2607/';

function ap(p: Partial<Airport>): Airport {
	return {
		ident: 'KJFK', type: 'large_airport', name: '', lat: 0, lon: 0,
		elevFt: null, transitionAltFt: null, country: 'US', city: '', iata: '',
		runways: [], access: null, military: false, joint: false, vfr: false,
		ifr: false, radios: [], charts: [], source: null, ...p,
	};
}

describe('dtppBase', () => {
	it('numbers the cycle directory by the AIRAC YYNN in force', () => {
		expect(dtppBase(NOW)).toBe(BASE);
	});
});

describe('rowToAerodromeCharts', () => {
	it('resolves each PDF name against the cycle in force', () => {
		const row = [
			'KJFK',
			[
				['ADC', 'AIRPORT DIAGRAM', '00610AD.PDF'],
				['IAC', 'ILS OR LOC RWY 04R', '00610IL4R.PDF'],
			],
		] as const;
		expect(rowToAerodromeCharts(row, NOW)).toEqual({
			ident: 'KJFK',
			charts: [
				{ code: 'ADC', title: 'AIRPORT DIAGRAM', url: `${BASE}00610AD.PDF` },
				{ code: 'IAC', title: 'ILS OR LOC RWY 04R', url: `${BASE}00610IL4R.PDF` },
			],
		});
	});
});

describe('usAdChartUrl', () => {
	it('joins a PDF name onto the cycle base', () => {
		expect(usAdChartUrl('00610AD.PDF', NOW)).toBe(`${BASE}00610AD.PDF`);
	});
});

describe('chartLink for the United States', () => {
	const diagram = `${BASE}00610AD.PDF`;

	it('opens the resolved chart (airport diagram) for a US airport', () => {
		expect(chartLink(ap({}), undefined, null, null, false, diagram)).toEqual({
			url: diagram,
			kind: 'us-dtpp',
		});
	});

	it('gates on the country, not a publisher tag (US baseline has no source)', () => {
		expect(chartLink(ap({ source: null }), undefined, null, null, false, diagram)?.kind).toBe(
			'us-dtpp',
		);
	});

	it('shows no link for a US airport absent from the d-TPP', () => {
		expect(chartLink(ap({ ident: 'K99' }), undefined, null, null, false, null)).toBeNull();
	});

	it('does not hand the US link to a non-US airport', () => {
		expect(chartLink(ap({ country: 'CA' }), undefined, null, null, false, diagram)).toBeNull();
	});
});
