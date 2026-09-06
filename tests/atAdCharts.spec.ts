import { describe, expect, it } from 'vitest';
import { rowToAerodromeLinks } from '$lib/data/atAdcharts';
import { chartLink } from '$lib/data/airports';
import type { Airport } from '$lib/data/airports';

// The edition directory is dated by the edition's own validity, so the
// base rides in the artifact instead of being recomputed from the AIRAC
// cycle the way the SIA one is.
const BASE = 'https://eaip.austrocontrol.at/lo/260710/';

function ap(p: Partial<Airport>): Airport {
	return {
		ident: 'LOWW',
		type: 'large_airport',
		name: '',
		lat: 0,
		lon: 0,
		elevFt: null,
		transitionAltFt: null,
		country: 'AT',
		city: '',
		iata: '',
		runways: [],
		access: null,
		military: false,
		joint: false,
		vfr: false,
		ifr: false,
		radios: [],
		charts: [],
		source: 'at',
		...p,
	};
}

describe('rowToAerodromeLinks', () => {
	it('resolves the AD section and every chart against the edition base', () => {
		const row = [
			'LOWW',
			'PART_3/AD_2/PRI/AD_2_LOWW/LO_AD_2_LOWW_en.pdf',
			[
				['ADC', 'Aerodrome Chart - ICAO', 'Charts/LOWW/LO_AD_2_LOWW_1-1_en.pdf'],
				['IAC', 'Instrument Approach Chart - ICAO (ILS or LOC RWY 11)', 'Charts/LOWW/LO_AD_2_LOWW_13-1-1_en.pdf'],
			],
		] as const;
		expect(rowToAerodromeLinks(row, BASE)).toEqual({
			ident: 'LOWW',
			adUrl: `${BASE}PART_3/AD_2/PRI/AD_2_LOWW/LO_AD_2_LOWW_en.pdf`,
			charts: [
				{
					code: 'ADC',
					title: 'Aerodrome Chart - ICAO',
					url: `${BASE}Charts/LOWW/LO_AD_2_LOWW_1-1_en.pdf`,
				},
				{
					code: 'IAC',
					title: 'Instrument Approach Chart - ICAO (ILS or LOC RWY 11)',
					url: `${BASE}Charts/LOWW/LO_AD_2_LOWW_13-1-1_en.pdf`,
				},
			],
		});
	});

	it('keeps an aerodrome that publishes no charts page', () => {
		const row = ['LOAG', 'PART_3/AD_2/SRY/AD_2_LOAG/LO_AD_2_LOAG_en.pdf', []] as const;
		const got = rowToAerodromeLinks(row, BASE);
		expect(got.charts).toEqual([]);
		expect(got.adUrl).toBe(`${BASE}PART_3/AD_2/SRY/AD_2_LOAG/LO_AD_2_LOAG_en.pdf`);
	});

	it('carries the encoded space of the secondary chart directories through', () => {
		const row = [
			'LOAV',
			'PART_3/AD_2/SRY/AD_2_LOAV/LO_AD_2_LOAV_en.pdf',
			[['VAC', 'Chart for VFR flights VÖSLAU', 'Charts/SECONDARY_%20LOAV/LO_AD_2_LOAV_14-2_en.pdf']],
		] as const;
		expect(rowToAerodromeLinks(row, BASE).charts[0].url).toBe(
			`${BASE}Charts/SECONDARY_%20LOAV/LO_AD_2_LOAV_14-2_en.pdf`,
		);
	});
});

describe('chartLink for Austria', () => {
	const adUrl = `${BASE}PART_3/AD_2/PRI/AD_2_LOWW/LO_AD_2_LOWW_en.pdf`;

	it('opens the eAIP aerodrome section when the dataset resolves one', () => {
		expect(chartLink(ap({}), undefined, adUrl)).toEqual({ url: adUrl, kind: 'at-ad' });
	});

	it('links a heliport that the AIP publishes', () => {
		const heli = `${BASE}PART_3/AD_3/LOAT/LO_AD_3_LOAT_en.pdf`;
		expect(chartLink(ap({ ident: 'LOAT', type: 'heliport' }), undefined, heli)).toEqual({
			url: heli,
			kind: 'at-ad',
		});
	});

	it('leaves an Austrian field the AIP does not publish without a link', () => {
		// The KML also carries private and hospital heliports, which have
		// no AD section; their absence from the dataset is the gate.
		expect(chartLink(ap({ ident: 'LOAE', type: 'heliport' }), undefined, null)).toBeNull();
	});

	it('does not hand the Austrian link to another publisher', () => {
		expect(chartLink(ap({ ident: 'EDDF', source: 'de' }), undefined, adUrl)?.kind).not.toBe('at-ad');
	});
});
