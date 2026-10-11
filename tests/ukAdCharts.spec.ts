import { describe, expect, it } from 'vitest';
import { ukAdChartUrl, rowToAerodromeCharts } from '$lib/data/ukAdcharts';

// 2026-06-07 falls inside AIRAC cycle 2605, effective 2026-05-14, so the
// rebuilt URLs carry that cycle's dated segment (the airportCharts pin).
const NOW = Date.UTC(2026, 5, 7);
const ROOT = 'https://www.aurora.nats.co.uk/htmlAIP/Publications/2026-05-14-AIRAC/';

describe('ukAdChartUrl', () => {
	it('resolves a stored graphics path against the AIRAC cycle in force', () => {
		expect(ukAdChartUrl('graphics/487994.pdf', NOW)).toBe(`${ROOT}graphics/487994.pdf`);
	});
});

describe('rowToAerodromeCharts', () => {
	it('decodes a dataset row into panel-ready chart links', () => {
		const row = [
			'EGLL',
			[
				['ADC', 'AERODROME CHART - ICAO', 'graphics/487994.pdf'],
				['IAC', 'INSTRUMENT APPROACH CHART ILS/DME RWY 09L - ICAO', 'graphics/461600.pdf'],
			],
		] as const;
		expect(rowToAerodromeCharts(row, NOW)).toEqual({
			ident: 'EGLL',
			charts: [
				{ code: 'ADC', title: 'AERODROME CHART - ICAO', url: `${ROOT}graphics/487994.pdf` },
				{
					code: 'IAC',
					title: 'INSTRUMENT APPROACH CHART ILS/DME RWY 09L - ICAO',
					url: `${ROOT}graphics/461600.pdf`,
				},
			],
		});
	});
});
