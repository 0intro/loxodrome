/* The route profile's activation hatch is each band's state where the
 * flight crosses it (components/profileOverlays.svelte.ts over
 * profileBand.ts bandHatch): a zone active from noon hatches for a crossing
 * flown in the afternoon and stays bare for one flown at dawn, and the
 * NOTAMs layer toggle leaves it alone. The resolver stands in here: it
 * answers by the range each band is judged over, and
 * tests/zoneActivity.spec.ts reads the shipped zones. The deriveds run in
 * the client runtime (tests/env/webnode.ts). */

import { flushSync } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
// The data store before the NOTAM state, as tests/profileOverlays.client.spec.ts
// explains.
import '$lib/state/data.svelte';
import type { ProfileOverlaySource } from '$lib/components/profileOverlays.svelte';
import { NO_ENTRY } from '$lib/data/airspaceEntry';
import { AIRSPACE_TYPE_LABELS } from '$lib/data/airspaces';
import type { AirspaceCorridorBand } from '$lib/route/airspaces';
import { buildBands } from '$lib/route/routeProfile';
import type { Waypoint } from '$lib/state/route.svelte';
import { profileLayers } from '$lib/state/profileLayers.svelte';
import { fromTriple } from '$lib/vertical/limits';
import { mountOverlays } from './helpers/profileOverlaysHost.svelte';

const T = vi.hoisted(() => ({ NOON: Date.UTC(2026, 11, 4, 12), H: 3_600_000 }));

// R 1 is active from noon to 16:00Z in its published hours.
vi.mock('$lib/state/activity.svelte', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/state/activity.svelte')>()),
	bandStates: (
		bands: readonly { key: string }[],
		at: { fromMs: number; toMs: number },
		_unknown: unknown,
		ranges?: ReadonlyMap<string, { fromMs: number; toMs: number }> | null,
	) =>
		new Map(
			bands.map((b) => {
				const r = ranges?.get(b.key) ?? at;
				const active = r.toMs >= T.NOON && r.fromMs <= T.NOON + 4 * T.H;
				return [
					b.key,
					active
						? { state: 'active', reason: 'published', period: { startMs: T.NOON, endMs: T.NOON + 4 * T.H } }
						: { state: 'inactive', reason: 'outside', period: null },
				];
			}),
		),
}));

const { NOON, H } = T;

// R 1 from 28 to 32 NM along the route, SFC to 3000 ft AMSL.
const CORRIDOR: AirspaceCorridorBand[] = [
	{
		key: 'LFR1|R 1',
		id: 'LFR1',
		name: 'R 1',
		type: 'R',
		category: 'restricted',
		vLower: fromTriple(['SFC', '0', '']),
		vUpper: fromTriple(['ALT', '3000', 'FT']),
		airClass: '',
		entry: NO_ENTRY,
		badge: { text: 'R', kind: 'zone' },
		activity: 'permanent',
		spans: [{ enterNM: 28, leaveNM: 32 }],
	},
];
const PLACED = buildBands(CORRIDOR, [], AIRSPACE_TYPE_LABELS);

const wp = (id: string, lat: number): Waypoint => ({ id, lat, lon: 2, kind: 'free', alt: 1500, altAuto: true });

/** The route flown from `departure` at 100 kt. */
function source(departure: number): ProfileOverlaySource {
	return {
		enough: () => true,
		pts: () => [
			{ lat: 48, lon: 2 },
			{ lat: 49, lon: 2 },
		],
		cumNM: () => [0, 60],
		bandWaypoints: () => [wp('a', 48), wp('b', 49)],
		terrain: () => [
			{ distNM: 0, elevFt: 300 },
			{ distNM: 60, elevFt: 300 },
		],
		corridorBands: () => CORRIDOR,
		placedBands: () => PLACED,
		pathVertices: () => [
			{ distNM: 0, altFt: 1500 },
			{ distNM: 60, altFt: 1500 },
		],
		vfr: () => true,
		verdictWindow: () => ({ from: NOON - 7 * H, to: NOON + 7 * H }),
		activityUnknown: () => ({ notam: false, rtba: false }),
		crossingClock: () => (nm: number) => departure + (nm / 100) * H,
	};
}

describe('the profile hatch', () => {
	afterEach(() => {
		profileLayers.notams = true;
	});

	it('hatches a zone active where the flight crosses it, and only there', () => {
		const afternoon = mountOverlays(source(NOON + H));
		const dawn = mountOverlays(source(NOON - 6 * H));
		expect(afternoon.overlays.bandActivations?.get('LFR1|R 1')).toBe(
			'Active from 12:00Z to 16:00Z. Active in its published hours.',
		);
		expect(dawn.overlays.bandActivations).toBeNull();
		afternoon.stop();
		dawn.stop();
	});

	it('keeps the hatch whichever way the NOTAMs toggle stands', () => {
		const { overlays, stop } = mountOverlays(source(NOON + H));
		const on = overlays.bandActivations;
		profileLayers.notams = false;
		flushSync();
		expect(overlays.bandActivations).toEqual(on);
		expect(on?.has('LFR1|R 1')).toBe(true);
		stop();
	});
});
