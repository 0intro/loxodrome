/* The raptor zones on the route profile (route/zsmProfile.ts): a band per
 * zone the route crosses, keyed by the zone's id, from the surface to the
 * height to overfly it at, forbidding nothing, and the word its active
 * crossing wears on the strip and the schedule (components/profileBand.ts
 * activeWord): the height in feet, rounded up, in place of ACTIVE. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ringAreaM2, ringBbox } from '$lib/notam/geometry';
import type { Zsm } from '$lib/data/zsm';
import { ZSM_INK } from '$lib/map/palette';
import { bandCrossings } from '$lib/route/routeProfile';
import { isZsmBandKey, zsmProfileBands } from '$lib/route/zsmProfile';
import type { Waypoint } from '$lib/state/route.svelte';
import { i18n } from '$lib/state/i18n.svelte';

const RING: [number, number][] = [
	[45.0, 6.0],
	[45.0, 6.2],
	[45.2, 6.2],
	[45.2, 6.0],
	[45.0, 6.0],
];
const ZONE: Zsm = {
	id: 'zsm:5991',
	name: 'Le Rompeau',
	species: 'Gypaète barbu',
	taxon: '2852',
	active: true,
	topM: 2110,
	overflyM: 3110,
	modified: '2026-10-31',
	ring: RING,
	bbox: ringBbox(RING),
	areaM2: ringAreaM2(RING),
};

vi.mock('$lib/state/zsm.svelte', () => ({
	zsmById: (id: string) => (id === ZONE.id ? ZONE : null),
}));

// West to east across the square at 45.1 N.
const ROUTE = [
	{ lat: 45.1, lon: 5.8 },
	{ lat: 45.1, lon: 6.4 },
] as Waypoint[];
const at = (altFt: number) => [
	{ distNM: 0, altFt },
	{ distNM: 26, altFt },
];

afterEach(() => {
	i18n.locale = 'en';
});

describe('raptor zone bands on the route profile', () => {
	it('bands a zone the route crosses, from the surface to its height, chipped ZSM', () => {
		const [b, ...rest] = zsmProfileBands(ROUTE, [ZONE], []);
		expect(rest).toEqual([]);
		expect([b.key, b.color, b.badge, b.badgeKind, b.label, b.limitsText]).toEqual([
			'zsm:5991',
			ZSM_INK,
			'ZSM',
			'zone',
			'Le Rompeau',
			'SFC – 3110 m AMSL',
		]);
		expect(b.tooltip).toBe('ZSM Le Rompeau\nGypaète barbu\nSFC – 3110 m AMSL');
		expect(b.entry.vfr).toBeNull();
		expect(b.spans).toHaveLength(1);
		expect(b.spans[0].enterNM).toBeGreaterThan(7);
		expect(b.spans[0].leaveNM).toBeLessThan(19);
		expect(isZsmBandKey(b.key)).toBe(true);
		expect(isZsmBandKey('sup:metropole-2026-100#0')).toBe(false);
	});

	it('leaves a route that misses the zone without a band', () => {
		const north = [
			{ lat: 46.1, lon: 5.8 },
			{ lat: 46.1, lon: 6.4 },
		] as Waypoint[];
		expect(zsmProfileBands(north, [ZONE], [])).toEqual([]);
	});

	it('is crossed below its height, never forbidden, and clear above it', () => {
		const bands = zsmProfileBands(ROUTE, [ZONE], []);
		const states = new Map([[ZONE.id, { state: 'active' as const, reason: 'published' as const, period: null }]]);
		const [low] = bandCrossings(bands, at(9000), { vfr: true, states });
		expect([low.key, low.forbidden, low.active]).toEqual(['zsm:5991', false, true]);
		expect(bandCrossings(bands, at(10_300), { vfr: true, states })).toEqual([]);
	});

	it('ranks its active crossing with the cautions, after an ACTIVE restriction', () => {
		const [zsm] = zsmProfileBands(ROUTE, [ZONE], []);
		const r = { ...zsm, key: 'LFR1|R 1', advisory: undefined };
		const active = { state: 'active' as const, reason: 'published' as const, period: null };
		const states = new Map([
			[zsm.key, active],
			[r.key, active],
		]);
		expect(bandCrossings([zsm, r], at(9000), { vfr: true, states }).map((c) => c.key)).toEqual(['LFR1|R 1', 'zsm:5991']);
	});

	it('wears the height to overfly it at, in feet, where an active zone wears ACTIVE', async () => {
		const { activeWord } = await import('$lib/components/profileBand');
		expect(activeWord('zsm:5991')).toEqual({ text: 'overfly above 10\u202f210\u202fft', caution: true });
		expect(activeWord('LFR151|151')).toEqual({ text: 'ACTIVE', caution: false });
		i18n.locale = 'fr';
		expect(activeWord('zsm:5991')).toEqual({ text: 'survoler au-dessus de 10\u202f210\u202fft', caution: true });
	});
});
