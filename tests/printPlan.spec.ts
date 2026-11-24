/* What a pack print's prefetch was computed for (flightprep/printPlan.ts).
 * The dossier prefetches each route's MSA, terrain and corridor ground per
 * leg, and the annex's aerodromes, from the plan as it stood when the run
 * began, and the sheets read the arrays by leg index. A waypoint inserted
 * while the run holds in review would shift every later leg's printed MSA by
 * one, so the run starts again whenever the key it began with has moved. */

import { describe, expect, it } from 'vitest';
import { printPlanKey } from '$lib/components/flightprep/printPlan';
import type { Route, Waypoint } from '$lib/state/route.svelte';

function wp(id: string, lat: number, lon: number, extra: Partial<Waypoint> = {}): Waypoint {
	return { id, lat, lon, kind: 'free', alt: 2500, altAuto: true, ...extra };
}

function route(id: string, waypoints: Waypoint[], extra: Partial<Route> = {}): Route {
	return { id, name: null, waypoints, selectedWaypointId: null, ...extra };
}

const LFPN = wp('a', 48.7517, 2.1061, { kind: 'airport', ident: 'LFPN' });
const LFAI = wp('b', 48.5931, 3.0047, { kind: 'airport', ident: 'LFAI' });
const LFOZ = wp('c', 47.8975, 2.1633, { kind: 'airport', ident: 'LFOZ' });
const SETTINGS = { minAltCorridorRadiusNM: 5, vfr: true };

function plan(): Route[] {
	return [route('r1', [LFPN, wp('m', 48.7, 2.6), LFAI]), route('r2', [LFAI, LFOZ])];
}

describe('printPlanKey', () => {
	const key = printPlanKey(plan(), SETTINGS);

	it('moves with every edit the prefetch answers for', () => {
		const edits: [string, Route[], typeof SETTINGS][] = [
			['a waypoint inserted', [route('r1', [LFPN, wp('n', 48.65, 2.4), wp('m', 48.7, 2.6), LFAI]), plan()[1]], SETTINGS],
			['a waypoint moved', [route('r1', [LFPN, wp('m', 48.71, 2.6), LFAI]), plan()[1]], SETTINGS],
			['a waypoint removed', [route('r1', [LFPN, LFAI]), plan()[1]], SETTINGS],
			['a route added', [...plan(), route('r3', [LFOZ, LFPN])], SETTINGS],
			['a route removed', plan().slice(0, 1), SETTINGS],
			['the routes reordered', plan().reverse(), SETTINGS],
			['a trip made an alternate', [plan()[0], { ...plan()[1], alternate: true }], SETTINGS],
			[
				'an aerodrome swapped at the same place',
				[plan()[0], route('r2', [LFAI, { ...LFOZ, ident: 'LFOX' }])],
				SETTINGS,
			],
			['the corridor widened', plan(), { ...SETTINGS, minAltCorridorRadiusNM: 10 }],
			['the flight rules', plan(), { ...SETTINGS, vfr: false }],
		];
		for (const [what, routes, settings] of edits) {
			expect(printPlanKey(routes, settings), what).not.toBe(key);
		}
	});

	it('stays through the edits the prefetch never read', () => {
		const r1 = plan()[0];
		const levelled = route('r1', r1.waypoints.map((w) => ({ ...w, alt: 6500, altAuto: false })), {
			name: 'Nav-examen',
		});
		const noted = route('r1', r1.waypoints.map((w) => ({ ...w, notes: 'report', windDirDeg: 270, windSpeedKt: 20 })));
		expect(printPlanKey([levelled, plan()[1]], SETTINGS)).toBe(key);
		expect(printPlanKey([noted, plan()[1]], SETTINGS)).toBe(key);
	});
});
