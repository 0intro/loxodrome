/* The Airports tab's list (state/airportSearch.svelte.ts rankAirportList,
 * components/tabs/AirportsTab.svelte): the aerodromes a query matches, and
 * the ones nearest the town it names (docs/search.md "Aerodromes"). */

import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadAirports, loadFrAirports, type Airport } from '$lib/data/airports';
import { mergeAixmOverlays } from '$lib/data/airportMerge';
import { civilGrades, FR_FUEL_URL, loadFrFuel, type AerodromeFuel } from '$lib/data/fuel';
import { loadPlaces, type Place } from '$lib/data/places';
import { NEAREST_LIMIT } from '$lib/nav/nearest';
import { rankAirportList, TOWN_RADIUS_NM } from '$lib/state/airportSearch.svelte';

const NM_IN_DEG = 1 / 60;

function ap(ident: string, name: string, lat: number, lon: number, extra: Partial<Airport> = {}): Airport {
	return { ident, iata: '', name, city: '', country: 'FR', type: 'small_airport', lat, lon, ...extra } as Airport;
}

function town(id: string, name: string, lat: number, lon: number, pop: number): Place {
	return { id, country: 'FR', name, lat, lon, pop, admin: '', alt: '', commune: true };
}

const idents = (rows: readonly { ident: string }[]): string[] => rows.map((a) => a.ident);

describe('rankAirportList', () => {
	const PAU = town('fr:64445', 'Pau', 43.3, -0.37, 77000);
	const lfbp = ap('LFBP', 'PAU PYRENEES', 43.38, -0.37, { iata: 'PUF', type: 'medium_airport' });
	const lfcz = ap('LFCZ', 'MIMIZAN', 44.15, -1.17);
	const vypk = ap('VYPK', 'Pauk Airport', 21.45, 94.49, { iata: 'PAU' });

	it('leads with the town a query names, its nearest fields from the town, the other matches after', () => {
		const r = rankAirportList([vypk, lfcz, lfbp], [PAU], 'Pau', undefined, PAU);
		expect(idents(r.results)).toEqual(['LFBP', 'VYPK']);
		expect(r.town?.hit.item.id).toBe('fr:64445');
		expect(r.town?.first).toBe(true);
		expect(r.town?.near.map((n) => n.airport.ident)).toEqual(['LFBP', 'LFCZ']);
		// LFBP is the town's: it is listed once, in the town's group.
		expect(idents(r.town?.others ?? [])).toEqual(['VYPK']);
		// Due north of the town: the bearing runs from the town, as the place
		// panel reads it.
		expect(r.town?.near[0].bearingTrueDeg).toBeCloseTo(0, 3);
	});

	it('lists the matches first when an aerodrome is the better answer', () => {
		// The aerodrome's whole name stands half a tier above the town's.
		const chavenay = town('fr:78140', 'Chavenay', 48.85, 1.99, 1800);
		const lfpx = ap('LFPX', 'CHAVENAY', 48.84, 1.98);
		const r = rankAirportList([lfpx], [chavenay], 'Chavenay', undefined, chavenay);
		expect(r.town?.first).toBe(false);
		expect(idents(r.town?.near.map((n) => n.airport) ?? [])).toEqual(['LFPX']);
	});

	it('filters before the limit, out to TOWN_RADIUS_NM', () => {
		const at = (ident: string, nm: number): Airport => ap(ident, ident, PAU.lat + nm * NM_IN_DEG, PAU.lon);
		const many = Array.from({ length: NEAREST_LIMIT + 4 }, (_, i) => at(`F${String(i).padStart(2, '0')}`, i + 1));
		const seller = at('SELL', TOWN_RADIUS_NM - 1);
		const beyond = at('FAR', TOWN_RADIUS_NM + 1);
		const all = [...many, seller, beyond];
		expect(rankAirportList(all, [PAU], 'Pau', undefined, PAU).town?.near).toHaveLength(NEAREST_LIMIT);
		const sells = (a: Airport): boolean => a.ident === 'SELL' || a.ident === 'FAR';
		expect(rankAirportList(all, [PAU], 'Pau', sells, PAU).town?.near.map((n) => n.airport.ident)).toEqual(['SELL']);
		expect(rankAirportList(all, [PAU], 'Pau', () => false, PAU).town?.near).toEqual([]);
	});

	it('names no town for a query inside a name, an ICAO, or before the towns load', () => {
		expect(rankAirportList([lfbp], [PAU], 'au', undefined, PAU).town).toBeNull();
		expect(rankAirportList([lfbp], [PAU], 'LFBP', undefined, PAU).town).toBeNull();
		expect(rankAirportList([lfbp], null, 'Pau', undefined, PAU).town).toBeNull();
	});
});

describe('the Airports tab over the committed data', () => {
	let airports: Airport[] = [];
	let places: Place[] = [];
	let fuel = new Map<string, AerodromeFuel>();
	const realFetch = globalThis.fetch;

	beforeAll(async () => {
		globalThis.fetch = (input: RequestInfo | URL): Promise<Response> => {
			const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
			return Promise.resolve(
				new Response(readFileSync(`public${path}`, 'utf8'), { headers: { 'content-type': 'application/json' } }),
			);
		};
		const base = await loadAirports('/data/airports.json');
		airports = mergeAixmOverlays(base, [await loadFrAirports('/data/fr-airports.json', 'fr')]);
		places = await loadPlaces('fr', true);
		fuel = new Map((await loadFrFuel(FR_FUEL_URL)).map((f) => [f.ident, f]));
	}, 120_000);

	afterAll(() => {
		globalThis.fetch = realFetch;
	});

	it('answers "Dourdan", a town with no aerodrome of its own, and "UL91 near Dourdan"', () => {
		const dourdan = places.find((p) => p.name === 'Dourdan');
		expect(dourdan?.admin).toBe('Essonne');
		const ref = { lat: dourdan?.lat ?? 0, lon: dourdan?.lon ?? 0 };
		const r = rankAirportList(airports, places, 'Dourdan', undefined, ref);
		expect(r.total).toBe(0);
		expect(r.town?.first).toBe(true);
		const near = r.town?.near ?? [];
		expect(near.map((n) => n.airport.ident).slice(0, 4)).toEqual(['LFOX', 'LFFQ', 'LFPN', 'LFFL']);
		expect(near).toHaveLength(NEAREST_LIMIT);
		expect(Math.round(near[0].distNM)).toBe(9);
		const ul91 = (a: Airport): boolean => {
			const f = fuel.get(a.ident);
			return !!f && f.avail !== 'no' && civilGrades(f).includes('UL91');
		};
		const sellers = rankAirportList(airports, places, 'Dourdan', ul91, ref).town?.near ?? [];
		expect(sellers.map((n) => n.airport.ident).slice(0, 4)).toEqual(['LFFL', 'LFPF', 'LFXU', 'LFPE']);
		expect(sellers.every((n) => n.distNM <= TOWN_RADIUS_NM)).toBe(true);
	});
});

describe('the Airports tab', () => {
	const tab = readFileSync('src/lib/components/tabs/AirportsTab.svelte', 'utf8');

	it('loads the towns on its first search, as the palette does', () => {
		expect(tab).toMatch(/if \(placesAsked \|\| airportSearch\.query\.trim\(\) === ''\) \{\s*return;\s*\}\s*placesAsked = true;\s*void ensurePlaces\(\)\.catch/);
	});

	it('orders the town\'s group and the matches by their best answer, each field once', () => {
		expect(tab).toContain('{:else if search.town?.first}');
		expect(tab).toContain('const listed = $derived(search.town?.first ? search.town.others : search.results);');
		expect(tab).toContain('{:else if search.total === 0 && !search.town}');
	});

	it('marks a field a NOTAM shut, and gives each its distance and direction from the town', () => {
		expect(tab).toContain('<span class="shut-tag">{t.detail.adClosedTag}</span>');
		expect(tab).toContain('{fmtNM(near.distNM)} NM {compassPoint(near.bearingTrueDeg)}');
	});
});
