/* Which feature an identifier names, chosen by the route around it
 * (route/anchorChoice.ts). Stub resolvers; the committed data's own
 * collisions are pinned in tests/anchorChoiceData.spec.ts. */

import { describe, expect, it } from 'vitest';
import {
	chooseAnchors,
	PREFERENCE_NM,
	routeAnchors,
	type AnchorItem,
	type WaypointResolver,
} from '$lib/route/anchorChoice';
import { destinationPoint } from '$lib/notam/geometry';
import { NM_TO_METERS } from '$lib/notam/units';
import type { WaypointAnchor } from '$lib/state/route.svelte';

const ap = (ident: string, lat: number, lon: number): WaypointAnchor => ({
	lat,
	lon,
	kind: 'airport',
	refId: ident,
	ident,
});
const nav = (ident: string, id: string, lat: number, lon: number): WaypointAnchor => ({
	lat,
	lon,
	kind: 'navaid',
	refId: id,
	ident,
});

/** A resolver listing every candidate, the call answering the first (the
 *  app's own contract: airports first). */
function resolver(table: Record<string, WaypointAnchor[]>): WaypointResolver {
	return Object.assign((t: string): WaypointAnchor | null => table[t.toUpperCase()]?.[0] ?? null, {
		candidates: (t: string): WaypointAnchor[] => table[t.toUpperCase()] ?? [],
	});
}

/** A point `nm` nautical miles from `from` on true bearing `deg`. */
function at(from: { lat: number; lon: number }, deg: number, nm: number): { lat: number; lon: number } {
	return destinationPoint(from.lat, from.lon, deg, nm * NM_TO_METERS);
}

const ids = (...t: string[]): AnchorItem[] => t.map((ident) => ({ ident }));
const kinds = (out: (WaypointAnchor | null)[]): (string | null)[] =>
	out.map((a) => (a ? `${a.ident}:${a.kind}` : null));

// Calvi and Propriano, Calvi's IR reporting point, and the Cairo Regional
// airport in Illinois filed under the same identifier KCIR; Calvi's NW point
// and TSTC Waco (KCNW); Bastia's NA point and Nashville (KBNA).
const LFKC = ap('LFKC', 42.52436, 8.79301);
const LFKO = ap('LFKO', 41.66028, 8.89389);
const KCIR_CAIRO = ap('KCIR', 37.06447, -89.21956);
const KCIR_VRP = nav('KCIR', 'WPT:8397617', 42.64444, 8.93167);
const KCNW_WACO = ap('KCNW', 31.63785, -97.07413);
const KCNW_VRP = nav('KCNW', 'WPT:27369766', 42.57528, 8.69083);
const KBNA_NASHVILLE = ap('KBNA', 36.12447, -86.67819);
const KBNA_VRP = nav('KBNA', 'WPT:8357901', 42.61944, 9.43556);
const CORSICA = resolver({
	LFKC: [LFKC],
	LFKO: [LFKO],
	KCIR: [KCIR_CAIRO, KCIR_VRP],
	KCNW: [KCNW_WACO, KCNW_VRP],
	KBNA: [KBNA_NASHVILLE, KBNA_VRP],
});

describe('chooseAnchors', () => {
	it('takes a resolver without candidates at its word', () => {
		const plain = (t: string): WaypointAnchor | null =>
			t === 'KCIR' ? KCIR_CAIRO : t === 'LFKC' ? LFKC : null;
		expect(chooseAnchors(ids('LFKC', 'KCIR', 'NONE'), plain)).toEqual([LFKC, KCIR_CAIRO, null]);
	});

	it('answers a route of single features as the resolver does, without weighing it', () => {
		expect(chooseAnchors(ids('LFKC', 'LFKO'), CORSICA)).toEqual([LFKC, LFKO]);
	});

	it('takes the reporting point the route passes, not the airport a continent away', () => {
		expect(kinds(chooseAnchors(ids('LFKC', 'KCIR', 'LFKO'), CORSICA))).toEqual([
			'LFKC:airport',
			'KCIR:navaid',
			'LFKO:airport',
		]);
	});

	it('places a run of ambiguous points before the first certain one by it', () => {
		const out = chooseAnchors(ids('KCNW', 'KCIR', 'LFKC'), CORSICA);
		expect(out[0]).toEqual(KCNW_VRP);
		expect(out[1]).toEqual(KCIR_VRP);
	});

	it('weighs every ambiguous point of a route together', () => {
		expect(chooseAnchors(ids('LFKC', 'KBNA', 'KCIR', 'KCNW', 'LFKO'), CORSICA).slice(1, 4)).toEqual([
			KBNA_VRP,
			KCIR_VRP,
			KCNW_VRP,
		]);
	});

	it('keeps an aerodrome as a destination within PREFERENCE_NM, and not beyond', () => {
		const dep = ap('DEP', 45, 5);
		const near = nav('XX', 'n1', 45.01, 5.01);
		for (const [nm, kind] of [
			[PREFERENCE_NM - 20, 'airport'],
			[PREFERENCE_NM + 20, 'navaid'],
		] as const) {
			const far = at(dep, 270, nm);
			const r = resolver({ DEP: [dep], XX: [ap('XX', far.lat, far.lon), near] });
			expect(chooseAnchors(ids('DEP', 'XX'), r)[1]?.kind).toBe(kind);
		}
	});

	it('takes the other feature once the route passes it and comes back', () => {
		// Annecy to Belle-Ile is LFEA the aerodrome; Annecy, LFEA, Chambery is
		// the LP-EA reporting point beside Annecy.
		const lflp = ap('LFLP', 45.92972, 6.09889);
		const lflb = ap('LFLB', 45.63806, 5.88);
		const belle = ap('LFEA', 47.32694, -3.19833);
		const lpea = nav('LFEA', 'WPT:lpea', 45.95, 6.17);
		const r = resolver({ LFLP: [lflp], LFLB: [lflb], LFEA: [belle, lpea] });
		expect(chooseAnchors(ids('LFLP', 'LFEA'), r)[1]).toEqual(belle);
		expect(chooseAnchors(ids('LFLP', 'LFEA', 'LFLB'), r)[1]).toEqual(lpea);
	});

	it('merges one place filed twice into the earlier candidate', () => {
		// Two navaids under one identifier, the later a little nearer the
		// route: within SAME_PLACE_NM they are one place, and the first stands.
		const dep = ap('DEP', 50, 10);
		const arr = ap('ARR', 50, 11);
		const first = nav('X', 'first', 50.2, 10.5);
		for (const [nm, want] of [
			[0.3, 'first'],
			[1.9, 'first'],
			[2.5, 'second'],
		] as const) {
			const p = at(first, 180, nm);
			const r = resolver({ DEP: [dep], ARR: [arr], X: [first, nav('X', 'second', p.lat, p.lon)] });
			expect(chooseAnchors(ids('DEP', 'X', 'ARR'), r)[1]?.refId, `${nm} NM`).toBe(want);
		}
	});

	it('keeps the aerodrome a reporting point is filed at under its own identifier', () => {
		const edac = ap('EDAC', 50.98, 12.51);
		const edah = ap('EDAH', 53.88, 14.15);
		const field = ap('EDAB', 51.19, 14.52);
		const p = at(field, 0, 0.3);
		const r = resolver({ EDAC: [edac], EDAH: [edah], EDAB: [field, nav('EDAB', 'v', p.lat, p.lon)] });
		expect(chooseAnchors(ids('EDAC', 'EDAB', 'EDAH'), r)[1]).toEqual(field);
	});

	it('finds the nearest of many candidates wherever it is listed', () => {
		const dep = ap('DEP', 47, 8);
		const cands = Array.from({ length: 40 }, (_, i) => {
			const p = at(dep, 90, i === 29 ? 3 : 300 + i * 10);
			return nav('S', `s${i}`, p.lat, p.lon);
		});
		const r = resolver({ DEP: [dep], S: cands });
		expect(chooseAnchors(ids('DEP', 'S'), r)[1]?.refId).toBe('s29');
	});

	it('keeps a picked feature by its refId, whatever the route says', () => {
		const out = chooseAnchors(
			[{ ident: 'LFKC' }, { ident: 'KCIR', keep: { ...KCIR_CAIRO } }, { ident: 'LFKO' }],
			CORSICA,
		);
		expect(out[1]).toEqual(KCIR_CAIRO);
	});

	it('keeps the feature a file states the position of, without a refId', () => {
		const keep = { lat: KCIR_CAIRO.lat + 0.01, lon: KCIR_CAIRO.lon };
		expect(chooseAnchors([{ ident: 'LFKC' }, { ident: 'KCIR', keep }], CORSICA)[1]).toEqual(KCIR_CAIRO);
	});

	it('lets the route decide when the kept feature is no longer filed there', () => {
		const keep = { lat: 10, lon: 10, kind: 'navaid' as const, refId: 'WPT:gone' };
		expect(chooseAnchors([{ ident: 'LFKC' }, { ident: 'KCIR', keep }], CORSICA)[1]).toEqual(KCIR_VRP);
	});

	it('lets `near` decide a lone ambiguous point, and the resolver order without one', () => {
		expect(chooseAnchors(ids('KCIR'), CORSICA, { lat: 42.5, lon: 8.8 })[0]).toEqual(KCIR_VRP);
		expect(chooseAnchors(ids('KCIR'), CORSICA, { lat: 38, lon: -89 })[0]).toEqual(KCIR_CAIRO);
		expect(chooseAnchors(ids('KCIR'), CORSICA)[0]).toEqual(KCIR_CAIRO);
	});

	it('ignores `near` once the route holds a certain point', () => {
		expect(chooseAnchors(ids('LFKC', 'KCIR'), CORSICA, { lat: 38, lon: -89 })[1]).toEqual(KCIR_VRP);
	});

	it('lets `near` place a route with no certain point at all', () => {
		expect(chooseAnchors(ids('KBNA', 'KCIR'), CORSICA, { lat: 46, lon: 2 })).toEqual([
			KBNA_VRP,
			KCIR_VRP,
		]);
		// Without it, the pair is weighed alone: Nashville and Cairo, Illinois.
		expect(chooseAnchors(ids('KBNA', 'KCIR'), CORSICA)).toEqual([KBNA_NASHVILLE, KCIR_CAIRO]);
	});

	it('skips name-only points and unknown identifiers, joining the route across them', () => {
		const out = chooseAnchors(
			[{ ident: 'LFKC' }, null, { ident: 'NONE' }, { ident: 'KCIR' }, { ident: 'LFKO' }],
			CORSICA,
		);
		expect(kinds(out)).toEqual(['LFKC:airport', null, null, 'KCIR:navaid', 'LFKO:airport']);
	});

	it('weighs free points as fixed positions', () => {
		const out = chooseAnchors([{ lat: 42.6, lon: 8.9 }, { ident: 'KCIR' }], CORSICA);
		expect(out).toEqual([null, KCIR_VRP]);
	});

	it('measures across the antimeridian the short way', () => {
		const dep = ap('NFFN', -17.75, 179.5);
		const east = nav('XYZ', 'east', -17.75, -179.9);
		const west = nav('XYZ', 'west', -17.75, 172.0);
		// Listed far first: only the true great-circle leg makes the east one near.
		const r = resolver({ NFFN: [dep], XYZ: [west, east] });
		expect(chooseAnchors(ids('NFFN', 'XYZ'), r)[1]?.refId).toBe('east');
	});

	it('gives a tie to the earlier candidate', () => {
		const dep = ap('DEP', 0, 0);
		const n = nav('T', 'north', 1, 0);
		const s = nav('T', 'south', -1, 0);
		expect(chooseAnchors(ids('DEP', 'T'), resolver({ DEP: [dep], T: [n, s] }))[1]?.refId).toBe('north');
		expect(chooseAnchors(ids('DEP', 'T'), resolver({ DEP: [dep], T: [s, n] }))[1]?.refId).toBe('south');
	});
});

describe('routeAnchors', () => {
	it('maps a parsed route: an ident with its stated position as the feature to keep, a free point, a name-only point', () => {
		const out = routeAnchors(
			[
				{ ident: 'LFKC' },
				{ ident: 'KCIR', lat: KCIR_CAIRO.lat, lon: KCIR_CAIRO.lon },
				{ lat: 42.0, lon: 8.9, name: 'Free' },
				{ name: 'Somewhere' },
				{ ident: 'LFKO' },
			],
			CORSICA,
		);
		expect(kinds(out)).toEqual(['LFKC:airport', 'KCIR:airport', null, null, 'LFKO:airport']);
	});

	it('chooses an identifier with no stated position by the route', () => {
		expect(routeAnchors([{ ident: 'LFKC' }, { ident: 'KCIR' }], CORSICA)[1]).toEqual(KCIR_VRP);
	});
});
