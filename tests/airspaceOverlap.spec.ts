import { describe, it, expect } from 'vitest';
import type { Notam, NotamCoordinate } from '$lib/notam/types';
import type { Airspace } from '$lib/data/airspaces';
import { geometryOverlap } from '$lib/state/notamLinks.svelte';

// A small (~1.7 km) aerial-activity-sized square ring near Brie, like the real
// LFV8396MOD model-flying zone reported. [lat, lon] pairs.
const RING: [number, number][] = [
	[48.682, 2.774],
	[48.698, 2.774],
	[48.698, 2.799],
	[48.682, 2.799],
];
const AIRSPACE = { ring: RING } as unknown as Airspace;

function coord(
	lat: number,
	lon: number,
	type: NotamCoordinate['type'],
	radius?: number,
): NotamCoordinate {
	return {
		lat,
		lon,
		type,
		original: '',
		...(radius != null ? { radius, radiusUnit: 'NM' as const } : {}),
	};
}

function notam(coordinates: NotamCoordinate[], isPolygon = false): Notam {
	return { isPolygon, coordinates } as unknown as Notam;
}

describe('geometryOverlap: Q-line scope must not flood small airspaces', () => {
	it('does NOT match a far regional NOTAM whose 25 NM Q-line scope merely encloses the zone', () => {
		// Centre ~38 km away (near LFPG); a 25 NM (~46 km) scope circle covers
		// the zone, but the NOTAM is not about it.
		const n = notam([coord(49.0097, 2.5478, 'qualifierLine', 25)]);
		expect(geometryOverlap(n, AIRSPACE)).toBe(false);
	});

	it('matches when the Q-line centre actually falls inside the zone', () => {
		const n = notam([coord(48.69, 2.786, 'qualifierLine', 25)]);
		expect(geometryOverlap(n, AIRSPACE)).toBe(true);
	});

	it('tolerates the Q-line centre rounding (~1 km just outside the edge)', () => {
		// Arc-minute rounding can push the centre ~1 km off; still link it.
		const n = notam([coord(48.707, 2.786, 'qualifierLine', 25)]);
		expect(geometryOverlap(n, AIRSPACE)).toBe(true);
	});

	it('does NOT match a Q-line centre a few km away despite a wide scope', () => {
		// ~5 km north; outside the ~2 km rounding tolerance.
		const n = notam([coord(48.743, 2.786, 'qualifierLine', 25)]);
		expect(geometryOverlap(n, AIRSPACE)).toBe(false);
	});

	it('still matches a precise PSN circle that clips the zone', () => {
		// Centre ~220 m north of the top edge; a 1 NM (~1.85 km) circle clips in.
		const n = notam([coord(48.7, 2.786, 'psn', 1)]);
		expect(geometryOverlap(n, AIRSPACE)).toBe(true);
	});

	it('matches a PSN point inside the zone', () => {
		expect(geometryOverlap(notam([coord(48.69, 2.786, 'psn')]), AIRSPACE)).toBe(true);
	});

	it('matches an overlapping polygon NOTAM', () => {
		const poly = notam(
			[
				coord(48.68, 2.77, 'psn'),
				coord(48.7, 2.77, 'psn'),
				coord(48.7, 2.8, 'psn'),
				coord(48.68, 2.8, 'psn'),
			],
			true,
		);
		expect(geometryOverlap(poly, AIRSPACE)).toBe(true);
	});
});
