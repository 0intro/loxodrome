/* Countries on the search engine (src/lib/search/countries.ts): the extent a
 * country's aerodromes occupy, and the fly-to rows named in both languages. */

import { describe, it, expect } from 'vitest';
import type { Airport } from '$lib/data/airports';
import { countryIndex, rankCountries, robustExtent } from '$lib/search/countries';
import { regionNames } from '$lib/i18n/intl';
import { prepareQuery } from '$lib/search/query';

describe('robustExtent', () => {
	it('keeps Corsica with the mainland', () => {
		const pts = [
			{ lat: 48.86, lon: 2.35 },
			{ lat: 43.6, lon: 1.44 },
			{ lat: 45.76, lon: 4.84 },
			{ lat: 47.22, lon: -1.55 },
			{ lat: 50.63, lon: 3.06 },
			{ lat: 43.3, lon: 5.37 },
			{ lat: 48.58, lon: 7.75 },
			{ lat: 44.84, lon: -0.58 },
			{ lat: 41.92, lon: 8.8 },
			{ lat: 42.7, lon: 9.45 },
		];
		const b = robustExtent(pts);
		expect(b?.minLat).toBeCloseTo(41.92, 2);
		expect(b?.maxLon).toBeCloseTo(9.45, 2);
	});

	it('takes an archipelago astride the antimeridian as one interval', () => {
		const b = robustExtent([
			{ lat: 52, lon: 172 },
			{ lat: 52, lon: 178 },
			{ lat: 52, lon: -179 },
			{ lat: 52, lon: -176 },
			{ lat: 52, lon: -170 },
		]);
		expect(b?.minLon).toBeCloseTo(172, 6);
		expect(b?.maxLon).toBeCloseTo(190, 6);
	});

	it('leaves out a far territory filed under the country, and pads a single strip', () => {
		const pts = Array.from({ length: 12 }, (_, i) => ({ lat: 46 + (i % 4), lon: 2 + i / 4 }));
		pts.push({ lat: -21.1, lon: 55.5 });
		expect(robustExtent(pts)?.minLat).toBeGreaterThan(45);
		const one = robustExtent([{ lat: 43.73, lon: 7.42 }]);
		expect(one && one.maxLat - one.minLat).toBeCloseTo(0.5, 6);
		expect(robustExtent([])).toBeNull();
	});
});

function ap(country: string, lat: number, lon: number, type = 'small_airport'): Airport {
	return { ident: `${country}${lat}`, country, lat, lon, type } as Airport;
}

describe('countryIndex and rankCountries', () => {
	const names = (code: string, lang: 'en' | 'fr'): string | undefined => regionNames(lang).of(code);
	const index = countryIndex(
		[ap('DE', 52.5, 13.4), ap('DE', 48.1, 11.6), ap('BE', 50.85, 4.35), ap('BE', 51.2, 4.4, 'closed'), ap('ZZ', 0, 0), ap('XX', 1, 1)],
		names,
	);
	const first = (q: string): string | undefined => rankCountries(index, prepareQuery(q), { ref: null, cap: 3 }).hits[0]?.item.code;

	it('names a country in English and in French from the platform, leaving no country and an unknown code out', () => {
		const de = index.find((c) => c.code === 'DE');
		expect(de?.en).toBe('Germany');
		expect(de?.fr).toBe('Allemagne');
		expect(index.find((c) => c.code === 'BE')?.count).toBe(1);
		expect(index.some((c) => c.code === 'ZZ' || c.code === 'XX')).toBe(false);
	});

	it('answers either language from three letters, never to a two-letter code', () => {
		expect(first('Allemagne')).toBe('DE');
		expect(first('germ')).toBe('DE');
		expect(first('Belgique')).toBe('BE');
		expect(first('Belgium')).toBe('BE');
		expect(first('ge')).toBeUndefined();
		expect(first('DE')).toBeUndefined();
	});
});
