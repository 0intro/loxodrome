import { describe, expect, it } from 'vitest';
import { frAdChartUrl, rowToAerodromeCharts } from '$lib/data/adcharts';

// 2026-06-07 falls inside AIRAC cycle 2605, effective 2026-05-14 (the
// airportCharts.spec pin), so the rebuilt URLs carry that cycle's segments.
const NOW = Date.UTC(2026, 5, 7);

describe('frAdChartUrl', () => {
	it('resolves a stored html/eAIP-relative path against the cycle in force', () => {
		expect(frAdChartUrl('Cartes/LFPO/AD_2_LFPO_IAC_RWY06_FNA_RNP.pdf', NOW)).toBe(
			'https://www.sia.aviation-civile.gouv.fr/media/dvd/eAIP_14_MAY_2026/FRANCE/AIRAC-2026-05-14/html/eAIP/Cartes/LFPO/AD_2_LFPO_IAC_RWY06_FNA_RNP.pdf',
		);
	});

	it('resolves the AD 3 heliport tree shape unchanged', () => {
		expect(frAdChartUrl('Cartes/VAC_HEL/LFWF/LFWF/AD_3_LFWF_IAC_077_RNP.pdf', NOW)).toBe(
			'https://www.sia.aviation-civile.gouv.fr/media/dvd/eAIP_14_MAY_2026/FRANCE/AIRAC-2026-05-14/html/eAIP/Cartes/VAC_HEL/LFWF/LFWF/AD_3_LFWF_IAC_077_RNP.pdf',
		);
	});
});

describe('rowToAerodromeCharts', () => {
	it('decodes a dataset row into panel-ready chart links', () => {
		const row = [
			'LFGA',
			[
				['IAC', 'RWY01 ILS', 'Cartes/LFGA/AD_2_LFGA_IAC_RWY01_ILS.pdf'],
				['DATA', '01', 'Cartes/LFGA/AD_2_LFGA_DATA_01.pdf'],
			],
			'ad',
		] as const;
		expect(rowToAerodromeCharts(row, NOW)).toEqual({
			ident: 'LFGA',
			vac: 'ad',
			charts: [
				{
					code: 'IAC',
					title: 'RWY01 ILS',
					url: frAdChartUrl('Cartes/LFGA/AD_2_LFGA_IAC_RWY01_ILS.pdf', NOW),
				},
				{
					code: 'DATA',
					title: '01',
					url: frAdChartUrl('Cartes/LFGA/AD_2_LFGA_DATA_01.pdf', NOW),
				},
			],
		});
	});

	it('decodes a plate-only row (most helistations have no eAIP page)', () => {
		expect(rowToAerodromeCharts(['LF075', [], 'hel'] as const, NOW)).toEqual({
			ident: 'LF075',
			charts: [],
			vac: 'hel',
		});
	});

	it('reads no membership from an empty token or a missing element', () => {
		expect(rowToAerodromeCharts(['LFBC', [], ''] as const, NOW).vac).toBeNull();
		expect(rowToAerodromeCharts(['LFBC', []] as const, NOW).vac).toBeNull();
	});
});
