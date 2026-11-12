/* The search over the committed datasets, read through the app's own
 * loaders and merge (fetch stands in for the server, reading public/): the
 * cases measured on dev 38956e00 that the one engine answers
 * (docs/search.md "Why one engine"). */

import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadAirports, loadFrAirports, type Airport } from '$lib/data/airports';
import { mergeAixmOverlays } from '$lib/data/airportMerge';
import { loadNavaids, type Navaid } from '$lib/data/navaids';
import { loadPlaces, type Place } from '$lib/data/places';
import { rankAirports } from '$lib/search/airports';
import { rankNavaids } from '$lib/search/navaids';
import { rankPlaces } from '$lib/search/places';
import { orderGroups } from '$lib/search/combine';
import { isIdentTier, TIER } from '$lib/search/match';
import { prepareQuery } from '$lib/search/query';
import { distFrom, FAR_IDENT_M, type Hit } from '$lib/search/rank';

const PARIS = { lat: 48.86, lon: 2.35 };
let airports: Airport[] = [];
let frNavaids: Navaid[] = [];
// Every country the town cases meet, the FAA's included, as "Search all
// countries" loads them.
let navaids: Navaid[] = [];
let places: Place[] = [];
const realFetch = globalThis.fetch;

beforeAll(async () => {
	globalThis.fetch = (input: RequestInfo | URL): Promise<Response> => {
		const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
		return Promise.resolve(
			new Response(readFileSync(`public${path}`, 'utf8'), { headers: { 'content-type': 'application/json' } }),
		);
	};
	const base = await loadAirports('/data/airports.json');
	const fr = await loadFrAirports('/data/fr-airports.json', 'fr');
	const de = await loadFrAirports('/data/de-airports.json', 'de');
	// The app merges in its own order, the later publisher winning its fields
	// (data.svelte.ts publishAirports); France and Germany do not overlap.
	airports = mergeAixmOverlays(base, [fr, de]);
	frNavaids = await loadNavaids('/data/fr-navaids.json');
	navaids = [...frNavaids];
	for (const c of ['de', 'uk', 'es', 'it', 'faa']) {
		navaids.push(...(await loadNavaids(`/data/${c}-navaids.json`)));
	}
	places = [...(await loadPlaces('fr', true)), ...(await loadPlaces('de', false)), ...(await loadPlaces('it', false))];
}, 120_000);

afterAll(() => {
	globalThis.fetch = realFetch;
});

const first = (q: string): string | undefined =>
	rankAirports(airports, prepareQuery(q), { ref: PARIS, cap: 5 }).hits[0]?.item.ident;

describe('the search over the committed aerodromes', () => {
	it('finds München however it is typed, though DFS writes MUENCHEN', () => {
		expect(airports.find((a) => a.ident === 'EDDM')?.name).toBe('MUENCHEN');
		for (const q of ['München', 'Munchen', 'Muenchen', 'Munich']) {
			expect(first(q), q).toBe('EDDM');
		}
		for (const q of ['Köln', 'Koeln', 'Cologne']) {
			expect(first(q), q).toBe('EDDK');
		}
	});

	it('finds a French town by its own spelling, in any word order', () => {
		expect(first('Mont-de-Marsan')).toBe('LFBM');
		expect(first('Angoulême')).toBe('LFBU');
		expect(first('bron lyon')).toBe('LFLY');
		expect(first('Saint-Étienne')).toBe('LFMH');
	});

	it('finds a French reporting point by the landmark the SIA names it after', () => {
		const top = rankNavaids(frNavaids, prepareQuery('Neuville de Poitou'), { ref: PARIS, cap: 6 }).hits[0];
		expect(top?.item.ident).toBe('BIN');
	});

	it('finds a field by the commune the worldwide list files it under', () => {
		// Dunkerque-Les Moëres, which the SIA names after Dunkerque.
		expect(first('Ghyvelde')).toBe('LFAK');
	});
});

/** The palette's groups for `q` typed at `ref`, best first. */
function paletteAt(q: string, ref: { lat: number; lon: number }) {
	const pq = prepareQuery(q);
	return orderGroups([
		{ id: 'airports', ranked: rankAirports(airports, pq, { ref, cap: 6 }) },
		{ id: 'navaids', ranked: rankNavaids(navaids, pq, { ref, cap: 6 }) },
		{ id: 'places', ranked: rankPlaces(places, pq, { ref, cap: 6 }) },
	]);
}

/** The largest town named `name`. */
function town(name: string): Place {
	return places.filter((p) => p.name === name).sort((a, b) => (b.pop ?? 0) - (a.pop ?? 0))[0];
}

/** The palette's first group for `q` typed at the town named `name`, and
 *  its first row: the town, a navaid or an aerodrome. */
function leadAt(q: string, name: string): string {
	const g = paletteAt(q, town(name))[0];
	const item = g?.ranked.hits[0]?.item as { ident?: string; name: string } | undefined;
	return `${g?.id} ${item?.ident ?? item?.name}`;
}

describe('the towns over the committed data', () => {
	it('leads with a whole name, before a waypoint whose ident it begins', () => {
		// AGENO and ROMAM, French waypoints, led until a whole name ranked
		// above an identifier begun. The whole names here are radio aids',
		// AGEN for AGN and ROMA for RMC, which a town stands half a tier under.
		expect(leadAt('Agen', 'Agen')).toBe('navaids AGN');
		expect(leadAt('Roma', 'Roma')).toBe('navaids RMC');
	});

	it('leads with the town, never an identifier more than 1,000 NM away', () => {
		// Pauk, Myanmar, by its IATA code PAU; Gusap, Papua New Guinea, GAP;
		// Raxaul, India, VERL; New Ulm, Minnesota, ULM.
		for (const name of ['Pau', 'Gap', 'Verl', 'Ulm']) {
			expect(leadAt(name, name), name).toBe(`places ${name}`);
		}
		// An FAA reporting point is WORMS too: the town's own airfield, named
		// WORMS by the DFS, leads with its whole name.
		expect(leadAt('Worms', 'Worms')).toBe('airports EDFV');
		const pau = paletteAt('Pau', town('Pau')).find((g) => g.id === 'airports');
		expect((pau?.ranked.hits[0]?.item as Airport | undefined)?.ident).toBe('LFBP');
	});

	it('never leads with an identifier a town merely begins, nor one beyond 1,000 NM', { timeout: 60_000 }, () => {
		// Every identifier a typed name can meet, sorted, to find the towns
		// whose name is one or begins one.
		const ids = [
			...airports.flatMap((a) => (a.iata ? [a.ident, a.iata] : [a.ident])),
			...navaids.map((n) => n.ident),
		]
			.map((x) => x.toUpperCase())
			.sort();
		const begins = (q: string): boolean => {
			let lo = 0;
			let hi = ids.length;
			while (lo < hi) {
				const mid = (lo + hi) >> 1;
				if (ids[mid] < q) {
					lo = mid + 1;
				} else {
					hi = mid;
				}
			}
			return lo < ids.length && ids[lo].startsWith(q);
		};
		const towns = places.filter((p) => (p.country === 'FR' || p.country === 'DE') && (p.pop ?? 0) >= 5000 && begins(p.name.toUpperCase()));
		expect(towns.length).toBeGreaterThan(30);
		const wrong: string[] = [];
		for (const t of towns) {
			const top = paletteAt(t.name, t)[0]?.ranked.hits[0] as Hit<{ lat: number; lon: number; ident?: string; name: string }> | undefined;
			if (!top || top.item === (t as unknown)) {
				continue;
			}
			const begun = top.tier === TIER.IDENT_PREFIX || top.tier === TIER.ALT_IDENT_PREFIX;
			const farIdent = isIdentTier(top.tier) && distFrom(t, top.item.lat, top.item.lon) > FAR_IDENT_M;
			if (begun || farIdent) {
				wrong.push(`${t.name}: ${top.item.ident ?? top.item.name} tier ${top.tier}`);
			}
		}
		expect(wrong).toEqual([]);
	});
});

// Each ident is a full ranking over the merged aerodromes: some 280 of
// them take four seconds on an idle machine, more beside the other files.
const SWEEP_TIMEOUT_MS = 60_000;

describe('the palette over the committed data', () => {
	it('leads with the navaid for every French radio-navaid ident typed exactly', { timeout: SWEEP_TIMEOUT_MS }, () => {
		const RADIO = new Set(['VOR', 'VOR-DME', 'VORTAC', 'NDB', 'DME', 'TACAN']);
		const idents = [...new Set(frNavaids.filter((n) => RADIO.has(n.type)).map((n) => n.ident.toUpperCase()))];
		const icao = new Set(airports.map((a) => a.ident.toUpperCase()));
		expect(idents.length).toBeGreaterThan(250);
		const wrong: string[] = [];
		for (const ident of idents) {
			const q = prepareQuery(ident);
			// Typed where the navaid is: from Paris, an overseas one (Guiana,
			// the Antilles, the Pacific) lies beyond FAR_IDENT_M.
			const rows = frNavaids.filter((n) => n.ident.toUpperCase() === ident);
			const ref = rows.some((n) => distFrom(PARIS, n.lat, n.lon) <= FAR_IDENT_M) ? PARIS : { lat: rows[0].lat, lon: rows[0].lon };
			const groups = orderGroups([
				{ id: 'airports', ranked: rankAirports(airports, q, { ref, cap: 6 }) },
				{ id: 'navaids', ranked: rankNavaids(frNavaids, q, { ref, cap: 6 }) },
			]);
			const top = groups[0]?.ranked.hits[0];
			const isNavaid = groups[0]?.id === 'navaids' && (top?.item as Navaid).ident.toUpperCase() === ident;
			if (top?.tier !== TIER.IDENT_EXACT || (!icao.has(ident) && !isNavaid)) {
				wrong.push(`${ident}: ${groups[0]?.id} tier ${top?.tier}`);
			}
		}
		expect(wrong).toEqual([]);
	});

	it('ranks an overseas navaid typed from Paris after every name', () => {
		const top = rankNavaids(frNavaids, prepareQuery('SDG'), { ref: PARIS, cap: 6 }).hits[0];
		expect(top?.item.ident).toBe('SDG');
		expect(top?.tier).toBe(TIER.FAR_IDENT);
	});
});
