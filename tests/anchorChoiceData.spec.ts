/* The identifiers the committed data files under several features, resolved
 * by the app's own resolver and route chooser (route/anchorChoice.ts,
 * state/waypointSearch.svelte.ts) over the real datasets: the worldwide
 * aerodrome baseline and every publisher's navaids, in merge order. Each case
 * is a collision the data really holds (asserted first, so a dataset that
 * loses one fails here loudly rather than passing for nothing), and each
 * answer is asserted by kind and by where it stands, never by an id. */

import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Airport } from '$lib/data/airports';
import type { Navaid } from '$lib/data/navaids';
import { MERGE_ORDER } from '$lib/data/publishers';
import { chooseAnchors, type WaypointResolver } from '$lib/route/anchorChoice';
import { distanceNM } from '$lib/route/routePoints';
import type { WaypointAnchor } from '$lib/state/route.svelte';

function rows(path: string): unknown[][] {
	const doc = JSON.parse(readFileSync(path, 'utf8')) as { rows: unknown[][] } | unknown[][];
	return Array.isArray(doc) ? doc : doc.rows;
}

// The baseline carries every aerodrome these routes name; the overlays only
// refine a row it already has, at the same place.
const airports = rows('public/data/airports.json').map(
	(r) => ({ ident: r[0], name: r[2], lat: r[3], lon: r[4], iata: r[8] ?? '', city: r[7] ?? '' }) as unknown as Airport,
);
const navaids = MERGE_ORDER.navaids.flatMap((pub) =>
	rows(`public/data/${pub}-navaids.json`).map(
		(r) =>
			({
				id: r[0],
				type: r[1],
				ident: r[2],
				name: r[3],
				lat: r[4],
				lon: r[5],
				freq: r[6] ?? '',
				channel: r[7] ?? '',
				elev: r[8] ?? null,
				source: pub,
			}) as unknown as Navaid,
	),
);

let resolve: WaypointResolver;

beforeAll(async () => {
	vi.resetModules();
	vi.doMock('$lib/state/data.svelte', async () => {
		const actual = await vi.importActual<typeof import('$lib/state/data.svelte')>('$lib/state/data.svelte');
		return { ...actual, getAirports: () => airports, getNavaids: () => navaids };
	});
	resolve = (await import('$lib/state/waypointSearch.svelte')).resolveWaypointToken;
});

afterAll(() => {
	vi.doUnmock('$lib/state/data.svelte');
});

/** The route's anchors, after asserting `ident` really names several
 *  features in the committed data. */
function route(ambiguous: string, ...idents: string[]): (WaypointAnchor | null)[] {
	expect(resolve.candidates?.(ambiguous).length ?? 0, `${ambiguous} names one feature only`).toBeGreaterThan(1);
	return chooseAnchors(
		idents.map((ident) => ({ ident })),
		resolve,
	);
}

function at(out: (WaypointAnchor | null)[], i: number): WaypointAnchor {
	const a = out[i];
	if (!a) {
		throw new Error(`point ${i} unresolved`);
	}
	return a;
}

describe('identifiers the committed data files under several features', () => {
	it('places the Corsican reporting points shared with US airports in Corsica', () => {
		const out = route('KCIR', 'LFKB', 'KBNA', 'LFKC', 'KCIR', 'KCNW', 'KCWC', 'LFKJ');
		const calvi = at(out, 2);
		for (const i of [1, 3, 4, 5]) {
			expect(at(out, i).kind).toBe('navaid');
			expect(distanceNM(at(out, i), calvi)).toBeLessThan(40);
		}
	});

	it('places the French VORs shadowed by airports abroad in France', () => {
		for (const [dep, vor, arr] of [
			['LFPT', 'BOV', 'LFAQ'],
			['LFSB', 'BLM', 'LFGA'],
			['LFBZ', 'BTZ', 'LFBP'],
		]) {
			const out = route(vor, dep, vor, arr);
			expect(at(out, 1).kind, vor).toBe('navaid');
			expect(distanceNM(at(out, 1), at(out, 0)), vor).toBeLessThan(60);
		}
	});

	it('takes the publisher a route flies in, whichever lists the identifier first', () => {
		const france = route('ROA', 'LFLV', 'ROA', 'LFLY');
		expect(distanceNM(at(france, 1), at(france, 0))).toBeLessThan(60);
		const virginia = route('ROA', 'KLYH', 'ROA', 'KBCB');
		expect(distanceNM(at(virginia, 1), at(virginia, 0))).toBeLessThan(60);
	});

	it('tells one publisher\'s two features under one identifier apart: CHW', () => {
		const chartres = route('CHW', 'LFOR', 'CHW', 'LFPN');
		expect(distanceNM(at(chartres, 1), at(chartres, 0))).toBeLessThan(40);
		const arcachon = route('CHW', 'LFCH', 'CHW', 'LFBD');
		expect(distanceNM(at(arcachon, 1), at(arcachon, 0))).toBeLessThan(10);
	});

	it('keeps the aerodrome a reporting point is filed at under its own identifier', () => {
		expect(at(route('EDAB', 'EDAC', 'EDAB', 'EDAH'), 1).kind).toBe('airport');
	});

	it('keeps a destination aerodrome over a nearer feature sharing its identifier', () => {
		const belleIle = route('LFEA', 'LFLP', 'LFEA');
		expect(at(belleIle, 1).kind).toBe('airport');
		expect(distanceNM(at(belleIle, 1), at(belleIle, 0))).toBeGreaterThan(300);
		// Passed through and left, it is the LP-EA reporting point beside Annecy.
		const lpEa = route('LFEA', 'LFLP', 'LFEA', 'LFLB');
		expect(at(lpEa, 1).kind).toBe('navaid');
		expect(distanceNM(at(lpEa, 1), at(lpEa, 0))).toBeLessThan(10);
	});

	it('lets the map centre place a lone identifier, the first feature without it', () => {
		const france = { lat: 48.8, lon: 2.4 };
		expect(chooseAnchors([{ ident: 'BOV' }], resolve, france)[0]?.kind).toBe('navaid');
		expect(chooseAnchors([{ ident: 'BOV' }], resolve)[0]?.kind).toBe('airport');
	});
});
