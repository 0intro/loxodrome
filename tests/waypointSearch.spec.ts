/* Unit tests for the proximity-aware route-builder ranking (rankWaypointHits). */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { rankWaypointHits, type WaypointHit } from '$lib/state/waypointSearch.svelte';
import type { Airport } from '$lib/data/airports';
import type { Navaid } from '$lib/data/navaids';

// Minimal mocks: rankWaypointHits only reads ident/iata/name/city/lat/lon (airports)
// and ident/name/lat/lon (navaids).
function ap(ident: string, lat: number, lon: number, extra: Partial<Airport> = {}): Airport {
	return { ident, iata: '', name: ident, city: '', lat, lon, ...extra } as Airport;
}
function nav(ident: string, lat: number, lon: number, name = ''): Navaid {
	return { id: ident, ident, name, lat, lon, type: 'VOR' } as unknown as Navaid;
}
const idents = (r: { results: WaypointHit[] }): string[] =>
	r.results.map((h) => (h.kind === 'airport' ? h.airport.ident : h.navaid.ident));

const REF = { lat: 0, lon: 0 };

describe('rankWaypointHits', () => {
	it('orders two equally-good prefix matches nearest first', () => {
		// LFAZ is nearer than LFAA, though alphabetically later.
		const airports = [ap('LFAA', 5, 0), ap('LFAZ', 1, 0)];
		expect(idents(rankWaypointHits(airports, null, 'LF', REF))).toEqual(['LFAZ', 'LFAA']);
	});

	it('keeps an exact-ident match above a nearer prefix match (tier wins)', () => {
		const airports = [ap('LFPA', 0.1, 0), ap('LFP', 10, 0)];
		expect(idents(rankWaypointHits(airports, null, 'LFP', REF))).toEqual(['LFP', 'LFPA']);
	});

	it('keeps a far prefix match above a nearer substring match (tier preserved)', () => {
		const airports = [ap('XABY', 0, 0, { name: '' }), ap('ABXX', 10, 0)];
		expect(idents(rankWaypointHits(airports, null, 'AB', REF))).toEqual(['ABXX', 'XABY']);
	});

	it('interleaves airports and navaids by proximity within a tier', () => {
		// Both prefix-match "AL"; the navaid is nearer than the airport.
		const airports = [ap('ALFA', 5, 0)];
		const navaids = [nav('ALN', 1, 0)];
		expect(idents(rankWaypointHits(airports, navaids, 'AL', REF))).toEqual(['ALN', 'ALFA']);
	});

	it('falls back to match-then-alphabetical order when ref is null', () => {
		const airports = [ap('LFAA', 5, 0), ap('LFAZ', 1, 0)];
		expect(idents(rankWaypointHits(airports, null, 'LF', null))).toEqual(['LFAA', 'LFAZ']);
	});

	it('is empty for a blank query or no data', () => {
		expect(rankWaypointHits([ap('LFAA', 0, 0)], null, '  ', REF).results).toHaveLength(0);
		expect(rankWaypointHits(null, null, 'LF', REF).results).toHaveLength(0);
	});

	it('surfaces a VFR point via its aerodrome ICAO or name', () => {
		const navaids = [nav('AQN', 50.0, 2.7)]; // id "AQN"
		const aero = new Map([['AQN', { ident: 'LFAQ', name: 'Albert Bray' }]]);
		expect(idents(rankWaypointHits(null, navaids, 'LFAQ', REF, aero))).toEqual(['AQN']);
		expect(idents(rankWaypointHits(null, navaids, 'Albert', REF, aero))).toEqual(['AQN']);
		// Without the aerodrome map the point is not reachable by the aerodrome.
		expect(rankWaypointHits(null, navaids, 'LFAQ', REF, null).results).toHaveLength(0);
	});

	it('keeps the aerodrome itself above its VFR points', () => {
		const airports = [ap('LFAQ', 49.97, 2.69)];
		const navaids = [nav('AQN', 50.0, 2.7)];
		const aero = new Map([['AQN', { ident: 'LFAQ', name: 'Albert Bray' }]]);
		expect(idents(rankWaypointHits(airports, navaids, 'LFAQ', REF, aero))).toEqual(['LFAQ', 'AQN']);
	});

	it("floats a nearby aerodrome's VFR points above a far same-named airport", () => {
		// "Albert": LFKA (Albertville, far) name-matches directly; AQN matches via its
		// aerodrome name (Albert Bray) and is near, so it ranks first.
		const airports = [ap('LFKA', 45.9, 6.4, { name: 'Albertville' })];
		const navaids = [nav('AQN', 1, 0)];
		const aero = new Map([['AQN', { ident: 'LFAQ', name: 'Albert Bray' }]]);
		expect(idents(rankWaypointHits(airports, navaids, 'Albert', REF, aero))).toEqual(['AQN', 'LFKA']);
	});
});

// The candidates a route chooses among (route/anchorChoice.ts): every loaded
// feature filed under an identifier, airports first, the first being the
// bare resolver's own answer; the ambiguous ones memoised per merge.
describe('waypointCandidates', () => {
	afterEach(() => {
		vi.doUnmock('$lib/state/data.svelte');
	});

	async function withData(airports: Airport[], navaids: Navaid[]) {
		const data = { airports, navaids };
		vi.resetModules();
		vi.doMock('$lib/state/data.svelte', async () => {
			const actual = await vi.importActual<typeof import('$lib/state/data.svelte')>('$lib/state/data.svelte');
			return { ...actual, getAirports: () => data.airports, getNavaids: () => data.navaids };
		});
		const mod = await import('$lib/state/waypointSearch.svelte');
		return { mod, data };
	}

	it('rides on the resolver, airports first, the first being its own answer', async () => {
		const cairo = ap('KCIR', 37.06, -89.22);
		const vrp: Navaid = { ...nav('KCIR', 42.64, 8.93, 'KC-IR'), id: 'WPT:8397617' };
		const { mod } = await withData([ap('LFKC', 42.52, 8.79), cairo], [vrp]);
		const r = mod.resolveWaypointToken;
		expect(r.candidates).toBe(mod.waypointCandidates);
		const c = mod.waypointCandidates('kcir');
		expect(c.map((a) => a.kind)).toEqual(['airport', 'navaid']);
		expect(c[0]).toEqual(r('KCIR'));
		expect(c[1].refId).toBe('WPT:8397617');
		expect(mod.waypointCandidates('LFKC')).toEqual([r('LFKC')]);
		expect(mod.waypointCandidates('NONE')).toEqual([]);
		expect(mod.waypointCandidates('  ')).toEqual([]);
	});

	it('follows a merge that publishes new arrays', async () => {
		const { mod, data } = await withData([ap('BOV', -3.38, 153.28)], []);
		expect(mod.waypointCandidates('BOV')).toHaveLength(1);
		data.navaids = [{ ...nav('BOV', 49.45, 2.07, 'BEAUVAIS'), id: 'VOR-DME:bov' }];
		expect(mod.waypointCandidates('BOV').map((a) => a.kind)).toEqual(['airport', 'navaid']);
	});
});
